# zeroday-hunter

Exploit-first 0-day hunting plugin for AgenC: a campaign state machine with
quantitative gates, a planner→dispatcher→expert-agent hierarchy, deterministic PoC
verification, independent-model falsification, variant-as-query sweeps, watch mode for
commit deltas, and hashed evidence export.

Built from published methodologies: Project Zero/DeepMind Big Sleep, Sean Heelan's o3
workflow (CVE-2025-37899), DARPA AIxCC winners (buttercup / atlantis / artiphishell),
XBOW, oss-fuzz-gen, HPTSA, OpenAI Aardvark, CodeQL variant analysis, CyberGym, EnIGMA,
CAI/PentestGPT, Fuzz4All/ChatAFL. Full citations and the statistics behind each rule:
`skills/zeroday-hunter/references/methodology-sources.md`.

## Install

```bash
agenc plugin install ./plugins/zeroday-hunter --scope user
# or from a clone: agenc plugin install /path/to/agenc-core/plugins/zeroday-hunter
```

## What the skill makes the agent do

- Runs **campaigns, not reviews**: `G0 FRAME → G1 MAP → G2 AUDIT → G3 PROVE → G4 FALSIFY
  → G5 REPORT`, each gate with on-disk artifacts and explicit exit criteria.
- A finding exists only when a **deterministic verifier** exits 0 (sanitizer crash,
  response diff, observed auth bypass) **and** an independent reviewer model fails to
  falsify it. Everything else is labeled HYPOTHESIS.
- One bug class per campaign; slices ≤ ~10k LoC; mandatory per-conditional attacker-
  control walkthroughs; pass@k independent audits on high-value slices; hard iteration
  caps with logged abandon criteria.
- Confirmed bugs are codified as **variant queries** (`.zdh/queries/`) that run
  repo-wide and double as regression tests for the fix.
- **Watch mode** audits only `baseline..HEAD` against the stored threat model — cheap
  continuous delta auditing instead of full rescans.

## Layout

| Path | Purpose |
| --- | --- |
| `skills/zeroday-hunter/SKILL.md` | doctrine + state machine + quantitative gates |
| `skills/zeroday-hunter/references/` | campaign manual, 10 bug-class playbooks, exploit-primitive ladder, FP library, toolchain recipes, methodology sources |
| `templates/` | `campaign.yaml`, hypothesis record, finding report |
| `scripts/zdh-init.sh` | scaffold a campaign state directory (`.zdh/<id>/`) |
| `scripts/zdh-slice.sh` | budget-capped call-graph slice around an entry symbol |
| `scripts/zdh-triage.sh` | dedup/cluster sanitizer crashes by (signal, top frame) |
| `scripts/zdh-watch.sh` | delta-audit scaffolder (baseline..HEAD, sink-touching hunks) |
| `scripts/zdh-variant.sh` | codify a confirmed pattern as a semgrep/grep query, run repo-wide |
| `scripts/poc-check.sh` | deterministic PoC verifier (signal regex, timeout, expect-exit) |
| `scripts/campaign.sh` | launch via the AgenC daemon: `single` (verified run + reviewer model + evidence) or `swarm` (one background agent per bug class) |

## Field-tested

Validated end-to-end against the `minilang` demo parser: found and **confirmed an
uncontrolled-recursion stack-exhaustion DoS** (CWE-674) — ASan-verified PoC
(parens/blocks/unary shapes), crash reproduced on a release build, fixed by a depth-cap
patch that makes the same PoC fail gracefully (crash pre-patch / clean post-patch).

## Scope guard

For codebases you own or are explicitly authorized to test. PoCs run only inside
sandboxed worktrees. The skill instructs the agent to refuse third-party targeting.
