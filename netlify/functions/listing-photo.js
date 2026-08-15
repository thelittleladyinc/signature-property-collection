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
//   6. Any failure returns a neutral gray placeholder with a SHORT cache, so a
//      broken photo self-heals on the next view instead of being frozen into
//      the CDN for a day.
const { getStore } = require("@netlify/blobs");
const { getBlobStore, BASE_URL, SELECT_FIELDS } = require("./lib/_mls-shared");
const {
  readCachedUrls, isThrottled, resolveMediaFor, SINGLE_TIMEOUT_MS, fetchMediaResponse,
} = require("./lib/_media");

const BLOB_STORE_NAME = "mls-listings";
const IMAGE_FETCH_TIMEOUT_MS = 8000;

// How long the CDN may serve our copy of a photo. Listing photos do change
// (a re-shoot, a re-ordering), so this isn't immutable -- a day of hard
// caching with a week of stale-while-revalidate keeps MLS Grid traffic near
// zero while still picking changes up.
const IMAGE_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";
const PLACEHOLDER_CACHE_CONTROL = "public, max-age=300";

// Matches the onerror fallback the listing cards already use (#eee), so a
// missing photo looks like a deliberate blank rather than a broken image.
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3" width="800" height="600">' +
  '<rect width="4" height="3" fill="#eeeeee"/></svg>';

function placeholder(reason) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": PLACEHOLDER_CACHE_CONTROL,
      // Read this header in the browser's network tab to see why a photo is
      // blank without needing the function logs.
      "X-Photo-Fallback": reason,
    },
    body: PLACEHOLDER_SVG,
  };
}

// One MLS Grid call per listing, cached for both this photo and the other 29 in
// the same gallery. listings-search.js normally warms this ahead of the
// browser's requests (see prewarmPhotoUrls in lib/_media.js) -- this path is the
// fallback for a direct hit, a shared link, or a cache that expired mid-visit.
async function resolvePhotoUrls(listingId, store, token) {
  const cached = await readCachedUrls(store, listingId);
  if (cached && cached.fresh) return cached.urls;

  // Respects the sync's suspension flag AND the photo-specific cooldown, and
  // sets only the latter -- photo traffic must never pause listing replication.
  const throttledUntil = await isThrottled(store);
  if (throttledUntil) return cached ? cached.urls : null;

  const resolved = await resolveMediaFor([listingId], {
    store, token, baseUrl: BASE_URL, selectFields: SELECT_FIELDS,
    timeoutMs: SINGLE_TIMEOUT_MS,
  });
  return resolved[listingId] || (cached ? cached.urls : null);
}

exports.handler = async (event) => {
  try {
    const params = (event && event.queryStringParameters) || {};
    const listingId = String(params.id || params.listingId || "").trim();
    if (!listingId || !/^[A-Za-z0-9_-]{3,40}$/.test(listingId)) {
      return placeholder("bad_id");
    }
    const index = Math.max(0, parseInt(params.i, 10) || 0);

    const token = process.env.MLSGRID_API_TOKEN;
    if (!token) return placeholder("not_configured");

    const store = getBlobStore(getStore, BLOB_STORE_NAME);
    const urls = await resolvePhotoUrls(listingId, store, token);
    if (!urls || !urls.length) return placeholder("no_media");
    if (index >= urls.length) return placeholder("index_out_of_range");

    // 2026-08-15: the Authorization header is chosen per URL rather than always
    // sent -- MLS Grid's pre-signed media URLs 403 when a second auth mechanism
    // rides along, which is what was blanking some cards. See fetchMediaResponse.
    const attempt = await fetchMediaResponse(urls[index], token, IMAGE_FETCH_TIMEOUT_MS);
    const imgRes = attempt && attempt.res;
    if (!imgRes) return placeholder("image_fetch_failed");
    if (!imgRes.ok) {
      console.error(`listing-photo: ${listingId} photo ${index} -> HTTP ${imgRes.status} (mode ${attempt.mode})`);
      return placeholder("image_http_" + imgRes.status);
    }

    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) return placeholder("not_an_image");

    const buf = Buffer.from(await imgRes.arrayBuffer());
    return {
      statusCode: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": IMAGE_CACHE_CONTROL,
        "Content-Length": String(buf.length),
      },
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error("listing-photo error:", err && err.message);
    return placeholder("exception");
  }
};
