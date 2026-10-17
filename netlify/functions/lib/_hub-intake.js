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
"use strict";
const { propertyFromAddress } = require("./_lead-address");

const INTAKE_PATH = "/v1/intake/website";
const TIMEOUT_MS = 4000;
const VALUE_FORMS = Object.freeze(["free-home-valuation", "sellers-page-inquiry"]);

// The switch: exactly "on" (spaces and case forgiven), anything else is off.
function hubIntakeOn(env) {
  return String((env && env.WEBSITE_TO_HUB_INTAKE) || "").trim().toLowerCase() === "on";
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
function intakeEndpoint(env) {
  const raw = String((env && env.HUB_API_URL) || "").trim();
  const key = String((env && env.HUB_INTAKE_KEY) || "").trim();
  const missing = [!raw && "HUB_API_URL", !key && "HUB_INTAKE_KEY"].filter(Boolean);
  if (missing.length) return { reason: `${missing.join(" and ")} not set` };
  let u;
  try { u = new URL(raw); } catch (e) { return { reason: "HUB_API_URL is not a valid URL" }; }
  if (u.protocol !== "https:") return { reason: "HUB_API_URL must start with https://" };
  if (u.username || u.password) return { reason: "HUB_API_URL must not carry a user name or password" };
  u.search = ""; u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/, "") + INTAKE_PATH;
  return { url: u.toString(), key };
}

function text(v, max) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
}

// The flat body the hub's intake reads (supabase/functions/hub-api/intake.ts).
function intakeBody(form, data, opts) {
  const d = data || {};
  const parts = String(d.name || "").trim().split(/\s+/).filter(Boolean);
  const home = propertyFromAddress(d.address || d.property_address) || {};
  const leadId = opts && opts.loftyLeadId != null ? String(opts.loftyLeadId) : "";
  return {
    first_name: text(parts[0], 100),
    last_name: text(parts.slice(1).join(" "), 100),
    email: text(d.email, 200),
    phone: text(d.phone, 40),
    property_address: text(home.streetAddress, 200),
    city: text(home.city, 100),
    state: text(home.state, 30),
    zip: text(home.zipCode, 10),
    event_type: "home_value_view",
    event_at: text(opts && opts.createdAt, 40),
    form_name: form.form_name,
    form_choice: form.form_choice || undefined,
    lofty_lead_id: /^[0-9]{1,20}$/.test(leadId) ? leadId : undefined,
    raw: { site: text(opts && opts.site, 20) || "main", submission_id: text(opts && opts.submissionId, 100) || null },
  };
}

// sendValueFormToHub({ formName, data, loftyLeadId, submissionId, createdAt, site }, { env, fetchImpl })
//   -> { attempted:false, reason } | { attempted:true, ok, httpStatus, hubStatus?, reviewStatus?, error? }
async function sendValueFormToHub(args, deps) {
  const a = args || {};
  const env = (deps && deps.env) || process.env;
  const doFetch = (deps && deps.fetchImpl) || fetch;
  try {
    if (!hubIntakeOn(env)) return { attempted: false, reason: "WEBSITE_TO_HUB_INTAKE is off" };
    const form = valueForm(a.formName, a.data);
    if (!form) return { attempted: false, reason: "not a value form" };
    const endpoint = intakeEndpoint(env);
    if (!endpoint.url) return { attempted: false, reason: endpoint.reason };
    const body = intakeBody(form, a.data, a);
    if (!body.email && !body.phone) return { attempted: false, reason: "no email or phone on the form" };
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
      return { attempted: true, ok: true, httpStatus: 200, hubStatus: j.status.slice(0, 20), reviewStatus: review && review.slice(0, 20) };
    }
    const why = j && typeof j.error === "string" ? j.error.slice(0, 120) : `hub answered ${res.status}`;
    return { attempted: true, ok: false, httpStatus: res.status, error: why };
  } catch (err) {
    return { attempted: true, ok: false, httpStatus: null, error: (err && err.name) || "error" };
  }
}

module.exports = { INTAKE_PATH, VALUE_FORMS, hubIntakeOn, valueForm, intakeEndpoint, intakeBody, sendValueFormToHub };
