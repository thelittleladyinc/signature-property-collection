// The side-by-side check with the hub (2026-10-23, lib/_hub-side-by-side.js, docs/hub-side-by-side.md), the form
// handler's half (lofty_write) and the town figures (mls_read, build/tools/hub-side-by-side-towns.js). This pins:
//
//   1. the settings: HUB_SIDE_BY_SIDE (a comma list, trimmed, any case; unset / empty / unknown = off; an unknown
//      entry ignored and logged once by name) and HUB_SIDE_BY_SIDE_MAX (default 20, at most 200);
//   2. off = no side-by-side hub call at all, nothing wrapped, and byte-identical behaviour;
//   3. on, the site's own Lofty calls, its answer, its stored records and its alert email are exactly what they are
//      with it off -- with the hub agreeing, differing, and failing in every way (down, slow, 401, 403, 429, 500,
//      503 off, 503 not ready, not JSON, not a dry run, rate limited), and when the ledger post fails;
//   4. the hub agreeing gives `same` rows; differing gives the right field names (own_only / different / hub_only);
//      every failure gives not_compared with the matching reason; the race (the hub found the lead this site had
//      just created) is `skipped`; the per-hour cap; too little time left = `skipped`;
//   5. the hub is only ever asked with dry_run: true, and no row or log line carries a name, email, phone, address
//      or note text;
//   6. the town figures: per town and figure, a different slice a day, the tool always exits 0;
//   7. the shared file and the tool are byte-identical to the other site's, the docs and CLAUDE.md say it is off.
//
// The same file runs in both repos. Nothing here touches the network.
"use strict";
process.exitCode = 1;
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const SIBLING = path.basename(ROOT) === "signature-property-collection" ? "thelittleladysellshomes" : "signature-property-collection";
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const kit = require(`${FN_DIR}/lib/suite-kit/index.js`);
const HUB_URL = "https://hub.example.test/functions/v1/hub-api";
const HUB_KEY = `hub_${"0".repeat(64)}`; // the shape of a hub key; not a real one
const PERSON = { name: "Pat Quimby", email: "pat.quimby@example.com", phone: "(970) 555-0123" };
const PRIVATE = ["Pat", "Quimby", "pat.quimby", "example.com", "555-0123", "5550123", "9705550123", "Elm Street", "4821 Elm", "Loveland, CO 80537"];
const QUIET = { info: () => {}, warn: () => {} };

const res = (status, body) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
};

// ---- An in-memory Lofty (this site's own, and a snapshot of it for the fake hub's dry run) -------------------
function fakeLofty(seed, opts) {
  const o = opts || {};
  const leads = new Map((seed || []).map((l) => [l.leadId, JSON.parse(JSON.stringify(l))]));
  let nextId = o.nextId || 9000;
  const ten = (v) => String(v && typeof v === "object" ? (v.phone || v.value) : (v == null ? "" : v)).replace(/\D/g, "").slice(-10);
  const emailsOf = (l) => [].concat(l.emails || [], l.email || []).map((e) => String(typeof e === "object" ? e.email || e.value : e).toLowerCase());
  const phonesOf = (l) => [].concat(l.phones || [], l.phone || []).map(ten);
  async function fetch(url, init) {
    const u = new URL(url);
    const method = (init && init.method) || "GET";
    const p = u.pathname.replace(/^\/v1\.0/, "");
    let body;
    try { body = init && init.body ? JSON.parse(init.body) : undefined; } catch (e) { body = undefined; }
    const one = p.match(/^\/leads\/(\d+)$/);
    if (method === "GET" && p === "/leads") {
      const email = (u.searchParams.get("email") || "").toLowerCase();
      const phone = ten(u.searchParams.get("phone"));
      return res(200, { leads: [...leads.values()].filter((l) => (email && emailsOf(l).includes(email)) || (phone && phonesOf(l).includes(phone))).slice(0, 5) });
    }
    if (method === "GET" && one) {
      const l = leads.get(Number(one[1]));
      return l ? res(200, { lead: l }) : res(404, { message: "errorCode=20006,errorMsg=Lead not exist" });
    }
    if (method === "PUT" && one) {
      const l = leads.get(Number(one[1]));
      if (!l) return res(404, { message: "not found" });
      Object.assign(l, body);
      return res(200, { lead: l });
    }
    if (method === "POST" && p === "/leads") {
      if (o.createFails) return res(500, { message: "Lofty is having a moment" });
      const id = nextId++;
      leads.set(id, { leadId: id, ...body, tags: Array.isArray(body.tags) ? body.tags : [] });
      return res(200, { leadId: id });
    }
    if (method === "POST" && p === "/notes") return res(200, { noteId: 1 });
    if (/\/v2\.0\/tasks$/.test(u.pathname)) return res(200, { taskId: 77 });
    if (/send-task-reminder$/.test(u.pathname)) return res(200, { message: "ok" });
    if (/listCustomField$/.test(u.pathname)) return res(200, { data: [] });
    if (/custom-field$/.test(u.pathname)) return res(200, {});
    if (/\/inquiry$/.test(u.pathname)) return res(200, {});
    return res(404, { message: `unknown route ${method} ${p}` });
  }
  return { fetch, leads };
}

// ---- A fake hub. The Lofty dry runs are answered by the VENDORED toolkit's own pushLead with a plan (the code the
// hub runs: every read as for real, every write planned), against a snapshot of this site's Lofty taken when the
// question arrives; or by echoing the writes this site made in a run with the check off ("agree"); or by failing. --
let OWN = fakeLofty();
const HUB = { mode: "toolkit", asks: [], rows: [], recordFails: null, echo: null, tweak: null, other: [] };
function statusOf(o) { return o.ok ? (o.action === "created" ? "created" : "updated") : o.code === "rate_limited" ? "rate_limited" : "held"; }

async function toolkitLead(b) {
  const snap = fakeLofty([...OWN.leads.values()], { nextId: 99000 });
  const plan = kit.createLoftyPlan();
  const deps = { apiKey: "hub-side-test-key", fetch: snap.fetch, log: QUIET, plan, allowTextingOn: false };
  const out = await kit.pushLead({
    lead: { firstName: b.first_name || "", lastName: b.last_name || "", email: b.email, phone: b.phone,
      source: b.source ? String(b.source).slice(0, 100) : undefined, leadTypes: b.lead_types,
      ...(b.address ? { property: { streetAddress: b.address.street, city: b.address.city, state: b.address.state, zipCode: b.address.zip } } : {}) },
    tags: b.tags, note: b.note, smsConsent: false, create: b.create !== false, createTags: b.create_tags,
  }, deps);
  if (out.ok && out.action === "created" && !out.merged) {
    if (b.custom_fields) {
      await kit.loftyRequestText("GET", "/v1.0/teamFeatures/listCustomField", undefined, deps);
      for (const n of Object.keys(b.custom_fields)) await kit.loftyRequest("POST", "/v1.0/teamFeatures/custom-field", { attributeName: n, attributeType: "text", value: "" }, deps);
      await kit.loftyRequest("PUT", `/leads/${out.leadId}`, { customAttributeList: Object.entries(b.custom_fields).map(([attributeName, value]) => ({ attributeName, attributeType: "text", value })) }, deps);
    }
    if (b.inquiry) await kit.loftyRequest("POST", `/leads/${out.leadId}/inquiry`, b.inquiry, deps);
  }
  return kit.withPlannedIds({ status: statusOf(out), ok: out.ok, action: out.action, lead_id: out.leadId, matched_by: out.matchedBy || null,
    tags_added: out.tagsAdded, tags_held: out.tagsHeld || [], tags_dropped: [], code: out.code || null, needs_review: out.needsReview === true,
    note_added: out.noteAdded, merged: false, held_by: null, dry_run: true, planned: kit.plannedRequests(plan), needs_flags: ["lofty_doorway_writes_enabled"] });
}

function toolkitTask(b) {
  const plan = kit.createLoftyPlan();
  const raw = JSON.stringify({ type: "Call", content: b.content, assignedRole: "Agent",
    endAt: new Date(Date.now() + b.due_in_minutes * 60000).toISOString(), timeZoneCode: "America/Denver", leadId: "__ID__" }).replace('"__ID__"', b.lead_id);
  kit.planRequest(plan, "POST", "/v2.0/tasks", raw);
  kit.planRequest(plan, "POST", "/v2.0/sales-agent/notification/app-push/send-task-reminder", JSON.stringify({ type: "TASK", taskId: 9007199254740990 }));
  return kit.withPlannedIds({ status: "created", lead_id: b.lead_id, task_id: "9007199254740990", pushed: true, dry_run: true, planned: kit.plannedRequests(plan), needs_flags: [] });
}

// "agree": the writes this site made with the check off, as the hub's plan (the new lead's id as the stand-in).
function echoAnswer(route) {
  const e = HUB.echo;
  const planned = e.writes.filter((w) => (route === "/v1/lofty/task" ? /tasks$|send-task-reminder$/.test(w.path) : !/tasks$|send-task-reminder$/.test(w.path)))
    .map((w) => ({ method: w.method, path: e.newId ? w.path.replace(`/${e.newId}`, "/{new_lead_id}") : w.path, body: typeof w.raw === "string" && /tasks$|reminder$/.test(w.path) ? w.raw : w.body }));
  if (route === "/v1/lofty/task") return { status: "created", lead_id: e.leadId, dry_run: true, planned, needs_flags: [] };
  return { status: e.action === "created" ? "created" : "updated", ok: true, action: e.action, lead_id: e.action === "created" ? "{new_lead_id}" : e.leadId,
    matched_by: e.matchedBy || null, tags_added: [], tags_held: [], tags_dropped: [], dry_run: true, planned, needs_flags: [], code: null };
}

async function hubHandle(url, init) {
  const route = new URL(url).pathname.replace(/^\/functions\/v1\/hub-api/, "");
  if (!init.headers || init.headers["x-hub-key"] !== HUB_KEY) return res(401, { error: "unknown key" });
  if (init.redirect !== "error" && init.redirect !== "manual") return res(400, { error: "the client must refuse redirects" });
  const b = init.body ? JSON.parse(init.body) : {};
  if (route === "/v1/parity/record") {
    if (HUB.recordFails === "throw") throw new TypeError("fetch failed");
    if (HUB.recordFails) return res(HUB.recordFails, { status: "off", error: "the side-by-side check is switched off (flag parity_compare_enabled)" });
    HUB.rows.push(...b.rows);
    return res(200, { status: "ok", recorded: b.rows.length });
  }
  if (route === "/v1/lofty/lead" || route === "/v1/lofty/task" || route === "/v1/lofty/note") {
    HUB.asks.push({ route, body: b });
    const m = HUB.mode;
    if (m === "throw") throw new TypeError("fetch failed");
    if (m === "hang") {
      return new Promise((resolve, reject) => {
        if (init.signal) init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    }
    if (typeof m === "number") return res(m, { error: m === 503 ? "dry runs are switched off at the hub (flag lofty_dry_run_enabled); nothing read or sent" : "refused" });
    if (m === "not_ready") return res(503, { status: "not_ready", error: "not ready" });
    if (m === "html") return { ok: true, status: 200, headers: { get: () => null }, text: async () => "<html>gateway</html>" };
    if (m === "not_dry") return res(200, { status: "created", ok: true, action: "created", lead_id: "1" });
    if (m === "rate_limited") return res(200, { status: "rate_limited", dry_run: true, planned: [], code: "rate_limited" });
    let answer = m === "agree" ? echoAnswer(route) : route === "/v1/lofty/task" ? toolkitTask(b) : await toolkitLead(b);
    if (HUB.tweak) answer = HUB.tweak(route, answer, b) || answer;
    return res(200, answer);
  }
  HUB.other.push({ route, body: init.body || "" });
  if (route === "/v1/email/send") return res(200, { status: "sent", provider_id: "e1" });
  return res(404, { error: `unknown route ${route}` });
}

// ---- The site, with Blobs in memory and every request routed to the fake hub or this site's own Lofty ----------
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
const mem = {};
const store = {
  get: async (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : null),
  setJSON: async (k, v, o) => {
    if (o && o.onlyIfNew && k in mem) return { modified: false };
    mem[k] = JSON.parse(JSON.stringify(v));
    return { modified: true };
  },
  delete: async (k) => { delete mem[k]; },
  list: async () => ({ blobs: [] }),
};
require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => store } };
for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];

const ENV_KEYS = ["LOFTY_VIA_HUB", "LEADS_TO_ROUTER", "LOFTY_API_KEY", "HUB_API_URL", "HUB_API_KEY", "LEAD_ALERT_TO", "LEAD_ALERT_FROM",
  "FLODESK_API_KEY", "LOFTY_QUEUE_DRAIN", "HUB_SIDE_BY_SIDE", "HUB_SIDE_BY_SIDE_MAX", "WEBSITE_TO_HUB_INTAKE", "VALUE_REVIEW_PLAN"];
function env(extra) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { LOFTY_API_KEY: "own-key-for-tests", HUB_API_URL: HUB_URL, HUB_API_KEY: HUB_KEY }, extra || {});
}
env();

let ownCalls = [];
const testFetch = async (url, init) => {
  const s = String(url);
  const i = init || {};
  if (s.startsWith("https://hub.example.test/")) return hubHandle(s, i);
  if (s.startsWith("https://api.lofty.com/")) {
    const u = new URL(s);
    ownCalls.push({ method: i.method || "GET", path: u.pathname + u.search, raw: typeof i.body === "string" ? i.body : null });
    return OWN.fetch(s, i);
  }
  throw new Error(`unexpected request ${s.slice(0, 40)}`);
};
global.fetch = testFetch;

const S = require(`${FN_DIR}/lib/_hub-side-by-side.js`);
const handler = require(`${FN_DIR}/submission-created.js`).handler;

const lines = [];
async function quiet(fn) {
  const keep = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...a) => lines.push(a.map(String).join(" "));
  try { return await fn(); } finally { [console.log, console.warn, console.error] = keep; }
}
const event = (form, data, id) => ({ body: JSON.stringify({ payload: { form_name: form, data, id: id || "sub-0001" } }) });

// The scenarios, each run on a fresh Lofty and fresh Blobs.
const RETURNING = () => [{ leadId: 4242, firstName: "Pat", lastName: "Quimby", emails: [PERSON.email], phones: ["9705550199"], tags: [{ tagName: "Old Tag" }], cannotText: true }];
const TWINS = () => [
  { leadId: 4242, firstName: "Pat", emails: [PERSON.email], phones: [], tags: [] },
  { leadId: 4343, firstName: "Pat", emails: [PERSON.email], phones: [], tags: [] },
];
const SCENARIOS = {
  newHome: { form: "free-home-valuation", seed: () => [], data: { ...PERSON, address: "4821 Elm Street, Loveland, CO 80537",
    attribution_first_page: "/a.html", attribution_form_page: "/b.html", attribution_source: "google" } },
  newAlert: { form: "listing-alert-request", seed: () => [], data: { ...PERSON, alert_criteria: "Loveland, 3+ beds", alert_query: "city=Loveland&minPrice=400000&beds=3" } },
  returning: { form: "contact", seed: RETURNING, data: { ...PERSON, message: "Call me about 4821 Elm Street" } },
  held: { form: "contact", seed: TWINS, data: { ...PERSON, message: "hello" } },
  pushFails: { form: "contact", seed: () => [], data: { ...PERSON, message: "hello" }, lofty: { createFails: true } },
};

const STAMP_RE = /\([A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M MT\)/g;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
const MDT_RE = /[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M MT/g;
const norm = (v) => JSON.stringify(v).replace(STAMP_RE, "(STAMP)").replace(MDT_RE, "STAMP").replace(ISO_RE, "TS");

async function run(name, extraEnv) {
  const sc = SCENARIOS[name];
  env(extraEnv);
  OWN = fakeLofty(sc.seed(), sc.lofty);
  ownCalls = [];
  HUB.asks = []; HUB.rows = []; HUB.other = [];
  for (const k of Object.keys(mem)) delete mem[k];
  S._internal.resetHourly();
  const before = global.fetch;
  const startLines = lines.length;
  const result = await quiet(() => handler(event(sc.form, sc.data, `sub-${name}`)));
  return {
    result, fetchRestored: global.fetch === before,
    own: norm(ownCalls), blobs: norm(Object.keys(mem).sort().map((k) => [k, mem[k]])), email: norm(HUB.other),
    asks: HUB.asks.slice(), rows: HUB.rows.slice(), log: lines.slice(startLines),
    writes: ownCalls.filter((c) => c.method !== "GET").map((c) => {
      let body = null;
      try { body = c.raw ? JSON.parse(c.raw) : null; } catch (e) { body = null; }
      return { method: c.method, path: c.path, body, raw: c.raw };
    }),
    leadIds: [...OWN.leads.keys()],
  };
}
const sameAs = (a, b) => a.own === b.own && a.blobs === b.blobs && a.email === b.email && JSON.stringify(a.result) === JSON.stringify(b.result) && a.fetchRestored && b.fetchRestored;
const why = (a, b) => [a.own === b.own ? "" : "Lofty calls differ", a.blobs === b.blobs ? "" : "stored records differ", a.email === b.email ? "" : "alert email differs",
  JSON.stringify(a.result) === JSON.stringify(b.result) ? "" : `result ${JSON.stringify(a.result)} vs ${JSON.stringify(b.result)}`, a.fetchRestored && b.fetchRestored ? "" : "fetch not restored"].filter(Boolean).join("; ");
const leaks = (text) => PRIVATE.filter((p) => text.includes(p));
const ON = { HUB_SIDE_BY_SIDE: "lofty_write", HUB_SIDE_BY_SIDE_MAX: "200" };

(async () => {
  // ------------------------------------------------------------------------------------------------------------
  console.log("\n1. The settings");
  const logs = [];
  const say = (m) => logs.push(m);
  S._internal.resetWarnings();
  for (const v of [undefined, "", "  ", "off", "on", "true", "LOFTY", "lofty write", ",,"]) {
    check(`HUB_SIDE_BY_SIDE=${JSON.stringify(v)} switches nothing on`, S.sideBySideAreas({ HUB_SIDE_BY_SIDE: v }, say).size === 0);
  }
  const a = S.sideBySideAreas({ HUB_SIDE_BY_SIDE: " Lofty_Write , MLS_READ,bogus, bogus ,rentcast" }, say);
  check("a comma list, trimmed, any case: the known areas only", [...a].sort().join() === "lofty_write,mls_read,rentcast", [...a].join());
  S.sideBySideAreas({ HUB_SIDE_BY_SIDE: "bogus" }, say);
  check("an unknown entry is logged once, by name", logs.filter((l) => /"bogus" is not an area/.test(l)).length === 1, logs.join(" | "));
  check("...and an entry that is not a name is not echoed", (S.sideBySideAreas({ HUB_SIDE_BY_SIDE: "x@y.com" }, say), !logs.join(" ").includes("x@y.com")));
  for (const [v, n] of [[undefined, 20], ["", 20], ["abc", 20], ["0", 20], ["-5", 20], ["7", 7], [" 50 ", 50], ["200", 200], ["201", 200], ["99999", 200]]) {
    check(`HUB_SIDE_BY_SIDE_MAX=${JSON.stringify(v)} is ${n}`, S.sideBySideMax({ HUB_SIDE_BY_SIDE_MAX: v }) === n);
  }

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n2. Off: no side-by-side hub call at all, nothing wrapped");
  const base = {};
  for (const name of Object.keys(SCENARIOS)) {
    base[name] = await run(name, {});
    check(`${name}, switch unset: no dry run asked, no ledger row, fetch untouched`, base[name].asks.length === 0 && base[name].rows.length === 0 &&
      base[name].fetchRestored && !base[name].log.some((l) => /Side-by-side/.test(l)));
  }
  check("the scenarios do what they are meant to (new contact created, returning one tasked, twins held, a failed push queued)",
    base.newHome.writes.some((w) => w.path === "/v1.0/leads") && base.returning.writes.some((w) => w.path === "/v2.0/tasks") &&
    !base.held.writes.some((w) => w.path === "/v1.0/leads") && /lofty push failed/.test(base.pushFails.result.body));
  for (const v of ["off", "lofty_read,rentcast", "LOFTY-WRITE"]) {
    const r = await run("newHome", { HUB_SIDE_BY_SIDE: v });
    check(`HUB_SIDE_BY_SIDE=${JSON.stringify(v)}: byte-identical to unset, no dry run`, sameAs(r, base.newHome) && r.asks.length === 0, why(r, base.newHome));
  }
  const viaHub = await run("newHome", { ...ON, LOFTY_VIA_HUB: "on" });
  check("with LOFTY_VIA_HUB=on the site already goes through the hub: no dry run is asked", !viaHub.asks.some((q) => q.body.dry_run === true) && viaHub.rows.length === 0);
  env({ HUB_SIDE_BY_SIDE: "lofty_write", HUB_API_URL: "", HUB_API_KEY: "" });
  const inert = S.leadSideBySide({ log: () => {} });
  check("on but without the hub settings: inert", inert.active === false);

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n3. On, the hub agreeing: identical behaviour, `same` rows, dry runs only");
  for (const name of ["newHome", "newAlert", "returning"]) {
    const b = base[name];
    const newId = b.leadIds.find((id) => id >= 9000) || null;
    HUB.mode = "agree";
    HUB.echo = { writes: b.writes, newId, action: name === "returning" ? "updated" : "created", leadId: name === "returning" ? "4242" : null,
      matchedBy: name === "returning" ? "email" : null };
    const r = await run(name, ON);
    check(`${name}: the site's own Lofty calls, answer, stored records and alert email are byte-identical`, sameAs(r, b), why(r, b));
    const ops = r.rows.map((x) => `${x.op}:${x.outcome}`).sort().join();
    check(`${name}: ${name === "returning" ? "lead and task rows" : "one lead row"}, all same`,
      ops === (name === "returning" ? "lead:same,task:same" : "lead:same"), JSON.stringify(r.rows));
    check(`${name}: every hub question was a dry run`, r.asks.length > 0 && r.asks.every((q) => q.body.dry_run === true), JSON.stringify(r.asks.map((q) => q.route)));
    check(`${name}: rows carry a key from parityKey and no value`, r.rows.every((x) => /^k[0-9a-f]{16}$/.test(x.key)) && !leaks(JSON.stringify(r.rows)).length);
  }

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n4. On, the hub as it really plans (the toolkit's dry run): the differences it finds, by name");
  HUB.mode = "toolkit"; HUB.tweak = null;
  const real = await run("newHome", ON);
  check("the site's own behaviour is byte-identical", sameAs(real, base.newHome), why(real, base.newHome));
  const ask0 = real.asks.find((q) => q.route === "/v1/lofty/lead").body;
  check("the hub is asked the site's push: the person, source, the form's tags, the note, the plan's lead type, create",
    ask0.email === PERSON.email && ask0.first_name === "Pat" && ask0.create === true && Array.isArray(ask0.tags) && ask0.tags.includes("Hot Lead - Website") &&
    typeof ask0.note === "string" && Array.isArray(ask0.lead_types) && ask0.lead_types.length === 1, JSON.stringify(Object.keys(ask0)));
  check("...the tags in the create body without the trigger tag (so 'Hot Lead - Website' fires after the create, as the site re-fires it)",
    Array.isArray(ask0.create_tags) && !ask0.create_tags.includes("Hot Lead - Website") && ask0.create_tags.length === ask0.tags.length - 1);
  check("...the home's address, the website fields and nothing the form does not carry",
    ask0.address && ask0.address.street === "4821 Elm Street" && ask0.address.zip === "80537" && ask0.custom_fields && ask0.custom_fields["Website Form"] && !ask0.inquiry);
  const lr = real.rows.find((x) => x.op === "lead");
  check("the lead row names the note the site puts in its create body as one the hub would lose (create.notes, own_only)",
    lr && lr.outcome === "different" && lr.own_only.includes("create.notes"), JSON.stringify(lr));
  check("...and agrees on the tags the lead ends with and the ones that fire, the note, the address and the website fields",
    lr && !["tags_on_lead", "tags_fired", "note", "create.property.street", "fields.website_form", "create.source", "create.emails", "create.phones"]
      .some((f) => lr.different.includes(f) || lr.own_only.includes(f) || lr.hub_only.includes(f)), JSON.stringify(lr));
  const alert = await run("newAlert", ON);
  const ar = alert.rows.find((x) => x.op === "lead");
  check("the listing-alert form: the search wishes go with it and are the same", alert.asks[0].body.inquiry && ar && !ar.different.includes("inquiry") && !ar.own_only.includes("inquiry"), JSON.stringify(ar));
  const ret = await run("returning", ON);
  check("a returning contact: the lead row compares the same lead, found the same way", ret.rows.find((x) => x.op === "lead") &&
    !ret.rows.find((x) => x.op === "lead").different.includes("lead_id"), JSON.stringify(ret.rows));

  // Differences planted in the hub's answer come back as the right field names, and never as values.
  HUB.tweak = (route, answer) => {
    if (route !== "/v1/lofty/lead") return answer;
    const planned = answer.planned.map((p) => {
      if (p.method === "POST" && p.path === "/v1.0/leads") {
        const body = { ...p.body, source: undefined, firstName: "Patricia", assignedUserId: 12345 };
        delete body.source;
        return { ...p, body };
      }
      if (p.method === "POST" && p.path === "/v1.0/notes") return { ...p, body: { ...p.body, content: `${p.body.content} (edited by the hub)` } };
      return p;
    });
    return { ...answer, planned };
  };
  const diff = await run("newHome", ON);
  const dr = diff.rows.find((x) => x.op === "lead");
  check("the site's own behaviour is byte-identical even so", sameAs(diff, base.newHome), why(diff, base.newHome));
  check("a field the hub drops is own_only (create.source)", dr && dr.own_only.includes("create.source"), JSON.stringify(dr));
  check("a field that differs is different (create.first_name, note)", dr && dr.different.includes("create.first_name") && dr.different.includes("note"), JSON.stringify(dr));
  check("a field only the hub sends is hub_only (create.assigned_user)", dr && dr.hub_only.includes("create.assigned_user"), JSON.stringify(dr));
  check("no value reaches a row or a log line (names, email, phone, address, note text)",
    !leaks(JSON.stringify(diff.rows)).length && !leaks(diff.log.join("\n")).length && !/Patricia|edited by the hub|12345/.test(JSON.stringify(diff.rows) + diff.log.join("\n")),
    `${leaks(JSON.stringify(diff.rows))} ${leaks(diff.log.join("\n"))}`);
  check("the log line names the fields, nothing else", diff.log.some((l) => /^Side-by-side lofty_write: 1 different; fields: .*create\.source \(own_only\)/.test(l)), diff.log.join(" | "));

  // The hub's lookup ran after this site's create and found that very lead: not the same question.
  HUB.tweak = (route, answer) => (route === "/v1/lofty/lead" ? { ...answer, status: "updated", action: "existing", lead_id: "9000", matched_by: "email" } : answer);
  const race = await run("newHome", ON);
  check("the hub finding the lead this site had just created is skipped, not a difference",
    race.rows.length === 1 && race.rows[0].outcome === "not_compared" && race.rows[0].reason === "skipped", JSON.stringify(race.rows));
  HUB.tweak = (route, answer) => (route === "/v1/lofty/task" ? { status: "held", code: "do_not_contact", reason: "Do Not Contact: no task", dry_run: true, planned: [], needs_flags: [] } : answer);
  const dnc = await run("returning", ON);
  const tr = dnc.rows.find((x) => x.op === "task");
  check("a Call task the hub would hold (Do Not Contact) and the site sends: the outcome differs", tr && tr.outcome === "different" && tr.different.includes("outcome"), JSON.stringify(tr));
  HUB.tweak = null;
  const held = await run("held", ON);
  check("both sides holding the same lead (two leads with one email): same", held.rows.length === 1 && held.rows[0].outcome === "same", JSON.stringify(held.rows));
  const failed = await run("pushFails", ON);
  check("the site's own push failing (queued): not compared, own_failed, behaviour unchanged",
    failed.rows.length === 1 && failed.rows[0].reason === "own_failed" && sameAs(failed, base.pushFails), why(failed, base.pushFails));

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n5. On, the hub failing in every way: the site's own path is unchanged, not_compared with the reason");
  const FAILS = [
    ["throw", "hub_unreachable"], [401, "hub_refused"], [403, "hub_refused"], [429, "hub_refused"], [500, "hub_refused"],
    [503, "hub_off"], ["not_ready", "hub_not_ready"], ["html", "hub_bad_answer"], ["not_dry", "hub_bad_answer"], ["rate_limited", "hub_refused"],
  ];
  for (const [mode, reason] of FAILS) {
    HUB.mode = mode;
    for (const name of ["newHome", "returning"]) {
      const r = await run(name, ON);
      check(`hub ${mode}, ${name}: the site's own path is byte-identical, rows not_compared ${reason}`,
        sameAs(r, base[name]) && r.rows.length >= 1 && r.rows.every((x) => x.outcome === "not_compared" && x.reason === reason),
        `${why(r, base[name])} ${JSON.stringify(r.rows)}`);
    }
  }
  HUB.mode = "hang";
  const t0 = Date.now();
  // AbortSignal.timeout's timer does not keep Node running on its own (a Netlify function's runtime does).
  const keepAlive = setInterval(() => {}, 250);
  const slow = await run("newHome", ON);
  clearInterval(keepAlive);
  const took = Date.now() - t0;
  check("a hub that never answers: hub_timeout after its own 3 s, and the site's own path is byte-identical",
    sameAs(slow, base.newHome) && slow.rows.length === 1 && slow.rows[0].reason === "hub_timeout" && took < 6000, `${took} ms ${why(slow, base.newHome)} ${JSON.stringify(slow.rows)}`);
  HUB.mode = "toolkit";
  for (const f of [503, "throw"]) {
    HUB.recordFails = f;
    const r = await run("newHome", ON);
    check(`the ledger post failing (${f}): logged as a count, never retried, the site's own path byte-identical`,
      sameAs(r, base.newHome) && r.log.some((l) => /1 row\(s\) not recorded/.test(l)), `${why(r, base.newHome)} ${r.log.filter((l) => /Side/.test(l)).join(" | ")}`);
  }
  HUB.recordFails = null;

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n6. The cap and the time limit");
  env({ HUB_SIDE_BY_SIDE: "lofty_write", HUB_SIDE_BY_SIDE_MAX: "2" });
  S._internal.resetHourly();
  HUB.asks = [];
  for (let i = 0; i < 3; i++) {
    OWN = fakeLofty();
    for (const k of Object.keys(mem)) delete mem[k];
    await quiet(() => handler(event("contact", { ...PERSON, message: "hi" }, `sub-cap-${i}`)));
  }
  check("HUB_SIDE_BY_SIDE_MAX=2: two submissions asked the hub this hour, the third did not", HUB.asks.filter((q) => q.route === "/v1/lofty/lead").length === 2,
    String(HUB.asks.length));
  env(ON);
  S._internal.resetHourly();
  HUB.rows = []; HUB.asks = [];
  const late = S.leadSideBySide({ startedAt: Date.now() - 7600, log: () => {} });
  late.lead({ body: { firstName: "A", emails: ["a@b.co"], tags: ["T"], notes: "n" }, plan: {}, data: {}, triggerTag: "T" });
  late.own({ existing: { attempted: true, ok: true, anyMatch: false }, newLeadId: "1", leadId: "1", provenNew: true });
  await late.finish();
  check("too little of the function's time left: the hub is not asked, and the row says skipped", HUB.asks.length === 0 && HUB.rows.length === 1 &&
    HUB.rows[0].outcome === "not_compared" && HUB.rows[0].reason === "skipped", JSON.stringify(HUB.rows));
  HUB.rows = [];
  const later = S.leadSideBySide({ startedAt: Date.now() - 9500, log: () => {} });
  later.lead({ body: { firstName: "A", emails: ["a@b.co"], tags: ["T"], notes: "n" }, plan: {}, data: {}, triggerTag: "T" });
  later.own({ failed: true });
  await later.finish();
  check("...and with no time left to post, nothing is sent at all", HUB.asks.length === 0 && HUB.rows.length === 0, JSON.stringify(HUB.rows));

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n7. The town figures (mls_read, op town_market)");
  const own = { generated_at: "2026-10-23", towns: { Loveland: { active: 214, median_list: 689000, median_price_per_sqft: 271 },
    Windsor: { active: 120, median_list: 640000, median_price_per_sqft: 250 }, Ault: { active: 7, median_list: 445000, median_price_per_sqft: null } } };
  const hub = { generated_at: "2026-10-23", source: "hub-mls", min_sample: 5, towns: { Loveland: { active: 214, median_list: 689000, median_price_per_sqft: 271, median_dom: 40 },
    Windsor: { active: 110, median_list: 640000.4, median_price_per_sqft: 250 }, Eaton: { active: 9, median_list: 700000, median_price_per_sqft: 300 } } };
  const rows = await S._internal.townRows(own, hub, 20, Date.UTC(2026, 9, 23));
  const keyOf = (t) => kit.parityKey(`town:${t.toLowerCase()}`);
  const out = {};
  for (const t of ["Ault", "Eaton", "Loveland", "Windsor"]) { const k = await keyOf(t); out[t] = rows.find((x) => x.key === k); }
  check("a town on both sides with the same figures is same (extra hub fields ignored)", out.Loveland && out.Loveland.outcome === "same", JSON.stringify(out.Loveland));
  check("a figure that differs is named (active); whole-dollar prices are the same", out.Windsor && out.Windsor.different.join() === "active", JSON.stringify(out.Windsor));
  check("a town only this site has is present own_only; only the hub, hub_only", out.Ault.own_only.includes("present") && out.Eaton.hub_only.includes("present"));
  check("rows carry the town only as parityKey's hash", rows.every((x) => /^k[0-9a-f]{16}$/.test(x.key)) && !/Loveland|Windsor|Ault|Eaton|689000/.test(JSON.stringify(rows)));
  const older = await S._internal.townRows(own, { ...hub, generated_at: "2026-10-21" }, 20, Date.UTC(2026, 9, 23));
  check("figures from different days are not compared (the hub's older: hub_not_ready)", older.every((x) => x.reason === "hub_not_ready"));
  const failedTowns = await S._internal.townRows(own, "hub_timeout", 20, Date.UTC(2026, 9, 23));
  check("a hub failure is one not_compared row per town, with the reason", failedTowns.length === 3 && failedTowns.every((x) => x.reason === "hub_timeout"));
  const big = { generated_at: "2026-10-23", towns: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Town ${i}`, { active: i + 5, median_list: 1, median_price_per_sqft: 1 }])) };
  const d1 = await S._internal.townRows(big, big, 20, Date.UTC(2026, 9, 23));
  const d2 = await S._internal.townRows(big, big, 20, Date.UTC(2026, 9, 24));
  check("at most HUB_SIDE_BY_SIDE_MAX towns a run, a different slice the next day", d1.length === 20 && d2.length === 20 &&
    d1.map((x) => x.key).join() !== d2.map((x) => x.key).join() && d1.every((x) => x.outcome === "same"));
  const tool = path.join(ROOT, "build", "tools", "hub-side-by-side-towns.js");
  const off = spawnSync(process.execPath, [tool], { encoding: "utf8", env: { PATH: process.env.PATH } });
  check("the tool, off: exits 0, says it is off, writes nothing", off.status === 0 && /off/.test(off.stdout) && !/not recorded/.test(off.stdout), off.stdout + off.stderr);
  const down = spawnSync(process.execPath, [tool], { encoding: "utf8", timeout: 20000,
    env: { PATH: process.env.PATH, HUB_SIDE_BY_SIDE: "mls_read", HUB_API_URL: "https://127.0.0.1:9/functions/v1/hub-api", HUB_API_KEY: HUB_KEY } });
  check("the tool, on with the hub unreachable: still exits 0, rows not recorded, the address and key never printed",
    down.status === 0 && /not_compared:hub_unreachable/.test(down.stdout) && !down.stdout.includes("127.0.0.1") && !down.stdout.includes(HUB_KEY), down.stdout + down.stderr);
  const dataPath = path.join(ROOT, "build", "data", "town_market.json");
  const before = fs.readFileSync(dataPath, "utf8");
  check("...and the committed town file is untouched", fs.readFileSync(dataPath, "utf8") === before);
  const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "town-market.yml"), "utf8");
  check("the workflow runs it only when the variable is set, never failing the job, names only",
    /- name: Side-by-side check of the town figures[^\n]*\n\s+if: \$\{\{[^}]*vars\.HUB_SIDE_BY_SIDE != ''[^}]*\}\}\n\s+continue-on-error: true\n/.test(wf) &&
    /run: node build\/tools\/hub-side-by-side-towns\.js/.test(wf) && /HUB_SIDE_BY_SIDE: \$\{\{ vars\.HUB_SIDE_BY_SIDE \}\}/.test(wf));
  check("...after the figures are produced and before anything is committed",
    wf.indexOf("hub-side-by-side-towns.js") > wf.indexOf("town-market-stats.js") &&
    wf.indexOf("hub-side-by-side-towns.js") < Math.max(wf.indexOf("git add build/data/town_market.json"), wf.indexOf("scripts/commit-generated.sh")) &&
    (wf.indexOf("- name: Anything new?") < 0 || wf.indexOf("hub-side-by-side-towns.js") < wf.indexOf("- name: Anything new?")));

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n8. One copy, never a write, off in the docs");
  const src = fs.readFileSync(`${FN_DIR}/lib/_hub-side-by-side.js`, "utf8");
  check("the shared file names neither site", !/little lady|signature property|thelittleladysellshomes\.com|signaturepropertycollection\.com/i.test(src));
  check("it asks the hub's Lofty write routes only with dry_run (every loftyLead / loftyTask call passes { dryRun: true })",
    (src.match(/\.lofty(Lead|Task|Note|OptOut|Flags|Stage|EmailAdd|FillName)\(/g) || []).length === (src.match(/\.lofty(Lead|Task)\([^)]*\{ dryRun: true \}\)/g) || []).length &&
    (src.match(/\.lofty(Lead|Task)\(/g) || []).length === 2 && !/call\(\s*["']POST["']\s*,\s*["']\/v1\/lofty\//.test(src));
  check("it never logs a key or a hub address", !/console\.[a-z]+\([^)]*(HUB_API_KEY|HUB_API_URL|LOFTY_API_KEY)/.test(src));
  check("lib/suite-kit is toolkit 0.5.2 with the parity rules", require(`${FN_DIR}/lib/suite-kit/version.js`).VERSION === "0.5.2" &&
    typeof kit.compareRecords === "function" && typeof kit.parityRow === "function");
  const other = path.join(ROOT, "..", SIBLING);
  if (fs.existsSync(other)) {
    for (const f of ["netlify/functions/lib/_hub-side-by-side.js", "build/tools/hub-side-by-side-towns.js", "tests/test-hub-side-by-side.js"]) {
      check(`${f} is byte-identical to ${SIBLING}'s copy`, fs.existsSync(path.join(other, f)) && fs.readFileSync(path.join(other, f), "utf8") === fs.readFileSync(path.join(ROOT, f), "utf8"));
    }
  } else {
    console.log(`  --   ${SIBLING} checkout not present; skipping the cross-site copy checks`);
  }
  const doc = fs.existsSync(path.join(ROOT, "docs", "hub-side-by-side.md")) ? fs.readFileSync(path.join(ROOT, "docs", "hub-side-by-side.md"), "utf8") : "";
  check("docs/hub-side-by-side.md says it is off and names the two settings", /off/i.test(doc) && /`HUB_SIDE_BY_SIDE`/.test(doc) && /`HUB_SIDE_BY_SIDE_MAX`/.test(doc) && !leaks(doc).length);
  const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
  check("CLAUDE.md points to it", /HUB_SIDE_BY_SIDE/.test(claude) && /docs\/hub-side-by-side\.md/.test(claude));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
