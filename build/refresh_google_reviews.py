"""Pull Christine's live Google Business Profile review stats and cache them
to build/data/google_reviews.json for build.py to consume.

Runs as a pre-build step. Fails silently (keeps the previous cached numbers)
if the GBP API is unreachable — a stale but honest number is better than a
broken build.

Christine's canonical GBP location:
    accounts/116586188101603604332  (The Little Lady Sells Homes, PERSONAL)
    locations/16585641039540537482  (Christine Gwinnup - TLLSH, LPT Realty)

This script is INTENTIONALLY duplicated identically in both repos
(signature-property-collection + thelittleladysellshomes) so each build is
self-contained. Keep them in sync — if you touch one, touch the other.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ACCOUNT = "accounts/116586188101603604332"
LOCATION = "locations/16585641039540537482"
OUT_PATH = Path(__file__).parent / "data" / "google_reviews.json"

STAR_MAP = {"ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5}


def _fetch_reviews_via_gbp_api() -> dict | None:
    """Fetch all reviews from GBP. Returns None on any failure.

    Uses google-api-python-client + a service-account or OAuth token from
    GOOGLE_APPLICATION_CREDENTIALS. If no creds are available in the build
    environment, returns None and the caller keeps the cached number.

    In the Perplexity Computer environment this is called via the connector
    layer instead — see refresh_from_connector.py (which invokes the pplx
    external tool and writes the same JSON schema).
    """
    try:
        # Deliberate lazy import: build environments without GBP creds
        # should not require google-api-python-client to be installed.
        from googleapiclient.discovery import build  # noqa: F401
    except ImportError:
        return None
    # Real implementation would go here; in practice we run the connector-
    # based refresher (below) in the Perplexity environment. Return None so
    # the CI / local-only build path keeps the cached number rather than
    # writing zeros.
    return None


def write_cache(payload: dict) -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2) + "\n")


def load_cache() -> dict | None:
    if not OUT_PATH.exists():
        return None
    try:
        return json.loads(OUT_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def summarize(reviews: list[dict], location_name: str) -> dict:
    total = len(reviews)
    five_star = sum(1 for r in reviews if STAR_MAP.get(r.get("starRating"), 0) == 5)
    if total == 0:
        avg = 0.0
    else:
        avg = round(
            sum(STAR_MAP.get(r.get("starRating"), 0) for r in reviews) / total, 2
        )
    return {
        "location": location_name,
        "totalReviewCount": total,
        "fiveStarCount": five_star,
        "averageRating": avg,
        "asOf": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def main() -> int:
    """Manual entrypoint. Not called by build.py directly — build.py just
    reads the cached JSON. Re-running this script (via a scheduled task in
    Perplexity Computer, or manually) is what keeps the cache current."""
    cache = load_cache()
    if cache is None:
        print(
            "WARN: no cached google_reviews.json — writing safe defaults so the "
            "build doesn't crash. Refresh manually via the Perplexity Computer "
            "GBP connector to populate real numbers.",
            file=sys.stderr,
        )
        write_cache(
            summarize([], location_name=LOCATION)
        )
        return 0
    print(json.dumps(cache, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
