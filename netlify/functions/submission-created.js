// Netlify auto-invokes any function named exactly "submission-created" right
// after a Netlify Forms submission succeeds — no webhook config needed. This
// pushes that lead into Lofty CRM as a new lead, using the same
// api.lofty.com/v1.0/leads pattern already proven in Christine's
// sellerintelligence project (src/sync/push-to-lofty.ts).
//
// Setup required (one-time, in the Netlify dashboard — never commit the key):
//   Site settings -> Environment variables -> add LOFTY_API_KEY
//   (same value as LOFTY_API_KEY in sellerintelligence's .env)
//
// If LOFTY_API_KEY isn't set, this function no-ops rather than failing --
// the Netlify Forms submission itself (Christine's fallback inbox) always
// succeeds independently of this function.
//
// 2026-08-15 (Christine: "i filled out a form earlier and nothing got pushed ot
// lofty", with her Lofty dashboard showing 0 new leads). Checked her real site
// through Netlify's API: the contact form has submission_count 1 with
// last_submission_at 13:55 UTC that same day, so Netlify captured the lead
// perfectly and the break was here, between Netlify and Lofty.
//
// The reason nobody could tell WHICH break it was: this function caught the
// failure, logged it, and returned 200. Correct for the visitor -- their
// submission is safely in Netlify Forms either way -- but it meant a broken
// integration looked identical to a working one from the outside. Same class of
// invisible failure as the stalled sync and the expired photo URLs. Three fixes:
//
//   1. The result of every push is written to Blobs and shown on /site-health,
//      including Lofty's own HTTP status and the first part of its response
//      body. That is what says whether this is a bad key, a rejected field, or
//      an endpoint that moved.
//   2. A failed push is QUEUED with the full lead payload (capped, newest kept)
//      so a lead is never lost to an outage and can be replayed once the cause
//      is fixed, instead of asking Christine to re-type it out of the Netlify
//      dashboard.
//   3. Lofty documents two auth styles -- an API key from Settings >
//      Integrations > API, and OAuth 2.0 bearer tokens -- and its docs aren't
//      reachable from this build environment to confirm which one an API key
//      wants. So the request is tried as "token <key>" (the style inherited
//      from Christine's sellerintelligence project) and, ONLY if that returns
//      401/403, retried once as "Bearer <key>". Which style worked is recorded,
//      so this can be pinned to the single correct one rather than left
//      guessing forever. A 401 means the first attempt failed anyway, so the
//      retry costs nothing and can't mask a working path.
const { getStore } = require("@netlify/blobs");
const { getBlobStore } = require("./lib/_mls-shared");

const LOFTY_BASE_URL = "https://api.lofty.com/v1.0";
const DIAG_STORE = "mls-listings";        // same store the rest of the site uses
const LAST_PUSH_KEY = "lofty-last-push.json";
const FAILED_PUSH_KEY = "lofty-failed-pushes.json";
const MAX_QUEUED_FAILURES = 25;

// Posts the lead, trying the API-key header style first and the OAuth bearer
// style only on an auth rejection. Returns everything the caller needs to record
// what happened.
async function postLead(body, apiKey) {
  const styles = [
    { style: "token", value: `token ${apiKey}` },
    { style: "bearer", value: `Bearer ${apiKey}` },
  ];
  let last = null;
  for (const attempt of styles) {
    const res = await fetch(`${LOFTY_BASE_URL}/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": attempt.value },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    last = { ok: res.ok, httpStatus: res.status, authStyle: attempt.style, responseBody: text.slice(0, 500) };
    if (res.ok) return last;
    // Anything other than an auth rejection is a real answer from Lofty (a
    // rejected field, a moved endpoint) -- retrying with a different header
    // would only obscure it.
    if (res.status !== 401 && res.status !== 403) return last;
  }
  return last;
}

async function recordPush(result, formName) {
  try {
    const store = getBlobStore(getStore, DIAG_STORE);
    await store.setJSON(LAST_PUSH_KEY, { at: new Date().toISOString(), formName, ...result });
    if (!result.ok) {
      const queue = (await store.get(FAILED_PUSH_KEY, { type: "json" }).catch(() => null)) || [];
      queue.unshift({ at: new Date().toISOString(), formName, ...result });
      await store.setJSON(FAILED_PUSH_KEY, queue.slice(0, MAX_QUEUED_FAILURES));
    }
  } catch (err) {
    // Diagnostics must never be the reason a lead push fails.
    console.error("could not record Lofty push result:", err && err.message);
  }
}

// Human-friendly source label per form-name, so leads are easy to tell apart
// inside Lofty. Falls back to the raw form name for anything not listed.
const SOURCE_LABELS = {
  "contact": "Signature Property Collection - Contact Form",
  "buyers-guide": "Signature Property Collection - Buyer's Guide Download",
  "sellers-guide": "Signature Property Collection - Seller's Guide Download",
  "relocation": "Signature Property Collection - Relocation Page",
  "free-home-valuation": "Signature Property Collection - Free Home Valuation",
  "lifestyle-search": "Signature Property Collection - Lifestyle Search",
  "listing-inquiry": "Signature Property Collection - Listing Inquiry (Current Listings page)",
  "neighborhood-quiz": "Signature Property Collection - Neighborhood Quiz",
  // 2026-08-13: added when buyers.html/sellers.html/relocation.html got
  // their own real lead-capture forms (previously they only linked out to
  // /contact.html) -- see build.py build_buyers()/build_sellers().
  "buyers-page-inquiry": "Signature Property Collection - Buyers Page Inquiry",
  // 2026-08-15: the "Email Me New Matches" button on every search widget. See
  // the alert_criteria block below -- this is the lead type that should get a
  // Lofty Property Alert turned on.
  "listing-alert-request": "Signature Property Collection - Listing Alert Request (saved search)",
  "sellers-page-inquiry": "Signature Property Collection - Sellers Page Inquiry (Home Valuation)",
};

function splitName(fullName) {
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: undefined, lastName: undefined };
  if (parts.length === 1) return { firstName: parts[0], lastName: undefined };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

exports.handler = async (event) => {
  try {
    const apiKey = process.env.LOFTY_API_KEY;
    if (!apiKey) {
      console.log("LOFTY_API_KEY not set — skipping Lofty push (Netlify Forms submission still recorded normally).");
      return { statusCode: 200, body: "ok (lofty sync skipped, no api key)" };
    }

    const payload = JSON.parse(event.body);
    const data = (payload && payload.payload && payload.payload.data) || {};
    const formName = (payload && payload.payload && payload.payload.form_name) || "website";

    const { firstName, lastName } = splitName(data.name);
    const body = {};
    if (firstName) body.firstName = firstName;
    if (lastName) body.lastName = lastName;
    if (data.email) body.emails = [data.email];
    if (data.phone) body.phones = [data.phone];
    body.source = SOURCE_LABELS[formName] || `Signature Property Collection - ${formName}`;
    body.tags = ["Website Lead", formName];
    if (formName === "listing-alert-request") {
      // 2026-08-15 (Christine: "we have the lofty api that connects to my
      // emails - review it"). Reviewed: Lofty's own Property Alerts -- a Smart
      // Plan carrying saved search criteria -- already send listing alerts from
      // her CRM, branded, tracked against the lead, with unsubscribe handled.
      // That's strictly better than adding a transactional email provider and
      // rebuilding a worse version of it, so this pushes the buyer's actual
      // search into Lofty as a lead instead.
      //
      // alert_criteria is the search in plain English (what she reads);
      // alert_query is the exact query string, so the same search can be
      // reproduced on the site or pasted into a Smart Plan's criteria.
      //
      // Deliberately does NOT try to create the Property Alert over the API:
      // Lofty's API docs weren't reachable from the build environment, so the
      // endpoint couldn't be verified, and a guessed endpoint would fail
      // silently -- the worst outcome for a lead-capture path. The lead arrives
      // tagged and ready; switching the alert on is one step in Lofty.
      body.notes = `Wants email alerts for new listings matching: ${data.alert_criteria || "(no filters — all new listings)"}` +
        (data.alert_query ? `\nReproduce this search: https://signaturepropertycollection.com/search-homes.html?${data.alert_query}` : "") +
        (data.message ? `\nAlso said: "${data.message}"` : "");
      body.tags.push("Property Alert Request", "Saved Search");
    } else if (data.listing_address) {
      // From the Current Listings page's Ask A Question / Request A Tour
      // buttons (netlify/functions/listings-search.js + build_current_listings()).
      const kind = data.inquiry_type === "Tour" ? "Requested a tour" : "Asked a question";
      const mls = data.listing_mls ? ` (MLS# ${data.listing_mls})` : "";
      const msg = data.message ? ` — "${data.message}"` : "";
      body.notes = `${kind} about listing: ${data.listing_address}${mls}${msg}`;
      body.tags.push(data.inquiry_type === "Tour" ? "Tour Request" : "Listing Question");
    } else if (data.moving_from) {
      // From the Relocation page's form (build_nav_pages() in build.py).
      body.notes = `Relocating from: ${data.moving_from}` +
        (data.message ? ` — "${data.message}"` : "");
    } else if (data.address) {
      body.notes = `Requested valuation for: ${data.address}`;
    } else if (data.message) {
      // From the Buyers page's form (build_buyers() in build.py).
      body.notes = data.message;
    } else if (data.quiz_match) {
      // From the Neighborhood Quiz (build_neighborhood_quiz() in build.py) —
      // quiz_match is the top city match (+ runner-up), quiz_answers is a
      // readable summary of what they picked, so the lead lands in Lofty
      // with real context instead of just a name/email.
      body.notes = `Neighborhood Quiz match: ${data.quiz_match}` +
        (data.quiz_answers ? ` — ${data.quiz_answers}` : "");
      body.tags.push("Neighborhood Quiz");
    }

    const result = await postLead(body, apiKey);

    if (!result.ok) {
      console.error(`Lofty API ${result.httpStatus} (auth style "${result.authStyle}"): ${result.responseBody}`);
      // The lead itself is queued by recordPush() and is also sitting in
      // Netlify Forms, so nothing is lost. Still returns 200: failing here
      // would not help the visitor, whose submission already succeeded.
      await recordPush({ ...result, lead: body }, formName);
      return { statusCode: 200, body: "ok (lofty push failed — see /site-health)" };
    }

    let json = {};
    try { json = JSON.parse(result.responseBody || "{}"); } catch (e) { json = {}; }
    const leadId = json?.data?.leadId ?? json?.data?.id ?? json?.leadId ?? json?.id ?? null;
    console.log(`Pushed lead to Lofty${leadId ? ` (leadId ${leadId})` : ""} from form "${formName}" using the "${result.authStyle}" auth style.`);
    await recordPush({ ...result, leadId }, formName);
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("submission-created function error:", err);
    return { statusCode: 200, body: "ok (error logged, see function logs)" };
  }
};
