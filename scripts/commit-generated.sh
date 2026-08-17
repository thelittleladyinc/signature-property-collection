#!/usr/bin/env bash
#
# Commit a regenerated data file plus the site/ it produces, and survive losing a
# race to the other generator.
#
# WHY THIS EXISTS (2026-08-17). Two scheduled workflows now write to master:
# town-market.yml (Mondays and Thursdays) and geocode-towns.yml (on demand).
# Both regenerate a file in build/data/, both rebuild all of site/, and both
# commit. The first time they overlapped, geocode-towns did everything right --
# fetched 36 real coordinates from Google, rebuilt 37 town pages, passed all 26
# suites, committed -- and then died on:
#
#     ! [rejected]  master -> master (fetch first)
#
# because town-market had pushed one second earlier. A full run's work, and
# 36 paid API calls, thrown away by a lost race. town-market is on a cron, so
# this recurs on its own without anyone triggering anything.
#
# WHY NOT `git pull --rebase`. Because both jobs regenerate the ENTIRE site/
# directory, a rebase replays ~150 rewritten HTML files onto ~150 other
# rewritten HTML files and conflicts on every page both runs touched. Resolving
# generated files by hand is exactly the thing to never do.
#
# WHAT THIS DOES INSTEAD. site/ is a pure function of build/data/ -- build.py is
# deterministic and offline by design. So on a rejected push we keep only the
# freshly generated DATA, take the new master wholesale, and rebuild. The
# rebuild reconciles both jobs' data by construction, and a conflict is not
# possible because nothing is being merged.
#
# USAGE
#   scripts/commit-generated.sh <subject> <body> <data-file> [<data-file> ...]

set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <subject> <body> <data-file> [<data-file> ...]" >&2
  exit 2
fi

SUBJECT="$1"
BODY="$2"
shift 2
DATA_FILES=("$@")

# Number of times to rebuild onto a moved master before giving up. Four is
# generous: two writers that each take ~30s cannot realistically beat this.
ATTEMPTS=4

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

run_suites() {
  # The pre-commit verification in each workflow ran against the PRE-rebase
  # content. After rebuilding onto a moved master the output is different, so it
  # gets verified again rather than trusted.
  local t
  for t in tests/test-*.js; do
    if ! node "$t" >/dev/null 2>&1; then
      echo "::error::$t fails after rebuilding onto the updated master. Nothing pushed."
      node "$t" || true
      return 1
    fi
  done
  echo "  all suites pass against the rebuilt tree"
}

if git diff --quiet -- "${DATA_FILES[@]}" site && \
   [ -z "$(git ls-files --others --exclude-standard -- "${DATA_FILES[@]}" site)" ]; then
  echo "Nothing changed — nothing to commit."
  exit 0
fi

for attempt in $(seq 1 "$ATTEMPTS"); do
  git add -- "${DATA_FILES[@]}" site

  if git diff --cached --quiet; then
    echo "Nothing staged on attempt $attempt — another run already published this exact content."
    exit 0
  fi

  git commit -q -m "$SUBJECT" -m "$BODY"

  if git push -q origin HEAD:master 2>/dev/null; then
    echo "Pushed on attempt $attempt."
    exit 0
  fi

  echo "Attempt $attempt: push rejected — another job reached master first."
  echo "  Keeping the regenerated data, taking the new master, and rebuilding."

  # Preserve only what this run actually generated. Everything else comes from
  # the updated master; site/ is then reproduced from the union of both.
  tmp="$(mktemp -d)"
  for f in "${DATA_FILES[@]}"; do
    if [ -e "$f" ]; then
      mkdir -p "$tmp/$(dirname "$f")"
      cp "$f" "$tmp/$f"
    fi
  done

  git fetch -q origin master
  git reset -q --hard origin/master

  for f in "${DATA_FILES[@]}"; do
    [ -e "$tmp/$f" ] && cp "$tmp/$f" "$f"
  done
  rm -rf "$tmp"

  python3 build/build.py >/dev/null
  run_suites || exit 1

  if git diff --quiet -- "${DATA_FILES[@]}" site && \
     [ -z "$(git ls-files --others --exclude-standard -- "${DATA_FILES[@]}" site)" ]; then
    echo "After rebuilding onto the new master there is nothing left to change — the"
    echo "other job's push already produced identical output. Done."
    exit 0
  fi
done

echo "::error::Could not push after $ATTEMPTS attempts. master is moving faster than"
echo "::error::this job can rebuild. The generated data was NOT published; re-run this"
echo "::error::workflow. Nothing is broken — the pages keep their previous values."
exit 1
