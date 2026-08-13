import { describe, expect, it } from "vitest";

import {
  REGISTERED_MODEL_CATALOG,
  deriveFlatCatalog,
  resolveRegisteredModelCatalogEntry,
} from "../registry/model-catalog.js";
import { getContextWindowForModel } from "../../utils/context.js";
import { supportsXaiStructuredOutputsWithTools } from "../structured-output.js";

/**
 * xAI shipped grok-4.6 on 2026-08-12 and it was missing from the catalog, so
 * it never appeared in /model and callers fell back to heuristics for its
 * context window. Specs pinned against https://docs.x.ai/developers/grok-4-6.
 */
describe("grok-4.6 is catalogued", () => {
  const entry = resolveRegisteredModelCatalogEntry({
    provider: "grok",
    model: "grok-4.6",
  });

  it("resolves as a listed grok model", () => {
    expect(entry).toBeDefined();
    expect(entry?.provider).toBe("grok");
    expect(entry?.displayName).toBe("Grok 4.6");
    // "hide" would keep it resolvable but drop it from the /model picker —
    // which is the exact symptom this entry exists to fix.
    expect(entry?.visibility).toBe("list");
  });

  it("carries the documented 500k context window", () => {
    expect(entry?.contextWindow).toBe(500_000);
    expect(entry?.maxContextWindow).toBe(500_000);
    // Resolved through the catalog rather than a name heuristic.
    expect(getContextWindowForModel("grok-4.6")).toBe(500_000);
  });

  // xAI documents low/medium/high/xhigh for this model. Every earlier Grok
  // stops at high, so reusing the shared tuple would make the top effort tier
  // unreachable.
  it("exposes xhigh, unlike every earlier Grok", () => {
    expect(entry?.supportedReasoningLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(entry?.defaultReasoningLevel).toBe("high");

    const grok45 = resolveRegisteredModelCatalogEntry({
      provider: "grok",
      model: "grok-4.5",
    });
    expect(grok45?.supportedReasoningLevels).not.toContain("xhigh");
  });

  it("takes text and images, tools and structured output", () => {
    expect(entry?.inputModalities).toContain("image");
    expect(entry?.supportsToolUse).toBe(true);
    expect(entry?.supportsStructuredOutput).toBe(true);
    // The grok-4 family gate already accepts a dotted minor.
    expect(supportsXaiStructuredOutputsWithTools("grok-4.6")).toBe(true);
  });

  it("is offered ahead of grok-4.5 in the picker", () => {
    const order = deriveFlatCatalog(REGISTERED_MODEL_CATALOG).grok ?? [];
    expect(order.indexOf("grok-4.6")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("grok-4.6")).toBeLessThan(order.indexOf("grok-4.5"));
  });
});
