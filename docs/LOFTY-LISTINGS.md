# Listings from Lofty — how it works, how to check it, how to switch back

Switched 2026-09-28 at Christine's request ("I need the backend of my websites to
link to Lofty's API for the listings and searches … switched to Lofty"; after an
MLS Grid email about the feed that morning, "I'd rather just switch to Lofty").
Covers signaturepropertycollection.com and thelittleladysellshomes.com — the
latter's search is a pass-through to this site's functions.

## What Lofty gives us (measured with her own key, 2026-09-28)

| | |
|---|---|
| Area-wide search | `POST https://api.lofty.com/v2.0/listings/search`, header `Authorization: token <LOFTY_API_KEY>`. Used by Lofty's official CLI (`@loftyai/lofty-cli`); **not in Lofty's public API reference** — see "Open questions". |
| Filters | `filterConditions.location.county: ["Larimer, CO"]` (also `city`, `zipCode`…), `daysOnSite: ",1"` (new in the last day), price/beds/baths/sqft ranges. `pageSize` max 100; deep pages work. |
| Statuses returned | Active, Active Under Contract, Pending — the same words the site already filters on. |
| Ids | `mlsListingId` is the same `IRE1234567` form MLS Grid used, so listing URLs (`/listing/IRE…`), area-alert ids and old links all carry over. |
| Extra vs MLS Grid | Latitude/longitude on every listing. |
| Missing from search | Description, subdivision, gallery. `GET /v1.0/listing?mlsListingIds=A,B&limit=2` supplies them (any brokerage's listing), 50 per call. |
| Photos | `img.chime.me` — stable URLs (not single-use), resized on request by prefixing the file name: `w300_`, `w600_`, `w800_`, `w1024_`, `w1200_`. A 600px card photo is ~30KB. Answers browsers, social-preview bots and Node; only curl's default user agent gets 403 (test with `-A "Mozilla/5.0"`). |
| Size | ~25,000 listings across the nine counties (Denver 4,669 is the largest) ≈ 255 search pages. |
| Rate limit | Lofty's documented default is 500 requests/minute. The refresh makes one request at a time with a 150ms gap. |

## How the site uses it

- **Full refresh** — `netlify/functions/lofty-sync-background.js` (background function, 15-minute limit) reads every page of every operating county, plus her own listings (`searchScope: "my"`), plus details for anything new or changed. Every 2 hours. A **complete** refresh replaces the catalogue, so sold/withdrawn listings leave; a **partial** one only adds and updates.
- **Quick pass** — `sync-listings.js`, the existing 30-minute schedule: her own listings (a withdrawal leaves her pages within half an hour) and listings new in the last day. Starts the full refresh when it is due.
- **Storage** — Netlify Blobs store `mls-listings`, keys `lofty-listings.json`, `lofty-mine-listings.json`, `lofty-sync-state.json`. The MLS Grid copy under `listings.json` etc. is untouched.
- **Photos** — cards get the 600px Lofty URL directly; galleries and listing-page heroes 1200px. Listing pages now show the whole gallery (up to 30), fetched from Lofty for other brokerages' listings and cached six hours.
- **Only IRES records are published.** Her Lofty account also holds a manual (non-MLS) listing; it is listed on `/status` but not shown on the site.
- **No MLS Grid calls** anywhere on the Lofty path — sync, search, listing pages, photo links and `/status` (pinned by `tests/test-lofty-source.js`).

All of it is in `netlify/functions/lib/_lofty-listings.js`.

## Showing listings: the IDX display switch

Listing display on the site is governed by the IDX kill switch added the same day
(PR #59, `lib/_idx-display.js`), after the MLS Grid licence was revoked: **nothing is
shown unless the Netlify variable `IDX_DISPLAY` is `on`**, and even then only while
the last complete refresh is under 12 hours old. The Lofty refresh writes
`lastSuccessAt` (what that guard reads) only when a full refresh re-read every
listing. So going live on Lofty is two steps: merge this change, then set
`IDX_DISPLAY=on`. Turning it off again is the same variable.

## Checking it

`/status` (add `?probe=1` for live checks) shows:
- *Listings refreshing from Lofty on schedule* — the 30-minute pass.
- *Every listing re-read from Lofty within 12 hours* — goes red past IDX's 12-hour limit; the detail has per-county counts, the last refresh's duration and anything it could not finish.
- *No Lofty errors on last run*, *Christine's own listings found*.
- *Listings shown on the website* — ON, or why not (switch off / not fresh).
- *Listing photos load end to end* — fetches one of her covers from Lofty's image server.

To start a full refresh by hand: `POST /.netlify/functions/lofty-sync-background`. It refuses to run within 20 minutes of a complete one, and never twice at once.

## Switching back to MLS Grid

Set `LISTINGS_SOURCE=mlsgrid` in Netlify → Site configuration → Environment variables, then redeploy. Every reader, the schedule and the generated disclaimers follow that one variable. The MLS Grid path is unchanged and its tests still run (pinned to `mlsgrid`).

## Open questions (not code)

1. **Display permission.** The listing search is not in Lofty's public reference, and the data is IRES IDX data licensed through Lofty. Worth getting Lofty (and IRES) to confirm in writing that showing it on her own domains, with the IRES disclaimer, is within her IDX terms.
2. **MLS Grid data.** Once live on Lofty, the old MLS Grid catalogue keys and stored MLS Grid photos in Blobs are unused. If MLS Grid's termination notice requires deleting its data, they can be removed — deliberately NOT done automatically.
3. **Coming Soon.** Lofty's default search returned no Coming Soon listings in the sample; if one of hers is Coming Soon, check it appears.
