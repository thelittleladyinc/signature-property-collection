// A homeowner who asks what their home is worth also goes to the Seller
// Intelligence hub, which drafts a value review for Christine (Build E,
// 2026-10-17). OFF unless WEBSITE_TO_HUB_INTAKE=on.
//
// BYTE-IDENTICAL in thelittleladysellshomes and signature-property-collection
// (tests/test-hub-intake.js compares the two when both checkouts sit side by
// side). The site name is the `site` argument, never a second copy of this file.
//
// Which forms: free-home-valuation, sellers-page-inquiry, and the homepage form
// ("home-lead") when `looking_to` is "value". New AND returning contacts alike:
// the hub matches the person (the Lofty lead id first, then email, then phone)
// and opens at most one review per person per 30 days.
//
// Which of them (Christine, 2026-10-31: start with ONE form so she sees a first
// draft): WEBSITE_TO_HUB_INTAKE_FORMS, a comma list of free-home-valuation,
// sellers-page-inquiry and home-lead (the homepage "value" choice). Unset or
// blank = all three, as before. A list naming none of them sends nothing.
//
// What is sent: POST {HUB_API_URL}/v1/intake/website with header x-hub-key =
// HUB_INTAKE_KEY -- a hub key that can only write intake, separate from
// HUB_API_KEY (which sends the alert email). The visitor's name, email, phone and
// the address they typed (split the same way lib/_lead-address.js splits it for
// Lofty), the form name, the Lofty lead id, and Netlify's submission id. https
// only, a redirect is refused (the key goes nowhere else), 4-second limit.
//
// It never throws, never holds up the Lofty path, and logs nothing personal: the
// answer kept for /status is the hub's status words only. The hub never emails
// anyone either; Christine reads and sends every review herself from Gmail.
//
// EVERY FORM (2026-11-12, Christine approved the cross-app work; OFF unless
// WEBSITE_TO_HUB_INTAKE_ALL_FORMS is exactly "on", and only while
// WEBSITE_TO_HUB_INTAKE is on too, since that switch and HUB_INTAKE_KEY are the
// hub connection): every other lead form goes to the hub's intake as well, so
// Seller Intelligence sees each person once whichever form they used. Contract:
// sellerintelligence docs/hub-crossapp.md "Intake for every form".
//   - The value forms are unchanged: source "website", event home_value_view,
//     still limited by WEBSITE_TO_HUB_INTAKE_FORMS (sending one opens a value
//     review at the hub, so a value form left off that list is never sent).
//   - Every other form: source "website" on this site, "signature" on the
//     Signature site (the hub takes "signature" only while its flag
//     intake_every_form_enabled is on; off it answers 503, recorded as a failed
//     send and nothing else changes). No event_type: the hub records
//     lead_received, which no score counts.
//   - Both carry `intent`: only the contract's allow-listed keys, worked out from
//     the form's own Interest tags (lib/_form-plans.js interestFor): side
//     (buyer / seller / both), rent_to_own: true, first_time_buyer: true. Never a
//     "false" we did not hear, and nothing about a protected characteristic (the
//     VA form says side "buyer" only, never military status; the retirement form
//     says side "seller" only, never age).
//   - The address goes only when the form is about the person's own home (a
//     value form, or side seller / both); a buyer's form may name a listing.
//   - The agent-recruiting forms (RECRUITING_FORMS) are not homeowner or buyer
//     leads and are never sent.
"use strict";
const { propertyFromAddress } = require("./_lead-address");
const { interestFor, INTEREST } = require("./_form-plans");

const INTAKE_PATH = "/v1/intake/website";
const TIMEOUT_MS = 4000;
const VALUE_FORMS = Object.freeze(["free-home-valuation", "sellers-page-inquiry"]);

// The forms WEBSITE_TO_HUB_INTAKE_FORMS lets through: null = all (unset or blank),
// else the Set of known names it lists (spaces and case forgiven; unknown names ignored).
const FORM_KEYS = Object.freeze([...VALUE_FORMS, "home-lead"]);
function allowedValueForms(env) {
  const raw = String((env && env.WEBSITE_TO_HUB_INTAKE_FORMS) || "").trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((x) => x.trim().toLowerCase()).filter((x) => FORM_KEYS.includes(x)));
}

// The switch: exactly "on" (spaces and case forgiven), anything else is off.
function hubIntakeOn(env) {
  return String((env && env.WEBSITE_TO_HUB_INTAKE) || "").trim().toLowerCase() === "on";
}

// Every form too (2026-11-12): exactly "on" (spaces and case forgiven), anything else is off.
function allFormsOn(env) {
  return String((env && env.WEBSITE_TO_HUB_INTAKE_ALL_FORMS) || "").trim().toLowerCase() === "on";
}

// Agents asking about LPT: not a homeowner or buyer lead, never sent to the hub.
const RECRUITING_FORMS = Object.freeze(["co-license-guide", "lpt-join", "lpt-join-co", "agent-coaching"]);

// The homepage form's answers the hub may keep as form_choice.
const HOME_LEAD_CHOICES = Object.freeze(["buy", "sell", "both", "value", "invest"]);

// { form_name, form_choice } for any other lead form (EVERY FORM above), or null
// for a recruiting form or a blank name.
function otherForm(formName, data) {
  const name = String(formName || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(name) || RECRUITING_FORMS.includes(name.toLowerCase())) return null;
  const choice = String((data && data.looking_to) || "").trim().toLowerCase();
  return { form_name: name, form_choice: name === "home-lead" && HOME_LEAD_CHOICES.includes(choice) ? choice : null };
}

// The hub source for a form: a value form is always "website" (only that source
// opens a value review); any other form is the site's own source.
function intakeSource(site, isValueForm) {
  return !isValueForm && site === "signature" ? "signature" : "website";
}

// The stated intent the hub's contract allows, from the form's own Interest tags.
// Only what the form says: side, and rent_to_own / first_time_buyer when TRUE.
// undefined when the form says nothing (a contact form, a newsletter sign-up).
const BUYER_SIDE = Object.freeze([INTEREST.BUYER, INTEREST.FIRST_TIME_BUYER, INTEREST.VA_BUYER, INTEREST.LUXURY_BUYER,
  INTEREST.RELOCATION, INTEREST.RENT_TO_OWN]);
const SELLER_SIDE = Object.freeze([INTEREST.SELLER, INTEREST.HOME_VALUE, INTEREST.CASH_OFFER, INTEREST.LUXURY_SELLER,
  INTEREST.EXPIRED, INTEREST.FSBO, INTEREST.DOWNSIZING]);
function formIntent(formName, data, site) {
  const tags = interestFor(formName, data, { site: site === "signature" ? "signature" : "main" });
  const buyer = tags.some((t) => BUYER_SIDE.includes(t));
  const seller = tags.some((t) => SELLER_SIDE.includes(t));
  const intent = {};
  if (buyer || seller) intent.side = buyer && seller ? "both" : buyer ? "buyer" : "seller";
  if (tags.includes(INTEREST.RENT_TO_OWN)) intent.rent_to_own = true;
  if (tags.includes(INTEREST.FIRST_TIME_BUYER)) intent.first_time_buyer = true;
  return Object.keys(intent).length ? intent : undefined;
}

// { form_name, form_choice } for a value form, else null.
function valueForm(formName, data) {
  const name = String(formName || "");
  if (VALUE_FORMS.includes(name)) return { form_name: name, form_choice: null };
  const intent = String((data && data.looking_to) || "").trim().toLowerCase();
  if (name === "home-lead" && intent === "value") return { form_name: name, form_choice: "value" };
  return null;
}

// The hub's intake address, or why it can't be used. Names the setting, never its value.
// `source` (2026-11-12): "website" (the default) or "signature".
function intakeEndpoint(env, source) {
  return hubEndpoint(env, source === "signature" ? "/v1/intake/signature" : INTAKE_PATH);
}

// Any hub route the website key may call (intake, and the value review's "What
// have you updated?" answers): HUB_API_URL + path, with HUB_INTAKE_KEY.
function hubEndpoint(env, path) {
  const raw = String((env && env.HUB_API_URL) || "").trim();
  const key = String((env && env.HUB_INTAKE_KEY) || "").trim();
  const missing = [!raw && "HUB_API_URL", !key && "HUB_INTAKE_KEY"].filter(Boolean);
  if (missing.length) return { reason: `${missing.join(" and ")} not set` };
  let u;
  try { u = new URL(raw); } catch (e) { return { reason: "HUB_API_URL is not a valid URL" }; }
  if (u.protocol !== "https:") return { reason: "HUB_API_URL must start with https://" };
  if (u.username || u.password) return { reason: "HUB_API_URL must not carry a user name or password" };
  u.search = ""; u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/, "") + path;
  return { url: u.toString(), key };
}

function text(v, max) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
}

// The flat body the hub's intake reads (supabase/functions/hub-api/intake.ts).
// opts.kind "form" (2026-11-12, EVERY FORM above): no event_type (the hub records
// lead_received) and the address only when opts.withAddress. opts.intent rides
// along when given. A value form's body is exactly as before.
function intakeBody(form, data, opts) {
  const d = data || {};
  const o = opts || {};
  const parts = String(d.name || "").trim().split(/\s+/).filter(Boolean);
  const valueKind = o.kind !== "form";
  const home = valueKind || o.withAddress ? propertyFromAddress(d.address || d.property_address) || {} : {};
  const leadId = o.loftyLeadId != null ? String(o.loftyLeadId) : "";
  const body = {
    first_name: text(parts[0], 100),
    last_name: text(parts.slice(1).join(" "), 100),
    email: text(d.email, 200),
    phone: text(d.phone, 40),
    property_address: text(home.streetAddress, 200),
    city: text(home.city, 100),
    state: text(home.state, 30),
    zip: text(home.zipCode, 10),
    event_type: valueKind ? "home_value_view" : undefined,
    event_at: text(o.createdAt, 40),
    form_name: form.form_name,
    form_choice: form.form_choice || undefined,
    lofty_lead_id: /^[0-9]{1,20}$/.test(leadId) ? leadId : undefined,
    raw: { site: text(o.site, 20) || "main", submission_id: text(o.submissionId, 100) || null },
  };
  if (o.intent && typeof o.intent === "object" && Object.keys(o.intent).length) body.intent = o.intent;
  return body;
}

// sendValueFormToHub({ formName, data, loftyLeadId, submissionId, createdAt, site }, { env, fetchImpl })
//   -> { attempted:false, reason, kind? } | { attempted:true, kind, source, ok, httpStatus, hubStatus?, reviewStatus?, error? }
// kind: "value" (a value form, as since Build E) or "form" (any other lead form,
// only with WEBSITE_TO_HUB_INTAKE_ALL_FORMS on). The name is kept: both sites'
// submission-created.js call it at the same two places.
async function sendValueFormToHub(args, deps) {
  const a = args || {};
  const env = (deps && deps.env) || process.env;
  const doFetch = (deps && deps.fetchImpl) || fetch;
  try {
    if (!hubIntakeOn(env)) return { attempted: false, reason: "WEBSITE_TO_HUB_INTAKE is off" };
    const every = allFormsOn(env);
    const site = a.site === "signature" ? "signature" : "main";
    let form = valueForm(a.formName, a.data);
    let kind = "value";
    if (form) {
      const allowed = allowedValueForms(env);
      if (allowed && !allowed.has(form.form_name)) return { attempted: false, kind, reason: "not on WEBSITE_TO_HUB_INTAKE_FORMS" };
    } else {
      if (!every) return { attempted: false, reason: "not a value form" };
      form = otherForm(a.formName, a.data);
      kind = "form";
      if (!form) return { attempted: false, kind, reason: "an agent-recruiting form or no form name (not sent)" };
    }
    const source = intakeSource(site, kind === "value");
    const endpoint = intakeEndpoint(env, source);
    if (!endpoint.url) return { attempted: false, kind, reason: endpoint.reason };
    const intent = every ? formIntent(a.formName, a.data, site) : undefined;
    const body = intakeBody(form, a.data, { ...a, kind, intent,
      withAddress: !!(intent && (intent.side === "seller" || intent.side === "both")) });
    if (!body.email && !body.phone) return { attempted: false, kind, reason: "no email or phone on the form" };
    const res = await doFetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-key": endpoint.key },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await res.text().catch(() => "");
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { j = null; }
    if (res.status === 200 && j && typeof j.status === "string") {
      const review = j.value_review && typeof j.value_review.status === "string" ? j.value_review.status : null;
      const out = { attempted: true, kind, source, ok: true, httpStatus: 200, hubStatus: j.status.slice(0, 20), reviewStatus: review && review.slice(0, 20) };
      // Counts only: how much of the intent the hub kept (present only while its flag is on).
      if (Number.isInteger(j.intent_kept)) out.intentKept = j.intent_kept;
      if (Number.isInteger(j.intent_dropped)) out.intentDropped = j.intent_dropped;
      return out;
    }
    const why = j && typeof j.error === "string" ? j.error.slice(0, 120) : `hub answered ${res.status}`;
    return { attempted: true, kind, source, ok: false, httpStatus: res.status, error: why };
  } catch (err) {
    return { attempted: true, ok: false, httpStatus: null, error: (err && err.name) || "error" };
  }
}

// The log line for /status and the function log: the form, the hub's status words, never the person.
function hubIntakeLogLine(formName, r) {
  const what = r && r.kind === "form" ? "Lead to the hub intake" : "Value review to the hub";
  return `${what} for "${formName}": ${r.ok ? `${r.hubStatus}${r.reviewStatus ? `, review ${r.reviewStatus}` : ""}` : `FAILED (${r.error})`}.`;
}

module.exports = { INTAKE_PATH, VALUE_FORMS, FORM_KEYS, RECRUITING_FORMS, allowedValueForms, hubIntakeOn, allFormsOn, valueForm,
  otherForm, intakeSource, formIntent, intakeEndpoint, hubEndpoint, intakeBody, sendValueFormToHub, hubIntakeLogLine };
