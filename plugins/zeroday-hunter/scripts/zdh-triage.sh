#!/usr/bin/env bash
# zdh-triage.sh — dedup and cluster sanitizer crashes by (signal, top frame).
#
# Usage: zdh-triage.sh <crash-dir>
#
# Scans logs for ASan/MSan/UBSan reports, extracts the bug signal and the top
# in-project stack frame, and prints clusters sorted by count. Answer the
# triage question per cluster BEFORE promoting: bug in the harness, or bug in
# the project? (see references/fp-patterns.md)
set -eu

DIR="${1:?usage: zdh-triage.sh <crash-dir>}"

found=0
tmp="$(mktemp -t zdh-triage.XXXXXX)"
trap 'rm -f "$tmp"' EXIT

for f in "$DIR"/*; do
  [ -f "$f" ] || continue
  sig="$(grep -Eo '(ERROR|SUMMARY): (Address|Memory|Leak)?Sanitizer: [a-zA-Z-]+|runtime error: [a-zA-Z -]+' "$f" | head -1 || true)"
  [ -z "$sig" ] && continue
  found=1
  # top frame: first '#N ... in <func>' or 'at <func>(' line
  top="$(grep -Eo '#[0-9]+ [^ ]* in [A-Za-z_][A-Za-z0-9_:]*' "$f" | head -1 | awk '{print $NF}')"
  [ -z "$top" ] && top="$(grep -Eo 'at [A-Za-z_][A-Za-z0-9_:]*\(' "$f" | head -1 | sed 's/^at //; s/($//')"
  printf '%s\t%s\t%s\n' "$sig" "${top:-unknown}" "$(basename "$f")" >> "$tmp"
done

if [ "$found" = "0" ]; then
  echo "no sanitizer reports found in $DIR"
  exit 1
fi

echo "count | signal | top-frame | example"
sort "$tmp" | awk -F'\t' '{ key=$1"\t"$2; cnt[key]++; ex[key]=ex[key]==""?$3:ex[key] }
  END { for (k in cnt) printf "%d\t%s\t%s\n", cnt[k], k, ex[k] }' \
  | sort -rn | column -t -s $'\t'

echo "---"
echo "next: for each cluster answer — bug in the harness, or bug in the project? — then zdh-init a hypothesis record."
