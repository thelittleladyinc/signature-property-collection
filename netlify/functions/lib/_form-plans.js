// Which Lofty nurture plan ("Smart Plan") a website form starts.
//
// 2026-10-06. Every website lead already reaches Lofty tagged "Hot Lead - Website"
// (the alert plan), but nothing put a form's lead into the nurture plan that fits
// what they asked for: a buyer, a seller, a downsizer, a luxury seller and an
// agent asking about LPT all landed the same way. This file is the one place that
// says which plan each form starts. submission-created.js asks it once per
// submission.
//
// BYTE-IDENTICAL in thelittleladysellshomes and signature-property-collection
// (tests/test-form-plans.js compares the two when both checkouts sit side by
// side). The one real difference between the sites -- Signature is the luxury
// brand, so ITS seller forms start the luxury seller plan -- is the `site`
// option below, not a second copy of this file.
//
// Two Lofty facts this is shaped around:
//
//   1. A Smart Plan started by "Tag Changed -> tag added" does NOT fire for a tag
//      sent on the create call. So a plan tag is never in the create's `tags`;
//      submission-created.js adds it in a PUT after the lead exists
//      (lib/_notify.js addPlanTags: read the lead's tags, keep them all, add the
//      plan tag; refuse to write when the tags can't be read).
//   2. A plan only enrolls a lead whose Lofty lead type is in the plan's scope,
//      so a new contact is created with its lead type (`leadTypes`, numeric:
//      1 = Seller, 2 = Buyer -- the same numbers Command Center's quiz and
//      Expired Elite send).
//
// Both happen ONLY for a contact proven brand new. A returning contact keeps its
// own lead type and gets no plan tag: it gets the Call task and phone push it
// already got (lib/_lofty-returning.js alertReturningLead).

// The tag that starts each plan, exactly as the plan's start tag reads in Lofty.
// Every "–" here is U+2013 EN DASH, copied from the plan names; S2's "-" is a
// plain ASCII hyphen. If a plan's tag is ever renamed in Lofty, change the one
// line here (tests/test-form-plans.js pins the characters).
const PLAN_TAGS = Object.freeze({
  B1_WEBSITE_BUYER: "TOF – Website Buyer",
  B1_FIRST_TIME: "TOF – First Time Buyer",
  B1_VA: "TOF – VA Buyer",
  S1_SELLER: "TOF – Seller Ready to List",
  S2_OPTIONS: "S2 - Seller Options",
  DS1_DOWNSIZING: "TOF – Downsizing",
  SPC_LUXURY: "TOF – Luxury / Signature",
  RECRUIT: "Agent Recruit",
});

// Lofty's numeric lead types (`leadTypes` on POST /v1.0/leads).
const LEAD_TYPE = Object.freeze({ SELLER: 1, BUYER: 2 });

// Each plan: its start tag and the lead type a new contact is created with.
// RECRUIT has no lead type: an agent asking about LPT is neither a buyer nor a
// seller, and must not land in a buyer or seller plan's scope.
const PLANS = Object.freeze({
  B1_WEBSITE_BUYER: { tag: PLAN_TAGS.B1_WEBSITE_BUYER, leadType: LEAD_TYPE.BUYER },
  B1_FIRST_TIME: { tag: PLAN_TAGS.B1_FIRST_TIME, leadType: LEAD_TYPE.BUYER },
  B1_VA: { tag: PLAN_TAGS.B1_VA, leadType: LEAD_TYPE.BUYER },
  S1_SELLER: { tag: PLAN_TAGS.S1_SELLER, leadType: LEAD_TYPE.SELLER },
  S2_OPTIONS: { tag: PLAN_TAGS.S2_OPTIONS, leadType: LEAD_TYPE.SELLER },
  DS1_DOWNSIZING: { tag: PLAN_TAGS.DS1_DOWNSIZING, leadType: LEAD_TYPE.SELLER },
  SPC_LUXURY: { tag: PLAN_TAGS.SPC_LUXURY, leadType: LEAD_TYPE.SELLER },
  RECRUIT: { tag: PLAN_TAGS.RECRUIT, leadType: null },
});

// Form name (Netlify form-name) -> plan, the same on both sites.
const FORM_PLAN = Object.freeze({
  // B1 -- website buyer: searches, listing questions, buyer and town guides.
  "listing-inquiry": "B1_WEBSITE_BUYER",
  "listing-alert-request": "B1_WEBSITE_BUYER",
  "neighborhood-quiz": "B1_WEBSITE_BUYER",
  "buyers-page-inquiry": "B1_WEBSITE_BUYER",
  "relocation": "B1_WEBSITE_BUYER",
  "lifestyle-search": "B1_WEBSITE_BUYER",
  "buyers-guide": "B1_WEBSITE_BUYER",
  "relocation-guide": "B1_WEBSITE_BUYER",
  "windsor-commute": "B1_WEBSITE_BUYER",
  "eaton-relocation": "B1_WEBSITE_BUYER",
  "eaton-dining": "B1_WEBSITE_BUYER",
  "dream-home-finder": "B1_WEBSITE_BUYER",
  "open-house-list": "B1_WEBSITE_BUYER",
  "foreclosure-list-larimer": "B1_WEBSITE_BUYER",
  "foreclosure-list-weld": "B1_WEBSITE_BUYER",
  "loveland-buyers-guide": "B1_WEBSITE_BUYER",
  "west-greeley-inquiry": "B1_WEBSITE_BUYER",
  "ault-area-inquiry": "B1_WEBSITE_BUYER",
  "multigenerational-search": "B1_WEBSITE_BUYER",
  "land-property-review": "B1_WEBSITE_BUYER",
  "land-due-diligence-checklist": "B1_WEBSITE_BUYER",
  "teacher-homebuying": "B1_WEBSITE_BUYER",
  "signature-buyers-inquiry": "B1_WEBSITE_BUYER",
  "signature-resort-buyer-inquiry": "B1_WEBSITE_BUYER",
  "signature-concierge-inquiry": "B1_WEBSITE_BUYER",
  "signature-luxury-market": "B1_WEBSITE_BUYER",
  "luxury-market": "B1_WEBSITE_BUYER",
  "concierge-page-inquiry": "B1_WEBSITE_BUYER",
  // B1 -- first-time buyer and VA buyer.
  "first-time-homebuyer": "B1_FIRST_TIME",
  "veteran-home-purchase": "B1_VA",
  // S1 -- seller ready to list.
  "sellers-guide": "S1_SELLER",
  "seller-local-proof": "S1_SELLER",
  "loveland-market-seller": "S1_SELLER",
  "sellers-page-inquiry": "S1_SELLER",
  // S2 -- seller weighing options (a value, a cash offer).
  "free-home-valuation": "S2_OPTIONS",
  "cash-offer": "S2_OPTIONS",
  // SPC-S -- luxury seller (The Little Lady's Signature Property Collection).
  "signature-sellers-inquiry": "SPC_LUXURY",
  "signature-expired-inquiry": "SPC_LUXURY",
  // DS1 -- downsizing / retirement move.
  "noco-retirement": "DS1_DOWNSIZING",
  // Agent recruiting (no lead type).
  "lpt-join": "RECRUIT",
  "lpt-join-co": "RECRUIT",
  "co-license-guide": "RECRUIT",
  "agent-coaching": "RECRUIT",
});

// On the Signature site -- the luxury brand -- its own seller forms start the
// luxury seller plan instead. Only these four; everything else maps as above.
const SIGNATURE_SITE_PLAN = Object.freeze({
  "sellers-page-inquiry": "SPC_LUXURY",
  "sellers-guide": "SPC_LUXURY",
  "seller-local-proof": "SPC_LUXURY",
  "free-home-valuation": "SPC_LUXURY",
});

// The homepage form ("home-lead") asks outright, in `looking_to`.
// "invest" (land / investment) and anything else start no plan.
const HOME_LEAD_PLAN = Object.freeze({
  sell: "S1_SELLER",
  both: "S1_SELLER",
  value: "S2_OPTIONS",
  buy: "B1_WEBSITE_BUYER",
});

// Forms that deliberately start NO plan (any form not named anywhere in this
// file starts none either). Listed so the choice is visible, not an accident:
// a general contact or testimonial note, a newsletter sign-up and the market-
// conditions question say nothing about buying or selling; rent-to-own leads go
// to another agent and are left exactly as they are.
const FORMS_WITHOUT_PLAN = Object.freeze([
  "contact",
  "testimonials-page-inquiry",
  "newsletter-signup",
  "rent-to-own-options",
  "market-conditions-inquiry",
]);

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// The plan key for a submission, or null.
function planKeyFor(formName, data, opts) {
  const name = String(formName || "");
  const site = opts && opts.site === "signature" ? "signature" : "main";
  if (name === "home-lead") {
    const intent = String((data && data.looking_to) || "").trim().toLowerCase();
    return hasOwn(HOME_LEAD_PLAN, intent) ? HOME_LEAD_PLAN[intent] : null;
  }
  if (site === "signature" && hasOwn(SIGNATURE_SITE_PLAN, name)) return SIGNATURE_SITE_PLAN[name];
  if (hasOwn(FORM_PLAN, name)) return FORM_PLAN[name];
  return null;
}

// planForSubmission(formName, data, { site: "main" | "signature" })
//   -> { plan, planTags: string[], leadTypes: number[] }
// Empty arrays (and plan null) = this submission starts no plan. `site` defaults
// to "main". Fresh arrays every call, so a caller can't change the table.
function planForSubmission(formName, data, opts) {
  const key = planKeyFor(formName, data, opts);
  const p = key ? PLANS[key] : null;
  if (!p) return { plan: null, planTags: [], leadTypes: [] };
  return { plan: key, planTags: [p.tag], leadTypes: p.leadType ? [p.leadType] : [] };
}

module.exports = {
  PLAN_TAGS,
  LEAD_TYPE,
  PLANS,
  FORM_PLAN,
  SIGNATURE_SITE_PLAN,
  HOME_LEAD_PLAN,
  FORMS_WITHOUT_PLAN,
  planForSubmission,
};
