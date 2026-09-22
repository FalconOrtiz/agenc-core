import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const source = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("system prompt authority architecture", () => {
  test("keeps startup and provider switches on one base-instructions adapter", () => {
    const authority = source("../../src/prompts/system-prompt.ts");
    const consumers = [
      source("../../src/bin/bootstrap.ts"),
      source("../../src/session/session.ts"),
    ];

    expect(authority).toMatch(
      /export async function assembleBaseInstructionsForModel\b/u,
    );
    for (const consumer of consumers) {
      expect(consumer).toContain("assembleBaseInstructionsForModel({");
      expect(consumer).not.toMatch(
        /function\s+buildBaseInstructionsForModel\b/u,
      );
    }
  });

  test("passes captured client identity to startup and retains it across model switches and rollout replay", () => {
    const bootstrap = source("../../src/bin/bootstrap.ts");
    const session = source("../../src/session/session.ts");
    const replay = source("../../src/conversation/thread-manager.ts");
    const renderer = source("../../src/prompts/client-rendering.ts");
    expect(bootstrap).toMatch(/assembleBaseInstructionsForModel\(\{\s*session:\s*\{\s*services:\s*\{[^}]*providerEnvironment/su);
    expect(session).toMatch(/assembleBaseInstructionsForModel\(\{\s*session:\s*this,/u);
    const replayBody = replay.slice(replay.indexOf("async function applyRolloutReconstructionToSession("), replay.indexOf("function emitSynthesizedEvents("));
    expect(replayBody).toContain("...current");
    expect(replayBody).not.toContain("sessionConfiguration:");
    expect(renderer).not.toContain("process.env");
    expect(renderer).not.toMatch(/getCurrentRuntimeSession|peekAmbientRuntimeSession/u);
  });
});
