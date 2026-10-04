// Returning leads and website fields in Lofty -- the two things the tag couldn't do.
//
// 2026-09-29 (Christine approved: "lets do 1-5"). Until today this code worked
// from what an older sibling project had learned by trial and error, because
// Lofty's API reference wasn't reachable from here. It is now
// (developer.lofty.com/llms.txt), and it settles the two open problems on
// /status:
//
//   1. A RETURNING LEAD NEVER PINGED HER IN LOFTY. When someone already in her
//      CRM fills out a form, Lofty merges the submission into that contact, and
//      her "Tag Added" Smart Plan can't fire again because the tag is already
//      there. The backup email still reached her; Lofty itself stayed silent.
//      Lofty's documented answer to "make an agent act on this lead now" is a
//      task: POST /v2.0/tasks creates a Call task on the lead, assigned to the
//      lead's agent, and POST /v2.0/sales-agent/notification/app-push/
//      send-task-reminder pushes it to that agent's phone. The push goes to the
//      AGENT (Christine, or whoever the lead is assigned to) -- never to the
//      client. Nothing is sent to the lead.
//
//   2. THE SURVIVING CONTACT'S ID. The id POST /leads returns on a merge can be
//      the absorbed record (see _notify.js, 2026-08-16), and the old note said
//      the API "offers no lookup-by-email". It does: GET /v1.0/leads?email=...
//      with preciseSearchFlag=true is an exact search. So the handler asks first,
//      and a returning lead's note, task and push go to the contact that actually
//      exists. It also lets a known contact keep its own tags: `tags` on the
//      create call REPLACES an existing contact's tag set ("All existing tags will
//      be updated based on this call"), `tagsAdd` only adds -- the handler sends
//      tagsAdd whenever the lookup found anyone.
//
//   3. WEBSITE FIELDS (item 3 of the same list). Which form, first page, form
//      page and traffic source used to live only inside the note text. They now
//      also go into four text custom fields on the lead, so she can filter and
//      report on them in Lofty. Created on the team once
//      (POST /v1.0/teamFeatures/custom-field) and remembered for a week.
//      Written ONLY on a contact the lookup proved is brand new: Lofty's docs
//      don't say whether a PUT with customAttributeList replaces a lead's other
//      custom fields, so an existing client's record is never touched.
//
// RULES THIS FILE KEEPS (from an independent review before it went live):
//   - It can never delay a lead much or lose one. The lookups run in parallel
//     under ONE 2-second budget; everything returns a result object and nothing
//     throws (every entry point is wrapped).
//   - "Can't tell" is never "new": a search error, a malformed answer, or any
//     result that isn't an exact match makes the answer untrustworthy, and then
//     no fields are written and no task is created.
//   - Only an EMAIL match redirects the note, task and link. A phone number can
//     be shared (a spouse), so a phone-only match just blocks the field write
//     and switches the create call to tagsAdd.
//   - Responses are parsed whole; only what is stored for /status is cut short.
"use strict";

const { inferCountyFromCity } = require("./_mls-shared");

const LOFTY_API = "https://api.lofty.com";
const CALL_TIMEOUT_MS = 5000;
const LOOKUP_BUDGET_MS = 2000;
const TZ = "America/Denver";
const TASK_DUE_MINUTES = 30;
const FIELDS_KEY = "lofty-website-fields.json";
const FIELDS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The four fields, as they appear in Lofty. Plain text: paths and labels.
const WEBSITE_FIELDS = [
  "Website Form",
  "Website First Page",
  "Website Form Page",
  "Website Traffic Source",
];

function headers(apiKey) {
  return { "Content-Type": "application/json", Authorization: `token ${apiKey}` };
}

function short(v, n) { return v == null ? undefined : String(v).slice(0, n || 200); }

// Lofty ids are 64-bit integers ("JavaScript/TypeScript integration requires
// special handling" -- their docs). JSON.parse would round anything past 2^53,
// so ids are read from the raw text as digit strings and written back into JSON
// bodies as raw digits.
function idsFrom(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"?(\\d{1,20})"?`, "g");
  const out = [];
  let m;
  while ((m = re.exec(String(text || "")))) out.push(m[1]);
  return out;
}

// The id a POST /v1.0/leads answer carries, exactly.
function leadIdFromResponse(text) {
  return idsFrom(text, "leadId")[0] || idsFrom(text, "id")[0] || null;
}

function withId(body, key, id) {
  // {"leadId": 1148639689762408, ...} with the id as literal digits.
  const json = JSON.stringify({ ...body, [key]: "__ID__" });
  return json.replace('"__ID__"', String(id).replace(/\D/g, ""));
}

async function call(method, path, apiKey, rawBody, opts) {
  const o = opts || {};
  const f = o.fetchImpl || fetch;
  try {
    const res = await f(`${LOFTY_API}${path}`, {
      method,
      headers: headers(apiKey),
      ...(rawBody != null ? { body: rawBody } : {}),
      signal: o.signal || AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, httpStatus: res.status, text };
  } catch (err) {
    return { ok: false, error: short((err && err.message) || err, 120) };
  }
}

function leadsFrom(text) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
  if (!parsed || !Array.isArray(parsed.leads)) return null;
  return parsed.leads.filter((l) => l && typeof l === "object");
}

// One search (by email or by phone), answered as: the exact match's id, or
// "nobody", or "can't tell". Any result that isn't an exact match is "can't
// tell" -- Lofty returned someone we couldn't place, so "new" isn't safe.
async function search(field, value, isMatch, apiKey, opts) {
  try {
    const qs = new URLSearchParams({ [field]: value, preciseSearchFlag: "true", limit: "5" });
    const res = await call("GET", `/v1.0/leads?${qs}`, apiKey, null, opts);
    if (!res.ok) return { attempted: true, ok: false, httpStatus: res.httpStatus, error: res.error };
    const leads = leadsFrom(res.text);
    if (!leads) return { attempted: true, ok: false, httpStatus: res.httpStatus, error: "unexpected response shape" };
    const exact = leads.filter(isMatch);
    if (exact.length > 1) {
      return { attempted: true, ok: false, httpStatus: res.httpStatus, matches: exact.length,
        leadId: null, manualReview: true, error: "multiple exact matches; identity needs manual review" };
    }
    if (leads.length && !exact.length) {
      return { attempted: true, ok: false, httpStatus: res.httpStatus, error: `${leads.length} result(s), none an exact match` };
    }
    const first = exact[0];
    if (first && !Number.isSafeInteger(first.leadId)) {
      return { attempted: true, ok: false, httpStatus: res.httpStatus, error: "lead id not exactly representable" };
    }
    return { attempted: true, ok: true, httpStatus: res.httpStatus, matches: exact.length, leadId: first ? String(first.leadId) : null };
  } catch (err) {
    return { attempted: true, ok: false, error: short((err && err.message) || err, 120) };
  }
}

function normEmail(v) { return String(v || "").trim().toLowerCase(); }
function lastTen(v) { const d = String(v || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; }

// The surviving contact for this email, or null when Lofty has none.
async function findLeadByEmail(email, apiKey, opts) {
  const e = String(email || "").trim();
  if (!apiKey || !e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { attempted: false };
  return search("email", e, (l) => [].concat(l.emails || [], l.email || []).map(normEmail).includes(normEmail(e)), apiKey, opts);
}

// The same question by phone -- Lofty's search takes bare digits ("3479033333").
async function findLeadByPhone(phone, apiKey, opts) {
  const ten = lastTen(phone);
  if (!apiKey || !ten) return { attempted: false };
  return search("phone", ten, (l) => [].concat(l.phones || [], l.phone || []).some((p) => lastTen(p) === ten), apiKey, opts);
}

// Is this person already in Lofty? Email and phone asked in parallel under one
// budget. Returns:
//   ok        every question asked was answered clearly (so "nobody" is true)
//   leadId    the EMAIL match -- the only one used to redirect note/task/link
//   anyMatch  anyone at all by email or phone (blocks fields, switches to tagsAdd)
async function findExistingLead(email, phone, apiKey, opts) {
  try {
    const o = opts || {};
    const signal = AbortSignal.timeout(o.budgetMs || LOOKUP_BUDGET_MS);
    const [byEmail, byPhone] = await Promise.all([
      findLeadByEmail(email, apiKey, { ...o, signal }),
      findLeadByPhone(phone, apiKey, { ...o, signal }),
    ]);
    const asked = [byEmail, byPhone].filter((r) => r.attempted);
    if (!asked.length) return { attempted: false, ok: false, leadId: null, anyMatch: false };
    const failed = asked.find((r) => !r.ok);
    const emailId = byEmail.ok ? byEmail.leadId || null : null;
    const phoneId = byPhone.ok ? byPhone.leadId || null : null;
    const mismatchedIds = !!(emailId && phoneId && emailId !== phoneId);
    const manualReview = !!(byEmail.manualReview || byPhone.manualReview || mismatchedIds);
    return {
      attempted: true,
      ok: !failed && !manualReview,
      leadId: manualReview ? null : emailId,
      via: emailId ? "email" : phoneId ? "phone" : undefined,
      phoneLeadId: phoneId,
      anyMatch: !!(emailId || phoneId || manualReview),
      manualReview,
      error: mismatchedIds ? "email and phone identify different contacts; identity needs manual review"
        : failed ? failed.error || `HTTP ${failed.httpStatus}` : undefined,
    };
  } catch (err) {
    return { attempted: true, ok: false, leadId: null, anyMatch: false, error: short((err && err.message) || err, 120) };
  }
}

// "2026-09-29T08:45:00-06:00" -- a wall-clock time in Denver with its real
// offset (MDT or MST), which is the shape Lofty's task API documents.
function denverIso(date) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMin = Math.round((asUtc - d.getTime()) / 60000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

function taskContent(d) {
  const who = [d.name, d.phone, d.email].filter(Boolean).join(" · ") || "a returning contact";
  return `Returning website lead — ${d.label || "website form"}. Call back: ${who}. ` +
    "They were already in Lofty, so the Hot Lead tag couldn't fire again; the full enquiry is in today's note.";
}

// Creates a Call task on the lead (due in 30 minutes, assigned to the lead's
// agent) and pushes it to that agent's phone. The client is never contacted.
async function alertReturningLead(leadId, details, apiKey, opts) {
  try {
    const o = opts || {};
    if (!apiKey || !leadId) return { attempted: false };
    const now = o.now ? new Date(o.now) : new Date();
    const body = withId({
      type: "Call",
      content: taskContent(details || {}).slice(0, 500),
      assignedRole: "Agent",
      endAt: denverIso(new Date(now.getTime() + TASK_DUE_MINUTES * 60000)),
      timeZoneCode: TZ,
    }, "leadId", leadId);
    const task = await call("POST", "/v2.0/tasks", apiKey, body, o);
    const taskId = task.ok ? idsFrom(task.text, "taskId")[0] || null : null;
    if (!taskId) {
      return {
        attempted: true, ok: false, step: "task",
        httpStatus: task.httpStatus, error: task.error || (task.ok ? "no taskId in response" : undefined),
        response: task.ok ? undefined : short(task.text),
      };
    }
    const push = await call("POST", "/v2.0/sales-agent/notification/app-push/send-task-reminder",
      apiKey, withId({ type: "TASK" }, "taskId", taskId), o);
    return {
      attempted: true, ok: push.ok, step: push.ok ? "pushed" : "push", taskId,
      httpStatus: push.httpStatus, error: push.error,
      response: push.ok ? undefined : short(push.text),
    };
  } catch (err) {
    return { attempted: true, ok: false, step: "task", error: short((err && err.message) || err, 120) };
  }
}

// The four field values for a lead, from the form's own hidden attribution
// fields (added statically to every lead form by the ROI build step).
function websiteFieldValues(formLabel, data) {
  const d = data || {};
  const utm = [d.utm_source, d.utm_medium].filter(Boolean).join(" / ");
  const source = d.attribution_source || utm || d.attribution_referrer || "";
  const values = {
    "Website Form": formLabel || "",
    "Website First Page": d.attribution_first_page || "",
    "Website Form Page": d.attribution_form_page || "",
    "Website Traffic Source": source,
  };
  return WEBSITE_FIELDS
    .map((name) => ({ attributeName: name, attributeType: "text", value: String(values[name] || "").slice(0, 250) }))
    .filter((f) => f.value);
}

function fieldNamesFrom(text) {
  const names = new Set();
  const re = /"attributeName"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    try { names.add(JSON.parse(`"${m[1]}"`)); } catch (err) { names.add(m[1]); }
  }
  return names;
}

// Makes sure the four fields exist on her team; remembered for a week so a form
// submission normally spends no calls on it.
async function ensureWebsiteFields(store, apiKey, opts) {
  try {
    const o = opts || {};
    const now = o.now || Date.now();
    if (!apiKey) return { ok: false, reason: "no api key" };
    if (store) {
      const cached = await store.get(FIELDS_KEY, { type: "json" }).catch(() => null);
      if (cached && cached.ok && now - Date.parse(cached.at) < FIELDS_TTL_MS) return { ...cached, cached: true };
    }
    const list = await call("GET", "/v1.0/teamFeatures/listCustomField", apiKey, null, o);
    if (!list.ok) return { ok: false, step: "list", httpStatus: list.httpStatus, error: list.error };
    const have = fieldNamesFrom(list.text);
    const created = [];
    const failed = [];
    for (const name of WEBSITE_FIELDS) {
      if (have.has(name)) continue;
      const res = await call("POST", "/v1.0/teamFeatures/custom-field", apiKey,
        JSON.stringify({ attributeName: name, attributeType: "text", value: "" }), o);
      if (res.ok) created.push(name); else failed.push(`${name} (${res.httpStatus || res.error})`);
    }
    const result = { ok: failed.length === 0, at: new Date(now).toISOString(), created, failed };
    if (store) await store.setJSON(FIELDS_KEY, result).catch(() => {});
    return result;
  } catch (err) {
    return { ok: false, error: short((err && err.message) || err, 120) };
  }
}

// Writes the field values onto a brand-new lead. See the header for why only new.
async function setWebsiteFields(leadId, fields, apiKey, opts) {
  try {
    if (!apiKey || !leadId || !Array.isArray(fields) || !fields.length) return { attempted: false };
    const res = await call("PUT", `/v1.0/leads/${String(leadId).replace(/\D/g, "")}`, apiKey,
      JSON.stringify({ customAttributeList: fields }), opts);
    return {
      attempted: true, ok: res.ok, httpStatus: res.httpStatus, error: res.error,
      fields: fields.map((f) => f.attributeName),
      response: res.ok ? undefined : short(res.text),
    };
  } catch (err) {
    return { attempted: true, ok: false, error: short((err && err.message) || err, 120) };
  }
}

// ---- 2026-09-30 (API audit): what a buyer asked for, in Lofty's own fields ----
// A listing-alert request (and a "where are you looking" answer) reached Lofty
// only as note text, which Lofty can't search, alert on or hand to its assistant,
// and the alert form's own comment said the alert had to be set up by hand
// because no endpoint was confirmed. Lofty's API reference has one:
// POST /v1.0/leads/{leadId}/inquiry, "set a lead's home search wants: price, beds,
// baths, areas". The field names are the ones Lofty returns as a lead's
// leadInquiry (priceMin, priceMax, bedroomsMin, bathroomsMin, propertyType,
// locations -- read that way by the noco-newsletter Lofty client); the endpoint's
// request schema itself wasn't readable from here, so the answer is recorded for
// /status and the note keeps the same wishes either way. Written only on a contact
// proven brand new, like the website fields: whether an inquiry replaces a
// client's existing one is undocumented.
//
// Property-type labels are the ones her Lofty search uses (lib/_home-search.js in
// the Signature repo, read off her Lofty site).
const INQUIRY_PROPERTY_TYPES = { house: ["Single Family Home"], condo: ["Condo", "Townhouse"] };
const MAX_INQUIRY_TOWNS = 25;

function positiveInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function townNames(list) {
  const out = [];
  for (const t of list) {
    const name = String(t || "").replace(/[^A-Za-z .'-]/g, "").trim();
    if (!name || name.length > 40) continue;
    const title = name.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
    if (!out.includes(title)) out.push(title);
    if (out.length >= MAX_INQUIRY_TOWNS) break;
  }
  return out;
}

// The inquiry for a form submission, or null when it carries no search. Reads the
// alert form's alert_query (the site's own search parameters) and, failing towns
// there, a free-text where_looking answer -- used only when every part of it is a
// town the site knows, so free text never becomes a wrong search area.
function inquiryFromForm(data) {
  const d = data || {};
  const q = new URLSearchParams(String(d.alert_query || ""));
  let towns = townNames([q.get("city")].concat(String(q.get("cities") || "").split(",")));
  if (!towns.length && d.where_looking) {
    const parts = String(d.where_looking).split(/,|\/|&|;|\bor\b|\band\b/i)
      .map((p) => p.replace(/\b(co|colorado)\b\.?/gi, "").trim()).filter(Boolean);
    if (parts.length && parts.every((p) => inferCountyFromCity(p.toLowerCase()))) towns = townNames(parts);
  }
  const body = {};
  if (towns.length) body.locations = towns.map((city) => ({ city, state: "CO" }));
  const min = positiveInt(q.get("minPrice"));
  const max = positiveInt(q.get("maxPrice"));
  if (min) body.priceMin = min;
  if (max && (!min || max >= min)) body.priceMax = max;
  const beds = positiveInt(q.get("beds"));
  if (beds) body.bedroomsMin = beds;
  const baths = positiveInt(q.get("baths"));
  if (baths) body.bathroomsMin = baths;
  const types = INQUIRY_PROPERTY_TYPES[String(q.get("propertyCategory") || "").toLowerCase()];
  if (types) body.propertyType = types.slice();
  return Object.keys(body).length ? body : null;
}

// POST /v1.0/leads/{leadId}/inquiry. Never throws; the caller records the result.
async function placeInquiry(leadId, inquiry, apiKey, opts) {
  try {
    if (!apiKey || !leadId || !inquiry) return { attempted: false };
    const res = await call("POST", `/v1.0/leads/${String(leadId).replace(/\D/g, "")}/inquiry`, apiKey,
      JSON.stringify(inquiry), opts);
    return {
      attempted: true, ok: res.ok, httpStatus: res.httpStatus, error: res.error,
      fields: Object.keys(inquiry),
      response: res.ok ? undefined : short(res.text),
    };
  } catch (err) {
    return { attempted: true, ok: false, error: short((err && err.message) || err, 120) };
  }
}

module.exports = {
  LOFTY_API, TZ, TASK_DUE_MINUTES, LOOKUP_BUDGET_MS, FIELDS_KEY, WEBSITE_FIELDS,
  idsFrom, withId, leadIdFromResponse, denverIso, taskContent,
  findLeadByEmail, findLeadByPhone, findExistingLead,
  alertReturningLead, websiteFieldValues, ensureWebsiteFields, setWebsiteFields,
  INQUIRY_PROPERTY_TYPES, inquiryFromForm, placeInquiry,
};
