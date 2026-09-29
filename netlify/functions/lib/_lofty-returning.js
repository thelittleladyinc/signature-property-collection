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
//      there (and GET /leads/{id} doesn't return tags, so it can't be removed and
//      re-added safely -- see _notify.js). The backup email still reached her;
//      Lofty itself stayed silent.
//
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
//      and a returning lead's note, task and push all go to the contact that
//      actually exists.
//
//   3. WEBSITE FIELDS (item 3 of the same list). Which form, first page, form
//      page and traffic source used to live only inside the note text. They now
//      also go into four text custom fields on the lead, so she can filter and
//      report on them in Lofty. Created on the team once
//      (POST /v1.0/teamFeatures/custom-field) and remembered for a week.
//      Written ONLY on a brand-new contact: Lofty's docs don't say whether a
//      PUT with customAttributeList replaces a lead's other custom fields, and
//      GET /leads doesn't return them to merge with, so touching an existing
//      client's record could wipe fields she or another tool set. A new contact
//      has nothing to lose.
//
// Every function here returns a small result object and throws nothing: the lead
// is already in Netlify Forms, in Lofty and in her inbox before any of it runs.
"use strict";

const LOFTY_API = "https://api.lofty.com";
const TIMEOUT_MS = 5000;
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

function withId(body, key, id) {
  // {"leadId": 1148639689762408, ...} with the id as literal digits.
  const json = JSON.stringify({ ...body, [key]: "__ID__" });
  return json.replace('"__ID__"', String(id).replace(/\D/g, ""));
}

async function call(method, path, apiKey, rawBody, fetchImpl) {
  const f = fetchImpl || fetch;
  try {
    const res = await f(`${LOFTY_API}${path}`, {
      method,
      headers: headers(apiKey),
      ...(rawBody != null ? { body: rawBody } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, httpStatus: res.status, text: text.slice(0, 4000) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// The surviving contact for this email, or null when Lofty has none. `ok` false
// means the question couldn't be answered -- callers then change nothing.
async function findLeadByEmail(email, apiKey, fetchImpl) {
  const e = String(email || "").trim();
  if (!apiKey || !e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { attempted: false };
  const qs = new URLSearchParams({ email: e, preciseSearchFlag: "true", limit: "5" });
  const res = await call("GET", `/v1.0/leads?${qs}`, apiKey, null, fetchImpl);
  if (!res.ok) return { attempted: true, ok: false, httpStatus: res.httpStatus, error: res.error };
  let parsed = null;
  try { parsed = JSON.parse(res.text); } catch (err) { parsed = null; }
  if (!parsed || !Array.isArray(parsed.leads)) {
    return { attempted: true, ok: false, httpStatus: res.httpStatus, error: "unexpected response shape" };
  }
  // Exact matches only, even though the search is already "precise": a stray
  // partial match must never attach a stranger's enquiry to someone else. And
  // only ids JavaScript holds exactly (today's are ~1.1e15, well under 2^53); a
  // larger one is treated as "can't tell" rather than risk a rounded id.
  const exact = parsed.leads.filter((l) => {
    const emails = [].concat(l.emails || [], l.email || []).map((x) => String(x).trim().toLowerCase());
    return emails.includes(e.toLowerCase());
  });
  const first = exact[0];
  if (first && !Number.isSafeInteger(first.leadId)) {
    return { attempted: true, ok: false, httpStatus: res.httpStatus, error: "lead id not exactly representable" };
  }
  return {
    attempted: true, ok: true, httpStatus: res.httpStatus,
    matches: exact.length,
    leadId: first ? String(first.leadId) : null,
    assignedUser: first && first.assignedUser ? String(first.assignedUser).slice(0, 60) : undefined,
  };
}

function digits(v) { return String(v || "").replace(/\D/g, ""); }
function lastTen(v) { const d = digits(v); return d.length >= 10 ? d.slice(-10) : ""; }

// The same question by phone -- Lofty's search takes bare digits ("3479033333").
// Asked only when the email found nobody, because Lofty can also merge a new
// submission into an existing contact by phone, and then "new contact" would be
// wrong (and the website fields would land on a client's existing record).
async function findLeadByPhone(phone, apiKey, fetchImpl) {
  const ten = lastTen(phone);
  if (!apiKey || !ten) return { attempted: false };
  const qs = new URLSearchParams({ phone: ten, preciseSearchFlag: "true", limit: "5" });
  const res = await call("GET", `/v1.0/leads?${qs}`, apiKey, null, fetchImpl);
  if (!res.ok) return { attempted: true, ok: false, httpStatus: res.httpStatus, error: res.error };
  let parsed = null;
  try { parsed = JSON.parse(res.text); } catch (err) { parsed = null; }
  if (!parsed || !Array.isArray(parsed.leads)) {
    return { attempted: true, ok: false, httpStatus: res.httpStatus, error: "unexpected response shape" };
  }
  const exact = parsed.leads.filter((l) => [].concat(l.phones || [], l.phone || []).some((p) => lastTen(p) === ten));
  const first = exact[0];
  if (first && !Number.isSafeInteger(first.leadId)) {
    return { attempted: true, ok: false, httpStatus: res.httpStatus, error: "lead id not exactly representable" };
  }
  return { attempted: true, ok: true, httpStatus: res.httpStatus, matches: exact.length, leadId: first ? String(first.leadId) : null };
}

// Is this person already in Lofty? By email first, then by phone. `ok` is true
// only when every question asked was answered, so "not found" can be trusted.
async function findExistingLead(email, phone, apiKey, fetchImpl) {
  const byEmail = await findLeadByEmail(email, apiKey, fetchImpl);
  if (byEmail.attempted && byEmail.ok && byEmail.leadId) return { ...byEmail, via: "email" };
  const byPhone = await findLeadByPhone(phone, apiKey, fetchImpl);
  if (byPhone.attempted && byPhone.ok && byPhone.leadId) return { ...byPhone, via: "phone" };
  const asked = [byEmail, byPhone].filter((r) => r.attempted);
  if (!asked.length) return { attempted: false };
  const failed = asked.find((r) => !r.ok);
  return failed
    ? { attempted: true, ok: false, httpStatus: failed.httpStatus, error: failed.error }
    : { attempted: true, ok: true, leadId: null, matches: 0 };
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
  const task = await call("POST", "/v2.0/tasks", apiKey, body, o.fetchImpl);
  const taskId = task.ok ? idsFrom(task.text, "taskId")[0] || null : null;
  if (!taskId) {
    return {
      attempted: true, ok: false, step: "task",
      httpStatus: task.httpStatus, error: task.error || (task.ok ? "no taskId in response" : undefined),
      response: task.ok ? undefined : String(task.text || "").slice(0, 200),
    };
  }
  const push = await call("POST", "/v2.0/sales-agent/notification/app-push/send-task-reminder",
    apiKey, withId({ type: "TASK" }, "taskId", taskId), o.fetchImpl);
  return {
    attempted: true, ok: push.ok, step: push.ok ? "pushed" : "push", taskId,
    httpStatus: push.httpStatus, error: push.error,
    response: push.ok ? undefined : String(push.text || "").slice(0, 200),
  };
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
  while ((m = re.exec(String(text || "")))) names.add(JSON.parse(`"${m[1]}"`));
  return names;
}

// Makes sure the four fields exist on her team; remembered for a week so a form
// submission normally spends no calls on it.
async function ensureWebsiteFields(store, apiKey, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  if (!apiKey) return { ok: false, reason: "no api key" };
  if (store) {
    const cached = await store.get(FIELDS_KEY, { type: "json" }).catch(() => null);
    if (cached && cached.ok && now - Date.parse(cached.at) < FIELDS_TTL_MS) return { ...cached, cached: true };
  }
  const list = await call("GET", "/v1.0/teamFeatures/listCustomField", apiKey, null, o.fetchImpl);
  if (!list.ok) return { ok: false, step: "list", httpStatus: list.httpStatus, error: list.error };
  const have = fieldNamesFrom(list.text);
  const created = [];
  const failed = [];
  for (const name of WEBSITE_FIELDS) {
    if (have.has(name)) continue;
    const res = await call("POST", "/v1.0/teamFeatures/custom-field", apiKey,
      JSON.stringify({ attributeName: name, attributeType: "text", value: "" }), o.fetchImpl);
    (res.ok ? created : failed).push(res.ok ? name : `${name} (${res.httpStatus || res.error})`);
  }
  const result = { ok: failed.length === 0, at: new Date(now).toISOString(), created, failed };
  if (store) await store.setJSON(FIELDS_KEY, result).catch(() => {});
  return result;
}

// Writes the field values onto a brand-new lead. See the header for why only new.
async function setWebsiteFields(leadId, fields, apiKey, fetchImpl) {
  if (!apiKey || !leadId || !Array.isArray(fields) || !fields.length) return { attempted: false };
  const res = await call("PUT", `/v1.0/leads/${String(leadId).replace(/\D/g, "")}`, apiKey,
    JSON.stringify({ customAttributeList: fields }), fetchImpl);
  return {
    attempted: true, ok: res.ok, httpStatus: res.httpStatus, error: res.error,
    fields: fields.map((f) => f.attributeName),
    response: res.ok ? undefined : String(res.text || "").slice(0, 200),
  };
}

module.exports = {
  LOFTY_API, TZ, TASK_DUE_MINUTES, FIELDS_KEY, WEBSITE_FIELDS,
  idsFrom, withId, denverIso, taskContent,
  findLeadByEmail, findLeadByPhone, findExistingLead,
  alertReturningLead, websiteFieldValues, ensureWebsiteFields, setWebsiteFields,
};
