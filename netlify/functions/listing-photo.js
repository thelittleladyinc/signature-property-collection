// Serves listing photos from THIS site's domain instead of linking straight
// to MLS Grid's media URLs.
//
// 2026-08-15 (Christine, looking at a live Search Homes page: "still no
// photos", with a screenshot showing every card's image broken). This is the
// last piece of a problem the codebase already understood but had only half
// solved. From sync-listings.js's own 2026-08-12 note:
//
//   "MLS Grid's Media URLs are signed with a short TTL (~1-2 hours, confirmed
//   live) -- storing them here forever meant listing photos silently 400'd on
//   the public site once that window passed"
//
// The fix at the time had two halves. Half one -- re-host Christine's OWN
// listing photos on Cloudinary, permanently -- works. Half two, for everyone
// else's listings, was a "small bounded refresh sweep" of 5 listings per
// 15-minute run. That was the right call for a few hundred listings. The store
// now holds 15,471, so the sweep re-touches roughly 0.03% of them per run and
// the overwhelming majority of stored photo URLs are expired at any given
// moment. Which is exactly what Christine's screenshot shows: a page of cards
// with alt text where the photos should be.
//
// Cloudinary can't be the answer at that scale on a small plan, so this takes
// the other route: the browser asks THIS function for a photo, and the
// function resolves a fresh signed URL from MLS Grid, fetches the bytes with
// the Bearer token (MLS Grid media requires one -- that's why Cloudinary's own
// remote-fetch mode couldn't be used either, see _cloudinary.js), and returns
// the image from our own domain with long cache headers.
//
// Why this is the compliant shape, not a workaround: MLS Grid's media URLs are
// signed, short-lived, and not meant to be embedded in a public page -- which
// is why re-hosting was always the plan for Christine's own listings. This is
// the same re-hosting, with the CDN as the store instead of Cloudinary. Every
// signed URL is used exactly once, by us, server-side.
//
// Cost control, in layers, because the MLS Grid account is shared with
// Christine's two other apps (Listing-Engine and Expired-Luxury) and its rate
// limits are per ACCOUNT:
//   1. Cloudinary URLs never come here at all -- listings-search.js sends
//      those to the browser directly (see photoUrlFor() there).
//   2. One MLS Grid call resolves EVERY photo for a listing, and the resolved
//      list is cached in Blobs for URL_CACHE_TTL_MS -- so opening a 30-photo
//      gallery costs one request, not thirty.
//   3. Successful responses are cached hard at the CDN, so a listing everyone
//      is looking at costs MLS Grid nothing after the first viewer.
//   4. listings-search.js pre-warms the whole page's photo URLs in ONE MLS Grid
//      call before the browser asks for any of them (prewarmPhotoUrls in
//      lib/_media.js), so a 12-card page costs 1 API call, not 12. Added
//      2026-08-15 after Christine asked "why some photos in and some are not?"
//      -- 12 simultaneous invocations each making their own call was tripping
//      MLS Grid's ~2-requests-per-second limit and every 429 became a gray box.
//   5. This function RESPECTS the suspension flag sync-listings.js sets on a
//      429, but never sets it -- it sets a shorter photo-only cooldown instead.
//      The first version set the shared flag, which meant a burst of photo
//      requests could pause the 15-minute listing sync: photo traffic taking
//      down data replication.
//   6. Any failure returns a neutral gray placeholder, cached for a length that
//      depends on WHY it failed (see PLACEHOLDER_TTL): seconds for a rate limit
//      so it self-heals, an hour for a photo that is genuinely gone. A flat short
//      cache on everything is what put a permanent floor under our own request
//      rate -- a dead photo re-asking MLS Grid every five minutes, forever, from
//      every CDN edge, feeding the 429s that then grey out photos which work.
const { getStore } = require("@netlify/blobs");
const { getBlobStore, BASE_URL, SELECT_FIELDS, MINE_LISTINGS_KEY } = require("./lib/_mls-shared");
const {
  readCachedUrls, isThrottled, resolveMediaFor, SINGLE_TIMEOUT_MS, fetchMediaResponse,
  isMediaThrottled, setMediaCooldown, usableUrl, markUrlUsed,
  PHOTO_CACHE_MAX_INDEX, photoCacheKey,
} = require("./lib/_media");
const { checkMlsQuota, recordMlsBytes } = require("./lib/_mls-usage");
// NOT required at module load. lib/_cloudinary.js pulls in the Cloudinary SDK, and
// this is the hottest function on the site -- every photo on every page. Paying
// that import on every cold start, for a branch that only fires on photos too big
// to return inline, is the wrong trade. Required lazily where it is used instead.


const BLOB_STORE_NAME = "mls-listings";
const IMAGE_FETCH_TIMEOUT_MS = 8000;

// Netlify caps a function response at 6 MB, and base64 encoding adds ~33%, so
// 4.4 MB of image is the real ceiling for returning bytes inline.
const MAX_INLINE_IMAGE_BYTES = 4_400_000;

// How long the CDN may serve our copy of a photo. Listing photos do change
// (a re-shoot, a re-ordering), so this isn't immutable -- a day of hard
// caching with a week of stale-while-revalidate keeps MLS Grid traffic near
// zero while still picking changes up.
const IMAGE_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

// ---- LAST-KNOWN-GOOD PHOTO COPY -----------------------------------------
// 2026-08-17. Christine, for the fourth time today: "photos still arent showing".
//
// Every explanation offered so far has been true and none of them fixed anything.
// The cover photo of her Greeley listing is grey because MLS Grid's media host is
// rate-limiting us; the CDN cache does not help, because a photo that never
// succeeded has nothing to cache; and the permanent fix -- Cloudinary re-hosting --
// is blocked on credentials only she can set. Meanwhile her main listings page has
// a hole in it.
//
// So the site keeps its own copy. Once a photo has been fetched successfully even
// ONCE, it is written to Blobs, and every later failure serves that copy instead of
// a grey square. A 429 stops being visible to anyone. This needs no third party, no
// account and no key, and it is strictly better than what the CDN can do: the CDN
// can only remember a success it happened to see at an edge, this remembers it for
// everyone, permanently.
//
// BOUNDED to the photos a page actually renders -- see shouldCachePhoto for why that
// is the bound that matters and why the original "her listings only" bound was
// dropped.
// PHOTO_CACHE_PREFIX / PHOTO_CACHE_MAX_INDEX / photoCacheKey moved to lib/_media.js
// on 2026-08-18: sync-listings.js needs them to invalidate this cache when a
// listing's photos change, and listing-page.js needs the bound to decide how many
// photos to render. Three files agreeing by comment is how they drift.

// Her own listing ids. No longer gates the photo cache (see shouldCachePhoto), kept
// because it is the cheap way to tell her listings apart from the catalogue and the
// next thing that needs that distinction should not re-derive it. Failure is silent
// and returns an empty set.
let _mineIds = null;
async function mineListingIds(store) {
  if (_mineIds) return _mineIds;
  try {
    const raw = await store.get(MINE_LISTINGS_KEY, { type: "json" });
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.listings) ? raw.listings : []);
    _mineIds = new Set(list.map((l) => String((l && (l.listingId || l.ListingId)) || "")).filter(Boolean));
  } catch (err) {
    console.warn("listing-photo: could not read mine-listings.json:", err && err.message);
    _mineIds = new Set();
  }
  return _mineIds;
}

// 2026-08-17, revised within the hour. The first version cached HER listings only,
// on the reasoning that this store also holds the ~27,000-listing IRES catalogue and
// an image cache over that would be gigabytes.
//
// That bound was aimed at the wrong number. Christine looked at her LUXURY SEARCH
// page -- $81.6M in Fraser, $30M in Bennett, other agents' listings -- and had grey
// cards there too, because nothing on that page is hers: Cloudinary does not re-host
// it and this cache would not store it. A search page full of holes is still a
// broken search page.
//
// Growth here is bounded by TRAFFIC, not by catalogue size. A cover is only written
// after somebody actually looks at that listing, so fifty browsed listings costs
// about 15MB. The catalogue total is the theoretical ceiling of a page nobody visits.
//
// The bound that actually does the work is index 0. Covers are what a card shows and
// therefore what goes grey; galleries are opened deliberately and are ~40x the
// volume. Keeping that one, dropping the ownership test.
async function shouldCachePhoto(store, listingId, index) {
  return index <= PHOTO_CACHE_MAX_INDEX;
}

// Best-effort in both directions: a cache miss, a write failure or a malformed
// entry must never turn a working photo into an error. Everything here is wrapped.
async function readCachedPhoto(store, listingId, index) {
  if (index > PHOTO_CACHE_MAX_INDEX) return null;
  try {
    const hit = await store.get(photoCacheKey(listingId, index), { type: "json" });
    // A photo too large to return inline lives on Cloudinary instead and the
    // entry holds a URL rather than bytes. See the too_large path below.
    if (hit && typeof hit.redirectUrl === "string" && hit.redirectUrl) return hit;
    if (hit && typeof hit.b64 === "string" && hit.b64.length) return hit;
  } catch (err) {
    console.warn(`listing-photo: cache read failed for ${listingId}/${index}:`, err && err.message);
  }
  return null;
}

async function writeCachedPhoto(store, listingId, index, buf, contentType) {
  try {
    await store.setJSON(photoCacheKey(listingId, index), {
      b64: buf.toString("base64"),
      contentType,
      bytes: buf.length,
      storedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`listing-photo: cache write failed for ${listingId}/${index}:`, err && err.message);
  }
}

// The single door every rescuable failure goes through: try the stored copy, and
// only fall back to a grey square if there isn't one.
//
// Debug requests skip the cache ON PURPOSE. `?debug=1` exists to answer "why is this
// photo grey", and serving a cached image would answer a different question and hide
// the very failure being investigated. Christine has spent hours today reading that
// output; it has to keep describing the live fetch.
async function servedOrPlaceholder(store, listingId, index, reason, debug, extra) {
  if (!debug && store) {
    const hit = await readCachedPhoto(store, listingId, index);
    if (hit) {
      console.warn(`listing-photo: ${listingId}/${index} served from stored copy (${reason})`);
      return cachedPhotoResponse(hit, reason);
    }
  }
  return placeholder(reason, debug, extra);
}

// Serve the stored copy. Deliberately NOT marked as a fallback in any way a visitor
// can see: it is the same image, fetched from the same source, just earlier.
function cachedPhotoResponse(hit, reason) {
  if (hit && hit.redirectUrl) {
    return {
      statusCode: 302,
      headers: {
        Location: hit.redirectUrl,
        "Cache-Control": IMAGE_CACHE_CONTROL,
        "X-Photo-Cache": "hit",
        "X-Photo-Cache-Reason": "oversize-rehosted",
        "X-Photo-Cache-Stored": String(hit.storedAt || ""),
      },
      body: "",
    };
  }
  return {
    statusCode: 200,
    headers: {
      "Content-Type": hit.contentType || "image/jpeg",
      "Cache-Control": IMAGE_CACHE_CONTROL,
      "X-Photo-Bytes": String(hit.bytes || 0),
      // For the network tab when something still looks wrong: this says the live
      // fetch failed and why, while the visitor saw a perfectly good photo.
      "X-Photo-Cache": "hit",
      "X-Photo-Cache-Reason": String(reason || "unknown"),
      "X-Photo-Cache-Stored": String(hit.storedAt || ""),
    },
    body: hit.b64,
    isBase64Encoded: true,
  };
}
// How long the CDN may serve a FAILURE, by reason.
//
// 2026-08-17. Every placeholder was cached for 300s regardless of why it failed,
// which quietly set a permanent floor under our own request rate: a photo that is
// never coming back re-asked MLS Grid every five minutes, forever, from every
// visitor's CDN edge. Multiply by the failing photos across the site and that is a
// steady drip against an account whose limits are shared with Listing-Engine and
// Expired-Luxury -- feeding the very 429s that then grey out photos which would
// otherwise have worked. Christine's readings 35 minutes apart both came back 429,
// so this is a sustained condition, not a burst.
//
// The rule: cache a permanent failure long enough to stop asking, and a transient
// one briefly so it self-heals. Getting this backwards in either direction is a
// real cost -- too long on a transient failure freezes a working photo grey, too
// short on a permanent one is the drip above.
const PLACEHOLDER_TTL = {
  // Temporary by definition. Short, so photos come back as soon as the limit
  // clears -- and the cooldown, not the CDN, is what protects the host meanwhile.
  media_rate_limited: 60,
  throttled: 60,
  // The URL we held was single-use and already spent, and re-resolving didn't
  // produce another. Self-healing on the next resolve, so treat it like a limit.
  url_unavailable: 60,
  // Our own budget said no. Clears at the top of the hour at the latest, and a
  // short TTL means the photo returns as soon as it does.
  quota_guard: 120,
  // A network blip. Worth retrying soon-ish, not instantly.
  image_fetch_failed: 300,
  exception: 300,
  // Not coming back on their own. An hour of not asking.
  no_media: 3600,
  index_out_of_range: 3600,
  not_an_image: 3600,
  too_large: 3600,
  bad_id: 86400,
  not_configured: 60,
};

// image_http_error splits on the status: a 403 is usually an expired signature and
// a fresh resolve fixes it, but a 404 confirmed on BOTH auth modes means the file
// is gone from MLS Grid and re-asking every five minutes is pure waste.
function placeholderMaxAge(reason, extra) {
  if (reason === "image_http_error") {
    const status = extra && extra.httpStatus;
    const attempts = (extra && extra.attempts) || [];
    const allTried = attempts.length >= 2;
    if (status === 404) return allTried ? 3600 : 300;
    return 300;
  }
  const ttl = PLACEHOLDER_TTL[reason];
  return typeof ttl === "number" ? ttl : 300;
}

// Matches the onerror fallback the listing cards already use (#eee), so a
// missing photo looks like a deliberate blank rather than a broken image.
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3" width="800" height="600">' +
  '<rect width="4" height="3" fill="#eeeeee"/></svg>';

// 2026-08-17. ?debug=1 used to be handled by a single block at the very BOTTOM
// of the handler -- after every `return placeholder(...)`. So it reported only on
// photos that already worked, and answered a failing photo with the same silent
// grey square as a normal request. Christine opened the debug URL for a land
// listing that renders grey and got a grey rectangle back; the one tool built to
// explain a blank photo could not explain a blank photo.
//
// The reason was never actually missing -- it goes out as X-Photo-Fallback on
// every placeholder -- but reading a response header means opening devtools,
// which is not a thing to ask someone to do to find out why a photo is grey.
//
// So the reason now travels with the placeholder, and every failure path returns
// it as readable JSON when debug=1. `extra` carries whatever that particular
// failure knows (HTTP status, byte count, how many URLs resolved) instead of
// making the reason string carry it by concatenation.
function placeholder(reason, debug, extra) {
  if (debug) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        ok: false,
        reason,
        // Plain-English reading of `reason`, so the answer doesn't depend on
        // knowing this file. Anything unrecognised falls through to the code.
        explanation: EXPLANATIONS[reason] || `Unrecognised failure code: ${reason}`,
        ...(extra || {}),
      }, null, 2),
    };
  }
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      // Per-reason, so a permanent failure stops re-asking MLS Grid every five
      // minutes. See placeholderMaxAge().
      "Cache-Control": `public, max-age=${placeholderMaxAge(reason, extra)}`,
      // Still sent on the image response, for the network tab and for anything
      // that samples these at scale.
      "X-Photo-Fallback": reason,
    },
    body: PLACEHOLDER_SVG,
  };
}

// Keyed by the reason codes used below. The point of each entry is to say what
// to DO about it, since a code alone still leaves the next step unclear.
const EXPLANATIONS = {
  bad_id: "The listing id in the URL isn't a valid MLS id.",
  not_configured: "MLSGRID_API_TOKEN is not set on this deploy, so no photo can be fetched at all.",
  no_media: "MLS Grid returned no photos for this listing. Either the listing genuinely has none, " +
    "or its media is not visible to this feed. The card's photo count comes from the last sync, so a " +
    "count above zero here means the media has gone away since then.",
  index_out_of_range: "This listing has fewer photos than the requested index.",
  throttled: "MLS Grid rate-limited us recently and the photo cooldown is still active, so no request " +
    "was made. This one is temporary — the same URL should work within a minute.",
  quota_guard: "This site's own quota guard refused the request — not MLS Grid. We log every " +
    "call we make and stop at half of MLS Grid's published limits, because a suspension costs days " +
    "(this account was suspended on 2026-08-01) and a placeholder costs minutes. `quotaReason` says " +
    "which budget was hit. If this fires in normal traffic, something is looping: check " +
    "/.netlify/functions/mls-usage for the hour-by-hour breakdown.",
  url_unavailable: "The listing has this photo, but we couldn't get a usable download URL for it. " +
    "MLS Grid's media URLs are SINGLE-USE — once one has been spent on a download it can never be " +
    "replayed — and the attempt to resolve a fresh one either failed or was throttled. Temporary: " +
    "the next request resolves again. If this is the steady state for one listing, the resolve step " +
    "is what to look at, not the image fetch.",
  image_fetch_failed: "The photo URL resolved, but fetching the image itself failed outright " +
    "(timeout or network error) rather than returning an HTTP error.",
  not_an_image: "The photo URL returned something that isn't an image.",
  image_http_error: "MLS Grid's media host refused the image. Read `attempts` below: it lists " +
    "every auth mode tried and what each returned. A 403 usually means an expired signed URL. " +
    "A 404 from BOTH modes means the photo is genuinely gone from MLS Grid even though the " +
    "listing still advertises it — nothing on this site can bring it back, and the card falls " +
    "back to a neutral grey tile.",
  media_rate_limited: "MLS Grid's media host is rate-limiting us, so this photo was not fetched. " +
    "This is temporary and NOT a broken photo — the site now backs off for a few seconds when this " +
    "happens instead of continuing to hammer the host, which is what used to keep the limit alive. " +
    "Reload after `retryAfterSeconds`. If it recurs constantly, the MLS Grid quota shared with " +
    "Listing-Engine and Expired-Luxury is the thing to look at, not this site.",
  too_large: "The photo downloaded fine but is too big to return through a Netlify function, AND " +
    "re-hosting it to Cloudinary either isn't configured or failed — with Cloudinary configured this " +
    "case resolves itself by redirecting to a permanently re-hosted copy. " +
    "A function response is capped at 6 MB and base64 encoding inflates it by a third, so the real " +
    "ceiling is about 4.4 MB. Full-resolution aerials and scanned plat maps — common on land " +
    "listings — routinely exceed it while ordinary house photos don't.",
  exception: "The function threw. Check the Netlify function logs for this request.",
};


// One MLS Grid call per listing, cached for both this photo and the other 29 in
// the same gallery. listings-search.js normally warms this ahead of the
// browser's requests (see prewarmPhotoUrls in lib/_media.js) -- this path is the
// fallback for a direct hit, a shared link, or a cache that expired mid-visit.
// Returns { urls, throttledUntil }. Reporting the throttle separately matters
// for diagnosis: "we were rate-limited so we didn't ask" and "we asked and this
// listing has no photos" both produce a grey square but need opposite responses
// -- the first fixes itself in under a minute, the second never does.
// 2026-08-17: this used to return the whole URL list and let the caller index it.
// It is now per-index, because whether a cached URL may be used is a per-index
// question: MLS Grid Media URLs are SINGLE-USE ("the URL may be used to download
// its image only once. A second request using the same URL will fail"), so an entry
// can be perfectly fresh and still be worthless for the one photo being asked for.
// usableUrl() is the only thing allowed to answer that.
//
// `force` skips the cache entirely -- used for the one retry after a cached URL
// fails, which is the case that used to be indistinguishable from a rate limit.
async function resolvePhotoUrl(listingId, index, store, token, force) {
  const cached = force ? null : await readCachedUrls(store, listingId);
  const cachedUrl = cached ? usableUrl(cached, index) : null;
  const cachedCount = cached ? cached.urls.length : 0;

  // Fast path: fresh and not yet spent.
  if (cached && cached.fresh && cachedUrl) {
    return { url: cachedUrl, urlCount: cachedCount, fromCache: true, throttledUntil: null };
  }
  // A fresh EMPTY entry is a remembered "this listing has no media" verdict, and
  // re-asking is exactly the drip EMPTY_CACHE_TTL_MS exists to stop.
  if (cached && cached.fresh && !cachedCount) {
    return { url: null, urlCount: 0, fromCache: true, throttledUntil: null };
  }

  // Respects the sync's suspension flag AND the photo-specific cooldown, and
  // sets only the latter -- photo traffic must never pause listing replication.
  const throttledUntil = await isThrottled(store);
  if (throttledUntil) {
    return { url: cachedUrl, urlCount: cachedCount, fromCache: true, throttledUntil };
  }

  const resolved = await resolveMediaFor([listingId], {
    store, token, baseUrl: BASE_URL, selectFields: SELECT_FIELDS,
    timeoutMs: SINGLE_TIMEOUT_MS,
  });
  const urls = resolved[listingId];
  if (Array.isArray(urls) && urls.length) {
    return { url: urls[index] || null, urlCount: urls.length, fromCache: false, throttledUntil: null };
  }
  // The resolve found nothing or failed. A stale-but-unspent URL is still worth a
  // try -- MLS Grid's own window is an hour and ours is five minutes.
  return { url: cachedUrl, urlCount: cachedCount, fromCache: true, throttledUntil: null };
}

// Exported for tests only. The photo cache's guarantees -- bounded to her own cover
// photos, never fatal, honest about what is missing -- are behaviour, and a test that
// only greps this file for strings proves none of them. tests/test-photocache.js
// drives these against a fake store.
exports.__test = {
  photoCacheKey, shouldCachePhoto, readCachedPhoto, writeCachedPhoto, cachedPhotoResponse,
  resetMineCache: () => { _mineIds = null; },
};

exports.handler = async (event) => {
  const params = (event && event.queryStringParameters) || {};
  // Read FIRST, and OUTSIDE the try, so every return below honours it -- the
  // exception handler included, which is the one place a caller most needs an
  // explanation rather than a grey square. It used to be read at the very bottom
  // of this function, so it only ever described a success. See placeholder().
  const debug = params.debug === "1";
  try {
    const listingId = String(params.id || params.listingId || "").trim();
    if (!listingId || !/^[A-Za-z0-9_-]{3,40}$/.test(listingId)) {
      return placeholder("bad_id", debug, { listingId });
    }
    const index = Math.max(0, parseInt(params.i, 10) || 0);

    const store = getBlobStore(getStore, BLOB_STORE_NAME);

    // ---- OUR OWN COPY FIRST -------------------------------------------------
    // 2026-08-17. This check used to live only on the FAILURE paths, so a photo we
    // already held was still re-resolved and re-downloaded from MLS Grid on every
    // request that missed a CDN edge -- against a documented rule that could not be
    // plainer: "There is NEVER a reason to download the same media more than once."
    //
    // Asking the store first is what turns this function from a proxy into a cache.
    // It also means a stored photo survives a missing token, a suspension, and MLS
    // Grid being down altogether.
    //
    // debug=1 deliberately skips it, for the same reason servedOrPlaceholder does:
    // the one tool for answering "why is this photo grey" has to keep describing the
    // live fetch.
    if (!debug) {
      const stored = await readCachedPhoto(store, listingId, index);
      if (stored) return cachedPhotoResponse(stored, "stored");
    }

    const token = process.env.MLSGRID_API_TOKEN;
    if (!token) return placeholder("not_configured", debug, { listingId });

    let resolved = await resolvePhotoUrl(listingId, index, store, token);
    const { throttledUntil, urlCount } = resolved;
    if (throttledUntil && !resolved.url) {
      return await servedOrPlaceholder(store, listingId, index, "throttled", debug, {
        listingId, index, retryAfterSeconds: Math.max(1, Math.ceil((throttledUntil - Date.now()) / 1000)),
      });
    }
    if (!urlCount) return placeholder("no_media", debug, { listingId, index, urlCount: 0 });
    if (index >= urlCount) {
      return placeholder("index_out_of_range", debug, { listingId, index, urlCount });
    }
    // The listing has this photo, but we could not get a URL we are allowed to use
    // -- the cached one is spent and the re-resolve failed or was throttled. That is
    // a transient, self-healing state and deliberately NOT reported as "no media",
    // which would be a lie about the listing.
    if (!resolved.url) {
      return await servedOrPlaceholder(store, listingId, index, "url_unavailable", debug, {
        listingId, index, urlCount,
      });
    }

    // The media host is refusing requests right now, so don't add one. Checked
    // AFTER the URL resolve because the two are separately rate-limited: a
    // resolve cooldown must not blank photos whose URLs are already cached and
    // would serve fine. Successful photos are CDN-cached for a day and never reach
    // this function, so this only ever pauses photos that were about to fail.
    const mediaCooldown = await isMediaThrottled(store);
    if (mediaCooldown) {
      return await servedOrPlaceholder(store, listingId, index, "media_rate_limited", debug, {
        listingId, index, urlCount,
        retryAfterSeconds: Math.max(1, Math.ceil((mediaCooldown - Date.now()) / 1000)),
      });
    }

    // The budget, checked before the download rather than after a 429. A photo we
    // already hold never reaches here -- the stored copy is served at the top of
    // this handler -- so the cost of the guard being wrong is a placeholder on a
    // photo nobody has loaded yet, never a page of holes. See _mls-usage.js.
    const quota = await checkMlsQuota(store);
    if (quota.blocked) {
      console.warn(`listing-photo: ${listingId}/${index} refused by the quota guard — ${quota.reason}`);
      return await servedOrPlaceholder(store, listingId, index, "quota_guard", debug, {
        listingId, index, urlCount, quotaReason: quota.reason,
        hourRequests: quota.hourRequests, hourMB: quota.hourMB,
        hourRequestBudget: quota.hourRequestBudget, hourMBBudget: quota.hourMBBudget,
      });
    }

    // 2026-08-15: the Authorization header is chosen per URL rather than always
    // sent -- MLS Grid's pre-signed media URLs 403 when a second auth mechanism
    // rides along, which is what was blanking some cards. See fetchMediaResponse.
    const hostOf = (u) => { try { return new URL(u).host; } catch (e) { return null; } };
    let mediaHost = hostOf(resolved.url);
    let attempt = await fetchMediaResponse(resolved.url, token, IMAGE_FETCH_TIMEOUT_MS, store);
    // Spent, whatever came back. A URL that has reached MLS Grid is single-use and
    // gone; handing it to the next visitor would guarantee them a failure that looks
    // exactly like a rate limit. Marked before the response is even inspected, so no
    // early return can skip it.
    await markUrlUsed(store, listingId, index);

    // ONE retry, and only where it is justified: the URL came from our cache, so it
    // may have been spent or expired in a way a fresh one would not be. A 429 is
    // excluded deliberately -- retrying into a rate limit is what kept the limit
    // alive in the first place -- and so is a live-resolved URL, which has no better
    // version to fetch.
    const worthRetrying = resolved.fromCache &&
      (!attempt || !attempt.res || (!attempt.res.ok && attempt.res.status !== 429));
    if (worthRetrying) {
      const fresh = await resolvePhotoUrl(listingId, index, store, token, true);
      if (fresh.url && fresh.url !== resolved.url) {
        console.warn(`listing-photo: ${listingId}/${index} cached URL failed ` +
          `(${(attempt && attempt.res && attempt.res.status) || "no response"}); retrying with a freshly resolved one`);
        resolved = fresh;
        mediaHost = hostOf(fresh.url);
        attempt = await fetchMediaResponse(fresh.url, token, IMAGE_FETCH_TIMEOUT_MS, store);
        await markUrlUsed(store, listingId, index);
      }
    }
    const imgRes = attempt && attempt.res;
    if (!imgRes) {
      return await servedOrPlaceholder(store, listingId, index, "image_fetch_failed", debug, {
        listingId, index, urlCount, mediaHost,
        authMode: attempt && attempt.mode, error: attempt && attempt.error,
        attempts: attempt && attempt.attempts,
      });
    }
    if (imgRes.status === 429) {
      // 2026-08-17: nothing used to back off from this. See MEDIA_COOLDOWN_KEY in
      // _media.js -- an unanswered media-host 429 is self-sustaining, because every
      // refusal becomes both a grey card and another request on the next view.
      const waitMs = await setMediaCooldown(store, imgRes.headers.get("retry-after"));
      console.error(`listing-photo: ${listingId} photo ${index} -> HTTP 429 from ${mediaHost}; ` +
        `media cooldown set for ${Math.round(waitMs / 1000)}s`);
      return await servedOrPlaceholder(store, listingId, index, "media_rate_limited", debug, {
        listingId, index, mediaHost, urlCount,
        authMode: attempt.mode, attempts: attempt.attempts,
        retryAfterSeconds: Math.round(waitMs / 1000),
      });
    }
    if (!imgRes.ok) {
      console.error(`listing-photo: ${listingId} photo ${index} -> HTTP ${imgRes.status} (mode ${attempt.mode})`);
      // The status is a field now rather than part of the reason string, so
      // callers can group these without parsing a code they have to guess at.
      return await servedOrPlaceholder(store, listingId, index, "image_http_error", debug, {
        listingId, index, httpStatus: imgRes.status, authMode: attempt.mode, mediaHost,
        urlCount,
        // Both auth modes, so a 404 can be read as "the photo is gone" rather than
        // "we only ever asked one way". See RETRY_OTHER_MODE_ON in _media.js.
        attempts: attempt.attempts,
      });
    }

    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return await servedOrPlaceholder(store, listingId, index, "not_an_image", debug, { listingId, index, contentType, mediaHost });
    }

    const buf = Buffer.from(await imgRes.arrayBuffer());
    // The real size of the download, recorded now that the body has been read.
    // media.mlsgrid.com sends no Content-Length, so this is the only point at which
    // photo bandwidth is knowable -- and photo bandwidth is the bulk of what this
    // site spends against MLS Grid's 3,072 MB/hour cap.
    await recordMlsBytes(store, buf.length);

    // 2026-08-15: Content-Length used to be set here from buf.length. That's a
    // bug in a base64 function response -- the platform decodes the body and
    // computes its own length, and a header that disagrees is exactly how a
    // browser ends up drawing a blank box for an image the server fetched
    // perfectly. Christine's site-health probe proved the server side works
    // ("resolved 47 URL(s), fetched photo 0 as image/jpeg, 286,081 bytes") while
    // her cards were still grey, which pointed the finger here rather than at
    // MLS Grid. Let the platform set it.
    //
    // The size guard is the other half. A Netlify function response is capped at
    // 6 MB and base64 inflates by a third, so any photo over roughly 4.4 MB
    // cannot be returned this way at all -- it fails as a 502 with nothing in the
    // page to explain it. MLS Grid originals are routinely several megabytes, so
    // this is a real ceiling, not a theoretical one, and it would hit exactly the
    // biggest photos: "some photos come up and some don't".
    if (buf.length > MAX_INLINE_IMAGE_BYTES) {
      console.error(`listing-photo: ${listingId} photo ${index} is ${buf.length} bytes — ` +
        `over the ${MAX_INLINE_IMAGE_BYTES}-byte inline ceiling.`);

      // 2026-08-18: this used to be the end of the road, and it is the ONLY
      // failure on this endpoint that no cache, cooldown or quota fix could ever
      // help -- the 6 MB cap is Netlify's, not MLS Grid's, so those photos were
      // permanently grey. Land listings with full-resolution aerials and scanned
      // plat maps hit it routinely.
      //
      // Cloudinary is the way out: its URLs go straight to the browser and never
      // pass through a function response. We already hold the bytes, so this costs
      // MLS Grid nothing extra -- and re-hosting is what its docs ask for anyway.
      // The redirect is cached like any other stored photo, so the next visitor
      // goes to Cloudinary without touching MLS Grid or this ceiling again.
      if (!debug) {
        try {
          const { uploadBufferToCloudinary, isCloudinaryConfigured } = require("./lib/_cloudinary");
          const url = isCloudinaryConfigured()
            ? await uploadBufferToCloudinary(buf, `spc-oversize/${listingId}/photo-${index}`, contentType)
            : null;
          if (url) {
            await store.setJSON(photoCacheKey(listingId, index), {
              redirectUrl: url, bytes: buf.length, contentType,
              storedAt: new Date().toISOString(),
            }).catch(() => {});
            console.warn(`listing-photo: ${listingId}/${index} was ${buf.length} bytes — ` +
              `re-hosted to Cloudinary and redirected instead of going grey.`);
            return cachedPhotoResponse({ redirectUrl: url, storedAt: new Date().toISOString() }, "oversize");
          }
        } catch (err) {
          // Falls through to the placeholder below, which is where it was before.
          console.error(`listing-photo: oversize re-host failed for ${listingId}/${index}:`, err && err.message);
        }
      }
      return await servedOrPlaceholder(store, listingId, index, "too_large", debug, {
        listingId, index, bytes: buf.length, limitBytes: MAX_INLINE_IMAGE_BYTES,
        overBy: buf.length - MAX_INLINE_IMAGE_BYTES, contentType, mediaHost, urlCount,
      });
    }

    if (debug) {
      // One URL Christine can open to see what happened, instead of a grey box.
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({
          listingId, index, ok: true, bytes: buf.length, contentType,
          authMode: attempt.mode, urlCount, mediaHost,
        }, null, 2),
      };
    }

    // The one write. Awaited rather than fired and forgotten: a Netlify function can
    // be frozen the moment it returns, so unawaited work is not reliably finished --
    // and a cache that only sometimes gets written is worse than none, because the
    // failure it is meant to cover would still show up at random.
    //
    // Bounded to her own cover photos (see shouldCachePhoto), and best-effort: a
    // write failure logs and the visitor still gets their photo.
    if (await shouldCachePhoto(store, listingId, index)) {
      await writeCachedPhoto(store, listingId, index, buf, contentType);
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": IMAGE_CACHE_CONTROL,
        // Handy in the network tab when a card still looks wrong.
        "X-Photo-Bytes": String(buf.length),
        "X-Photo-Auth-Mode": attempt.mode,
      },
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error("listing-photo error:", err && err.message);
    return placeholder("exception", debug, { error: err && err.message });
  }
};
