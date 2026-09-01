# Reported bugs

- Durable checkpoint prefix rejects writer `compactionHistory` (`RESPONSE_ITEM_KEYS`) — https://github.com/tetsuo-ai/agenc-core/pull/1960 — open — 2026-09-01
- Agent validation refusals (`close_agent` / `assign_task` / `send_message`) still used bare `isError` after the live effect boundary — https://github.com/tetsuo-ai/agenc-core/pull/1976 — open — 2026-09-01
- `updatePluginOp` / plugin update CLI printed the live credential URL after install stored `sourceRedacted` — https://github.com/tetsuo-ai/agenc-core/pull/1977 — open — 2026-09-01
- Gateway cron `tick()` consumed one-shot tasks after `fireTask` throw or admission pause — https://github.com/tetsuo-ai/agenc-core/pull/1855 — rejected — 2026-08-31
