# MLS reads through the hub (`MLS_SOURCE=hub`)

Wave 2a, 2026-10-17. **Off until Christine switches it on.** With `MLS_SOURCE` unset (today) nothing
here changes: the site reads MLS Grid exactly as before.

Why: this site, Listing Engine and Expired Elite shared one MLS Grid account, and MLS Grid suspends the
account for everyone's traffic together (it did on 2026-08-01). The Seller Intelligence hub now keeps
its own copy of the IRES feed and is the one MLS Grid reader. With `MLS_SOURCE=hub` this site asks the
hub instead and makes **no MLS Grid request at all** (pinned by `tests/test-mls-via-hub.js`).

Code: `netlify/functions/lib/_mls-hub.js` (the switch, the hub answers, the row mapping),
`netlify/functions/sync-listings.js` (`hubMarketDataRun`, `makeOnMarketConfirmer`),
`netlify/functions/mls-hub-sync.js` (the :15/:45 run), `lib/_idx-display.js` (the refusal).
The hub is called only through the vendored toolkit client (`lib/suite-kit/hub.js`, `createHubClient`).

## What moved

With the default listing source (Lofty: the site shows only Christine's own listings, from Lofty), only
two things on this site still read MLS Grid. Both move:

| What | Today (MLS Grid) | With `MLS_SOURCE=hub` |
|---|---|---|
| **The market-data copy** behind the town pages' figures (`listings.json`, `mine-listings.json`, `sync-state.json` in the `mls-listings` Blobs store) | `sync-listings.js` every 30 min, after her Lofty listings: bootstrap = `MlgCanView eq true` + Active/AUC/Pending, then `ModificationTimestamp gt <checkpoint>` with no status filter, so a listing that leaves the market comes back and is removed | Same blobs, same record shape, same rules, read from the hub: `GET /v1/mls/deleted` since the last pass, then `POST /v1/mls/search` ordered by `modified` from the same checkpoint, no status filter. Withheld stubs and deletions are removed, exactly like `MlgCanView=false` today. Every 15 min (see Speed). The first hub run reads one full snapshot instead of carrying the MLS Grid copy's checkpoint over (see below), then every run is incremental. |
| **"Is her Lofty listing really on the market?"** (`makeOnMarketConfirmer`, used by the 30-min sync and `refresh-my-listings`) | 1. in `mine-listings.json` → yes, no request; 2. else one MLS Grid request `ListingId eq …` (`StandardStatus`, `MlgCanView`); at most 2 a run, verdict kept 24 h, 7-day grace for a brand-new listing | Same order, cap, cache and grace; step 2 is `POST /v1/mls/search {listing_ids:[id]}`. |

The same record shape is guaranteed by cutting each hub row down to exactly the fields the MLS Grid crawl
selects (`SELECT_FIELDS`) and passing it through the same `mapListing()`.

**When the hub copy has no copy yet** (fresh store), **when the copy has never been checked against the hub**
(`hubReconciledAt` unset in `sync-state.json`: the first run after switching from MLS Grid), or when the deletion
list no longer reaches back to the last pass (the hub keeps 30 days), the run reads a full snapshot (Active,
Active Under Contract, Pending, Coming Soon) over as many runs as it takes, then removes whatever is stored that
the snapshot did not return, and records `hubReconciledAt`. A snapshot that would keep under half of what is
stored, or nothing at all, is refused: nothing removed, the copy not marked current, the reason on
`/site-health`.

**Why the first hub run re-reads (2026-10-23).** The MLS Grid copy keeps listings MLS Grid has stopped serving.
MLS Grid sends a listing's `MlgCanView=false` record for only about a week, so a removal that arrived while the
crawl was paused (the Aug 1 suspension, quota stops) was never seen; `refreshOneListing` skips a listing MLS Grid
no longer returns instead of removing it; and there is no key check against MLS Grid's full list (the hub runs
one weekly). On Oct 22 this site's town figures counted 22,881 Active listings in the 132 towns both copies cover,
against the hub's 21,127 (7.7% more; more in 88 towns, fewer in 15, the hub's figures a day newer). The one
snapshot clears those, so this site's town figures and the hub's agree after the switch.

**Fail closed.** Hub not configured, unreachable, refused (4xx/5xx), not JSON, a malformed row or cursor,
`503 not_ready`, or a 200 whose `copy.ready` is not true: nothing from that page is applied, the checkpoint
and `lastSuccessAt` do not move, the reason goes in `sync-state.json` `lastRunError` and on `/site-health`,
and nothing is ever read as "not found" or "zero listings". For the on-market check every such failure is
"unknown", which keeps the listing (as an MLS Grid failure does today). The town-figure job already refuses
a copy with no complete pass in 48 hours (`build/tools/town-market-stats.js`).

**Not with `LISTINGS_SOURCE=mlsgrid`.** That mode puts every brokerage's listings on public pages, which
need photos (the hub has none) and the listing agent for "Listing courtesy of …" (only with an extra scope).
So `LISTINGS_SOURCE=mlsgrid` + `MLS_SOURCE=hub` is **refused**: no listing, photo, map pin or alert is shown
(`idxGate` reason `mls_source_hub`; listing pages answer a temporary 503 + noindex), the sync and the
overnight photo walk make no MLS Grid request, and `/site-health` leads with a red "MLS source setting" row.

## The switch

`MLS_SOURCE`, read on every call (not frozen at deploy): exactly `hub` after trimming whitespace turns it on.
Unset, empty, `mlsgrid` or anything else (`Hub`, `on`, `true`) keeps MLS Grid; a value that is neither `hub`
nor `mlsgrid` is logged once ("only exactly "hub" switches…") without printing it.

In hub mode `MLSGRID_MARKET_DATA=off` still stops the market-data run; no MLS Grid token is needed.
`MLS_DISABLED` is the MLS Grid kill switch and does not apply to the hub (the hub's own switch is its
`mls_reads_enabled` flag). The MLS Grid quota guard and suspension breaker are not involved in hub mode.

## Status map — what each MLS status does on this site

Where the status is read today: MLS Grid `Property`, field **`StandardStatus`** (never `MlsStatus`) plus
`MlgCanView` (`_mls-shared.js:68` `SELECT_FIELDS`, `:548` `status: item.StandardStatus`, `:572`
`mlgCanView`); the crawl's filter is `sync-listings.js:368` `baseFilter`; the on-market lookup asks for
`ListingId,StandardStatus,MlgCanView` (`sync-listings.js:1008`). Via the hub: the rows' `StandardStatus`
(the hub falls back to `MlsStatus` only when `StandardStatus` is empty), `MlgCanView`, `_hub.withheld`, and
`/v1/mls/deleted`. Her own listings shown on the site come from Lofty's `listingStatus`
(`lib/_lofty-listings.js:124` `normalizeStatus`, `:452` filtered to `MINE_STATUSES`), checked against the MLS.

Status lists: stored `REPLICATED_STATUSES` = Active, Active Under Contract, Pending, Coming Soon
(`_mls-shared.js:102`); public search `PUBLIC_STATUSES` = Active, Coming Soon (`:104`); her own `MINE_STATUSES`
= the stored four (`:103`). Rule for storing: `sync-listings.js:1833` (MLS Grid) and `:1396` (hub) — any
other status, or `MlgCanView=false`, is removed from the copy.

| Status | In the MLS copy | Public pages (only with `LISTINGS_SOURCE=mlsgrid`) | Her own listings (default: from Lofty) | Town figures | Area alerts |
|---|---|---|---|---|---|
| **Coming Soon** | stored | shown in search and on its listing page (`listing-page.js:692`); badge "Coming Soon", no tour button (`build/build.py:1437`) | shown, sorted first on her page (`listings-search.js:397`); the MLS check says on the market | not counted (Active only) | nothing |
| **Active** | stored | shown (search floor $950K unless `noFloor`); badge Active + tour button | shown; MLS check: on the market | counted: count, median list price, median $/sqft (`town-market-stats.js:113`) | a newly Active listing in a saved area goes in the next alert email (`area-alerts-run.js:165`) — **held**: paused under Lofty (`:117`), unscheduled, and only with `AREA_ALERTS_APPROVED_BY` |
| **Active Under Contract** | stored | not in search; listing page 404s unless hers | shown as "Under Contract", sorted first, her listing page still works; map pin says "· Pending" (`build/assets/js/explore-map.js:1028`); MLS check: on the market | not counted | nothing (drops out of the match) |
| **Pending** | stored | same as Active Under Contract | same as Active Under Contract | not counted | nothing |
| **Closed** | removed | gone (404 "no longer on the market") | MLS check: off the market → **hidden**, named on `/site-health` "Every listing Lofty reports is still on the MLS" (`_lofty-listings.js:493`, `site-health.js:304`) — Lofty support fixes the record | not counted | nothing |
| **Expired** | removed (IRES marks it `MlgCanView=false`; via the hub: `/v1/mls/deleted` or a withheld stub) | gone | MLS check: off the market → hidden + named | not counted | nothing |
| **Canceled** | removed (as Expired) | gone | hidden + named | not counted | nothing |
| **Withdrawn** | removed | gone | hidden + named | not counted | nothing |
| **Hold** | removed | gone | hidden + named | not counted | nothing |
| **Back on market** (→ Active from Pending / Under Contract) | record updated to Active in place | back in search, badge Active, tour button returns | shown as Active (Lofty's status); MLS check on the market | counted again | announced only if the alert's last-sent list no longer holds it (it was emailed about other homes while this one was off Active); otherwise not re-announced |
| **Back on market** (→ Active from Expired / Canceled / Withdrawn / Hold) | stored again when its record returns (`MlgCanView` true again / back in the hub's search) — like a new listing | shown again | shown (her Lofty listing is no longer hidden on the next refresh) | counted again | as a new listing |

**Nothing else reacts to an MLS status on this site**: no email, draft, lead, note, Lofty tag or Smart
Plan, stage, campaign, milestone or suppression is triggered by a status change. The sold-homes page reads a
static file (`netlify/functions/lib/_sold-homes-data.json`), not the MLS copy; the "Recently sold & open
houses" strip reads Listing Engine's feed. The hub's `_hub.previous_status` / `back_on_market` and
`/v1/mls/changes` are not used: there is no status trigger to feed.

The same status sequences give the same `listings.json`, `mine-listings.json`, town figures and on-market
verdicts through both paths — `tests/test-mls-via-hub.js` sections 2, 3 and 5: Coming Soon→Active,
Active→Pending, Active→Under Contract, Pending→Closed, Pending→Active, Active→Expired (`MlgCanView=false`),
Active→Withdrawn, Active→Canceled and gone, Active→Hold, a price change, a new listing, Expired→Active, with
the hub both deleting hidden listings and answering withheld stubs.

## Speed

| What | Today (MLS Grid) | Through the hub |
|---|---|---|
| A change reaches the market-data copy | ≤ 30 min after MLS Grid has it (crawl every 30 min, `*/30`) | ≤ 15 min at the hub + ≤ 15 min until the next read (`*/30` + `15,45`) = **≤ 30 min** |
| Her Lofty listing hidden once the MLS says off-market | ≤ 60 min (copy ≤ 30, then the next 30-min Lofty refresh reads it) | ≤ 60 min (copy ≤ 30; read by the next Lofty refresh, ≤ 15 or 30 min later) |
| A single-listing check (only for a listing the copy does not hold) | live MLS Grid answer at the next Lofty refresh (≤ 30 min); kept 24 h | the hub's copy (≤ 15 min behind) at the next Lofty refresh (≤ 45 min); kept 24 h |
| Town figures on the town pages | `town-market.yml` Mon + Thu 13:20 UTC (≤ ~3.5 days + the copy's lag) | unchanged |
| Requests per day | MLS Grid: ~48 crawl pages + ≤ 96 lookups (unchanged in MLS Grid mode) | hub: ~192 (one deletion-list + one search call every 15 min) + ≤ 96 lookups; MLS Grid: **0** |

Why the extra run: reading the hub only every 30 minutes would see a change up to 45 minutes late (15 at the
hub + 30). So hub mode also reads at :15 and :45 (`mls-hub-sync.js`, `netlify.toml`). That function does
nothing at all unless `MLS_SOURCE=hub` — no request, no write — so MLS Grid's request volume and her Lofty
refresh (two Lofty requests every 30 minutes) are exactly as before; it never calls Lofty. `/site-health`'s
hub row goes red after 35 minutes without a hub read (`HUB_SYNC_INTERVAL_MINUTES` = 15). The hub can be set
to sync every 5 minutes on Christine's word, which would make the copy ≤ 20 minutes.

## What the hub does not provide, and what this site does

| Missing / different | This site |
|---|---|
| Photos (`Media`) | The copy is market data only; stored photo fields are kept as they were (as the MLS Grid background run already does). No MLS Grid photo is fetched in hub mode. Public MLS listing pages need photos → `LISTINGS_SOURCE=mlsgrid` is refused. |
| Agent names without the `mls:agents` scope | Her own listings are told apart by agent name, so a page of rows with no agent fields is **refused** (nothing applied, "the hub key has no mls:agents scope…"). The key needs `mls:agents`. |
| `PrivateRemarks`, `SyndicationRemarks`, `OnMarketDate`, taxes, HOA, schools, `BathroomsTotalDecimal`, … | Not used by this site. |
| `PublicRemarks` only on IDX rows | Same as MLS Grid's IDX feed; used for the waterfront / equestrian flags, then dropped for other brokerages' listings. |
| Extra fields the hub does send (`ListOfficeName`, `ListOfficeMlsId`, coordinates, dates, `OriginalListPrice`) | Not stored, so the record shape stays identical to the MLS Grid copy. `ListOfficeName` (which MLS Grid rejects on this feed) is available if attribution is ever wanted. |
| Records from MLS systems other than `ires` | This site reads `ires` only either way. |
| Formats | Prices to the cent, strings trimmed, timestamps ISO with milliseconds, `StandardStatus` falling back to `MlsStatus`. With real IRES data these are the same values; a City with stray spaces or a sub-cent price would be stored trimmed / rounded. |
| An Expired listing the hub dropped (no `mls:offmarket`) | The on-market check sees "no record" rather than "Expired": still off the market — except a listing Lofty says was listed in the last 7 days, which the grace rule then keeps as "unknown" (MLS Grid would have said off-market). |
| ListingId with or without the `IRE` prefix | The hub matches both; MLS Grid's filter is exact. Lofty's ids always carry the prefix. |

## Where this site stores and reads the MLS Grid token

Only **`MLSGRID_API_TOKEN`**. `MLS_GRID_API_TOKEN` and `MLS_API_KEY` are not read anywhere in this repository.

Set in: **Netlify → signature-property-collection site → Site configuration → Environment variables**
(listed, empty, in `.env.example:61`). Not in GitHub (the `town-market.yml` job uses `BLOBS_SITE_ID` /
`BLOBS_TOKEN` only) and not on Render (this site is Netlify only). The same MLS Grid account token is used by
Listing Engine and Expired Elite; removing it here does not revoke it there.

Read at:
- `netlify/functions/sync-listings.js:1116` (`mlsGridMarketDataOn`, MLS Grid mode only), `:1095` (the on-market check's token; ignored in hub mode), `:1500` (`mlsGridRun`)
- `netlify/functions/refresh-my-listings.js:45` (the on-market check's token; ignored in hub mode)
- `netlify/functions/listing-photo.js:581`, `netlify/functions/listings-search.js:543`, `netlify/functions/photo-backfill-background.js:78` (MLS Grid photos; `LISTINGS_SOURCE=mlsgrid` only, refused in hub mode)
- `netlify/functions/site-health.js:163` (the market-data row), `:959` (the MLS Grid photo probe; refused in hub mode)

## To turn on (Christine)

1. In Seller Intelligence, the hub flags **`hub_api_enabled`** and **`mls_reads_enabled`** must be on, and the
   hub's MLS copy must be ready (its `GET /v1/mls/status` says `reads_enabled: true` and `copy.ready: true`).
2. This site's hub key needs the scopes **`mls:read`** and **`mls:agents`**. Not `mls:bo` (never for a public
   site) and not `mls:offmarket` (not needed; the site works the same with or without it).
   If this site already has a hub key from the Lofty doorway (wave 1b), add the two scopes to it with
   `hub_api.grant_key_scopes`; otherwise issue one.
3. Netlify → signature-property-collection → Site configuration → Environment variables:
   `HUB_API_URL` and `HUB_API_KEY` (already there if wave 1b is on), and **`MLS_SOURCE` = `hub`**.
   Leave `LISTINGS_SOURCE` unset (Lofty). Redeploy so the new :15/:45 schedule is picked up.
4. Check `/site-health`: the row "Market data from the hub refreshing (optional)" turns green within
   15 minutes and says "no MLS Grid request is made". `/.netlify/functions/mls-usage` should show this site's
   MLS Grid requests falling to zero.

To go back: unset `MLS_SOURCE` (or set it to `mlsgrid`) and redeploy. The copy, its checkpoint and the
verdict cache carry straight back to MLS Grid; nothing to rebuild (needs `MLSGRID_API_TOKEN` still set).

## Removing this site's MLS token once the hub has run clean

After about a week with `MLS_SOURCE=hub` and the hub row green (and a Monday/Thursday town-figures job that
succeeded):

1. Netlify → signature-property-collection → Site configuration → Environment variables → delete
   **`MLSGRID_API_TOKEN`**. Redeploy.
2. Check `/site-health` again: the hub row stays green; "Every listing Lofty reports is still on the MLS"
   still says the listings were confirmed (the check runs in hub mode without the token).
3. From then on, going back to MLS Grid (`MLS_SOURCE` unset) or to `LISTINGS_SOURCE=mlsgrid` needs the token
   put back first; without it the market-data run and the on-market check are simply off.
4. The token itself belongs to the shared MLS Grid account: revoke it at MLS Grid only once Listing Engine and
   Expired Elite have moved too.
