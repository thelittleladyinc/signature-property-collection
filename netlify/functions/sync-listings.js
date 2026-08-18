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
  BASE_URL, SELECT_FIELDS, REPLICATED_STATUSES, OPERATING_COUNTIES,
  LISTINGS_KEY, SYNC_STATE_KEY, MINE_LISTINGS_KEY, AGENT_SURNAME, mapListing, getBlobStore,
} = require("./lib/_mls-shared");
const { cachePhotoToCloudinary, isCloudinaryConfigured } = require("./lib/_cloudinary");
const { recordMlsCall, checkMlsQuota, pruneUsage, bytesFromResponse } = require("./lib/_mls-usage");
const { drainFailedPushes } = require("./lib/_lofty");

// 2026-08-13 (diagnostics): Christine added the CLOUDINARY_* env vars but
// her own listings are still all serving raw MLS Grid URLs. cacheCoverPhoto
// IfHers below has always swallowed the real reason into a console.warn
// that neither of us can see (Netlify function logs aren't reachable from
// here) — so this has been unfalsifiable from outside Netlify's dashboard.
// Fix: capture the real error (or "not_configured" if the three env vars
// still aren't all set) into this module-scope variable, reset at the top
// of every invocation, and surface it through SYNC_STATE_KEY -> the
// listings-search.js ?debug=true endpoint. Module scope is safe here
// specifically because it's explicitly reset first thing in the handler
// below -- a warm-started Netlify Function reusing this module between
// invocations would otherwise leak a stale error from a previous run.
let _lastCloudinaryError = null;

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
// 2026-08-16, RAISED 8000 -> 11000 on documented evidence rather than a guess.
//
// Netlify's own docs state a 30-SECOND execution limit for scheduled functions
// (docs.netlify.com/build/functions/scheduled-functions — synchronous functions
// get 10s, background functions 15min, scheduled functions 30s). The comment above
// inferred "~15s" from an observed 499, which is a reasonable read of a symptom but
// was never checked against the documentation.
//
// Why this mattered enough to change: with LATE_WORK_TIME_MARGIN_MS at 6000, a
// budget of 8000 left a 2000ms window in which ANY loop could start new work --
// including the bootstrap crawl -- and one throttle wait (1500ms) plus one
// $expand=Media fetch nearly exhausts it. That is why the catalog crawl reported
// lastRunPagesFetched 0 and sat at 18,226 of ~19,000 listings.
//
// 11000 gives a 5000ms start window, 2.5x the throughput, and by this file's own
// worst-case reasoning (work starts at budget - margin, then runs its full ~8s)
// tops out near 13s -- comfortably under the documented 30s AND under the 15s the
// observed 499 suggested. Deliberately NOT raised to the full 30s: the 499s were
// real, the incremental checkpoint saves below bound the damage of a timeout to
// the current chunk rather than the whole run, and there is no reason to spend the
// entire limit to fix a 2000ms window. See tests/test-budget.js, which asserts the
// worst case stays under a stated ceiling so this can't quietly creep.
const TIME_BUDGET_MS = 11000;
// The most any one sub-task may take of the run's budget. Exists so a failing
// side-task can never starve the listing replication that is this function's
// actual job -- see the 2026-08-16 note in the priority pass below, where a
// broken Cloudinary account was consuming 100% of every run.
const PRIORITY_PASS_BUDGET_FRACTION = 0.4;

// A Cloudinary error that will fail identically no matter how many times it is
// retried, because the account or credentials are wrong rather than busy.
// Deliberately narrow: anything not matched here is treated as transient and
// keeps its normal retries.
function isCloudinaryConfigError(message) {
  return /cloud_name mismatch|invalid signature|invalid api.?key|unknown api.?key|disabled account/i
    .test(String(message || ""));
}
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
//
// 2026-08-14 (bumped 4000 -> 6000, paired with the new 4000ms caps on the
// MLS Grid photo download and Cloudinary upload in _cloudinary.js): real
// Netlify logs showed 502/499s on sync-listings once photo uploads started
// actually succeeding (see that file's 2026-08-14 comment for the full
// story). A single photo attempt can now take up to ~8s worst case (4s
// download + 4s upload) — requiring 6s of margin before starting one means
// the absolute worst case (new work starts at TIME_BUDGET_MS - 6000, then
// runs its full 8s) tops out around TIME_BUDGET_MS + 2000, comfortably
// under the ~15s the observed 499 suggests Netlify's real limit is here.
const LATE_WORK_TIME_MARGIN_MS = 6000;
// 2026-08-15 -- THE REASON ZERO PHOTOS WERE EVER CACHED.
//
// Every call site of cacheCoverPhotoIfHers() is gated behind
// `elapsed < TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS`, which after the
// 4000 -> 6000 bump above means "only in the first 2000ms of a run". But every
// one of those call sites sits downstream of at least one throttle() +
// $expand=Media fetch, and REQUEST_DELAY_MS alone is 1500ms before that heavy
// request even starts. So in practice the window had already closed by the time
// any listing was in hand, on every run, forever. Site health showed the exact
// signature of this: Cloudinary configured, zero Cloudinary errors, and 0 of 11
// listings cached -- the code was never called, so it could not error.
//
// The bump wasn't wrong (it fixed real 499/502 timeouts once uploads started
// succeeding); it just had this side effect. Rather than loosen the margin and
// re-introduce the timeouts, Christine's OWN listings now get their photos
// cached by a dedicated pass that runs FIRST, before any crawling, with its own
// budget derived from the real ceiling instead of from leftover time.
//
// Sizing: a photo attempt is capped at 4s download + 4s upload = ~8s worst
// case, and observed 499s put Netlify's real limit near 15s. So a new attempt
// only starts while elapsed < 7000ms, keeping the worst case at ~15s including
// the attempt itself. Starting from elapsed ~= 0 that reliably yields one
// attempt per run, and a second when the first was quick.
const OWN_PHOTO_START_CUTOFF_MS = 7000;
// Belt and braces on top of the time cutoff, so a run can never queue an
// unbounded number of uploads if every one returns instantly.
const OWN_PHOTO_MAX_ATTEMPTS_PER_RUN = 3;
// 2026-08-14: every raw MLS Grid fetch() in this file used to have no
// timeout at all — a slow (not failing) response could hang indefinitely,
// same class of bug as the uncapped photo download/upload calls this
// pairs with. Applied to every MLS Grid request below.
const MLS_FETCH_TIMEOUT_MS = 5000;

function statusClause() {
  return "(" + REPLICATED_STATUSES.map((s) => `StandardStatus eq '${s}'`).join(" or ") + ")";
}

// 2026-08-13 (prune fix): a listing that goes off-market (sells, gets
// withdrawn, expires, goes under a status outside REPLICATED_STATUSES) OR
// gets its MlgCanView flag flipped to false was never actually removed from
// storage, even though the per-record handling below (both here and in
// refreshOneListing) already knows how to delete a disqualified record the
// moment it sees one. The reason it never saw one: every INCREMENTAL query
// filtered server-side on `MlgCanView eq true and (StandardStatus eq
// 'Active' or ...)` -- so the instant a stored listing's status or
// MlgCanView flag changed to something disqualifying, that exact change is
// what made MLS Grid stop returning the record at all, even though its
// ModificationTimestamp legitimately advanced. The sync would then never
// see it again, and the stale (e.g. actually-sold) listing would sit in
// Blobs and on the public site forever, looking active. This is the
// dataset's actual pruning gap, not just unbounded growth.
// Fix: only apply the MlgCanView/status filters on the BOOTSTRAP pass
// (sinceTimestamp is falsy there), where it's correct and intentional --
// never pull sold/closed/non-viewable data into storage in the first
// place. Once bootstrapped, the incremental pass filters ONLY by
// OriginatingSystemName + ModificationTimestamp, so ANY change to an
// already-known listing (including one that disqualifies it) comes back
// and hits the existing "delete if disqualified" logic below / in
// refreshOneListing. MlgCanView/StandardStatus are both in MLS Grid's
// allowed-filter-fields list, so this is just choosing to filter on fewer
// of them for the incremental pass -- still fully within their contract.
// MLS Grid v2: "Each request must contain a single OriginatingSystemName specified
// in the filter criteria of the request." It was inlined here and MISSING from the
// three single-purpose queries below, which is very likely the real explanation for
// the behaviour refreshOneListing documents as MLS Grid "silently ignoring a
// ListingId filter and returning an unrelated record" -- that is what an unscoped
// query looks like from the outside.
const ORIGINATING_SYSTEM_CLAUSE = "OriginatingSystemName eq 'ires'";

// 2026-08-18: every MLS Grid request from this job now goes through one function,
// so all four call sites are measured and gated identically. Before this, the job
// paced itself carefully and then had no idea what it had spent -- which is the
// gap that made §2.6 a guess rather than a measurement.
//
// The guard uses the FULL 24-hour picture rather than just this hour: the sync is
// the site's bulk consumer and runs on a schedule, so it can afford the extra blob
// reads, and it is the path where a runaway crawl would actually threaten the
// daily cap. Photo requests use the cheap one-hour check instead.
//
// Returns the Response. Throws MlsQuotaError when the budget says no, so a caller
// that does not handle it stops rather than continuing blind.
class MlsQuotaError extends Error {}

async function mlsFetch(url, token, store, { full } = {}) {
  const quota = await checkMlsQuota(store, { full: full !== false });
  if (quota.blocked) {
    throw new MlsQuotaError(`quota guard refused the request — ${quota.reason}`);
  }
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(MLS_FETCH_TIMEOUT_MS),
    });
    await recordMlsCall(store, {
      kind: "api", status: res.status,
      bytes: bytesFromResponse(res),
    });
    return res;
  } catch (err) {
    // A timeout still spent a request. Counting it is the difference between
    // "we were quiet" and "we were failing", which look identical otherwise.
    await recordMlsCall(store, { kind: "api", status: 0, bytes: 0 });
    throw err;
  }
}

function baseFilter(sinceTimestamp) {
  const clauses = [ORIGINATING_SYSTEM_CLAUSE];
  if (sinceTimestamp) {
    clauses.push(`ModificationTimestamp gt ${sinceTimestamp}`);
  } else {
    clauses.push("MlgCanView eq true", statusClause());
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

// 2026-08-13 (performance fix): every save of the full listings blob also
// writes a small MINE_LISTINGS_KEY copy containing just Christine's own
// listings, so listings-search.js can answer mine=true requests (the vast
// majority of traffic — see the file comment on MINE_LISTINGS_KEY in
// _mls-shared.js) without reading the full regional dataset. Cheap: this
// is always a handful of records, and Object.values+filter over the
// already-in-memory listingsById is negligible next to the Blobs write
// itself. Called from all three checkpoint-save sites below so the small
// copy never lags behind the full one.
async function saveListingsCheckpoint(store, listingsById) {
  await store.setJSON(LISTINGS_KEY, listingsById);
  const mineListings = Object.values(listingsById).filter(isHerListing);
  await store.setJSON(MINE_LISTINGS_KEY, mineListings);
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
//
// 2026-08-13 (stuck-crawl fix): real Netlify function logs showed listing
// IRE1059947 retrying ALL 11 of its photos on every single 15-minute run —
// every attempt was failing (Cloudinary "Invalid Signature" + MLS Grid
// HTTP 429s), and the old CLOUDINARY_PHOTOS_PER_LISTING_PER_RUN cap only
// counted uploadedThisCall (successes), so a listing where every attempt
// fails was never actually capped — it burned the entire remaining time
// budget every run, starving the main bootstrap crawl loop (confirmed via
// logs: one invocation's Duration was 11754ms against an 8000ms budget),
// which is why totalListingsStored got stuck at the same number run after
// run. Now capped by ATTEMPTS, not successes, and each attempt goes through
// the same account-wide throttle() gate as every other MLS Grid request
// this run, since the unthrottled photo fetches were also the direct cause
// of the logged 429s (a real risk of another full account suspension).
// `deadlineMs` (2026-08-15): how far into the run this function may still START
// a photo attempt. The crawl call sites pass nothing and keep the original
// conservative late-work window; the dedicated own-photo pass passes its own,
// larger budget. Without this parameter the pass was pointless -- it ran first,
// then hit this same 2000ms window from the inside and broke immediately, which
// is the second half of why 0 of 11 photos were ever cached.
async function cacheCoverPhotoIfHers(mapped, previouslyStored, token, startedAt, throttle, deadlineMs) {
  if (!mapped.photos || !mapped.photos.length || !isHerListing(mapped)) return 0;
  if (!isCloudinaryConfigured()) {
    _lastCloudinaryError = "not_configured: one or more of CLOUDINARY_CLOUD_NAME/" +
      "CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET isn't set (or isn't visible to " +
      "scheduled functions yet -- a fresh deploy after adding them sometimes helps)";
    return 0; // fall back to the raw MLS Grid URLs
  }

  const already = (previouslyStored && Array.isArray(previouslyStored.cloudinaryPhotos))
    ? previouslyStored.cloudinaryPhotos.slice()
    : (previouslyStored && previouslyStored.cloudinaryPhoto ? [previouslyStored.cloudinaryPhoto] : []);
  const cloudinaryPhotos = mapped.photos.map((_, i) => already[i] || null);
  let uploadedThisCall = 0;
  let attemptsThisCall = 0;

  for (let i = 0; i < mapped.photos.length; i += 1) {
    if (cloudinaryPhotos[i]) continue; // already cached from an earlier run
    // Cap by ATTEMPTS, not successes -- see the 2026-08-13 note above. A
    // listing where every attempt fails must still stop after this many
    // tries per run, or it consumes the whole time budget forever.
    if (attemptsThisCall >= CLOUDINARY_PHOTOS_PER_LISTING_PER_RUN) break;
    const cutoff = deadlineMs != null ? deadlineMs : TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS;
    if (startedAt && Date.now() - startedAt > cutoff) break;
    attemptsThisCall += 1;
    if (throttle) await throttle();
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
      const msg = `${mapped.listingId} photo ${i}: ${(err && err.message) || "unknown error"}`;
      console.warn(`sync-listings: Cloudinary cache failed for ${msg}`);
      _lastCloudinaryError = msg.slice(0, 300);
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
async function refreshOneListing(listingId, listingsById, store, token, startedAt, throttle, photoDeadlineMs) {
  const qs = new URLSearchParams({
    "$filter": `${ORIGINATING_SYSTEM_CLAUSE} and ListingId eq '${listingId}' and MlgCanView eq true`,
    "$select": SELECT_FIELDS,
    "$expand": "Media",
    "$top": "1",
  });
  const res = await mlsFetch(`${BASE_URL}?${qs.toString()}`, token, store);
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
  const photosCached = await cacheCoverPhotoIfHers(mapped, previouslyStored, token, startedAt, throttle, photoDeadlineMs);
  mapped.photosRefreshedAt = new Date().toISOString();
  listingsById[mapped.listingId] = slimForStorage(mapped);
  return { refreshed: true, cached: photosCached > 0, photosCached };
}

// 2026-08-14 (office-wide discovery, part 1 -- find the ID): Christine's own
// listings are currently only found by walking the ENTIRE regional feed and
// text-matching her surname on the agent field -- see the 2026-08-13
// comment above for why that's slow. ListOfficeMlsId is one of the seven
// fields MLS Grid's Property resource actually allows filtering on
// (confirmed directly against their docs), so a dedicated `ListOfficeMlsId
// eq '<id>'` query could find her listings in one or two fast requests
// instead of waiting for the slow walk to reach them. But this exact feed
// (IRES, via this exact MLS Grid account) has a real, repeated history of
// rejecting "obvious" RESO field names under their standard names --
// WaterfrontFeatures, ListOfficeName, ListAgentDirectPhone, and
// ListAgentEmail all came back with a 400 "does not exist or is unable to
// be retrieved" the first time they were tried (see _mls-shared.js's file
// comment) -- so there's real reason to be cautious about ListOfficeMlsId
// too, rather than trust MLS Grid's docs blindly.
//
// This function is the one and only place that ever puts ListOfficeMlsId in
// a $select -- a single, tiny, try/caught request against a listing we
// already know is hers (found the normal way), completely isolated from
// the main crawl's SELECT_FIELDS (proven-stable, never touched here) and
// from refreshOneListing (used every run for real work -- also never
// touched here). If MLS Grid rejects this the same way it rejected
// ListOfficeName, this just returns null and nothing else in the file is
// affected -- the existing agent-name-match approach keeps working exactly
// as it does today. Only runs once per deploy, effectively -- see the
// `if (!state.herOfficeMlsId)` guard around the call site below -- so a
// rejection costs one extra request per run, forever, which is negligible
// next to REQUEST_DELAY_MS pacing.
async function discoverHerOfficeMlsId(listingsById, token, store) {
  const known = Object.values(listingsById).find((l) => l.listingId && isHerListing(l));
  if (!known) return null; // nothing to look up from yet -- try again once bootstrap finds at least one
  try {
    const qs = new URLSearchParams({
      "$filter": `${ORIGINATING_SYSTEM_CLAUSE} and ListingId eq '${known.listingId}' and MlgCanView eq true`,
      "$select": "ListingId,ListOfficeMlsId",
      "$top": "1",
    });
    const res = await mlsFetch(`${BASE_URL}?${qs.toString()}`, token, store);
    if (!res.ok) return null; // includes a 400 if this feed rejects the field -- fails silently, retried next run
    const json = await res.json();
    const officeMlsId = (json.value || [])[0] && (json.value || [])[0].ListOfficeMlsId;
    return officeMlsId || null;
  } catch (err) {
    console.warn(`sync-listings: office ID discovery failed: ${err && err.message}`);
    return null;
  }
}

// 2026-08-14 (office-wide discovery, part 2 -- use the ID): once
// state.herOfficeMlsId is known, this runs every invocation as a fast
// supplement to the priority pass above -- it can find a brand-new listing
// of Christine's the very run it's entered into MLS, instead of waiting for
// the slow regional walk to eventually reach it (which, during a bootstrap
// pass over ~19,000 records, could otherwise take a long time). Bounded to
// OFFICE_DISCOVERY_MAX_PAGES per run, same throttle() gate as everything
// else, and its $select is the proven-stable SELECT_FIELDS -- ListOfficeMlsId
// only ever appears in the $filter here, never in $select, so this call
// carries none of the "is this field even selectable" risk discoverHer
// OfficeMlsId above already absorbed on its own.
const OFFICE_DISCOVERY_MAX_PAGES = 3;
async function discoverListingsByOffice(officeMlsId, listingsById, store, token, startedAt, throttle) {
  const qs = new URLSearchParams({
    "$filter": `${ORIGINATING_SYSTEM_CLAUSE} and ListOfficeMlsId eq '${officeMlsId}' and MlgCanView eq true and ${statusClause()}`,
    "$select": SELECT_FIELDS,
    "$expand": "Media",
    "$top": String(PAGE_SIZE),
  });
  let url = `${BASE_URL}?${qs.toString()}`;
  let found = 0;
  let pages = 0;
  try {
    while (url && pages < OFFICE_DISCOVERY_MAX_PAGES) {
      if (Date.now() - startedAt > TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS) break;
      await throttle();
      const res = await mlsFetch(url, token, store);
      if (res.status === 429) {
        await markSuspended(store, SUSPENSION_COOLDOWN_MS);
        return { suspended: true, found };
      }
      if (!res.ok) {
        // ListOfficeMlsId got rejected as a $filter field (or some other
        // 4xx) -- give up for this run, same graceful-degrade spirit as
        // everything else in this file. The existing agent-name-match walk
        // is completely unaffected either way.
        console.warn(`sync-listings: office-wide discovery got HTTP ${res.status} — skipping this run.`);
        return { found };
      }
      pages += 1;
      const json = await res.json();
      for (const item of json.value || []) {
        const mapped = mapListing(item);
        if (!mapped.listingId) continue;
        if (mapped.mlgCanView === false || !REPLICATED_STATUSES.includes(mapped.status)) continue;
        const isNew = !listingsById[mapped.listingId];
        const previouslyStored = listingsById[mapped.listingId];
        if (Date.now() - startedAt < TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS) {
          await cacheCoverPhotoIfHers(mapped, previouslyStored, token, startedAt, throttle);
        }
        mapped.photosRefreshedAt = new Date().toISOString();
        listingsById[mapped.listingId] = slimForStorage(mapped);
        if (isNew) found += 1;
      }
      url = json["@odata.nextLink"] || null;
    }
  } catch (err) {
    console.warn(`sync-listings: office-wide discovery exception: ${err && err.message}`);
  }
  return { found };
}

// ---------------------------------------------------------------------------
// 2026-08-15 -- WHY THE SYNC STOPPED COMPLETING AT ALL.
//
// Site health showed: last successful run frozen at 11:01Z, lastRunError null,
// lastRunPagesFetched 1, and 18,925 listings stored. Those together point at
// one thing: saveAll() loads the ENTIRE listing store into memory and writes
// the whole object back on every single run. At ~19k records each carrying
// PublicRemarks (often 1-2KB) plus a full photos[] array, that blob had grown
// into the tens of megabytes. Parsing, mutating and re-serialising it stopped
// fitting inside the function's wall clock -- and it dies BEFORE the line that
// records lastRunAt/lastRunError, which is exactly why the failure was
// invisible: the last numbers you can see are from the last run that survived.
//
// Two size reductions, both chosen so nothing a visitor can see changes:
//
//   1. `remarks` is dropped for listings that aren't Christine's. Verified
//      unused in the UI -- nothing in build.py renders it. Its ONLY consumer is
//      the waterfront keyword test in matchesQuery(), so that test is
//      pre-computed into the boolean `waterfront` here and the raw text is
//      discarded. Biggest single win: remarks are the largest field by far.
//   2. `photos[]` is dropped for listings that aren't Christine's, keeping the
//      cover `photo` and a `photoCount`. listings-search.js already sends only
//      those two to the browser, never the array. And for other brokers'
//      listings the array is dead weight regardless -- those are raw MLS Grid
//      URLs, which are single-use, expire in an hour, and which MLS Grid's own
//      docs forbid putting on a website. Only Christine's listings get
//      Cloudinary-rehosted, so only hers need the array kept.
//
// Christine's own listings are never slimmed, so nothing about her own
// inventory, photos or galleries is affected.
// Equine words that mean the property is actually set up for horses, not just
// rural. "horse" on its own is intentionally excluded: "horseshoe" shows up in
// street and subdivision names all over Northern Colorado ("Horseshoe Lake",
// "Horseshoe Bend"), so it's matched as "horse property"/"horses" instead.
const EQUESTRIAN_STRONG = [
  "horse property", "horses allowed", "horses welcome", "zoned for horses",
  "horse setup", "horse facility", "horse barn", "horse arena", "equestrian",
  "loafing shed", "riding arena", "round pen", "stalls", "corral",
  "tack room", "hay barn", "irrigated pasture",
];
// These only count when paired with one of the words below, since a "barn" or
// "pasture" by itself describes most acreage out here.
const EQUESTRIAN_WEAK = ["barn", "pasture", "paddock", "outbuildings"];
const EQUESTRIAN_WEAK_PARTNER = ["horse", "equine", "livestock", "stall", "arena"];

function hasEquestrianKeywords(remarksLower) {
  if (!remarksLower) return false;
  if (EQUESTRIAN_STRONG.some((k) => remarksLower.includes(k))) return true;
  if (EQUESTRIAN_WEAK.some((k) => remarksLower.includes(k))) {
    return EQUESTRIAN_WEAK_PARTNER.some((k) => remarksLower.includes(k));
  }
  return false;
}

function slimForStorage(mapped) {
  if (isHerListing(mapped)) return mapped;

  const remarks = (mapped.remarks || "").toLowerCase();
  const waterfrontByKeyword = remarks.includes("riverfront") ||
    remarks.includes("river frontage") || remarks.includes("waterfront");

  const slim = { ...mapped };
  slim.waterfront = mapped.waterfront === true || waterfrontByKeyword || null;
  // 2026-08-15 (Christine: "do we want to add an advanced search with
  // riverfront property or if its esquetarian"). Same trick as waterfront
  // above, and for the same reason: the keyword test has to run BEFORE remarks
  // are discarded, because after this function there is no text left to search.
  //
  // Deliberately not a remarks scan at query time and not a new MLS field:
  // this feed has a documented history of rejecting standard RESO field names
  // outright (WaterfrontFeatures, ListOfficeName, ListAgentDirectPhone and
  // ListAgentEmail all 400'd, see SELECT_FIELDS in _mls-shared.js), and a 400
  // in the main crawl's $select breaks the whole sync. HorseYN/HorseAmenities
  // are worth probing later in an isolated try/catch the way
  // discoverHerOfficeMlsId() does, but that needs a live token to verify, so
  // keywords are what ships today.
  //
  // Phrases chosen to be specific enough to avoid obvious false positives:
  // "pasture" and "barn" alone would catch half the acreage in Weld County, so
  // they only count alongside an explicitly equine word.
  slim.equestrian = mapped.equestrian === true || hasEquestrianKeywords(remarks) || null;
  delete slim.remarks;

  if (Array.isArray(slim.photos)) {
    slim.photoCount = slim.photos.length;
    slim.photo = slim.photo || slim.photos[0] || null;
    delete slim.photos;
  }
  // Always null on this IRES feed (see SELECT_FIELDS' history in
  // _mls-shared.js) -- storing 19k nulls costs bytes for nothing.
  delete slim.officeName;
  delete slim.agentPhone;
  delete slim.agentEmail;
  return slim;
}

// One-time (per run) cleanup of what's ALREADY stored, so the blob shrinks on
// the first run that completes rather than only as the crawl happens to
// re-reach each record -- which at 50 records per run would take months.
// Applies the same slimming as above, and drops out-of-area listings when
// OPERATING_COUNTIES is set (never Christine's own -- same rule as everywhere
// else in this file).
function pruneAndSlimStore(listingsById) {
  let slimmed = 0;
  let dropped = 0;
  for (const id of Object.keys(listingsById)) {
    const l = listingsById[id];
    if (!l) { delete listingsById[id]; continue; }
    if (OPERATING_COUNTIES.size > 0 && l.county && !OPERATING_COUNTIES.has(l.county) && !isHerListing(l)) {
      delete listingsById[id];
      dropped += 1;
      continue;
    }
    if (!isHerListing(l) && (l.remarks || Array.isArray(l.photos))) {
      listingsById[id] = slimForStorage(l);
      slimmed += 1;
    }
  }
  if (slimmed || dropped) {
    console.log(`sync-listings: store cleanup — slimmed ${slimmed}, dropped ${dropped} out-of-area listing(s).`);
  }
  return { slimmed, dropped };
}

// 2026-08-15: caches cover photos for Christine's OWN listings ahead of
// everything else. Only touches listings that don't already have a permanent
// Cloudinary photo, so once they're all cached this returns immediately and the
// bootstrap crawl gets the full time budget back.
//
// It re-fetches each listing rather than reusing the stored photo URLs on
// purpose: MLS Grid media URLs are signed, single-use and expire in an hour
// (see _cloudinary.js), so anything already in Blobs is dead by now and only a
// fresh $expand=Media response carries a usable link.
function hasPermanentPhoto(listing) {
  if (!listing || !listing.photo) return false;
  try {
    return new URL(listing.photo).host.indexOf("cloudinary") !== -1;
  } catch (e) {
    return false;
  }
}

async function cacheOwnPhotosFirst(listingsById, store, token, startedAt, throttle) {
  const needsPhoto = Object.values(listingsById)
    .filter((l) => l.listingId && isHerListing(l) && !hasPermanentPhoto(l))
    // Oldest-touched first so one stubborn listing can't monopolise every run.
    .sort((a, b) => {
      const at = a.photosRefreshedAt ? Date.parse(a.photosRefreshedAt) : 0;
      const bt = b.photosRefreshedAt ? Date.parse(b.photosRefreshedAt) : 0;
      return at - bt;
    });

  if (!needsPhoto.length) return { attempted: 0, cached: 0, remaining: 0 };

  let attempted = 0;
  let cached = 0;
  for (const listing of needsPhoto) {
    if (attempted >= OWN_PHOTO_MAX_ATTEMPTS_PER_RUN) break;
    if (Date.now() - startedAt >= OWN_PHOTO_START_CUTOFF_MS) break;
    attempted += 1;
    await throttle();
    try {
      const result = await refreshOneListing(
        listing.listingId, listingsById, store, token, startedAt, throttle,
        OWN_PHOTO_START_CUTOFF_MS,
      );
      if (result.suspended) {
        console.error("sync-listings: own-photo pass hit 429 — suspension breaker opened, stopping pass.");
        break;
      }
      if (result.photosCached) cached += result.photosCached;
    } catch (err) {
      console.warn(`sync-listings: own-photo pass failed for ${listing.listingId}: ${err && err.message}`);
    }
  }
  const remaining = needsPhoto.length - cached;
  console.log(
    `sync-listings: own-photo pass — ${attempted} attempted, ${cached} cached, ` +
    `${remaining} of Christine's listings still without a permanent photo.`
  );
  return { attempted, cached, remaining };
}

exports.handler = async () => {
  const token = process.env.MLSGRID_API_TOKEN;
  if (!token) {
    console.error("sync-listings: MLSGRID_API_TOKEN not set, skipping run.");
    return { statusCode: 200, body: "no token configured" };
  }

  const store = getBlobStore(getStore);
  const startedAt = Date.now();
  _lastCloudinaryError = null; // see the 2026-08-13 diagnostics note above

  // Our own budget, before MLS Grid's. Checked once at the top so a blocked run
  // ends cleanly with a reason on record, rather than throwing out of the middle
  // of a pass -- and so the kill switch (MLS_DISABLED) has somewhere obvious to
  // take effect. Old usage buckets are pruned here because this is the only code
  // path on the site that runs on a schedule and already budgets its own time.
  const quota = await checkMlsQuota(store, { full: true });
  if (quota.blocked) {
    console.warn(`sync-listings: skipping this run — ${quota.reason}`);
    await pruneUsage(store);
    return { statusCode: 200, body: `quota guard: ${quota.reason}` };
  }
  await pruneUsage(store);

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
  // Shrink what's already stored before doing anything else -- see
  // pruneAndSlimStore's comment. Cheap (pure in-memory) and idempotent.
  pruneAndSlimStore(listingsById);

  // ---- Retry any website lead that failed to reach Lofty ----------------
  // 2026-08-15 (Christine: "submitted - but still didnt come into lofty"). A
  // lead that fails the live push is queued with its full payload; this drains
  // that queue so it arrives on a later run instead of waiting for someone to
  // notice. Deliberately first, tiny (at most 3 per run), and fully isolated:
  // Lofty has nothing to do with listing replication, so it must never be able
  // to slow it down or fail it.
  let loftyDrain = { attempted: 0, recovered: 0 };
  try {
    loftyDrain = await drainFailedPushes(store, process.env.LOFTY_API_KEY);
    if (loftyDrain.attempted) {
      console.log(`sync-listings: retried ${loftyDrain.attempted} queued Lofty lead(s), ` +
        `${loftyDrain.recovered} recovered, ${loftyDrain.stillQueued} still queued.`);
    }
  } catch (err) {
    console.error("sync-listings: Lofty queue drain failed (ignored):", err && err.message);
  }

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

  // ---- Christine's own photos, FIRST. Before any crawling, because the
  // leftover-time window this used to depend on never actually opened -- see
  // OWN_PHOTO_START_CUTOFF_MS above. No-ops once they're all cached. ----
  const ownPhotoResult = await cacheOwnPhotosFirst(listingsById, store, token, startedAt, throttle);
  coverPhotosCached += ownPhotoResult.cached;

  // ---- Office-wide discovery: learn Christine's ListOfficeMlsId once (if
  // this feed allows it -- see discoverHerOfficeMlsId's comment above for
  // why that's not assumed), then use it every run as a fast supplement to
  // the priority pass below. Entirely best-effort: if either step fails or
  // is never able to run, nothing else in this file changes behavior. ----
  if (!state.herOfficeMlsId) {
    const discovered = await discoverHerOfficeMlsId(listingsById, token, store);
    if (discovered) {
      state = { ...state, herOfficeMlsId: discovered };
      console.log(`sync-listings: discovered ListOfficeMlsId=${discovered} for Christine's office -- office-wide fast discovery is now active.`);
    }
  }
  let newlyDiscoveredByOffice = 0;
  if (state.herOfficeMlsId) {
    const officeResult = await discoverListingsByOffice(state.herOfficeMlsId, listingsById, store, token, startedAt, throttle);
    newlyDiscoveredByOffice = officeResult.found || 0;
    if (officeResult.suspended) {
      lastRunError = "MLS Grid 429: rate limited during office-wide discovery — suspension circuit breaker opened for 5 minutes";
      console.error(`sync-listings: ${lastRunError}`);
      httpErrorOccurred = true;
    }
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

  // 2026-08-16, FOUND BY AUDIT and this is the real bug behind a symptom nobody
  // had explained: her /status showed "Last ran 5 minute(s) ago" with
  // lastRunPagesFetched 0 and lastRunRecordsSeen 0, and an initial catalog crawl
  // stuck at $skip=12400 while claiming to be "in progress".
  //
  // CAUSE, corrected on a second sweep. My first write-up of this said the
  // priority pass "consumed the entire 8-second budget". That was wrong, and the
  // arithmetic matters too much to leave a wrong explanation in the file:
  //
  //   TIME_BUDGET_MS                = 8000
  //   LATE_WORK_TIME_MARGIN_MS      = 6000   (sized for a ~8s photo upload)
  //   => every time-gated loop here, INCLUDING the bootstrap crawl, may only
  //      START new work in the first 8000 - 6000 = 2000ms of a run.
  //   REQUEST_DELAY_MS              = 1500   (one throttle wait)
  //
  // So the real failure is not that the priority pass ate 8 seconds. It is that
  // the whole function only has a 2000ms window to start anything, and the work
  // queued ahead of the crawl -- the Lofty drain, then one throttle plus one
  // $expand=Media fetch in this pass -- exceeds 2000ms on its own. By the time
  // the crawl is reached, its own cutoff has already passed, so it breaks
  // immediately and reports lastRunPagesFetched 0. Cloudinary's broken
  // credentials are what keeps this pass non-empty forever (isFullyCached can
  // never become true), so the starvation repeats every 15 minutes instead of
  // ending once the photos cached.
  //
  // Two guards. Both are real fixes; the first is the one that frees the crawl:
  //
  //   1. NO SUB-TASK MAY EAT THE SHARED WINDOW. The priority pass is capped at a
  //      fraction of it, leaving the rest for replication no matter what else is
  //      failing. That property should have existed from the start.
  //   2. Don't retry a CONFIGURATION failure. cloud_name mismatch and friends
  //      fail identically every attempt, so hammering 11 listings every 15
  //      minutes is pure waste. Transient errors keep their normal retries.
  //
  // DONE 2026-08-16: the structural fix this note used to defer. Netlify's docs
  // state a 30s limit for scheduled functions, so TIME_BUDGET_MS went 8000 -> 11000
  // (see its comment) and the start-work window went 2000ms -> 5000ms. Not raised
  // to the full 30s on purpose -- the observed 499s were real and there is no need
  // to spend the whole limit to fix a 2000ms window.
  const priorityCutoff = Math.floor((TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS) * PRIORITY_PASS_BUDGET_FRACTION);
  const cloudConfigBroken = isCloudinaryConfigError(state && state.lastCloudinaryError);
  if (cloudConfigBroken && herPendingIds.length) {
    console.error(`sync-listings: skipping the photo-caching priority pass for ` +
      `${herPendingIds.length} listing(s) — Cloudinary's credentials are misconfigured ` +
      `("${state.lastCloudinaryError}"), so every attempt would fail the same way and the ` +
      `catalog crawl would be starved of its time budget. Fix the CLOUDINARY_* env vars to re-enable.`);
  }

  for (const listingId of (cloudConfigBroken ? [] : herPendingIds)) {
    if (Date.now() - startedAt > priorityCutoff) break;
    await throttle();
    try {
      const result = await refreshOneListing(listingId, listingsById, store, token, startedAt, throttle);
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
  await saveListingsCheckpoint(store, listingsById);

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

        const res = await mlsFetch(requestUrl, token, store);
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
          // 2026-08-14 (market scoping): only actually filters anything once
          // Christine sets OPERATING_COUNTIES -- see that constant's comment
          // in _mls-shared.js. Never drops one of her OWN listings, and
          // never drops a listing whose county couldn't be inferred (a gap
          // in the city lookup table shouldn't silently hide a real home).
          if (OPERATING_COUNTIES.size > 0 && mapped.county && !OPERATING_COUNTIES.has(mapped.county) && !isHerListing(mapped)) {
            if (mapped.listingId) delete listingsById[mapped.listingId];
            continue;
          }
          if (mapped.listingId) {
            const previouslyStored = listingsById[mapped.listingId];
            if (Date.now() - startedAt < TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS) {
              const photosCached = await cacheCoverPhotoIfHers(mapped, previouslyStored, token, startedAt, throttle);
              coverPhotosCached += photosCached;
            }
            mapped.photosRefreshedAt = new Date().toISOString();
            listingsById[mapped.listingId] = slimForStorage(mapped);
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
        await saveListingsCheckpoint(store, listingsById);
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
          lastCloudinaryError: _lastCloudinaryError,
          herOfficeMlsId: state.herOfficeMlsId || null,
          lastRunNewlyDiscoveredByOffice: newlyDiscoveredByOffice,
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
          const result = await refreshOneListing(staleListing.listingId, listingsById, store, token, startedAt, throttle);
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
    // The budget tripping mid-run is a deliberate stop, not a fault. Recording it
    // as "exception: ..." would put a red row on site-health for the guard doing
    // exactly its job, and the next person would go looking for a bug.
    if (err instanceof MlsQuotaError) {
      lastRunError = `quota guard: ${err.message}`;
      console.warn(`sync-listings: ${lastRunError}`);
    } else {
      lastRunError = `exception: ${err && err.message}`;
      console.error("sync-listings: exception during sync", err);
    }
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
  await saveListingsCheckpoint(store, listingsById);
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
    lastCloudinaryError: _lastCloudinaryError,
    herOfficeMlsId: state.herOfficeMlsId || null,
    lastRunNewlyDiscoveredByOffice: newlyDiscoveredByOffice,
  });

  console.log(
    `sync-listings: fetched ${pagesFetched} page(s), ${recordsSeen} record(s), ` +
    `pass ${passComplete ? "complete" : "paused (resumes next run)"}, ` +
    `${Object.keys(listingsById).length} listing(s) now stored, ` +
    `${coverPhotosCached} cover photo(s) cached to Cloudinary, ` +
    `${staleListingsRefreshed} stale listing(s) refreshed, ` +
    `${newlyDiscoveredByOffice} newly discovered via office-wide lookup.`
  );

  return { statusCode: 200, body: "ok" };
};
