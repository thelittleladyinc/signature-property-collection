#!/usr/bin/env python3
"""Generate docs/YOUTUBE-DESCRIPTION-LINES.md from build/data/local_spots.json.

2026-08-16. The highest-leverage thing available to Christine is not more code: it
is that 31,000 views of her own local content already exist on YouTube and Google
Maps, and most of those descriptions point at her old site or nowhere useful. One
line per video sends that traffic to a page she owns.

Generated rather than hand-written for the same reason everything else here is:
view counts and town-page URLs change, and a hand-typed list becomes wrong quietly.
Run this after adding spots.

    python3 build/tools/description_lines.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DATA = os.path.join(ROOT, "netlify", "functions", "lib", "_local-spots.json")
OUT = os.path.join(ROOT, "docs", "YOUTUBE-DESCRIPTION-LINES.md")
SITE = "https://signaturepropertycollection.com"


def main():
    spots = json.load(open(DATA))["spots"]

    # Grouped by VIDEO, not by spot: one film can cover several places (the Erie
    # video covers three), and a description is edited once per video.
    by_video = {}
    for s in spots:
        vid = s.get("videoId")
        if not vid:
            continue
        entry = by_video.setdefault(vid, {
            "title": s.get("videoTitle") or "",
            "views": s.get("views") or 0,
            "places": [], "hrefs": set(), "towns": set(),
        })
        entry["places"].append(s["name"])
        entry["hrefs"].add(s["cityHref"])
        entry["towns"].add(s.get("city") or "")

    videos = sorted(by_video.items(), key=lambda kv: -kv[1]["views"])
    reviews = sorted(
        (s for s in spots if not s.get("videoId") and (s.get("reviewViews") or 0) > 0),
        key=lambda s: -(s.get("reviewViews") or 0),
    )
    total_video = sum(v["views"] for _, v in videos)
    total_review = sum(s.get("reviewViews") or 0 for s in reviews)

    L = []
    L.append("# Paste-ready description lines for your existing videos")
    L.append("")
    L.append("Generated from `build/data/local_spots.json`, so every URL and view count here is")
    L.append("real. Regenerate with `python3 build/tools/description_lines.py`.")
    L.append("")
    L.append("## Why this is worth an evening")
    L.append("")
    L.append(f"These {len(videos)} videos have **{total_video:,} views** between them, and your")
    L.append(f"reviews add another **{total_review:,}**. That audience already exists and already")
    L.append("trusts your taste in local places. Right now most of those descriptions point at the")
    L.append("old site or nowhere useful, so the traffic evaporates. One line per video sends it")
    L.append("somewhere you own — a page listing the other places you've covered in that town, and")
    L.append("the homes for sale near them.")
    L.append("")
    L.append("Do the top five and you have covered most of the reach.")
    L.append("")
    L.append("---")
    L.append("")
    L.append("## The videos, most-watched first")
    L.append("")
    for vid, v in videos:
        town = sorted(v["towns"])[0] if v["towns"] else ""
        href = sorted(v["hrefs"])[0]
        L.append(f"### {v['views']:,} views — {v['title'] or vid}")
        L.append(f"`youtube.com/watch?v={vid}`  ·  covers: {', '.join(sorted(v['places']))}")
        L.append("")
        L.append("Add to the description (near the top, above the hashtags):")
        L.append("")
        L.append("```")
        L.append(f"📍 More of {town} the way locals actually see it — every spot I've filmed here,")
        L.append(f"plus homes for sale nearby: {SITE}{href}")
        L.append("```")
        L.append("")

    L.append("---")
    L.append("")
    L.append("## Your Google reviews")
    L.append("")
    L.append("Google reviews can't carry a clickable link, so these work differently: mention the")
    L.append("site in the review text itself next time you post or edit one. Keep it natural — a")
    L.append("recommendation that reads like an advert gets ignored, and yours don't.")
    L.append("")
    for s in reviews:
        L.append(f"- **{s['name']}** ({s.get('reviewViews'):,} review views) — town page: "
                 f"`{SITE}{s['cityHref']}`")
    L.append("")
    L.append("Suggested phrasing to work in, not paste verbatim:")
    L.append("")
    L.append("```")
    L.append("I map the local spots I actually eat at and hike around Northern Colorado —")
    L.append(f"{SITE.replace('https://', '')}/communities")
    L.append("```")
    L.append("")
    L.append("---")
    L.append("")
    L.append("## The one link that works everywhere")
    L.append("")
    L.append("Bio, pinned comment, Google Business profile, email signature:")
    L.append("")
    L.append("```")
    L.append(f"{SITE}/communities")
    L.append("```")
    L.append("")
    L.append(f"That is the map with all {len(spots)} spots on it. From there a visitor reaches every")
    L.append("town page, every video, and a live search of homes near any of them.")
    L.append("")
    L.append("## And for sellers")
    L.append("")
    L.append("When a seller asks why they should list with you:")
    L.append("")
    L.append("```")
    L.append(f"{SITE}/seller-local-proof")
    L.append("```")
    L.append("")
    L.append("They pick their town and see how many people have already watched or read your")
    L.append("content about it. No other agent in your market can show that number.")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        f.write("\n".join(L) + "\n")
    print(f"wrote docs/YOUTUBE-DESCRIPTION-LINES.md — {len(videos)} videos "
          f"({total_video:,} views), {len(reviews)} review-only spots ({total_review:,} views)")


if __name__ == "__main__":
    main()
