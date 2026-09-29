# Listings from Lofty — how it works, how to check it, how to switch back

Switched 2026-09-28 at Christine's request ("I need the backend of my websites to
link to Lofty's API for the listings and searches … switched to Lofty"; after an
MLS Grid email about the feed that morning, "I'd rather just switch to Lofty").
Covers signaturepropertycollection.com and thelittleladysellshomes.com — the
latter's search and listing pages are pass-throughs to this site's functions.

## The shape (approved the same day: "lets do it!!!")

We timed both sites from click to data. Her Lofty site was faster — a listing
page ~1.1s vs ~2.4s, search results ~0.6s vs ~1.0s — so:

- **Her Lofty site does the home search** and the listing pages for every home on
  the market. Every "Search Homes" on this site opens it, already filtered.
- **This site keeps her own listings** — with their video tours — and the town
  pages.
- The Lofty site's domain (today `theboldcollectivehomes.com`) is being rebranded
  to The Little Lady in Lofty. When it moves, set `IDX_SEARCH_URL` in Netlify to
  `https://<new domain>/listing`. Nothing else changes.

For a few hours the same day this site copied the whole market from Lofty
(~25,000 listings every two hours through a background function). That was cut
back to her own listings once the plan above was chosen; the background refresh
is gone.

## Her listings (`netlify/functions/lib/_lofty-listings.js`)

- **Every 30 minutes** (`sync-listings.js`, the existing schedule): Lofty's "my
  listings" search (`POST https://api.lofty.com/v2.0/listings/search`,
  `searchScope: "my"` — agent or co-agent), then their details (`GET
  /v1.0/listing?mlsListingIds=…`: description, subdivision, whole gallery). Two
  requests a run. Header `Authorization: token <LOFTY_API_KEY>`.
- **A complete answer replaces her set**, so a listing she withdraws or sells
  leaves her pages within half an hour, and records `lastSuccessAt` (what the IDX
  12-hour guard reads).
- **Anything less changes nothing.** A failed or partial read keeps the last good
  set. An **empty** answer is believed only after Lofty has said so for two hours
  running — a glitch is likelier than her having nothing listed, but a permanent
  "keep the old ones" would show sold homes forever.
- **Only IRES records are shown** (`mlsOrgId` 1054). Her Lofty account also holds
  a manual listing (`MANL…`) that is not on the MLS; it is listed on `/status`,
  not shown, because these pages present listings as IRES MLS data. A "my
  listings" record that doesn't carry her surname as agent or co-agent is not
  shown either (counted on `/status`).
- **Refresh now**: `POST /.netlify/functions/refresh-my-listings` (refuses within a
  minute of the last refresh). Scheduled functions can't be called by URL, so this
  is also how a deploy preview gets her listings.
- **Storage**: Netlify Blobs store `mls-listings`, keys `lofty-listings.json`,
  `lofty-mine-listings.json`, `lofty-sync-state.json`. The MLS Grid copy under
  `listings.json` etc. is untouched. (Leftovers from the few hours of the
  whole-market design, unused now: `lofty-crawl-lock.json`,
  `lofty-crawl-kick.json`, `lofty-gallery/*`. Safe to delete.)
- **Photos**: `img.chime.me` — stable URLs that resize on request (`w600_`,
  `w1200_` …). Cards get 600px directly, galleries and heroes 1200px. Her listing
  pages show her whole gallery.
- **No MLS Grid calls** on anything that shows listings (pinned by
  `tests/test-lofty-source.js`). MLS Grid is still read in the background for the
  town market figures — see below.

## The home search hand-off (`netlify/functions/lib/_home-search.js`)

- `/search-homes.html` (and `/search-homes`, `/search-homes/`) is a forced rewrite
  to `home-search.js`, which **302s** to the same search on her Lofty site. Every
  link on the site — menu, footer, town pages, the maps' price buttons — already
  pointed there with its filters in the query string, so none of them had to
  change. 302, not 301, so a domain change is never stuck in browsers.
- A public search through `listings-search.js` (the widgets on town and
  neighborhood pages) answers with **the same hand-off**: `idxUnavailable: true`,
  `reason: "home_search"`, a label ("See Loveland homes for sale from $950K") and
  the Lofty URL. Every widget already renders that as a button; the town pages'
  **Search Homes** button goes straight there.
- Lofty's URL, read off her Lofty site and tried there (Lofty doesn't document it):
  `/listing?condition=<JSON>&page=1[&listingSort=…]` with `location.city`
  (`["Loveland, CO"]`), `location.county`, `price` (`"950000,"`), `beds`, `baths`,
  `sqft`, `propertytype`. Loveland + $950K + 3 beds gave 95 homes, all matching.
- **Kept**: the $950K floor unless a link says `noFloor=true` or names a minimum
  (Signature stays a luxury search). With no town named: **Larimer + Weld**
  (Christine: "switch to loveland and noco specifically weld and larimer
  counties") — her Lofty site's own default search includes other states.
  `HOME_SEARCH_COUNTIES` (comma-separated) changes it.
- **Not mapped, on purpose**: subdivision (Lofty wants the exact name — "Mariana"
  finds nothing, "Mariana Butte" does — so those searches open the whole town),
  riverfront / horse property (no Lofty filter), land / farm (labels didn't match).
- **Tagged with where they came from** (2026-09-29): every hand-off URL carries
  `utm_source=signaturepropertycollection.com` (or `thelittleladysellshomes.com`
  when the Little Lady site passes the search through with `?site=thelittleladysellshomes`),
  `utm_medium=website`, `utm_campaign=home-search`. Lofty sets a new lead's
  source from `utm_source`, so a buyer who registers on her Lofty site after
  tapping Search Homes here shows up with this site as their source instead of
  plain "Website". A query parameter, not a header, because these answers are
  cached by URL. Nothing about the visitor or the page is added.
- **Counted in Google Analytics**: a redirect is never a page view, so the
  hand-off itself is an event, `home_search_handoff` (`page_path`, `cta_id` —
  the button's `data-roi-cta`, `search-widget` or `link`; never the search).
- A listing page for anyone else's listing is a 404 with a "Search Homes For Sale"
  button to her Lofty search (old links from the MLS Grid days land there).
- **thelittleladysellshomes.com** does the same (its PR #45): its
  `/search-homes.html` is a forced rewrite to its own `home-search.js`, a
  pass-through to this site's with `noFloor=true` (that site searches every
  price). Its widgets, listing pages and map already come through this site's
  functions. Merge it only after this site's `home-search` function is live.

## What else changed with it

- **Map "Email Me New Homes Here"**: this site can't see new listings any more, so
  the map now offers "Save This Area On My Home Search" (Lofty's Save Search sends
  the alerts). The alert endpoint answers any older copy of the map the same way.
  **Alerts saved before the switch are kept but no longer emailed** — `/status`
  counts them. Nobody was emailed about this; that's Christine's call.
- **Town market figures** (`build/tools/town-market-stats.js`) stay on MLS Grid.
  Christine, later the same day: "use my mls grid for whatever we need to for all
  of this — it wasn't shut off after all but speed made the difference". So
  `sync-listings.js`, after refreshing her Lofty listings, runs the MLS Grid
  replication as before, **under the MLS Grid keys only** (`listings.json`,
  `sync-state.json`) — never what the site shows. The stats job reads that copy
  and refuses to publish if it hasn't refreshed in 48 hours. `MLSGRID_MARKET_DATA=off`
  stops the background run; `MLS_DISABLED=true` still stops every MLS Grid call.
  `/status`: *Market data from MLS Grid refreshing*.
- The legal page and disclaimers no longer name MLS Grid while Lofty is the source.
- **The "Recently sold & open houses" strip** (`recent-activity.js`) reads Listing
  Engine, which records those events from the IRES feed through MLS Grid — not
  from Lofty. So turning `IDX_DISPLAY` on for her Lofty listings does not turn it
  on: on Lofty it also needs `RECENT_ACTIVITY_DISPLAY=on`, Christine's call.

## Website leads in Lofty: returning leads and website fields (2026-09-29)

`lib/_lofty-returning.js`, used by `submission-created.js` on both sites (the
Little Lady copy is pinned identical by its tests):

- **Before pushing a lead, Lofty is asked whether the person already exists**:
  `GET /v1.0/leads?email=…&preciseSearchFlag=true` and the same by phone (bare
  digits), **in parallel, under one 2-second budget**. Exact matches only; any
  non-exact answer is "can't tell", never "new".
- **Tags:** `tags` on the create call *replaces* a merged contact's tag set, so it
  is sent only for a contact proven new (both lookups answered, nobody found).
  Anyone found — and anyone the lookup couldn't answer for — gets `tagsAdd`.
  Queued retries (`drainFailedPushes`) always replay with `tagsAdd`.
- **Returning lead** (found **by email**): the timeline note goes to that contact
  (not the absorbed record a merge hands back), and instead of the tag re-fire
  Lofty's API can't do, a **Call task** is created on the contact
  (`POST /v2.0/tasks`, assigned to the lead's agent, due in 30 minutes Denver
  time) and **pushed to that agent's phone**
  (`POST /v2.0/sales-agent/notification/app-push/send-task-reminder`). Nothing
  is ever sent to the client. A **phone-only** match is treated as "someone"
  (tags added, no fields) but never redirects the note or task — it could be a
  spouse.
- **New contact** (both lookups answered, nobody found): four text custom
  fields — *Website Form*, *Website First Page*, *Website Form Page*, *Website
  Traffic Source* — are written on the new lead (`PUT /v1.0/leads/{id}` with
  `customAttributeList`), using the create call's own id read exactly (64-bit).
  The fields are created on her team once (`POST /v1.0/teamFeatures/custom-field`)
  and remembered for a week (Blobs `lofty-website-fields.json`). Never written on
  an existing contact: whether an update replaces a lead's other custom fields is
  undocumented.
- **Time:** the create (both attempts) must finish 7 seconds after the function
  starts (`CREATE_DEADLINE_MS`; each attempt also stops at 6 seconds, and the
  minimal-shape retry is skipped when under 1.5 seconds remain), so the backup
  email always goes out inside the function's time limit. `/status` is written as
  soon as the email is out, then updated as the note, tag, task and fields finish.
- If Lofty can't answer the lookup, the lead flows as before except that its tags
  are added rather than replacing anything. `/status` → *Your Lofty notification
  will fire* shows what the lookup found, and the task/push (or what failed) for
  a returning lead.

## Showing listings: the IDX display switch

Display is governed by the kill switch added the same day (PR #59,
`lib/_idx-display.js`): **nothing from storage is shown unless the Netlify
variable `IDX_DISPLAY` is `on`**, and then only while `lastSuccessAt` is under 12
hours old. On Lofty that means her own listings. The home search hand-off is
never gated — a link to her Lofty site is not listing data.

## Checking it

`/status` (add `?probe=1` for live checks):
- *Your listings refreshing from Lofty on schedule*, *Your listings confirmed by
  Lofty within 12 hours*, *No Lofty errors on last run*, *Christine's own
  listings found* (plus anything not shown, and why).
- *Descriptions and full galleries loaded*, *Home search goes to Lofty* (the
  address in use), *Map new-home alerts paused* (if any were saved).
- *Listings shown on the website* — ON, or why not.
- *Listing photos load end to end* — fetches one of her covers from Lofty.

## Switching back to MLS Grid

Set `LISTINGS_SOURCE=mlsgrid` in Netlify → Site configuration → Environment
variables, then redeploy. Every reader, the schedule, the search page (the
hand-off rewrite is only written on Lofty), the map and the generated disclaimers
follow that one variable. The MLS Grid path is unchanged and its tests still run
(pinned to `mlsgrid`).

## Open questions (not code)

1. **Display permission.** Showing her own listings on her own sites is ordinary
   listing marketing; worth confirming with Lofty/IRES anyway that using the
   Lofty API for it is fine by them. The whole-market display question went away
   with the whole-market copy.
2. **MLS Grid.** PR #59 (the IDX kill switch) was written on the understanding
   that the MLS Grid licence had been revoked; Christine said later on 2026-09-28
   that the feed "wasn't shut off after all". Its copy is in use again, for the
   town market figures only.
3. **Coming Soon.** Lofty's "my listings" search returned Active, Under Contract
   and Pending in testing; if one of hers is Coming Soon, check it appears.
