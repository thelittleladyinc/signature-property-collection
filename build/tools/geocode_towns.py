#!/usr/bin/env python3
"""Geocode every town the site covers, once, and write build/data/town_geo.json.

WHY (2026-08-17). The 37 town pages carry a `Place` schema node saying which town
the page is about, with the town name, its county and the state -- but no
coordinates, because `city_content.json` has none. That is the single remaining
geo gap in an otherwise well-covered site: the agent entity has real lat/lng on
all 155 pages, the location photos carry `contentLocation` with real coordinates,
and `areaServed` is everywhere. Only the town entities are coordinate-less.

WHY NOT JUST TYPE THEM IN. Thirty-six latitudes recalled from memory is thirty-six
chances to be quietly, plausibly wrong -- a schema validator accepts any
well-formed number, so a town placed twelve miles into a field would never
surface. Christine already pays for `GOOGLE_MAPS_API_KEY` (confirmed present in
Netlify, and already used by `nearby-places.js` for drive times), so the
coordinates can be fetched from the authority instead of guessed. Same rule as
the town prices and the relocation guide: real data, fetched, never typed.

WHY IT IS A SEPARATE SCRIPT. `build.py` must stay offline and deterministic --
Netlify runs it on every deploy, and a build that phones an API is a build that
can fail because someone else's service had a bad afternoon. This writes a data
file; `build.py` only ever reads it. If the file is missing, `_town_place_schema()`
emits `Place` without `geo`, exactly as it does today. Nothing breaks.

RUN IT ONCE. Town coordinates do not change. This is not a scheduled job -- it is
run when a town is added to the site, and otherwise never. The output is committed.

USAGE
    GOOGLE_MAPS_API_KEY=... python3 build/tools/geocode_towns.py
    GOOGLE_MAPS_API_KEY=... python3 build/tools/geocode_towns.py --force   # re-fetch all

By default it only fetches towns missing from the existing file, so re-running it
after adding one town costs exactly one API call rather than thirty-seven.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD_DIR = os.path.dirname(HERE)

sys.path.insert(0, BUILD_DIR)
import build as b  # noqa: E402  (guarded by __main__, so this loads data only)

OUT_PATH = os.path.join(BUILD_DIR, "data", "town_geo.json")
ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json"

# Google's geocoder is generous about input but the result is only as specific as
# the query. Constraining to the county and state stops "Boulder" resolving to the
# county centroid, and stops the handful of small towns that share a name with
# somewhere bigger in another state from silently resolving there.
def _query(town, county_name):
    return f"{town}, {county_name}, Colorado, USA"


# Result types we accept as "this is a town". Google returns `locality` for
# incorporated places; unincorporated communities like Masonville and Red Feather
# Lakes come back as `neighborhood` or one of the unincorporated types, which are
# still the right point for our purpose. `administrative_area_level_2` is a COUNTY
# and is explicitly not accepted -- that is the failure mode this guards against.
ACCEPT_TYPES = {
    "locality", "sublocality", "neighborhood", "postal_town",
    "administrative_area_level_3", "administrative_area_level_4",
}
REJECT_TYPES = {"administrative_area_level_1", "administrative_area_level_2", "country"}


def geocode(town, county_name, key):
    qs = urllib.parse.urlencode({
        "address": _query(town, county_name),
        "components": "country:US|administrative_area:CO",
        "key": key,
    })
    with urllib.request.urlopen(f"{ENDPOINT}?{qs}", timeout=20) as r:
        data = json.loads(r.read().decode())

    status = data.get("status")
    if status == "ZERO_RESULTS":
        return None, "no result"
    if status != "OK":
        # OVER_QUERY_LIMIT / REQUEST_DENIED are configuration problems, not data
        # problems -- surface them rather than writing a file with holes in it.
        raise SystemExit(
            f"!! Google Geocoding returned {status} for {town}: "
            f"{data.get('error_message', '(no message)')}\n"
            "!! Nothing written. Check the key is enabled for the Geocoding API "
            "specifically — a key that works for Distance Matrix is not "
            "automatically enabled for Geocoding."
        )

    top = data["results"][0]
    types = set(top.get("types") or [])
    if types & REJECT_TYPES:
        return None, f"resolved to {sorted(types & REJECT_TYPES)}, not a town"
    if not (types & ACCEPT_TYPES):
        return None, f"unexpected result types {sorted(types)}"

    loc = top["geometry"]["location"]
    return {
        "lat": round(float(loc["lat"]), 5),
        "lng": round(float(loc["lng"]), 5),
        "resolved": top.get("formatted_address"),
        "types": sorted(types & ACCEPT_TYPES),
    }, None


def main():
    key = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
    if not key:
        raise SystemExit(
            "!! GOOGLE_MAPS_API_KEY is not set. It is in Netlify (Site "
            "configuration -> Environment variables); export it here, or add it as "
            "a GitHub Actions secret if this is running in CI. Nothing written."
        )
    force = "--force" in sys.argv

    existing = {}
    if os.path.exists(OUT_PATH) and not force:
        with open(OUT_PATH) as f:
            existing = (json.load(f) or {}).get("towns") or {}

    # One entry per town the site actually builds a page for, keyed by the
    # city_content slug so build.py can look it up without a name match.
    wanted = []
    seen = set()
    for c in b.COUNTIES:
        for town in c["cities"]:
            slug = b.CITY_DATA_SLUG.get(town)
            if not slug or slug not in b.CITY_CONTENT or slug in seen:
                continue
            seen.add(slug)
            wanted.append((slug, town, c["name"]))

    towns = dict(existing)
    fetched = skipped = failed = 0
    problems = []
    for slug, town, county in wanted:
        if slug in towns and not force:
            skipped += 1
            continue
        result, why = geocode(town, county, key)
        if result is None:
            failed += 1
            problems.append(f"{town} ({county}): {why}")
            continue
        result["town"] = town
        result["county"] = county
        towns[slug] = result
        fetched += 1
        print(f"  {town:22} {result['lat']:>9.5f}, {result['lng']:>10.5f}  "
              f"{result['resolved']}")
        time.sleep(0.12)  # courtesy pacing; the free tier does not need more

    out = {
        "_README": [
            "Coordinates for each town the site builds a page for, fetched from the",
            "Google Geocoding API by build/tools/geocode_towns.py.",
            "",
            "DO NOT HAND-EDIT. Re-run the script. The whole point of this file is",
            "that no latitude in this repo was typed in by a person.",
            "",
            "build.py reads it and adds a `geo` block to the Place schema on each",
            "town page. If this file is missing, Place is emitted without geo and",
            "nothing breaks — that is the designed fallback, not an error.",
            "",
            "Town coordinates do not change, so this is NOT a scheduled job. Run it",
            "when a town is added to the site. Re-running only fetches towns that",
            "are missing, unless --force is passed.",
        ],
        "source": "Google Geocoding API",
        "towns": towns,
    }
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=2, sort_keys=True)
        f.write("\n")

    print(f"\nwrote {os.path.relpath(OUT_PATH, os.path.dirname(BUILD_DIR))}: "
          f"{len(towns)} towns ({fetched} fetched, {skipped} already present, "
          f"{failed} failed)")
    if problems:
        print("\n!! Towns without coordinates — their Place schema stays geo-less,")
        print("!! which is correct behaviour, but worth a look:")
        for p in problems:
            print(f"     {p}")


if __name__ == "__main__":
    main()
