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
//      page in ONE MLS Grid call (OR-joined ListingId clauses -- `in` isn't
//      reliably supported on this feed) and writes them all to the cache before
//      the browser ever asks for an image. So a page costs 1 API call instead
//      of 12, and the image requests are cache hits.
//   2. DON'T POISON THE SYNC. The first pass had listing-photo.js call
//      markSuspended() on a 429, which is the flag sync-listings.js uses to
//      stop itself. A burst of photo requests could therefore pause the
//      15-minute listing sync -- photo traffic taking down data replication.
//      Photo requests now respect that flag but never set it; they set their
//      own, shorter cooldown instead.
const PHOTO_URL_CACHE_PREFIX = "photo-urls/";

// Comfortably inside MLS Grid's ~1-2 hour signature life.
const URL_CACHE_TTL_MS = 40 * 60 * 1000;

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
// Photo traffic's own flag, deliberately separate and much shorter.
const PHOTO_COOLDOWN_KEY = "mlsgrid-photo-cooldown.json";
const PHOTO_COOLDOWN_MS = 45 * 1000;

const BATCH_TIMEOUT_MS = 5000;
const SINGLE_TIMEOUT_MS = 6000;
// One MLS Grid URL has to stay a sane length, and $top bounds the response.
const MAX_IDS_PER_BATCH = 12;

function cacheKey(listingId) {
  return `${PHOTO_URL_CACHE_PREFIX}${listingId}.json`;
}

async function readCachedUrls(store, listingId) {
  const cached = await store.get(cacheKey(listingId), { type: "json" }).catch(() => null);
  if (!cached || !Array.isArray(cached.urls)) return null;
  // An empty entry is a remembered "this listing has no media" verdict and ages
  // out on its own, shorter clock -- see EMPTY_CACHE_TTL_MS.
  const ttl = cached.urls.length ? URL_CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
  const fresh = typeof cached.cachedAt === "number" &&
    Date.now() - cached.cachedAt < ttl;
  // Stale entries are still returned, flagged -- a signed URL a little past our
  // conservative TTL is often still valid, and trying it costs MLS Grid nothing.
  return { urls: cached.urls, fresh };
}

async function writeCachedUrls(store, listingId, urls) {
  await store.setJSON(cacheKey(listingId), { urls, cachedAt: Date.now() }).catch(() => {});
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
async function resolveMediaFor(ids, { store, token, baseUrl, selectFields, timeoutMs }) {
  const wanted = ids.slice(0, MAX_IDS_PER_BATCH).filter(Boolean);
  if (!wanted.length || !token) return {};
  const idClause = wanted.map((id) => `ListingId eq '${id}'`).join(" or ");
  const qs = new URLSearchParams({
    "$filter": `(${idClause}) and MlgCanView eq true`,
    "$select": selectFields,
    "$expand": "Media",
    "$top": String(wanted.length),
  });
  try {
    const res = await fetch(`${baseUrl}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs || BATCH_TIMEOUT_MS),
    });
    if (res.status === 429) {
      // Our own cooldown, NOT the sync's suspension flag.
      await setPhotoCooldown(store);
      return {};
    }
    if (!res.ok) return {};
    const json = await res.json();
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
    console.error("resolveMediaFor failed:", err && err.message);
    return {};
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
    if (cached && cached.fresh) return;
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

function looksPresigned(url) {
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
async function fetchMediaResponse(url, token, timeoutMs) {
  const modes = looksPresigned(url) ? ["anon", "auth"] : ["auth", "anon"];
  let last = null;
  for (const mode of modes) {
    const headers = mode === "auth"
      ? {
        Authorization: `Bearer ${token}`,
        // Inherited from Listing-Engine, which found MLS Grid wants the token
        // echoed here too. Only sent alongside the Authorization header.
        "User-Agent": token,
        Accept: "image/*,*/*;q=0.8",
      }
      : { Accept: "image/*,*/*;q=0.8" };
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // Keep the first transport error, but let the other mode have a go.
      last = last || { res: null, mode, error: (err && err.message) || String(err) };
      continue;
    }
    if (res.ok) return { res, mode };
    last = { res, mode };
    // Only an auth-shaped rejection is worth retrying the other way. A 404 or a
    // 500 means something else entirely.
    if (res.status !== 401 && res.status !== 403) break;
  }
  return last;
}

module.exports = {
  PHOTO_URL_CACHE_PREFIX,
  URL_CACHE_TTL_MS,
  PHOTO_COOLDOWN_MS,
  SINGLE_TIMEOUT_MS,
  cacheKey,
  readCachedUrls,
  writeCachedUrls,
  isThrottled,
  setPhotoCooldown,
  mediaUrlsFrom,
  resolveMediaFor,
  prewarmPhotoUrls,
  looksPresigned,
  fetchMediaResponse,
};
