// The side-by-side check (Christine, 2026-10-23: "it's very important that we don't lose anything at all since
// everything is completely integrated"). OFF unless HUB_SIDE_BY_SIDE says so.
//
// BYTE-IDENTICAL in thelittleladysellshomes and signature-property-collection (tests/test-lofty-via-hub.js compares
// the two when both checkouts sit side by side). It names neither site. docs/hub-side-by-side.md is the short version;
// sellerintelligence docs/hub-parity-compare.md is the whole contract.
//
// WHAT IT IS. Before any of this site's work moves onto the Seller Intelligence hub, the site keeps doing exactly what
// it does today with its own connection AND asks the hub the same question, compares the two answers field by field
// with the shared toolkit's rules (lib/suite-kit/parity.js compareRecords), and sends one row per comparison to the
// hub's ledger (POST /v1/parity/record). A row carries field NAMES only (which fields differed, and whether the hub
// would lose one: own_only), never a value, and the record's key only as parityKey's hash.
//
// THE SETTINGS (names only; never a value in code, docs or a log):
//   HUB_SIDE_BY_SIDE      a comma-separated list of the areas to run: lofty_write, lofty_read, mls_read, rentcast
//                         (trimmed, any case). Unset, empty or nothing known = off. An unknown entry is ignored and
//                         logged once by name. This site runs lofty_write (the form handler) and mls_read (the
//                         scheduled MLS sync and the town-figures job); lofty_read and rentcast have nothing here yet.
//   HUB_SIDE_BY_SIDE_MAX  comparisons per run (scheduled jobs) or per hour (the form handler, per warm function
//                         instance); default 20, at most 200.
//   HUB_API_URL + HUB_API_KEY  the hub settings this site already uses (https only; the key in x-hub-key only).
//
// THE RULES IT KEEPS.
//   - It never changes what the site does. Off, nothing here runs at all: no hub call, no wrapper, no extra read.
//     On, the site's own Lofty, MLS Grid and Blobs work, its answers, its timing and everything it writes are exactly
//     what they are with it off, whatever the hub does (slow, down, refusing, answering garbage). Every entry point
//     here is wrapped and never throws.
//   - It never writes to Lofty, MLS Grid or the hub's own data. The Lofty questions go to the hub with dry_run: true
//     ONLY (the hub reads Lofty as for real and answers the requests it WOULD send, sending none), and only after a
//     probe ({ dry_run: "probe" }) shows the hub knows dry_run: an older hub-api would ignore it and really write, so
//     it is never sent a real body (dryRunReady). The MLS and town questions are the hub's ordinary reads. The one
//     write is the ledger row.
//   - Short time limits: 3 s on the form handler (a request path), 8 s in a scheduled job, and never past the
//     platform's own limit (Netlify: about 10 s for the form handler, 30 s for a scheduled function): with too little
//     time left the question is not asked (reason "skipped").
//   - The hub's dry-run answer holds the person's details (it is the request body). It is compared in memory here and
//     dropped: never logged, stored, printed or sent anywhere. Log lines carry counts and field names only.
//   - Rows go to the hub in batches of at most 200, with a short time limit; a failed post is logged as a count and
//     never retried.
"use strict";

const AREAS = Object.freeze(["lofty_write", "lofty_read", "mls_read", "rentcast"]);
const DEFAULT_MAX = 20;
const MAX_MAX = 200;
const REQUEST_ASK_MS = 3000;
const JOB_ASK_MS = 8000;
// Netlify's own limits: the form handler (an event-triggered function) and a scheduled function.
const REQUEST_LIMIT_MS = 10000;
const SCHEDULED_LIMIT_MS = 30000;
const LIMIT_MARGIN_MS = 1500;
const MIN_POST_MS = 500;
const RECORD_PATH = "/v1/parity/record";
const MAX_ROWS_PER_POST = 200;
const LOFTY_ORIGIN = "https://api.lofty.com/";
// The hub takes at most 20 tags on a push (lib/_lofty-hub.js MAX_HUB_TAGS).
const MAX_HUB_TAGS = 20;

// The vendored toolkit (lib/suite-kit, CommonJS build; never edit it), loaded on first use so a site with the check
// off never loads it.
let kitCache = null;
function kit() {
  if (!kitCache) {
    kitCache = { hub: require("./suite-kit/hub"), parity: require("./suite-kit/parity"), lofty: require("./suite-kit/lofty"),
      contact: require("./suite-kit/contact") };
  }
  return kitCache;
}

const quietLog = (log) => (typeof log === "function" ? log : (m) => console.log(m));
function safe(fn, fallback) {
  try { return fn(); } catch (err) { return fallback; }
}
const short = (v, n) => String(v == null ? "" : v).slice(0, n || 80);

// ---- The settings ---------------------------------------------------------------------------------------------

const warned = new Set();
function warnOnce(key, line, log) {
  if (warned.has(key)) return;
  warned.add(key);
  try { quietLog(log)(line); } catch (err) { /* never in the way */ }
}

// The areas HUB_SIDE_BY_SIDE switches on (a Set). Unknown entries are ignored, each logged once by name.
function sideBySideAreas(env, log) {
  const raw = String(((env || process.env).HUB_SIDE_BY_SIDE) == null ? "" : (env || process.env).HUB_SIDE_BY_SIDE);
  const out = new Set();
  for (const part of raw.split(",")) {
    const a = part.trim().toLowerCase();
    if (!a) continue;
    if (AREAS.includes(a)) { out.add(a); continue; }
    if (/^[a-z0-9_-]{1,40}$/.test(a)) warnOnce(`area:${a}`, `Side-by-side: HUB_SIDE_BY_SIDE entry "${a}" is not an area (lofty_write, lofty_read, mls_read, rentcast); ignored.`, log);
    else warnOnce("area:?", "Side-by-side: HUB_SIDE_BY_SIDE has an entry that is not an area name; ignored.", log);
  }
  return out;
}

function sideBySideOn(area, env, log) {
  return sideBySideAreas(env, log).has(area);
}

// HUB_SIDE_BY_SIDE_MAX: a whole number 1..200; unset or unreadable = 20; above 200 = 200.
function sideBySideMax(env) {
  const v = String(((env || process.env).HUB_SIDE_BY_SIDE_MAX) == null ? "" : (env || process.env).HUB_SIDE_BY_SIDE_MAX).trim();
  if (!/^\d{1,6}$/.test(v)) return DEFAULT_MAX;
  const n = Number(v);
  if (n < 1) return DEFAULT_MAX;
  return Math.min(n, MAX_MAX);
}

// The form handler's cap: comparisons per clock hour, counted in this function instance's memory (nothing is
// stored: a cold start counts from zero, which only ever means fewer questions over a day, never more per hour).
const hourly = { hour: -1, used: 0 };
function takeHourly(n, env, now) {
  const hour = Math.floor((now || Date.now()) / 3600000);
  if (hourly.hour !== hour) { hourly.hour = hour; hourly.used = 0; }
  if (hourly.used + n > sideBySideMax(env)) return false;
  hourly.used += n;
  return true;
}
function resetHourly() { hourly.hour = -1; hourly.used = 0; }

// Why the hub can't be asked, naming the settings and never a value; null when it can.
function hubProblem(env) {
  const e = env || process.env;
  const url = String(e.HUB_API_URL || "").trim();
  const key = String(e.HUB_API_KEY || "").trim();
  if (!url || !key) return "HUB_API_URL / HUB_API_KEY not set";
  if (!kit().hub.hubConfigured({ baseUrl: url, key })) return "HUB_API_URL must be https and HUB_API_KEY a hub key";
  return null;
}

// A hub client on its own time limit, through the toolkit (redirects refused, the key in x-hub-key only). The fetch
// it is handed is wrapped only to tell a timeout from an unreachable hub.
function hubClient(env, timeoutMs, baseFetch) {
  const e = env || process.env;
  const state = { timedOut: false };
  const f = baseFetch || ((u, i) => globalThis.fetch(u, i));
  const watched = async (url, init) => {
    try { return await f(url, init); } catch (err) {
      if (err && (err.name === "TimeoutError" || err.name === "AbortError")) state.timedOut = true;
      throw err;
    }
  };
  const client = kit().hub.createHubClient({
    baseUrl: String(e.HUB_API_URL || "").trim(), key: String(e.HUB_API_KEY || "").trim(),
    fetch: watched, timeoutMs: Math.max(1, Math.round(timeoutMs)),
  });
  return { client, state };
}

// A failed hub answer as one of the ledger's reasons.
function reasonFor(ans, state) {
  if (!ans) return "hub_unreachable";
  if (ans.reason === "not_configured") return "hub_off";
  if (ans.reason === "unreachable") return state && state.timedOut ? "hub_timeout" : "hub_unreachable";
  if (ans.reason === "bad_answer") return "hub_bad_answer";
  const b = ans.body && typeof ans.body === "object" ? ans.body : {};
  if (ans.status === 503) {
    if (b.status === "not_ready" || /not.ready/i.test(String(b.error || ""))) return "hub_not_ready";
    return "hub_off";
  }
  return "hub_refused";
}

// Asks once; never throws. -> { ok: true, body, at } | { ok: false, reason, at }
async function ask(make, env, timeoutMs, baseFetch) {
  const { client, state } = hubClient(env, timeoutMs, baseFetch);
  let ans;
  try { ans = await make(client); } catch (err) { ans = null; }
  const at = Date.now();
  if (ans && ans.ok && ans.body && typeof ans.body === "object") return { ok: true, body: ans.body, at };
  return { ok: false, reason: reasonFor(ans, state), status: ans && ans.status, at };
}

// The dry-run probe. Before the first dry run on a Lofty write route, the route is asked something only a hub that
// knows dry_run can answer: { dry_run: "probe" }. A hub with the option (0079, toolkit 0.5.2) refuses it with a 400
// naming dry_run before it reads anything else or looks at a switch (writeRequest in the hub's lofty.ts). An older
// hub-api does not know dry_run: it would ignore it on a real body and REALLY write (a second lead, task or tag), so
// it is never sent one. Asked the probe, an older hub answers 400 for the missing email or lead id (nothing written)
// or 503 for a closed switch. Remembered in this instance's memory: an hour for a yes, 10 minutes for a no; a timeout,
// an unreachable hub, a 429 or a 5xx other than a closed switch is not remembered. -> null (ready) | a ledger reason
const DRY_RUN_PROBE_OK_MS = 3600000;
const DRY_RUN_PROBE_BAD_MS = 600000;
const dryRunProbes = new Map();
async function dryRunReady(path, env, timeoutMs, baseFetch) {
  const seen = dryRunProbes.get(path);
  if (seen && Date.now() - seen.at < (seen.reason ? DRY_RUN_PROBE_BAD_MS : DRY_RUN_PROBE_OK_MS)) return seen.reason;
  const { client, state } = hubClient(env, timeoutMs, baseFetch);
  let ans;
  try { ans = await client.call("POST", path, { dry_run: "probe" }); } catch (err) { ans = null; }
  const error = ans && ans.body && typeof ans.body === "object" ? String(ans.body.error || "") : "";
  let reason;
  if (ans && ans.status === 400 && /\bdry_run\b/.test(error)) reason = null;
  // A 2xx to a probe: the route did not check the option, so it is never sent a real body.
  else if (ans && ans.ok) reason = "hub_bad_answer";
  // A build without the option (or without the route).
  else if (ans && (ans.status === 400 || ans.status === 404)) reason = "hub_not_ready";
  else reason = reasonFor(ans, state);
  const keep = reason === null || reason === "hub_not_ready" || reason === "hub_bad_answer" || reason === "hub_off" ||
    !!(ans && (ans.status === 401 || ans.status === 403));
  if (keep) dryRunProbes.set(path, { reason, at: Date.now() });
  return reason;
}

// A dry run on a Lofty write route, only after its probe says the hub knows dry_run; both inside one time limit.
// -> as ask()
async function dryRunAsk(path, make, env, timeoutMs, baseFetch) {
  const started = Date.now();
  const no = await dryRunReady(path, env, timeoutMs, baseFetch);
  if (no) return { ok: false, reason: no, at: Date.now() };
  const left = timeoutMs - (Date.now() - started);
  if (left < 250) return { ok: false, reason: "hub_timeout", at: Date.now() };
  return ask(make, env, left, baseFetch);
}

async function keyFor(text) {
  try { return await kit().parity.parityKey(String(text)); } catch (err) { return null; }
}

// One ledger row, or null when the toolkit refuses it (a developer error; never sent).
function row(area, op, result, key) {
  try { return kit().parity.parityRow(area, op, result, key); } catch (err) { return null; }
}

function compare(spec, own, hub) {
  return kit().parity.compareRecords(spec, own, hub);
}

// Sends rows to the hub's ledger in batches of 200. Never throws, never retries. -> { sent, failed, reason }
async function recordRows(rows, opts) {
  const o = opts || {};
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const out = { sent: 0, failed: 0, reason: null };
  if (!list.length) return out;
  if (hubProblem(o.env)) { out.failed = list.length; out.reason = "hub_off"; return out; }
  const until = o.deadline || (Date.now() + (o.timeoutMs || REQUEST_ASK_MS));
  for (let i = 0; i < list.length; i += MAX_ROWS_PER_POST) {
    const batch = list.slice(i, i + MAX_ROWS_PER_POST);
    const left = Math.min(o.timeoutMs || REQUEST_ASK_MS, until - Date.now());
    if (left < MIN_POST_MS) { out.failed += list.length - i; out.reason = out.reason || "skipped"; break; }
    const r = await ask((c) => c.call("POST", RECORD_PATH, { rows: batch }), o.env, left, o.fetch);
    if (r.ok && r.body.status === "ok") out.sent += batch.length;
    else { out.failed += batch.length; out.reason = out.reason || (r.ok ? "hub_bad_answer" : r.reason); }
  }
  return out;
}

// One log line for a set of rows: outcomes and field names, never a value.
function describeRows(label, rows) {
  const counts = {};
  const fields = new Set();
  for (const r of rows) {
    if (!r) continue;
    const k = r.outcome === "not_compared" ? `not_compared:${r.reason}` : r.outcome;
    counts[k] = (counts[k] || 0) + 1;
    for (const f of r.own_only) fields.add(`${f} (own_only)`);
    for (const f of r.different) fields.add(`${f} (different)`);
    for (const f of r.hub_only) fields.add(`${f} (hub_only)`);
  }
  const parts = Object.keys(counts).sort().map((k) => `${counts[k]} ${k}`);
  const named = [...fields].sort();
  return `Side-by-side ${label}: ${parts.join(", ") || "nothing compared"}` +
    (named.length ? `; fields: ${named.slice(0, 30).join(", ")}${named.length > 30 ? ", ..." : ""}` : "") + ".";
}

// ---- Lofty writes: the request bodies --------------------------------------------------------------------------

function parseBody(body) {
  if (body == null) return { obj: null, raw: null };
  if (typeof body === "string") {
    let obj = null;
    try { obj = JSON.parse(body); } catch (err) { obj = null; }
    return { obj: obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null, raw: body };
  }
  if (typeof body === "object" && !Array.isArray(body)) return { obj: body, raw: null };
  return { obj: null, raw: null };
}

// A Lofty write, whoever made it: { kind, leadRef, body, raw, at }. Paths are Lofty's full paths (/v1.0/leads/123).
function classifyWrite(method, path, body, at) {
  const m = String(method || "").toUpperCase();
  const p = String(path || "").split("?")[0];
  const { obj, raw } = parseBody(body);
  const lead = /^\/v1\.0\/leads\/([^/]+)$/.exec(p);
  const inquiry = /^\/v1\.0\/leads\/([^/]+)\/inquiry$/.exec(p);
  let kind = "other";
  if (m === "POST" && p === "/v1.0/leads") kind = "create";
  else if (m === "POST" && p === "/v1.0/notes") kind = "note";
  else if (m === "PUT" && lead) kind = "update";
  else if (m === "POST" && inquiry) kind = "inquiry";
  else if (m === "POST" && p === "/v1.0/teamFeatures/custom-field") kind = "team_field";
  else if (m === "POST" && (p === "/v2.0/tasks" || p === "/v1.0/tasks")) kind = "task";
  else if (m === "POST" && /send-task-reminder$/.test(p)) kind = "task_push";
  return { kind, leadRef: (lead && lead[1]) || (inquiry && inquiry[1]) || null, body: obj, raw, at: at || null };
}

const tagName = (t) => (typeof t === "string" ? t : t && typeof t === "object" ? (t.tagName || t.name || "") : "");
const tagList = (v) => (Array.isArray(v) ? v.map(tagName).map((t) => String(t).trim()).filter(Boolean) : null);
const listOf = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

// What a list of writes does to one lead, in order: the create, the tags it ends with, the tags each later write
// added ("Tag Added" in Lofty, which starts a Smart Plan), the notes, texting switched on or off, the website fields,
// the team fields created, the search wishes, and the emails / phones / address written.
function writesSummary(writes) {
  const s = {
    create: null, tagsFinal: new Set(), tagsFired: new Set(), tagsSent: new Set(), notes: [], textingOn: false, textingOff: false,
    fields: null, teamFields: [], inquiry: null, emails: [], phones: [], property: null, tasks: [], taskPushes: 0,
  };
  let running = null;
  for (const w of writes) {
    const b = w.body || {};
    if (w.kind === "create") {
      s.create = b;
      const t = tagList(b.tags) || [];
      for (const x of t.concat(tagList(b.tagsAdd) || [])) s.tagsSent.add(x);
      running = new Set(t);
      s.emails.push(...listOf(b.emails), ...listOf(b.email));
      s.phones.push(...listOf(b.phones), ...listOf(b.phone));
      if (b.property) s.property = b.property;
    } else if (w.kind === "update") {
      const t = tagList(b.tags);
      if (t) {
        const before = running || new Set();
        for (const x of t) { s.tagsSent.add(x); if (!before.has(x)) s.tagsFired.add(x); }
        running = new Set(t);
      }
      if (b.cannotText === false) s.textingOn = true;
      if (b.cannotText === true) s.textingOff = true;
      if (Array.isArray(b.customAttributeList)) {
        s.fields = {};
        for (const f of b.customAttributeList) if (f && typeof f.attributeName === "string") s.fields[f.attributeName] = f.value;
      }
      if (Array.isArray(b.emails)) s.emails.push(...b.emails);
      if (Array.isArray(b.phones)) s.phones.push(...b.phones);
      if (b.property) s.property = b.property;
    } else if (w.kind === "note") {
      if (typeof b.content === "string") s.notes.push(b.content);
    } else if (w.kind === "team_field") {
      if (typeof b.attributeName === "string") s.teamFields.push(b.attributeName);
    } else if (w.kind === "inquiry") {
      s.inquiry = b;
    } else if (w.kind === "task") {
      s.tasks.push(w);
    } else if (w.kind === "task_push") {
      s.taskPushes += 1;
    }
  }
  if (running) s.tagsFinal = running;
  return s;
}

const fieldSlug = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
const onlyForm = (set, formTags) => formTags.filter((t) => set.has(t));
function propertyView(p) {
  if (!p || typeof p !== "object") return undefined;
  return { street: p.streetAddress || p.street || undefined, city: p.city || undefined, state: p.state || undefined,
    zip: p.zipCode || p.zip || undefined };
}
const normEmail = (v) => safe(() => kit().contact.normEmail(v), null);
const normPhone = (v) => safe(() => kit().contact.normPhone(v), null);
const hasEmail = (list, email) => { const e = normEmail(email); return !!e && list.some((x) => normEmail(x) === e); };
const hasPhone = (list, phone) => { const p = normPhone(phone); return !!p && list.some((x) => normPhone(x) === p); };

// The notes a summary carries: the form's own note (the first one that is not the toolkit's "new number" note), and
// how many others.
function noteView(s) {
  const extra = safe(() => kit().lofty.NEW_NUMBER_NOTE, "");
  const main = s.notes.find((n) => n !== extra);
  return { note: main, notes_other: s.notes.length - (main === undefined ? 0 : 1) };
}

function fieldsView(s) {
  if (!s.fields) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(s.fields)) { const slug = fieldSlug(k); if (slug) out[slug] = v; }
  return out;
}

// A new contact, as one record: what the create carried, the tags the lead ends with and the ones that fire, the
// note, texting, the website fields, the team fields created and the search wishes.
function createdView(s, formTags) {
  const c = s.create || {};
  return {
    outcome: "created",
    create: {
      first_name: c.firstName, last_name: c.lastName, emails: [...listOf(c.emails), ...listOf(c.email)],
      phones: [...listOf(c.phones), ...listOf(c.phone)], source: c.source, cannot_text: c.cannotText,
      lead_types: Array.isArray(c.leadTypes) ? c.leadTypes.map(String) : undefined, notes: c.notes,
      property: propertyView(c.property), assigned_user: c.assignedUserId == null ? undefined : String(c.assignedUserId),
    },
    tags_on_lead: onlyForm(s.tagsFinal, formTags),
    tags_fired: onlyForm(s.tagsFired, formTags),
    ...noteView(s),
    texting_on: s.textingOn, texting_off: s.textingOff,
    fields: fieldsView(s),
    team_fields_created: s.teamFields.slice(),
    inquiry: s.inquiry || undefined,
  };
}

// The comparison rules for a lead. Not compared, because a dry run cannot reproduce them exactly (sellerintelligence
// docs/hub-parity-compare.md): the new lead's id (a stand-in on the hub), Lofty folding a create into another lead,
// a write Lofty refuses, a read-back that differs from what was written. Also not compared: the tags IN the create
// body (the site sends the form's tags there and re-fires "Hot Lead - Website" afterwards; the hub path puts the same
// tags in the create body except the trigger tag, which it adds after the create -- what counts in Lofty is which
// tags the lead ends with, tags_on_lead, and which fire a "Tag Added" plan, tags_fired); the form's nurture-plan tag
// (on the hub path a second push after the create, which a dry run cannot plan for a lead it only planned to create;
// both sides add it only to a contact they created, which `outcome` compares); the SMS consent tag (texting_on).
const SPEC_CREATED = Object.freeze({
  outcome: "text",
  "create.first_name": "text", "create.last_name": "text", "create.emails": "emails", "create.phones": "phones",
  "create.source": "text", "create.cannot_text": "bool", "create.lead_types": "set", "create.notes": "text",
  "create.property.street": "text_ci", "create.property.city": "text_ci", "create.property.state": "text_ci",
  "create.property.zip": "text", "create.assigned_user": "text",
  tags_on_lead: "tags", tags_fired: "tags", note: "text", notes_other: "number", texting_on: "bool", texting_off: "bool",
  team_fields_created: "set", inquiry: "json",
});
const SPEC_UPDATED = Object.freeze({
  outcome: "text", lead_id: "text", match_by: "text", email_kept: "bool", phone_kept: "bool", address_kept: "bool",
  tags_on_lead: "tags", note: "text", notes_other: "number", texting_on: "bool", texting_off: "bool",
});
const SPEC_HELD = Object.freeze({ outcome: "text", hold_reason: "text" });
const SPEC_OUTCOME = SPEC_HELD;
const SPEC_TASK = Object.freeze({
  outcome: "text", hold_reason: "text", type: "text", content: "text", assigned_role: "text",
  due_minutes: { rule: "number", tolerance: 2 }, time_zone: "text", lead_id: "text", push: "bool",
});

function specFor(ownRec, hubRec) {
  if (ownRec.outcome !== hubRec.outcome) return SPEC_OUTCOME;
  if (ownRec.outcome === "held") return SPEC_HELD;
  if (ownRec.outcome === "updated") return SPEC_UPDATED;
  const spec = { ...SPEC_CREATED };
  const slugs = new Set([...Object.keys(ownRec.fields || {}), ...Object.keys(hubRec.fields || {})]);
  for (const slug of slugs) if (/^[a-z][a-z0-9_]{0,49}$/.test(slug)) spec[`fields.${slug}`] = "text";
  return spec;
}

// The site's own hold reasons in the hub's words.
function ownHoldCode(text) {
  const t = String(text || "");
  if (/multiple exact matches/i.test(t)) return "several_leads";
  if (/different contacts/i.test(t)) return "email_phone_differ";
  return "other";
}
const HUB_HOLD_CODES = new Set(["several_leads", "no_exact_match", "already_in_lofty", "name_differs", "no_lookup_key",
  "unreadable", "dnc_lost", "do_not_contact"]);

// The site's own push, as one record (or a reason it can't be compared).
//   facts: { held } | { failed } | { existing, newLeadId, leadId, provenNew }
function ownLeadRecord(writes, facts, ctx) {
  const f = facts || {};
  if (f.held) return { outcome: "held", hold_reason: ownHoldCode(f.held) };
  if (f.failed || !f.existing) return { reason: "own_failed" };
  const ex = f.existing;
  const s = writesSummary(writes);
  if (f.provenNew) return { ...createdView(s, ctx.formTags), _leadId: f.newLeadId || null };
  if (!ex.ok && !ex.anyMatch) return { reason: "own_failed" };
  // The lookup found nobody, yet the create did not come back as this contact's own (Lofty folded it into another
  // lead, or its note did not land): a dry run cannot reproduce a fold.
  if (!ex.anyMatch) return { reason: "skipped" };
  const c = s.create || {};
  const sentEmails = [...listOf(c.emails), ...listOf(c.email)];
  const sentPhones = [...listOf(c.phones), ...listOf(c.phone)];
  return {
    outcome: "updated",
    lead_id: ex.leadId || ex.phoneLeadId || undefined,
    match_by: ex.via || (ex.leadId ? "email" : ex.phoneLeadId ? "phone" : undefined),
    // What the site SENT on its merge create (Lofty merges it into the contact it finds).
    email_kept: ctx.email ? hasEmail(sentEmails, ctx.email) : undefined,
    phone_kept: ctx.phone ? hasPhone(sentPhones, ctx.phone) : undefined,
    address_kept: ctx.addressAsked ? !!c.property : undefined,
    tags_on_lead: onlyForm(s.tagsSent, ctx.formTags),
    ...noteView(s),
    texting_on: s.textingOn, texting_off: s.textingOff,
  };
}

function hubHoldCode(b) {
  if (b.held_by === "do_not_contact") return "do_not_contact";
  const c = String(b.code || "");
  return HUB_HOLD_CODES.has(c) ? c : "other";
}

// The hub's dry run of the same push, as one record (or a reason it can't be compared).
function hubLeadRecord(answer, ctx) {
  if (!answer.ok) return { reason: answer.reason };
  const b = answer.body;
  if (b.dry_run !== true || !Array.isArray(b.planned)) return { reason: "hub_bad_answer" };
  if (b.status === "rate_limited") return { reason: "hub_refused" };
  if (b.status === "not_configured") return { reason: "hub_off" };
  if (b.code === "lookup_failed") return { reason: "hub_not_ready" };
  const writes = b.planned.map((p) => classifyWrite(p && p.method, p && p.path, p && p.body, answer.at));
  const s = writesSummary(writes);
  if ((b.status === "created" || b.status === "updated") && b.ok !== false) {
    if (b.action === "created") return createdView(s, ctx.formTags);
    const held = new Set([...listOf(b.tags_held), ...listOf(b.tags_dropped)].map(tagName));
    const asked = new Set(ctx.askedTags);
    return {
      outcome: "updated",
      lead_id: b.lead_id == null ? undefined : String(b.lead_id),
      match_by: b.matched_by || undefined,
      email_kept: ctx.email ? (b.matched_by === "email" || hasEmail(s.emails, ctx.email)) : undefined,
      // The hub adds a submitted number the lead does not have in its read-merge-write; no phone write means the
      // number was already on the lead.
      phone_kept: ctx.phone ? (b.matched_by === "phone" || !s.phones.length || hasPhone(s.phones, ctx.phone)) : undefined,
      address_kept: ctx.addressAsked ? ["filled", "completed", "same"].includes(b.address) || !!s.property : undefined,
      tags_on_lead: ctx.formTags.filter((t) => asked.has(t) && !held.has(t)),
      ...noteView(s),
      texting_on: s.textingOn, texting_off: s.textingOff,
    };
  }
  return { outcome: "held", hold_reason: hubHoldCode(b) };
}

// The Call task for a returning contact, as one record. Own: the POST /v2.0/tasks it sent (and the push after it).
function taskRecordFrom(s, sentAt) {
  const t = s.tasks[s.tasks.length - 1];
  if (!t) return { outcome: "none" };
  const b = t.body || {};
  const leadId = (/"leadId"\s*:\s*"?(\d{1,20})"?/.exec(t.raw || "") || [])[1] || (b.leadId == null ? undefined : String(b.leadId));
  const due = Date.parse(b.endAt || "");
  const from = t.at || sentAt || Date.now();
  return {
    outcome: "created", type: b.type, content: b.content, assigned_role: b.assignedRole,
    due_minutes: Number.isFinite(due) ? Math.round((due - from) / 60000) : undefined,
    time_zone: b.timeZoneCode, lead_id: leadId, push: s.taskPushes > 0,
  };
}

function hubTaskRecord(answer) {
  if (!answer.ok) return { reason: answer.reason };
  const b = answer.body;
  if (b.dry_run !== true || !Array.isArray(b.planned)) return { reason: "hub_bad_answer" };
  if (b.status === "rate_limited") return { reason: "hub_refused" };
  if (b.status === "not_configured") return { reason: "hub_off" };
  if (b.status === "held") return { outcome: "held", hold_reason: String(b.code || "other") };
  if (b.status !== "created") return { reason: "hub_not_ready" };
  // The hub works out the due time from when it was asked; so is it measured here.
  const writes = b.planned.map((p) => classifyWrite(p && p.method, p && p.path, p && p.body, answer.askedAt || answer.at));
  return taskRecordFrom(writesSummary(writes));
}

// ---- Lofty writes: the form handler's side-by-side --------------------------------------------------------------

// The capture: while one submission is handled, every Lofty write this site's own code sends (POST / PUT / DELETE
// to api.lofty.com) is noted -- method, path, body -- and passed on UNCHANGED, with the same arguments, to the same
// fetch, whose answer is returned as it is. Nothing else is touched. A Netlify function handles one request at a
// time, so the writes noted are this submission's. Restored in finish().
function installCapture(writes) {
  const base = globalThis.fetch;
  if (typeof base !== "function") return null;
  const wrapped = function sideBySideCapture(url, init) {
    try {
      const s = typeof url === "string" ? url : url && typeof url.url === "string" ? url.url : String(url);
      if (s.startsWith(LOFTY_ORIGIN)) {
        const method = String((init && init.method) || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          const u = new URL(s);
          writes.push(classifyWrite(method, u.pathname, init && init.body, Date.now()));
        }
      }
    } catch (err) { /* noting a write must never be in its way */ }
    return base(url, init);
  };
  globalThis.fetch = wrapped;
  return { base, wrapped };
}

const INERT = Object.freeze({
  active: false,
  lead() {}, lookedUp() {}, own() {},
  finish: async () => ({ attempted: false }),
});

// The form handler's side-by-side (area lofty_write). Inert unless HUB_SIDE_BY_SIDE lists lofty_write, the site's own
// Lofty path is in use (LOFTY_VIA_HUB not "on": with it on the site already goes through the hub), the hub is set up
// and this hour's cap allows it.
//   opts: { env, log, startedAt, fetch, limitMs }
function leadSideBySide(opts) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    const log = quietLog(o.log);
    if (!sideBySideOn("lofty_write", env, log)) return INERT;
    if (String(env.LOFTY_VIA_HUB || "").trim().toLowerCase() === "on") {
      warnOnce("lofty_write:via_hub", "Side-by-side lofty_write: LOFTY_VIA_HUB is on, so this site already goes through the hub; nothing to compare.", log);
      return INERT;
    }
    const problem = hubProblem(env);
    if (problem) { warnOnce("lofty_write:hub", `Side-by-side lofty_write is on but ${problem}; nothing asked.`, log); return INERT; }
    return makeLeadSide({ env, log, startedAt: o.startedAt || Date.now(), baseFetch: o.fetch || null, limitMs: o.limitMs || REQUEST_LIMIT_MS });
  } catch (err) {
    return INERT;
  }
}

function makeLeadSide(o) {
  const writes = [];
  const st = { capture: null, leadAsk: null, taskAsk: null, ctx: null, facts: null, taskDetails: null, taskAskedAt: null, done: false };
  const baseFetch = () => o.baseFetch || (st.capture ? st.capture.base : null) || ((u, i) => globalThis.fetch(u, i));
  const left = () => o.startedAt + o.limitMs - LIMIT_MARGIN_MS - Date.now();
  const askMs = () => Math.min(REQUEST_ASK_MS, left() - MIN_POST_MS);

  return {
    active: true,
    // Called with the push the site is about to make, before its own lookup and create.
    lead(input) {
      try {
        if (st.ctx) return;
        const i = input || {};
        const body = i.body || {};
        const formTags = Array.from(new Set((Array.isArray(body.tags) ? body.tags : []).map(String)));
        const email = Array.isArray(body.emails) ? body.emails[0] : body.email;
        const phone = Array.isArray(body.phones) ? body.phones[0] : body.phone;
        st.ctx = { formTags, email: email || null, phone: phone || null, addressAsked: !!i.property,
          submissionId: i.submissionId || null, askedTags: [] };
        if (!takeHourly(1, o.env, Date.now())) {
          warnOnce(`lofty_write:cap:${Math.floor(Date.now() / 3600000)}`, "Side-by-side lofty_write: this hour's HUB_SIDE_BY_SIDE_MAX is used; not asked.", o.log);
          st.ctx.capped = true;
          return;
        }
        st.capture = installCapture(writes);
        if (askMs() < 500) { st.leadAsk = Promise.resolve({ ok: false, reason: "skipped", at: Date.now() }); return; }
        const ask0 = buildLeadAsk(i, formTags);
        st.ctx.askedTags = ask0.tags;
        st.leadAsk = dryRunAsk("/v1/lofty/lead", (c) => c.loftyLead(ask0, { dryRun: true }), o.env, askMs(), baseFetch());
      } catch (err) { /* never in the way */ }
    },
    // Called once the site's own lookup has answered. A returning contact (found by email) gets the Call task: the
    // hub's dry run of the same task is asked now, before the site's own task goes out.
    lookedUp(existing, details) {
      try {
        if (!st.ctx || st.ctx.capped || st.taskAsk || !existing || !existing.leadId) return;
        if (!takeHourly(1, o.env, Date.now())) return;
        const content = String(require("./_lofty-returning").taskContent(details || {})).slice(0, 500);
        st.taskAskedAt = Date.now();
        if (askMs() < 500) { st.taskAsk = Promise.resolve({ ok: false, reason: "skipped", at: Date.now() }); return; }
        const t = { lead_id: String(existing.leadId), content, due_in_minutes: 30, push_reminder: true };
        st.taskAsk = dryRunAsk("/v1/lofty/task", (c) => c.loftyTask(t, { dryRun: true }), o.env, askMs(), baseFetch());
      } catch (err) { /* never in the way */ }
    },
    // What the site's own push came to: { held } | { failed } | { existing, newLeadId, leadId, provenNew }.
    own(facts) {
      try { if (!st.facts) st.facts = facts && typeof facts === "object" ? { ...facts } : null; } catch (err) { /* ignore */ }
    },
    // After the site has finished: restore fetch, compare, record. Never throws.
    async finish() {
      if (st.done) return { attempted: false };
      st.done = true;
      try {
        if (st.capture && globalThis.fetch === st.capture.wrapped) globalThis.fetch = st.capture.base;
      } catch (err) { /* ignore */ }
      try {
        if (!st.ctx || st.ctx.capped || !st.leadAsk) return { attempted: false };
        const rows = [];
        const leadAnswer = await st.leadAsk;
        const facts = st.facts || { failed: true };
        const ownRec = ownLeadRecord(writes, facts, st.ctx);
        const hubRec = hubLeadRecord(leadAnswer, st.ctx);
        const keyText = facts.existing && (facts.existing.leadId || facts.existing.phoneLeadId) ? `lofty:${facts.existing.leadId || facts.existing.phoneLeadId}`
          : facts.newLeadId ? `lofty:${facts.newLeadId}` : st.ctx.submissionId ? `submission:${st.ctx.submissionId}` : null;
        const key = keyText ? await keyFor(keyText) : null;
        let leadResult;
        if (ownRec.reason) leadResult = ownRec.reason;
        else if (hubRec.reason) leadResult = hubRec.reason;
        // The hub's lookup ran after this site's own create and found that very lead: not the same question.
        else if (ownRec.outcome === "created" && hubRec.outcome === "updated" && ownRec._leadId && hubRec.lead_id === String(ownRec._leadId)) leadResult = "skipped";
        else {
          const { _leadId, ...own } = ownRec;
          leadResult = compare(specFor(own, hubRec), own, hubRec);
        }
        rows.push(row("lofty_write", "lead", leadResult, key));
        if (st.taskAsk) {
          const taskAnswer = await st.taskAsk;
          if (taskAnswer.ok) taskAnswer.askedAt = st.taskAskedAt;
          const s = writesSummary(writes);
          const ownTask = facts.failed || facts.held ? { reason: "own_failed" } : taskRecordFrom(s);
          const hubTask = hubTaskRecord(taskAnswer);
          const taskResult = ownTask.reason || hubTask.reason ||
            compare(ownTask.outcome === "created" && hubTask.outcome === "created" ? SPEC_TASK : { outcome: "text", hold_reason: "text" }, ownTask, hubTask);
          rows.push(row("lofty_write", "task", taskResult, key));
        }
        const timeLeft = left();
        const kept = rows.filter(Boolean);
        o.log(describeRows("lofty_write", kept));
        if (timeLeft < MIN_POST_MS) {
          o.log(`Side-by-side lofty_write: ${kept.length} row(s) not recorded (no time left in this function).`);
          return { attempted: true, rows: kept.length, sent: 0 };
        }
        const posted = await recordRows(kept, { env: o.env, fetch: baseFetch(), timeoutMs: Math.min(REQUEST_ASK_MS, timeLeft) });
        if (posted.failed) o.log(`Side-by-side lofty_write: ${posted.failed} row(s) not recorded (${posted.reason}).`);
        return { attempted: true, rows: kept.length, sent: posted.sent };
      } catch (err) {
        try { o.log("Side-by-side lofty_write: the comparison failed and was dropped."); } catch (e) { /* ignore */ }
        return { attempted: true, error: true };
      }
    },
  };
}

// The hub's /v1/lofty/lead for this push, with dry_run: true (lib/_lofty-hub.js pushLeadViaHub's body, plus the
// parity options sellerintelligence docs/hub-parity.md lists for the websites): the person, the source, the form's
// tags (after the create, by read-merge-write), the same tags IN the create body except the trigger tag (create_tags:
// the site puts its tags in the create body so they start no "Tag Added" plan, then re-fires the trigger tag alone),
// the note, the plan's lead type (a create only), the home's address, the four website fields and the search wishes
// (both written by the hub only on a contact it created, as the site writes them only on a contact proven new).
function buildLeadAsk(input, formTags) {
  const i = input || {};
  const b = i.body || {};
  const clean = (t) => safe(() => kit().lofty.cleanTag(t), "");
  const tags = Array.from(new Set(formTags.map(clean).filter(Boolean))).slice(0, MAX_HUB_TAGS);
  const createTags = tags.filter((t) => t !== i.triggerTag);
  const email = Array.isArray(b.emails) ? b.emails[0] : b.email;
  const phone = Array.isArray(b.phones) ? b.phones[0] : b.phone;
  const plan = i.plan || {};
  const leadTypes = Array.isArray(plan.leadTypes) ? plan.leadTypes.filter((n) => Number.isInteger(n) && n > 0 && n < 100) : [];
  const out = {
    ...(b.firstName ? { first_name: String(b.firstName) } : {}),
    ...(b.lastName ? { last_name: String(b.lastName) } : {}),
    ...(email ? { email: String(email) } : {}),
    ...(phone ? { phone: String(phone) } : {}),
    ...(b.source ? { source: String(b.source) } : {}),
    tags,
    ...(typeof b.notes === "string" && b.notes.trim() ? { note: b.notes } : {}),
    ...(leadTypes.length ? { lead_types: leadTypes } : {}),
    create: true,
  };
  if (createTags.length) out.create_tags = createTags;
  const p = i.property;
  if (p && p.streetAddress) {
    out.address = { street: p.streetAddress, ...(p.city ? { city: p.city } : {}), ...(p.state ? { state: p.state } : {}), ...(p.zipCode ? { zip: p.zipCode } : {}) };
  }
  const returning = safe(() => require("./_lofty-returning"), null);
  if (returning && i.data) {
    const values = safe(() => returning.websiteFieldValues(i.label, i.data), []) || [];
    if (values.length) out.custom_fields = Object.fromEntries(values.map((f) => [f.attributeName, f.value]));
    const inquiry = safe(() => returning.inquiryFromForm(i.data), null);
    if (inquiry) out.inquiry = inquiry;
  }
  return out;
}

// ---- MLS reads: the scheduled sync's side-by-side ---------------------------------------------------------------

// The comparison rules for one listing: every field this site stores for it (lib/_mls-shared.js mapListing, then
// sync-listings.js slimForStorage), the hub's row put through the very same mapping (and keepStoredPhotos, as the
// hub mode does: the stored photo fields are kept, so they are the same by construction and not compared); plus the
// MLS's own photo count (stored photoCount against the hub's PhotosCount) when this site has one stored.
const SPEC_LISTING = Object.freeze({
  present: "bool", withheld: "bool", listing_key: "text", status: "text", price: "money", beds: "number", baths: "number",
  sqft: "number", address: "text", city: "text", state: "text", zip: "text", property_type: "text", subdivision: "text",
  waterfront: "bool", equestrian: "bool", agent_name: "text", co_agent_name: "text", remarks: "text", county: "text",
  mlg_can_view: "bool", photo_count: "number",
});
const SPEC_ON_MARKET = Object.freeze({ present: "bool", on_market: "bool", status: "text" });

function listingView(rec) {
  if (!rec) return {};
  return {
    present: true, listing_key: rec.listingKey, status: rec.status, price: rec.price, beds: rec.beds, baths: rec.baths,
    sqft: rec.sqft, address: rec.address, city: rec.city, state: rec.state, zip: rec.zip, property_type: rec.propertyType,
    subdivision: rec.subdivision, waterfront: rec.waterfront, equestrian: rec.equestrian, agent_name: rec.agentName,
    co_agent_name: rec.coAgentName, remarks: rec.remarks, county: rec.county, mlg_can_view: rec.mlgCanView,
  };
}

const sameId = (a, b) => {
  const n = (v) => String(v == null ? "" : v).trim().toUpperCase().replace(/^IRE/, "");
  return n(a) !== "" && n(a) === n(b);
};
const ownPhotoCount = (rec) => (rec && typeof rec.photoCount === "number" ? rec.photoCount
  : rec && Array.isArray(rec.photos) ? rec.photos.length : undefined);

// One listing: the stored record against the hub's row (null = not in the hub's answer). Only the same version of
// the record is compared: when the two ModificationTimestamps differ, one copy has not caught up (hub older:
// hub_not_ready; this site's older: skipped).
function compareListing(own, hubRow, toStored) {
  if (hubRow && hubRow._hub && hubRow._hub.withheld === true) return compare(SPEC_LISTING, { present: true }, { withheld: true });
  if (!hubRow) return compare(SPEC_LISTING, { present: true }, {});
  const hub = toStored(hubRow, own);
  const a = Date.parse(own.modificationTimestamp || "");
  const b = Date.parse((hub && hub.modificationTimestamp) || "");
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return b < a ? "hub_not_ready" : "skipped";
  const ownRec = listingView(own);
  const hubRec = listingView(hub);
  const count = ownPhotoCount(own);
  if (count !== undefined) { ownRec.photo_count = count; hubRec.photo_count = typeof hubRow.PhotosCount === "number" ? hubRow.PhotosCount : undefined; }
  return compare(SPEC_LISTING, ownRec, hubRec);
}

// "Is her Lofty listing on the market?": this site's own verdict against the one the hub's row gives, with the same
// rules (sync-listings.js makeOnMarketConfirmer, lib/_mls-hub.js hubOnMarket: a stored status and MlgCanView, a
// brand-new listing the MLS does not know yet is unknown).
function compareOnMarket(own, rows, statuses) {
  if (!own || own.verdict == null || own.verdict.onMarket == null) return "own_failed";
  const rec = rows.find((r) => r && sameId(r.ListingId, own.id));
  let hubOn;
  let hubStatus;
  if (!rec) {
    hubOn = false;
    const listed = own.listDate ? Date.parse(own.listDate) : NaN;
    if (Number.isFinite(listed) && Date.now() - listed < 7 * 24 * 60 * 60 * 1000) return "hub_not_ready";
  } else if (rec._hub && rec._hub.withheld === true) {
    hubOn = false;
  } else {
    hubStatus = String(rec.StandardStatus || "");
    hubOn = rec.MlgCanView !== false && statuses.includes(hubStatus);
  }
  const ownStatus = own.verdict.status || own.storedStatus || undefined;
  return compare(SPEC_ON_MARKET, { present: true, on_market: own.verdict.onMarket, status: ownStatus },
    { present: true, on_market: hubOn, status: ownStatus === undefined ? undefined : hubStatus });
}

const INERT_MLS = Object.freeze({
  active: false,
  wrapConfirmer(fn) { return fn; },
  finish: async () => ({ attempted: false }),
});

// The scheduled MLS sync's side-by-side (area mls_read): her Lofty listings' on-market verdicts and a sample of the
// stored MLS copy against the hub's copy, asked once, after the site's own runs. Inert unless HUB_SIDE_BY_SIDE lists
// mls_read, the site reads MLS Grid itself (not MLS_SOURCE=hub: then its copy IS the hub's) and the hub is set up.
//   opts: { env, log, startedAt, viaHub, fetch, limitMs }
function mlsSideBySide(opts) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    const log = quietLog(o.log);
    if (!sideBySideOn("mls_read", env, log)) return INERT_MLS;
    if (o.viaHub) {
      warnOnce("mls_read:via_hub", "Side-by-side mls_read: MLS_SOURCE is hub, so this site's copy is the hub's; nothing to compare.", log);
      return INERT_MLS;
    }
    const problem = hubProblem(env);
    if (problem) { warnOnce("mls_read:hub", `Side-by-side mls_read is on but ${problem}; nothing asked.`, log); return INERT_MLS; }
    return makeMlsSide({ env, log, startedAt: o.startedAt || Date.now(), baseFetch: o.fetch || null, limitMs: o.limitMs || SCHEDULED_LIMIT_MS });
  } catch (err) {
    return INERT_MLS;
  }
}

function makeMlsSide(o) {
  const verdicts = new Map();
  const left = () => o.startedAt + o.limitMs - LIMIT_MARGIN_MS - Date.now();
  let done = false;
  return {
    active: true,
    // Notes what the site's own confirmer answered for each listing, and hands that answer back as it is.
    wrapConfirmer(fn) {
      if (typeof fn !== "function") return fn;
      return async function confirmOnMarketSideBySide(listing) {
        const verdict = await fn(listing);
        try {
          const id = listing && listing.listingId;
          if (id && !verdicts.has(id)) verdicts.set(id, { id, verdict: verdict && typeof verdict === "object" ? { ...verdict } : { onMarket: verdict }, listDate: listing.listDate || null });
        } catch (err) { /* never in the way */ }
        return verdict;
      };
    },
    // h: { store, gridRan, listingsKey, mineKey, toStored, statuses }
    async finish(h) {
      if (done) return { attempted: false };
      done = true;
      try {
        const x = h || {};
        const max = sideBySideMax(o.env);
        const statuses = Array.isArray(x.statuses) ? x.statuses : [];
        if (left() < JOB_ASK_MS + 3000) {
          o.log("Side-by-side mls_read: not enough of this run's time left; skipped.");
          const rows = [row("mls_read", "listing", "skipped", null)].filter(Boolean);
          if (left() >= MIN_POST_MS + 1000) await recordRows(rows, { env: o.env, fetch: o.baseFetch, timeoutMs: Math.min(JOB_ASK_MS, left() - 500) });
          return { attempted: true, skipped: true };
        }
        // Her listings' verdicts first, then her stored listings, then a rotating slice of the rest of the copy.
        const onMarket = [...verdicts.values()].slice(0, max);
        let mine = [];
        let all = null;
        if (x.gridRan && x.store) {
          mine = await x.store.get(x.mineKey, { type: "json" }).catch(() => null);
          mine = Array.isArray(mine) ? mine.filter((l) => l && l.listingId) : [];
        }
        const room = Math.max(0, max - onMarket.length);
        const sample = mine.slice(0, room);
        if (x.gridRan && x.store && sample.length < room && left() >= JOB_ASK_MS + 6000) {
          all = await x.store.get(x.listingsKey, { type: "json" }).catch(() => null);
          const taken = new Set(sample.map((l) => l.listingId));
          const rest = all && typeof all === "object" ? Object.keys(all).filter((id) => !taken.has(id) && all[id]).sort() : [];
          const want = room - sample.length;
          if (rest.length && want > 0) {
            const start = (Math.floor(Date.now() / (30 * 60 * 1000)) * want) % rest.length;
            for (let i = 0; i < Math.min(want, rest.length); i++) sample.push(all[rest[(start + i) % rest.length]]);
          }
        }
        const mineById = new Map(mine.map((l) => [l.listingId, l]));
        for (const v of onMarket) { const m = mineById.get(v.id); if (m && m.status) v.storedStatus = m.status; }
        const ids = Array.from(new Set([...onMarket.map((v) => v.id), ...sample.map((l) => l.listingId)])).slice(0, 200);
        if (!ids.length) return { attempted: true, rows: 0 };
        const askMs = Math.min(JOB_ASK_MS, left() - 3000);
        const answer = askMs < 1000 ? { ok: false, reason: "skipped" }
          : await ask((c) => c.call("POST", "/v1/mls/search", { listing_ids: ids, limit: ids.length }), o.env, askMs, o.baseFetch);
        let failure = answer.ok ? null : answer.reason;
        let rowsIn = [];
        if (!failure) {
          const b = answer.body;
          if (b.status !== "ok" || !Array.isArray(b.rows)) failure = "hub_bad_answer";
          else if (!b.copy || b.copy.ready !== true) failure = "hub_not_ready";
          else rowsIn = b.rows.filter((r) => r && typeof r === "object");
        }
        const rows = [];
        for (const v of onMarket) {
          const key = await keyFor(`mls:${v.id}`);
          rows.push(row("mls_read", "on_market", failure || compareOnMarket(v, rowsIn, statuses), key));
        }
        for (const own of sample) {
          const key = await keyFor(`mls:${own.listingId}`);
          let result = failure;
          if (!result) {
            const hubRow = rowsIn.find((r) => sameId(r.ListingId, own.listingId)) || null;
            result = safe(() => compareListing(own, hubRow, x.toStored), "hub_bad_answer");
          }
          rows.push(row("mls_read", "listing", result, key));
        }
        const kept = rows.filter(Boolean);
        o.log(describeRows("mls_read", kept));
        const posted = await recordRows(kept, { env: o.env, fetch: o.baseFetch, timeoutMs: Math.min(JOB_ASK_MS, left()) });
        if (posted.failed) o.log(`Side-by-side mls_read: ${posted.failed} row(s) not recorded (${posted.reason}).`);
        return { attempted: true, rows: kept.length, sent: posted.sent };
      } catch (err) {
        try { o.log("Side-by-side mls_read: the comparison failed and was dropped."); } catch (e) { /* ignore */ }
        return { attempted: true, error: true };
      }
    },
  };
}

// ---- Town figures: the scheduled job's side-by-side ------------------------------------------------------------

// The figures the town pages print, per town: homes for sale, the median asking price and the price per square foot
// (build/data/town_market.json) against the hub's GET /v1/market/towns (the same schema). A town on one side only is
// `present` own_only / hub_only. Figures from different days are not compared (hub older: hub_not_ready; this
// site's older: skipped).
const SPEC_TOWN = Object.freeze({ present: "bool", active: "number", median_list: "money", median_price_per_sqft: "number" });
const townView = (t) => (t && typeof t === "object" ? { present: true, active: t.active, median_list: t.median_list,
  median_price_per_sqft: t.median_price_per_sqft } : {});

// own / hub: the two files (hub may be a failure reason string). -> rows (at most max, rotating by day).
async function townRows(own, hub, max, now) {
  const ownTowns = own && own.towns && typeof own.towns === "object" ? own.towns : {};
  const hubTowns = hub && typeof hub === "object" && hub.towns && typeof hub.towns === "object" ? hub.towns : null;
  const names = Array.from(new Set([...Object.keys(ownTowns), ...Object.keys(hubTowns || {})])).sort();
  if (!names.length) return [];
  const n = Math.min(max, names.length);
  const start = (Math.floor((now || Date.now()) / 86400000) * n) % names.length;
  const picked = [];
  for (let i = 0; i < n; i++) picked.push(names[(start + i) % names.length]);
  let reason = typeof hub === "string" ? hub : hubTowns ? null : "hub_bad_answer";
  if (!reason) {
    const a = String(own && own.generated_at || "");
    const b = String(hub.generated_at || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b) && a !== b) reason = b < a ? "hub_not_ready" : "skipped";
  }
  const rows = [];
  for (const name of picked) {
    const key = await keyFor(`town:${name.toLowerCase()}`);
    rows.push(row("mls_read", "town_market", reason || compare(SPEC_TOWN, townView(ownTowns[name]), townView(hubTowns[name])), key));
  }
  return rows.filter(Boolean);
}

// The scheduled job's run: read this site's town figures (a file path) and the hub's, compare, record. Never throws.
//   opts: { env, log, ownFile, fetch, readFile }
async function townSideBySide(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const log = quietLog(o.log);
  try {
    if (!sideBySideOn("mls_read", env, log)) return { attempted: false, reason: "off" };
    const problem = hubProblem(env);
    if (problem) { log(`Side-by-side town figures: mls_read is on but ${problem}; nothing asked.`); return { attempted: false, reason: problem }; }
    let own = null;
    try { own = JSON.parse((o.readFile || ((p) => require("fs").readFileSync(p, "utf8")))(o.ownFile)); } catch (err) { own = null; }
    if (!own || !own.towns) { log("Side-by-side town figures: this site's town figures could not be read; nothing compared."); return { attempted: false, reason: "own_failed" }; }
    const answer = await ask((c) => c.call("GET", "/v1/market/towns"), env, JOB_ASK_MS, o.fetch);
    const rows = await townRows(own, answer.ok ? answer.body : answer.reason, sideBySideMax(env), o.now);
    log(describeRows("town figures", rows));
    const posted = await recordRows(rows, { env, fetch: o.fetch, timeoutMs: JOB_ASK_MS });
    if (posted.failed) log(`Side-by-side town figures: ${posted.failed} row(s) not recorded (${posted.reason}).`);
    return { attempted: true, rows: rows.length, sent: posted.sent };
  } catch (err) {
    try { log("Side-by-side town figures: the comparison failed and was dropped."); } catch (e) { /* ignore */ }
    return { attempted: true, error: true };
  }
}

module.exports = {
  AREAS,
  DEFAULT_MAX,
  MAX_MAX,
  REQUEST_ASK_MS,
  JOB_ASK_MS,
  RECORD_PATH,
  sideBySideAreas,
  sideBySideOn,
  sideBySideMax,
  leadSideBySide,
  mlsSideBySide,
  townSideBySide,
  recordRows,
  // For tests.
  _internal: {
    buildLeadAsk, classifyWrite, writesSummary, ownLeadRecord, hubLeadRecord, taskRecordFrom, hubTaskRecord, specFor,
    compareListing, compareOnMarket, townRows, reasonFor, resetHourly, resetWarnings: () => warned.clear(),
    resetDryRunProbes: () => dryRunProbes.clear(), dryRunReady,
    SPEC_CREATED, SPEC_UPDATED, SPEC_LISTING, SPEC_TOWN,
  },
};
