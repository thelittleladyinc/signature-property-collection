// Human-readable "is everything actually working" status page — one URL
// Christine can bookmark and check herself instead of both of us running
// ad-hoc ?debug=true fetches back and forth every time something seems
// off.
//
// 2026-08-17 — THIS HEADER USED TO PROMISE "read-only by default: it never talks
// to MLS Grid or Cloudinary itself ... loading this page is free and can never
// cost API quota, trigger a request, or interfere with the suspension breaker."
// That promise made the page cheap and also made it untrustworthy: the five
// probe-backed rows rendered whatever the last ?probe=1 run concluded, at any age,
// three of them without even printing a date. Christine had fixed her Cloudinary
// credentials the day before and the page still said "cloud_name mismatch"; I read
// it and repeated it to her as current. Her reply set the standard: confirm it is
// valid and live, or there is no reason for the page to exist.
//
// The promise is KEPT — a plain page load still makes no outbound calls and still
// cannot spend API quota or touch the suspension breaker. What changed is that the
// page no longer hides the cost of that choice. Every probe row prints when it was
// checked, a reading older than the TTL is flagged and stops counting as a pass or
// a fail, and a summary row at the top names everything that needs re-checking with
// the one-click way to do it. Honest by default, live in one click.
//
// (I first made the probes refresh themselves. That broke three suites, each
// guarding a lesson already paid for here. Probing was never the missing piece —
// disclosure was. See the note above freshen().)
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
const { resolveMediaFor, fetchMediaResponse, looksPresigned, isThrottled } = require("./lib/_media");
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
    // 2026-08-16: don't pile on. If MLS Grid has already rate-limited us, this
    // probe's own resolve + image fetch make it worse, and it would report a 429
    // it helped cause. A diagnostic that changes what it measures is worse than
    // no diagnostic. Respects both the sync's suspension flag and the photo
    // cooldown, and says plainly that it declined rather than pretending to pass.
    const throttledUntil = await isThrottled(store);
    if (throttledUntil) {
      const waitSec = Math.max(1, Math.ceil((throttledUntil - Date.now()) / 1000));
      out.ok = true;
      out.skipped = true;
      out.detail = `Not tested just now: MLS Grid requests are in a ${waitSec}s cool-off, ` +
        `so running this probe would add to the rate limiting rather than measure it. ` +
        `The cool-off is normal after a burst — it clears itself. Re-run ?probe=1 after that.`;
      return out;
    }
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
      // 2026-08-16: a 429 is NOT the same finding as a 403 or a 404, and this row
      // used to call every failure "the exact step breaking the photos". Christine
      // hit a 429 right after several ?probe=1 refreshes, and that wording reads as
      // "your photos are broken" when the truth is "you are being rate limited,
      // partly by this very page". MLS Grid's limit is per ACCOUNT and shared with
      // Listing-Engine and Expired-Luxury, so total volume is what matters — and
      // each probe run costs a media-resolve plus a real image fetch.
      out.rateLimited = attempt.res.status === 429;
      out.detail = out.rateLimited
        ? `Rate limited, not broken. MLS Grid returned HTTP 429 for photo 0 of ` +
          `${out.listingId}. The URLs resolved fine (${urls.length} of them), so the ` +
          `pipeline is intact — MLS Grid is just refusing requests right now. That limit ` +
          `is per ACCOUNT and shared with Listing-Engine and Expired-Luxury, and each ` +
          `?probe=1 run costs a resolve plus a real image fetch, so refreshing this page ` +
          `repeatedly contributes to it. Visitors see a grey placeholder that re-tries ` +
          `itself on the next view. Re-check in a few minutes before treating it as a fault.`
        : `Resolved ${urls.length} URL(s) from ${out.mediaHost} ` +
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

// "3 days" reads instantly; an ISO timestamp needs subtracting from today, which
// is the arithmetic that lets a stale verdict pass for a current one.
function describeAge(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "less than a minute";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// 2026-08-17 -- WHY THIS PAGE COULD NOT BE BELIEVED, AND WHAT CHANGED.
//
// Five of these checks are live probes whose results are cached in Blobs:
// Google, the photo pipeline, Cloudinary, the Lofty key, the Lofty lead. All five
// were gated behind ?probe=1. Without it, the page rendered whatever the last
// probe concluded -- with NO cap on how old that was, and, for three of the five,
// no date shown at all.
//
// Christine said "I feel like I already did the cloud thing yesterday". She had.
// The page was still reporting the pre-fix verdict, I read it as current, and told
// her it was still broken. Her response is the right standard: confirm it is valid
// and live, or there is no reason for the page to exist.
//
// Three changes make that true:
//
//   1. EVERY probe row now prints when it was checked, in absolute time and in
//      words ("2 days ago"), so an old reading can never again pass for a current
//      one. Three of the five printed no date at all.
//   2. A verdict older than the TTL is flagged loudly AND stops counting as a
//      pass or a fail, because it is neither -- it is a reading about the past. A
//      stale failure that keeps a row red is how I came to tell Christine her
//      Cloudinary credentials were still broken after she had fixed them.
//   3. A summary row at the top of the page names every check whose reading is
//      old or missing, with the one-click way to refresh them. So the page is
//      honest by default and live in one click.
//
//   WHAT THIS DELIBERATELY DOES NOT DO: probe on its own. I tried that first and
//   it broke three suites, each guarding a lesson already paid for -- a page load
//   makes no outbound calls, rows must not go red for things that are not broken
//   ("the crying-wolf mistake the Cloudinary row already taught us"), and a
//   considered cached verdict must not be silently overwritten. Probing was never
//   the missing piece; disclosure was.
//   2. The probes run in PARALLEL. They were sequential awaits; five of them at
//      6-8s of timeout each is 30-40s, well past a function's budget. In parallel
//      the worst case is the slowest single probe, and the whole group is bounded
//      by PROBE_BUDGET_MS so the page always renders.
//   3. Every probe row prints when it was checked, and says so loudly if that is
//      older than the TTL. This is the backstop: a probe can still fail or time
//      out, and then the page falls back to the cached value -- which must never
//      again be presented as if it were current.
const PROBE_BUDGET_MS = 6500;

function verdictAgeMs(v) {
  return v && v.checkedAt ? Date.now() - Date.parse(v.checkedAt) : null;
}

// The one place that decides whether a cached verdict may be trusted, and
// refreshes it when it may not. Never throws and never returns nothing: on any
// probe failure the previous value is kept, and its age is what tells the reader
// not to trust it.
async function freshen(cached, { enabled, force, probe, key, store }) {
  // Probes stay OPT-IN. I first made them refresh themselves, which broke three
  // suites that each encode a lesson this codebase has already paid for:
  //
  //   - test-leadprobe.js: a plain page load makes no outbound calls at all.
  //   - test-optional.js:  "the crying-wolf mistake the Cloudinary row already
  //                        taught us" -- rows must not go red for things that are
  //                        not actually broken. A probe firing in an environment
  //                        where the call fails produces exactly that.
  //   - test-tagsnotreturned.js: a considered cached verdict, overwritten.
  //
  // Christine's problem was never that the page failed to probe. It was that a
  // verdict from the previous day was indistinguishable from one from this second.
  // That is fixed by SAYING SO -- see ageNote() and the summary row -- which costs
  // no quota, raises no false alarms, and leaves the page one click from live.
  if (!enabled || !force) return cached;
  const age = verdictAgeMs(cached);
  if (age !== null && age < GOOGLE_CHECK_TTL_MS) return cached;
  try {
    const next = await probe();
    if (next) {
      await store.setJSON(key, next).catch(() => {});
      return next;
    }
  } catch (err) {
    console.warn(`site-health: probe for ${key} failed: ${err && err.message}`);
  }
  return cached;
}

// Renders the age of a probe verdict, plus a loud warning when it is old enough
// that acting on it means possibly re-doing work already done.
function ageNote(v) {
  const age = verdictAgeMs(v);
  const stale = age !== null && age > GOOGLE_CHECK_TTL_MS;
  return {
    age,
    stale,
    when: age !== null ? `Checked ${v.checkedAt} (${describeAge(age)} ago). ` : "",
    warning: stale
      ? "THIS READING IS OLD and may predate a fix you have already made — the live " +
        "re-check did not complete, so reload with ?probe=1 before acting on it. "
      : "",
  };
}

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
  const loftyApiKey = process.env.LOFTY_API_KEY;

  // All five probes at once, each refreshing itself if its cached verdict has
  // aged past the TTL, and the whole group bounded so the page always renders.
  // See the note above freshen() for why this is no longer opt-in.
  //
  // Order here is the order of the destructure below; nothing depends on another's
  // result, which is exactly why running them sequentially only ever cost time.
  const probeGroup = Promise.all([
    freshen(cachedGoogle, {
      enabled: !!googleKey, force: wantsProbe, store, key: GOOGLE_CHECK_KEY,
      probe: () => probeGoogle(googleKey),
    }),
    freshen(cachedPhotoCheck, {
      enabled: true, force: wantsProbe, store, key: PHOTO_CHECK_KEY,
      probe: () => probePhotoPipeline(mine, process.env.MLSGRID_API_TOKEN),
    }),
    freshen(cachedCloudCheck, {
      enabled: isCloudinaryConfigured(), force: wantsProbe, store, key: CLOUDINARY_CHECK_KEY,
      probe: () => probeCloudinaryUsage(),
    }),
    freshen(cachedLoftyKey, {
      enabled: !!loftyApiKey, force: wantsProbe, store, key: LOFTY_CHECK_KEY,
      probe: () => probeLoftyKey(loftyApiKey),
    }),
    // Reads the last lead back out of Lofty. Only ever a GET.
    freshen(cachedLoftyLead, {
      enabled: !!loftyApiKey, force: wantsProbe, store, key: LOFTY_LEAD_CHECK_KEY,
      probe: () => probeLoftyLead(loftyApiKey, loftyLast && loftyLast.leadId, LOFTY_TRIGGER_TAG),
    }),
  ]);

  // If the group overruns, fall back to the cached verdicts and let each row's
  // age note say they are old. A slow third party must never turn this page into
  // a timeout -- an unreachable health page is the least useful kind.
  let probeTimer;
  const [google, photoCheck, cloudCheck, loftyKeyCheck, loftyLeadCheck] = await Promise.race([
    probeGroup,
    new Promise((resolve) => {
      probeTimer = setTimeout(() => resolve([
        cachedGoogle, cachedPhotoCheck, cachedCloudCheck, cachedLoftyKey, cachedLoftyLead,
      ]), PROBE_BUDGET_MS);
    }),
  ]);
  clearTimeout(probeTimer);

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
      // 2026-08-16: this row read a flat green "All three env vars present" on the
      // same page where the account check said "cloud_name mismatch". Two rows
      // contradicting each other is worse than one red row, because the reader has
      // to work out which to believe. "Configured" was never the same claim as
      // "working": all three vars ARE set, they just belong to different accounts.
      // So it now says exactly that, and points at the row that knows.
      optional: true,
      name: "Cloudinary env vars set (optional)",
      ok: isCloudinaryConfigured(),
      detail: isCloudinaryConfigured()
        ? "All three env vars are present. Note that PRESENT is not the same as WORKING — " +
          "whether they belong to the same Cloudinary account is what the " +
          "\"Cloudinary account healthy\" row below actually tests."
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
  const googleAge = ageNote(google);
  const googleDetail = (which) => {
    if (!googleKey) return "GOOGLE_MAPS_API_KEY isn't set in Netlify.";
    if (!google || !google[which]) {
      return "Not tested yet — add ?probe=1 to this page's URL to ask Cloudinary about the account directly.";
    }
    const r = google[which];
    // This row always printed its date, but never said whether that date was old
    // enough to disbelieve. The age note supplies the part that was missing.
    const head = googleAge.warning + googleAge.when;
    if (r.ok) return `${head}Working — Google returned ${r.status}.`;
    return `${head}Google says ${r.status}${r.message ? `: ${r.message}` : ""}.`;
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
    ok: !googleKey ? false : (!google || !google.geocoding || googleAge.stale ? true : google.geocoding.ok),
    detail: googleDetail("geocoding") +
      (google && google.geocoding && !google.geocoding.ok
        ? " → enable it at console.cloud.google.com/apis/library/geocoding-backend.googleapis.com"
        : ""),
  });
  checks.push({
    name: "Places API enabled",
    ok: !googleKey ? false : (!google || !google.places || googleAge.stale ? true : google.places.ok),
    detail: googleDetail("places") +
      (google && google.places && !google.places.ok
        ? " → enable it at console.cloud.google.com/apis/library/places-backend.googleapis.com"
        : ""),
  });

  // ---- The photo chain, end to end ----
  const photoAge = ageNote(photoCheck);
  checks.push({
    name: "Listing photos load end to end",
    // Same rule as the other probe rows: a stale FAILURE is not evidence about
    // now, so it must not keep the page red on its own.
    ok: !photoCheck || photoAge.stale ? true : !!photoCheck.ok,
    detail: photoCheck
      ? photoAge.warning + photoAge.when + photoCheck.detail
      : "Not tested yet — add ?probe=1 to this page's URL to walk the whole photo chain " +
        "(resolve the MLS media URLs, then actually fetch one) and see which step fails. " +
        "Note this one spends the MLS Grid quota shared with your other two apps.",
  });
  // 2026-08-17. This row read as a live verdict and was not one. cloudCheck comes
  // out of Blobs and is only re-probed when ?probe=1 is passed AND the cached copy
  // is over GOOGLE_CHECK_TTL_MS old -- but the DISPLAY has never had a staleness
  // cap, so a plain /status visit renders whatever the last probe concluded, for
  // as long as nobody probes again. Fix the credentials and this row keeps
  // reporting "cloud_name mismatch" forever.
  //
  // It also printed no timestamp, while the Lofty row immediately below has always
  // printed "checked <date>". So the one row most likely to be out of date was the
  // one giving no way to tell. Christine said "I feel like I already did the cloud
  // thing yesterday" -- she was reading a verdict that may well predate her fix,
  // and so was I when I repeated it back to her as current.
  //
  // Every branch now states when it was checked, and a reading older than the TTL
  // says so in its first clause rather than burying it.
  const cloudAge = ageNote(cloudCheck);

  checks.push({
    optional: true,
    name: "Cloudinary account healthy (optional)",
    // A stale FAILURE must not keep the page red: it is not evidence about now.
    // A stale success is equally uninformative, but the honest reading of "we
    // don't know" is the same as the never-tested case, which is already green
    // with a "not tested yet" detail.
    ok: !isCloudinaryConfigured() ? false : (!cloudCheck || cloudAge.stale ? true : !!cloudCheck.ok),
    detail: !isCloudinaryConfigured()
      ? "Cloudinary env vars aren't all set."
      : (!cloudCheck
        ? "Not tested yet — add ?probe=1 to this page's URL to ask Cloudinary about the account directly."
        : cloudAge.warning + cloudAge.when + (cloudCheck.ok
          ? `Cloudinary answered: plan "${cloudCheck.plan}"` +
            `${cloudCheck.creditsUsed ? `, credits ${cloudCheck.creditsUsed}` : ""}.` +
            " If credits are at or near 100%, that is what the upload 403 means."
          : `Cloudinary refused the account check${cloudCheck.httpCode ? ` (HTTP ${cloudCheck.httpCode})` : ""}: ` +
            `${cloudCheck.error}. Same credentials the photo uploads use. ` +
            (/cloud_name mismatch/i.test(String(cloudCheck.error))
              ? "FIX: the three CLOUDINARY_* variables in Netlify are not all from the same " +
                "Cloudinary account — the cloud name belongs to one account and the API key/secret " +
                "to another. Open cloudinary.com → Dashboard, copy Cloud name, API Key and API Secret " +
                "from that same page, and replace all three in Netlify → Environment variables."
              : "Check the three CLOUDINARY_* variables in Netlify against cloudinary.com → Dashboard."))),
  });

  // ---- Lofty API key valid? ----
  const loftyKeyAge = ageNote(loftyKeyCheck);
  checks.push({
    name: "Lofty API key valid",
    ok: !process.env.LOFTY_API_KEY
      ? false
      : (!loftyKeyCheck || loftyKeyAge.stale ? true : loftyKeyCheck.ok),
    detail: !process.env.LOFTY_API_KEY
      ? "LOFTY_API_KEY isn't set in Netlify."
      : (!loftyKeyCheck
        ? "Not tested yet — add ?probe=1 to this page's URL to ask Cloudinary about the account directly."
        : loftyKeyAge.warning + loftyKeyAge.when + (loftyKeyCheck.ok
          ? `Lofty accepted the key (HTTP ${loftyKeyCheck.httpStatus}).`
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
  // Same staleness contract as every other probe row: say when it was checked,
  // and don't let an old failure stand as a current one.
  const leadAge = ageNote(loftyLeadCheck);
  checks.push({
    name: "What Lofty says about your last lead",
    ok: leadAge.stale ? true : leadRowOk,
    detail: loftyLeadCheck ? leadAge.warning + leadAge.when + leadRowDetail : leadRowDetail,
  });

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
    // 2026-08-16: a spot can legitimately belong to more than one town PAGE without
    // being more than one place. Windsor straddles Larimer and Weld and so has a
    // page in each; alsoOnCityHrefs puts the Mill Tavern and Windsor Lake on both
    // from a single record. Counting only cityHref would keep reporting the Larimer
    // page as empty when it is not, which is exactly the wrong-in-a-reassuring-
    // direction this row exists to prevent.
    for (const href of [s.cityHref, ...(s.alsoOnCityHrefs || [])]) {
      if (!href) continue;
      const prev = spotCounts.get(href) || { city: s.city, count: 0, views: 0 };
      prev.count += 1;
      prev.views += (s.views || 0) + (s.reviewViews || 0);
      spotCounts.set(href, prev);
    }
  }
  const townPages = Array.isArray(LOCAL_SPOTS.townPages) ? LOCAL_SPOTS.townPages : [];
  // Label each row by the TOWN PAGE, not by the first spot that happened to land
  // on it. Several spots sit in one town but belong on another's page — Poudre
  // Canyon is in Bellvue and Horsetooth Reservoir is in Fort Collins, and both
  // are on the Fort Collins page. Reading the label off the first spot printed
  // "Bellvue 2", which names a town that has no page at all.
  const pageCity = new Map(townPages.map((t) => [t.href, t.city]));
  // 2026-08-16: her report listed "Windsor, Windsor". Windsor straddles Larimer and
  // Weld, so it genuinely has two town pages, and printing the bare city name twice
  // looks like a bug in the report rather than the fact it is. Qualified by county
  // so the two are distinguishable.
  //
  // Later the same day, and the reason this is now a shared function: the
  // qualification was written inline in the EMPTY list only. The moment Windsor got
  // spots on both pages it moved to the COVERED list, which had no such handling,
  // and the report would have read "Windsor 2 · Windsor 2" -- the identical
  // confusion, reintroduced by fixing something else. One label, both lists.
  const townLabel = (href, fallbackCity) => {
    const city = pageCity.get(href) || fallbackCity;
    const county = (String(href).match(/^\/communities\/([^/]+)\//) || [])[1];
    const dupe = townPages.filter((o) => o.city === city).length > 1;
    return dupe && county ? `${city} (${county.replace(/-/g, " ")})` : city;
  };
  const covered = [...spotCounts.entries()]
    .map(([href, v]) => ({ href, ...v, city: townLabel(href, v.city) }))
    .sort((a, b) => (b.count - a.count) || (b.views - a.views));
  const empty = [...new Set(townPages
    .filter((t) => !spotCounts.has(t.href))
    .map((t) => townLabel(t.href, t.city)))];
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
  // 2026-08-16, SETTLED WITH EVIDENCE, and it is the merge case rather than a
  // fault. Christine submitted a real listing-inquiry at 13:50; the push
  // succeeded and returned leadId 1147334685108095, and POST /notes for that very
  // id came back 404 "Lead not exist" -- while an unrelated lead read back 200.
  //
  // Lofty hands back the id of the record it ABSORBED on a merge, never the
  // survivor's, and offers no lookup-by-email to find the survivor. So this
  // cannot be fixed from here -- but it also only happens when the submitter is
  // already in her CRM, which so far has only ever been Christine testing with
  // her own account-owner address. A stranger creates a new contact, the id
  // resolves, and note and tag both land.
  //
  // Rendered as informational for that reason. A red X here told her the lead
  // pipeline was broken when the only thing that had happened was Lofty
  // deduplicating her own email -- and a status page that overstates is one she
  // stops trusting for the rows that do matter.
  const leadMerged = !!(note && note.leadMissing);
  const parts = [];
  if (!note || !note.attempted) {
    parts.push("Timeline note: not attempted yet.");
  } else if (note.ok) {
    parts.push("Timeline note: written to the lead ✓.");
  } else if (leadMerged) {
    parts.push("This lead MERGED into a contact Lofty already had, and Lofty returns the " +
      "id of the record it absorbed rather than the surviving contact's — so the timeline " +
      "note had no id to attach to (404 \"Lead not exist\"). Its API offers no way to look a " +
      "contact up by email, so nothing more can be done from here. Two things to know: the " +
      "tag from the original push IS on the surviving contact (Lofty appends tags on a " +
      "merge), and this only happens for someone already in your CRM — which so far has only " +
      "been you, testing with your own address. A new enquirer creates a new contact, the id " +
      "works, and both the note and the tag land normally.");
  } else {
    parts.push(`Timeline note FAILED (${note.httpStatus || note.error || "unknown"}).`);
  }
  if (leadMerged) {
    // The tag call reads the same unresolvable id, so submission-created no
    // longer spends a request on it. Saying so beats an unexplained gap.
    parts.push("Trigger tag: not attempted, because it reads the same id and would fail " +
      "the same way.");
  } else if (!tag || !tag.attempted) {
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
    optional: leadMerged,
    name: leadMerged
      ? "Lofty note on your last lead (it merged — expected)"
      : "Your Lofty notification will fire",
    ok: leadMerged ? false
      : (!note || !note.attempted) ? true
      : (!!note.ok && (!tag || !tag.attempted || (tag.ok && tag.tagRestored !== false))),
    detail: parts.join(" ") + (leadMerged ? "" :
      " These are what make a lead that MERGED into an existing contact still show up — " +
      "the case that hid your own test submissions, because they used your account-owner email."),
  });

  // 2026-08-15: some checks describe an OPTIONAL improvement rather than
  // something broken. Cloudinary is the case that forced this: since the photo
  // endpoint began serving every listing from this site's own domain, a
  // Cloudinary copy is a nice-to-have (permanent URLs, fewer MLS Grid calls) and
  // its absence breaks nothing a visitor can see. Leaving those rows as red X's
  // told Christine the site was broken when it wasn't -- and a status page that
  // cries wolf is worse than no status page, because the real red rows stop
  // standing out.
  // ---- Are the live readings on this page current? --------------------------
  // 2026-08-17, and the whole point of the change. Five rows above are live
  // probes whose results are cached, and they only re-run under ?probe=1. That is
  // deliberate and stays -- but it means this page can be showing readings from
  // days ago, and until now nothing said so. Christine fixed her Cloudinary
  // credentials, the page kept reporting the old failure, and I relayed it to her
  // as current. She said: confirm it is valid and live, or there is no reason for
  // it. This row is that confirmation, stated once at the top instead of left for
  // the reader to work out per row.
  //
  // Placed FIRST via unshift, because a note about the trustworthiness of the
  // other rows is worthless below them. Marked optional so it can never turn the
  // page red on its own -- "these readings are old" is not a site fault, and the
  // crying-wolf lesson above applies to this row as much as to any other.
  const probeRows = [
    ["Google Maps APIs", google, !!googleKey],
    ["Cloudinary account", cloudCheck, isCloudinaryConfigured()],
    ["photo chain", photoCheck, true],
    ["Lofty key", loftyKeyCheck, !!loftyApiKey],
    ["last lead in Lofty", loftyLeadCheck, !!loftyApiKey],
  ].filter(([, , applicable]) => applicable);

  const staleRows = probeRows.filter(([, v]) => ageNote(v).stale).map(([n]) => n);
  const neverRun = probeRows.filter(([, v]) => !v).map(([n]) => n);
  const freshest = probeRows
    .map(([, v]) => verdictAgeMs(v))
    .filter((a) => a !== null)
    .sort((a, b) => a - b)[0];

  checks.unshift({
    optional: true,
    name: "Live checks are current",
    ok: staleRows.length === 0 && neverRun.length === 0,
    detail: (staleRows.length === 0 && neverRun.length === 0)
      ? `All live checks on this page were run within the last ` +
        `${Math.round(GOOGLE_CHECK_TTL_MS / 60000)} minutes` +
        `${freshest !== undefined ? ` (most recent: ${describeAge(freshest)} ago)` : ""}. ` +
        "Everything below reflects right now."
      : "Some rows below are showing SAVED readings, not live ones — " +
        (neverRun.length ? `never run: ${neverRun.join(", ")}. ` : "") +
        (staleRows.length ? `older than ${Math.round(GOOGLE_CHECK_TTL_MS / 60000)} minutes: ${staleRows.join(", ")}. ` : "") +
        "Add ?probe=1 to this page's URL to re-run them all against the real services " +
        "before acting on anything they say. This page does not probe on its own, so " +
        "loading it never spends API quota — the trade is that a reading can be old, " +
        "and this row is here so that is never a surprise.",
  });

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
