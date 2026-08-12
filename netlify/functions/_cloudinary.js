// Permanent photo re-hosting for MLS Grid listing photos, mirroring the
// proven pattern in Christine's Listing-Engine repo (api/routes/photos.js +
// api/lib/cloudinary.js) — confirmed live/working there, not a guess.
//
// WHY NOT CLOUDINARY'S "REMOTE FETCH" UPLOAD MODE (file=<url>)?
// MLS Grid's MediaURL values are served from a CDN that requires
// Authorization: Bearer <MLSGRID_API_TOKEN>. If we hand Cloudinary the raw
// URL and let ITS servers fetch it, Cloudinary can't send that header and
// the fetch 4xxs — confirmed in Listing-Engine's own commit history (their
// first attempt did exactly this and every photo failed). So instead we
// download the bytes ourselves (with the token) and hand Cloudinary a
// Buffer — Cloudinary never talks to media.mlsgrid.com directly.
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

// Downloads one MLS Grid MediaURL with the Bearer token and verifies it's
// actually image bytes, not an error page.
async function fetchMlsPhotoBuffer(mediaUrl, token) {
  const res = await fetch(mediaUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Mozilla/5.0 (compatible; SignaturePropertyCollection/1.0)",
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
  return result.secure_url || null;
}

module.exports = { cachePhotoToCloudinary, isCloudinaryConfigured, MIN_IMAGE_SIZE_BYTES };
