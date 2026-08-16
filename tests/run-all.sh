#!/usr/bin/env bash
# Runs every suite. 2026-08-16: these lived in a session scratchpad and would have
# vanished with it -- eleven suites of real regression coverage, gone. Moved here so
# they survive, and so CI can run them.
set -u
cd "$(dirname "$0")/.."
python3 build/build.py >/dev/null || { echo "build FAILED"; exit 1; }
fail=0
for t in tests/test-*.js; do
  printf "%-28s " "$(basename "$t" .js)"
  out="$(node "$t" 2>&1)"
  if printf '%s' "$out" | grep -q "All checks passed"; then echo "ok"
  else echo "FAILED"; printf '%s\n' "$out" | grep -E "FAIL" | head -5; fail=1; fi
done
[ "$fail" -eq 0 ] && echo "All suites passed." || echo "Some suites FAILED."
exit "$fail"
