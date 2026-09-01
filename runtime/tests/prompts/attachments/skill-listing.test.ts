/**
 * The skill listing must reach the model on every sampling request.
 * Attachment messages are never persisted into canonical history, so a
 * cross-turn hash gate hid the listing from the second request onward.
 */
import { describe, expect, test } from "vitest";

import { getAttachmentTrackingState } from "../../session/attachment-state.js";
import { SKILL_LISTING_REMINDER_HEADER } from "./messages.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";
import { skillListingProducer } from "./skill-listing.js";

function makeOpts(
  partial?: Partial<GetAttachmentsOptions>,
): GetAttachmentsOptions {
  return {
    sessionKey: {},
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-skill-listing-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    agencHome: "/tmp/agenc-skill-listing-home",
    skillsManager: {
      skillsForConfig: async () => ({
        invokedSkills: [],
        availableSkills: [
          {
            name: "repo-docs",
            description: "Explain the repository docs",
            loadedFrom: "skills",
          },
        ],
      }),
    },
    ...partial,
  };
}

describe("skillListingProducer", () => {
  test("emits the listing on every request whose history does not carry it", async () => {
    const opts = makeOpts();
    const trackingState = getAttachmentTrackingState(opts.sessionKey);

    const first = await skillListingProducer(opts, trackingState);
    const second = await skillListingProducer(opts, trackingState);

    for (const out of [first, second]) {
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: "skill_listing" });
      expect(out[0]).toHaveProperty(
        "content",
        expect.stringContaining("- repo-docs: Explain the repository docs"),
      );
    }
  });

  test("stays quiet when a message already carries the rendered listing", async () => {
    const rendered =
      `<system-reminder>\n${SKILL_LISTING_REMINDER_HEADER}\n\n- repo-docs: Explain the repository docs\n</system-reminder>`;
    const asString = makeOpts({
      messages: [
        { role: "system", content: "base prompt" },
        { role: "user", content: rendered },
        { role: "user", content: "hello" },
      ],
    });
    const asParts = makeOpts({
      messages: [
        { role: "user", content: [{ type: "text", text: rendered }] },
      ],
    });

    expect(
      await skillListingProducer(asString, getAttachmentTrackingState(asString.sessionKey)),
    ).toEqual([]);
    expect(
      await skillListingProducer(asParts, getAttachmentTrackingState(asParts.sessionKey)),
    ).toEqual([]);
  });

  test("emits nothing for subagents or when no skill is model-invocable", async () => {
    const subagent = makeOpts({ subagentDepth: 1 });
    expect(
      await skillListingProducer(subagent, getAttachmentTrackingState(subagent.sessionKey)),
    ).toEqual([]);

    const hiddenOnly = makeOpts({
      skillsManager: {
        skillsForConfig: async () => ({
          invokedSkills: [],
          availableSkills: [
            { name: "batch", description: "Bulk edits", disableModelInvocation: true },
          ],
        }),
      },
    });
    expect(
      await skillListingProducer(hiddenOnly, getAttachmentTrackingState(hiddenOnly.sessionKey)),
    ).toEqual([]);
  });
});
