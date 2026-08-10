import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  XAI_IMAGINE_API_BASE_URL,
  XaiImagineBroker,
  handleXaiImagineBrokerValue,
  parseXaiImagineBrokerRequest,
  type XaiImagineBrokerOauth,
} from "../../../src/services/xai/imagine-broker.js";
import type { XaiOauthCredentialBlob } from "../../../src/utils/xaiOauthCredentials.js";
import { asRecord } from "../../../src/utils/record.js";

const temporaryRoots: string[] = [];
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("mock-png"),
]);
const WAV_BYTES = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVEfmt mock-wave-audio"),
]);
const MP3_BYTES = Buffer.concat([Buffer.from("ID3"), Buffer.from("timed-audio")]);
const MP4_BYTES = Buffer.concat([
  Buffer.from([0, 0, 0, 16]),
  Buffer.from("ftypisom"),
  Buffer.from("mock-video"),
]);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
  vi.restoreAllMocks();
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenc-xai-broker-"));
  temporaryRoots.push(root);
  return root;
}

function credentials(
  overrides: Partial<XaiOauthCredentialBlob> = {},
): XaiOauthCredentialBlob {
  return {
    accessToken: "oauth-access-secret",
    refreshToken: "oauth-refresh-secret",
    expiresAt: Date.now() + 6 * 60 * 60 * 1_000,
    accountLabel: "safe-account-label",
    ...overrides,
  };
}

function oauth(
  initial: XaiOauthCredentialBlob | null | undefined = credentials(),
  refreshed: XaiOauthCredentialBlob | null | undefined = credentials({
    accessToken: "oauth-access-secret-rotated",
  }),
  storage = "libsecret",
): XaiImagineBrokerOauth & {
  read: ReturnType<typeof vi.fn>;
  refreshIfNeeded: ReturnType<typeof vi.fn>;
  forceRefresh: ReturnType<typeof vi.fn>;
} {
  let current = initial ?? undefined;
  return {
    read: vi.fn(() => current),
    refreshIfNeeded: vi.fn(async () => {
      current = refreshed ?? undefined;
      return refreshed ?? undefined;
    }),
    forceRefresh: vi.fn(async () => {
      current = refreshed ?? undefined;
      return refreshed ?? undefined;
    }),
    storageKind: () => storage,
  };
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function modelRegistry(
  id: string,
  inputModalities: readonly string[],
  outputModalities: readonly string[],
): Response {
  return json({
    models: [
      {
        id,
        fingerprint: `fp-${id}`,
        max_prompt_length: 10_000,
        input_modalities: inputModalities,
        output_modalities: outputModalities,
      },
    ],
  });
}

function request(
  method:
    | "protocol.version"
    | "operations.status"
    | "auth.status"
    | "auth.migrate_storage"
    | "capabilities.probe"
    | "images.generate"
    | "images.edit"
    | "videos.submit"
    | "videos.poll"
    | "tts.voices"
    | "tts.generate"
    | "artifacts.download",
  params?: Record<string, unknown>,
) {
  return {
    protocol_version: 1 as const,
    id: "request-1",
    method,
    ...(params === undefined ? {} : { params }),
  };
}

describe("xAI Imagine broker protocol and auth boundary", () => {
  test("advertises the stable OAuth-only protocol without exposing credentials", async () => {
    const root = await temporaryRoot();
    const session = oauth(credentials(), credentials(), "plaintext");
    const broker = new XaiImagineBroker({ oauth: session, artifactRoot: root });

    const protocol = await broker.handle(request("protocol.version"));
    const status = await broker.handle(request("auth.status"));
    const serialized = JSON.stringify({ protocol, status });

    expect(protocol).toMatchObject({
      name: "agenc.xai.imagine",
      version: 1,
      auth_modes: ["oauth"],
      base_url: "https://api.x.ai/v1",
    });
    expect(protocol.methods).toEqual(
      expect.arrayContaining([
        "auth.migrate_storage",
        "tts.voices",
        "tts.generate",
      ]),
    );
    expect(asRecord(protocol.method_schemas)).toEqual(
      expect.objectContaining({
        "images.generate": expect.any(Object),
        "videos.poll": expect.any(Object),
        "artifacts.download": expect.any(Object),
        "operations.status": expect.any(Object),
      }),
    );
    expect(status).toMatchObject({
      auth_mode: "oauth",
      configured: true,
      ready: true,
      storage_security: {
        status: "plaintext",
        secure: false,
        migration_available: true,
      },
    });
    expect(serialized).not.toContain("oauth-access-secret");
    expect(serialized).not.toContain("oauth-refresh-secret");
  });

  test("keeps golden v1 request fixtures parseable", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../fixtures/xai-imagine-broker-v1.json", import.meta.url),
        "utf8",
      ),
    ) as { requests: unknown[] };
    expect(fixture.requests.map(parseXaiImagineBrokerRequest)).toHaveLength(4);
  });

  test("never falls back to an API key when OAuth is absent", async () => {
    const original = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "api-key-must-not-be-used";
    try {
      const broker = new XaiImagineBroker({
        oauth: oauth(null, null),
        fetchImpl: vi.fn(async () => {
          throw new Error("fetch must not run");
        }),
        artifactRoot: await temporaryRoot(),
      });
      const response = await handleXaiImagineBrokerValue(
        broker,
        request("tts.voices"),
      );
      expect(response).toMatchObject({
        ok: false,
        error: { code: "auth_required" },
      });
      expect(JSON.stringify(response)).not.toContain("api-key-must-not-be-used");
    } finally {
      if (original === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = original;
    }
  });

  test("reports expired unrefreshable OAuth as not ready", async () => {
    const broker = new XaiImagineBroker({
      oauth: oauth(credentials({ expiresAt: Date.now() - 1, refreshToken: undefined })),
      artifactRoot: await temporaryRoot(),
    });
    expect(await broker.handle(request("auth.status"))).toMatchObject({
      configured: true,
      ready: false,
      refreshable: false,
      expiring: true,
      needs_reauthentication: true,
    });
  });

  test("returns only migration status", async () => {
    const broker = new XaiImagineBroker({
      oauth: oauth(),
      artifactRoot: await temporaryRoot(),
      migrateStorage: () => ({
        success: true,
        migrated: true,
        alreadySecure: false,
        storage: "libsecret",
      }),
    });
    expect(await broker.handle(request("auth.migrate_storage"))).toEqual({
      migrated: true,
      already_secure: false,
      storage: "libsecret",
      storage_security: {
        status: "native_secure_storage",
        secure: true,
        migration_available: false,
      },
    });
  });

  test("validates version, method, fields, and request ids", () => {
    expect(() => parseXaiImagineBrokerRequest({})).toThrow(/protocol_version/u);
    expect(() =>
      parseXaiImagineBrokerRequest({
        protocol_version: 2,
        id: "x",
        method: "auth.status",
      }),
    ).toThrow(/protocol_version/u);
    expect(() =>
      parseXaiImagineBrokerRequest({
        protocol_version: 1,
        id: "x",
        method: "tokens.dump",
      }),
    ).toThrow(/unknown broker method/u);
  });
});

describe("live capability evidence with mocked endpoints", () => {
  test("probes the dedicated image, video, and voice registries", async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/v1/image-generation-models") {
        return modelRegistry("grok-imagine-image", ["text", "image"], ["image"]);
      }
      if (path === "/v1/video-generation-models") {
        return modelRegistry("grok-imagine-video", ["text", "image", "video"], ["video"]);
      }
      if (path === "/v1/tts/voices") {
        return json({ voices: [{ voice_id: "eve", name: "Eve", language: "multilingual" }] });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: await temporaryRoot(),
      now: () => Date.UTC(2026, 7, 9),
    });

    const result = await broker.handle(request("capabilities.probe"));
    expect(paths).toEqual([
      "/v1/image-generation-models",
      "/v1/video-generation-models",
      "/v1/tts/voices",
    ]);
    expect(result).toMatchObject({
      auth_mode: "oauth",
      observed: {
        image: { available: true, evidence: "oauth_endpoint_response" },
        video: { available: true, evidence: "oauth_endpoint_response" },
        tts: {
          available: true,
          evidence: "oauth_endpoint_response",
          generate_entitlement: "unverified_until_submission",
        },
      },
      documented_contract: {
        evidence: "xai_documentation_not_live_entitlement",
      },
    });
  });

  test("reports an endpoint entitlement denial without inventing capability", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/image-generation-models") {
        return modelRegistry("grok-imagine-image", ["text"], ["image"]);
      }
      if (path === "/v1/video-generation-models") {
        return json({ error: { message: "not entitled" } }, 403);
      }
      return json({ voices: [] });
    });
    const session = oauth();
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: session,
      artifactRoot: await temporaryRoot(),
    });
    const result = await broker.handle(request("capabilities.probe"));
    expect(result.observed).toMatchObject({
      video: {
        available: false,
        error: { code: "auth_or_entitlement_denied", http_status: 403 },
      },
    });
    expect(session.forceRefresh).toHaveBeenCalledTimes(1);
  });

  test("retries a safe authenticated read once after rotating OAuth", async () => {
    const authorizations: string[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      calls += 1;
      return calls === 1
        ? json({ error: { message: "expired" } }, 401)
        : json({ voices: [{ voice_id: "eve" }] });
    });
    const session = oauth();
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: session,
      artifactRoot: await temporaryRoot(),
    });
    expect(await broker.handle(request("tts.voices"))).toMatchObject({
      voices: [{ voice_id: "eve" }],
    });
    expect(authorizations).toEqual([
      "Bearer oauth-access-secret",
      "Bearer oauth-access-secret-rotated",
    ]);
    expect(session.forceRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("paid image and video submissions", () => {
  test("pins image generation to api.x.ai and preserves caller idempotency", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "generated.png");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (path === "/v1/image-generation-models") {
        return modelRegistry("grok-imagine-image-quality", ["text", "image"], ["image"]);
      }
      if (path === "/v1/images/generations") {
        return json({
          data: [{
            url: "https://imgen.x.ai/result.png?signature=private-source",
            file_output: { file_id: "file_image_done" },
          }],
        });
      }
      if (path === "/v1/files/file_image_done/content") {
        return new Response(PNG_BYTES, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: root,
    });
    const result = await broker.handle(
      request("images.generate", {
        idempotency_key: "image-shot-0001",
        prompt: "Cinematic rain at night",
        model: "grok-imagine-image-quality",
        n: 1,
        aspect_ratio: "16:9",
        destinations: [destination],
      }),
    );
    expect(JSON.stringify(result)).not.toContain("file_image_done");
    expect(JSON.stringify(result)).not.toContain("private-source");
    const post = calls.find((call) => call.init?.method === "POST");
    expect(post?.url).toBe(`${XAI_IMAGINE_API_BASE_URL}/images/generations`);
    expect(new Headers(post?.init?.headers).get("x-idempotency-key")).toBe(
      "image-shot-0001",
    );
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      model: "grok-imagine-image-quality",
      prompt: "Cinematic rain at night",
      response_format: "url",
      storage_options: {
        expires_after: 2_592_000,
      },
    });
    expect(result).toMatchObject({
      operation: "generate",
      idempotency_key: "image-shot-0001",
      images: [{ index: 0, provider_record_valid: true }],
      artifacts: [{ destination }],
    });
    expect(await readFile(destination)).toEqual(PNG_BYTES);
    expect(
      await broker.handle(
        request("operations.status", {
          operation: "images.generate",
          key: "image-shot-0001",
        }),
      ),
    ).toMatchObject({
      state: "completed",
      caller_action: "use_result",
      result: { artifacts: [{ destination }] },
    });
  });

  test("uses JSON multi-image edits with at most three references", async () => {
    const root = await temporaryRoot();
    let postBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/image-generation-models") {
        return modelRegistry("grok-imagine-image", ["text", "image"], ["image"]);
      }
      if (new URL(String(input)).hostname === "imgen.x.ai") {
        return new Response(PNG_BYTES, {
          headers: { "content-type": "image/png" },
        });
      }
      postBody = JSON.parse(String(init?.body));
      return json({ data: [{ url: "https://imgen.x.ai/edit.png" }] });
    });
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: root,
    });
    await broker.handle(
      request("images.edit", {
        idempotency_key: "image-edit-0001",
        prompt: "Keep identity, repair jacket",
        model: "grok-imagine-image",
        images: [
          { url: "https://example.com/a.png" },
          { file_id: "file_reference_2" },
        ],
        destinations: [join(root, "edited.png")],
      }),
    );
    expect(postBody).toMatchObject({
      images: [
        { url: "https://example.com/a.png" },
        { file_id: "file_reference_2" },
      ],
    });
  });

  test("materializes hash-locked local image references without exposing paths upstream", async () => {
    const root = await temporaryRoot();
    const referencePath = join(root, "refs", "character.png");
    await mkdir(join(root, "refs"));
    await writeFile(referencePath, PNG_BYTES, { mode: 0o600 });
    let postBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("image-generation-models")) {
        return modelRegistry("grok-imagine-image", ["text", "image"], ["image"]);
      }
      if (url.hostname === "imgen.x.ai") {
        return new Response(PNG_BYTES, {
          headers: { "content-type": "image/png" },
        });
      }
      postBody = JSON.parse(String(init?.body));
      return json({ data: [{ url: "https://imgen.x.ai/local-edit.png" }] });
    });
    const broker = new XaiImagineBroker({ fetchImpl, oauth: oauth(), artifactRoot: root });
    await broker.handle(
      request("images.edit", {
        idempotency_key: "image-local-ref-0001",
        prompt: "Keep the exact identity",
        model: "grok-imagine-image",
        images: [{
          path: referencePath,
          sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
        }],
        destinations: [join(root, "edited-local.png")],
      }),
    );
    const materialized = asRecord(postBody?.image);
    expect(materialized?.url).toMatch(/^data:image\/png;base64,/u);
    expect(JSON.stringify(postBody)).not.toContain(referencePath);
    expect(JSON.stringify(postBody)).not.toContain("sha256");
  });

  test("obeys a live card that does not advertise text input", async () => {
    const fetchImpl = vi.fn(async () =>
      modelRegistry("grok-imagine-video-1.5", ["image", "video"], ["video"]),
    );
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: await temporaryRoot(),
    });
    const response = await handleXaiImagineBrokerValue(
      broker,
      request("videos.submit", {
        idempotency_key: "video-text-0001",
        operation: "generate",
        model: "grok-imagine-video-1.5",
        prompt: "A bird crosses the sunrise",
      }),
    );
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        details: { required_input_modalities: ["text"] },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("selects 1.5 only for image/reference generation when its live card permits it", async () => {
    let postedModel: unknown;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/video-generation-models") {
        return json({
          models: [
            {
              id: "grok-imagine-video",
              max_prompt_length: 10_000,
              input_modalities: ["text", "image", "video"],
              output_modalities: ["video"],
            },
            {
              id: "grok-imagine-video-1.5",
              max_prompt_length: 10_000,
              input_modalities: ["text", "image", "video"],
              output_modalities: ["video"],
            },
          ],
        });
      }
      postedModel = JSON.parse(String(init?.body)).model;
      return json({ request_id: "video-request-1" });
    });
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: await temporaryRoot(),
    });
    const result = await broker.handle(
      request("videos.submit", {
        idempotency_key: "video-image-0001",
        operation: "generate",
        prompt: "She turns toward camera",
        image: { file_id: "file_character_1" },
      }),
    );
    expect(postedModel).toBe("grok-imagine-video-1.5");
    expect(result).toMatchObject({
      request_id: "video-request-1",
      status: "submitted",
    });
  });

  test("selects 1.5 for text generation when the live registry advertises text", async () => {
    let postedModel: unknown;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/video-generation-models") {
        return json({
          models: [
            {
              id: "grok-imagine-video-1.5",
              max_prompt_length: 10_000,
              input_modalities: ["text", "image", "video"],
              output_modalities: ["video"],
            },
          ],
        });
      }
      postedModel = JSON.parse(String(init?.body)).model;
      return json({ request_id: "video-text-request-1" });
    });
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: await temporaryRoot(),
    });
    await broker.handle(
      request("videos.submit", {
        idempotency_key: "video-text-live-0001",
        prompt: "A practical miniature spaceship crosses frame",
      }),
    );
    expect(postedModel).toBe("grok-imagine-video-1.5");
  });

  test("resolves an explicitly advertised live model alias without fallback", async () => {
    let postedModel: unknown;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("video-generation-models")) {
        return json({
          models: [{
            id: "video-versioned-id",
            aliases: ["grok-imagine-video-1.5"],
            max_prompt_length: 10_000,
            input_modalities: ["text"],
            output_modalities: ["video"],
          }],
        });
      }
      postedModel = JSON.parse(String(init?.body)).model;
      return json({ request_id: "video-alias-request-1" });
    });
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: await temporaryRoot(),
    });
    await broker.handle(
      request("videos.submit", {
        idempotency_key: "video-alias-0001",
        prompt: "Alias lock",
        model: "grok-imagine-video-1.5",
      }),
    );
    expect(postedModel).toBe("grok-imagine-video-1.5");
  });

  test("validates and forwards up to three preset reference voices", async () => {
    let postBody: Record<string, unknown> | undefined;
    const voicePaths: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/video-generation-models") {
        return modelRegistry(
          "grok-imagine-video-1.5",
          ["text", "image", "video", "audio"],
          ["video"],
        );
      }
      if (path.startsWith("/v1/tts/voices/")) {
        voicePaths.push(path);
        return json({ voice_id: path.split("/").at(-1) });
      }
      postBody = JSON.parse(String(init?.body));
      return json({ request_id: "video-voice-request-1" });
    });
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: await temporaryRoot(),
    });
    await broker.handle(
      request("videos.submit", {
        idempotency_key: "video-voices-0001",
        prompt: "<AUDIO_0> calls to <AUDIO_1> across the station",
        reference_audios: [{ voice_id: "EVE" }, { voice_id: "rex" }],
        duration: 8,
        resolution: "720p",
      }),
    );
    expect(voicePaths).toEqual(["/v1/tts/voices/eve", "/v1/tts/voices/rex"]);
    expect(postBody).toMatchObject({
      model: "grok-imagine-video-1.5",
      reference_audios: [{ voice_id: "eve" }, { voice_id: "rex" }],
    });
  });

  test("rejects 1080p reference mode before submission", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("must not call xAI");
    });
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: await temporaryRoot(),
    });
    const response = await handleXaiImagineBrokerValue(
      broker,
      request("videos.submit", {
        idempotency_key: "video-ref-1080-0001",
        prompt: "<AUDIO_0> speaks",
        model: "grok-imagine-video-1.5",
        reference_audios: [{ voice_id: "eve" }],
        resolution: "1080p",
      }),
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("replays a definite 401 once with the same idempotency key", async () => {
    const root = await temporaryRoot();
    const postKeys: string[] = [];
    const postAuth: string[] = [];
    let postCount = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/image-generation-models") {
        return modelRegistry("grok-imagine-image", ["text"], ["image"]);
      }
      if (new URL(String(input)).hostname === "imgen.x.ai") {
        return new Response(PNG_BYTES, {
          headers: { "content-type": "image/png" },
        });
      }
      const headers = new Headers(init?.headers);
      postKeys.push(headers.get("x-idempotency-key") ?? "");
      postAuth.push(headers.get("authorization") ?? "");
      postCount += 1;
      return postCount === 1
        ? json({ error: { message: "expired" } }, 401)
        : json({ data: [{ url: "https://imgen.x.ai/recovered.png" }] });
    });
    const session = oauth();
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: session,
      artifactRoot: root,
    });
    await broker.handle(
      request("images.generate", {
        idempotency_key: "image-refresh-0001",
        prompt: "Recovered session",
        model: "grok-imagine-image",
        destinations: [join(root, "recovered.png")],
      }),
    );
    expect(postKeys).toEqual(["image-refresh-0001", "image-refresh-0001"]);
    expect(postAuth).toEqual([
      "Bearer oauth-access-secret",
      "Bearer oauth-access-secret-rotated",
    ]);
    expect(session.forceRefresh).toHaveBeenCalledTimes(1);
  });

  test("salvages valid paid image siblings before reporting a malformed set", async () => {
    const root = await temporaryRoot();
    const firstDestination = join(root, "first.png");
    const secondDestination = join(root, "second.png");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("image-generation-models")) {
        return modelRegistry("grok-imagine-image", ["text"], ["image"]);
      }
      if (path.endsWith("images/generations")) {
        return json({
          data: [
            { file_output: { file_id: "file_valid_sibling" } },
            null,
          ],
        });
      }
      return new Response(PNG_BYTES, {
        headers: { "content-type": "application/octet-stream" },
      });
    });
    const broker = new XaiImagineBroker({ fetchImpl, oauth: oauth(), artifactRoot: root });
    const response = await handleXaiImagineBrokerValue(
      broker,
      request("images.generate", {
        idempotency_key: "image-partial-set-0001",
        prompt: "Preserve valid siblings",
        model: "grok-imagine-image",
        n: 2,
        destinations: [firstDestination, secondDestination],
      }),
    );
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "download_failed",
        details: {
          completed_artifacts: [{ destination: firstDestination }],
          unrecoverable_image_indexes: [1],
        },
      },
    });
    expect(await readFile(firstDestination)).toEqual(PNG_BYTES);
    await expect(readFile(secondDestination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    ["transport failure", "throw"],
    ["provider 503", "503"],
  ])("reports submission_unknown on %s and never retries", async (_label, mode) => {
    const root = await temporaryRoot();
    let posts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/image-generation-models") {
        return modelRegistry("grok-imagine-image", ["text"], ["image"]);
      }
      posts += 1;
      if (mode === "throw") throw new Error("connection reset");
      return json({ error: { message: "internal" } }, 503);
    });
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: root,
    });
    const response = await handleXaiImagineBrokerValue(
      broker,
      request("images.generate", {
        idempotency_key: "image-ambiguous-0001",
        prompt: "Do not duplicate",
        model: "grok-imagine-image",
        destinations: [join(root, "ambiguous.png")],
      }),
    );
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "submission_unknown",
        retryable: false,
        details: { idempotency_key: "image-ambiguous-0001" },
      },
    });
    expect(posts).toBe(1);
    expect(
      await broker.handle(
        request("operations.status", {
          operation: "images.generate",
          key: "image-ambiguous-0001",
        }),
      ),
    ).toMatchObject({
      state: "submission_unknown",
      caller_action: "manual_reconciliation_no_resubmit",
    });
  });
});

describe("video polling and acquisition", () => {
  test("downloads a completed private video immediately and strips signed URLs", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "video", "shot.mp4");
    const signedUrl = "https://vidgen.x.ai/shot.mp4?signature=video-secret";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/videos/video-request-done") {
        return json({
          status: "done",
          video: {
            url: signedUrl,
            duration: 8,
            file_output: { file_id: "file_video_done" },
          },
        });
      }
      if (path === "/v1/files/file_video_done/content") {
        return new Response(MP4_BYTES, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    const broker = new XaiImagineBroker({ fetchImpl, oauth: oauth(), artifactRoot: root });
    const result = await broker.handle(
      request("videos.poll", {
        request_id: "video-request-done",
        destination,
      }),
    );
    expect(result).toMatchObject({
      request_id: "video-request-done",
      status: "done",
      terminal: true,
      artifact: { destination, bytes: MP4_BYTES.length, mime_type: "video/mp4" },
    });
    expect(JSON.stringify(result)).not.toContain(signedUrl);
    expect(JSON.stringify(result)).not.toContain("video-secret");
    expect(JSON.stringify(result)).not.toContain("file_video_done");
    expect(await readFile(destination)).toEqual(MP4_BYTES);
  });

  test("preserves provider video error codes and retry semantics", async () => {
    const root = await temporaryRoot();
    const broker = new XaiImagineBroker({
      fetchImpl: vi.fn(async () =>
        json({
          status: "failed",
          error: { code: "service_unavailable", message: "temporary worker loss" },
        }),
      ),
      oauth: oauth(),
      artifactRoot: root,
    });
    const result = await broker.handle(
      request("videos.poll", {
        request_id: "video-request-failed",
        destination: join(root, "unused.mp4"),
      }),
    );
    expect(result).toMatchObject({
      status: "failed",
      terminal: true,
      caller_action: "poll_or_escalate_without_resubmitting",
      provider_error: {
        code: "service_unavailable",
        retryable: true,
      },
    });
  });
});

describe("TTS binary artifact contract", () => {
  test("lists voices through a safe OAuth GET", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ voices: [{ voice_id: "eve", name: "Eve" }] }),
    );
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: await temporaryRoot(),
    });
    expect(await broker.handle(request("tts.voices"))).toMatchObject({
      voices: [{ voice_id: "eve", name: "Eve" }],
      evidence: "oauth_endpoint_response",
    });
  });

  test("streams raw audio to an atomic hashed artifact and never emits binary", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "audio", "locked-vo.wav");
    let postBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/tts/voices/eve") {
        return json({ voice_id: "eve", name: "Eve" });
      }
      postBody = JSON.parse(String(init?.body));
      return new Response(WAV_BYTES, {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    });
    const broker = new XaiImagineBroker({ fetchImpl, oauth: oauth(), artifactRoot: root });
    const result = await broker.handle(
      request("tts.generate", {
        idempotency_key: "tts-locked-0001",
        text: "We leave at dawn.",
        voice_id: "eve",
        language: "en",
        output_format: { codec: "wav", sample_rate: 48_000 },
        speed: 0.9,
        destination,
      }),
    );
    expect(postBody).toEqual({
      text: "We leave at dawn.",
      voice_id: "eve",
      language: "en",
      output_format: { codec: "wav", sample_rate: 48_000 },
      speed: 0.9,
    });
    expect(await readFile(destination)).toEqual(WAV_BYTES);
    expect(result).toMatchObject({
      idempotency_key: "tts-locked-0001",
      voice_id: "eve",
      artifact: {
        destination,
        bytes: WAV_BYTES.length,
        mime_type: "audio/wav",
      },
    });
    expect(JSON.stringify(result)).not.toContain(
      WAV_BYTES.toString("base64"),
    );
  });

  test("decodes timestamped JSON audio to disk and returns alignment metadata", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "audio", "timed.mp3");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/voices/eve")) return json({ voice_id: "eve" });
      return json({
        audio: MP3_BYTES.toString("base64"),
        content_type: "audio/mpeg",
        duration: 0.92,
        audio_timestamps: {
          graph_chars: ["H", "i"],
          graph_times: [[0, 0.4], [0.4, 0.92]],
        },
      });
    });
    const broker = new XaiImagineBroker({ fetchImpl, oauth: oauth(), artifactRoot: root });
    const result = await broker.handle(
      request("tts.generate", {
        idempotency_key: "tts-timed-0001",
        text: "Hi",
        voice_id: "eve",
        language: "en",
        with_timestamps: true,
        destination,
      }),
    );
    expect(await readFile(destination)).toEqual(MP3_BYTES);
    expect(result).toMatchObject({
      duration_seconds: 0.92,
      audio_timestamps: {
        graph_chars: ["H", "i"],
        graph_times: [[0, 0.4], [0.4, 0.92]],
      },
    });
  });

  test("keeps valid paid audio when timestamp alignment is malformed", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "audio", "salvaged.mp3");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname.endsWith("/voices/eve")) {
        return json({ voice_id: "eve" });
      }
      return json({
        audio: MP3_BYTES.toString("base64"),
        content_type: "audio/mpeg",
        duration: 1,
        audio_timestamps: {
          graph_chars: ["A", "B"],
          graph_times: [[0.5, 0.8], [0.2, 0.4]],
        },
      });
    });
    const broker = new XaiImagineBroker({ fetchImpl, oauth: oauth(), artifactRoot: root });
    const result = await broker.handle(
      request("tts.generate", {
        idempotency_key: "tts-salvage-0001",
        text: "AB",
        voice_id: "eve",
        language: "en",
        with_timestamps: true,
        destination,
      }),
    );
    expect(await readFile(destination)).toEqual(MP3_BYTES);
    expect(result).toMatchObject({
      artifact: { destination },
      alignment: {
        valid: false,
        error: { code: "invalid_timestamps" },
      },
    });
  });

  test("reports an ambiguous TTS server error without creating a file", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "audio", "missing.mp3");
    let posts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/voices/eve")) return json({ voice_id: "eve" });
      posts += 1;
      return json({ error: { message: "server failed" } }, 503);
    });
    const broker = new XaiImagineBroker({ fetchImpl, oauth: oauth(), artifactRoot: root });
    const response = await handleXaiImagineBrokerValue(
      broker,
      request("tts.generate", {
        idempotency_key: "tts-ambiguous-0001",
        text: "One take only",
        voice_id: "eve",
        language: "en",
        destination,
      }),
    );
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "submission_unknown",
        details: { idempotency_key: "tts-ambiguous-0001" },
      },
    });
    expect(posts).toBe(1);
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("artifact download safety", () => {
  test("resumes only through an opaque handle and never exposes a signed URL", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "frames", "shot-01.png");
    const signedUrl = "https://imgen.x.ai/artifacts/shot.png?token=cdn-secret";
    let downloads = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/image-generation-models") {
        return modelRegistry("grok-imagine-image", ["text"], ["image"]);
      }
      if (path === "/v1/images/generations") {
        return json({
          data: [{ url: signedUrl, file_output: { file_id: "file_generated_1" } }],
        });
      }
      if (path === "/v1/files/file_generated_1/content") {
        downloads += 1;
        return downloads === 1
          ? new Response("retry", { status: 503 })
          : new Response(PNG_BYTES, {
              headers: { "content-type": "application/octet-stream" },
            });
      }
      throw new Error(`unexpected ${path}`);
    });
    const broker = new XaiImagineBroker({ fetchImpl, oauth: oauth(), artifactRoot: root });
    const failed = await handleXaiImagineBrokerValue(
      broker,
      request("images.generate", {
        idempotency_key: "image-recovery-0001",
        prompt: "A safe recovery frame",
        model: "grok-imagine-image",
        destinations: [destination],
      }),
    );
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "download_failed",
        details: {
          pending_artifacts: [
            { recovery_handle: expect.stringMatching(/^recovery_/u), destination },
          ],
        },
      },
    });
    const serializedFailure = JSON.stringify(failed);
    expect(serializedFailure).not.toContain(signedUrl);
    expect(serializedFailure).not.toContain("cdn-secret");
    const error = "error" in failed ? failed.error : undefined;
    const pending = Array.isArray(error?.details?.pending_artifacts)
      ? error.details.pending_artifacts[0]
      : undefined;
    const handle = asRecord(pending)?.recovery_handle;
    expect(handle).toBeTypeOf("string");
    const resumed = await broker.handle(
      request("artifacts.download", { recovery_handle: handle }),
    );
    expect(resumed).toMatchObject({
      recovery_handle: handle,
      recovered: true,
      artifact: { destination, bytes: PNG_BYTES.length, mime_type: "image/png" },
    });
    expect(await readFile(destination)).toEqual(PNG_BYTES);
    await expect(readFile(join(root, ".agenc-xai-recovery"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rejects corrupt media and leaves no finished artifact", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "bad.png");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("image-generation-models")) {
        return modelRegistry("grok-imagine-image", ["text"], ["image"]);
      }
      if (path.endsWith("images/generations")) {
        return json({ data: [{ file_output: { file_id: "file_bad_image" } }] });
      }
      return new Response("<html>not an image</html>", {
        headers: { "content-type": "text/html" },
      });
    });
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: root,
    });
    const response = await handleXaiImagineBrokerValue(
      broker,
      request("images.generate", {
        idempotency_key: "image-corrupt-0001",
        prompt: "Corrupt fixture",
        model: "grok-imagine-image",
        destinations: [destination],
      }),
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "download_failed", details: { cause_code: "integrity_mismatch" } },
    });
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a malformed opaque recovery handle before network access", async () => {
    const fetchImpl = vi.fn();
    const broker = new XaiImagineBroker({
      fetchImpl,
      oauth: oauth(),
      artifactRoot: await temporaryRoot(),
    });
    const response = await handleXaiImagineBrokerValue(
      broker,
      request("artifacts.download", { recovery_handle: "recovery_not-valid" }),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
