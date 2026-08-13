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
//
// 2026-08-13 (priority pass): the main loop below walks ALL IRES listings
// in ModificationTimestamp order. During the initial bootstrap (which can
// take many hours over a ~19,000-listing regional dataset), Christine's own
// handful of listings could be anywhere in that walk — so cacheCoverPhotoIfHers
// might not reach them for a long time, and the refresh sweep never even
// runs during bootstrap since it only fires when the main loop finishes
// early (time budget left over), which never happens while bootstrapping.
// Her own listings are the actual point of this fix, so they can't be left
// waiting on an unrelated regional crawl to get around to them. The
// priority pass below refreshes her known listings directly, every run,
// before the main loop spends any of the time budget — small and fixed
// (bounded by however many of her listings are already known), and
// effectively free once each one is cached (cacheCoverPhotoIfHers no-ops
// immediately for anything already on Cloudinary, so this only costs real
// MLS Grid requests for the ones not yet cached).
const { getStore } = require("@netlify/blobs");
const {
  BASE_URL, SELECT_FIELDS, REPLICATED_STATUSES,
  LISTINGS_KEY, SYNC_STATE_KEY, AGENT_SURNAME, mapListing, getBlobStore,
} = require("./lib/_mls-shared");
const { cachePhotoToCloudinary, isCloudinaryConfigured } = require("./lib/_cloudinary");

// 2026-08-13 (real timeout found in Netlify's own Observability logs):
// this used to be 20000 on the assumption of a 30s function limit — that
// assumption was wrong. Live logs showed sync-listings POST requests
// returning HTTP 499 (client closed / timed out) on essentially every
// scheduled invocation once photo caching started doing real network work
// (downloading+uploading real photos takes real seconds, unlike the old
// wrong-header fetches which failed near-instantly). A platform kill isn't
// a catchable JS exception — it cuts the process before the try/catch's
// cleanup or the final store.setJSON() calls at the bottom of this file
// ever run, so a timed-out run silently threw away 100% of that run's
// work (every listing pulled, every photo cached) with nothing written to
// Blobs. That's the real reason cloudinaryPhoto never appeared even after
// the User-Agent fix, and why the bootstrap crawl and photosRefreshedAt
// both looked completely frozen run after run. Tightened here for extra
// margin, but the durable fix is the incremental checkpoint saves added
// below (after the priority pass and after each page) — those make a
// timeout lose at most the current chunk of work instead of the whole run.
const TIME_BUDGET_MS = 8000;
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

// 2026-08-13 (full-gallery cache): originally this only cached photos[0]
// (the card thumbnail). But Current Listings' "View All N Photos" lightbox
// pulls from the full photos[] array, so every photo past the cover was
// still a raw, eventually-expiring MLS Grid URL — the gallery button worked
// but every photo inside it 403'd once the signed URL's short TTL passed.
// Extends the same proven pattern (download bytes with the Bearer token,
// hand Cloudinary a Buffer) to every photo, not just the first.
//
// Bounded per call by CLOUDINARY_PHOTOS_PER_LISTING_PER_RUN + the remaining
// time budget, since a brand-new listing can have up to MAX_STORED_PHOTOS
// (12) photos to cache and each one is a real download+upload round trip —
// doing all 12 in one invocation risks blowing Netlify's function time
// limit. Whatever isn't reached this run picks up next run: already-cached
// slots (tracked per-index in previouslyStored.cloudinaryPhotos) are never
// re-uploaded, so this safely converges over a few runs to every photo
// being permanently hosted, without ever re-doing finished work.
const CLOUDINARY_PHOTOS_PER_LISTING_PER_RUN = 4;

// Permanently re-hosts a listing's photos (cover + full gallery) on
// Cloudinary, a few at a time until all are cached. Safe to call every time
// this listing is processed — already-cached photos are skipped instantly,
// and it no-ops (falls back to the raw, eventually-expiring MLS Grid URLs)
// if Cloudinary env vars aren't set yet, so nothing breaks before Christine
// adds them in Netlify. Returns the number of photos newly cached this call
// (for the caller's run-summary counters).
async function cacheCoverPhotoIfHers(mapped, previouslyStored, token, startedAt) {
  if (!mapped.photos || !mapped.photos.length || !isHerListing(mapped)) return 0;
  if (!isCloudinaryConfigured()) return 0; // fall back to the raw MLS Grid URLs

  const already = (previouslyStored && Array.isArray(previouslyStored.cloudinaryPhotos))
    ? previouslyStored.cloudinaryPhotos.slice()
    : (previouslyStored && previouslyStored.cloudinaryPhoto ? [previouslyStored.cloudinaryPhoto] : []);
  const cloudinaryPhotos = mapped.photos.map((_, i) => already[i] || null);
  let uploadedThisCall = 0;

  for (let i = 0; i < mapped.photos.length; i += 1) {
    if (cloudinaryPhotos[i]) continue; // already cached from an earlier run
    if (uploadedThisCall >= CLOUDINARY_PHOTOS_PER_LISTING_PER_RUN) break;
    if (startedAt && Date.now() - startedAt > TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS) break;
    try {
      const publicId = `spc-listings/${mapped.listingId}/photo-${i}`;
      const secureUrl = await cachePhotoToCloudinary(mapped.photos[i], token, publicId);
      if (secureUrl) {
        cloudinaryPhotos[i] = secureUrl;
        uploadedThisCall += 1;
      }
    } catch (err) {
      // Don't let one photo failing break the rest — the listing still gets
      // stored with that slot's (eventually-expiring) raw MLS Grid photo,
      // and this just retries that slot on a later run.
      console.warn(`sync-listings: Cloudinary cache failed for ${mapped.listingId} photo ${i}: ${err && err.message}`);
    }
  }

  if (cloudinaryPhotos.some(Boolean)) {
    mapped.cloudinaryPhotos = cloudinaryPhotos;
    mapped.cloudinaryPhoto = cloudinaryPhotos[0] || undefined; // back-compat with older stored records
    // Serve whichever photos are cached so far; any not-yet-cached slot
    // falls back to its raw MLS Grid URL rather than being dropped, so the
    // gallery's photo count never shrinks while caching is still catching up.
    mapped.photos = mapped.photos.map((raw, i) => cloudinaryPhotos[i] || raw);
    mapped.photo = mapped.photos[0];
  }
  return uploadedThisCall;
}

// Fetches one listing by ListingId, verifies MLS Grid actually honored the
// filter (it's documented — per Listing-Engine's own hard-won notes — to
// sometimes silently ignore a ListingId filter and return an unrelated
// record instead), applies the same cover-photo caching used everywhere
// else, and stores/removes it in listingsById as appropriate. Shared by the
// priority pass (Christine's own listings, below) and the refresh sweep
// (everyone else's stale listings, below) so both go through identical
// logic.
async function refreshOneListing(listingId, listingsById, store, token, startedAt) {
  const qs = new URLSearchParams({
    "$filter": `ListingId eq '${listingId}' and MlgCanView eq true`,
    "$select": SELECT_FIELDS,
    "$expand": "Media",
    "$top": "1",
  });
  const res = await fetch(`${BASE_URL}?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    await markSuspended(store, SUSPENSION_COOLDOWN_MS);
    return { suspended: true };
  }
  if (!res.ok) return { skipped: true };
  const json = await res.json();
  const returned = (json.value || [])[0];
  if (!returned) return { skipped: true };
  const mapped = mapListing(returned);
  if (mapped.listingId !== listingId) return { skipped: true }; // filter was ignored
  if (mapped.mlgCanView === false || !REPLICATED_STATUSES.includes(mapped.status)) {
    delete listingsById[mapped.listingId];
    return { removed: true };
  }
  const previouslyStored = listingsById[mapped.listingId];
  const photosCached = await cacheCoverPhotoIfHers(mapped, previouslyStored, token, startedAt);
  mapped.photosRefreshedAt = new Date().toISOString();
  listingsById[mapped.listingId] = mapped;
  return { refreshed: true, cached: photosCached > 0, photosCached };
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

  let lastRunError = null;
  let httpErrorOccurred = false;
  let coverPhotosCached = 0;
  let staleListingsRefreshed = 0;
  // Tracks whether ANY MLS Grid request has been made yet this run (across
  // the priority pass, the main loop, and the refresh sweep) so exactly one
  // fixed REQUEST_DELAY_MS gap is kept between every consecutive request
  // regardless of which phase makes it, and the very first request of the
  // whole run never waits for nothing.
  let anyRequestMadeThisRun = false;
  async function throttle() {
    if (anyRequestMadeThisRun) await sleep(REQUEST_DELAY_MS);
    anyRequestMadeThisRun = true;
  }

  // ---- Priority pass: Christine's own listings, independent of bootstrap
  // progress (see the 2026-08-13 file-level comment above for why this
  // exists) ----
  // Not-yet-fully-cached means either no cloudinaryPhotos record at all, or
  // one that doesn't yet cover every photo in the listing's current photos
  // array (a partial result from an earlier run's time budget, or a photo
  // count that's grown since the last cache pass).
  const isFullyCached = (l) => Array.isArray(l.cloudinaryPhotos)
    && Array.isArray(l.photos)
    && l.cloudinaryPhotos.length >= l.photos.length
    && l.cloudinaryPhotos.slice(0, l.photos.length).every(Boolean);
  const herPendingIds = Object.values(listingsById)
    .filter((l) => l.listingId && isHerListing(l) && !isFullyCached(l))
    .map((l) => l.listingId);

  for (const listingId of herPendingIds) {
    if (Date.now() - startedAt > TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS) break;
    await throttle();
    try {
      const result = await refreshOneListing(listingId, listingsById, store, token, startedAt);
      if (result.suspended) {
        lastRunError = "MLS Grid 429: rate limited during priority pass — suspension circuit breaker opened for 5 minutes";
        console.error(`sync-listings: ${lastRunError}`);
        httpErrorOccurred = true;
        break;
      }
      if (result.cached) coverPhotosCached += (result.photosCached || 1);
    } catch (err) {
      console.warn(`sync-listings: priority pass failed for ${listingId}: ${err && err.message}`);
    }
  }

  // 2026-08-13 (checkpoint save): write Christine's own listings' progress
  // to Blobs right now, before spending any time budget on the much larger
  // regional crawl below. This is the fix for the real timeout confirmed in
  // Netlify's Observability logs (see the TIME_BUDGET_MS comment above) —
  // her newly-cached cover photos and refreshed data survive even if the
  // main crawl loop or refresh sweep below gets killed by the platform
  // before the function's own final save at the bottom of this file ever
  // runs. Cheap and safe to call this often; Blobs writes are fast and
  // idempotent.
  await store.setJSON(LISTINGS_KEY, listingsById);

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

  try {
    if (!httpErrorOccurred) {
      while (requestUrl) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          // Out of time for this invocation — save the cursor and resume on
          // the next scheduled run rather than risk a timeout mid-request.
          break;
        }

        await throttle();

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
              const photosCached = await cacheCoverPhotoIfHers(mapped, previouslyStored, token, startedAt);
              coverPhotosCached += photosCached;
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

        // 2026-08-13 (checkpoint save): persist after every page, not just
        // once at the end. Same real-timeout problem as the priority-pass
        // checkpoint above — without this, a run that times out partway
        // through a multi-page bootstrap pull saves NOTHING, not even the
        // cursor, so totalListingsStored/cursorPending can look frozen for
        // hours even though real MLS Grid requests are succeeding every
        // run. Saving the cursor here means a timeout mid-crawl resumes
        // from the next page instead of replaying pages already fetched.
        await store.setJSON(LISTINGS_KEY, listingsById);
        await store.setJSON(SYNC_STATE_KEY, {
          bootstrapped: state.bootstrapped,
          cursor: requestUrl,
          lastModified: state.lastModified,
          lastRunAt: new Date().toISOString(),
          lastRunPagesFetched: pagesFetched,
          lastRunRecordsSeen: recordsSeen,
          totalListingsStored: Object.keys(listingsById).length,
          lastRunCoverPhotosCached: coverPhotosCached,
          lastRunStaleListingsRefreshed: staleListingsRefreshed,
          lastRunError: null,
        });
      }
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
        // Exclude anything already touched THIS run (priority pass or the
        // main incremental loop above) — it was just refreshed moments
        // ago, re-fetching it again in the sweep would just waste a
        // request for nothing.
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
        await throttle();
        try {
          const result = await refreshOneListing(staleListing.listingId, listingsById, store, token, startedAt);
          if (result.suspended) {
            console.error("sync-listings: refresh sweep hit 429 — suspension circuit breaker opened, stopping sweep.");
            break;
          }
          if (result.refreshed || result.removed) {
            touchedThisRun.add(staleListing.listingId);
            staleListingsRefreshed += 1;
          }
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
