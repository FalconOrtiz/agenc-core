#!/usr/bin/env bash
# zdh-init.sh — scaffold a zeroday-hunter campaign state directory.
#
# Usage: zdh-init.sh <repo> <bug-class> [max-cost-usd]
#
# Creates .zdh/<campaign-id>/ inside the repo with state files from the plugin
# templates, records the baseline commit, and prints the campaign dir.
set -eu

REPO="${1:?usage: zdh-init.sh <repo> <bug-class> [max-cost-usd]}"
CLASS="${2:?bug class required, e.g. uaf, oob, sqli, idor, race, traversal, deser, logic}"
MAXCOST="${3:-10}"

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$REPO" && pwd)"
slug="$(printf '%s' "$CLASS" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-\|-$//g')"
ID="zdh-$(date +%Y%m%d)-${slug}"
DIR="$REPO/.zdh/$ID"

if [ -e "$DIR" ]; then
  echo "error: $DIR already exists" >&2
  exit 1
fi

mkdir -p "$DIR"/{hypotheses,pocs,crashes,findings,logs}
cp "$PLUGIN_DIR/templates/campaign.yaml" "$DIR/campaign.yaml"
cp "$PLUGIN_DIR/templates/hypothesis.md" "$DIR/hypotheses/_template.md"
cp "$PLUGIN_DIR/templates/finding.md" "$DIR/findings/_template.md"

commit="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo 'no-git')"

# fill campaign.yaml fields (portable sed -i)
sed -i \
  -e "s|  id: \"\"|  id: \"$ID\"|" \
  -e "s|  target_repo: \"\"|  target_repo: \"$REPO\"|" \
  -e "s|  baseline_commit: \"\"|  baseline_commit: \"$commit\"|" \
  -e "s|  bug_class: \"\"|  bug_class: \"$CLASS\"|" \
  -e "s|  max_cost_usd: 10|  max_cost_usd: $MAXCOST|" \
  "$DIR/campaign.yaml"

cat > "$DIR/state.yaml" <<EOF
gate: G0
hypotheses: { raised: 0, promoted: 0, confirmed: 0, rejected: 0, demoted: 0 }
spend_usd: 0
started: "$(date -Iseconds)"
EOF

cat > "$DIR/logs/bad-attempts.md" <<'EOF'
# Bad attempts & FP kills — read before every action, never repeat these.

| ts | gate | attempt/pattern | why it failed |
| --- | --- | --- | --- |
EOF

printf '%s | G0 | init | campaign scaffolded, baseline %s | fill threat model in campaign.yaml\n' \
  "$(date -Iseconds)" "$commit" >> "$DIR/logs/decision.log"

echo "$DIR"
