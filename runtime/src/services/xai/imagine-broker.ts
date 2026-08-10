/**
 * OAuth-only, versioned xAI Imagine broker.
 *
 * This module owns the credential boundary for the NDJSON stdio protocol.
 * Access and refresh tokens are consumed here and are never included in a
 * response. Every inference request is pinned to api.x.ai; API keys and base
 * URL overrides are deliberately outside this broker's contract.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { parseProviderRetryAfterDirective } from "../../llm/retry-after.js";
import { getAgenCConfigHomeDir } from "../../utils/envUtils.js";
import { asRecord } from "../../utils/record.js";
import {
  getSecureStorage,
  migratePlainTextStorageToNative,
  type SecureStorageMigrationResult,
} from "../../utils/secureStorage/index.js";
import {
  forceRefreshXaiOauthCredentials,
  readXaiOauthCredentials,
  refreshXaiOauthCredentialsIfNeeded,
  xaiOauthTokenIsExpiring,
  type XaiOauthCredentialBlob,
} from "../../utils/xaiOauthCredentials.js";

export const XAI_IMAGINE_BROKER_PROTOCOL_NAME = "agenc.xai.imagine";
export const XAI_IMAGINE_BROKER_PROTOCOL_VERSION = 1;
export const XAI_IMAGINE_API_BASE_URL = "https://api.x.ai/v1";

const JSON_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const POST_TIMEOUT_MS = 180_000;
const TTS_TIMEOUT_MS = 15 * 60_000;
const READ_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_DOWNLOAD_LIMIT_BYTES = 1024 * 1024 * 1024;
const MAX_DOWNLOAD_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_LOCAL_IMAGE_REFERENCE_BYTES = 20 * 1024 * 1024;
const MAX_LOCAL_VIDEO_REFERENCE_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_PUBLIC_PROMPT_LENGTH = 64 * 1024;
const MAX_TTS_TEXT_LENGTH = 15_000;
const MAX_TTS_TIMESTAMP_TEXT_LENGTH = 10_000;
const MAX_TTS_AUDIO_BYTES = 512 * 1024 * 1024;
const MAX_TTS_TIMESTAMP_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_REGISTRY_ITEMS = 256;
// Paid image calls request at most ten outputs, but retain a bounded amount of
// unexpected provider output so a malformed sibling cannot strand valid work.
const MAX_IMAGE_RESULTS = 64;
const MAX_PUBLIC_METADATA_LENGTH = 1_024;
const UNEXPECTED_ARTIFACT_DIRECTORY = ".agenc-xai-unexpected";
const MAX_RECOVERY_RECORD_BYTES = 128 * 1024;
const PROVIDER_FILE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const IMAGE_ASPECT_RATIOS = new Set([
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
  "auto",
]);
const VIDEO_ASPECT_RATIOS = new Set([
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
]);
const VIDEO_RESOLUTIONS = new Set(["480p", "720p", "1080p"]);
const TTS_CODECS = new Set(["mp3", "wav", "pcm", "mulaw", "alaw"]);
const TTS_SAMPLE_RATES = new Set([8_000, 16_000, 22_050, 24_000, 44_100, 48_000]);
const TTS_BIT_RATES = new Set([32_000, 64_000, 96_000, 128_000, 192_000]);
const ARTIFACT_HOSTS = new Set([
  "imgen.x.ai",
  "vidgen.x.ai",
  "files-cdn.x.ai",
]);
const METHOD_NAMES = Object.freeze([
  "protocol.version",
  "operations.status",
  "auth.status",
  "auth.migrate_storage",
  "capabilities.probe",
  "images.generate",
  "images.edit",
  "videos.submit",
  "videos.poll",
  "tts.voices",
  "tts.generate",
  "artifacts.download",
] as const);

export type XaiImagineBrokerMethod = (typeof METHOD_NAMES)[number];

const LOCAL_MEDIA_REFERENCE_SCHEMA = {
  oneOf: [
    {
      type: "object",
      required: ["url"],
      properties: { url: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["file_id"],
      properties: { file_id: { type: "string", pattern: "^file_" } },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["path", "sha256"],
      properties: {
        path: { type: "string", minLength: 1 },
        sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
      },
      additionalProperties: false,
    },
  ],
} as const;

const EMPTY_PARAMS_SCHEMA = {
  type: "object",
  maxProperties: 0,
  additionalProperties: false,
} as const;

/** Machine-readable v1 method contract returned by protocol.version. */
export const XAI_IMAGINE_BROKER_METHOD_SCHEMAS = Object.freeze({
  "protocol.version": {
    params: EMPTY_PARAMS_SCHEMA,
    result: { type: "object", required: ["name", "version", "methods"] },
  },
  "operations.status": {
    params: {
      type: "object",
      required: ["operation", "key"],
      properties: {
        operation: {
          enum: [
            "images.generate",
            "images.edit",
            "videos.submit",
            "videos.poll",
            "tts.generate",
          ],
        },
        key: { type: "string", minLength: 1, maxLength: 512 },
      },
      additionalProperties: false,
    },
    result: { type: "object", required: ["operation", "key", "state", "caller_action"] },
  },
  "auth.status": {
    params: EMPTY_PARAMS_SCHEMA,
    result: { type: "object", required: ["auth_mode", "configured", "ready"] },
  },
  "auth.migrate_storage": {
    params: EMPTY_PARAMS_SCHEMA,
    result: { type: "object", required: ["migrated", "already_secure", "storage_security"] },
  },
  "capabilities.probe": {
    params: EMPTY_PARAMS_SCHEMA,
    result: { type: "object", required: ["auth_mode", "observed", "documented_contract"] },
  },
  "images.generate": {
    params: {
      type: "object",
      required: ["idempotency_key", "prompt", "destinations"],
      properties: {
        idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
        prompt: { type: "string", minLength: 1 },
        model: { type: "string" },
        n: { type: "integer", minimum: 1, maximum: 10 },
        aspect_ratio: { type: "string" },
        resolution: { enum: ["1k", "2k"] },
        destinations: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } },
      },
      additionalProperties: false,
    },
    result: { type: "object", required: ["operation", "idempotency_key", "images", "artifacts"] },
  },
  "images.edit": {
    params: {
      type: "object",
      required: ["idempotency_key", "prompt", "images", "destinations"],
      properties: {
        idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
        prompt: { type: "string", minLength: 1 },
        model: { type: "string" },
        images: { type: "array", minItems: 1, maxItems: 3, items: LOCAL_MEDIA_REFERENCE_SCHEMA },
        n: { type: "integer", minimum: 1, maximum: 10 },
        aspect_ratio: { type: "string" },
        resolution: { enum: ["1k", "2k"] },
        destinations: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } },
      },
      additionalProperties: false,
    },
    result: { type: "object", required: ["operation", "idempotency_key", "images", "artifacts"] },
  },
  "videos.submit": {
    params: {
      type: "object",
      required: ["idempotency_key", "prompt"],
      properties: {
        idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
        operation: { enum: ["generate", "edit", "extend"] },
        prompt: { type: "string", minLength: 1 },
        model: { type: "string" },
        duration: { type: "integer" },
        aspect_ratio: { type: "string" },
        resolution: { enum: ["480p", "720p", "1080p"] },
        image: LOCAL_MEDIA_REFERENCE_SCHEMA,
        reference_images: { type: "array", minItems: 1, maxItems: 7, items: LOCAL_MEDIA_REFERENCE_SCHEMA },
        reference_audios: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            required: ["voice_id"],
            properties: { voice_id: { type: "string" } },
            additionalProperties: false,
          },
        },
        video: LOCAL_MEDIA_REFERENCE_SCHEMA,
      },
      additionalProperties: false,
    },
    result: { type: "object", required: ["operation", "idempotency_key", "request_id", "status"] },
  },
  "videos.poll": {
    params: {
      type: "object",
      required: ["request_id", "destination"],
      properties: { request_id: { type: "string" }, destination: { type: "string" } },
      additionalProperties: false,
    },
    result: { type: "object", required: ["request_id", "status", "terminal", "caller_action"] },
  },
  "tts.voices": {
    params: EMPTY_PARAMS_SCHEMA,
    result: { type: "object", required: ["voices", "observed_at", "evidence"] },
  },
  "tts.generate": {
    params: {
      type: "object",
      required: ["idempotency_key", "text", "voice_id", "language", "destination"],
      properties: {
        idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
        text: { type: "string", minLength: 1, maxLength: MAX_TTS_TEXT_LENGTH },
        voice_id: { type: "string" },
        language: { type: "string" },
        output_format: { type: "object" },
        speed: { type: "number", minimum: 0.7, maximum: 1.5 },
        optimize_streaming_latency: { type: "integer", minimum: 0, maximum: 2 },
        text_normalization: { type: "boolean" },
        with_timestamps: { type: "boolean" },
        destination: { type: "string" },
      },
      additionalProperties: false,
    },
    result: { type: "object", required: ["idempotency_key", "voice_id", "language", "artifact"] },
  },
  "artifacts.download": {
    params: {
      type: "object",
      required: ["recovery_handle"],
      properties: { recovery_handle: { type: "string", pattern: "^recovery_" } },
      additionalProperties: false,
    },
    result: { type: "object", required: ["recovery_handle", "recovered", "artifact"] },
  },
} as const);

export type XaiImagineBrokerErrorCode =
  | "invalid_json"
  | "invalid_request"
  | "unsupported_protocol"
  | "unknown_method"
  | "auth_required"
  | "auth_quarantined"
  | "auth_refresh_failed"
  | "auth_or_entitlement_denied"
  | "storage_migration_failed"
  | "rate_limited"
  | "upstream_rejected"
  | "upstream_unavailable"
  | "submission_unknown"
  | "invalid_artifact_url"
  | "destination_exists"
  | "artifact_too_large"
  | "integrity_mismatch"
  | "download_failed"
  | "internal_error";

export interface XaiImagineBrokerRequest {
  readonly protocol_version: number;
  readonly id: string;
  readonly method: XaiImagineBrokerMethod;
  readonly params?: Record<string, unknown>;
}

export type XaiImagineBrokerResponse =
  | {
      readonly protocol_version: 1;
      readonly id: string | null;
      readonly ok: true;
      readonly result: Record<string, unknown>;
    }
  | {
      readonly protocol_version: 1;
      readonly id: string | null;
      readonly ok: false;
      readonly error: {
        readonly code: XaiImagineBrokerErrorCode;
        readonly message: string;
        readonly retryable: boolean;
        readonly details?: Record<string, unknown>;
      };
    };

export class XaiImagineBrokerError extends Error {
  readonly code: XaiImagineBrokerErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: XaiImagineBrokerErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "XaiImagineBrokerError";
    this.code = code;
    this.retryable = options.retryable === true;
    if (options.details !== undefined) this.details = options.details;
  }
}

export interface XaiImagineBrokerOauth {
  read(): XaiOauthCredentialBlob | undefined;
  refreshIfNeeded(): Promise<XaiOauthCredentialBlob | undefined>;
  forceRefresh(): Promise<XaiOauthCredentialBlob | undefined>;
  storageKind(): string;
}

export interface XaiImagineBrokerOptions {
  readonly fetchImpl?: typeof fetch;
  readonly oauth?: XaiImagineBrokerOauth;
  readonly now?: () => number;
  readonly artifactRoot?: string;
  /** Test/embedding override. Production state belongs under AgenC config. */
  readonly recoveryRoot?: string;
  readonly migrateStorage?: () => SecureStorageMigrationResult;
}

type MediaReference =
  | { readonly url: string }
  | { readonly file_id: string }
  | { readonly path: string; readonly sha256: string };
type AudioReference = { readonly voice_id: string };

interface XaiModelCard {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly fingerprint?: string;
  readonly maxPromptLength?: number;
  readonly inputModalities?: readonly string[];
  readonly outputModalities?: readonly string[];
}

interface ArtifactRecoveryRecord {
  readonly version: 1;
  readonly media_kind: "image" | "video";
  readonly source_url?: string;
  readonly file_id?: string;
  readonly destination: string;
  readonly max_bytes: number;
  readonly created_at: string;
  readonly expected_sha256?: string;
  readonly bytes?: number;
  readonly mime_type?: string;
  readonly downloaded_at?: string;
}

interface LoadedArtifactRecovery {
  readonly handle: string;
  readonly path: string;
  readonly record: ArtifactRecoveryRecord;
}

type DurableOperationName =
  | "images.generate"
  | "images.edit"
  | "videos.submit"
  | "videos.poll"
  | "tts.generate";

interface DurableOperationReceipt {
  readonly version: 1;
  readonly operation: DurableOperationName;
  readonly key_hash: string;
  readonly state:
    | "submission_unknown"
    | "submitted"
    | "recovery_required"
    | "completed";
  readonly created_at: string;
  readonly updated_at: string;
  readonly result?: Record<string, unknown>;
  readonly recovery?: Record<string, unknown>;
}

function defaultStorageKind(): string {
  const credentials = readXaiOauthCredentials();
  if (credentials === undefined) return "none";
  try {
    const native = getSecureStorage({ allowPlainTextFallback: false });
    const nativeData = native.read();
    if (nativeData?.xaiOauth?.accessToken) return native.name;
  } catch {
    // The configured fallback below remains authoritative.
  }
  return "plaintext";
}

const DEFAULT_OAUTH: XaiImagineBrokerOauth = {
  read: () => readXaiOauthCredentials(),
  refreshIfNeeded: () => refreshXaiOauthCredentialsIfNeeded(),
  forceRefresh: () => forceRefreshXaiOauthCredentials(),
  storageKind: () => defaultStorageKind(),
};

function storageSecurityStatus(
  storage: string,
  configured: boolean,
): Record<string, unknown> {
  if (!configured || storage === "none") {
    return {
      status: "not_configured",
      secure: null,
      migration_available: false,
    };
  }
  if (storage === "plaintext" || storage.includes("plaintext")) {
    return {
      status: "plaintext",
      secure: false,
      migration_available: true,
      migration_action:
        "Run `agenc xai auth migrate-storage`; it removes plaintext only after a verified native-vault readback.",
    };
  }
  if (
    storage.includes("libsecret") ||
    storage.includes("keychain") ||
    storage.includes("credential-locker")
  ) {
    return {
      status: "native_secure_storage",
      secure: true,
      migration_available: false,
    };
  }
  return {
    status: "unknown",
    secure: null,
    migration_available: false,
  };
}

function safeStorageName(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    ? value
    : "unknown";
}

function safeIsoDate(value: unknown): string | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function cleanMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return value
    .trim()
    .slice(0, 1_000)
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[URL REDACTED]")
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED]")
    .replace(
      /\b(access_token|token|signature|sig|api_key)=[^\s&]+/giu,
      "$1=[REDACTED]",
    );
}

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    const field = cleanMessage(unexpected[0], "field").slice(0, 128);
    throw new XaiImagineBrokerError(
      "invalid_request",
      `${label} contains unsupported field '${field}'`,
    );
  }
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  options: { readonly max?: number; readonly pattern?: RegExp } = {},
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      `${key} must be a non-empty string`,
    );
  }
  const normalized = value.trim();
  if (normalized.length > (options.max ?? Number.MAX_SAFE_INTEGER)) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      `${key} exceeds its maximum length`,
    );
  }
  if (options.pattern !== undefined && !options.pattern.test(normalized)) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      `${key} has an invalid format`,
    );
  }
  return normalized;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!own(record, key)) return undefined;
  return requiredString(record, key);
}

function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  if (!own(record, key)) return undefined;
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      `${key} must be an integer from ${min} through ${max}`,
    );
  }
  return value as number;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (!own(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new XaiImagineBrokerError(
      "invalid_request",
      `${key} must be a boolean`,
    );
  }
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  if (!own(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      `${key} must be a number from ${min} through ${max}`,
    );
  }
  return value;
}

function optionalEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  if (!own(record, key)) return undefined;
  const value = requiredString(record, key, { max: 128 });
  if (!allowed.has(value)) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      `${key} has an unsupported value`,
    );
  }
  return value;
}

function requiredLanguage(record: Record<string, unknown>): string {
  return requiredString(record, "language", {
    max: 35,
    pattern: /^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/u,
  });
}

function parseTtsOutputFormat(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const format = asRecord(value);
  if (format === null) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      "output_format must be an object",
    );
  }
  assertAllowedKeys(format, ["codec", "sample_rate", "bit_rate"], "output_format");
  const codec = optionalEnum(format, "codec", TTS_CODECS) ?? "mp3";
  const sampleRate = optionalInteger(format, "sample_rate", 8_000, 48_000);
  if (sampleRate !== undefined && !TTS_SAMPLE_RATES.has(sampleRate)) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      "output_format.sample_rate is not supported",
    );
  }
  const bitRate = optionalInteger(format, "bit_rate", 32_000, 192_000);
  if (bitRate !== undefined && !TTS_BIT_RATES.has(bitRate)) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      "output_format.bit_rate is not supported",
    );
  }
  if (bitRate !== undefined && codec !== "mp3") {
    throw new XaiImagineBrokerError(
      "invalid_request",
      "output_format.bit_rate is only valid for mp3",
    );
  }
  return {
    codec,
    ...(sampleRate !== undefined ? { sample_rate: sampleRate } : {}),
    ...(bitRate !== undefined ? { bit_rate: bitRate } : {}),
  };
}

function paramsObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const params = asRecord(value);
  if (params === null) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      "params must be an object",
    );
  }
  return params;
}

function validateModel(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      "model has an invalid format",
    );
  }
  return value;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

function requiredIdempotencyKey(params: Record<string, unknown>): string {
  return requiredString(params, "idempotency_key", {
    max: 200,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u,
  });
}

function privateStorageOptions(
  idempotencyKey: string,
  extension: "png" | "mp4",
): { readonly filename: string; readonly expires_after: number } {
  // xAI's storage_options makes the paid output a private, durable Files API
  // object. The name is correlation-only: it contains neither a prompt nor a
  // caller path, and public_url is deliberately never requested.
  const digest = createHash("sha256")
    .update(idempotencyKey, "utf8")
    .digest("hex")
    .slice(0, 32);
  return {
    filename: `agenc-${digest}.${extension}`,
    // Bound cloud retention while leaving a generous crash-recovery window.
    expires_after: PROVIDER_FILE_RETENTION_SECONDS,
  };
}

function requiredPrompt(params: Record<string, unknown>): string {
  return requiredString(params, "prompt", { max: MAX_PROMPT_LENGTH });
}

function normalizeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const strings = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.length > 0 && entry.length <= 128,
  );
  return strings.length === value.length ? strings : undefined;
}

function normalizeModelCard(value: unknown): XaiModelCard | undefined {
  const record = asRecord(value);
  if (
    record === null ||
    typeof record.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(record.id)
  ) {
    return undefined;
  }
  const maxPromptLength = record.max_prompt_length;
  const aliases = normalizeStringArray(record.aliases)?.filter((alias) =>
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(alias),
  );
  return {
    id: record.id,
    ...(aliases !== undefined ? { aliases } : {}),
    ...(typeof record.fingerprint === "string" && record.fingerprint.length <= 512
      ? { fingerprint: record.fingerprint }
      : {}),
    ...(typeof maxPromptLength === "number" &&
    Number.isInteger(maxPromptLength) &&
    maxPromptLength > 0
      ? { maxPromptLength }
      : {}),
    ...(normalizeStringArray(record.input_modalities) !== undefined
      ? { inputModalities: normalizeStringArray(record.input_modalities) }
      : {}),
    ...(normalizeStringArray(record.output_modalities) !== undefined
      ? { outputModalities: normalizeStringArray(record.output_modalities) }
      : {}),
  };
}

function publicModelCard(card: XaiModelCard): Record<string, unknown> {
  return {
    id: card.id,
    ...(card.aliases !== undefined ? { aliases: card.aliases } : {}),
    ...(card.fingerprint !== undefined ? { fingerprint: card.fingerprint } : {}),
    ...(card.maxPromptLength !== undefined
      ? { max_prompt_length: card.maxPromptLength }
      : {}),
    ...(card.inputModalities !== undefined
      ? { input_modalities: card.inputModalities }
      : {}),
    ...(card.outputModalities !== undefined
      ? { output_modalities: card.outputModalities }
      : {}),
  };
}

function parseMediaReference(value: unknown, label: string): MediaReference {
  const record = asRecord(value);
  if (record === null) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      `${label} must be an object containing exactly one of url or file_id`,
    );
  }
  assertAllowedKeys(record, ["url", "file_id", "path", "sha256"], label);
  const hasUrl = own(record, "url");
  const hasFileId = own(record, "file_id");
  const hasPath = own(record, "path");
  const hasSha = own(record, "sha256");
  const sourceKinds = Number(hasUrl) + Number(hasFileId) + Number(hasPath || hasSha);
  if (sourceKinds !== 1 || hasPath !== hasSha) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      `${label} must contain exactly one of url, file_id, or path plus sha256`,
    );
  }
  if (hasPath) {
    const path = requiredString(record, "path", { max: 16_384 });
    const sha256 = requiredString(record, "sha256", {
      max: 64,
      pattern: /^[A-Fa-f0-9]{64}$/u,
    }).toLowerCase();
    return { path, sha256 };
  }
  if (hasFileId) {
    const fileId = requiredString(record, "file_id", {
      max: 256,
      pattern: /^file_[A-Za-z0-9._:-]+$/u,
    });
    return { file_id: fileId };
  }
  const url = requiredString(record, "url", { max: 32 * 1024 * 1024 });
  if (/^data:(?:image|video)\/[A-Za-z0-9.+-]+;base64,/iu.test(url)) {
    return { url };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new XaiImagineBrokerError("invalid_request", `${label}.url is invalid`);
  }
  if (parsed.protocol !== "https:") {
    throw new XaiImagineBrokerError(
      "invalid_request",
      `${label}.url must use https or a supported data URI`,
    );
  }
  return { url };
}

function parseReferenceArray(
  value: unknown,
  label: string,
  min: number,
  max: number,
): readonly MediaReference[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      `${label} must contain ${min} through ${max} entries`,
    );
  }
  return value.map((entry, index) =>
    parseMediaReference(entry, `${label}[${index}]`),
  );
}

function parseAudioReferences(value: unknown): readonly AudioReference[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new XaiImagineBrokerError(
      "invalid_request",
      "reference_audios must contain 1 through 3 preset voices",
    );
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (record === null) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        `reference_audios[${index}] must be an object`,
      );
    }
    assertAllowedKeys(record, ["voice_id"], `reference_audios[${index}]`);
    return {
      voice_id: requiredString(record, "voice_id", {
        max: 128,
        pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/u,
      }).toLowerCase(),
    };
  });
}

function detectLocalMediaMime(
  bytes: Buffer,
  kind: "image" | "video",
): string | undefined {
  if (
    kind === "image" &&
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    kind === "image" &&
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    kind === "image" &&
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    kind === "video" &&
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    return "video/mp4";
  }
  if (
    kind === "video" &&
    bytes.length >= 4 &&
    bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  ) {
    return "video/webm";
  }
  return undefined;
}

type ExpectedArtifactMedia =
  | "image"
  | "video"
  | "audio-mp3"
  | "audio-wav"
  | "audio-raw";

function validateArtifactMedia(
  leadingBytes: Buffer,
  expected: ExpectedArtifactMedia,
): string {
  if (expected === "image" || expected === "video") {
    const detected = detectLocalMediaMime(leadingBytes, expected);
    if (detected === undefined) {
      throw new XaiImagineBrokerError(
        "integrity_mismatch",
        `The downloaded ${expected} artifact has an invalid file signature`,
      );
    }
    return detected;
  }
  if (expected === "audio-mp3") {
    const isId3 = leadingBytes.length >= 3 &&
      leadingBytes.subarray(0, 3).toString("ascii") === "ID3";
    const isFrame = leadingBytes.length >= 2 &&
      leadingBytes[0] === 0xff &&
      (leadingBytes[1]! & 0xe0) === 0xe0;
    if (!isId3 && !isFrame) {
      throw new XaiImagineBrokerError(
        "integrity_mismatch",
        "The downloaded MP3 artifact has an invalid file signature",
      );
    }
    return "audio/mpeg";
  }
  if (expected === "audio-wav") {
    if (
      leadingBytes.length < 12 ||
      leadingBytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
      leadingBytes.subarray(8, 12).toString("ascii") !== "WAVE"
    ) {
      throw new XaiImagineBrokerError(
        "integrity_mismatch",
        "The downloaded WAV artifact has an invalid file signature",
      );
    }
    return "audio/wav";
  }
  return "application/octet-stream";
}

function safeUsage(value: unknown): Record<string, unknown> | undefined {
  const usage = asRecord(value);
  if (usage === null) return undefined;
  const cost = usage.cost_in_usd_ticks;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
    return { cost_in_usd_ticks: cost };
  }
  if (typeof cost === "string" && /^\d{1,128}$/u.test(cost)) {
    return { cost_in_usd_ticks: cost };
  }
  return undefined;
}

function normalizeAudioTimestamps(
  value: unknown,
  durationSeconds?: number,
): Record<string, unknown> {
  const timestamps = asRecord(value);
  const characters = timestamps?.graph_chars;
  const times = timestamps?.graph_times;
  if (
    !Array.isArray(characters) ||
    !Array.isArray(times) ||
    characters.length !== times.length ||
    characters.length > MAX_TTS_TEXT_LENGTH ||
    !characters.every(
      (entry) => typeof entry === "string" && entry.length <= 16,
    ) ||
    !times.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry.every(
          (point) =>
            typeof point === "number" && Number.isFinite(point) && point >= 0,
        ),
    )
  ) {
    throw new XaiImagineBrokerError(
      "submission_unknown",
      "xAI completed TTS but returned malformed character timestamps",
    );
  }
  let previousEnd = 0;
  for (const [start, end] of times as [number, number][]) {
    if (
      start > end ||
      start + 0.001 < previousEnd ||
      (durationSeconds !== undefined && end > durationSeconds + 0.05)
    ) {
      throw new XaiImagineBrokerError(
        "submission_unknown",
        "xAI completed TTS but returned non-monotonic character timestamps",
      );
    }
    previousEnd = end;
  }
  return { graph_chars: characters, graph_times: times };
}

function safeFileOutput(value: unknown): Record<string, unknown> | undefined {
  const file = asRecord(value);
  if (file === null) return undefined;
  const result: Record<string, unknown> = {};
  const stringLimits: Readonly<Record<string, number>> = {
    file_id: 512,
    filename: 1_024,
    expires_at: 128,
    public_url_expires_at: 128,
  };
  for (const [key, limit] of Object.entries(stringLimits)) {
    const item = file[key];
    if (typeof item === "string" && item.length <= limit) {
      result[key] = item;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeImagesPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (
    !Array.isArray(payload.data) ||
    payload.data.length === 0
  ) {
    throw new XaiImagineBrokerError(
      "submission_unknown",
      "xAI accepted the image submission but returned no usable image records",
      { retryable: false },
    );
  }
  if (payload.data.length > MAX_IMAGE_RESULTS) {
    throw new XaiImagineBrokerError(
      "submission_unknown",
      "xAI accepted the image submission but returned an unsafe number of image records",
      {
        retryable: false,
        details: { observed_count: payload.data.length, salvage_limit: MAX_IMAGE_RESULTS },
      },
    );
  }
  const images = payload.data.map((item) => {
    const record = asRecord(item);
    if (record === null) {
      return { provider_record_valid: false };
    }
    const image: Record<string, unknown> = {};
    for (const [key, max] of [
      ["url", 32_768],
      ["mime_type", 256],
      ["revised_prompt", MAX_PUBLIC_PROMPT_LENGTH],
    ] as const) {
      if (typeof record[key] === "string" && record[key].length <= max) {
        image[key] = record[key];
      }
    }
    const fileOutput = safeFileOutput(record.file_output);
    if (fileOutput !== undefined) image.file_output = fileOutput;
    if (
      typeof image.url !== "string" &&
      fileOutput?.file_id === undefined
    ) {
      image.provider_record_valid = false;
    } else {
      image.provider_record_valid = true;
    }
    return image;
  });
  const usage = safeUsage(payload.usage);
  return {
    images,
    ...(usage !== undefined ? { usage } : {}),
  };
}

function publicImagesPayload(
  normalized: Record<string, unknown>,
): Record<string, unknown> {
  const images = Array.isArray(normalized.images) ? normalized.images : [];
  return {
    images: images.map((entry, index) => {
      const image = asRecord(entry) ?? {};
      return {
        index,
        provider_record_valid: image.provider_record_valid === true,
        ...(typeof image.mime_type === "string"
          ? { mime_type: image.mime_type }
          : {}),
        ...(typeof image.revised_prompt === "string"
          ? { revised_prompt: image.revised_prompt }
          : {}),
      };
    }),
    ...(asRecord(normalized.usage) !== null ? { usage: normalized.usage } : {}),
  };
}

function publicVideoPayload(
  normalized: Record<string, unknown>,
): Record<string, unknown> {
  const video = asRecord(normalized.video);
  if (video === null) return normalized;
  const publicVideo = { ...video };
  delete publicVideo.url;
  delete publicVideo.file_output;
  return {
    ...normalized,
    video: publicVideo,
  };
}

function normalizeVideoPayload(
  requestId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    request_id: requestId,
    status:
      typeof payload.status === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/u.test(payload.status)
        ? payload.status.toLowerCase()
        : "unknown",
  };
  if (
    typeof payload.progress === "number" &&
    Number.isFinite(payload.progress) &&
    payload.progress >= 0 &&
    payload.progress <= 100
  ) {
    result.progress = payload.progress;
  }
  if (
    typeof payload.model === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(payload.model)
  ) {
    result.model = payload.model;
  }
  const video = asRecord(payload.video);
  if (video !== null) {
    const normalized: Record<string, unknown> = {};
    if (typeof video.url === "string" && video.url.length <= 32_768) {
      normalized.url = video.url;
    }
    if (
      typeof video.duration === "number" &&
      Number.isFinite(video.duration) &&
      video.duration >= 0
    ) {
      normalized.duration = video.duration;
    }
    if (typeof video.respect_moderation === "boolean") {
      normalized.respect_moderation = video.respect_moderation;
    }
    const fileOutput = safeFileOutput(video.file_output);
    if (fileOutput !== undefined) normalized.file_output = fileOutput;
    if (Object.keys(normalized).length > 0) result.video = normalized;
  }
  const usage = safeUsage(payload.usage);
  if (usage !== undefined) result.usage = usage;
  const error = asRecord(payload.error);
  if (error !== null && typeof error.message === "string") {
    const code =
      typeof error.code === "string" &&
      new Set([
        "invalid_argument",
        "permission_denied",
        "failed_precondition",
        "service_unavailable",
        "internal_error",
      ]).has(error.code)
        ? error.code
        : "unknown";
    result.provider_error = {
      code,
      message: cleanMessage(error.message, "xAI video request failed"),
      retryable: code === "service_unavailable" || code === "internal_error",
    };
  }
  return result;
}

function safeMimeType(value: string | null): string {
  if (
    value !== null &&
    value.length <= 256 &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+"'():-]+)*$/u.test(
      value,
    )
  ) {
    return value;
  }
  return "application/octet-stream";
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > JSON_RESPONSE_LIMIT_BYTES) {
    await discardResponseBody(response);
    throw new XaiImagineBrokerError(
      "upstream_unavailable",
      "xAI returned an unexpectedly large JSON response",
      { retryable: true, details: { http_status: response.status } },
    );
  }
  if (response.body === null) {
    throw new XaiImagineBrokerError(
      "upstream_unavailable",
      "xAI returned an empty JSON response",
      { retryable: response.status >= 500, details: { http_status: response.status } },
    );
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      bytes += chunk.length;
      if (bytes > JSON_RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new XaiImagineBrokerError(
          "upstream_unavailable",
          "xAI returned an unexpectedly large JSON response",
          { retryable: true, details: { http_status: response.status } },
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const text = Buffer.concat(chunks, bytes).toString("utf8");
  try {
    return asRecord(JSON.parse(text)) ?? {};
  } catch {
    throw new XaiImagineBrokerError(
      "upstream_unavailable",
      "xAI returned a non-JSON response",
      {
        retryable: response.status >= 500,
        details: { http_status: response.status },
      },
    );
  }
}

function providerErrorMessage(
  payload: Record<string, unknown>,
  fallback: string,
): string {
  const error = asRecord(payload.error);
  return cleanMessage(error?.message, fallback);
}

function retryAfterDetails(response: Response): Record<string, unknown> | undefined {
  const directive = parseProviderRetryAfterDirective(response.headers);
  if (directive.classification !== "valid") return undefined;
  return { retry_after_ms: directive.floorMs };
}

function definiteHttpError(
  response: Response,
  payload: Record<string, unknown>,
): XaiImagineBrokerError {
  const details = {
    http_status: response.status,
    ...(retryAfterDetails(response) ?? {}),
  };
  if (response.status === 401 || response.status === 403) {
    return new XaiImagineBrokerError(
      "auth_or_entitlement_denied",
      "xAI rejected the OAuth session or its Imagine entitlement",
      { retryable: false, details },
    );
  }
  if (response.status === 429) {
    return new XaiImagineBrokerError(
      "rate_limited",
      providerErrorMessage(payload, "xAI rate limited the request"),
      { retryable: true, details },
    );
  }
  return new XaiImagineBrokerError(
    "upstream_rejected",
    providerErrorMessage(payload, `xAI rejected the request (HTTP ${response.status})`),
    { retryable: false, details },
  );
}

function fetchTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

export class XaiImagineBroker {
  readonly #fetch: typeof fetch;
  readonly #oauth: XaiImagineBrokerOauth;
  readonly #now: () => number;
  readonly #artifactRoot: string;
  readonly #recoveryRoot: string;
  readonly #migrateStorage: () => SecureStorageMigrationResult;

  constructor(options: XaiImagineBrokerOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#oauth = options.oauth ?? DEFAULT_OAUTH;
    this.#now = options.now ?? Date.now;
    this.#artifactRoot = resolve(options.artifactRoot ?? process.cwd());
    const rootFingerprint = createHash("sha256")
      .update(this.#artifactRoot, "utf8")
      .digest("hex");
    this.#recoveryRoot = resolve(
      options.recoveryRoot ??
        join(getAgenCConfigHomeDir(), "xai-imagine-recovery", rootFingerprint),
    );
    this.#migrateStorage =
      options.migrateStorage ?? migratePlainTextStorageToNative;
  }

  async handle(request: XaiImagineBrokerRequest): Promise<Record<string, unknown>> {
    const params = paramsObject(request.params);
    switch (request.method) {
      case "protocol.version":
        assertAllowedKeys(params, [], "params");
        return {
          name: XAI_IMAGINE_BROKER_PROTOCOL_NAME,
          version: XAI_IMAGINE_BROKER_PROTOCOL_VERSION,
          transport: "ndjson-stdio",
          auth_modes: ["oauth"],
          base_url: XAI_IMAGINE_API_BASE_URL,
          artifact_root: this.#artifactRoot,
          methods: [...METHOD_NAMES],
          method_schemas: XAI_IMAGINE_BROKER_METHOD_SCHEMAS,
        };
      case "operations.status":
        return this.#operationStatus(params);
      case "auth.status":
        assertAllowedKeys(params, [], "params");
        return this.#authStatus();
      case "auth.migrate_storage":
        assertAllowedKeys(params, [], "params");
        return this.#authMigrateStorage();
      case "capabilities.probe":
        assertAllowedKeys(params, [], "params");
        return this.#capabilitiesProbe();
      case "images.generate":
        return this.#imagesGenerate(params);
      case "images.edit":
        return this.#imagesEdit(params);
      case "videos.submit":
        return this.#videosSubmit(params);
      case "videos.poll":
        return this.#videosPoll(params);
      case "tts.voices":
        return this.#ttsVoices(params);
      case "tts.generate":
        return this.#ttsGenerate(params);
      case "artifacts.download":
        return this.#artifactDownload(params);
    }
  }

  #authStatus(): Record<string, unknown> {
    const credentials = this.#oauth.read();
    if (credentials === undefined) {
      const storage = "none";
      return {
        auth_mode: "oauth",
        configured: false,
        ready: false,
        storage,
        storage_security: storageSecurityStatus(storage, false),
      };
    }
    const quarantined = credentials.quarantinedAt !== undefined;
    const expiresAt = safeIsoDate(credentials.expiresAt);
    const quarantinedAt = safeIsoDate(credentials.quarantinedAt);
    const storage = safeStorageName(this.#oauth.storageKind());
    const refreshable = Boolean(credentials.refreshToken?.trim());
    const expiring = !quarantined && xaiOauthTokenIsExpiring(credentials);
    const ready = !quarantined && (!expiring || refreshable);
    return {
      auth_mode: "oauth",
      configured: true,
      ready,
      quarantined,
      refreshable,
      expiring,
      needs_reauthentication: !ready,
      storage,
      storage_security: storageSecurityStatus(storage, true),
      ...(credentials.accountLabel !== undefined &&
      credentials.accountLabel.trim().length > 0
        ? {
            account_label: cleanMessage(
              credentials.accountLabel,
              "account",
            ).slice(0, 256),
          }
        : {}),
      ...(expiresAt !== undefined
        ? {
            expires_at: expiresAt,
            expires_in_seconds: Math.floor(
              (credentials.expiresAt! - this.#now()) / 1_000,
            ),
          }
        : {}),
      ...(quarantined && quarantinedAt !== undefined
        ? {
            quarantined_at: quarantinedAt,
            quarantine_reason: cleanMessage(
              credentials.quarantineReason,
              "OAuth refresh grant is no longer usable",
            ),
          }
        : {}),
    };
  }

  #authMigrateStorage(): Record<string, unknown> {
    const result = this.#migrateStorage();
    if (!result.success) {
      throw new XaiImagineBrokerError(
        "storage_migration_failed",
        "Credential storage could not be migrated and the plaintext fallback was retained",
        {
          retryable: true,
          details: {
            reason: result.reason,
            storage: safeStorageName(result.storage),
          },
        },
      );
    }
    return {
      migrated: result.migrated,
      already_secure: result.alreadySecure,
      storage: safeStorageName(result.storage),
      storage_security: storageSecurityStatus(
        safeStorageName(result.storage),
        result.storage !== "none",
      ),
    };
  }

  async #freshBearer(): Promise<string> {
    const current = this.#oauth.read();
    if (current === undefined) {
      throw new XaiImagineBrokerError(
        "auth_required",
        "No AgenC xAI OAuth session is stored; run `agenc xai auth login` first",
      );
    }
    if (current.quarantinedAt !== undefined) {
      throw new XaiImagineBrokerError(
        "auth_quarantined",
        "The stored xAI OAuth grant is quarantined; run `agenc xai auth login` again",
      );
    }
    if (!xaiOauthTokenIsExpiring(current)) return current.accessToken;
    const refreshed = await this.#oauth.refreshIfNeeded();
    if (refreshed?.accessToken) return refreshed.accessToken;
    const latest = this.#oauth.read();
    if (latest?.quarantinedAt !== undefined) {
      throw new XaiImagineBrokerError(
        "auth_quarantined",
        "The stored xAI OAuth grant is quarantined; run `agenc xai auth login` again",
      );
    }
    throw new XaiImagineBrokerError(
      "auth_refresh_failed",
      "The xAI OAuth bearer needs refresh, but no fresh bearer was obtained",
      { retryable: true },
    );
  }

  async #safeRead(
    path: string,
    options: { readonly accept?: string; readonly timeoutMs?: number } = {},
  ): Promise<Response> {
    let bearer = await this.#freshBearer();
    const send = (token: string) =>
      this.#fetch(`${XAI_IMAGINE_API_BASE_URL}${path}`, {
        method: "GET",
        headers: {
          accept: options.accept ?? "application/json",
          authorization: `Bearer ${token}`,
        },
        redirect: "error",
        signal: fetchTimeout(options.timeoutMs ?? READ_TIMEOUT_MS),
      });
    let response: Response;
    try {
      response = await send(bearer);
    } catch {
      throw new XaiImagineBrokerError(
        "upstream_unavailable",
        "The authenticated xAI read failed before a response was received",
        { retryable: true },
      );
    }
    if (response.status !== 401 && response.status !== 403) return response;
    await discardResponseBody(response);
    const refreshed = await this.#oauth.forceRefresh();
    if (!refreshed?.accessToken) {
      throw new XaiImagineBrokerError(
        "auth_refresh_failed",
        "xAI rejected the OAuth bearer and refresh did not produce a replacement",
        { retryable: true, details: { http_status: response.status } },
      );
    }
    bearer = refreshed.accessToken;
    try {
      return await send(bearer);
    } catch {
      throw new XaiImagineBrokerError(
        "upstream_unavailable",
        "The authenticated xAI read failed after OAuth refresh",
        { retryable: true },
      );
    }
  }

  async #modelRegistry(kind: "image" | "video"): Promise<readonly XaiModelCard[]> {
    const path = kind === "image"
      ? "/image-generation-models"
      : "/video-generation-models";
    const response = await this.#safeRead(path);
    const payload = await readJsonResponse(response);
    if (!response.ok) throw definiteHttpError(response, payload);
    const rawModels = Array.isArray(payload.models)
      ? payload.models
      : Array.isArray(payload.data)
        ? payload.data
        : undefined;
    if (rawModels === undefined) {
      throw new XaiImagineBrokerError(
        "upstream_unavailable",
        `xAI returned a malformed ${kind} model registry`,
        { retryable: true },
      );
    }
    if (rawModels.length > MAX_REGISTRY_ITEMS) {
      throw new XaiImagineBrokerError(
        "upstream_unavailable",
        `xAI returned too many ${kind} model records`,
        { retryable: true },
      );
    }
    return rawModels
      .map((entry) => normalizeModelCard(entry))
      .filter((entry): entry is XaiModelCard => entry !== undefined);
  }

  async #resolveModel(
    kind: "image" | "video",
    requestedModel: string | undefined,
    requiredInputs: readonly ("text" | "image" | "audio" | "video")[],
    prompt: string,
    preferredIds: readonly string[],
  ): Promise<string> {
    const models = await this.#modelRegistry(kind);
    const model = requestedModel === undefined
      ? undefined
      : validateModel(requestedModel);
    const expectedOutput = kind;
    const supportsContract = (entry: XaiModelCard) => {
      const inputModalities = entry.inputModalities?.map((item) => item.toLowerCase());
      const outputModalities = entry.outputModalities?.map((item) => item.toLowerCase());
      return (
        inputModalities !== undefined &&
        requiredInputs.every((required) => inputModalities.includes(required)) &&
        outputModalities?.includes(expectedOutput) === true
      );
    };
    const matchingCards = (identifier: string) =>
      models.filter(
        (entry) =>
          entry.id === identifier || entry.aliases?.includes(identifier) === true,
      );
    let card: XaiModelCard | undefined;
    if (model !== undefined) {
      const matches = matchingCards(model);
      if (matches.length > 1) {
        throw new XaiImagineBrokerError(
          "upstream_unavailable",
          `xAI returned a colliding ${kind} model alias`,
          { retryable: true },
        );
      }
      card = matches[0];
    } else {
      for (const preferred of preferredIds) {
        const matches = matchingCards(preferred);
        if (matches.length > 1) {
          throw new XaiImagineBrokerError(
            "upstream_unavailable",
            `xAI returned a colliding ${kind} model alias`,
            { retryable: true },
          );
        }
        if (matches[0] !== undefined && supportsContract(matches[0])) {
          card = matches[0];
          break;
        }
      }
      card ??= models.find(supportsContract);
    }
    if (card === undefined) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        model === undefined
          ? `No live ${kind} model advertises the required input and output modalities`
          : `${kind} model '${model}' is not present in the live OAuth model registry`,
        {
          details: {
            ...(model !== undefined ? { model } : {}),
            required_input_modalities: requiredInputs,
            required_output_modality: expectedOutput,
            registry: `${kind}-generation-models`,
          },
        },
      );
    }
    if (
      card.maxPromptLength !== undefined &&
      [...prompt].length > card.maxPromptLength
    ) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        `prompt exceeds model '${card.id}' max_prompt_length`,
        { details: { model: card.id, max_prompt_length: card.maxPromptLength } },
      );
    }
    const inputModalities = card.inputModalities?.map((entry) => entry.toLowerCase());
    const outputModalities = card.outputModalities?.map((entry) => entry.toLowerCase());
    const missingInputs = requiredInputs.filter(
      (required) => inputModalities?.includes(required) !== true,
    );
    if (missingInputs.length > 0 || outputModalities?.includes(expectedOutput) !== true) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        `model '${card.id}' does not advertise the required live modalities`,
        {
          details: {
            model: card.id,
            required_input_modalities: requiredInputs,
            required_output_modality: expectedOutput,
            advertised_input_modalities: inputModalities ?? [],
            advertised_output_modalities: outputModalities ?? [],
          },
        },
      );
    }
    return model ?? card.id;
  }

  async #listVoices(): Promise<readonly Record<string, unknown>[]> {
    const response = await this.#safeRead("/tts/voices");
    const payload = await readJsonResponse(response);
    if (!response.ok) throw definiteHttpError(response, payload);
    if (
      !Array.isArray(payload.voices) ||
      payload.voices.length > MAX_REGISTRY_ITEMS
    ) {
      throw new XaiImagineBrokerError(
        "upstream_unavailable",
        "xAI returned a malformed TTS voice registry",
        { retryable: true },
      );
    }
    return payload.voices.flatMap((entry) => {
      const voice = asRecord(entry);
      if (
        voice === null ||
        typeof voice.voice_id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(voice.voice_id)
      ) {
        return [];
      }
      const normalized: Record<string, unknown> = { voice_id: voice.voice_id };
      for (const key of ["name", "language", "description", "gender"]) {
        if (
          typeof voice[key] === "string" &&
          voice[key].length <= MAX_PUBLIC_METADATA_LENGTH
        ) {
          normalized[key] = voice[key];
        }
      }
      return [normalized];
    });
  }

  #safeProbeError(error: unknown): Record<string, unknown> {
    if (error instanceof XaiImagineBrokerError) {
      return {
        available: false,
        evidence: "oauth_endpoint_response",
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(typeof error.details?.http_status === "number"
            ? { http_status: error.details.http_status }
            : {}),
        },
      };
    }
    return {
      available: false,
      evidence: "probe_failure",
      error: {
        code: "internal_error",
        message: "Capability probe failed",
        retryable: false,
      },
    };
  }

  async #capabilitiesProbe(): Promise<Record<string, unknown>> {
    await this.#freshBearer();
    let image: Record<string, unknown>;
    let video: Record<string, unknown>;
    let tts: Record<string, unknown>;
    try {
      const models = await this.#modelRegistry("image");
      image = {
        available: true,
        evidence: "oauth_endpoint_response",
        registry_path: "/v1/image-generation-models",
        models: models.map(publicModelCard),
      };
    } catch (error) {
      image = this.#safeProbeError(error);
    }
    try {
      const models = await this.#modelRegistry("video");
      video = {
        available: true,
        evidence: "oauth_endpoint_response",
        registry_path: "/v1/video-generation-models",
        models: models.map(publicModelCard),
      };
    } catch (error) {
      video = this.#safeProbeError(error);
    }
    try {
      const voices = await this.#listVoices();
      tts = {
        available: true,
        evidence: "oauth_endpoint_response",
        voices_path: "/v1/tts/voices",
        voices,
        generate_entitlement: "unverified_until_submission",
      };
    } catch (error) {
      tts = this.#safeProbeError(error);
    }
    return {
      auth_mode: "oauth",
      base_url: XAI_IMAGINE_API_BASE_URL,
      observed_at: new Date(this.#now()).toISOString(),
      observed: { image, video, tts },
      documented_contract: {
        evidence: "xai_documentation_not_live_entitlement",
        images: ["generate", "edit"],
        videos: ["generate", "edit", "extend", "poll"],
        tts: ["voices", "generate"],
      },
      artifact_download: {
        available: true,
        evidence: "local_broker_capability",
        root: this.#artifactRoot,
      },
    };
  }

  async #post(
    path: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ response: Response; payload: Record<string, unknown> }> {
    let bearer = await this.#freshBearer();
    const send = (token: string) =>
      this.#fetch(`${XAI_IMAGINE_API_BASE_URL}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: fetchTimeout(POST_TIMEOUT_MS),
      });
    let response: Response;
    try {
      response = await send(bearer);
    } catch {
      throw new XaiImagineBrokerError(
        "submission_unknown",
        "No response was received for the paid submission; do not create a new idempotency key or resubmit blindly",
        {
          retryable: false,
          details: { idempotency_key: idempotencyKey },
        },
      );
    }
    if (response.status === 401 || response.status === 403) {
      await discardResponseBody(response);
      const refreshed = await this.#oauth.forceRefresh();
      if (!refreshed?.accessToken) {
        throw new XaiImagineBrokerError(
          "auth_refresh_failed",
          "xAI rejected the OAuth bearer and refresh did not produce a replacement",
          { retryable: true, details: { http_status: response.status } },
        );
      }
      bearer = refreshed.accessToken;
      try {
        response = await send(bearer);
      } catch {
        throw new XaiImagineBrokerError(
          "submission_unknown",
          "The paid submission failed after a safe OAuth refresh replay with the same idempotency key; acceptance is unknown",
          {
            retryable: false,
            details: { idempotency_key: idempotencyKey },
          },
        );
      }
    }
    let payload: Record<string, unknown>;
    try {
      payload = await readJsonResponse(response);
    } catch (error) {
      if (
        (response.status >= 200 && response.status < 300) ||
        response.status >= 500
      ) {
        throw new XaiImagineBrokerError(
          "submission_unknown",
          "The paid submission returned an ambiguous response; do not resubmit blindly",
          {
            retryable: false,
            details: {
              idempotency_key: idempotencyKey,
              http_status: response.status,
            },
          },
        );
      }
      throw error;
    }
    if (response.status >= 500) {
      throw new XaiImagineBrokerError(
        "submission_unknown",
        "xAI returned a server error for the paid submission; acceptance is unknown",
        {
          retryable: false,
          details: {
            idempotency_key: idempotencyKey,
            http_status: response.status,
          },
        },
      );
    }
    if (!response.ok) throw definiteHttpError(response, payload);
    return { response, payload };
  }

  async #materializeMediaReference(
    reference: MediaReference,
    kind: "image" | "video",
  ): Promise<{ readonly url: string } | { readonly file_id: string }> {
    if (!("path" in reference)) return reference;
    const path = await this.#destinationPath(
      reference.path,
      "require",
      false,
    );
    await this.#assertArtifactParentStillBound(path);
    const maxBytes = kind === "image"
      ? MAX_LOCAL_IMAGE_REFERENCE_BYTES
      : MAX_LOCAL_VIDEO_REFERENCE_BYTES;
    const file = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    ).catch(() => undefined);
    if (file === undefined) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "local media reference could not be opened safely",
      );
    }
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
        throw new XaiImagineBrokerError(
          "invalid_request",
          `local ${kind} reference must be a non-empty regular file no larger than ${maxBytes} bytes`,
        );
      }
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const read = await file.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
        if (bytes > maxBytes) {
          throw new XaiImagineBrokerError(
            "invalid_request",
            `local ${kind} reference grew beyond its size limit while reading`,
          );
        }
        const chunk = Buffer.from(buffer.subarray(0, read.bytesRead));
        chunks.push(chunk);
        hash.update(chunk);
      }
    } finally {
      await file.close();
    }
    await this.#assertArtifactParentStillBound(path);
    const actualSha = hash.digest("hex");
    if (actualSha !== reference.sha256) {
      throw new XaiImagineBrokerError(
        "integrity_mismatch",
        "local media reference does not match its required sha256",
        {
          details: {
            path,
            expected_sha256: reference.sha256,
            actual_sha256: actualSha,
          },
        },
      );
    }
    const content = Buffer.concat(chunks, bytes);
    const mime = detectLocalMediaMime(content, kind);
    if (mime === undefined) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        `local ${kind} reference has an unsupported or mismatched file signature`,
      );
    }
    return { url: `data:${mime};base64,${content.toString("base64")}` };
  }

  async #imageDestinations(
    params: Record<string, unknown>,
    count: number,
  ): Promise<readonly string[]> {
    if (!Array.isArray(params.destinations) || params.destinations.length !== count) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        `destinations must contain exactly ${count} absolute artifact path${count === 1 ? "" : "s"}`,
      );
    }
    const values = params.destinations.map((value, index) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new XaiImagineBrokerError(
          "invalid_request",
          `destinations[${index}] must be a non-empty string`,
        );
      }
      return value.trim();
    });
    const destinations: string[] = [];
    for (const value of values) destinations.push(await this.#destinationPath(value));
    if (new Set(destinations).size !== destinations.length) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "destinations must not contain duplicate paths",
      );
    }
    return destinations;
  }

  async #persistImages(
    normalized: Record<string, unknown>,
    destinations: readonly string[],
    idempotencyKey: string,
    onCheckpoint?: (
      recoveries: readonly {
        readonly index: number;
        readonly recovery_handle: string;
        readonly destination: string;
      }[],
    ) => Promise<void>,
  ): Promise<readonly Record<string, unknown>[]> {
    const images = Array.isArray(normalized.images) ? normalized.images : [];
    const unrecoverableOutputs: number[] = [];
    const planned = images.flatMap((entry, index) => {
      const image = asRecord(entry);
      const url = image?.url;
      const fileId = asRecord(image?.file_output)?.file_id;
      if (typeof url !== "string" && typeof fileId !== "string") {
        unrecoverableOutputs.push(index);
        return [];
      }
      return [{
        index,
        source:
          typeof fileId === "string"
            ? { file_id: fileId }
            : { url: url as string },
        destination:
          destinations[index] ??
          join(
            this.#artifactRoot,
            UNEXPECTED_ARTIFACT_DIRECTORY,
            `${randomUUID()}.bin`,
          ),
      }];
    });
    const recoveries: Array<{
      readonly index: number;
      readonly recovery_handle: string;
      readonly destination: string;
    }> = [];
    for (const item of planned) {
      try {
        recoveries.push({
          index: item.index,
          recovery_handle: await this.#createRecoveryRecord(
            item.source,
            item.destination,
            DEFAULT_DOWNLOAD_LIMIT_BYTES,
            "image",
          ),
          destination: item.destination,
        });
        await onCheckpoint?.(recoveries);
      } catch (error) {
        const brokerError = error instanceof XaiImagineBrokerError
          ? error
          : new XaiImagineBrokerError("download_failed", "Recovery setup failed");
        throw new XaiImagineBrokerError(
          "download_failed",
          "Image generation completed, but the broker could not checkpoint every artifact source",
          {
            retryable: brokerError.retryable,
            details: {
              idempotency_key: idempotencyKey,
              cause_code: brokerError.code,
              checkpointed_artifacts: recoveries,
              uncheckpointed_image_index: item.index,
              ...(typeof brokerError.details?.recovery_handle === "string"
                ? {
                    uncertain_recovery_handle:
                      brokerError.details.recovery_handle,
                    checkpoint_state: "uncertain",
                  }
                : {}),
            },
          },
        );
      }
    }
    const completed: Record<string, unknown>[] = [];
    for (let offset = 0; offset < recoveries.length; offset += 1) {
      const recovery = recoveries[offset]!;
      try {
        completed.push(await this.#consumeRecoveryRecord(recovery.recovery_handle));
      } catch (error) {
        const brokerError = error instanceof XaiImagineBrokerError
          ? error
          : new XaiImagineBrokerError("download_failed", "Image download failed");
        throw new XaiImagineBrokerError(
          "download_failed",
          "Image generation completed, but immediate artifact persistence did not; resume only through the opaque recovery handles",
          {
            retryable: brokerError.retryable,
            details: {
              idempotency_key: idempotencyKey,
              cause_code: brokerError.code,
              completed_artifacts: completed,
              pending_artifacts: recoveries.slice(offset),
            },
          },
        );
      }
    }
    if (
      images.length !== destinations.length ||
      unrecoverableOutputs.length > 0
    ) {
      throw new XaiImagineBrokerError(
        "download_failed",
        "xAI returned an unexpected image artifact set; every recoverable output was preserved locally",
        {
          details: {
            idempotency_key: idempotencyKey,
            expected_count: destinations.length,
            actual_count: images.length,
            completed_artifacts: completed,
            unrecoverable_image_indexes: unrecoverableOutputs,
          },
        },
      );
    }
    return completed;
  }

  async #imagesGenerate(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(
      params,
      [
        "idempotency_key",
        "prompt",
        "model",
        "n",
        "aspect_ratio",
        "resolution",
        "destinations",
      ],
      "params",
    );
    const idempotencyKey = requiredIdempotencyKey(params);
    const prompt = requiredPrompt(params);
    const requestedModel = optionalString(params, "model");
    const n = optionalInteger(params, "n", 1, 10) ?? 1;
    const aspectRatio = optionalEnum(params, "aspect_ratio", IMAGE_ASPECT_RATIOS);
    const resolution = optionalEnum(params, "resolution", new Set(["1k", "2k"]));
    const destinations = await this.#imageDestinations(params, n);
    const model = await this.#resolveModel(
      "image",
      requestedModel,
      ["text"],
      prompt,
      ["grok-imagine-image-quality", "grok-imagine-image"],
    );
    const body: Record<string, unknown> = {
      model,
      prompt,
      n,
      response_format: "url",
      storage_options: privateStorageOptions(idempotencyKey, "png"),
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
    };
    const prior = await this.#beginPaidOperation("images.generate", idempotencyKey);
    if (prior !== undefined) return prior;
    const { payload } = await this.#post("/images/generations", body, idempotencyKey);
    const normalized = normalizeImagesPayload(payload);
    let artifacts: readonly Record<string, unknown>[];
    try {
      artifacts = await this.#persistImages(
        normalized,
        destinations,
        idempotencyKey,
        async (recoveries) => {
          await this.#writeOperationReceipt(
            "images.generate",
            idempotencyKey,
            "recovery_required",
            { recovery: { pending_artifacts: recoveries } },
          );
        },
      );
    } catch (error) {
      if (error instanceof XaiImagineBrokerError) {
        await this.#writeOperationReceipt(
          "images.generate",
          idempotencyKey,
          "recovery_required",
          { recovery: error.details ?? { cause_code: error.code } },
        ).catch(() => {});
      }
      throw error;
    }
    const result = {
      operation: "generate",
      idempotency_key: idempotencyKey,
      ...publicImagesPayload(normalized),
      artifacts,
    };
    await this.#writeOperationReceipt(
      "images.generate",
      idempotencyKey,
      "completed",
      { result },
    );
    return result;
  }

  async #imagesEdit(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(
      params,
      [
        "idempotency_key",
        "prompt",
        "model",
        "images",
        "n",
        "aspect_ratio",
        "resolution",
        "destinations",
      ],
      "params",
    );
    const idempotencyKey = requiredIdempotencyKey(params);
    const prompt = requiredPrompt(params);
    const requestedModel = optionalString(params, "model");
    const images = await Promise.all(
      parseReferenceArray(params.images, "images", 1, 3).map((reference) =>
        this.#materializeMediaReference(reference, "image"),
      ),
    );
    const n = optionalInteger(params, "n", 1, 10) ?? 1;
    const aspectRatio = optionalEnum(params, "aspect_ratio", IMAGE_ASPECT_RATIOS);
    const resolution = optionalEnum(params, "resolution", new Set(["1k", "2k"]));
    const destinations = await this.#imageDestinations(params, n);
    const model = await this.#resolveModel(
      "image",
      requestedModel,
      ["text", "image"],
      prompt,
      ["grok-imagine-image-quality", "grok-imagine-image"],
    );
    const body: Record<string, unknown> = {
      model,
      prompt,
      n,
      response_format: "url",
      storage_options: privateStorageOptions(idempotencyKey, "png"),
      ...(images.length === 1 ? { image: images[0] } : { images }),
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
    };
    const prior = await this.#beginPaidOperation("images.edit", idempotencyKey);
    if (prior !== undefined) return prior;
    const { payload } = await this.#post("/images/edits", body, idempotencyKey);
    const normalized = normalizeImagesPayload(payload);
    let artifacts: readonly Record<string, unknown>[];
    try {
      artifacts = await this.#persistImages(
        normalized,
        destinations,
        idempotencyKey,
        async (recoveries) => {
          await this.#writeOperationReceipt(
            "images.edit",
            idempotencyKey,
            "recovery_required",
            { recovery: { pending_artifacts: recoveries } },
          );
        },
      );
    } catch (error) {
      if (error instanceof XaiImagineBrokerError) {
        await this.#writeOperationReceipt(
          "images.edit",
          idempotencyKey,
          "recovery_required",
          { recovery: error.details ?? { cause_code: error.code } },
        ).catch(() => {});
      }
      throw error;
    }
    const result = {
      operation: "edit",
      idempotency_key: idempotencyKey,
      ...publicImagesPayload(normalized),
      artifacts,
    };
    await this.#writeOperationReceipt(
      "images.edit",
      idempotencyKey,
      "completed",
      { result },
    );
    return result;
  }

  async #videosSubmit(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(
      params,
      [
        "idempotency_key",
        "operation",
        "prompt",
        "model",
        "duration",
        "aspect_ratio",
        "resolution",
        "image",
        "reference_images",
        "reference_audios",
        "video",
      ],
      "params",
    );
    const idempotencyKey = requiredIdempotencyKey(params);
    const prompt = requiredPrompt(params);
    const operation = optionalString(params, "operation") ?? "generate";
    if (!new Set(["generate", "edit", "extend"]).has(operation)) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "operation must be generate, edit, or extend",
      );
    }
    const requestedModel = optionalString(params, "model");
    let model: string;
    let body: Record<string, unknown>;
    let path: string;
    if (operation === "generate") {
      if (own(params, "video")) {
        throw new XaiImagineBrokerError(
          "invalid_request",
          "video is only valid for edit or extend operations",
        );
      }
      const image = own(params, "image")
        ? await this.#materializeMediaReference(
            parseMediaReference(params.image, "image"),
            "image",
          )
        : undefined;
      const references = own(params, "reference_images")
        ? await Promise.all(
            parseReferenceArray(
              params.reference_images,
              "reference_images",
              1,
              7,
            ).map((reference) =>
              this.#materializeMediaReference(reference, "image"),
            ),
          )
        : undefined;
      const referenceAudios = own(params, "reference_audios")
        ? parseAudioReferences(params.reference_audios)
        : undefined;
      if (
        image !== undefined &&
        (references !== undefined || referenceAudios !== undefined)
      ) {
        throw new XaiImagineBrokerError(
          "invalid_request",
          "image cannot be combined with reference_images or reference_audios",
        );
      }
      const requiredInputs: ("text" | "image" | "audio")[] = ["text"];
      if (image !== undefined || references !== undefined) {
        requiredInputs.push("image");
      }
      if (referenceAudios !== undefined) requiredInputs.push("audio");
      const duration = optionalInteger(params, "duration", 1, 15);
      const aspectRatio = optionalEnum(params, "aspect_ratio", VIDEO_ASPECT_RATIOS);
      const resolution = optionalEnum(params, "resolution", VIDEO_RESOLUTIONS);
      if (
        (references !== undefined || referenceAudios !== undefined) &&
        resolution === "1080p"
      ) {
        throw new XaiImagineBrokerError(
          "invalid_request",
          "reference-to-video does not support 1080p",
        );
      }
      model = await this.#resolveModel(
        "video",
        requestedModel,
        requiredInputs,
        prompt,
        ["grok-imagine-video-1.5", "grok-imagine-video"],
      );
      if (referenceAudios !== undefined) {
        for (const audio of referenceAudios) {
          await this.#requireVoice(audio.voice_id);
        }
      }
      body = { model, prompt };
      Object.assign(body, {
        ...(duration !== undefined ? { duration } : {}),
        ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(image !== undefined ? { image } : {}),
        ...(references !== undefined ? { reference_images: references } : {}),
        ...(referenceAudios !== undefined
          ? { reference_audios: referenceAudios }
          : {}),
      });
      path = "/videos/generations";
    } else {
      if (
        own(params, "image") ||
        own(params, "reference_images") ||
        own(params, "reference_audios")
      ) {
        throw new XaiImagineBrokerError(
          "invalid_request",
          "image references are only valid for generate operations",
        );
      }
      const video = await this.#materializeMediaReference(
        parseMediaReference(params.video, "video"),
        "video",
      );
      model = await this.#resolveModel(
        "video",
        requestedModel,
        ["text", "video"],
        prompt,
        ["grok-imagine-video", "grok-imagine-video-1.5"],
      );
      body = { model, prompt };
      body.video = video;
      if (operation === "edit") {
        for (const key of ["duration", "aspect_ratio", "resolution"]) {
          if (own(params, key)) {
            throw new XaiImagineBrokerError(
              "invalid_request",
              `${key} is not supported for video editing`,
            );
          }
        }
        path = "/videos/edits";
      } else {
        const duration = optionalInteger(params, "duration", 2, 10);
        if (duration !== undefined) body.duration = duration;
        if (own(params, "aspect_ratio") || own(params, "resolution")) {
          throw new XaiImagineBrokerError(
            "invalid_request",
            "aspect_ratio and resolution are not supported for video extension",
          );
        }
        path = "/videos/extensions";
      }
    }
    body.storage_options = privateStorageOptions(idempotencyKey, "mp4");
    const prior = await this.#beginPaidOperation("videos.submit", idempotencyKey);
    if (prior !== undefined) return prior;
    const { payload } = await this.#post(path, body, idempotencyKey);
    const requestId = payload.request_id;
    if (
      typeof requestId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(requestId)
    ) {
      throw new XaiImagineBrokerError(
        "submission_unknown",
        "xAI accepted the video submission but returned no request_id",
        {
          retryable: false,
          details: { idempotency_key: idempotencyKey },
        },
      );
    }
    const result = {
      operation,
      idempotency_key: idempotencyKey,
      request_id: requestId,
      status: "submitted",
      submitted_at: new Date(this.#now()).toISOString(),
    };
    await this.#writeOperationReceipt(
      "videos.submit",
      idempotencyKey,
      "submitted",
      { result },
    );
    return result;
  }

  async #videosPoll(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, ["request_id", "destination"], "params");
    const requestId = requiredString(params, "request_id", {
      max: 256,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
    });
    const destination = await this.#destinationPath(
      requiredString(params, "destination", { max: 16_384 }),
    );
    const priorReceipt = await this.#loadOperationReceipt("videos.poll", requestId);
    if (priorReceipt?.state === "completed" && priorReceipt.result !== undefined) {
      return { ...priorReceipt.result, recovered_from_operation_receipt: true };
    }
    const priorRecovery = asRecord(priorReceipt?.recovery);
    if (
      priorReceipt?.state === "recovery_required" &&
      typeof priorRecovery?.recovery_handle === "string"
    ) {
      const artifact = await this.#consumeRecoveryRecord(
        priorRecovery.recovery_handle,
      );
      const safePollResult = asRecord(priorRecovery.poll_result) ?? {
        request_id: requestId,
        status: "done",
        terminal: true,
        caller_action: "artifact_ready",
      };
      const resumed = { ...safePollResult, artifact };
      await this.#writeOperationReceipt(
        "videos.poll",
        requestId,
        "completed",
        { result: resumed },
      );
      return { ...resumed, recovered_from_operation_receipt: true };
    }
    const response = await this.#safeRead(`/videos/${encodeURIComponent(requestId)}`);
    const payload = await readJsonResponse(response);
    if (!response.ok) throw definiteHttpError(response, payload);
    const normalized = normalizeVideoPayload(requestId, payload);
    const status = normalized.status;
    if (
      typeof status !== "string" ||
      !new Set(["queued", "pending", "processing", "done", "failed", "expired"])
        .has(status)
    ) {
      throw new XaiImagineBrokerError(
        "upstream_unavailable",
        "xAI returned an unrecognized video request status",
        { retryable: true, details: { request_id: requestId } },
      );
    }
    const publicResult = publicVideoPayload(normalized);
    if (status !== "done") {
      return {
        ...publicResult,
        terminal: status === "failed" || status === "expired",
        caller_action:
          status === "failed"
            ? asRecord(normalized.provider_error)?.retryable === true
              ? "poll_or_escalate_without_resubmitting"
              : "terminal_failure"
            : status === "expired"
              ? "terminal_expired"
              : "poll",
      };
    }
    const video = asRecord(normalized.video);
    if (video?.respect_moderation === false) {
      return { ...publicResult, terminal: true, caller_action: "terminal_filtered" };
    }
    const fileId = asRecord(video?.file_output)?.file_id;
    const source = typeof fileId === "string"
      ? { file_id: fileId }
      : typeof video?.url === "string"
        ? { url: video.url }
        : undefined;
    if (source === undefined) {
      throw new XaiImagineBrokerError(
        "download_failed",
        "xAI marked the video done without a recoverable artifact source",
        { details: { request_id: requestId, destination } },
      );
    }
    if (priorReceipt === undefined) {
      await this.#writeOperationReceipt(
        "videos.poll",
        requestId,
        "submission_unknown",
        {},
        true,
      );
    }
    const recoveryHandle = await this.#createRecoveryRecord(
      source,
      destination,
      DEFAULT_DOWNLOAD_LIMIT_BYTES,
      "video",
    );
    await this.#writeOperationReceipt(
      "videos.poll",
      requestId,
      "recovery_required",
      {
        recovery: {
          recovery_handle: recoveryHandle,
          destination,
          poll_result: {
            ...publicResult,
            terminal: true,
            caller_action: "artifact_ready",
          },
        },
      },
    );
    try {
      const result = {
        ...publicResult,
        terminal: true,
        caller_action: "artifact_ready",
        artifact: await this.#consumeRecoveryRecord(recoveryHandle),
      };
      await this.#writeOperationReceipt(
        "videos.poll",
        requestId,
        "completed",
        { result },
      );
      return result;
    } catch (error) {
      const brokerError = error instanceof XaiImagineBrokerError
        ? error
        : new XaiImagineBrokerError("download_failed", "Video acquisition failed");
      throw new XaiImagineBrokerError(
        "download_failed",
        "Video generation completed, but artifact acquisition must resume through the opaque recovery handle",
        {
          retryable: brokerError.retryable,
          details: {
            request_id: requestId,
            cause_code: brokerError.code,
            recovery_handle: recoveryHandle,
            destination,
          },
        },
      );
    }
  }

  async #ttsVoices(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, [], "params");
    const voices = await this.#listVoices();
    return {
      voices,
      observed_at: new Date(this.#now()).toISOString(),
      evidence: "oauth_endpoint_response",
    };
  }

  async #requireVoice(voiceId: string): Promise<void> {
    const response = await this.#safeRead(
      `/tts/voices/${encodeURIComponent(voiceId)}`,
    );
    const payload = await readJsonResponse(response);
    if (!response.ok) throw definiteHttpError(response, payload);
    if (payload.voice_id !== voiceId) {
      throw new XaiImagineBrokerError(
        "upstream_unavailable",
        "xAI returned a mismatched TTS voice record",
        { retryable: true },
      );
    }
  }

  async #postTts(
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<Response> {
    let bearer = await this.#freshBearer();
    const send = (token: string) =>
      this.#fetch(`${XAI_IMAGINE_API_BASE_URL}/tts`, {
        method: "POST",
        headers: {
          accept: "audio/*, application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: fetchTimeout(TTS_TIMEOUT_MS),
      });
    let response: Response;
    try {
      response = await send(bearer);
    } catch {
      throw new XaiImagineBrokerError(
        "submission_unknown",
        "No response was received for the TTS submission; do not resubmit with a new idempotency key",
        { details: { idempotency_key: idempotencyKey } },
      );
    }
    if (response.status === 401 || response.status === 403) {
      await discardResponseBody(response);
      const refreshed = await this.#oauth.forceRefresh();
      if (!refreshed?.accessToken) {
        throw new XaiImagineBrokerError(
          "auth_refresh_failed",
          "xAI rejected the OAuth bearer and refresh did not produce a replacement",
          { retryable: true, details: { http_status: response.status } },
        );
      }
      bearer = refreshed.accessToken;
      try {
        response = await send(bearer);
      } catch {
        throw new XaiImagineBrokerError(
          "submission_unknown",
          "The TTS submission failed after OAuth refresh replay with the same idempotency key; acceptance is unknown",
          { details: { idempotency_key: idempotencyKey } },
        );
      }
    }
    if (response.status >= 500) {
      await discardResponseBody(response);
      throw new XaiImagineBrokerError(
        "submission_unknown",
        "xAI returned a server error for the TTS submission; acceptance is unknown",
        {
          details: {
            idempotency_key: idempotencyKey,
            http_status: response.status,
          },
        },
      );
    }
    if (!response.ok) {
      const payload = await readJsonResponse(response);
      throw definiteHttpError(response, payload);
    }
    return response;
  }

  async #ttsGenerate(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(
      params,
      [
        "idempotency_key",
        "text",
        "voice_id",
        "language",
        "output_format",
        "speed",
        "optimize_streaming_latency",
        "text_normalization",
        "with_timestamps",
        "destination",
      ],
      "params",
    );
    const idempotencyKey = requiredIdempotencyKey(params);
    const text = requiredString(params, "text", { max: MAX_TTS_TEXT_LENGTH });
    const voiceId = requiredString(params, "voice_id", {
      max: 128,
      pattern: /^[a-z0-9][a-z0-9_-]*$/u,
    });
    const language = requiredLanguage(params);
    const outputFormat = parseTtsOutputFormat(params.output_format);
    const outputCodec = String(asRecord(outputFormat)?.codec ?? "mp3");
    const speed = optionalNumber(params, "speed", 0.7, 1.5);
    const optimizeStreamingLatency = optionalInteger(
      params,
      "optimize_streaming_latency",
      0,
      2,
    );
    const textNormalization = optionalBoolean(params, "text_normalization");
    const withTimestamps = optionalBoolean(params, "with_timestamps") ?? false;
    if (
      withTimestamps &&
      (text.length > MAX_TTS_TIMESTAMP_TEXT_LENGTH ||
        (asRecord(outputFormat)?.codec ?? "mp3") !== "mp3")
    ) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        `with_timestamps requires mp3 output and at most ${MAX_TTS_TIMESTAMP_TEXT_LENGTH} text characters so paid audio can be checkpointed safely`,
      );
    }
    const destination = await this.#destinationPath(
      requiredString(params, "destination", { max: 16_384 }),
    );
    await this.#requireVoice(voiceId);
    const prior = await this.#beginPaidOperation("tts.generate", idempotencyKey);
    if (prior !== undefined) return prior;
    const response = await this.#postTts(
      {
        text,
        voice_id: voiceId,
        language,
        ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
        ...(speed !== undefined ? { speed } : {}),
        ...(optimizeStreamingLatency !== undefined
          ? { optimize_streaming_latency: optimizeStreamingLatency }
          : {}),
        ...(textNormalization !== undefined
          ? { text_normalization: textNormalization }
          : {}),
        ...(withTimestamps ? { with_timestamps: true } : {}),
      },
      idempotencyKey,
    );

    let audioResponse = response;
    let timingResult: Record<string, unknown> = {};
    if (withTimestamps) {
      let payload: Record<string, unknown>;
      try {
        payload = await readJsonResponse(response);
      } catch {
        throw new XaiImagineBrokerError(
          "submission_unknown",
          "xAI completed TTS but returned an unusable timestamp envelope",
          { details: { idempotency_key: idempotencyKey } },
        );
      }
      if (typeof payload.audio !== "string" || payload.audio.length === 0) {
        throw new XaiImagineBrokerError(
          "submission_unknown",
          "xAI completed TTS but returned no timestamped audio payload",
          { details: { idempotency_key: idempotencyKey } },
        );
      }
      const normalizedBase64 = payload.audio.replace(/\s+/gu, "");
      if (
        normalizedBase64.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
          normalizedBase64,
        )
      ) {
        throw new XaiImagineBrokerError(
          "submission_unknown",
          "xAI completed TTS but returned invalid base64 audio",
          { details: { idempotency_key: idempotencyKey } },
        );
      }
      const audio = Buffer.from(normalizedBase64, "base64");
      if (audio.length > MAX_TTS_TIMESTAMP_AUDIO_BYTES) {
        throw new XaiImagineBrokerError(
          "artifact_too_large",
          "The timestamped TTS audio exceeds the in-memory envelope limit",
          { details: { max_bytes: MAX_TTS_TIMESTAMP_AUDIO_BYTES } },
        );
      }
      const contentType = safeMimeType(
        typeof payload.content_type === "string" ? payload.content_type : null,
      );
      audioResponse = new Response(audio, {
        status: 200,
        headers: {
          "content-length": String(audio.length),
          "content-type": contentType,
        },
      });
      const duration =
        typeof payload.duration === "number" &&
        Number.isFinite(payload.duration) &&
        payload.duration >= 0
          ? payload.duration
          : undefined;
      try {
        timingResult.audio_timestamps = normalizeAudioTimestamps(
          payload.audio_timestamps,
          duration,
        );
        timingResult.alignment = { valid: true };
      } catch {
        // The paid audio is independently useful. Commit it first and expose a
        // typed alignment defect instead of discarding a valid synthesis.
        timingResult.alignment = {
          valid: false,
          error: {
            code: "invalid_timestamps",
            message: "xAI returned malformed or non-monotonic character timestamps",
          },
        };
      }
      if (duration !== undefined) timingResult.duration_seconds = duration;
    } else {
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (
        !contentType.startsWith("audio/") &&
        contentType !== "application/octet-stream"
      ) {
        await discardResponseBody(response);
        throw new XaiImagineBrokerError(
          "submission_unknown",
          "xAI completed TTS but returned an unexpected content type",
          {
            details: {
              idempotency_key: idempotencyKey,
              content_type: contentType,
            },
          },
        );
      }
    }

    try {
      const artifact = await this.#writeBodyAtomic(
        audioResponse,
        destination,
        MAX_TTS_AUDIO_BYTES,
        undefined,
        undefined,
        undefined,
        outputCodec === "mp3"
          ? "audio-mp3"
          : outputCodec === "wav"
            ? "audio-wav"
            : "audio-raw",
      );
      const result = {
        idempotency_key: idempotencyKey,
        voice_id: voiceId,
        language,
        artifact,
        ...timingResult,
      };
      await this.#writeOperationReceipt(
        "tts.generate",
        idempotencyKey,
        "completed",
        { result },
      );
      return result;
    } catch (error) {
      const code = error instanceof XaiImagineBrokerError
        ? error.code
        : "download_failed";
      throw new XaiImagineBrokerError(
        "submission_unknown",
        "TTS completed but its audio artifact could not be committed; do not resubmit with a new idempotency key",
        {
          details: {
            idempotency_key: idempotencyKey,
            destination,
            cause_code: code,
          },
        },
      );
    }
  }

  async #writePrivateJson(
    path: string,
    value: Record<string, unknown>,
    replaceExisting: boolean,
  ): Promise<void> {
    await this.#assertRecoveryParentStillBound(path);
    const serialized = Buffer.from(JSON.stringify(value), "utf8");
    if (serialized.length > MAX_RECOVERY_RECORD_BYTES) {
      throw new XaiImagineBrokerError(
        "download_failed",
        "The broker recovery record exceeded its safety limit",
      );
    }
    const temporary = join(
      dirname(path),
      `.${basename(path)}.${randomUUID()}.partial`,
    );
    let committed = false;
    try {
      const handle = await open(
        temporary,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      try {
        let offset = 0;
        while (offset < serialized.length) {
          const written = await handle.write(
            serialized,
            offset,
            serialized.length - offset,
          );
          if (written.bytesWritten <= 0) {
            throw new XaiImagineBrokerError(
              "download_failed",
              "The broker recovery write made no forward progress",
            );
          }
          offset += written.bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (replaceExisting) {
        await this.#assertRecoveryParentStillBound(path);
        await rename(temporary, path);
      } else {
        await this.#assertRecoveryParentStillBound(path);
        await link(temporary, path);
      }
      committed = true;
      await this.#syncDirectory(dirname(path));
    } catch (error) {
      if (error instanceof XaiImagineBrokerError) throw error;
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new XaiImagineBrokerError(
          "destination_exists",
          "The private recovery record already exists",
        );
      }
      throw new XaiImagineBrokerError(
        "download_failed",
        committed
          ? "Private artifact recovery state was written, but its durability is uncertain"
          : "The broker could not persist private artifact recovery state",
        {
          retryable: true,
          details: { checkpoint_state: committed ? "uncertain" : "not_committed" },
        },
      );
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    if (process.platform === "win32") return;
    let directory: Awaited<ReturnType<typeof open>> | undefined;
    try {
      directory = await open(path, fsConstants.O_RDONLY);
      await directory.sync();
    } catch {
      throw new XaiImagineBrokerError(
        "download_failed",
        "The broker could not durably sync an artifact directory",
        { retryable: true },
      );
    } finally {
      await directory?.close().catch(() => {});
    }
  }

  async #recoveryRecordPath(handle: string): Promise<string> {
    try {
      await mkdir(this.#recoveryRoot, { recursive: true, mode: 0o700 });
      await chmod(this.#recoveryRoot, 0o700);
    } catch {
      throw new XaiImagineBrokerError(
        "download_failed",
        "The broker could not prepare private recovery storage",
        { retryable: true },
      );
    }
    const [resolvedRoot, stat] = await Promise.all([
      realpath(this.#recoveryRoot).catch(() => undefined),
      lstat(this.#recoveryRoot).catch(() => undefined),
    ]);
    if (
      resolvedRoot !== this.#recoveryRoot ||
      stat === undefined ||
      stat.isSymbolicLink() ||
      !stat.isDirectory()
    ) {
      throw new XaiImagineBrokerError(
        "download_failed",
        "The broker private recovery directory is not safely bound",
      );
    }
    return join(this.#recoveryRoot, `${handle}.json`);
  }

  async #assertRecoveryParentStillBound(path: string): Promise<void> {
    if (dirname(path) !== this.#recoveryRoot) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "Private recovery state escaped its broker-owned directory",
      );
    }
    const [resolvedRoot, stat] = await Promise.all([
      realpath(this.#recoveryRoot).catch(() => undefined),
      lstat(this.#recoveryRoot).catch(() => undefined),
    ]);
    if (
      resolvedRoot !== this.#recoveryRoot ||
      stat === undefined ||
      stat.isSymbolicLink() ||
      !stat.isDirectory()
    ) {
      throw new XaiImagineBrokerError(
        "download_failed",
        "The broker private recovery directory changed unexpectedly",
      );
    }
  }

  #operationRecordIdentity(
    operation: DurableOperationName,
    key: string,
  ): { readonly hash: string; readonly filename: string } {
    const hash = createHash("sha256")
      .update(operation, "utf8")
      .update("\0", "utf8")
      .update(key, "utf8")
      .digest("hex");
    return { hash, filename: `operation_${hash}.json` };
  }

  async #readPrivateRecord(
    path: string,
  ): Promise<Record<string, unknown> | undefined> {
    const file = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (file === undefined) return undefined;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECOVERY_RECORD_BYTES) {
        throw new XaiImagineBrokerError(
          "invalid_request",
          "The broker private operation receipt is invalid",
        );
      }
      const buffer = Buffer.allocUnsafe(16 * 1024);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for (;;) {
        const read = await file.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
        if (bytes > MAX_RECOVERY_RECORD_BYTES) {
          throw new XaiImagineBrokerError(
            "invalid_request",
            "The broker private operation receipt exceeds its safety limit",
          );
        }
        chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
      }
      const parsed = asRecord(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
      if (parsed === null) throw new Error("not an object");
      return parsed;
    } catch (error) {
      if (error instanceof XaiImagineBrokerError) throw error;
      throw new XaiImagineBrokerError(
        "invalid_request",
        "The broker private operation receipt could not be decoded",
      );
    } finally {
      await file.close();
    }
  }

  async #operationReceiptPath(
    operation: DurableOperationName,
    key: string,
  ): Promise<{ readonly path: string; readonly hash: string }> {
    const identity = this.#operationRecordIdentity(operation, key);
    const recoveryProbe = `recovery_${randomUUID()}`;
    const probePath = await this.#recoveryRecordPath(recoveryProbe);
    return {
      path: join(dirname(probePath), identity.filename),
      hash: identity.hash,
    };
  }

  async #loadOperationReceipt(
    operation: DurableOperationName,
    key: string,
  ): Promise<DurableOperationReceipt | undefined> {
    const { path, hash } = await this.#operationReceiptPath(operation, key);
    const record = await this.#readPrivateRecord(path);
    if (record === undefined) return undefined;
    const state = record.state;
    if (
      record.version !== 1 ||
      record.operation !== operation ||
      record.key_hash !== hash ||
      !new Set(["submission_unknown", "submitted", "recovery_required", "completed"])
        .has(String(state))
    ) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "The broker private operation receipt failed validation",
      );
    }
    return {
      version: 1,
      operation,
      key_hash: hash,
      state: state as DurableOperationReceipt["state"],
      created_at: requiredString(record, "created_at", { max: 128 }),
      updated_at: requiredString(record, "updated_at", { max: 128 }),
      ...(asRecord(record.result) !== null ? { result: asRecord(record.result)! } : {}),
      ...(asRecord(record.recovery) !== null
        ? { recovery: asRecord(record.recovery)! }
        : {}),
    };
  }

  async #writeOperationReceipt(
    operation: DurableOperationName,
    key: string,
    state: DurableOperationReceipt["state"],
    values: {
      readonly result?: Record<string, unknown>;
      readonly recovery?: Record<string, unknown>;
    } = {},
    createOnly = false,
  ): Promise<DurableOperationReceipt> {
    const { path, hash } = await this.#operationReceiptPath(operation, key);
    const prior = createOnly ? undefined : await this.#loadOperationReceipt(operation, key);
    const now = new Date(this.#now()).toISOString();
    const receipt: DurableOperationReceipt = {
      version: 1,
      operation,
      key_hash: hash,
      state,
      created_at: prior?.created_at ?? now,
      updated_at: now,
      ...(values.result !== undefined ? { result: values.result } : {}),
      ...(values.recovery !== undefined ? { recovery: values.recovery } : {}),
    };
    await this.#writePrivateJson(path, receipt as unknown as Record<string, unknown>, !createOnly);
    return receipt;
  }

  async #beginPaidOperation(
    operation: Exclude<DurableOperationName, "videos.poll">,
    key: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      await this.#writeOperationReceipt(operation, key, "submission_unknown", {}, true);
      return undefined;
    } catch (error) {
      if (!(error instanceof XaiImagineBrokerError) || error.code !== "destination_exists") {
        throw error;
      }
      const prior = await this.#loadOperationReceipt(operation, key);
      if (prior?.state === "completed" && prior.result !== undefined) {
        return { ...prior.result, recovered_from_operation_receipt: true };
      }
      throw new XaiImagineBrokerError(
        "submission_unknown",
        "This operation key already has a durable broker receipt; inspect it instead of resubmitting",
        {
          details: {
            operation,
            operation_key: key,
            state: prior?.state ?? "unknown",
            caller_action: "operations.status",
          },
        },
      );
    }
  }

  async #operationStatus(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, ["operation", "key"], "params");
    const operation = requiredString(params, "operation", { max: 64 }) as DurableOperationName;
    if (!new Set<DurableOperationName>([
      "images.generate",
      "images.edit",
      "videos.submit",
      "videos.poll",
      "tts.generate",
    ]).has(operation)) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "operation is not a durable broker operation",
      );
    }
    const key = requiredString(params, "key", { max: 512 });
    const receipt = await this.#loadOperationReceipt(operation, key);
    if (receipt === undefined) {
      return {
        operation,
        key,
        state: "not_found",
        caller_action: "do_not_infer_provider_submission",
      };
    }
    return {
      operation,
      key,
      state: receipt.state,
      created_at: receipt.created_at,
      updated_at: receipt.updated_at,
      caller_action:
        receipt.state === "completed"
          ? "use_result"
          : receipt.state === "recovery_required"
            ? "resume_artifacts"
            : receipt.state === "submitted"
              ? "poll"
              : "manual_reconciliation_no_resubmit",
      ...(receipt.result !== undefined ? { result: receipt.result } : {}),
      ...(receipt.recovery !== undefined ? { recovery: receipt.recovery } : {}),
    };
  }

  async #createRecoveryRecord(
    source: { readonly url: string } | { readonly file_id: string },
    destination: string,
    maxBytes: number,
    mediaKind: "image" | "video",
  ): Promise<string> {
    if ("url" in source) assertArtifactUrl(source.url);
    const canonicalDestination = await this.#destinationPath(destination);
    const handle = `recovery_${randomUUID()}`;
    const path = await this.#recoveryRecordPath(handle);
    try {
      await this.#writePrivateJson(
        path,
        {
          version: 1,
          media_kind: mediaKind,
          ...( "url" in source
            ? { source_url: source.url }
            : { file_id: source.file_id }),
          destination: canonicalDestination,
          max_bytes: maxBytes,
          created_at: new Date(this.#now()).toISOString(),
        },
        false,
      );
      return handle;
    } catch (error) {
      if (error instanceof XaiImagineBrokerError) {
        throw new XaiImagineBrokerError(error.code, error.message, {
          retryable: error.retryable,
          details: {
            ...(error.details ?? {}),
            ...(error.details?.checkpoint_state === "uncertain"
              ? { recovery_handle: handle }
              : {}),
          },
        });
      }
      throw error;
    }
  }

  async #loadRecoveryRecord(handle: string): Promise<LoadedArtifactRecovery> {
    if (!/^recovery_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(handle)) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "recovery_handle has an invalid format",
      );
    }
    const path = await this.#recoveryRecordPath(handle);
    const file = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    ).catch(() => undefined);
    if (file === undefined) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "recovery_handle could not be opened safely",
      );
    }
    let text: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECOVERY_RECORD_BYTES) {
        throw new XaiImagineBrokerError(
          "invalid_request",
          "recovery_handle does not identify a valid broker recovery record",
        );
      }
      const chunks: Buffer[] = [];
      const buffer = Buffer.allocUnsafe(Math.min(16 * 1024, MAX_RECOVERY_RECORD_BYTES));
      let bytes = 0;
      for (;;) {
        const read = await file.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
        if (bytes > MAX_RECOVERY_RECORD_BYTES) {
          throw new XaiImagineBrokerError(
            "invalid_request",
            "recovery_handle private state exceeds its safety limit",
          );
        }
        chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
      }
      text = Buffer.concat(chunks, bytes).toString("utf8");
    } finally {
      await file.close();
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "recovery_handle contains invalid private state",
      );
    }
    const record = asRecord(value);
    if (record === null) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "recovery_handle contains invalid private state",
      );
    }
    assertAllowedKeys(
      record,
      [
        "version",
        "media_kind",
        "source_url",
        "file_id",
        "destination",
        "max_bytes",
        "created_at",
        "expected_sha256",
        "bytes",
        "mime_type",
        "downloaded_at",
      ],
      "recovery record",
    );
    if (record.version !== 1) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "recovery_handle uses an unsupported private-state version",
      );
    }
    if (record.media_kind !== "image" && record.media_kind !== "video") {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "recovery_handle is missing its expected media kind",
      );
    }
    const hasSourceUrl = own(record, "source_url");
    const hasFileId = own(record, "file_id");
    if (hasSourceUrl === hasFileId) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "recovery_handle must contain exactly one private artifact source",
      );
    }
    const sourceUrl = hasSourceUrl
      ? requiredString(record, "source_url", { max: 32_768 })
      : undefined;
    if (sourceUrl !== undefined) assertArtifactUrl(sourceUrl);
    const fileId = hasFileId
      ? requiredString(record, "file_id", {
          max: 256,
          pattern: /^file_[A-Za-z0-9._:-]+$/u,
        })
      : undefined;
    const destination = await this.#destinationPath(
      requiredString(record, "destination", { max: 16_384 }),
      "allow",
    );
    const maxBytes = optionalInteger(
      record,
      "max_bytes",
      1,
      MAX_DOWNLOAD_LIMIT_BYTES,
    );
    if (maxBytes === undefined) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "recovery_handle is missing its artifact size limit",
      );
    }
    const expectedSha = optionalString(record, "expected_sha256")?.toLowerCase();
    if (expectedSha !== undefined && !/^[a-f0-9]{64}$/u.test(expectedSha)) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "recovery_handle contains an invalid artifact digest",
      );
    }
    const bytes = optionalInteger(record, "bytes", 0, MAX_DOWNLOAD_LIMIT_BYTES);
    const mimeType = optionalString(record, "mime_type");
    const createdAt = requiredString(record, "created_at", { max: 128 });
    const downloadedAt = optionalString(record, "downloaded_at");
    return {
      handle,
      path,
      record: {
        version: 1,
        media_kind: record.media_kind,
        ...(sourceUrl !== undefined ? { source_url: sourceUrl } : {}),
        ...(fileId !== undefined ? { file_id: fileId } : {}),
        destination,
        max_bytes: maxBytes,
        created_at: createdAt,
        ...(expectedSha !== undefined ? { expected_sha256: expectedSha } : {}),
        ...(bytes !== undefined ? { bytes } : {}),
        ...(mimeType !== undefined ? { mime_type: safeMimeType(mimeType) } : {}),
        ...(downloadedAt !== undefined ? { downloaded_at: downloadedAt } : {}),
      },
    };
  }

  async #verifyRecoveredArtifact(
    loaded: LoadedArtifactRecovery,
  ): Promise<Record<string, unknown> | undefined> {
    const expectedSha = loaded.record.expected_sha256;
    if (expectedSha === undefined) return undefined;
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(
        loaded.record.destination,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new XaiImagineBrokerError(
        "download_failed",
        "The broker could not inspect a recovered artifact",
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        throw new XaiImagineBrokerError(
          "integrity_mismatch",
          "The recovered artifact destination is not a regular file",
        );
      }
      if (stat.size > loaded.record.max_bytes) {
        throw new XaiImagineBrokerError(
          "artifact_too_large",
          "The recovered artifact exceeds its recorded size limit",
        );
      }
      for (;;) {
        const read = await file.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
        if (bytes > loaded.record.max_bytes) {
          throw new XaiImagineBrokerError(
            "artifact_too_large",
            "The recovered artifact grew beyond its recorded size limit",
          );
        }
        hash.update(buffer.subarray(0, read.bytesRead));
      }
    } finally {
      await file.close();
    }
    const actualSha = hash.digest("hex");
    if (actualSha !== expectedSha) {
      throw new XaiImagineBrokerError(
        "integrity_mismatch",
        "The recovered artifact does not match its broker checkpoint",
        {
          details: {
            expected_sha256: expectedSha,
            actual_sha256: actualSha,
          },
        },
      );
    }
    return {
      destination: loaded.record.destination,
      bytes,
      sha256: actualSha,
      mime_type: loaded.record.mime_type ?? "application/octet-stream",
      downloaded_at:
        loaded.record.downloaded_at ?? new Date(this.#now()).toISOString(),
      recovered_after_interruption: true,
    };
  }

  async #consumeRecoveryRecord(handle: string): Promise<Record<string, unknown>> {
    const loaded = await this.#loadRecoveryRecord(handle);
    const recovered = await this.#verifyRecoveredArtifact(loaded);
    if (recovered !== undefined) {
      try {
        await unlink(loaded.path);
        await this.#syncDirectory(dirname(loaded.path));
      } catch {
        throw new XaiImagineBrokerError(
          "download_failed",
          "The artifact is verified, but recovery cleanup must be retried",
          { retryable: true, details: { recovery_handle: handle } },
        );
      }
      return recovered;
    }
    try {
      await lstat(loaded.record.destination);
      throw new XaiImagineBrokerError(
        "destination_exists",
        "The recovery destination exists without a matching broker checkpoint",
        { details: { recovery_handle: handle } },
      );
    } catch (error) {
      if (error instanceof XaiImagineBrokerError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new XaiImagineBrokerError(
          "download_failed",
          "The broker could not inspect the recovery destination",
          { details: { recovery_handle: handle } },
        );
      }
    }
    const response = loaded.record.source_url !== undefined
      ? await this.#fetchArtifact(loaded.record.source_url)
      : await this.#safeRead(
          `/files/${encodeURIComponent(loaded.record.file_id!)}/content`,
          {
            accept: "image/*, video/*, audio/*, application/octet-stream",
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
          },
        );
    if (!response.ok) {
      await discardResponseBody(response);
      throw new XaiImagineBrokerError(
        "download_failed",
        `The xAI artifact recovery failed (HTTP ${response.status})`,
        {
          retryable: response.status >= 500,
          details: { recovery_handle: handle, http_status: response.status },
        },
      );
    }
    const artifact = await this.#writeBodyAtomic(
      response,
      loaded.record.destination,
      loaded.record.max_bytes,
      loaded.record.expected_sha256,
      async (checkpoint) => {
        await this.#writePrivateJson(
          loaded.path,
          {
            ...loaded.record,
            expected_sha256: checkpoint.sha256,
            bytes: checkpoint.bytes,
            mime_type: checkpoint.mime_type,
            downloaded_at: checkpoint.downloaded_at,
          },
          true,
        );
      },
      handle,
      loaded.record.media_kind,
    );
    try {
      await unlink(loaded.path);
      await this.#syncDirectory(dirname(loaded.path));
    } catch {
      throw new XaiImagineBrokerError(
        "download_failed",
        "The artifact was committed, but recovery cleanup must be retried",
        { retryable: true, details: { recovery_handle: handle } },
      );
    }
    return artifact;
  }

  async #destinationPath(
    value: string,
    existing: "forbid" | "allow" | "require" = "forbid",
    createParents = true,
  ): Promise<string> {
    if (!isAbsolute(value)) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "destination must be an absolute path",
      );
    }
    const destination = resolve(value);
    if (!isWithinRoot(this.#artifactRoot, destination) || destination === this.#artifactRoot) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "destination must be a file beneath the broker artifact root",
        { details: { artifact_root: this.#artifactRoot } },
      );
    }
    let realRoot: string;
    try {
      realRoot = await realpath(this.#artifactRoot);
    } catch {
      throw new XaiImagineBrokerError(
        "download_failed",
        "The broker artifact root does not exist or cannot be resolved",
      );
    }
    const parentRelative = relative(this.#artifactRoot, dirname(destination));
    let realParent = realRoot;
    for (const component of parentRelative.split(sep).filter(Boolean)) {
      realParent = join(realParent, component);
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        stat = await lstat(realParent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new XaiImagineBrokerError(
            "download_failed",
            "The broker could not inspect the artifact parent directory",
          );
        }
        if (!createParents) {
          throw new XaiImagineBrokerError(
            "invalid_request",
            "local media reference parent does not exist",
          );
        }
        try {
          await mkdir(realParent, { mode: 0o700 });
          stat = await lstat(realParent);
        } catch {
          throw new XaiImagineBrokerError(
            "download_failed",
            "The broker could not create the artifact parent directory",
          );
        }
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new XaiImagineBrokerError(
          "invalid_request",
          "artifact destination parents must be real directories beneath the broker root",
        );
      }
    }
    try {
      realParent = await realpath(realParent);
    } catch {
      throw new XaiImagineBrokerError(
        "download_failed",
        "The broker could not resolve the artifact destination parent",
      );
    }
    if (!isWithinRoot(realRoot, realParent)) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "destination resolves outside the broker artifact root",
        { details: { artifact_root: this.#artifactRoot } },
      );
    }
    const canonicalDestination = join(realParent, basename(destination));
    let destinationExists = false;
    try {
      await lstat(canonicalDestination);
      destinationExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new XaiImagineBrokerError(
          "download_failed",
          "The broker could not inspect the artifact destination",
        );
      }
    }
    if (existing === "forbid" && destinationExists) {
      throw new XaiImagineBrokerError(
        "destination_exists",
        "destination already exists; artifact writes never overwrite files",
      );
    }
    if (existing === "require" && !destinationExists) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "the required broker-local path does not exist",
      );
    }
    return canonicalDestination;
  }

  async #assertArtifactParentStillBound(destination: string): Promise<void> {
    const parent = dirname(destination);
    let resolvedParent: string;
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      [resolvedParent, stat] = await Promise.all([
        realpath(parent),
        lstat(parent),
      ]);
    } catch {
      throw new XaiImagineBrokerError(
        "download_failed",
        "The artifact destination parent changed or disappeared",
      );
    }
    if (
      resolvedParent !== parent ||
      stat.isSymbolicLink() ||
      !stat.isDirectory()
    ) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "The artifact destination parent is no longer safely bound beneath the broker root",
      );
    }
    const realRoot = await realpath(this.#artifactRoot).catch(() => undefined);
    if (realRoot === undefined || !isWithinRoot(realRoot, resolvedParent)) {
      throw new XaiImagineBrokerError(
        "invalid_request",
        "The artifact destination parent escaped the broker root",
      );
    }
  }

  async #writeBodyAtomic(
    response: Response,
    destination: string,
    maxBytes: number,
    expectedSha?: string,
    beforeCommit?: (
      checkpoint: {
        readonly destination: string;
        readonly bytes: number;
        readonly sha256: string;
        readonly mime_type: string;
        readonly downloaded_at: string;
      },
    ) => Promise<void>,
    recoveryHandle?: string,
    expectedMedia?: ExpectedArtifactMedia,
  ): Promise<Record<string, unknown>> {
    await this.#assertArtifactParentStillBound(destination);
    if (response.body === null) {
      throw new XaiImagineBrokerError(
        "download_failed",
        "The artifact response did not contain a body",
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await discardResponseBody(response);
      throw new XaiImagineBrokerError(
        "artifact_too_large",
        "The artifact exceeds max_bytes",
        { details: { declared_bytes: declared, max_bytes: maxBytes } },
      );
    }
    const temporary = join(
      dirname(destination),
      `.${basename(destination)}.${recoveryHandle ?? randomUUID()}.partial`,
    );
    if (recoveryHandle !== undefined) {
      // A resume deterministically discovers the prior attempt's partial, so
      // repeated crashes cannot accumulate unbounded broker-owned files.
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    try {
      const handle = await open(
        temporary,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      const hash = createHash("sha256");
      let bytes = 0;
      const leadingChunks: Buffer[] = [];
      let leadingBytes = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          const chunk = Buffer.from(next.value);
          bytes += chunk.length;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new XaiImagineBrokerError(
              "artifact_too_large",
              "The artifact exceeded max_bytes while downloading",
              { details: { max_bytes: maxBytes } },
            );
          }
          hash.update(chunk);
          if (leadingBytes < 64) {
            const prefix = chunk.subarray(0, Math.min(chunk.length, 64 - leadingBytes));
            leadingChunks.push(Buffer.from(prefix));
            leadingBytes += prefix.length;
          }
          let offset = 0;
          while (offset < chunk.length) {
            const written = await handle.write(
              chunk,
              offset,
              chunk.length - offset,
            );
            if (written.bytesWritten <= 0) {
              throw new XaiImagineBrokerError(
                "download_failed",
                "The artifact write made no forward progress",
                { retryable: true },
              );
            }
            offset += written.bytesWritten;
          }
        }
        await handle.sync();
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
      if (bytes === 0) {
        throw new XaiImagineBrokerError(
          "integrity_mismatch",
          "The downloaded artifact was empty",
        );
      }
      const sha256 = hash.digest("hex");
      if (expectedSha !== undefined && sha256 !== expectedSha) {
        throw new XaiImagineBrokerError(
          "integrity_mismatch",
          "The downloaded artifact did not match expected_sha256",
          { details: { expected_sha256: expectedSha, actual_sha256: sha256 } },
        );
      }
      const detectedMime = expectedMedia === undefined
        ? safeMimeType(response.headers.get("content-type"))
        : validateArtifactMedia(
            Buffer.concat(leadingChunks, leadingBytes),
            expectedMedia,
          );
      const declaredMime = safeMimeType(response.headers.get("content-type"));
      if (
        expectedMedia !== undefined &&
        declaredMime !== "application/octet-stream" &&
        ((expectedMedia === "image" && !declaredMime.startsWith("image/")) ||
          (expectedMedia === "video" && !declaredMime.startsWith("video/")) ||
          (expectedMedia.startsWith("audio-") && !declaredMime.startsWith("audio/")))
      ) {
        throw new XaiImagineBrokerError(
          "integrity_mismatch",
          "The artifact Content-Type does not match its expected media kind",
        );
      }
      const checkpoint = {
        destination,
        bytes,
        sha256,
        mime_type: detectedMime,
        downloaded_at: new Date(this.#now()).toISOString(),
      };
      await beforeCommit?.(checkpoint);
      await this.#assertArtifactParentStillBound(destination);
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new XaiImagineBrokerError(
            "destination_exists",
            "destination already exists; artifact writes never overwrite files",
          );
        }
        throw new XaiImagineBrokerError(
          "download_failed",
          "The filesystem does not support an atomic no-overwrite artifact commit",
        );
      }
      await this.#syncDirectory(dirname(destination));
      await unlink(temporary).catch(() => {});
      return checkpoint;
    } catch (error) {
      if (error instanceof XaiImagineBrokerError) throw error;
      throw new XaiImagineBrokerError(
        "download_failed",
        "The artifact could not be written",
        { retryable: true },
      );
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async #artifactDownload(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, ["recovery_handle"], "params");
    const recoveryHandle = requiredString(params, "recovery_handle", {
      max: 64,
      pattern: /^recovery_[0-9a-f-]+$/u,
    });
    try {
      return {
        recovery_handle: recoveryHandle,
        recovered: true,
        artifact: await this.#consumeRecoveryRecord(recoveryHandle),
      };
    } catch (error) {
      if (error instanceof XaiImagineBrokerError) {
        throw new XaiImagineBrokerError(error.code, error.message, {
          retryable: error.retryable,
          details: {
            ...(error.details ?? {}),
            recovery_handle: recoveryHandle,
          },
        });
      }
      throw new XaiImagineBrokerError(
        "download_failed",
        "Artifact recovery failed",
        { retryable: true, details: { recovery_handle: recoveryHandle } },
      );
    }
  }

  async #fetchArtifact(sourceUrl: string): Promise<Response> {
    let current = sourceUrl;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      assertArtifactUrl(current);
      let response: Response;
      try {
        response = await this.#fetch(current, {
          method: "GET",
          headers: { accept: "image/*, video/*, application/octet-stream" },
          redirect: "manual",
          signal: fetchTimeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch {
        throw new XaiImagineBrokerError(
          "download_failed",
          "The xAI artifact download failed before a response was received",
          { retryable: true },
        );
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (redirect === MAX_REDIRECTS) {
        await discardResponseBody(response);
        throw new XaiImagineBrokerError(
          "download_failed",
          "The xAI artifact exceeded the redirect limit",
        );
      }
      const location = response.headers.get("location");
      if (!location) {
        await discardResponseBody(response);
        throw new XaiImagineBrokerError(
          "download_failed",
          "The xAI artifact returned a redirect without a location",
        );
      }
      await discardResponseBody(response);
      current = new URL(location, current).toString();
    }
    throw new XaiImagineBrokerError("download_failed", "Artifact redirect failure");
  }
}

function assertArtifactUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new XaiImagineBrokerError(
      "invalid_artifact_url",
      "artifact URL is invalid",
    );
  }
  if (parsed.protocol !== "https:" || !ARTIFACT_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new XaiImagineBrokerError(
      "invalid_artifact_url",
      "artifact URL must use HTTPS on an approved xAI artifact host",
      { details: { allowed_hosts: [...ARTIFACT_HOSTS] } },
    );
  }
}

export function parseXaiImagineBrokerRequest(value: unknown): XaiImagineBrokerRequest {
  const record = asRecord(value);
  if (record === null) {
    throw new XaiImagineBrokerError("invalid_request", "request must be an object");
  }
  assertAllowedKeys(record, ["protocol_version", "id", "method", "params"], "request");
  if (record.protocol_version !== XAI_IMAGINE_BROKER_PROTOCOL_VERSION) {
    throw new XaiImagineBrokerError(
      "unsupported_protocol",
      `protocol_version must be ${XAI_IMAGINE_BROKER_PROTOCOL_VERSION}`,
      {
        details: {
          requested_version:
            typeof record.protocol_version === "number"
              ? record.protocol_version
              : null,
          supported_versions: [XAI_IMAGINE_BROKER_PROTOCOL_VERSION],
        },
      },
    );
  }
  const id = requiredString(record, "id", { max: 128 });
  const method = requiredString(record, "method", { max: 128 });
  if (!(METHOD_NAMES as readonly string[]).includes(method)) {
    throw new XaiImagineBrokerError(
      "unknown_method",
      "unknown broker method",
      { details: { methods: [...METHOD_NAMES] } },
    );
  }
  const params = own(record, "params") ? paramsObject(record.params) : undefined;
  return {
    protocol_version: XAI_IMAGINE_BROKER_PROTOCOL_VERSION,
    id,
    method: method as XaiImagineBrokerMethod,
    ...(params !== undefined ? { params } : {}),
  };
}

function responseId(value: unknown): string | null {
  const record = asRecord(value);
  return record !== null && typeof record.id === "string"
    ? record.id.slice(0, 128)
    : null;
}

export async function handleXaiImagineBrokerValue(
  broker: XaiImagineBroker,
  value: unknown,
): Promise<XaiImagineBrokerResponse> {
  const id = responseId(value);
  try {
    const request = parseXaiImagineBrokerRequest(value);
    const result = await broker.handle(request);
    return {
      protocol_version: XAI_IMAGINE_BROKER_PROTOCOL_VERSION,
      id: request.id,
      ok: true,
      result,
    };
  } catch (error) {
    const brokerError =
      error instanceof XaiImagineBrokerError
        ? error
        : new XaiImagineBrokerError(
            "internal_error",
            "The xAI Imagine broker encountered an internal error",
          );
    return {
      protocol_version: XAI_IMAGINE_BROKER_PROTOCOL_VERSION,
      id,
      ok: false,
      error: {
        code: brokerError.code,
        message: brokerError.message,
        retryable: brokerError.retryable,
        ...(brokerError.details !== undefined
          ? { details: brokerError.details }
          : {}),
      },
    };
  }
}

export function invalidJsonBrokerResponse(): XaiImagineBrokerResponse {
  return {
    protocol_version: XAI_IMAGINE_BROKER_PROTOCOL_VERSION,
    id: null,
    ok: false,
    error: {
      code: "invalid_json",
      message: "input line is not valid JSON",
      retryable: false,
    },
  };
}
