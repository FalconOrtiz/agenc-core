---
id: H-000
bug_class: ""
status: draft            # draft | promoted | demoted | confirmed | rejected
score: 0                 # reachability(0-3) x control(0-3) x impact(0-3) - effort(0-2)
slice: ""                # entry symbol + depth used
pass_at_k: 1             # independent runs that found this (k total in notes)
---

# H-000 — <one-line claim>

## Entry → Sink
`file:line` entry point → `file:line` dangerous operation. Data flow in 1-3 lines.

## Threat model fit
Why this path is reachable by the attacker defined in campaign.yaml.

## Mandatory walkthrough
Step-by-step path from entry to sink. For EVERY conditional on the path:
how the attacker concretely controls its outcome.

| Step | Location | Condition | Attacker control |
| --- | --- | --- | --- |
| 1 |  |  |  |

## Missing definitions fetched
Functions/types retrieved during the audit (never assumed).

## FP library check
Patterns from fp-patterns.md evaluated, and why each does not apply.

## PoC plan
Generator approach + verifier signal (must be intrinsic to the bug).

## Failure log (G3 iterations)
| Attempt | Mutation tried | Verifier result | Failure class |
| --- | --- | --- | --- |

## Falsification (G4)
Reviewer model + verdict + the broken link found (or "none found").

## Variants
Sibling hypotheses spawned after confirmation.
