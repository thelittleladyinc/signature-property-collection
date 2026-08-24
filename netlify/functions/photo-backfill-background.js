// Overnight cover backfill for the WHOLE catalogue — a Netlify BACKGROUND
// function (the -background suffix is what grants the 15-minute budget;
// callers get a 202 immediately and the work continues here).
//
// 2026-08-24. Why this exists, from the MLS Grid account's own usage log:
// 552 of 1,000 requests were listing-photo.js resolving photos on demand for
// listings this site had never stored — one API call per cold listing across
// a 15,471-listing catalogue, all first views, and every burst-second warning
// was several of them landing at once. The fix has two halves:
//
//   1. listing-photo.js no longer resolves cold listings live (it serves a
//      short-TTL placeholder and leaves a photo-demand/ note), and
//   2. THIS function fills the store AHEAD of demand, overnight, at a pace
//      that never troubles anyone — so "cold" becomes a state listings pass
//      through once, in the middle of the night, instead of a permanent tax
//      collected from visitors at 2 requests a head.
//
// MLS Grid's own docs sanction exactly this shape: "you must maintain your own
// copy of all media files" and "there is NEVER a reason to download the same
// media more than once."
//
// PACE MATH. Each stored cover costs one media download plus 1/24th of a
// batched resolve (resolveMediaFor takes 24 ids per `in`-filter call). Every
// call passes the same checkMlsQuota guard and paceMlsCall per-second gate as
// visitor traffic, plus this function's own caps below: at most
// MAX_REQUESTS_PER_RUN requests in a run, at most one run per LOCK_MS. Five
// overnight kicks (sync-listings fires one per half-hour inside the window;
// the lock admits roughly one per 20 minutes) fill ~3,000-4,000 covers a
// night, so the full catalogue stores in about four nights and stays warm
// thereafter — each night's work after that is only what's new.
//
// SAFE TO TRIGGER FROM ANYWHERE. The endpoint is public like every function,
// so it defends itself rather than trusting its caller: outside the overnight
// window it exits, under the lock it exits, over quota it exits, on any 429 it
// stops for the night. A malicious or accidental daytime POST costs a few blob
// reads and no MLS Grid requests.
const { getStore } = require("@netlify/blobs");
const {
  getBlobStore, BASE_URL, SELECT_FIELDS, LISTINGS_KEY,
} = require("./lib/_mls-shared");
const {
  resolveMediaFor, readCachedUrls, usableUrl, markUrlUsed, fetchMediaResponse,
  writeCachedPhoto, photoCacheKey, isThrottled, isMediaThrottled,
  listPhotoDemand, clearPhotoDemand,
} = require("./lib/_media");
const { checkMlsQuota } = require("./lib/_mls-usage");

const BLOB_STORE_NAME = "mls-listings";
const LOCK_KEY = "photo-backfill-lock.json";
const STATUS_KEY = "photo-backfill-status.json";
const CURSOR_KEY = "photo-backfill-cursor.json";

// One run per 20 minutes at most, so overlapping kicks collapse to one worker.
const LOCK_MS = 20 * 60 * 1000;
// Stop starting new work with 90s of the 15-minute budget left.
const RUN_BUDGET_MS = 13.5 * 60 * 1000;
// Hard per-run request ceiling, counted locally: resolves + downloads (a
// download can cost two requests when the auth-mode retry fires, so it is
// counted as what it actually spent). ~900 requests is a quarter of the
// self-imposed hourly budget — roomy overnight, harmless if the window ever
// overlaps real traffic.
const MAX_REQUESTS_PER_RUN = 900;
// 1-5 AM MDT / 12-4 AM MST. Must match the kicker in sync-listings.js.
const OVERNIGHT_UTC_HOURS = [7, 8, 9, 10, 11];
const RESOLVE_BATCH = 24;
const FETCH_TIMEOUT_MS = 8000;

exports.handler = async () => {
  const startedAt = Date.now();
  const store = getBlobStore(getStore, BLOB_STORE_NAME);
  const token = process.env.MLSGRID_API_TOKEN;
  const summary = { startedAt: new Date().toISOString(), stored: 0, requests: 0, stopped: null };

  async function finish(reason) {
    summary.stopped = reason;
    summary.finishedAt = new Date().toISOString();
    await store.setJSON(STATUS_KEY, summary).catch(() => {});
    console.log(`photo-backfill: ${summary.stored} cover(s) stored, ~${summary.requests} request(s), stopped: ${reason}`);
    return { statusCode: 200, body: reason };
  }

  if (!token) return finish("no token configured");
  if (!OVERNIGHT_UTC_HOURS.includes(new Date().getUTCHours())) {
    return finish("outside the overnight window");
  }

  // The lock. Blobs has no atomic compare-and-set, so two simultaneous kicks
  // can both pass this check — the pace gate and quota guard bound the damage,
  // and the sync only kicks once per half hour anyway.
  const lock = await store.get(LOCK_KEY, { type: "json" }).catch(() => null);
  if (lock && typeof lock.until === "number" && lock.until > Date.now()) {
    return finish("another run holds the lock");
  }
  await store.setJSON(LOCK_KEY, { until: Date.now() + LOCK_MS }).catch(() => {});

  if (await isThrottled(store) || await isMediaThrottled(store)) {
    return finish("MLS Grid cooldown active");
  }

  const listingsById = await store.get(LISTINGS_KEY, { type: "json" }).catch(() => null);
  if (!listingsById) return finish("no catalogue stored yet");

  // The catalogue in price order — the money pages sort price-high-to-low, so
  // the listings most likely to be seen store first. The persisted cursor makes
  // successive runs walk successive stretches instead of re-checking the same
  // stored covers every night.
  const candidates = Object.values(listingsById)
    .filter((l) => l && l.listingId && (l.photoCount || 0) > 0)
    .sort((a, b) => (b.price || 0) - (a.price || 0))
    .map((l) => l.listingId);
  const cursorState = await store.get(CURSOR_KEY, { type: "json" }).catch(() => null);
  let cursor = Number(cursorState && cursorState.cursor) || 0;
  if (cursor >= candidates.length) cursor = 0;

  async function saveCursor() {
    await store.setJSON(CURSOR_KEY, { cursor, at: new Date().toISOString() }).catch(() => {});
  }

  // outOfBudget / storeBatch are the shared machinery for both phases: gather
  // ids whose cover is missing, one batched resolve per RESOLVE_BATCH, then the
  // downloads one at a time through the same paced gate as visitor traffic.
  function outOfBudget() {
    if (Date.now() - startedAt > RUN_BUDGET_MS) return "time budget spent";
    if (summary.requests >= MAX_REQUESTS_PER_RUN) return "request cap reached";
    return null;
  }

  async function storeBatch(ids) {
    const quota = await checkMlsQuota(store);
    if (quota.blocked) return `quota guard: ${quota.reason}`;
    const needResolve = [];
    for (const id of ids) {
      if (!usableUrl(await readCachedUrls(store, id), 0)) needResolve.push(id);
    }
    if (needResolve.length) {
      summary.requests += 1;
      await resolveMediaFor(needResolve, {
        store, token, baseUrl: BASE_URL, selectFields: SELECT_FIELDS, timeoutMs: FETCH_TIMEOUT_MS,
      });
    }
    for (const id of ids) {
      const stop = outOfBudget();
      if (stop) return stop;
      try {
        const url = usableUrl(await readCachedUrls(store, id), 0);
        if (!url) continue;
        const attempt = await fetchMediaResponse(url, token, FETCH_TIMEOUT_MS, store);
        await markUrlUsed(store, id, 0);
        summary.requests += (attempt && Array.isArray(attempt.attempts) && attempt.attempts.length) || 1;
        if (attempt && attempt.res && attempt.res.status === 429) {
          return "media host 429 — stopping for the night";
        }
        if (!attempt || !attempt.res || !attempt.res.ok) continue;
        const buf = Buffer.from(await attempt.res.arrayBuffer());
        const ctype = String((attempt.res.headers && attempt.res.headers.get && attempt.res.headers.get("content-type")) || "");
        if (!ctype.startsWith("image/") || buf.length < 2048 || buf.length > 4400000) continue;
        await writeCachedPhoto(store, id, 0, buf, ctype);
        await clearPhotoDemand(store, id);
        summary.stored += 1;
      } catch (err) {
        console.warn(`photo-backfill: ${id} failed: ${err && err.message}`);
      }
    }
    return null;
  }

  // Walks a list of ids, batching the ones whose cover is missing. `onDone` is
  // called for every id fully dealt with in phase 2, which is how the cursor
  // advances past both stored-already ids and just-processed ones.
  async function walk(ids, onDone) {
    let batch = [];
    for (const id of ids) {
      const stop = outOfBudget();
      if (stop) return stop;
      const existing = await store.get(photoCacheKey(id, 0), { type: "json" }).catch(() => null);
      if (existing && (existing.b64 || existing.redirectUrl)) {
        await clearPhotoDemand(store, id);
        if (onDone) onDone(id);
        continue;
      }
      batch.push(id);
      if (batch.length >= RESOLVE_BATCH) {
        const stopped = await storeBatch(batch);
        if (onDone) batch.forEach(onDone);
        batch = [];
        if (stopped) return stopped;
      }
    }
    if (batch.length) {
      const stopped = await storeBatch(batch);
      if (onDone) batch.forEach(onDone);
      if (stopped) return stopped;
    }
    return null;
  }

  // Phase 1: demand notes — the people who saw a placeholder today. Notes for
  // ids not in the catalogue are cleared rather than retried forever.
  const known = new Set(candidates);
  const demanded = [];
  for (const id of await listPhotoDemand(store, 500)) {
    if (known.has(id)) demanded.push(id);
    else await clearPhotoDemand(store, id);
  }
  let stopped = await walk(demanded, null);

  // Phase 2: the catalogue itself, resuming at the cursor and wrapping.
  if (!stopped) {
    const rotation = candidates.slice(cursor).concat(candidates.slice(0, cursor));
    let advanced = 0;
    stopped = await walk(rotation, () => {
      advanced += 1;
      cursor = (cursor + 1) % (candidates.length || 1);
    });
    if (!stopped && advanced >= candidates.length) stopped = "catalogue walk complete";
  }

  await saveCursor();
  return finish(stopped || "catalogue walk complete");
};
