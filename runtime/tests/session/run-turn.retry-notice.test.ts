import { describe, expect, test } from "vitest";

import {
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../../src/llm/errors.js";
import { StreamModelError } from "../../src/phases/stream-model.js";
import { streamRetryNoticeMessage } from "../../src/session/run-turn.js";

// The reconnect ladder makes one initial call plus five recovery re-entries.
const MAX_ATTEMPTS = 6;

describe("streamRetryNoticeMessage", () => {
  test("a 429 names the rate limit and the server's Retry-After delay", () => {
    const wrapped = new StreamModelError(
      new LLMRateLimitError("grok", 12_000),
    );
    expect(streamRetryNoticeMessage(wrapped, 1, MAX_ATTEMPTS)).toBe(
      "rate limited, retrying in 12 s (2/6): grok rate limited, retry after 12000ms",
    );
  });

  test("a 5xx names the provider status and the exponential cap for the attempt", () => {
    const wrapped = new StreamModelError(
      new LLMServerError("grok", 503, "overloaded"),
    );
    // attempt 1 -> cap 1 s, attempt 3 -> cap 4 s, attempt 6 -> saturates at 30 s
    expect(streamRetryNoticeMessage(wrapped, 1, MAX_ATTEMPTS)).toMatch(
      /^provider error \(HTTP 503\), retrying in up to 1 s \(2\/6\): /,
    );
    expect(streamRetryNoticeMessage(wrapped, 3, MAX_ATTEMPTS)).toMatch(
      /^provider error \(HTTP 503\), retrying in up to 4 s \(4\/6\): /,
    );
    expect(streamRetryNoticeMessage(wrapped, 6, MAX_ATTEMPTS)).toMatch(
      /^provider error \(HTTP 503\), retrying in up to 30 s \(7\/6\): /,
    );
  });

  test("timeouts, watchdog idles and socket drops get their own labels", () => {
    expect(
      streamRetryNoticeMessage(
        new StreamModelError(new LLMTimeoutError("grok", 120_000)),
        1,
        MAX_ATTEMPTS,
      ),
    ).toMatch(/^request timed out, retrying in up to 1 s \(2\/6\): /);
    expect(
      streamRetryNoticeMessage(
        new StreamModelError(new Error("stream_idle: no data for 600000ms")),
        2,
        MAX_ATTEMPTS,
      ),
    ).toBe(
      "stream idle, retrying in up to 2 s (3/6): stream_idle: no data for 600000ms",
    );
    expect(
      streamRetryNoticeMessage(
        new StreamModelError(
          Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        ),
        1,
        MAX_ATTEMPTS,
      ),
    ).toBe(
      "connection lost (ECONNRESET), retrying in up to 1 s (2/6): socket hang up",
    );
  });

  test("a Retry-After above the policy ceiling is reported instead of a delay", () => {
    const wrapped = new StreamModelError(
      new LLMRateLimitError("grok", 600_000),
    );
    expect(streamRetryNoticeMessage(wrapped, 1, MAX_ATTEMPTS)).toMatch(
      /^rate limited, server asked to wait 600 s, above the retry policy \(2\/6\): /,
    );
  });

  test("unclassified failures keep the generic wording", () => {
    expect(
      streamRetryNoticeMessage(new Error("something odd"), 1, MAX_ATTEMPTS),
    ).toBe(
      "stream interruption, retrying in up to 1 s (2/6): something odd",
    );
  });
});
