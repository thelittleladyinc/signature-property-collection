// Scheduled function (see netlify.toml — runs every 15 minutes, MLS Grid's
// own recommended replication cadence, well inside the 12-hour maximum
// refresh interval required by IDX Rule 12) that replicates Christine's
// licensed IRES listings into Netlify Blobs.
//
// This exists because MLS Grid's Property resource rejects live $filter
// queries on ListPrice/City/etc. — see _mls-shared.js's file comment for
// the exact error and why "replicate on a schedule, filter your own copy"
// is the only integration pattern MLS Grid actually allows. listings-search.js
// (the function the browser calls on every search) reads what this job
// writes; it never talks to MLS Grid directly anymore.
//
// Bootstrap vs. incremental: the very first runs page through EVERY
// currently-allowed listing (there's no way to know the count in advance,
// and MLS Grid's Best Practices Guide explicitly warns against range
// queries on ModificationTimestamp for the initial pull). Each invocation
// is time-boxed well under Netlify's 30s scheduled-function limit — if a
// pass isn't finished, the @odata.nextLink cursor is saved to Blobs and the
// *next* scheduled run (15 min later) picks up exactly where this one left
// off, so a large initial catalog bootstraps over a few runs without ever
// timing out or losing progress. Once bootstrapped, every run is a small,
// fast incremental pull (only records modified since the last completed
// pass), per MLS Grid's own recommended pattern.
//
// 2026-08-12 (photo staleness fix): MLS Grid's Media URLs are signed with a
// short TTL (~1-2 hours, confirmed live) — storing them here forever meant
// listing photos silently 400'd on the public site once that window passed,
// for any listing incremental sync wasn't touching anymore. Two-part fix,
// informed by reviewing Christine's other MLS Grid integrations
// (Listing-Engine, Expired-Luxury) before building this:
//   1. Christine's OWN listings (mine=true, small set) get their cover
//      photo permanently re-hosted on Cloudinary the first time they're
//      seen — see cacheCoverPhotoIfHers() below. This mirrors the exact
//      pattern already proven in Listing-Engine's photos.js: MLS Grid's
//      MediaURL requires a Bearer token to fetch, which Cloudinary's own
//      remote-fetch upload mode can't send, so we download the bytes
//      ourselves and hand Cloudinary a Buffer instead (see _cloudinary.js).
//   2. Everyone else's listings (the wider luxury search) can't all be
//      Cloudinary-cached cheaply, so instead a small bounded "refresh
//      sweep" (see the stale-listing loop below) re-touches a few of the
//      stalest-photo listings every run, so nothing goes stale forever —
//      just capped so it can never spike request volume.
// IMPORTANT: signature-property-collection shares ONE MLS Grid account
// (one MLSGRID_API_TOKEN) with Listing-Engine and Expired-Luxury —
// confirmed with Christine directly. MLS Grid enforces its rate limits per
// ACCOUNT, not per app, so this file can't reason about the other two
// apps' traffic — it can only keep its OWN footprint small and back off
// hard the moment MLS Grid signals trouble. That's what the suspension
// circuit breaker below is for (same pattern Listing-Engine's mls.js uses,
// persisted to Blobs here since Netlify Functions don't keep in-memory
// state between invocations the way Listing-Engine's always-on server does).
const { getStore } = require("@netlify/blobs");
const {
  BASE_URL, SELECT_FIELDS, REPLICATED_STATUSES,
  LISTINGS_KEY, SYNC_STATE_KEY, AGENT_SURNAME, mapListing, getBlobStore,
} = require("./_mls-shared");
const { cachePhotoToCloudinary, isCloudinaryConfigured } = require("./_cloudinary");

const TIME_BUDGET_MS = 20000; // leave headroom under the 30s function limit
const PAGE_SIZE = 50; // kept small since $expand=Media makes each record heavy
// 2026-08-12 (rate-limit fix): MLS Grid suspended API access today (and
// several times before, per notify@mlsgrid.com emails going back to
// mid-July) for exceeding their request-rate limits. Their own numbers:
// warning at >4 requests/sec at any instant or >7200/hour, temporary
// suspension at >6 req/sec or >18000/hour. This loop was firing requests
// back-to-back with zero delay -- a single bootstrap run was measured
// fetching 140 pages inside the 20s time budget, i.e. ~7 req/sec sustained,
// already past the "warning" line on its own; stacked with anything else
// hitting the same token in the same window (a manual "Run now", overlapping
// invocations, etc.) it's easy to blow past the suspension threshold, which
// is exactly what happened (MLS Grid logged 13 req/sec for this hour).
// Suspension is temporary and self-clears once usage drops back under the
// limit for a while, but it stalls the sync in the meantime, so the real
// fix is to just never send requests that fast. A fixed delay between pages
// keeps this comfortably under every limit above (roughly 1.4 req/sec) at
// the cost of fewer pages per 15-minute run -- the bootstrap pass just takes
// a few more cycles to finish, which is fine; nothing here is time-critical
// beyond IDX Rule 12's 12-hour refresh requirement.
//
// 2026-08-12 (bumped further, photo-fix pass): reviewing Listing-Engine's
// own mls.js turned up that IT started at this same 600-700ms pacing and
// still got a real "API Access Warning" email from MLS Grid for hitting
// 4 req/sec — they bumped to 1500ms (~0.67 req/sec) afterward and documented
// it as "the safe side" of the real 2 req/sec sustained limit MLS Grid
// actually enforces. Since this app shares the same account/token as
// Listing-Engine, matching their hard-learned number here (rather than
// re-discovering it the same way) is the responsible choice.
const REQUEST_DELAY_MS = 1500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- MLS Grid suspension circuit breaker (Blobs-persisted) ----
// Mirrors Listing-Engine's mls.js isMlsGridSuspended/markMlsGridSuspended,
// but persisted to Blobs instead of an in-memory flag: a Netlify Function
// is a fresh process every invocation, so an in-memory flag would reset on
// literally the next run and never actually stop anything.
const SUSPENSION_KEY = "mlsgrid-suspension.json";
const SUSPENSION_COOLDOWN_MS = 5 * 60 * 1000; // 5 min, same window Listing-Engine uses

async function readSuspension(store) {
  const state = await store.get(SUSPENSION_KEY, { type: "json" });
  const until = state && state.suspendedUntil;
  return typeof until === "number" && until > Date.now() ? until : null;
}

async function markSuspended(store, cooldownMs) {
  await store.setJSON(SUSPENSION_KEY, { suspendedUntil: Date.now() + cooldownMs });
}

// ---- Photo refresh-sweep tuning (the "everyone else" side of the fix) ----
// Small and bounded on purpose — this exists to keep already-stored,
// unchanged listings' photo URLs from going stale forever, not to
// aggressively re-pull the whole regional dataset every run. At most this
// adds REFRESH_SWEEP_BATCH_SIZE extra single-listing requests per 15-minute
// run (well inside the REQUEST_DELAY_MS pacing above).
const REFRESH_SWEEP_BATCH_SIZE = 5;
// Stop starting new work (photo caching or the refresh sweep) once less
// than this much of the time budget remains, so neither one risks pushing
// a run past Netlify's hard limit.
const LATE_WORK_TIME_MARGIN_MS = 4000;

function statusClause() {
  return "(" + REPLICATED_STATUSES.map((s) => `StandardStatus eq '${s}'`).join(" or ") + ")";
}

function baseFilter(sinceTimestamp) {
  const clauses = [
    "OriginatingSystemName eq 'ires'",
    "MlgCanView eq true",
    statusClause(),
  ];
  if (sinceTimestamp) {
    clauses.push(`ModificationTimestamp gt ${sinceTimestamp}`);
  }
  return clauses.join(" and ");
}

// True when this listing is one of Christine's own (same check
// matchesQuery() in _mls-shared.js uses for mine=true) — only her own
// listings get the Cloudinary treatment; there are only ever a handful of
// them, so caching costs stay small and predictable.
function isHerListing(mapped) {
  const surname = AGENT_SURNAME;
  const agent = (mapped.agentName || "").toLowerCase();
  const coAgent = (mapped.coAgentName || "").toLowerCase();
  return agent.includes(surname) || coAgent.includes(surname);
}

// Permanently re-hosts a listing's cover photo on Cloudinary the first
// time it's seen. Safe to call every time this listing is processed —
// it no-ops immediately if already cached, and no-ops (falls back to the
// raw, eventually-expiring MLS Grid URL) if Cloudinary env vars aren't
// set yet, so nothing breaks before Christine adds them in Netlify.
async function cacheCoverPhotoIfHers(mapped, previouslyStored, token) {
  if (!mapped.photo || !isHerListing(mapped)) return;
  if (previouslyStored && previouslyStored.cloudinaryPhoto) {
    // Already cached from an earlier run — reuse it, no MLS Grid or
    // Cloudinary call needed. (We intentionally never re-check whether the
    // source photo changed; re-caching automatically isn't worth the extra
    // MLS Grid requests for a handful of listings whose cover photo rarely
    // changes after the initial upload. A future manual "recache" admin
    // action could force this if it's ever actually needed.)
    mapped.cloudinaryPhoto = previouslyStored.cloudinaryPhoto;
    mapped.photo = previouslyStored.cloudinaryPhoto;
    if (mapped.photos && mapped.photos.length) mapped.photos[0] = previouslyStored.cloudinaryPhoto;
    return;
  }
  if (!isCloudinaryConfigured()) return; // fall back to the raw MLS Grid URL
  try {
    const publicId = `spc-listings/${mapped.listingId}/cover`;
    const secureUrl = await cachePhotoToCloudinary(mapped.photo, token, publicId);
    if (secureUrl) {
      mapped.cloudinaryPhoto = secureUrl;
      mapped.photo = secureUrl;
      if (mapped.photos && mapped.photos.length) mapped.photos[0] = secureUrl;
    }
  } catch (err) {
    // Don't let a photo-caching failure break the sync — the listing still
    // gets stored with its (eventually-expiring) raw MLS Grid photo, and
    // this just retries on the next run.
    console.warn(`sync-listings: Cloudinary cache failed for ${mapped.listingId}: ${err && err.message}`);
  }
}

exports.handler = async () => {
  const token = process.env.MLSGRID_API_TOKEN;
  if (!token) {
    console.error("sync-listings: MLSGRID_API_TOKEN not set, skipping run.");
    return { statusCode: 200, body: "no token configured" };
  }

  const store = getBlobStore(getStore);
  const startedAt = Date.now();

  const suspendedUntil = await readSuspension(store);
  if (suspendedUntil) {
    const waitSec = Math.ceil((suspendedUntil - Date.now()) / 1000);
    console.warn(`sync-listings: MLS Grid suspension circuit breaker open for another ${waitSec}s — skipping this run entirely.`);
    return { statusCode: 200, body: `mls grid suspended for ${waitSec}s more` };
  }

  let state = (await store.get(SYNC_STATE_KEY, { type: "json" })) || {
    bootstrapped: false,
    cursor: null,
    lastModified: null,
  };

  let listingsById = (await store.get(LISTINGS_KEY, { type: "json" })) || {};
  let requestUrl;
  if (state.cursor) {
    // Mid-pass (bootstrap or incremental) — the saved nextLink already
    // encodes the full query, just keep following it.
    requestUrl = state.cursor;
  } else {
    const filter = baseFilter(state.bootstrapped ? state.lastModified : null);
    const qs = new URLSearchParams({
      "$filter": filter,
      "$select": SELECT_FIELDS,
      "$expand": "Media",
      "$top": String(PAGE_SIZE),
      "$orderby": "ModificationTimestamp asc",
    });
    requestUrl = `${BASE_URL}?${qs.toString()}`;
  }

  let pagesFetched = 0;
  let recordsSeen = 0;
  let maxModTimestampThisPass = state.lastModified;
  // 2026-08-12: surfaced into sync-state.json (and from there into
  // listings-search.js's ?debug=true response) so a failed MLS Grid call
  // is visible from the browser instead of only in Netlify's own function
  // logs, which we don't have a way to read directly.
  let lastRunError = null;
  // 2026-08-12: tracks whether this run ended because MLS Grid rejected a
  // request (4xx/5xx), as opposed to running out of time budget or a
  // network-level exception. Used below to decide whether it's safe to
  // save `requestUrl` as next run's resume cursor.
  let httpErrorOccurred = false;
  let coverPhotosCached = 0;
  let staleListingsRefreshed = 0;

  try {
    while (requestUrl) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        // Out of time for this invocation — save the cursor and resume on
        // the next scheduled run rather than risk a timeout mid-request.
        break;
      }

      if (pagesFetched > 0) {
        // Throttle: see REQUEST_DELAY_MS comment above. Skipped before the
        // very first request of the run (no prior request to space out
        // from) so it doesn't eat into the time budget for nothing.
        await sleep(REQUEST_DELAY_MS);
      }

      const res = await fetch(requestUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 429) {
        // Same account-wide suspension Listing-Engine's mls.js guards
        // against — open the circuit breaker so neither this run's
        // remaining pages nor the next scheduled run try again until the
        // cooldown passes.
        await markSuspended(store, SUSPENSION_COOLDOWN_MS);
        lastRunError = "MLS Grid 429: rate limited — suspension circuit breaker opened for 5 minutes";
        console.error(`sync-listings: ${lastRunError}`);
        httpErrorOccurred = true;
        break;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        lastRunError = `MLS Grid ${res.status}: ${text.slice(0, 500)}`;
        console.error(`sync-listings: ${lastRunError}`);
        httpErrorOccurred = true;
        break;
      }
      const json = await res.json();
      const items = json.value || [];
      pagesFetched += 1;
      recordsSeen += items.length;

      for (const item of items) {
        const mapped = mapListing(item);
        if (mapped.mlgCanView === false || !REPLICATED_STATUSES.includes(mapped.status)) {
          // Deleted / no-longer-qualifying / off the replicated status set
          // — remove it if we had it, per MLS Grid's MlgCanView contract.
          if (mapped.listingId) delete listingsById[mapped.listingId];
          continue;
        }
        if (mapped.listingId) {
          const previouslyStored = listingsById[mapped.listingId];
          if (Date.now() - startedAt < TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS) {
            await cacheCoverPhotoIfHers(mapped, previouslyStored, token);
            if (mapped.cloudinaryPhoto && (!previouslyStored || !previouslyStored.cloudinaryPhoto)) {
              coverPhotosCached += 1;
            }
          }
          mapped.photosRefreshedAt = new Date().toISOString();
          listingsById[mapped.listingId] = mapped;
        }
        if (mapped.modificationTimestamp &&
          (!maxModTimestampThisPass || mapped.modificationTimestamp > maxModTimestampThisPass)) {
          maxModTimestampThisPass = mapped.modificationTimestamp;
        }
      }

      requestUrl = json["@odata.nextLink"] || null;
    }

    // ---- Refresh sweep: keep the wider (non-Christine) search's photos
    // from going stale forever ----
    // Only runs when there's real time left, MLS Grid hasn't just 429'd us,
    // and the incremental pass above didn't itself hit an error. Picks the
    // REFRESH_SWEEP_BATCH_SIZE listings whose photos were touched longest
    // ago (or never) and re-fetches just those, one at a time, through the
    // same REQUEST_DELAY_MS-throttled gate — so it can never spike request
    // volume no matter how large the stored dataset grows.
    if (!httpErrorOccurred && Date.now() - startedAt < TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS) {
      const touchedThisRun = new Set();
      const stale = Object.values(listingsById)
        .filter((l) => l.listingId)
        // Exclude anything the main incremental loop above already touched
        // THIS run — it was just refreshed moments ago, re-fetching it
        // again in the sweep would just waste a request for nothing.
        .filter((l) => !l.photosRefreshedAt || Date.parse(l.photosRefreshedAt) < startedAt)
        .sort((a, b) => {
          const at = a.photosRefreshedAt ? Date.parse(a.photosRefreshedAt) : 0;
          const bt = b.photosRefreshedAt ? Date.parse(b.photosRefreshedAt) : 0;
          return at - bt; // oldest (or never-refreshed) first
        })
        .slice(0, REFRESH_SWEEP_BATCH_SIZE);

      for (const staleListing of stale) {
        if (Date.now() - startedAt > TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS) break;
        if (touchedThisRun.has(staleListing.listingId)) continue;
        await sleep(REQUEST_DELAY_MS);
        try {
          const qs = new URLSearchParams({
            "$filter": `ListingId eq '${staleListing.listingId}' and MlgCanView eq true`,
            "$select": SELECT_FIELDS,
            "$expand": "Media",
            "$top": "1",
          });
          const res = await fetch(`${BASE_URL}?${qs.toString()}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.status === 429) {
            await markSuspended(store, SUSPENSION_COOLDOWN_MS);
            console.error("sync-listings: refresh sweep hit 429 — suspension circuit breaker opened, stopping sweep.");
            break;
          }
          if (!res.ok) continue; // leave this one stale, try again next run
          const json = await res.json();
          const returned = (json.value || [])[0];
          if (!returned) continue;
          const mapped = mapListing(returned);
          // MLS Grid is documented (per Listing-Engine's own hard-won notes)
          // to sometimes silently ignore a ListingId filter and return an
          // unrelated record — verify before trusting it, same as
          // Listing-Engine's mls.js does.
          if (mapped.listingId !== staleListing.listingId) continue;
          if (mapped.mlgCanView === false || !REPLICATED_STATUSES.includes(mapped.status)) {
            delete listingsById[mapped.listingId];
            continue;
          }
          const previouslyStored = listingsById[mapped.listingId];
          await cacheCoverPhotoIfHers(mapped, previouslyStored, token);
          mapped.photosRefreshedAt = new Date().toISOString();
          listingsById[mapped.listingId] = mapped;
          touchedThisRun.add(mapped.listingId);
          staleListingsRefreshed += 1;
        } catch (err) {
          console.warn(`sync-listings: refresh sweep failed for ${staleListing.listingId}: ${err && err.message}`);
        }
      }
    }
  } catch (err) {
    lastRunError = `exception: ${err && err.message}`;
    console.error("sync-listings: exception during sync", err);
    // Save whatever progress we made before the error, same as a
    // time-budget break — next run resumes from the cursor.
  }

  const passComplete = !requestUrl;
  // 2026-08-12: previously this always saved `requestUrl` as the resume
  // cursor, including when it was the exact URL MLS Grid just rejected
  // with a 4xx (e.g. the WaterfrontFeatures $select bug). That poisoned
  // cursor then got replayed on every subsequent run forever — bypassing
  // the fresh query this code builds from the current SELECT_FIELDS/filter
  // — which is why fixing the underlying field bug in _mls-shared.js never
  // actually took effect in production. On an HTTP rejection specifically,
  // we now discard the cursor instead, so the next run rebuilds a brand
  // new request from scratch using whatever the code currently asks for.
  // (A time-budget break or network exception still resumes from
  // `requestUrl` as before — those aren't proof the query itself is bad.)
  const cursorToSave = httpErrorOccurred ? null : requestUrl;
  await store.setJSON(LISTINGS_KEY, listingsById);
  await store.setJSON(SYNC_STATE_KEY, {
    bootstrapped: state.bootstrapped || passComplete,
    cursor: cursorToSave,
    lastModified: passComplete ? maxModTimestampThisPass : state.lastModified,
    lastRunAt: new Date().toISOString(),
    lastRunPagesFetched: pagesFetched,
    lastRunRecordsSeen: recordsSeen,
    totalListingsStored: Object.keys(listingsById).length,
    lastRunCoverPhotosCached: coverPhotosCached,
    lastRunStaleListingsRefreshed: staleListingsRefreshed,
    lastRunError,
  });

  console.log(
    `sync-listings: fetched ${pagesFetched} page(s), ${recordsSeen} record(s), ` +
    `pass ${passComplete ? "complete" : "paused (resumes next run)"}, ` +
    `${Object.keys(listingsById).length} listing(s) now stored, ` +
    `${coverPhotosCached} cover photo(s) cached to Cloudinary, ` +
    `${staleListingsRefreshed} stale listing(s) refreshed.`
  );

  return { statusCode: 200, body: "ok" };
};
