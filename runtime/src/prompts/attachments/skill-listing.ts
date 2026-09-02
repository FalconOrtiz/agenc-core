import type { LLMMessage } from "../../llm/types.js";
import type { AttachmentProducer } from "./orchestrator.js";
import { SKILL_LISTING_REMINDER_HEADER } from "./messages.js";
import {
  formatSkillListingWithinBudget,
  type SkillListingEntry,
} from "../../skills/local-loader.js";

function messageCarriesText(message: LLMMessage, needle: string): boolean {
  if (typeof message.content === "string") {
    return message.content.includes(needle);
  }
  return message.content.some(
    (part) => part.type === "text" && part.text.includes(needle),
  );
}

/**
 * Skills registered through `registerBundledSkill` (browser-automation, the
 * marketplace kit installer) live outside the local loader, but the Skill
 * tool loads them, so the model must hear about them too. Dynamic literal
 * import with a catch, as in /skills: in tests the build-time MACRO global
 * is absent and registration throws at module load, in which case the
 * listing simply omits them.
 */
async function bundledRegistrySkills(): Promise<readonly SkillListingEntry[]> {
  try {
    const { getBundledSkills } = await import("../../skills/bundledSkills.js");
    return getBundledSkills().flatMap((command): SkillListingEntry[] =>
      command.isEnabled?.() === false
        ? []
        : [{
            name: command.name,
            description: command.description,
            ...(command.whenToUse !== undefined
              ? { whenToUse: command.whenToUse }
              : {}),
            disableModelInvocation: command.disableModelInvocation === true,
            loadedFrom: "bundled",
          }],
    );
  } catch {
    return [];
  }
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
  const known = new Set(skills.map((skill) => skill.name));
  const bundled = (await bundledRegistrySkills()).filter(
    (skill) => !known.has(skill.name),
  );
  const listing = formatSkillListingWithinBudget(
    [...skills, ...bundled],
    opts.contextWindowTokens,
    // What the user just asked for decides which skills get the budget when
    // the installed catalog does not fit.
    opts.userInput,
  );
  if (listing.length === 0) return [];

  return [
    {
      kind: "skill_listing",
      content: listing,
    },
  ];
};
