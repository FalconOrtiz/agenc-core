# xAI OAuth media broker protocol

`agenc xai broker --stdio` is AgenC's stable subprocess boundary for xAI
Imagine and text-to-speech operations. It is intended for local film machinery
that needs resumable, hash-bound artifacts without receiving an OAuth token.

## Security and lifecycle invariants

- Authentication is stored xAI OAuth only. Broker mode never reads an API key
  and has no API-key fallback.
- Authenticated requests are pinned to `https://api.x.ai/v1`; callers cannot
  override the origin.
- Expiring credentials are refreshed before requests. Safe GETs retry once
  after forced refresh. A paid POST retries only after a definite 401/403
  rejection; no ambiguous POST is retried.
- xAI's OpenAPI does not document request idempotency or lookup by idempotency
  key. The caller key is a broker correlation key, not a provider deduplication
  guarantee. A transport failure, malformed success, or 5xx is
  `submission_unknown`: manually reconcile it and never resubmit blindly.
- Artifacts are written only beneath the startup working directory. Writes use
  a same-directory partial, `fsync`, SHA-256, and hard-link no-replace commit.
  Existing files are never overwritten.
- Image and video requests ask xAI to retain output as a private Files object
  for 30 days; no persistent public URL is requested. Any temporary provider
  URL remains broker-private. The broker acquires the output, checks size and
  media signature, and hashes it before success.
- Signed URLs and private source IDs never cross NDJSON. Recovery failures
  expose only opaque `recovery_handle` values and safe destination metadata.
- Private recovery and operation receipts live under the AgenC config
  directory, keyed by artifact-root fingerprint, with 0700/0600 permissions.
  They never live in the film project. The local trust boundary is the OS
  account: another process running as the same user can access that user's
  files and native credential vault.
- A conservative operation receipt is written before each paid POST. Query
  `operations.status` after broker/stdout loss. A pre-response receipt can
  remain `submission_unknown`; this blocks unsafe duplication rather than
  claiming provider reconciliation that xAI does not offer.
- stdout contains protocol frames only. Human login instructions and CLI
  diagnostics use stderr.

## Framing and schema

Transport is UTF-8 NDJSON, one object per line. Input and output lines are
limited to 16 MiB. Empty lines are ignored. Responses remain ordered and the
process drains accepted input and serialized output before exiting on stdin
EOF.

Request:

```json
{"protocol_version":1,"id":"caller-unique-id","method":"protocol.version","params":{}}
```

Success:

```json
{"protocol_version":1,"id":"caller-unique-id","ok":true,"result":{}}
```

Failure:

```json
{
  "protocol_version": 1,
  "id": "caller-unique-id",
  "ok": false,
  "error": {
    "code": "invalid_request",
    "message": "description",
    "retryable": false,
    "details": {}
  }
}
```

The protocol identity is `agenc.xai.imagine`, numeric version `1`. Call
`protocol.version` first and reject an unexpected name or version. Its
`method_schemas` field is the machine-readable JSON Schema contract for every
method. Golden v1 frames live in
`runtime/tests/fixtures/xai-imagine-broker-v1.json`.

## Methods

### `protocol.version`

No parameters. Returns name, numeric version, transport, OAuth-only auth mode,
pinned API base URL, artifact root, complete method list, and method schemas.

### `operations.status`

Requires `operation` and `key`. `operation` is one of `images.generate`,
`images.edit`, `videos.submit`, `videos.poll`, or `tts.generate`. The key is the
caller `idempotency_key`, except for `videos.poll`, where it is `request_id`.

Returns one of `not_found`, `submission_unknown`, `submitted`,
`recovery_required`, or `completed`, with a machine-readable `caller_action`.
Completed receipts contain only safe results and hash-bound local artifacts.
Recovery receipts contain only opaque handles and safe destinations.

### `auth.status`

No parameters. Returns only safe status: `auth_mode`, `configured`, `ready`,
quarantine/expiry flags, storage kind, and `storage_security`. It never returns
access, refresh, or ID tokens.

### `auth.migrate_storage`

No parameters. Serializes xAI credential mutation against rotating refresh,
writes the authoritative shared blob to native secure storage, verifies exact
readback, then deletes plaintext. On detected concurrent change it removes the
stale native copy and retains plaintext. The result contains status only.

### `capabilities.probe`

Performs authenticated safe reads of `/v1/image-generation-models`,
`/v1/video-generation-models`, and `/v1/tts/voices`. Observed live cards are
kept distinct from documented expectations; voice-list success does not imply
TTS generation entitlement.

### `images.generate`

Required parameters are `idempotency_key`, non-empty `prompt`, and absolute
`destinations` beneath the artifact root, exactly one per requested image.
Optional fields are `model`, `n` (1-10, default 1), `aspect_ratio`, and
`resolution`. The live model card must advertise every required modality.

Success contains safe image metadata plus:

```json
{"artifacts":[{"destination":"/film/shot.png","bytes":1234,"sha256":"...","mime_type":"image/png","downloaded_at":"..."}]}
```

No generated source URL is returned.

### `images.edit`

Adds required `images`, one to three references. A reference contains exactly
one of:

```json
{"url":"https://..."}
{"file_id":"file_..."}
{"path":"/film/artifacts/input.png","sha256":"64 lowercase hex"}
```

Local paths must be beneath the artifact root. The broker opens them without
following symlinks, enforces size and media signatures, verifies SHA-256, and
converts the bytes into a provider data reference internally. Local paths and
data URIs never appear in broker results.

### `videos.submit`

Requires `idempotency_key` and `prompt`. `operation` is `generate` (default),
`edit`, or `extend`; `model` may lock an explicit live model.

- Generate accepts `image`, or reference mode with `reference_images` and up
  to three `reference_audios: [{voice_id}]`. All actual text/image/audio
  modalities must be advertised by the live card. Reference mode is capped at
  720p.
- Edit and extend require `video` and a live video-input card. Image and video
  references accept URL, File ID, or local `{path, sha256}`.
- Extension duration is 2-10 seconds. Generation duration is 1-15 seconds.

Success returns `request_id`, operation, caller key, status, and submission
time. Persist these in the film checkpoint.

### `videos.poll`

Requires `request_id` and absolute `destination` beneath the artifact root.
Pending states return a typed `caller_action`. On `done`, the broker immediately
downloads the private File, validates it as video, atomically commits it, and
returns `artifact`. No source URL is returned. Acquisition failure returns an
opaque recovery handle.

### `tts.voices`

No parameters. Returns the OAuth-observed voice registry and observation time.

### `tts.generate`

Requires `idempotency_key`, text (maximum 15,000 characters), explicit
`voice_id`, BCP-47 `language` or `auto`, and absolute `destination`. Optional
fields are `output_format`, `speed` (0.7-1.5),
`optimize_streaming_latency` (0-2), `text_normalization`, and
`with_timestamps`.

The voice is checked by safe GET before POST. MP3/WAV signatures and non-empty
raw audio are checked before atomic commit. Timestamp mode validates base64 and
timing order. Invalid timing metadata does not discard valid paid audio: the
result contains the artifact and `alignment.valid: false` with a typed error.
Binary data is never written to NDJSON.

### `artifacts.download`

Requires only `{ "recovery_handle": "recovery_..." }`. The caller cannot
supply a URL, File ID, destination, size limit, or digest. The handle resolves
inside broker-owned private state. Success is:

```json
{
  "recovery_handle": "recovery_...",
  "recovered": true,
  "artifact": {
    "destination": "/film/artifacts/shot.png",
    "bytes": 1234,
    "sha256": "64 lowercase hex characters",
    "mime_type": "image/png",
    "downloaded_at": "2026-08-09T00:00:00.000Z"
  }
}
```

## Typed error handling

| Code | Caller action |
| --- | --- |
| `auth_required` | Run `agenc xai auth login` or `--device`. |
| `auth_quarantined` | Sign in again; never retry the dead rotating grant. |
| `auth_refresh_failed` | Retry later or sign in again. |
| `auth_or_entitlement_denied` | Check OAuth account and xAI entitlement. |
| `storage_migration_failed` | Plaintext remains; repair native storage and retry. |
| `rate_limited` | Honor `details.retry_after_ms` when present. |
| `upstream_rejected` | Fix the request; it was definitely rejected. |
| `submission_unknown` | Query `operations.status`; manually reconcile, never resubmit blindly. |
| `download_failed` | Resume only through an opaque recovery handle. |
| `destination_exists` | Resolve the conflict; the broker never overwrites. |
| `integrity_mismatch` | Quarantine the bad transfer and resume safely. |

Live endpoint shapes and model cards can change. Use `capabilities.probe`
instead of embedding a model inventory. See the official xAI
[model registry](https://docs.x.ai/developers/rest-api-reference/inference/models),
[Imagine overview](https://docs.x.ai/developers/model-capabilities/images/overview),
and [voice API](https://docs.x.ai/developers/rest-api-reference/inference/voice).
