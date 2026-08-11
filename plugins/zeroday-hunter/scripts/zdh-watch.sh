#!/usr/bin/env bash
# zdh-watch.sh — delta-audit scaffolder (watch mode).
#
# Diffs baseline..HEAD and keeps only hunks touching security-relevant code
# (sinks, entry points, auth logic). Emits a focused G2 goal file so the audit
# covers the delta against the existing threat model — not the whole repo.
#
# Usage: zdh-watch.sh <repo> <baseline-commit> [sink-regex]
set -eu

REPO="${1:?usage: zdh-watch.sh <repo> <baseline-commit> [sink-regex]}"
BASE="${2:?baseline commit required}"
SINK_RE="${3:-memcpy|memmove|strcpy|strcat|sprintf|vsprintf|gets|free\(|delete |exec[lv]|system\(|popen|eval\(|exec\.|\.query|SELECT |INSERT |UPDATE |DELETE FROM|password|passwd|token|secret|auth|session|permission|role|privilege|decrypt|verify|signature|deserialize|unserialize|pickle|yaml\.load|ObjectInputStream|open\(|readFile|sendFile|writeFile|include\(|require\(|redirect|ssrf|fetch\(|http\.get}"

REPO="$(cd "$REPO" && pwd)"
HEAD="$(git -C "$REPO" rev-parse HEAD)"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$REPO/.zdh/watch-$TS"
mkdir -p "$OUT"

changed="$(git -C "$REPO" diff --name-only "$BASE..$HEAD" || true)"
if [ -z "$changed" ]; then
  echo "no changes between $BASE and $HEAD — nothing to audit"
  exit 0
fi

# hunks touching security-relevant lines (added or context)
git -C "$REPO" diff -U3 "$BASE..$HEAD" > "$OUT/full.diff"
grep -nE "^\+.*($SINK_RE)" "$OUT/full.diff" > "$OUT/sink-hits.txt" || true

nfiles=$(printf '%s\n' "$changed" | wc -l)
nhits=$(wc -l < "$OUT/sink-hits.txt")

{
  echo "# Watch-mode audit goal — $TS"
  echo
  echo "baseline: $BASE"
  echo "head:     $HEAD"
  echo "changed files: $nfiles — sink-touching added lines: $nhits"
  echo
  echo "## Changed files"
  printf '%s\n' "$changed" | sed 's/^/- /'
  echo
  echo "## Sink-touching additions (audit these hunks against the threat model)"
  echo '```'
  cat "$OUT/sink-hits.txt"
  echo '```'
  echo
  echo "## Instructions"
  echo "Run zeroday-hunter G2–G4 on the slices reachable from these hunks only."
  echo "Re-run stored .zdh/*/queries/ against this diff (incomplete patches, reintroduced patterns)."
  echo "If a hunk is security-irrelevant, say so in the decision log and skip it."
} > "$OUT/goal.md"

if [ "$nhits" -eq 0 ]; then
  echo "watch: $nfiles files changed, 0 security-relevant hunks → no-op. Goal: $OUT/goal.md"
else
  echo "watch: $nfiles files changed, $nhits sink-touching additions → audit goal: $OUT/goal.md"
fi
