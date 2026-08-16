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
//   3. The auth header is CONFIRMED rather than inferred. Christine sent a
//      screenshot of her Lofty Settings > Integrations > API page, whose own
//      usage example reads:
//
//        curl --request GET --url https://api.lofty.com/v1.0/me \
//             --header 'Authorization: token <your apiKey>'
//
//      So "token <key>" is correct and the brief "retry as Bearer on a 401"
//      fallback added an hour earlier has been removed -- with the format
//      confirmed, a 401 means the KEY is wrong, and retrying it with a
//      different header only wastes a call and muddies the diagnosis.
//
//      That same page also showed six active keys (Expired-Listings, Listing
//      Engine API, Listing Engine Most, Listing Engine, RTO Key, Legacy Token)
//      and none named for this website -- so whatever is in LOFTY_API_KEY was
//      borrowed from another app. site-health can now test the key directly
//      against /v1.0/me, which is why that endpoint is worth knowing about.
//
// 2026-08-15, later that day. Christine built the Smart Plan by hand, tested it
// twice, and got "didnt work" then "it didnt come through". Then she pointed at
// the thing that actually settled it: "i have lofty sync with my repo called
// seller intelligence i think - can you see if that repo has what you need?"
//
// That project has been driving this same Lofty account for months and it knew
// three things this file was only guessing at -- the real notes endpoint, that
// tags can be rewritten on an existing lead, and that she already has a Resend
// account. So the notification no longer rests on a CRM automation firing
// correctly: see lib/_notify.js, and the three calls after the push below.
const { getStore } = require("@netlify/blobs");
const { getBlobStore } = require("./lib/_mls-shared");
const { postLead, recordPush } = require("./lib/_lofty");
const { addLoftyNote, refireLoftyTag, sendLeadAlertEmail } = require("./lib/_notify");

const DIAG_STORE = "mls-listings";        // same store the rest of the site uses

// The tag her Smart Plan is triggered by. Kept in one place because two things
// depend on it agreeing exactly: the tag written on the new lead, and the
// remove-then-re-add that makes a repeat enquiry trigger the plan again.
const TRIGGER_TAG = "Hot Lead - Website";

// Human-friendly source label per form-name, so leads are easy to tell apart
// inside Lofty. Falls back to the raw form name for anything not listed.
const SOURCE_LABELS = {
  "contact": "Signature Property Collection - Contact Form",
  "buyers-guide": "Signature Property Collection - Buyer's Guide Download",
  "sellers-guide": "Signature Property Collection - Seller's Guide Download",
  "relocation": "Signature Property Collection - Relocation Page",
  // 2026-08-16: the site's single named lead magnet, linked from every town page,
  // the relocation page and the homepage. Worth its own label rather than sharing
  // "relocation" with the relocation page's form: this lead has read a town page
  // and asked for the guide, which is a different (earlier, out-of-state) moment
  // than someone who filled in the "start your relocation" form.
  "relocation-guide": "Signature Property Collection - Relocation Guide Download",
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
  // 2026-08-16: the seller-facing local-proof page. A lead here has seen how many
  // people already watch content about their town and asked for it for their own
  // address -- so it is a listing lead, not a browse, and worth its own label.
  "seller-local-proof": "Signature Property Collection - Seller Local Proof (listing lead)",
  // 2026-08-16: found by cross-checking every form-name rendered into site/ against
  // the keys here, while adding the thank-you redirect. These three forms exist and
  // have existed, and were falling through to the raw-slug fallback below -- so a
  // lead from the luxury page arrived in Lofty labelled "luxury-market", which
  // sorts and reads like a bug rather than a source. Worth their own labels
  // especially: two of the three are the highest-intent pages on the site.
  "luxury-market": "Signature Property Collection - Luxury Market Page",
  "concierge-page-inquiry": "Signature Property Collection - Concierge Page Inquiry",
  "testimonials-page-inquiry": "Signature Property Collection - Testimonials Page Inquiry",
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
    // 2026-08-15 (Christine: "make sure that when the new lead comes in or if it
    // merges that i am still notified some how in lofty with a hot lead or
    // something of hte sort"). Her 16:48 test DID reach Lofty -- lead
    // 1147334685108095 -- but it used her own account-owner email, so Lofty
    // folded it into an existing contact and it never appeared in "Today's New
    // Leads". A merge is the case that has to stay visible.
    //
    // Tags are the lever, because tags are the one enrichment this API has
    // already accepted (the full payload went through), and Lofty appends tags on
    // a merge rather than replacing them. "Hot Lead - Website" is deliberately a
    // distinct, sortable label rather than a note: a tag can be filtered, saved
    // as a smart list, and used as a Smart Plan trigger, so it can drive a real
    // notification instead of sitting in a timeline nobody opens.
    body.tags = [TRIGGER_TAG, "Website Lead", formName];
    // Every note starts with this, so even a merged lead's activity timeline shows
    // at a glance that a NEW website enquiry came in and when.
    const stamp = new Date().toLocaleString("en-US", {
      timeZone: "America/Denver", dateStyle: "medium", timeStyle: "short",
    });
    const banner = `NEW WEBSITE LEAD (${stamp} MT) — ${SOURCE_LABELS[formName] || formName}`;

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
      body.notes = `${banner}\nWants email alerts for new listings matching: ${data.alert_criteria || "(no filters — all new listings)"}` +
        (data.alert_query ? `\nReproduce this search: https://signaturepropertycollection.com/search-homes.html?${data.alert_query}` : "") +
        (data.message ? `\nAlso said: "${data.message}"` : "");
      body.tags.push("Property Alert Request", "Saved Search");
    } else if (data.listing_address) {
      // From the Current Listings page's Ask A Question / Request A Tour
      // buttons (netlify/functions/listings-search.js + build_current_listings()).
      const kind = data.inquiry_type === "Tour" ? "Requested a tour" : "Asked a question";
      const mls = data.listing_mls ? ` (MLS# ${data.listing_mls})` : "";
      const msg = data.message ? ` — "${data.message}"` : "";
      body.notes = `${banner}\n${kind} about listing: ${data.listing_address}${mls}${msg}`;
      body.tags.push(data.inquiry_type === "Tour" ? "Tour Request" : "Listing Question");
    } else if (data.moving_from) {
      // From the Relocation page's form (build_nav_pages() in build.py).
      body.notes = `${banner}\nRelocating from: ${data.moving_from}` +
        (data.message ? ` — "${data.message}"` : "");
    } else if (data.address) {
      body.notes = `${banner}\nRequested valuation for: ${data.address}` +
        // Only the local-proof form sends this, and it says which town's audience
        // numbers they were looking at when they asked -- a genuinely useful
        // opening line for the call back.
        (data.local_proof_town ? `\nSaw the local-proof numbers for: ${data.local_proof_town}` : "");
      if (formName === "seller-local-proof") body.tags.push("Seller Lead", "Local Proof");
    } else if (data.message) {
      // From the Buyers page's form (build_buyers() in build.py).
      body.notes = `${banner}\n${data.message}`;
    } else if (data.quiz_match) {
      // From the Neighborhood Quiz (build_neighborhood_quiz() in build.py) —
      // quiz_match is the top city match (+ runner-up), quiz_answers is a
      // readable summary of what they picked, so the lead lands in Lofty
      // with real context instead of just a name/email.
      body.notes = `${banner}\nNeighborhood Quiz match: ${data.quiz_match}` +
        (data.quiz_answers ? ` — ${data.quiz_answers}` : "");
      body.tags.push("Neighborhood Quiz");
    }

    // A form with nothing but a name and email (the guide downloads) matches none
    // of the branches above, and a lead with no note at all is the easiest one to
    // miss. The banner alone is still worth having.
    if (!body.notes) body.notes = banner;

    const result = await postLead(body, apiKey);
    // The store is only needed for diagnostics, so a Blobs problem must not
    // prevent the push itself -- it's fetched after the lead has already gone.
    let store = null;
    try { store = getBlobStore(getStore, DIAG_STORE); } catch (e) { store = null; }

    let json = {};
    try { json = JSON.parse(result.responseBody || "{}"); } catch (e) { json = {}; }
    // POST /leads returns the lead id whether it CREATED a contact or merged into
    // an existing one -- Christine's 16:48 test proved that, coming back with
    // 1147334685108095 for a contact that already existed. That is what makes the
    // follow-up calls below possible without having to search Lofty by email
    // (which its API offers no way to do -- sellerintelligence pages all ~20k
    // leads to find one, far too slow for a form handler).
    const leadId = json?.data?.leadId ?? json?.data?.id ?? json?.leadId ?? json?.id ?? null;

    // ---- The notification, in the order that matters -------------------------
    // The email goes out UNCONDITIONALLY -- before the note, before the tag, and
    // whether or not the push above succeeded. It is the only step that still
    // works when Lofty is down, when the lead merged into an existing contact,
    // and when the Smart Plan is misconfigured, so nothing that can fail is
    // allowed in front of it. This is the answer to "i want to be notified
    // immediatly".
    //
    // It does sit after the create call, because that call is what yields the
    // leadId for the "Open this lead in Lofty" link -- but a failed create
    // doesn't stop it, which is the property that matters.
    const stampedSource = SOURCE_LABELS[formName] || formName;
    const emailResult = await sendLeadAlertEmail({
      name: data.name, email: data.email, phone: data.phone,
      source: stampedSource,
      // The long labels all start with the site name; the subject line doesn't
      // need it repeated.
      sourceShort: stampedSource.replace("Signature Property Collection - ", ""),
      noteText: body.notes, leadId, stamp: `${stamp} MT`,
    });

    if (!result.ok) {
      console.error(`Lofty API ${result.httpStatus} (payload shape "${result.payloadShape}"): ${result.responseBody}`);
      // The lead is queued for retry by the next sync run, is sitting in Netlify
      // Forms, and -- new as of this change -- has already been emailed to her.
      // Still returns 200: failing here would not help the visitor, whose
      // submission already succeeded.
      if (store) await recordPush(store, { ...result, emailResult }, formName, body);
      return { statusCode: 200, body: "ok (lofty push failed — see /site-health)" };
    }

    console.log(`Pushed lead to Lofty${leadId ? ` (leadId ${leadId})` : ""} from form "${formName}" (${result.payloadShape} payload).`);

    // The note as its own call, because a merge has no reason to overwrite an
    // existing contact's fields -- which is why her repeat tests left no trace.
    const noteResult = leadId ? await addLoftyNote(leadId, body.notes, apiKey) : { attempted: false };
    // And make the trigger tag a real CHANGE, so the Smart Plan fires on a
    // returning buyer's second enquiry and not only their first.
    //
    // 2026-08-16: skipped entirely when the note already proved the returned
    // leadId doesn't resolve (a merge — see addLoftyNote). The tag call reads the
    // same id and would 404 identically, so attempting it only spends a Lofty
    // call and puts a second, redundant failure on /status that reads like a
    // separate fault. tagRestored stays true because the tag written by the
    // create call is still on the surviving contact; Lofty appends tags on merge.
    const tagResult = !leadId ? { attempted: false }
      : noteResult.leadMissing
        ? { attempted: false, skipped: "lead-missing", tagRestored: true }
        : await refireLoftyTag(leadId, TRIGGER_TAG, apiKey);

    if (store) await recordPush(store, { ...result, leadId, emailResult, noteResult, tagResult }, formName, body);
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("submission-created function error:", err);
    return { statusCode: 200, body: "ok (error logged, see function logs)" };
  }
};
