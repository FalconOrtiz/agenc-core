# Reported bugs

- Checkpoint prefix rejects writer-emitted `compactionHistory` (`RESPONSE_ITEM_KEYS` / prefix hash) — https://github.com/tetsuo-ai/agenc-core/pull/1960 — open — 2026-09-01
- Mid-turn / pre-sampling compact skip emits run-fatal `error` and bricks keep-alive daemon sessions — https://github.com/tetsuo-ai/agenc-core/pull/1949 — open — 2026-09-01
- Gateway cron `tick()` consumed one-shot tasks after `fireTask` throw or admission pause — https://github.com/tetsuo-ai/agenc-core/pull/1855 — rejected — 2026-08-31
