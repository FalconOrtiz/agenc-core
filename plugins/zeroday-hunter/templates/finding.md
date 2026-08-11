---
id: F-000
status: CONFIRMED        # CONFIRMED | HYPOTHESIS
bug_class: ""
primitive_rung: 0        # 0-7, see exploit-primitives.md — the rung actually demonstrated
campaign: ""
baseline_commit: ""
---

# <bug class> in <component>: <one-line root cause>

## Summary
2-3 sentences: the root cause, not the symptoms.

## Entry → Sink
`file:line` → `file:line`, with the essential path.

## Attacker control
Per walkthrough step — what the attacker controls and how each branch is satisfied.

## Evidence
- Verifier: `<exact command>` → exit 0, signal `<deterministic signal>`
- Primitive demonstrated: rung N (see exploit-primitives.md); mitigations observed: ...
- AgenC run: `<run-id>` (hashed evidence attached: `agenc run evidence <run-id>`)
- Reproduction: exact steps + environment (commit, build flags, config)

## Impact
Ceiling (RCE / infoleak / authz bypass / DoS) and the honest prerequisites.

## Severity rationale
Reachability × impact; mitigations; what blocks the next primitive rung if not at 7.

## Variants found
Sibling issues from the sweep (with their own status).

## Remediation
Minimal fix + the regression test that proves it (the PoC must fail post-fix).
