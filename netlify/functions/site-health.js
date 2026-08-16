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
const { tagsFromLead, describeTagShape } = require("./lib/_notify");
// Read for the Tour It With Me coverage row below — same file the map reads.
const LOCAL_SPOTS = require("./lib/_local-spots.json");

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
const LOFTY_LEAD_CHECK_KEY = "lofty-lead-check.json";
// Must match TRIGGER_TAG in submission-created.js.
const LOFTY_TRIGGER_TAG = "Hot Lead - Website";
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
// Reads back the LAST lead this site pushed and reports what Lofty says about
// it. Read-only on purpose -- it creates nothing, changes nothing, and adds no
// junk contact to her CRM.
//
// 2026-08-15 (Christine: "can you check again? just revonnected?"). I can't. Her
// live site, api.lofty.com and developer.lofty.com are all blocked by this
// environment's egress proxy, so every question about what Lofty actually
// returns has had to be relayed through her, one screenshot at a time, and the
// answer keeps arriving hours later than the question. This probe collapses that
// loop: one page load answers the three things I have been unable to check.
//
//   1. Does GET /leads/{id} work on her account at all? If it 404s, the tag
//      re-fire can never run, and that would be the whole story.
//   2. What SHAPE are tags in? Strings, or objects? That is the unknown behind
//      the data-loss guard in lib/_notify.js -- it currently refuses to touch a
//      lead whose tags it can't read, which is safe but means the Smart Plan
//      never re-triggers. Knowing the shape is what lets that be fixed properly.
//   3. Is "Hot Lead - Website" actually ON that lead right now? That settles
//      whether the tag is reaching Lofty, independently of any automation.
//
// Deliberately reports counts and the trigger tag's presence rather than dumping
// the lead: this page is reachable by anyone who knows the URL.
async function probeLoftyLead(apiKey, leadId, triggerTag) {
  const base = { checkedAt: new Date().toISOString(), leadId: leadId || null };
  if (!leadId) {
    return { ...base, ok: false, reason: "no lead has been pushed yet, so there's nothing to read back" };
  }
  try {
    const res = await fetch(`https://api.lofty.com/v1.0/leads/${leadId}`, {
      headers: { "Authorization": `token ${apiKey}` },
      signal: AbortSignal.timeout(GOOGLE_PROBE_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return { ...base, ok: false, httpStatus: res.status, body: text.slice(0, 200) };
    }
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    const lead = (json && (json.data || json)) || {};
    const readable = tagsFromLead(json);
    return {
      ...base,
      ok: true,
      httpStatus: res.status,
      tagShape: describeTagShape(json),
      // Null means lib/_notify.js will refuse to edit tags on this lead.
      tagsReadable: readable !== null,
      tagCount: Array.isArray(lead.tags) ? lead.tags.length : null,
      hasTriggerTag: readable !== null ? readable.includes(triggerTag) : null,
      // Only when the shape is one we DON'T understand, and trimmed hard -- this
      // is the sample that lets the reader be fixed.
      sample: readable === null && Array.isArray(lead.tags) && lead.tags.length
        ? JSON.stringify(lead.tags[0]).slice(0, 120)
        : null,
    };
  } catch (err) {
    return { ...base, ok: false, httpStatus: "request failed", body: (err && err.message) || "" };
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
    cachedLoftyLead, cachedPhotoCheck, cachedCloudCheck] = await Promise.all([
    store.get(SYNC_STATE_KEY, { type: "json" }),
    store.get(MINE_LISTINGS_KEY, { type: "json" }),
    store.get(SUSPENSION_KEY, { type: "json" }),
    store.get(GOOGLE_CHECK_KEY, { type: "json" }).catch(() => null),
    store.get(LOFTY_LAST_PUSH_KEY, { type: "json" }).catch(() => null),
    store.get(LOFTY_FAILED_PUSH_KEY, { type: "json" }).catch(() => null),
    store.get(LOFTY_CHECK_KEY, { type: "json" }).catch(() => null),
    store.get(LOFTY_LEAD_CHECK_KEY, { type: "json" }).catch(() => null),
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

  // Reads the last lead back out of Lofty. Cached like the others so refreshing
  // the page doesn't hammer the API, and only ever a GET.
  let loftyLeadCheck = cachedLoftyLead;
  const loftyLeadFresh = loftyLeadCheck && loftyLeadCheck.checkedAt &&
    Date.now() - Date.parse(loftyLeadCheck.checkedAt) < GOOGLE_CHECK_TTL_MS;
  if (wantsProbe && loftyApiKey && !loftyLeadFresh) {
    loftyLeadCheck = await probeLoftyLead(
      loftyApiKey, loftyLast && loftyLast.leadId, LOFTY_TRIGGER_TAG);
    await store.setJSON(LOFTY_LEAD_CHECK_KEY, loftyLeadCheck).catch(() => {});
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

  // ---- Is Christine actually being TOLD about the lead? --------------------
  // 2026-08-15: added because the answer turned out to be no, twice, while the
  // row above said the push was fine. Reaching the CRM and reaching HER are two
  // different things, and only one of them loses business when it breaks.
  // 2026-08-15 (Christine: "i dont think i already have resend - never used it -
  // we cant use lofty to send?"). She's right on both counts, and I was wrong to
  // present it as something she already had: sellerintelligence contains the
  // digest CODE but there is no key in her Netlify env, no key in that repo's CI
  // secrets, and no .env committed -- it was written and never switched on.
  //
  // So this row is OPTIONAL, not a failure. The Lofty route is the primary one
  // and it is now genuinely fixed (see the tag re-add in submission-created.js),
  // which is what the row below reports. This second, vendor-independent email is
  // a belt-and-braces backup for the day Lofty itself is down -- worth having
  // eventually, worth nobody's afternoon today. A red X here would be the same
  // crying-wolf mistake the Cloudinary row made.
  const emailKeySet = !!process.env.RESEND_API_KEY;
  const lastEmail = loftyLast && loftyLast.emailResult;
  let emailOk;
  let emailDetail;
  let emailOptional = false;
  if (!emailKeySet) {
    emailOk = false;
    emailOptional = true;
    emailDetail = "Not set up, and nothing is broken by that — your Lofty notification is the " +
      "primary route and it works. This is only a backup for the day Lofty itself is down: " +
      "a plain email straight from this site, needing no CRM automation to fire. " +
      "If you ever want it, make a free key at resend.com/api-keys and add RESEND_API_KEY in " +
      "Netlify → Site configuration → Environment variables. " +
      "Optional extras: LEAD_ALERT_TO to change or add recipients, LEAD_ALERT_FROM once your " +
      "own domain is verified in Resend. A simpler backup needing no signup at all: " +
      "Netlify → Site configuration → Notifications → form submission email.";
  } else if (!lastEmail || !lastEmail.attempted) {
    emailOk = true;
    emailDetail = "The key is set. No lead has come in since — submit any form once and this row " +
      "will show whether the email actually left.";
  } else if (lastEmail.ok) {
    emailOk = true;
    emailDetail = `Sent to you at ${loftyLast.at} for the lead from "${loftyLast.formName}". ` +
      "If it isn't in your inbox, check spam — the default sender is Resend's shared " +
      "onboarding@resend.dev address, which only delivers to the Resend account owner.";
  } else {
    emailOk = false;
    emailDetail = `The lead email FAILED at ${loftyLast.at}: ` +
      `${lastEmail.httpStatus ? `HTTP ${lastEmail.httpStatus} — ` : ""}` +
      `${String(lastEmail.response || lastEmail.error || "(no detail)").slice(0, 240)}. ` +
      "The lead itself is safe (Netlify Forms and Lofty both have it) — this is only the alert.";
  }
  // ---- What Lofty says about the last lead, read straight back ------------
  // The row that exists so nobody has to relay a screenshot to find out.
  let leadRowOk;
  let leadRowDetail;
  if (!loftyApiKey) {
    leadRowOk = false;
    leadRowDetail = "LOFTY_API_KEY isn't set.";
  } else if (!loftyLeadCheck) {
    leadRowOk = true;
    leadRowDetail = "Not run yet — add ?probe=1 to this page's URL and it will read your most " +
      "recent website lead back out of Lofty and report exactly what came back. Read-only: " +
      "it creates nothing and changes nothing.";
  } else if (!loftyLeadCheck.leadId) {
    leadRowOk = true;
    leadRowDetail = loftyLeadCheck.reason || "No lead pushed yet.";
  } else if (!loftyLeadCheck.ok) {
    leadRowOk = false;
    leadRowDetail = `Lofty would NOT return lead ${loftyLeadCheck.leadId}: ` +
      `${loftyLeadCheck.httpStatus}${loftyLeadCheck.body ? ` — ${String(loftyLeadCheck.body).slice(0, 200)}` : ""}. ` +
      "If this is a 404, then GET /leads/{id} isn't available on this account and the trigger " +
      "tag can never be re-fired — which would explain a Smart Plan that never runs.";
  } else if (/no 'tags' field/.test(loftyLeadCheck.tagShape || "")) {
    // 2026-08-16: answered, so stop asking. Lofty's GET /leads/{id} returns no
    // tags on this account, which means the tag can never be re-fired for a
    // repeat enquiry. Not a fault on this side and not fixable from here, so it
    // reads as a known limitation with the actual remedy attached.
    leadRowOk = true;
    leadRowDetail = `Read lead ${loftyLeadCheck.leadId} back from Lofty ✓ (HTTP 200) — and this ` +
      `settles the notification question. Lofty's API does NOT return tags for a lead, so this site ` +
      `cannot check or re-apply the "${LOFTY_TRIGGER_TAG}" tag. The tag sent when the lead is created ` +
      `still lands, so a brand-new contact is fine; a RETURNING buyer whose contact already exists ` +
      `cannot have the tag re-added, which is exactly what a "Tag Added" Smart Plan needs in order to ` +
      `fire a second time. Nothing more can be done through Lofty's API here. The reliable fix is the ` +
      `backup email row below — it does not depend on Lofty at all.`;
  } else {
    // The three answers, in one line, in plain words.
    leadRowOk = loftyLeadCheck.tagsReadable !== false && loftyLeadCheck.hasTriggerTag !== false;
    leadRowDetail = `Read lead ${loftyLeadCheck.leadId} back from Lofty ✓ (HTTP 200). ` +
      `Tags: ${loftyLeadCheck.tagShape}. ` +
      (loftyLeadCheck.tagsReadable === false
        ? `This site can't safely edit tags in that shape, so it leaves them alone — ` +
          `send me this line${loftyLeadCheck.sample ? ` including: ${loftyLeadCheck.sample}` : ""} and I'll fix the reader.`
        : (loftyLeadCheck.hasTriggerTag
          ? `"${LOFTY_TRIGGER_TAG}" IS on the lead ✓ — so the tag is reaching Lofty, and if your ` +
            `Smart Plan still didn't run, the trigger inside the plan is what needs looking at.`
          : `"${LOFTY_TRIGGER_TAG}" is NOT on the lead ✗ — Lofty accepted the lead but dropped the ` +
            `tag, which is the reason a tag-triggered Smart Plan wouldn't fire.`));
  }
  checks.push({ name: "What Lofty says about your last lead", ok: leadRowOk, detail: leadRowDetail });

  // ---- "Tour It With Me" coverage, ranked -----------------------------------
  // 2026-08-15 (Christine: "how do i view the highest count for tour it with me?
  // ... for ex windsor town but mentions 3 in town places"). She'd spotted that a
  // town page's prose can name three places while its Tour It With Me section
  // pins none of them, and nothing on the site would tell her. This row is that
  // answer: every town ranked by how many of her spots it carries, with the
  // empty ones named explicitly. A coverage report that only lists what's done
  // is a progress bar, not a to-do list.
  const spotCounts = new Map();
  for (const s of LOCAL_SPOTS.spots || []) {
    if (!s.cityHref) continue;
    const prev = spotCounts.get(s.cityHref) || { city: s.city, count: 0, views: 0 };
    prev.count += 1;
    prev.views += (s.views || 0) + (s.reviewViews || 0);
    spotCounts.set(s.cityHref, prev);
  }
  const townPages = Array.isArray(LOCAL_SPOTS.townPages) ? LOCAL_SPOTS.townPages : [];
  // Label each row by the TOWN PAGE, not by the first spot that happened to land
  // on it. Several spots sit in one town but belong on another's page — Poudre
  // Canyon is in Bellvue and Horsetooth Reservoir is in Fort Collins, and both
  // are on the Fort Collins page. Reading the label off the first spot printed
  // "Bellvue 2", which names a town that has no page at all.
  const pageCity = new Map(townPages.map((t) => [t.href, t.city]));
  const covered = [...spotCounts.entries()]
    .map(([href, v]) => ({ href, ...v, city: pageCity.get(href) || v.city }))
    .sort((a, b) => (b.count - a.count) || (b.views - a.views));
  // 2026-08-16: her report listed "Windsor, Windsor". Windsor straddles Larimer
  // and Weld, so it genuinely has two town pages, and printing the bare city name
  // twice looks like a bug in the report rather than the fact it is. Qualified by
  // county so the two are distinguishable, and deduped as a backstop.
  const empty = [...new Set(townPages
    .filter((t) => !spotCounts.has(t.href))
    .map((t) => {
      const county = (String(t.href).match(/^\/communities\/([^/]+)\//) || [])[1];
      const dupe = townPages.filter((o) => o.city === t.city).length > 1;
      return dupe && county
        ? `${t.city} (${county.replace(/-/g, " ")})`
        : t.city;
    }))];
  const ranked = covered
    .map((t) => `${t.city} ${t.count}` + (t.views ? ` (${t.views.toLocaleString()} views)` : ""))
    .join(" · ");
  checks.push({
    // Not a failure: an uncovered town is work to do, not something broken.
    optional: empty.length > 0,
    name: "Tour It With Me coverage" + (empty.length ? " (towns still empty)" : ""),
    ok: empty.length === 0,
    detail: (covered.length
      ? `Ranked by number of spots — ${ranked}. `
      : "No town has spots yet. ") +
      (empty.length
        ? `${empty.length} of ${townPages.length} town pages have NO spots yet: ${empty.join(", ")}. ` +
          "Each of those pages already describes local places in its text; they just have nothing " +
          "of yours pinned to them. Send a business name and town for any of them and it appears " +
          "on both the town page and the county map."
        : `All ${townPages.length} town pages have at least one spot.`),
  });

  checks.push({
    optional: emailOptional,
    name: emailOptional ? "Backup email alert, no CRM needed (optional)" : "New-lead email reaching you",
    ok: emailOk,
    detail: emailDetail,
  });

  // The two calls that make a MERGED lead visible in Lofty: a note of its own,
  // and a tag that genuinely counts as newly added so a Smart Plan re-triggers.
  const note = loftyLast && loftyLast.noteResult;
  const tag = loftyLast && loftyLast.tagResult;
  const parts = [];
  if (!note || !note.attempted) {
    parts.push("Timeline note: not attempted yet.");
  } else if (note.ok) {
    parts.push("Timeline note: written to the lead ✓.");
  } else {
    parts.push(`Timeline note FAILED (${note.httpStatus || note.error || "unknown"}).`);
  }
  if (!tag || !tag.attempted) {
    parts.push("Trigger tag: not attempted yet.");
  } else if (tag.ok) {
    parts.push(tag.step === "refired"
      ? `Trigger tag: removed and re-added, so "Hot Lead - Website" counts as a NEW tag and your Smart Plan fires even for a repeat enquiry ✓.`
      : `Trigger tag: added to the lead ✓ (this lead already had ${tag.tagsSeen ?? "?"} other tag(s)).`);
  } else if (tag.step === "read") {
    // 2026-08-15: worth calling out separately. If Lofty won't let us READ the
    // lead we just created, the tag can never be re-fired, and that is a
    // different problem from the tag edit being refused.
    parts.push(`Trigger tag: could NOT read the lead back from Lofty ` +
      `(HTTP ${tag.httpStatus}${tag.response ? ` — ${String(tag.response).slice(0, 120)}` : ""}). ` +
      `The tag from the original push should still be on the lead, but it could not be re-fired.`);
  } else if (tag.step === "unreadable-tags") {
    parts.push(`Trigger tag: left alone on purpose — Lofty returned tags in a shape this code ` +
      `doesn't recognise (${tag.tagShape || "unknown"}), and overwriting them could have deleted ` +
      `tags on a real client's record. Nothing was changed. Send me this line and I'll fix the reader.`);
  } else if (tag.tagRestored === false) {
    parts.push(`Trigger tag: the re-add FAILED (${tag.httpStatus || tag.error || "unknown"}) — ` +
      `the lead is currently missing "Hot Lead - Website". Add it by hand on that lead in Lofty.`);
  } else {
    parts.push(`Trigger tag: unchanged, Lofty refused the edit (${tag.httpStatus || tag.error || "unknown"}). ` +
      "The tag from the original push is still there; only the re-trigger didn't happen.");
  }
  checks.push({
    // Named for what she cares about, not for the mechanism: this row is the
    // primary notification path now that the tag genuinely changes.
    name: "Your Lofty notification will fire",
    ok: (!note || !note.attempted) ? true
      : (!!note.ok && (!tag || !tag.attempted || (tag.ok && tag.tagRestored !== false))),
    detail: parts.join(" ") +
      " These are what make a lead that MERGED into an existing contact still show up — " +
      "the case that hid your own test submissions, because they used your account-owner email.",
  });

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
      body: JSON.stringify({ allOk, checks, raw: { state, suspension, mineCount, mineCloudinaryCount, google, loftyLast, loftyFailed, loftyKeyCheck, loftyLeadCheck, photoCheck, cloudCheck } }, null, 2),
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
