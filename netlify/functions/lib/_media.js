// Shared photo-URL resolution for listing-photo.js (serves one image) and
// listings-search.js (pre-warms a whole page of them).
//
// 2026-08-15, second pass. The first pass moved listing photos onto this site's
// own domain, which fixed the "no photos at all" problem -- Christine's next
// screenshot showed real photos loading. It also showed the next problem:
// "why some photos in and some are not?" Some cards rendered, some stayed gray,
// on the same page, with the gray ones still reporting "View All 25 Photos" --
// so the data was there and the fetch was what failed.
//
// The cause is a burst. A search page shows 12 cards, the browser requests 12
// images at once, and in the first pass EACH of those was its own function
// invocation making its own MLS Grid API call. MLS Grid's documented limit is
// about 2 requests per second, and that account is shared with Christine's two
// other apps (Listing-Engine and Expired-Luxury), so 12 simultaneous calls
// reliably 429s most of them. Each 429 became a gray placeholder.
//
// Two fixes, both here:
//
//   1. BATCH. listings-search.js resolves the media for every listing on the
//      page in ONE MLS Grid call and writes them all to the cache before the
//      browser ever asks for an image. So a page costs 1 API call instead of 12,
//      and the image requests are cache hits. (This originally OR-joined the
//      ListingId clauses, noting `in` "isn't reliably supported on this feed".
//      MLS Grid's v2 documentation says the opposite -- `in` is new in v2 and
//      PREFERRED, and no more than five `or` operators are allowed per query,
//      which a 12-id batch broke by more than double. See MAX_OR_IDS_PER_REQUEST.)
//   2. DON'T POISON THE SYNC. The first pass had listing-photo.js call
//      markSuspended() on a 429, which is the flag sync-listings.js uses to
//      stop itself. A burst of photo requests could therefore pause the
//      15-minute listing sync -- photo traffic taking down data replication.
//      Photo requests now respect that flag but never set it; they set their
//      own, shorter cooldown instead.
const { recordMlsCall, recordMlsBytes, checkMlsQuota, bytesFromResponse , paceMlsCall } = require("./_mls-usage");

const PHOTO_URL_CACHE_PREFIX = "photo-urls/";

// ---- WHERE THIS SITE'S OWN COPY OF A PHOTO LIVES ------------------------
// 2026-08-18: these three moved here from listing-photo.js because three separate
// files now need to agree about them, and "agree" was previously enforced by a
// comment. listing-photo.js writes the cache, sync-listings.js invalidates it when
// a listing's photos change, and listing-page.js decides how many photos to render
// -- and rendering more than are cached hands the difference straight back to MLS
// Grid, one live download per view, forever.
const PHOTO_CACHE_PREFIX = "photo-cache/";

// The last photo index this site both renders and stores. MLS Grid's rule is
// "There is NEVER a reason to download the same media more than once", so the only
// defensible bound is exactly what a page shows: 12 photos, indexes 0-11.
const PHOTO_CACHE_MAX_INDEX = 11;

function photoCacheKey(listingId, index) {
  return `${PHOTO_CACHE_PREFIX}${listingId}-${index}.json`;
}

// Drops this site's stored copies of a listing's photos. Called when the photo set
// has demonstrably changed, because the cache is keyed by INDEX and MLS Grid keys
// media by MediaKey -- so a listing that gains, loses or re-orders photos would
// otherwise serve yesterday's picture at that index for as long as the listing
// lives. Best-effort: a failed delete costs a stale photo, never a request.
async function invalidatePhotoCache(store, listingId, maxIndex) {
  const upTo = typeof maxIndex === "number" ? maxIndex : PHOTO_CACHE_MAX_INDEX;
  let dropped = 0;

  // 2026-08-18: cheap exit first. The catalogue crawl is walking ~29,000 listings
  // and calls this for every one whose photo count moved; at twelve blob reads
  // each that is hundreds of reads inside an eleven-second budget, spent almost
  // entirely on listings nobody has ever viewed and which therefore have nothing
  // stored at all.
  //
  // Index 0 is the tell. Every path that stores photos stores the cover -- a card
  // stores only the cover, a detail page stores 0 through 11 together -- so no
  // cover means nothing to drop, and one read settles it for the overwhelming
  // majority of listings.
  try {
    const cover = await store.get(photoCacheKey(listingId, 0), { type: "json" });
    if (!cover) return 0;
  } catch (err) {
    console.warn(`invalidatePhotoCache ${listingId} cover probe failed:`, err && err.message);
    return 0;
  }

  for (let i = 0; i <= upTo; i += 1) {
    try {
      const key = photoCacheKey(listingId, i);
      const existing = await store.get(key, { type: "json" });
      if (!existing) continue;
      await store.delete(key);
      dropped += 1;
    } catch (err) {
      console.warn(`invalidatePhotoCache ${listingId}/${i} failed:`, err && err.message);
    }
  }
  return dropped;
}

// 2026-08-17. This was 40 minutes, on the reasoning that it sat "comfortably
// inside MLS Grid's ~1-2 hour signature life". Lifetime was never the binding
// constraint. From MLS Grid's Media documentation:
//
//   "Single-use - the URL may be used to download its image only once. A second
//    request using the same URL will fail."
//   "do not store or cache a Media URL for later use. Retrieve it from the API
//    and download the image promptly."
//
// So a 40-minute cache of URLs guaranteed failure: the first visitor spent each
// URL, and every reload, every other CDN edge and every later visitor in that
// window replayed a URL that was already dead. That is a grey card with nothing
// whatsoever to do with rate limiting -- and it is indistinguishable, from the
// outside, from the 429s that have been chased all day.
//
// Two changes together make this safe. Each index is marked USED the moment a
// download is attempted (markUrlUsed), so it is never handed out twice; and the
// window is short, purely to bridge the gap between prewarmPhotoUrls resolving a
// page and the browser asking for its images seconds later. Nothing here is a
// durable store any more -- the durable store is the PHOTO BYTES, in
// listing-photo.js, which is what the docs actually ask for: "You must maintain
// your own copy of all media files."
const URL_CACHE_TTL_MS = 5 * 60 * 1000;

// How long "this listing resolved to no media" is remembered.
//
// 2026-08-17. resolveMediaFor() used to `continue` past any listing that came
// back with an empty Media array, writing nothing. Since the cache is the only
// thing that stops a lookup, that listing was re-resolved on EVERY page view,
// forever -- and prewarmPhotoUrls() put it back in `needed` every single time.
// A handful of photo-less listings sitting in a popular result set is therefore
// a permanent, self-inflicted drip of MLS Grid requests against an account
// whose rate limits are shared with Christine's two other apps. And each 429 it
// provokes sets the photo cooldown, which turns the OTHER cards on the same
// page grey. So a few listings with no photos could cost photos on listings
// that have them.
//
// Deliberately much shorter than the URL TTL: an empty verdict is about the
// listing's state rather than a signature's lifetime, and a listing that gets
// its photos loaded an hour after hitting the feed should not wait 40 minutes
// to show them. Ten minutes stops the hammering while keeping it responsive.
const EMPTY_CACHE_TTL_MS = 10 * 60 * 1000;

// The sync's flag: respected everywhere, set only by sync-listings.js.
const SYNC_SUSPENSION_KEY = "mlsgrid-suspension.json";
// Photo traffic's own flag, deliberately separate and much shorter. Set when the
// API (api.mlsgrid.com) rate-limits a media RESOLVE.
const PHOTO_COOLDOWN_KEY = "mlsgrid-photo-cooldown.json";
const PHOTO_COOLDOWN_MS = 45 * 1000;

// 2026-08-17, from Christine's debug output on a grey land listing:
//
//   {"httpStatus":429,"mediaHost":"media.mlsgrid.com","attempts":[{"mode":"auth","status":429}]}
//
// A 429 from the MEDIA HOST, and nothing in this codebase backed off from it.
// setPhotoCooldown() had exactly one caller: resolveMediaFor(), which handles a 429
// from the API. The image fetch in listing-photo.js just returned a grey
// placeholder and moved on.
//
// That is self-sustaining. A search page fires a dozen image requests; the media
// host starts refusing; every refusal becomes a grey card AND another request on
// the next view, with nothing anywhere reducing the rate. The limit never gets a
// chance to clear. It is a strong candidate for the "some photos show and some
// don't" pattern that has been chased three times in this file's history.
//
// A SEPARATE key from the resolve cooldown on purpose. These are two different
// resources -- api.mlsgrid.com and media.mlsgrid.com -- and collapsing them means
// an API rate-limit blanks photos whose URLs are already cached and would have
// served fine, which is its own crying-wolf failure. Each backs off from the
// service that actually complained.
const MEDIA_COOLDOWN_KEY = "mlsgrid-media-cooldown.json";
const MEDIA_COOLDOWN_MS = 45 * 1000;

const BATCH_TIMEOUT_MS = 5000;
const SINGLE_TIMEOUT_MS = 6000;
// Matches the maximum `top` listings-search.js will serve (24), so a full page is
// always one request. It was 12 while the maximum page was 24, which silently left
// half a large page unwarmed -- each of those cards then resolving on its own, which
// is the exact burst the prewarm exists to prevent. `in` (below) makes 24 ids as
// cheap as 12; the or-fallback chunks instead.
const MAX_IDS_PER_BATCH = 24;

// MLS Grid v2: "Each request must contain a single OriginatingSystemName specified
// in the filter criteria of the request." It was missing from every media resolve --
// present only in sync-listings.js's replication filter. Beyond being out of spec,
// it is the most plausible explanation for the behaviour this file already works
// around below: a feed that "sometimes ignores a ListingId filter and returns an
// unrelated record" is what an unscoped query looks like.
const ORIGINATING_SYSTEM_NAME = "ires";

// MLS Grid v2: "The query must include no more than 5 'or' operators per query...
// It is preferred to use the in operator instead which is new in version 2.0."
// A 12-id batch was eleven 'or' operators -- more than double the documented
// ceiling, on the highest-frequency call this site makes.
//
// `in` is documented and preferred, so it is what we send. But a photo path that
// fails completely if one assumption about someone else's feed is wrong is not
// worth the elegance, so a 400 falls back to or-chains chunked to five ids -- and
// remembers, so the 400 is paid once per container rather than once per request.
const MAX_OR_IDS_PER_REQUEST = 5;
let _inOperatorRejected = false;

function cacheKey(listingId) {
  return `${PHOTO_URL_CACHE_PREFIX}${listingId}.json`;
}

// Returns { urls, fresh, used } where `used` is the set of indexes whose URL has
// already been handed to a download attempt and is therefore spent. A caller must
// treat a used index as no URL at all -- see usableUrl().
async function readCachedUrls(store, listingId) {
  const cached = await store.get(cacheKey(listingId), { type: "json" }).catch(() => null);
  if (!cached || !Array.isArray(cached.urls)) return null;
  // An empty entry is a remembered "this listing has no media" verdict and ages
  // out on its own, shorter clock -- see EMPTY_CACHE_TTL_MS.
  const ttl = cached.urls.length ? URL_CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
  const fresh = typeof cached.cachedAt === "number" &&
    Date.now() - cached.cachedAt < ttl;
  const used = new Set(Array.isArray(cached.used) ? cached.used : []);
  // Stale entries are still returned, flagged: an unused URL a little past our
  // conservative window is often still inside MLS Grid's own hour, and trying it
  // costs one request. A SPENT one is different -- it is known to fail, so
  // usableUrl() refuses it regardless of freshness.
  return { urls: cached.urls, fresh, used };
}

// The one place that decides whether a cached URL may be used. Single-use is not a
// TTL question, so freshness alone is never enough.
function usableUrl(cached, index) {
  if (!cached || !Array.isArray(cached.urls)) return null;
  if (cached.used && cached.used.has(index)) return null;
  const url = cached.urls[index];
  return typeof url === "string" && url ? url : null;
}

async function writeCachedUrls(store, listingId, urls) {
  await store.setJSON(cacheKey(listingId), { urls, cachedAt: Date.now(), used: [] }).catch(() => {});
}

// Spend an index. Called the moment a download is ATTEMPTED, not when one succeeds:
// a request that reached MLS Grid has consumed the URL whatever it answered, and
// re-offering it to the next visitor would produce a guaranteed failure that looks
// exactly like a rate limit. Best-effort -- if this write is lost, the worst case is
// one wasted request that then re-resolves.
async function markUrlUsed(store, listingId, index) {
  try {
    const cached = await store.get(cacheKey(listingId), { type: "json" });
    if (!cached || !Array.isArray(cached.urls)) return;
    const used = new Set(Array.isArray(cached.used) ? cached.used : []);
    if (used.has(index)) return;
    used.add(index);
    await store.setJSON(cacheKey(listingId), {
      urls: cached.urls, cachedAt: cached.cachedAt, used: Array.from(used),
    });
  } catch (err) {
    console.warn(`markUrlUsed failed for ${listingId}/${index}:`, err && err.message);
  }
}

async function isThrottled(store) {
  const [sync, photo] = await Promise.all([
    store.get(SYNC_SUSPENSION_KEY, { type: "json" }).catch(() => null),
    store.get(PHOTO_COOLDOWN_KEY, { type: "json" }).catch(() => null),
  ]);
  const until = Math.max(
    (sync && typeof sync.suspendedUntil === "number") ? sync.suspendedUntil : 0,
    (photo && typeof photo.until === "number") ? photo.until : 0,
  );
  return until > Date.now() ? until : null;
}

async function setPhotoCooldown(store) {
  await store.setJSON(PHOTO_COOLDOWN_KEY, { until: Date.now() + PHOTO_COOLDOWN_MS }).catch(() => {});
}

// Backoff for the media host specifically. `retryAfterSeconds` honours a
// Retry-After header when the host sends one -- it knows better than our constant
// does -- clamped so a hostile or mistaken value cannot park photos for an hour.
async function setMediaCooldown(store, retryAfterSeconds) {
  var ms = MEDIA_COOLDOWN_MS;
  var n = Number(retryAfterSeconds);
  if (isFinite(n) && n > 0) ms = Math.min(Math.max(n * 1000, 5000), 5 * 60 * 1000);
  await store.setJSON(MEDIA_COOLDOWN_KEY, { until: Date.now() + ms }).catch(() => {});
  return ms;
}

// True when the MEDIA host should be left alone. Respects the sync's suspension
// flag too, since that means the whole account is in trouble.
async function isMediaThrottled(store) {
  const [sync, media] = await Promise.all([
    store.get(SYNC_SUSPENSION_KEY, { type: "json" }).catch(() => null),
    store.get(MEDIA_COOLDOWN_KEY, { type: "json" }).catch(() => null),
  ]);
  const until = Math.max(
    (sync && typeof sync.suspendedUntil === "number") ? sync.suspendedUntil : 0,
    (media && typeof media.until === "number") ? media.until : 0,
  );
  return until > Date.now() ? until : null;
}

// MLS Grid can't sort inside $expand (its docs say so explicitly), so Order
// decides and array position breaks ties -- same rule as mapListing().
function mediaUrlsFrom(record) {
  return (Array.isArray(record && record.Media) ? record.Media.slice() : [])
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ao = typeof a.m.Order === "number" ? a.m.Order : Number.MAX_SAFE_INTEGER;
      const bo = typeof b.m.Order === "number" ? b.m.Order : Number.MAX_SAFE_INTEGER;
      return ao !== bo ? ao - bo : a.i - b.i;
    })
    .map((x) => x.m && x.m.MediaURL)
    .filter(Boolean);
}

// Resolves media for one or many listing ids in a single request. Returns a
// {listingId: urls[]} map of whatever came back, and writes each to the cache.
// Never throws: on any failure it resolves to whatever it managed to get.
// OData string literals escape a single quote by doubling it. Listing ids are
// already validated upstream, so this is belt and braces rather than a live
// injection route -- but an id with an apostrophe would otherwise produce a filter
// that silently means something else.
function odataString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// The documented, preferred shape: one OriginatingSystemName, one `in` list, no
// `or` operators at all.
function inFilter(ids) {
  return `OriginatingSystemName eq ${odataString(ORIGINATING_SYSTEM_NAME)} and ` +
    `ListingId in (${ids.map(odataString).join(",")}) and MlgCanView eq true`;
}

// The fallback, used only after MLS Grid has rejected `in` once. Chunked so it can
// never exceed the documented five-`or` ceiling the way the original did.
function orFilter(ids) {
  const clause = ids.map((id) => `ListingId eq ${odataString(id)}`).join(" or ");
  return `OriginatingSystemName eq ${odataString(ORIGINATING_SYSTEM_NAME)} and ` +
    `(${clause}) and MlgCanView eq true`;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Stores a fetched photo's bytes under the photo-cache key — THE permanent
// copy MLS Grid's rules require ("you must maintain your own copy of all
// media files"). Lived in listing-photo.js until 2026-08-18; moved here so
// the sync's cover backfill and the on-demand path share one implementation.
async function writeCachedPhoto(store, listingId, index, buf, contentType) {
  try {
    await store.setJSON(photoCacheKey(listingId, index), {
      b64: buf.toString("base64"),
      contentType,
      bytes: buf.length,
      storedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`writeCachedPhoto: failed for ${listingId}/${index}:`, err && err.message);
  }
}

async function resolveMediaFor(ids, { store, token, baseUrl, selectFields, timeoutMs }) {
  const all = ids.filter(Boolean);
  if (!all.length || !token) return {};
  if (all.length > MAX_IDS_PER_BATCH) {
    // Never silent. A truncated batch used to look identical to a batch that
    // simply found nothing, which is how half a large page could go unwarmed
    // without leaving a trace anywhere.
    console.warn(`resolveMediaFor: ${all.length} ids requested, ` +
      `resolving the first ${MAX_IDS_PER_BATCH}`);
  }
  const wanted = all.slice(0, MAX_IDS_PER_BATCH);

  // One request in the normal case. Only the `or` fallback splits, and only after
  // MLS Grid has actually rejected `in`.
  const groups = _inOperatorRejected ? chunk(wanted, MAX_OR_IDS_PER_REQUEST) : [wanted];
  const out = {};
  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g];
    // 2 rps is a hard ceiling, so a multi-chunk fallback paces itself rather than
    // firing back to back.
    if (g > 0) await new Promise((r) => setTimeout(r, 550));
    const got = await resolveOneBatch(group, { store, token, baseUrl, selectFields, timeoutMs });
    if (got === null) return out; // throttled or hard failure -- stop asking
    Object.assign(out, got);
  }
  return out;
}

// Returns a {listingId: urls[]} map, or null when the request failed in a way that
// means "stop" (429, timeout, non-ok). The null/{} distinction matters: {} is a
// real answer worth negative-caching, null is an outage that must not be.
async function resolveOneBatch(wanted, { store, token, baseUrl, selectFields, timeoutMs }) {
  const qs = new URLSearchParams({
    "$filter": _inOperatorRejected ? orFilter(wanted) : inFilter(wanted),
    "$select": selectFields,
    "$expand": "Media",
    "$top": String(wanted.length),
  });
  // Before the request, not after the 429. A cooldown reacts to a limit we have
  // already hit; this refuses the request that would hit it. See _mls-usage.js.
  const quota = await checkMlsQuota(store);
  if (quota.blocked) {
    console.warn(`resolveMediaFor: quota guard refused the request — ${quota.reason}`);
    return null;
  }
  // Volume above, SPEED here: at most 2 MLS-bound starts per second across
  // every concurrent lambda — see paceMlsCall in _mls-usage.js and the
  // 2026-08-18 suspension it exists to prevent (10 of these in one second).
  await paceMlsCall(store);
  try {
    const res = await fetch(`${baseUrl}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs || BATCH_TIMEOUT_MS),
    });
    // Measured before anything is decided about the response, so a 429 counts as
    // the request it was. Content-Length is the compressed size on the wire, which
    // is what MLS Grid's MB cap actually meters.
    await recordMlsCall(store, {
      kind: "api", status: res.status,
      bytes: bytesFromResponse(res),
    });
    if (res.status === 429) {
      // Our own cooldown, NOT the sync's suspension flag.
      await setPhotoCooldown(store);
      return null;
    }
    // A 400 on the `in` form means this feed doesn't support it after all. Say so
    // once, remember it, and retry this same batch the documented long way rather
    // than returning a page of grey cards over a query-syntax preference.
    if (res.status === 400 && !_inOperatorRejected) {
      _inOperatorRejected = true;
      console.warn("resolveMediaFor: MLS Grid rejected the `in` operator (400) — " +
        "falling back to chunked `or` filters for the life of this container.");
      const out = {};
      for (const group of chunk(wanted, MAX_OR_IDS_PER_REQUEST)) {
        const got = await resolveOneBatch(group, { store, token, baseUrl, selectFields, timeoutMs });
        if (got === null) return out;
        Object.assign(out, got);
      }
      return out;
    }
    if (!res.ok) return null;
    // Read as text so the payload can be measured. MLS Grid gzips these and sends
    // no Content-Length, so this is the only place the real size is knowable --
    // and without it the MB budget never moves. Deliberately the UNCOMPRESSED
    // size, which over-counts against a cap metered on the wire: a guard that
    // errs strict is the right direction of error.
    //
    // Falls back to .json() when a response has no .text(): real Responses have
    // both, test doubles often have only one, and measurement must never be the
    // reason a photo fails. This is the second time an instrumentation helper
    // assumed more of a Response than a double provides -- hence the belt.
    let json;
    if (typeof res.text === "function") {
      const text = await res.text();
      await recordMlsBytes(store, text.length);
      json = JSON.parse(text);
    } else {
      json = await res.json();
    }
    const out = {};
    // This feed is documented to sometimes ignore a ListingId filter and return
    // an unrelated record, so only ids we actually asked for are accepted.
    const asked = new Set(wanted.map(String));
    for (const record of (json.value || [])) {
      const id = String(record && record.ListingId);
      if (!asked.has(id)) continue;
      const urls = mediaUrlsFrom(record);
      if (!urls.length) continue;
      out[id] = urls;
      await writeCachedUrls(store, id, urls);
    }
    // Remember the misses too. Reaching here means the request itself SUCCEEDED
    // -- the 429, non-ok and timeout paths all returned above -- so an id absent
    // from `out` is a real answer ("no media", or not visible to us), not an
    // outage, and it is safe to cache. Without this, every photo-less listing in
    // a popular result set re-queried MLS Grid on every page view forever. See
    // EMPTY_CACHE_TTL_MS.
    for (const id of wanted) {
      if (!out[String(id)]) await writeCachedUrls(store, id, []);
    }
    return out;
  } catch (err) {
    // A timeout still consumed a request slot at MLS Grid's end, so it is logged
    // rather than forgotten -- an hour of timeouts is exactly the shape of usage
    // that would otherwise look like no usage at all.
    await recordMlsCall(store, { kind: "api", status: 0, bytes: 0 });
    console.error("resolveMediaFor failed:", err && err.message);
    return null;
  }
}

// Called by listings-search.js for the page it's about to return: fills the
// cache for any listing that doesn't already have a fresh entry, so the
// browser's image requests don't each trigger their own API call. Bounded and
// best-effort -- a slow or throttled MLS Grid must never delay search results,
// so a failure here just means those photos resolve individually (and may hit
// the placeholder once) rather than a broken page.
async function prewarmPhotoUrls(listings, { store, token, baseUrl, selectFields, timeoutMs }) {
  if (!token || !Array.isArray(listings) || !listings.length) return 0;
  const throttledUntil = await isThrottled(store);
  if (throttledUntil) return 0;

  const needed = [];
  await Promise.all(listings.slice(0, MAX_IDS_PER_BATCH).map(async (l) => {
    if (!l || !l.listingId) return;
    // A listing whose cover is already re-hosted on Cloudinary never needs a
    // signed URL at all.
    const rehosted = (Array.isArray(l.cloudinaryPhotos) && l.cloudinaryPhotos[0]) || l.cloudinaryPhoto;
    if (typeof rehosted === "string" && rehosted.indexOf("res.cloudinary.com") !== -1) return;
    const cached = await readCachedUrls(store, l.listingId);
    // Fresh is not sufficient: a fresh entry whose cover URL has already been spent
    // is worse than no entry, because it would hand the next visitor a URL that is
    // certain to fail. An empty entry (a remembered "no media" verdict) still
    // counts as warm -- there is nothing to resolve.
    if (cached && cached.fresh && (!cached.urls.length || usableUrl(cached, 0))) return;

    // 2026-08-18: a listing whose cover this site already HOLDS needs no URL at
    // all -- listing-photo.js will serve the stored bytes and never reach MLS Grid.
    // Resolving one anyway is a request spent on a photo nobody is going to fetch,
    // once per page render, forever. On a page of listings people have already
    // browsed that is the difference between one API call and none.
    //
    // Checked only for listings that would otherwise trigger a resolve, so the
    // common warm path still costs exactly one blob read per listing.
    const storedCover = await store.get(photoCacheKey(l.listingId, 0), { type: "json" })
      .catch(() => null);
    if (storedCover) return;

    needed.push(l.listingId);
  }));

  if (!needed.length) return 0;
  const resolved = await resolveMediaFor(needed, {
    store, token, baseUrl, selectFields, timeoutMs: timeoutMs || BATCH_TIMEOUT_MS,
  });
  return Object.keys(resolved).length;
}


// ---- Fetching the image bytes -------------------------------------------
// 2026-08-15, third pass (Christine: "some photos still arent coming up", plus
// her /site-health page showing BOTH "0 of 11" of her own listings on a
// permanent Cloudinary photo AND a Cloudinary error reading:
//     IRE1062480 photo 3: Server returned unexpected status code - 403
//
// A 403 is the giveaway. Every path in this codebase fetched MLS Grid media with
// `Authorization: Bearer <token>` unconditionally, and MLS Grid serves media
// through pre-signed URLs -- the signature is IN the query string. S3 and
// CloudFront reject a request that carries a pre-signed signature AND an
// Authorization header, because that's two auth mechanisms for one request. The
// result is a 403 on exactly the media that is pre-signed, and success on the
// media that isn't, which is precisely the "some photos work and some don't"
// pattern on the page and the reason none of her own photos have ever cached.
//
// So the header is chosen per URL instead of always sent: a URL carrying
// signature parameters is fetched anonymously (it is already authenticated),
// anything else keeps the Bearer token. On a 401/403 the other mode is tried
// once, because the point is to be right under either regime rather than to be
// right about my diagnosis. Which mode succeeded is returned so callers can log
// it and this can be pinned once real traffic proves it.
const PRESIGNED_QUERY_HINTS = [
  "x-amz-signature", "x-amz-credential", "x-amz-security-token",
  "signature=", "expires=", "sig=", "se=", "st=", "token=", "key-pair-id",
];

// 2026-08-17. This read the QUERY STRING only, and returned false when there was
// none. MLS Grid's media URL format effective 8 September 2026 has no query string
// at all -- the signature is in the PATH:
//
//   https://media.mlsgrid.com/token=...&expires=...&id=.../images/MFR.../....jpeg
//
// So every new-format URL was classified as unsigned, which put `auth` first and
// sent Authorization: Bearer alongside a signature -- the exact two-auth-mechanisms
// 403 the mode split was written to avoid. The comment above guessed at this ("a
// path-signed URL would slip past"); MLS Grid's docs confirm it is the format
// everything is moving to, and the 429s and 404s in evidence are already coming
// from media.mlsgrid.com.
//
// The host is now the primary signal, because MLS Grid documents that EVERY Media
// URL it issues is signed. The query hints stay for the legacy AWS/CloudFront URLs
// still in flight until the migration completes.
const SIGNED_MEDIA_HOSTS = new Set(["media.mlsgrid.com"]);

function looksPresigned(url) {
  let host = null;
  try { host = new URL(String(url)).host.toLowerCase(); } catch (err) { host = null; }
  if (host && SIGNED_MEDIA_HOSTS.has(host)) return true;
  const query = (String(url).split("?")[1] || "").toLowerCase();
  if (!query) return false;
  return PRESIGNED_QUERY_HINTS.some((hint) => query.includes(hint));
}

// Returns { res, mode } for the attempt that succeeded, or the last failure.
// Never throws -- neither on an HTTP error (the caller decides what a bad status
// means) nor on a transport error, which is returned as { res: null, mode, error }.
//
// 2026-08-17: it DID throw on a transport error. The comment said "never throws
// on an HTTP error", which was true and beside the point -- a timeout or a socket
// reset propagated out of here, past listing-photo.js's `if (!imgRes) return
// placeholder("image_fetch_failed")`, and into its outer catch, where it became
// the generic "exception" reason. So a self-healing network blip on one photo was
// reported as "the function threw, go read the Netlify logs", which sends you
// looking in the wrong place -- and `image_fetch_failed` was unreachable.
//
// All three callers (listing-photo.js, site-health.js, _cloudinary.js) were
// already written for this shape and check `attempt && attempt.res`; site-health
// even has a branch reading "the image fetch threw with no response" that could
// never fire. Catching here is what they were all waiting for.
//
// A transport failure on one mode still tries the other -- a dropped connection
// says nothing about which auth mode is right.
// 2026-08-17, from Christine's debug output on a land listing that renders grey:
//
//   {"reason":"image_http_error","httpStatus":404,"authMode":"auth",
//    "mediaHost":"media.mlsgrid.com","urlCount":4}
//
// MLS Grid resolved 4 photo URLs for that listing, and fetching photo 0 came back
// 404. Note authMode "auth": looksPresigned() said the URL carried no signature, so
// the Bearer token went out -- and the retry below only ever fired on 401/403, so
// the OTHER mode was never tried. That listing has only ever been fetched one way.
//
// 404 is now retried too. Two readings of that 404 are open, and this settles it
// without another round trip:
//
//   - The photos genuinely no longer exist. These are legacy records (sequential
//     low ids IRE1000029/31), so a purge is entirely plausible, and the second
//     attempt will 404 as well. Nothing lost but one request.
//   - The Bearer header IS the problem and 404 is a masked auth failure. S3 and
//     CloudFront answer 404 rather than 403 for objects a caller may not know
//     exists, and looksPresigned() is a heuristic over query-string hints that a
//     path-signed URL would slip past. Then the anonymous attempt just works, and
//     the photos come back on their own.
//
// This is the same principle the auth-mode split was built on in the first place:
// be right under either regime rather than be right about my diagnosis. Cost is
// bounded at two requests per failing photo, exactly as the 401/403 path already
// was, and only ever on failure.
const RETRY_OTHER_MODE_ON = new Set([401, 403, 404]);

// `store` is optional and only used to record the call. It is a fourth argument
// rather than part of an options object because three callers already pass three
// positional arguments; those that cannot supply a store still work, they just
// go unmeasured.
async function fetchMediaResponse(url, token, timeoutMs, store) {
  const modes = looksPresigned(url) ? ["anon", "auth"] : ["auth", "anon"];
  let last = null;
  // Every attempt, so a caller in debug mode can show which modes were tried and
  // what each said -- the thing that was missing when this 404 first turned up.
  const attempts = [];
  // Same per-second gate as the resolve path — a media download is a request
  // against the same 2 rps account ceiling. Once per call, not per mode: the
  // second mode only runs after the first has already failed, never in parallel.
  await paceMlsCall(store);
  for (const mode of modes) {
    // 2026-08-17: the User-Agent used to be sent ONLY in `auth` mode, described as
    // something "only sent alongside the Authorization header". MLS Grid's docs are
    // unambiguous and it is the opposite of optional:
    //
    //   "ALL requests to download the expanded media using the Media URL MUST
    //    include the HTTP header User-Agent. The User-Agent value MUST be the Oauth
    //    2 access token... Any User-Agent that is not your Oauth 2 access token
    //    will be blocked by our service."
    //
    // So the anonymous mode -- which is the FIRST mode tried for every signed URL,
    // i.e. most of them -- was going out with the platform's default agent and
    // being blocked by rule. The 2026-08-15 change was right that an Authorization
    // header breaks a pre-signed URL, but it dropped the User-Agent along with it
    // and only one of the two was the problem. A User-Agent is not an
    // authentication mechanism; it cannot conflict with a signature.
    const headers = {
      "User-Agent": token,
      Accept: "image/*,*/*;q=0.8",
    };
    if (mode === "auth") headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      var msg = (err && err.message) || String(err);
      await recordMlsCall(store, { kind: "media", status: 0, bytes: 0 });
      attempts.push({ mode, error: msg });
      // Keep the first transport error, but let the other mode have a go.
      last = last || { res: null, mode, error: msg };
      continue;
    }
    // Every attempt counts, including the retry in the other auth mode -- two
    // attempts on one photo really are two requests against the account.
    await recordMlsCall(store, {
      kind: "media", status: res.status,
      bytes: bytesFromResponse(res),
    });
    attempts.push({ mode, status: res.status });
    if (res.ok) return { res, mode, attempts };
    last = { res, mode };
    // A 500 still means something else entirely and is not worth a second request.
    if (!RETRY_OTHER_MODE_ON.has(res.status)) break;
  }
  return last ? Object.assign(last, { attempts }) : { res: null, mode: null, attempts };
}

module.exports = {
  writeCachedPhoto,
  PHOTO_URL_CACHE_PREFIX,
  PHOTO_CACHE_PREFIX,
  PHOTO_CACHE_MAX_INDEX,
  photoCacheKey,
  invalidatePhotoCache,
  URL_CACHE_TTL_MS,
  PHOTO_COOLDOWN_MS,
  SINGLE_TIMEOUT_MS,
  cacheKey,
  readCachedUrls,
  writeCachedUrls,
  usableUrl,
  markUrlUsed,
  ORIGINATING_SYSTEM_NAME,
  MAX_IDS_PER_BATCH,
  isThrottled,
  setPhotoCooldown,
  setMediaCooldown,
  isMediaThrottled,
  MEDIA_COOLDOWN_KEY,
  mediaUrlsFrom,
  resolveMediaFor,
  prewarmPhotoUrls,
  looksPresigned,
  fetchMediaResponse,
};
