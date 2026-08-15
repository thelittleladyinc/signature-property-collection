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

const LOFTY_BASE_URL = "https://api.lofty.com/v1.0";

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

    const res = await fetch(`${LOFTY_BASE_URL}/leads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `token ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`Lofty API ${res.status}: ${text.slice(0, 500)}`);
      // Still return 200 — the Netlify Forms submission already succeeded
      // and is sitting in the dashboard; don't make that fail on Lofty's account.
      return { statusCode: 200, body: "ok (lofty push failed, see function logs)" };
    }

    const json = await res.json().catch(() => ({}));
    const leadId = json?.data?.leadId ?? json?.data?.id ?? json?.leadId ?? json?.id ?? null;
    console.log(`Pushed lead to Lofty${leadId ? ` (leadId ${leadId})` : ""} from form "${formName}".`);
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("submission-created function error:", err);
    return { statusCode: 200, body: "ok (error logged, see function logs)" };
  }
};
