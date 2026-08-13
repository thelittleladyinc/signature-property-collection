// Permanent photo re-hosting for MLS Grid listing photos, mirroring the
// proven pattern in Christine's Listing-Engine repo (api/routes/photos.js +
// api/lib/cloudinary.js) — confirmed live/working there, not a guess.
//
// WHY NOT CLOUDINARY'S "REMOTE FETCH" UPLOAD MODE (file=<url>)?
// MLS Grid's Media URLs require a specific auth header to fetch. If we hand
// Cloudinary the raw URL and let ITS servers fetch it, Cloudinary can't send
// that header and the fetch 4xxs — confirmed in Listing-Engine's own commit
// history (their first attempt did exactly this and every photo failed). So
// instead we download the bytes ourselves (with the header) and hand
// Cloudinary a Buffer — Cloudinary never talks to media.mlsgrid.com directly.
//
// 2026-08-13 (real bug found in MLS Grid's own docs, not a guess): every
// media download this file has ever attempted was sending the WRONG header.
// MLS Grid's docs (MLS Grid Documentation > Media Files) say: "ALL requests
// to download the expanded media using the Media URL MUST include the HTTP
// header User-Agent. The User-Agent value MUST be the Oauth 2 access token
// you are provided by MLS Grid... Any User-Agent that is not your Oauth 2
// access token will be blocked by our service." This file was sending a
// fake browser-style User-Agent string instead — meaning every single photo
// download this function ever made was rejected by MLS Grid's media server
// before it even got to a rate-limit check. That's almost certainly the
// real reason zero photos ever got Cloudinary-cached, independent of the
// separate account-wide rate-limiting problem. Fixed below: User-Agent is
// now the literal access token, per spec. Authorization: Bearer is kept too
// since the main api.mlsgrid.com API documents that header and it's
// harmless to include here, but User-Agent is the one the media server
// actually requires.
//
// Also worth knowing for anyone touching this later: MLS Grid's docs state
// Media URLs are SIGNED, SINGLE-USE, and TIME-LIMITED (1 hour) — "the URL
// may be used to download its image only once. A second request using the
// same URL will fail." And separately, in bold, twice: "DO NOT use these
// URLs on your website or in your application" — they exist ONLY to be
// downloaded once, server-side, and re-hosted (which is exactly what this
// file does). That's a second, independent reason the site must never fall
// back to serving a raw MLS Grid photo URL straight to a visitor's
// browser — it's out of spec and it will only ever work for the first
// visitor to load it.
const cloudinary = require("cloudinary").v2;

let _configured = false;
function configureCloudinary() {
  if (_configured) return true;
  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;
  if (!cloud_name || !api_key || !api_secret) return false;
  cloudinary.config({ cloud_name, api_key, api_secret });
  _configured = true;
  return true;
}

function isCloudinaryConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY
    && process.env.CLOUDINARY_API_SECRET);
}

// Minimum byte count we expect from a real image response. An HTTP error
// page is typically a few hundred bytes of HTML; real JPEGs start around
// 2-5KB even heavily compressed. Same guard Listing-Engine's photos.js uses
// to avoid caching an error page as if it were a real photo.
const MIN_IMAGE_SIZE_BYTES = 2048;

// Downloads one MLS Grid MediaURL and verifies it's actually image bytes,
// not an error page. Per MLS Grid's own docs, the User-Agent header MUST be
// the literal access token — that's the real credential the media server
// checks (see the 2026-08-13 file-header note above).
async function fetchMlsPhotoBuffer(mediaUrl, token) {
  const res = await fetch(mediaUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": token,
      Accept: "image/*,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} fetching MLS Grid photo`);
    err.status = res.status;
    throw err;
  }
  const arrayBuffer = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  if (buf.length < MIN_IMAGE_SIZE_BYTES) {
    throw new Error(`Response too small (${buf.length} bytes) — likely an error page, not an image`);
  }
  return buf;
}

// Downloads one MLS Grid photo and uploads it to Cloudinary permanently.
// publicId should be stable per photo (e.g. "spc-listings/<listingId>/cover")
// so re-running this later is a safe overwrite, never a pile of duplicates.
// Returns the permanent secure_url, or null if Cloudinary isn't configured
// yet (so callers can fall back to the raw — expiring — MLS Grid URL
// without breaking anything before Christine adds the env vars).
async function cachePhotoToCloudinary(mediaUrl, token, publicId) {
  if (!configureCloudinary()) return null;
  const buffer = await fetchMlsPhotoBuffer(mediaUrl, token);
  const dataUri = `data:image/jpeg;base64,${buffer.toString("base64")}`;
  const result = await cloudinary.uploader.upload(dataUri, {
    public_id: publicId,
    resource_type: "image",
    overwrite: true,
    invalidate: true,
    // Strip EXIF/GPS metadata for privacy (same as Listing-Engine) —
    // matters more here since these are live, publicly-linked listing
    // photos, not an internal admin tool.
    flags: "strip_profile",
  });
  if (!result.secure_url) return null;
  // 2026-08-13 (speed): MLS Grid's original photos are often several
  // megabytes and always plain JPEG. result.secure_url above points at
  // that untouched master -- fine to keep as the stored original, but not
  // what visitors should actually download. Build the delivery URL with
  // Cloudinary's automatic optimization instead: f_auto serves WebP/AVIF
  // to browsers that support it (falls back to JPEG otherwise), q_auto
  // picks the smallest quality level that still looks right, and capping
  // width at 1600 is plenty for any card or gallery view on this site
  // (nothing here displays a photo larger than that). Cloudinary generates
  // this derivative once on first request and caches it at their CDN edge
  // -- it costs nothing extra per view, it just means every visitor gets a
  // much lighter image than MLS Grid's original.
  return cloudinary.url(publicId, {
    secure: true,
    resource_type: "image",
    transformation: [{ quality: "auto", fetch_format: "auto", width: 1600, crop: "limit" }],
  });
}

module.exports = { cachePhotoToCloudinary, isCloudinaryConfigured, MIN_IMAGE_SIZE_BYTES };
