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

# Ground truth, printed rather than trusted. NEXT-SESSION.md quotes these numbers
# and any hand-written figure goes stale; this prints what is actually true right
# now so nobody has to believe a document.
python3 - <<'PYEOF'
import json, glob, os
spots = json.load(open("netlify/functions/lib/_local-spots.json"))["spots"]
views = sum(s.get("views") or 0 for s in spots)
reviews = sum(s.get("reviewViews") or 0 for s in spots)
# Two DIFFERENT true measures, labelled so they can't look like a contradiction:
# town PAGES carrying spots (Bellvue's spot lives on the Fort Collins page), versus
# distinct town names in the data. Same for html files on disk versus pages the
# sitemap tracks (404.html is deliberately not in the sitemap).
town_pages = len({s.get("cityHref") for s in spots if s.get("cityHref")})
town_names = len({s.get("city") for s in spots if s.get("city")})
html_files = sum(1 for r, _, fs in os.walk("site") for f in fs if f.endswith(".html"))
# Her listing tours on town pages. Counted off the built pages, not off the data
# table, because the table holds more than the pages show (one video per house, price
# anchors held back, anything already embedded higher up the page skipped).
import re
tours = tour_pages = 0
for f in glob.glob("site/communities/*/*.html"):
    h = open(f).read()
    m = re.search(r'<span class="eyebrow">[^<]*Work In [^<]*</span>(.*?)</section>', h, re.S)
    if m:
        tour_pages += 1
        tours += len(re.findall(r'class="yt-facade" data-yt=', m.group(1)))
print(f"\nCurrent: {html_files} html files on disk · {len(spots)} local spots on "
      f"{town_pages} town pages ({town_names} distinct town names) "
      f"· {views:,} video views + {reviews:,} review views "
      f"· {tours} listing tours on {tour_pages} town pages "
      f"· {len(glob.glob('tests/test-*.js'))} test suites")
PYEOF
exit "$fail"
