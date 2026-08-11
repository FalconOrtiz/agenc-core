# Campaign manual

The full operating procedure behind the SKILL.md state machine. Read this at G0 and
consult it at every gate.

## State directory layout

Created by `scripts/zdh-init.sh <repo> <bug-class>`:

```
.zdh/<campaign-id>/
├── campaign.yaml        # config: bug class, scope, budgets, caps (template provided)
├── state.yaml           # machine-readable: gate, hypothesis counts, spend
├── surface.md           # G1 output: attack surface inventory
├── hypotheses/H-NNN.md  # G2 output: one file per hypothesis
├── pocs/H-NNN/          # G3: generator + verifier + build artifacts per hypothesis
├── crashes/             # raw crash logs, triaged by zdh-triage.sh — incl. OFF-TARGET ones
├── queries/             # variant rules codified from confirmed findings (zdh-variant.sh)
├── findings/F-NNN.md    # G5: confirmed findings, report-contract format
├── logs/
│   ├── decision.log     # one line per step: ts | gate | action | result | next
│   └── bad-attempts.md  # approaches that failed — never repeat these
└── memory-note.md       # what goes to persistent memory at G5
```

Rules: every agent reads `campaign.yaml` + `bad-attempts.md` before acting and appends
to `decision.log` after acting. Two agents never own the same file; the coordinator
merges `surface-*.md` into `surface.md`.

## G0 FRAME

Write down, in `campaign.yaml` and in prose at the top of `surface.md`:

- **Attacker**: unauthenticated remote? authenticated user? local process? two concurrent
  connections? malicious file?
- **Control surface**: which bytes/requests/files the attacker fully controls.
- **Impact ceiling**: RCE > infoleak > authz bypass > DoS. This calibrates scoring.
- **Baseline commit**: `git rev-parse HEAD`. Everything is audited relative to this.
- **Scope fences**: directories in scope (server, parsers, auth) vs out (tests, vendor,
  generated code — unless vendor is the target).
- **Abandon criteria** for the campaign, declared now, not later.

## G1 MAP

Produce `surface.md` with four inventories:

1. **Entry points** — network handlers, file/parsers, IPC/RPC, CLI/env, deserializers,
   auth middleware, template rendering, webhook/callback handlers. For each: file:line,
   input format, trust boundary crossed.
2. **Sinks for this campaign's bug class** — from the playbook table, extended by grep:
   `grep -rnE '<sink-pattern>' --include='*.<ext>'` over in-scope dirs. Every sink gets a
   line: `sink | file:line | reaching entry | notes`.
3. **Coverage gaps** — functions far from tests/fuzzers: compare `surface.md` entries
   against test dirs and existing fuzz harnesses. Uncovered + reachable + dangerous =
   priority.
4. **Git security history** — `git log --oneline --grep='fix\|security\|CVE\|overflow\|
   injection\|auth'` and `git log -p -S '<sink>'` on suspicious files. Every past fix is a
   variant-analysis seed: write the fix commit + diff into a hypothesis candidate
   immediately ("this was a bug; check for siblings *now*").

Score every sink (reachability × control × impact − effort) and rank. Sinks below
promotion threshold go to the backlog **with a one-line reason** — silence is not
coverage.

## G2 AUDIT

Per promoted slice:

1. Extract the slice: `scripts/zdh-slice.sh <repo> <entry-symbol> [depth=3]`. If the
   output exceeds the line budget, narrow to a deeper entry point — never enlarge context.
2. Read the playbook for the bug class end-to-end before auditing.
3. For each candidate path, create `hypotheses/H-NNN.md` from the template and fill the
   walkthrough: every conditional on the path, attacker control per branch, sources and
   sanitizers encountered. Fetch every missing definition — assumption = demotion.
4. Run the FP patterns checklist. Log kills in `decision.log`.
5. Score. Promote top-K (default K=5 per campaign wave) to G3.

High-value slices get pass@k: spawn k independent auditor agents, each with fresh
context and no access to each other's notes. Intersection of independent findings is the
strongest pre-PoC signal that exists.

## G3 PROVE

Per promoted hypothesis, in a sandboxed worktree:

1. **Build**: memory-unsafe → ASan/UBSan build (toolchain recipes). Web/service → run it
   locally with the real config, not a mock.
2. **Generator**: `pocs/H-NNN/gen_payload.py` computing all structural fields. Raw blobs
   are forbidden — they don't survive format nesting and can't be mutated on failure.
3. **Verifier**: `pocs/H-NNN/verify.sh` wrapping `poc-check.sh` with the deterministic
   signal for this bug class (ASan banner, canary in response, row count diff, 200-vs-403
   oracle, JS-execution marker). The signal must be *intrinsic to the bug*, not to your
   logging.
4. Iterate ≤ 5 failed runs. Each failure: record the failure mode class (wrong reach
   path / wrong condition / wrong format / target fixed) in the hypothesis record.
   Failure class decides the next mutation — not vibes.
5. Harness crash? Triage question: **bug in the harness/generator, or bug in the
   project?** Answer True/False with evidence before touching anything.

## G4 FALSIFY

- Assemble the falsification packet: slice files, hypothesis record, PoC, verifier
  output. Hand to the reviewer model (different provider) with the brief: *"This claim
  is false. Find the broken link: unreachable path, uncontrollable branch, sanitizer you
  missed, mitigation already present."*
- Reviewer verdicts: CONFIRMED (no broken link found) or REJECTED (with the exact broken
  link). REJECTED → record the falsification note in memory; it is a permanent FP filter.
- **Variant sweep**: for CONFIRMED bugs, enumerate every sibling (same sink/pattern,
  other entries, other modules) as new hypotheses and run G2–G4 on the top scorers.

## G5 REPORT

- One `findings/F-NNN.md` per confirmed bug, report contract, evidence id attached.
- Codify each confirmed pattern as a query (`zdh-variant.sh`) in `queries/` and run it
  repo-wide — every hit becomes a pre-scored hypothesis; the query is also the fix's
  regression test.
- Campaign summary: sinks reviewed / total, hypotheses raised / promoted / confirmed,
  dead ends with reasons, FP patterns observed, spend vs budget.
- `memory-note.md` → persistent memory: baseline commit, threat model, confirmations,
  query paths, FP list, dead ends. This is what makes campaign N+1 a diff-audit instead
  of a re-audit.

## WATCH MODE (continuous delta auditing)

After any campaign, the threat model + baseline turn every later audit into a cheap
delta check instead of a full rescan (Aardvark-style commit scanning):

1. `scripts/zdh-watch.sh <repo> <baseline-commit> [sink-regex]` — diffs baseline..HEAD,
   keeps only hunks touching sinks/entries/auth checks, writes a focused goal file.
2. If the diff touches nothing security-relevant: record "no-op" in the decision log and
   stop. Most commits are no-ops; saying so quickly is the point.
3. Otherwise run G2–G4 on the changed slices only, with the existing threat model.
4. Also re-run the stored `queries/` against the diff — incomplete patches and
   reintroduced patterns are the most common watch-mode catches.
5. Update the baseline commit at the end.

## Coordinator checklist (run at every gate transition)

- [ ] All produced artifacts exist on disk (not in chat)
- [ ] `decision.log` is current
- [ ] Budget consumed vs split (15/45/30/10) — rebalance or stop
- [ ] Abandon criteria checked — met? stop and record why
- [ ] Next gate's entry criteria met — if not, say what's missing instead of proceeding
