import type { RenderableMessage } from '../../types/message.js';
import { type buildMessageLookups, getToolUseID, hasUnresolvedHooksFromLookup } from '../../utils/messages.js';
import { every } from '../../utils/set.js';
import type { Screen } from '../types/screen.js';

export function shouldRenderStatically(message: RenderableMessage, streamingToolUseIDs: Set<string>, inProgressToolUseIDs: Set<string>, siblingToolUseIDs: ReadonlySet<string>, screen: Screen, lookups: ReturnType<typeof buildMessageLookups>): boolean {
  if (screen === 'transcript') {
    return true;
  }
  switch (message.type) {
    case 'attachment':
    case 'user':
    case 'assistant':
      {
        if (message.type === 'assistant') {
          const block = message.message.content[0];
          if (block?.type === 'server_tool_use') {
            return lookups.resolvedToolUseIDs.has(block.id);
          }
        }
        const toolUseID = getToolUseID(message);
        if (!toolUseID) {
          return true;
        }
        if (streamingToolUseIDs.has(toolUseID)) {
          return false;
        }
        if (inProgressToolUseIDs.has(toolUseID)) {
          return false;
        }

        // Check if there are any unresolved PostToolUse hooks for this tool use
        // If so, keep the message transient so the HookProgressMessage can update
        if (hasUnresolvedHooksFromLookup(toolUseID, 'PostToolUse', lookups)) {
          return false;
        }
        return every(siblingToolUseIDs, lookups.resolvedToolUseIDs);
      }
    case 'system':
      {
        // api errors always render dynamically, since we hide
        // them as soon as we see another non-error message.
        return message.subtype !== 'api_error';
      }
    case 'grouped_tool_use':
      {
        const allResolved = message.messages.every((msg: any) => {
          const content = msg.message.content[0];
          return content?.type === 'tool_use' && lookups.resolvedToolUseIDs.has(content.id);
        });
        return allResolved;
      }
    case 'collapsed_read_search':
      {
        // In prompt mode, never mark as static to prevent flicker between API turns
        // (In transcript mode, we already returned true at the top of this function)
        return false;
      }
  }
  return true;
}
