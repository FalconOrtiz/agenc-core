#!/usr/bin/env bash
# zdh-variant.sh — codify a confirmed pattern as a reusable query and run it repo-wide.
#
# Turns one confirmed bug into a permanent detector (variant analysis):
# writes a semgrep rule into .zdh/queries/ and runs it; falls back to grep when
# semgrep is unavailable. Every hit is a pre-scored hypothesis; the rule doubles
# as the regression test for the fix.
#
# Usage: zdh-variant.sh <repo> <name> <pattern-regex> [message]
# Example:
#   zdh-variant.sh . strlen-memcpy 'memcpy\s*\([^;]*strlen\s*\(' \
#     "memcpy sized by strlen(source) — classic off-by-one/overflow"
# Note: pattern-regex is line-based (no nested-paren matching); prefer simple,
# high-signal shapes over precise ones — triage does the filtering.
set -eu

REPO="${1:?usage: zdh-variant.sh <repo> <name> <pattern-regex> [message]}"
NAME="${2:?rule name required}"
REGEX="${3:?pattern regex required}"
MSG="${4:-variant of a confirmed pattern — audit me}"

REPO="$(cd "$REPO" && pwd)"
QDIR="$REPO/.zdh/queries"
mkdir -p "$QDIR"
RULE="$QDIR/$NAME.yml"

cat > "$RULE" <<EOF
rules:
  - id: zdh-$NAME
    languages: [generic]
    message: "$MSG"
    severity: WARNING
    pattern-regex: '$REGEX'
    metadata:
      source: zeroday-hunter variant-as-query
      created: $(date -Iseconds)
EOF

echo "rule written: $RULE"

if command -v semgrep >/dev/null 2>&1; then
  echo "--- semgrep scan ---"
  semgrep --config "$RULE" --quiet "$REPO" || true
else
  echo "--- semgrep not found, grep fallback ---"
  grep -rnE "$REGEX" "$REPO" \
    --include='*.c' --include='*.h' --include='*.cc' --include='*.cpp' \
    --include='*.go' --include='*.js' --include='*.ts' --include='*.py' \
    --include='*.java' --include='*.rb' --include='*.php' --include='*.rs' \
    2>/dev/null | grep -v '/\.zdh/' || echo "no hits"
fi
