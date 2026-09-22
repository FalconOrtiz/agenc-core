# Core source publication validation — 2026-09-07

This source snapshot preserves the pending changes in the
`agenc-core-meta-provider` worktree, based on `ba45da9`. It is published on
`publish/core-pending-2026-09-07`, not merged into `main` or released.

## Scope

- Daemon-managed browser Connections, private Telegram agents, and routines,
  including their protocol and SDK contracts.
- Explicit provider authentication selection, model/reasoning capabilities,
  and client-aware system prompts.
- MCP authentication/management, plugin network authority and publisher-key
  rollover, with associated documentation and regression tests.

The interdependent changes are retained as one source snapshot. A test-only
portability correction uses a canonical disposable home path instead of
assuming `/home/user` has identical filesystem spelling on macOS and Linux.

## Checks performed

- Runtime source: `node node_modules/typescript/bin/tsc --noEmit -p runtime/tsconfig.json`.
- Runtime test support: `node node_modules/typescript/bin/tsc --noEmit -p runtime/tsconfig.test-support.json`.
- SDK: `node node_modules/typescript/bin/tsc --noEmit -p packages/agenc-sdk/tsconfig.json`.
- Generated SDK consistency: `node runtime/scripts/check-sdk-generated-types.mjs`.
- All 35 changed test files were selected from the pending tracked/untracked
  file inventory. The ordinary hermetic launcher ran 34 files with
  `run --maxWorkers=2 --reporter=dot`: **783 tests passed**.
- The remaining file belongs to the explicit cross-repository lane:
  `node runtime/scripts/run-hermetic-vitest.mjs run --config vitest.cross-repo.config.ts tests/app-server/protocol.contract.test.ts --maxWorkers=1 --reporter=dot`:
  **12 tests passed**.
- Staged whitespace checks passed. A redacted pattern scan of staged source
  found only two deliberate example-host credential-URL rejection fixtures;
  no identified real credentials or binary payloads were staged.

The `npm run typecheck` wrapper rejected the installed npm 11.19.0 because this
repository pins npm 11.17.0. The underlying local TypeScript checks listed above
were run directly and passed; no package-manager requirement was weakened.

## Boundaries and limitations

This is not full-suite, platform-matrix, live-provider, or release validation.
No normal runtime build or actual-daemon smoke was run: those could replace the
runtime artifacts used by an existing local Core process. Its binary, process,
credentials, sessions, and configuration were not changed by this publication.

Ignored dependencies and generated `dist` directories remain local and are not
published. The credential scan is a heuristic review, not an exhaustive security
audit. Provider-key trust entries in source are public verification keys.

The checked-in workflows run ordinary push tests only on `main`, PR checks on
pull requests, and release/npm/installer jobs only on explicit dispatch. This
feature-branch push creates no PR, tag, merge, package publication, or deployment.

## Pull-request integration

PR #2261 integrates current main `6b6e78e` in a separate worktree while retaining
publication commit `719f2c527f219b0c31d9522faf751558dc03ce69` as ancestry.
The dispatcher conflict retains both the remote/routine typed errors and main's
operation-timeout mapping. Memory extraction retains main's canonical home
resolver and its injected-no-home regression.

Review found a semantic integration issue: main's refreshed-Grok-OAuth factory
could override the publication's explicit API-key selection. The integrated
resolver records that choice in factory options; the factory honors it across
provider recreation without changing automatic OAuth refresh. Two added tests
failed before the fix and pass afterward.

- The integration regression run passed **382 tests in 16 files**, covering the
  dispatcher, agent-create deadlines, background runner, memory extraction,
  provider credentials/OAuth, remote access, and routines.
- All three no-emit TypeScript checks and generated SDK consistency passed.
- Protocol index/schema, routine types, and SDK protocol/routine source bytes
  remain identical to `719f2c5`.
- An initial multi-file run encountered a missing native-helper error in one
  credential fixture. Its isolated rerun and the complete integration rerun
  passed; no native helper was built or installed. Hosted Linux CI remains the
  independent gate, not a claimed result of these local checks.

Only the isolated worktree and feature branch are updated. The original worktree
and running Core remain unchanged; this is not release or deployment evidence.

A subsequent changed-file sweep selected 44 test files from the integrated PR
diff; the default hermetic configuration ran **1,216 tests in 42 files**, all
passing. Configuration-excluded lanes are not included in that count.
SonarCloud then requested an explicit alphabetical comparator for MCP
environment names. That bounded change retains redaction, adds a mixed-case
ordering/redaction regression, and passed all **14 MCP management tests** plus
the three no-emit TypeScript checks. Hosted checks remain pending until their
results appear on the PR.

## Protocol fixture and refreshed-main follow-up

Hosted CI reached an unchanged consumer still treating protocol 1.10 as a future
version. Four consumer fixtures now explicitly expect current 1.10, reject future
1.11 before authentication, and retain the authentication assertions. SDK
downgrade coverage now also includes the older 1.9 daemon. A disposable canonical
SDK home replaces a hard-coded `/tmp` spelling. These checks passed **203 tests
in six files**.

A fresh-main guard then found upstream `d9764469dfe9c168caeeb890386a50725e2ec20f`
(PR #2262). Its shutdown-cleanup and task-settlement fixes were merged without
conflicts, preserving both the publication and current main. Their focused
regressions passed **27 tests in two files**; all three no-emit TypeScript checks
and generated SDK consistency passed. Compared with the previously reviewed
`97d6bcdf3a8735b050f8818168dc77a089d90a68`, production changes are confined to
upstream's daemon CLI, signal handlers, and task lifecycle. Protocol and SDK
mirror bytes are unchanged.

The full affected-test selection is derived from `scripts/run-fast-checks.mjs`
against the refreshed main. The local diagnostic run uses its same 81 runtime
inputs and two-worker cap, removing early bail only to collect failures. It is
not yet a passing full-lane result. A focused CLI/autostart run encountered 27
macOS/native-identity fixture failures; authentication expectations were not
relaxed. Hosted pinned Linux CI remains required. A separate quarantine fixture
keeps each path below macOS PATH_MAX while still asserting the same aggregate
size rejection; its file passed **108 tests with seven existing skips**.

These checks use disposable hermetic state in the isolated integration worktree.
No live Core process, runtime binary, credentials, sessions, or configuration
were changed.

## Credential fallback correction

Hosted CI on `32c47ef` exposed an actual integration regression: a generic
`mode-required` guard intended to block OpenAI/Grok OAuth fallback also blocked
Gemini's explicitly selected API-key mode from reading saved BYOK. The fallback
policy now uses only the OpenAI/Grok selectable preference. Gemini keeps its own
credential-plan rules; access-token and ADC modes still cannot become API-key
mode. Selected OpenAI/Grok OAuth cannot read saved paid keys, and either explicit
selection cannot obtain managed credentials instead.

The new Gemini provenance regression failed before the source fix. Afterward,
the existing bootstrap file passed all **56 tests**, and the expanded credential
authority/Grok factory checks passed **54 tests**. Runtime, test-support, and SDK
no-emit checks plus generated SDK consistency passed. The broad local diagnostic
was stopped before changing source after this hosted failure; it has no complete
or passing result and does not replace hosted CI.

Fresh main subsequently advanced to `16277d7` (PR #2264, atomic task ID/alias
claims). It was merged without conflicts. Its identifier tests and the preceding
task-settlement/signal-cleanup regressions passed **45 tests in three files**.
The original publication remains ancestry and protocol/SDK mirror bytes remain
unchanged. Hosted checks must pass again on the final integrated head.

## Canonical-home and task-generation follow-up

Hosted CI on `27ec5ef` reached the canonical-home architecture guard. The MCP
OAuth provider now checks the captured `HomeContext.source`, not a direct
environment read. Missing, empty, and whitespace-only bindings are rejected;
an explicitly configured canonical default home remains valid. The whitespace
case failed before the correction. The focused home/auth, architecture,
environment-documentation, model-catalog, and MCP-migration checks passed
**41 tests in five files**. Catalog fixtures now retain exact order and the
distinct reasoning levels of legacy versus newly registered models. MCP
migration fixtures preserve valid OAuth options and continue rejecting unknown
nested authority; their rejection and rollback assertions were not removed.

Independent review also reproduced two races in main's newly reusable task
IDs: an old asynchronous stop could kill a replacement, and an old unsubscribe
could remove a replacement's identical listener. Five new primary/alias,
cleanup-success/failure, and subscription cases failed before the fix. Stop
settlement is now fenced by the original record identity, and listener cleanup
is bound to its original set. A stale successful stop reports `not_found` rather
than claiming it stopped the replacement; cleanup errors retain `stop_failed`.
The three focused lifecycle files passed **52 tests**. Runtime, test-support,
and SDK no-emit checks and generated SDK consistency passed again.

The broad local related-test run is diagnostic only: it has macOS/native/PTY
failures and spanned working-tree edits while investigating blockers. It is not
passing exact-head evidence. Hosted pinned Linux checks remain required before
merge. No live runtime, credentials, sessions, or configuration were changed.

## Subsequent main integration

Exact head `7ee586d` passed hosted PR CI: **1,597 tests in 54 files**, then
**17,667 tests in 1,677 files**, with both Sonar checks passing. The pre-merge
ancestry guard nevertheless stopped the merge because main had advanced to
`ba495de` through completed-event retention (#2266) and dynamic TUI command
snapshot invalidation (#2267). These changes were integrated without conflicts.

The incoming cache, background-runner ordering, SDK event mapping, and TUI render
regressions passed **153 tests in four files**. All three no-emit TypeScript
checks and generated SDK consistency passed again. The protocol and SDK event
contract now add optional `retiredCountKnown` for a cache-miss replay gap whose
loss count is unknown; downstream source pins and protocol mirrors must account
for this addition. No workflow, dependency lock, or build-script input changed.
Hosted CI and review must pass again on the refreshed integrated head.
