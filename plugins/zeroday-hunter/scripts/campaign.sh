#!/usr/bin/env bash
# campaign.sh — launch zeroday-hunter campaigns through the AgenC daemon.
#
# Modes:
#   campaign.sh single <repo> <goal-file> <verify-cmd> [max-cost] [reviewer-model]
#       One verified run: PoC verifier as hard admission gate (--verify),
#       independent reviewer model for falsification (--reviewer-model),
#       hashed evidence exported at the end.
#
#   campaign.sh swarm <repo> <class1,class2,...> [max-cost-per-agent]
#       One zdh campaign + one background auditor agent per bug class, each
#       read-mostly, writing into its own .zdh/<id>/ state dir.
#
# Examples:
#   campaign.sh single ~/src/app goals/uaf.md \
#     "poc=./poc-check.sh --signal 'heap-use-after-free' -- ./poc" 5 anthropic:claude-sonnet-4-5
#   campaign.sh swarm ~/src/app uaf,oob,race 5
set -eu

MODE="${1:?usage: campaign.sh <single|swarm> ...}"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shift

case "$MODE" in

single)
  REPO="${1:?repo dir}"; GOAL="${2:?goal file}"
  VERIFY="${3:?verify cmd, e.g. poc=./poc-check.sh ... -- ./poc}"
  MAXCOST="${4:-5}"; REVIEWER="${5:-}"
  args=(run start --cwd "$REPO" --goal-file "$GOAL" --max-cost "$MAXCOST" --verify "$VERIFY" --follow)
  [ -n "$REVIEWER" ] && args+=(--reviewer-model "$REVIEWER")
  echo "campaign[single]: repo=$REPO max-cost=\$$MAXCOST reviewer=${REVIEWER:-none}"
  out="$(agenc "${args[@]}")"; echo "$out"
  run_id="$(printf '%s\n' "$out" | grep -Eo 'run[_-][A-Za-z0-9]+' | head -1 || true)"
  if [ -n "$run_id" ]; then
    agenc run status "$run_id" || true
    echo "--- hashed evidence ---"
    agenc run evidence "$run_id" || true
  else
    echo "warning: run id not parsed; export manually: agenc run evidence <run-id>" >&2
  fi
  ;;

swarm)
  REPO="${1:?repo dir}"; CLASSES="${2:?comma-separated bug classes}"
  MAXCOST="${3:-5}"
  IFS=',' read -ra cls <<< "$CLASSES"
  echo "campaign[swarm]: repo=$REPO classes=${#cls[@]} max-cost/agent=\$$MAXCOST"
  for c in "${cls[@]}"; do
    c="$(echo "$c" | tr -d ' ')"
    dir="$("$PLUGIN_DIR/scripts/zdh-init.sh" "$REPO" "$c" "$MAXCOST")"
    id="$(basename "$dir")"
    echo "--- $c → $id"
    agenc agent start \
      --unattended-allow read,grep,glob,bash \
      "zeroday-hunter campaign $id in $REPO, bug class: $c. You are the AUDITOR for this class only. Read $dir/campaign.yaml and $dir/logs/bad-attempts.md first. Follow the zeroday-hunter skill state machine: fill the threat model, build surface.md (G1), audit slices (G2) writing hypothesis records under $dir/hypotheses/, and stop at G3 boundaries — PoC execution beyond read-only probes requires the coordinator. Append every action to $dir/logs/decision.log. Abandon criteria: see campaign.yaml. Report hypothesis count and top scores when done." \
      || echo "warning: agent start failed for class $c" >&2
  done
  echo "swarm launched. Track: agenc agent list / agenc agent logs <id>"
  ;;

*)
  echo "unknown mode: $MODE (single|swarm)" >&2
  exit 2
  ;;
esac
