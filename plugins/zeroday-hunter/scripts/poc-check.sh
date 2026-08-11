#!/usr/bin/env bash
# poc-check.sh — deterministic PoC verifier for zeroday-hunter campaigns.
#
# A finding is CONFIRMED only when this script exits 0. It runs a command and
# greps its output for a deterministic signal (ASan report, assertion, canary
# string, expected response marker). Never edit this script to make a PoC pass.
#
# Usage:
#   poc-check.sh --signal <regex> [--timeout <secs>] [--expect-exit <n>] -- <command...>
#
# Examples:
#   poc-check.sh --signal 'ERROR: AddressSanitizer' -- ./target ./poc.bin
#   poc-check.sh --signal 'PWNED' --timeout 10 -- python3 gen_payload.py \| nc 127.0.0.1 4444
set -u

SIGNAL=""
TIMEOUT=30
EXPECT_EXIT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --signal) SIGNAL="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --expect-exit) EXPECT_EXIT="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$SIGNAL" ] || [ $# -eq 0 ]; then
  echo "usage: poc-check.sh --signal <regex> [--timeout s] [--expect-exit n] -- <command...>" >&2
  exit 2
fi

LOG="$(mktemp -t poc-check.XXXXXX.log)"
trap 'rm -f "$LOG"' EXIT

timeout "$TIMEOUT" "$@" >"$LOG" 2>&1
rc=$?

confirmed=0
if grep -Eq "$SIGNAL" "$LOG"; then
  confirmed=1
fi
if [ -n "$EXPECT_EXIT" ] && [ "$rc" != "$EXPECT_EXIT" ]; then
  confirmed=0
fi
# timeout(1) returns 124 on expiry — a hang is not a crash
if [ "$rc" = "124" ]; then
  confirmed=0
  echo "NOTE: command timed out after ${TIMEOUT}s" >&2
fi

if [ "$confirmed" = "1" ]; then
  echo "CONFIRMED: signal /$SIGNAL/ observed (exit=$rc)"
  exit 0
fi

echo "NOT-REPRODUCED: signal /$SIGNAL/ absent (exit=$rc)"
exit 1
