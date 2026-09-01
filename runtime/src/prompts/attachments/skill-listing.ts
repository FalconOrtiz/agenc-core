import type { LLMMessage } from "../../llm/types.js";
import type { AttachmentProducer } from "./orchestrator.js";
import { SKILL_LISTING_REMINDER_HEADER } from "./messages.js";
import { formatSkillListingWithinBudget } from "../../skills/local-loader.js";

function messageCarriesText(message: LLMMessage, needle: string): boolean {
  if (typeof message.content === "string") {
    return message.content.includes(needle);
  }
  return message.content.some(
    (part) => part.type === "text" && part.text.includes(needle),
  );
}

/**
 * Attachment messages are not persisted into canonical history: every
 * sampling request re-projects `messagesForQuery` from `state.messages`,
 * so a listing emitted on the previous request is gone by the next one.
 * The gate is therefore an absence check against the request's own
 * messages, not a cross-turn hash: the listing is emitted on every request
 * unless this request already carries it. Inserted right after the leading
 * system prefix, it lands at a byte-stable position inside the cached prefix.
 */
export const skillListingProducer: AttachmentProducer = async (opts) => {
  if (opts.subagentDepth > 0) return [];
  if (!opts.skillsManager) return [];
  if (
    opts.messages.some((message) =>
      messageCarriesText(message, SKILL_LISTING_REMINDER_HEADER),
    )
  ) {
    return [];
  }

  const outcome = await opts.skillsManager.skillsForConfig(opts.config ?? {}, null);
  const skills = outcome.availableSkills ?? [];
  const listing = formatSkillListingWithinBudget(
    skills,
    opts.contextWindowTokens,
  );
  if (listing.length === 0) return [];

  return [
    {
      kind: "skill_listing",
      content: listing,
    },
  ];
};
