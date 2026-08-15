// Human-readable "is everything actually working" status page — one URL
// Christine can bookmark and check herself instead of both of us running
// ad-hoc ?debug=true fetches back and forth every time something seems
// off. Read-only by default: it never talks to MLS Grid or Cloudinary itself,
// it only reads what sync-listings.js already wrote to Blobs on its last
// scheduled run — so loading this page is free and can never cost API
// quota, trigger a request, or interfere with the suspension breaker.
//
// ONE EXCEPTION, added 2026-08-15 (Christine: "can you confirm that google maps
// is correct api set correct for me?"). Nobody can answer that by reading code:
// the key lives in Netlify's env vars and which APIs are enabled lives in her
// Google Cloud project. So ?google=1 runs two real, tiny probes against her key
// — one Geocoding request and one Places request — and reports Google's own
// status and error_message verbatim, which is the part that actually says which
// API to turn on ("This API project is not authorized to use this API",
// "REQUEST_DENIED", "API key not valid", and so on).
//
// Kept honest about cost: opt-in only (the default page still makes zero
// outbound calls), the result is cached in Blobs for GOOGLE_CHECK_TTL_MS so
// refreshing the page doesn't re-spend quota, and two requests is far inside
// the free tier either way. The key itself is never printed — only whether it
// works.
const { getStore } = require("@netlify/blobs");
const {
  SYNC_STATE_KEY, MINE_LISTINGS_KEY, getBlobStore, BASE_URL, SELECT_FIELDS,
} = require("./lib/_mls-shared");
const { isCloudinaryConfigured } = require("./lib/_cloudinary");
const { resolveMediaFor, fetchMediaResponse, looksPresigned } = require("./lib/_media");

// Must match SUSPENSION_KEY in sync-listings.js — duplicated here rather
// than exported since it's a single literal string and this file should
// stay read-only / dependency-light.
const SUSPENSION_KEY = "mlsgrid-suspension.json";
const GOOGLE_CHECK_KEY = "google-api-check.json";
// Written by submission-created.js on every website-lead push. See that file's
// 2026-08-15 note: a broken Lofty integration used to look exactly like a
// working one from outside, which is how a real form submission went missing.
const LOFTY_LAST_PUSH_KEY = "lofty-last-push.json";
const LOFTY_FAILED_PUSH_KEY = "lofty-failed-pushes.json";
const LOFTY_CHECK_KEY = "lofty-key-check.json";
const PHOTO_CHECK_KEY = "photo-pipeline-check.json";
const CLOUDINARY_CHECK_KEY = "cloudinary-usage-check.json";

// 2026-08-15: Lofty's own API page (Settings > Integrations > API) documents
// this exact call as its usage example, which makes it the ideal key test --
// GET, read-only, and it either recognizes the key or it doesn't:
//
//   curl --request GET --url https://api.lofty.com/v1.0/me \
//        --header 'Authorization: token <your apiKey>'
//
// Worth having because the alternative was "submit a form and wait": Christine
// asked why a lead never reached Lofty, and without this the only way to test
// the key was to generate another real lead.
const LOFTY_ME_URL = "https://api.lofty.com/v1.0/me";

// 2026-08-15 (Christine: "i dont kmow what the problem is - the pics still arent
// showing", with her own Current Listings page showing a grey box on every card
// that doesn't have a video). I had already guessed twice at this -- expired
// URLs, then a pre-signed-URL conflict -- so this stops guessing and walks the
// real chain end to end, server-side, on one of her own listings: resolve the
// media URLs from MLS Grid, then actually fetch photo 0 the same way
// listing-photo.js does, and report exactly which step failed and how.
//
// It makes real MLS Grid requests, which is why it only runs under ?probe=1 and
// caches for 10 minutes like the other probes.
async function probePhotoPipeline(mineListings, token) {
  const out = { checkedAt: new Date().toISOString() };
  const first = (Array.isArray(mineListings) ? mineListings : []).find((l) => l && l.listingId);
  if (!first) {
    out.ok = false;
    out.detail = "No listings of Christine's are known yet, so there is nothing to test.";
    return out;
  }
  out.listingId = first.listingId;
  if (!token) {
    out.ok = false;
    out.detail = "MLSGRID_API_TOKEN isn't set.";
    return out;
  }
  try {
    const store = getBlobStore(getStore);
    const resolved = await resolveMediaFor([first.listingId], {
      store, token, baseUrl: BASE_URL, selectFields: SELECT_FIELDS, timeoutMs: 6000,
    });
    const urls = resolved[first.listingId];
    if (!urls || !urls.length) {
      out.ok = false;
      out.detail = `MLS Grid returned no media for ${first.listingId} — the URL resolve step is what's failing, not the image fetch.`;
      return out;
    }
    out.urlCount = urls.length;
    // Host only. The signature in the query string is a credential.
    try { out.mediaHost = new URL(urls[0]).host; } catch (e) { out.mediaHost = "unparseable"; }
    out.presigned = looksPresigned(urls[0]);

    const attempt = await fetchMediaResponse(urls[0], token, 8000);
    if (!attempt || !attempt.res) {
      out.ok = false;
      out.detail = `Resolved ${urls.length} URL(s) from ${out.mediaHost}, but the image fetch threw with no response.`;
      return out;
    }
    out.fetchStatus = attempt.res.status;
    out.authMode = attempt.mode;
    out.contentType = attempt.res.headers.get("content-type") || null;
    if (!attempt.res.ok) {
      out.ok = false;
      out.detail = `Resolved ${urls.length} URL(s) from ${out.mediaHost} ` +
        `(pre-signed: ${out.presigned ? "yes" : "no"}), but fetching photo 0 returned ` +
        `HTTP ${attempt.res.status} using the "${attempt.mode}" auth mode. ` +
        `That is the exact step breaking the photos.`;
      return out;
    }
    const buf = Buffer.from(await attempt.res.arrayBuffer());
    out.bytes = buf.length;
    out.ok = buf.length > 1000;
    out.detail = out.ok
      ? `Working end to end: resolved ${urls.length} URL(s) from ${out.mediaHost}, ` +
        `fetched photo 0 as ${out.contentType} (${buf.length.toLocaleString()} bytes) ` +
        `using the "${attempt.mode}" auth mode.`
      : `Fetched photo 0 but got only ${buf.length} bytes — that's an error page, not an image.`;
    return out;
  } catch (err) {
    out.ok = false;
    out.detail = `Photo pipeline probe threw: ${(err && err.message) || err}`;
    return out;
  }
}

// Cloudinary's own account usage. The 403 blocking her permanent photo copies
// comes from Cloudinary's upload API (proven: that error string lives in
// node_modules/cloudinary/lib/uploader.js), and Cloudinary answers 403 for a
// short list of reasons -- credits exhausted, account disabled, bad signature.
// Asking for usage separates them: it needs valid credentials to answer at all,
// and its numbers say whether the account is out of room.
async function probeCloudinaryUsage() {
  try {
    const cloudinary = require("cloudinary").v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    const usage = await cloudinary.api.usage({ timeout: 6000 });
    const credits = usage && usage.credits;
    return {
      checkedAt: new Date().toISOString(),
      ok: true,
      plan: usage && usage.plan,
      creditsUsed: credits && credits.used_percent != null ? `${credits.used_percent}% of ${credits.limit}` : null,
      storageBytes: usage && usage.storage && usage.storage.usage,
      lastUpdated: usage && usage.last_updated,
    };
  } catch (err) {
    return {
      checkedAt: new Date().toISOString(),
      ok: false,
      error: (err && (err.message || (err.error && err.error.message))) || String(err),
      httpCode: (err && err.http_code) || null,
    };
  }
}

async function probeLoftyKey(apiKey) {
  try {
    const res = await fetch(LOFTY_ME_URL, {
      headers: { "Authorization": `token ${apiKey}` },
      signal: AbortSignal.timeout(GOOGLE_PROBE_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    return {
      checkedAt: new Date().toISOString(),
      ok: res.ok,
      httpStatus: res.status,
      // Trimmed hard: /me returns the account's own details and this page is
      // reachable by anyone who knows the URL, so only enough to confirm which
      // account answered, never the full payload.
      body: text.slice(0, 160),
    };
  } catch (err) {
    return {
      checkedAt: new Date().toISOString(),
      ok: false,
      httpStatus: "request failed",
      body: (err && err.message) || "",
    };
  }
}
const GOOGLE_CHECK_TTL_MS = 10 * 60 * 1000;
const GOOGLE_PROBE_TIMEOUT_MS = 6000;

// Christine's own business address (SITE['address'] in build.py) and a point in
// Loveland — real inputs, so a success genuinely proves the API works rather
// than proving a placeholder round-trips.
const GEOCODE_PROBE_ADDRESS = "2411 Glade Rd, Loveland, CO";
const PLACES_PROBE_LATLNG = "40.3978,-105.0748";

// Probes the two Google APIs this site actually uses. Returns a plain,
// printable result per API: ok, Google's status, and Google's own message.
async function probeGoogle(apiKey) {
  const out = { checkedAt: new Date().toISOString() };

  async function call(label, url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_PROBE_TIMEOUT_MS) });
      if (!res.ok) return { ok: false, status: `HTTP ${res.status}`, message: "" };
      const json = await res.json();
      // Google returns 200 with a status field even when the key is wrong, which
      // is exactly why checking the HTTP code alone tells you nothing.
      const okStatuses = ["OK", "ZERO_RESULTS"];
      return {
        ok: okStatuses.includes(json.status),
        status: json.status || "unknown",
        message: json.error_message || "",
      };
    } catch (err) {
      return { ok: false, status: "request failed", message: (err && err.message) || "" };
    }
  }

  out.geocoding = await call(
    "geocoding",
    "https://maps.googleapis.com/maps/api/geocode/json?address=" +
      encodeURIComponent(GEOCODE_PROBE_ADDRESS) + "&key=" + encodeURIComponent(apiKey),
  );
  // Same legacy Places endpoint nearby-places.js and walkability.js use, so this
  // tests the API those features actually call -- not a different Places
  // product that might be enabled while theirs isn't.
  out.places = await call(
    "places",
    "https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=" +
      encodeURIComponent(PLACES_PROBE_LATLNG) + "&rankby=distance&type=cafe&key=" +
      encodeURIComponent(apiKey),
  );
  return out;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

exports.handler = async (event) => {
  const store = getBlobStore(getStore);
  const params = (event && event.queryStringParameters) || {};
  const wantsJson = params.format === "json";

  const [state, mine, suspension, cachedGoogle, loftyLast, loftyFailed, cachedLoftyKey,
    cachedPhotoCheck, cachedCloudCheck] = await Promise.all([
    store.get(SYNC_STATE_KEY, { type: "json" }),
    store.get(MINE_LISTINGS_KEY, { type: "json" }),
    store.get(SUSPENSION_KEY, { type: "json" }),
    store.get(GOOGLE_CHECK_KEY, { type: "json" }).catch(() => null),
    store.get(LOFTY_LAST_PUSH_KEY, { type: "json" }).catch(() => null),
    store.get(LOFTY_FAILED_PUSH_KEY, { type: "json" }).catch(() => null),
    store.get(LOFTY_CHECK_KEY, { type: "json" }).catch(() => null),
    store.get(PHOTO_CHECK_KEY, { type: "json" }).catch(() => null),
    store.get(CLOUDINARY_CHECK_KEY, { type: "json" }).catch(() => null),
  ]);

  // ---- Google key check (opt-in, cached) ----
  const googleKey = process.env.GOOGLE_MAPS_API_KEY;
  // ?probe=1 runs every live check; ?google=1 is kept working since that URL
  // has already been handed to Christine.
  const wantsProbe = params.probe === "1" || params.probe === "true" ||
    params.google === "1" || params.google === "true" ||
    params.lofty === "1" || params.lofty === "true";
  const wantsGoogle = wantsProbe;
  let google = cachedGoogle;
  const googleFresh = google && google.checkedAt &&
    Date.now() - Date.parse(google.checkedAt) < GOOGLE_CHECK_TTL_MS;
  if (wantsGoogle && googleKey && !googleFresh) {
    google = await probeGoogle(googleKey);
    await store.setJSON(GOOGLE_CHECK_KEY, google).catch(() => {});
  }

  let photoCheck = cachedPhotoCheck;
  const photoFresh = photoCheck && photoCheck.checkedAt &&
    Date.now() - Date.parse(photoCheck.checkedAt) < GOOGLE_CHECK_TTL_MS;
  if (wantsProbe && !photoFresh) {
    photoCheck = await probePhotoPipeline(mine, process.env.MLSGRID_API_TOKEN);
    await store.setJSON(PHOTO_CHECK_KEY, photoCheck).catch(() => {});
  }

  let cloudCheck = cachedCloudCheck;
  const cloudFresh = cloudCheck && cloudCheck.checkedAt &&
    Date.now() - Date.parse(cloudCheck.checkedAt) < GOOGLE_CHECK_TTL_MS;
  if (wantsProbe && isCloudinaryConfigured() && !cloudFresh) {
    cloudCheck = await probeCloudinaryUsage();
    await store.setJSON(CLOUDINARY_CHECK_KEY, cloudCheck).catch(() => {});
  }

  const loftyApiKey = process.env.LOFTY_API_KEY;
  let loftyKeyCheck = cachedLoftyKey;
  const loftyKeyFresh = loftyKeyCheck && loftyKeyCheck.checkedAt &&
    Date.now() - Date.parse(loftyKeyCheck.checkedAt) < GOOGLE_CHECK_TTL_MS;
  if (wantsProbe && loftyApiKey && !loftyKeyFresh) {
    loftyKeyCheck = await probeLoftyKey(loftyApiKey);
    await store.setJSON(LOFTY_CHECK_KEY, loftyKeyCheck).catch(() => {});
  }

  const now = Date.now();
  const lastRunAt = state && state.lastRunAt ? Date.parse(state.lastRunAt) : null;
  const minutesSinceLastRun = lastRunAt ? Math.round((now - lastRunAt) / 60000) : null;
  const suspendedUntil = suspension && suspension.suspendedUntil;
  const isSuspended = !!(suspendedUntil && suspendedUntil > now);

  const mineListings = Array.isArray(mine) ? mine : [];
  const mineCount = mineListings.length;
  const mineCloudinaryCount = mineListings.filter((l) => {
    try { return !!(l.photo && new URL(l.photo).host.indexOf("cloudinary") !== -1); } catch (e) { return false; }
  }).length;

  const checks = [
    {
      name: "Sync running on schedule",
      ok: !isSuspended && minutesSinceLastRun !== null && minutesSinceLastRun < 20,
      detail: isSuspended
        ? `MLS Grid rate-limit circuit breaker is OPEN — paused until ${new Date(suspendedUntil).toLocaleString("en-US")}`
        : (lastRunAt != null
          ? `Last ran ${minutesSinceLastRun} minute(s) ago (should be every 15)`
          : "Has never run yet"),
    },
    {
      name: "No MLS Grid errors on last run",
      ok: !state || !state.lastRunError,
      detail: (state && state.lastRunError) || "none",
    },
    {
      optional: true,
      name: "Initial catalog crawl (in progress is normal)",
      ok: !!(state && state.bootstrapped),
      detail: state
        ? `${state.bootstrapped ? "Complete" : "Still in progress"} — ${state.totalListingsStored ?? "?"} listing(s) stored so far this pass`
        : "Not started",
    },
    {
      name: "Christine's own listings found",
      ok: mineCount > 0,
      detail: `${mineCount} listing(s) currently known to the site`,
    },
    {
      name: "Cloudinary configured",
      ok: isCloudinaryConfigured(),
      detail: isCloudinaryConfigured()
        ? "All three env vars present"
        : "CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET — one or more isn't set",
    },
    {
      optional: true,
      name: "Christine's own photos permanently cached (optional)",
      ok: mineCount > 0 && mineCloudinaryCount === mineCount,
      // Reworded 2026-08-15: "0 of 11 ... expiring MLS Grid links" was written when
      // an expiring link meant a blank card. It doesn't anymore -- every listing
      // photo is served through /listing-photo from this site's own domain, which
      // resolves a fresh URL per request. A Cloudinary copy is now purely an
      // optimization, so the row says that instead of implying the photos are down.
      detail: `${mineCloudinaryCount} of ${mineCount} listing(s) have a permanent Cloudinary copy. ` +
        `This is an optimization, not a fault: every listing photo is already served ` +
        `from this site's own domain, so photos work either way. A Cloudinary copy just ` +
        `saves an MLS Grid lookup per photo.`,
    },
    {
      optional: true,
      name: "No Cloudinary errors on last run (optional)",
      ok: !state || !state.lastCloudinaryError,
      detail: (state && state.lastCloudinaryError) || "none",
    },
    {
      // 2026-08-14: informational only (always ok) -- this is a nice-to-have
      // speed optimization, not something required for the site to work
      // correctly, so it never flips the overall "Everything looks clean"
      // banner. If IRES rejects ListOfficeMlsId the same way it rejected a
      // few other MLS Grid field names before, this just stays "not yet" --
      // the existing agent-name-match walk is unaffected either way.
      name: "Fast office-wide listing lookup",
      ok: true,
      detail: state && state.herOfficeMlsId
        ? `Active (office ID ${state.herOfficeMlsId}) — ${state.lastRunNewlyDiscoveredByOffice ?? 0} newly discovered on the last run`
        : "Not yet discovered — falls back to the slower regional-walk method (not a problem, just not optimized yet)",
    },
  ];

  // Google Maps: three separate rows, because "the key is set" and "the two
  // APIs it needs are enabled" fail independently and have different fixes.
  const googleDetail = (which) => {
    if (!googleKey) return "GOOGLE_MAPS_API_KEY isn't set in Netlify.";
    if (!google || !google[which]) {
      return "Not tested yet — add ?google=1 to this page's URL to run a live check.";
    }
    const r = google[which];
    const when = google.checkedAt ? ` (checked ${google.checkedAt})` : "";
    if (r.ok) return `Working — Google returned ${r.status}${when}.`;
    return `Google says ${r.status}${r.message ? `: ${r.message}` : ""}${when}`;
  };
  checks.push({
    name: "Google Maps key set",
    ok: !!googleKey,
    detail: googleKey
      ? "GOOGLE_MAPS_API_KEY is present. Note it shows several deploy-context values in Netlify — the Production one is the one this page reads."
      : "Not set. Add GOOGLE_MAPS_API_KEY in Netlify → Site configuration → Environment variables.",
  });
  checks.push({
    name: "Geocoding API enabled",
    // An untested probe isn't a failure, so it doesn't turn the page red.
    ok: !googleKey ? false : (!google || !google.geocoding ? true : google.geocoding.ok),
    detail: googleDetail("geocoding") +
      (google && google.geocoding && !google.geocoding.ok
        ? " → enable it at console.cloud.google.com/apis/library/geocoding-backend.googleapis.com"
        : ""),
  });
  checks.push({
    name: "Places API enabled",
    ok: !googleKey ? false : (!google || !google.places ? true : google.places.ok),
    detail: googleDetail("places") +
      (google && google.places && !google.places.ok
        ? " → enable it at console.cloud.google.com/apis/library/places-backend.googleapis.com"
        : ""),
  });

  // ---- The photo chain, end to end ----
  checks.push({
    name: "Listing photos load end to end",
    ok: !photoCheck ? true : !!photoCheck.ok,
    detail: photoCheck
      ? photoCheck.detail
      : "Not tested yet — add ?probe=1 to this page's URL to walk the whole photo chain " +
        "(resolve the MLS media URLs, then actually fetch one) and see which step fails.",
  });
  checks.push({
    optional: true,
    name: "Cloudinary account healthy (optional)",
    ok: !isCloudinaryConfigured() ? false : (!cloudCheck ? true : !!cloudCheck.ok),
    detail: !isCloudinaryConfigured()
      ? "Cloudinary env vars aren't all set."
      : (!cloudCheck
        ? "Not tested yet — add ?probe=1 to ask Cloudinary about the account directly."
        : (cloudCheck.ok
          ? `Cloudinary answered: plan "${cloudCheck.plan}"` +
            `${cloudCheck.creditsUsed ? `, credits ${cloudCheck.creditsUsed}` : ""}.` +
            " If credits are at or near 100%, that is what the upload 403 means."
          : `Cloudinary refused the account check${cloudCheck.httpCode ? ` (HTTP ${cloudCheck.httpCode})` : ""}: ` +
            `${cloudCheck.error}. Same credentials the photo uploads use, so this IS the 403's cause. ` +
            (/cloud_name mismatch/i.test(String(cloudCheck.error))
              ? "FIX: the three CLOUDINARY_* variables in Netlify are not all from the same " +
                "Cloudinary account — the cloud name belongs to one account and the API key/secret " +
                "to another. Open cloudinary.com → Dashboard, copy Cloud name, API Key and API Secret " +
                "from that same page, and replace all three in Netlify → Environment variables."
              : "Check the three CLOUDINARY_* variables in Netlify against cloudinary.com → Dashboard."))),
  });

  // ---- Lofty API key valid? ----
  checks.push({
    name: "Lofty API key valid",
    ok: !process.env.LOFTY_API_KEY ? false : (!loftyKeyCheck ? true : loftyKeyCheck.ok),
    detail: !process.env.LOFTY_API_KEY
      ? "LOFTY_API_KEY isn't set in Netlify."
      : (!loftyKeyCheck
        ? "Not tested yet — add ?probe=1 to this page's URL to test the key against Lofty's /v1.0/me endpoint."
        : (loftyKeyCheck.ok
          ? `Lofty accepted the key (HTTP ${loftyKeyCheck.httpStatus}, checked ${loftyKeyCheck.checkedAt}).`
          : `Lofty REJECTED the key: HTTP ${loftyKeyCheck.httpStatus}. ${loftyKeyCheck.body || ""} ` +
            "Create a key for this website in Lofty → Settings → Integrations → API, " +
            "then replace LOFTY_API_KEY in Netlify with it.")),
  });

  // ---- Website leads reaching Lofty ----
  const loftyKeySet = !!process.env.LOFTY_API_KEY;
  const failedCount = Array.isArray(loftyFailed) ? loftyFailed.length : 0;
  let loftyDetail;
  let loftyOk;
  if (!loftyKeySet) {
    loftyOk = false;
    loftyDetail = "LOFTY_API_KEY isn't set — website leads stay in Netlify Forms only.";
  } else if (!loftyLast) {
    loftyOk = true;
    loftyDetail = "No website lead has been submitted since this check was added " +
      "(2026-08-15). Submit any form once and this row will show exactly what Lofty said.";
  } else if (loftyLast.ok) {
    loftyOk = failedCount === 0;
    loftyDetail = `Last lead from "${loftyLast.formName}"` +
      `${loftyLast.leadEmail ? ` (${loftyLast.leadEmail})` : ""} reached Lofty at ${loftyLast.at}` +
      `${loftyLast.leadId ? ` (lead ${loftyLast.leadId})` : ""}` +
      `${loftyLast.payloadShape ? `, ${loftyLast.payloadShape} payload` : ""}.` +
      (failedCount ? ` ${failedCount} earlier push(es) failed and are queued.` : "");
  } else {
    loftyOk = false;
    loftyDetail = `Last lead from "${loftyLast.formName}"` +
      `${loftyLast.leadEmail ? ` (${loftyLast.leadEmail})` : ""} FAILED at ${loftyLast.at}: ` +
      `Lofty returned HTTP ${loftyLast.httpStatus} (payload shape: ${loftyLast.payloadShape || "full"}). ` +
      `Lofty said: ${String(loftyLast.responseBody || "(empty response)").slice(0, 240)}. ` +
      `${failedCount} lead(s) queued and recoverable — nothing is lost, the submissions are also in Netlify Forms.`;
  }
  checks.push({ name: "Website leads reaching Lofty", ok: loftyOk, detail: loftyDetail });

  // 2026-08-15: some checks describe an OPTIONAL improvement rather than
  // something broken. Cloudinary is the case that forced this: since the photo
  // endpoint began serving every listing from this site's own domain, a
  // Cloudinary copy is a nice-to-have (permanent URLs, fewer MLS Grid calls) and
  // its absence breaks nothing a visitor can see. Leaving those rows as red X's
  // told Christine the site was broken when it wasn't -- and a status page that
  // cries wolf is worse than no status page, because the real red rows stop
  // standing out.
  const allOk = checks.every((c) => c.ok || c.optional);
  const optionalIssues = checks.filter((c) => !c.ok && c.optional).length;

  if (wantsJson) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ allOk, checks, raw: { state, suspension, mineCount, mineCloudinaryCount, google, loftyLast, loftyFailed, loftyKeyCheck, photoCheck, cloudCheck } }, null, 2),
    };
  }

  const rows = checks.map((c) => `
    <tr>
      <td style="padding:12px 16px;font-size:20px;text-align:center">${c.ok ? "✅" : (c.optional ? "ℹ️" : "❌")}</td>
      <td style="padding:12px 16px;font-weight:600;white-space:nowrap">${esc(c.name)}</td>
      <td style="padding:12px 16px;color:#555">${esc(c.detail)}</td>
    </tr>`).join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site Health — Signature Property Collection</title>
<meta name="robots" content="noindex">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f8f6f4; margin:0; padding:40px 20px; }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom:4px; color:#141415; }
  .status-line { font-size:16px; margin-bottom:24px; font-weight:700; }
  .ok { color:#2f6b45; } .bad { color:#a33; }
  table { width:100%; border-collapse: collapse; background:#fff; border:1px solid #e4e4d8; border-radius:4px; overflow:hidden; }
  tr + tr td { border-top:1px solid #eee; }
  .refresh { font-size:12px; color:#888; margin-top:16px; }
  code { background:#eee; padding:1px 5px; border-radius:3px; }
</style>
</head><body><div class="wrap">
<h1>Signature Property Collection — Site Health</h1>
<p class="status-line ${allOk ? "ok" : "bad"}">${allOk
  ? (optionalIssues
    ? `✅ Nothing is broken. ${optionalIssues} optional improvement(s) noted below (marked ℹ️) — the site works without them.`
    : "✅ Everything looks clean.")
  : "⚠️ Something needs attention — see below."}</p>
<table>${rows}</table>
<p class="refresh">Checked live just now — reload anytime. This page only reads stored status; it never calls MLS Grid or Cloudinary itself, so checking it is always free. Add <code>?probe=1</code> to live-test the Google APIs and the Lofty key (cached 10 minutes), or <code>?format=json</code> for raw data.</p>
</div></body></html>`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: html,
  };
};
