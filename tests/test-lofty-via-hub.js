// Wave 1b (2026-10-17): the website forms' Lofty work through the Seller Intelligence hub, switched by
// LOFTY_VIA_HUB, and the router copy, switched by LEADS_TO_ROUTER (lib/_lofty-hub.js). This pins:
//
//   1. the switch: unset / "off" / "yes" / "true" = today's path (this site's own Lofty key); " On " = the hub;
//   2. the real form handler through the hub: lookup + create (lead type) + tags + note in ONE push, the plan tag
//      in a second push only for a contact the hub created, after the hub's consent route; a returning contact
//      gets the Call task (own key, after consent); nothing the hub covers goes out on this site's own key;
//   3. Do Not Contact / opted out is never pushed for a plan, tagged for a plan, emailed or texted -- on today's
//      path (the guards, OPTED OUT included) and on the hub path (held, held_by do_not_contact, consent);
//   4. two writers on the same lead at once never lose a tag (a fake hub built from the VENDORED toolkit, with
//      its one-writer-per-lead lock and a fake Lofty that holds every lead read until both writers have read);
//      Do Not Contact still wins when one of them is an opt-out;
//   5. fail closed: hub not configured / unreachable / 503 / rate limited -> nothing on the own key, the lead
//      queued (or held) with the reason, and the queue replay goes through the hub too;
//   6. the router copy: off by default, once per submission, rent-to-own included (Christine's lead, intent
//      rent_to_own), cash offer and FSBO with their own intents (seller_cash, seller_fsbo) and the Lofty side
//      unchanged, never in the way, no PII in the log;
//   7. the vendored toolkit copy is untouched (its check.mjs), and the shared files match the other site's.
//
// The same file runs in both repos; only SITE and SIBLING below differ. Nothing here touches the network.
"use strict";
process.exitCode = 1;
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const SITE = "signature";
const SIBLING = "thelittleladysellshomes";
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const kit = require(`${FN_DIR}/lib/suite-kit/index.js`);
const EN = String.fromCharCode(0x2013);
const PLAN_B1 = `TOF ${EN} Website Buyer`;
const HUB_URL = "https://hub.example.test/functions/v1/hub-api";
const HUB_KEY = `hub_${"0".repeat(64)}`; // the shape of a hub key; not a real one
const CHRISTINE = "thelittleladyinc@gmail.com";

const res = (status, body) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
};

// ---- A toolkit-style in-memory Lofty (the hub's Lofty, or this site's own in today's-path checks) ----------
function fakeLofty(seed) {
  const leads = new Map((seed || []).map((l) => [l.leadId, JSON.parse(JSON.stringify(l))]));
  const calls = [];
  const notes = [];
  let nextId = 9000;
  const ten = (v) => String(v && typeof v === "object" ? (v.phone || v.value) : (v == null ? "" : v)).replace(/\D/g, "").slice(-10);
  const emailsOf = (l) => [].concat(l.emails || [], l.email || []).map((e) => String(typeof e === "object" ? e.email || e.value : e).toLowerCase());
  const phonesOf = (l) => [].concat(l.phones || [], l.phone || []).map(ten);
  async function fetch(url, init) {
    const u = new URL(url);
    const method = (init && init.method) || "GET";
    const p = u.pathname.replace(/^\/v1\.0/, "");
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: p, body });
    const one = p.match(/^\/leads\/(\d+)$/);
    if (method === "GET" && p === "/leads") {
      const email = (u.searchParams.get("email") || "").toLowerCase();
      const phone = ten(u.searchParams.get("phone"));
      const found = [...leads.values()].filter((l) => (email && emailsOf(l).includes(email)) || (phone && phonesOf(l).includes(phone)));
      return res(200, { leads: found.slice(0, 5) });
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
      const id = nextId++;
      leads.set(id, { leadId: id, ...body, tags: [] });
      return res(200, { leadId: id });
    }
    if (method === "POST" && p === "/notes") { notes.push(body); return res(200, { noteId: 1 }); }
    if (/\/v2\.0\/tasks$/.test(u.pathname)) return res(200, { taskId: 77 });
    if (/send-task-reminder$/.test(u.pathname)) return res(200, { message: "ok" });
    if (/listCustomField$/.test(u.pathname)) return res(200, { data: [] });
    if (/custom-field$/.test(u.pathname)) return res(200, {});
    if (/\/inquiry$/.test(u.pathname)) return res(200, {});
    return res(404, { message: `unknown route ${method} ${p}` });
  }
  return { fetch, leads, calls, notes };
}

// Hold every GET /leads/{id} until `n` have arrived (or `ms` passed): both writers read before either writes.
function readTogether(f, n = 2, ms = 60) {
  let waiting = [];
  return async (url, init) => {
    if (((init && init.method) || "GET") === "GET" && /\/leads\/\d+$/.test(new URL(url).pathname)) {
      await new Promise((resolve) => {
        waiting.push(resolve);
        if (waiting.length >= n) { waiting.forEach((r) => r()); waiting = []; } else setTimeout(resolve, ms);
      });
    }
    return f.fetch(url, init);
  };
}

// ---- A fake hub, built from the VENDORED toolkit: the same pushLead / tagLead / applyOptOut / lookupConsent the
// hub runs, the same one-writer-per-lead lock, the shared opt-out list, the hub's answer shapes ------------------
const QUIET = { info: () => {}, warn: () => {} };
const outcomeJson = (o) => ({
  ok: o.ok, lead_id: o.leadId, action: o.action, matched_by: o.matchedBy || null, tags_added: o.tagsAdded, tags_held: o.tagsHeld || [],
  note_added: o.noteAdded, code: o.code || null, needs_review: o.needsReview === true, match_lead_ids: o.matchLeadIds || [],
  reason: o.reason || null, do_not_contact: o.dncHeld === true, dnc_lost: o.dncLost === true, texting_turned_off: o.textingTurnedOff === true,
  email_turned_off: o.emailTurnedOff === true, merged: o.merged === true, retry_after: o.retryAfterSeconds || null,
});
const statusOf = (o) => (o.ok ? (o.action === "created" ? "created" : "updated")
  : o.code === "rate_limited" || o.code === "busy" ? "rate_limited" : o.code === "not_configured" ? "not_configured" : "held");

function fakeHub(opts) {
  const o = opts || {};
  const h = {
    lofty: o.lofty || fakeLofty(), lock: o.lock === null ? undefined : (o.lock || kit.createMemoryLeadLock()),
    dnc: new Set(o.dnc || []), optedOut: new Set(o.optedOut || []), requests: [], emails: [], routed: [],
    down: null, routerDown: null, together: null,
  };
  // One barrier shared by every writer in a race: each lead read waits (up to 600 ms) until two have arrived.
  h.race = () => { h.together = readTogether(h.lofty, 2, 600); };
  h.deps = () => ({ apiKey: "hub-side-test-key", fetch: h.together ? h.together : h.lofty.fetch, log: QUIET,
    lockLead: h.lock, allowTextingOn: false });
  h.list = (email, phone) => {
    const e = kit.normEmail(email);
    const p = kit.normPhone(phone);
    const doNotContact = !!((e && h.dnc.has(e)) || (p && h.dnc.has(p)));
    const emailBlocked = !!(e && (h.optedOut.has(e) || h.dnc.has(e)));
    return { doNotContact, emailBlocked, emailOptOut: !!(e && h.optedOut.has(e)), phoneBlocked: !!(p && h.dnc.has(p)) };
  };
  h.handle = async (url, init) => {
    const route = new URL(url).pathname.replace(/^\/functions\/v1\/hub-api/, "");
    if (!init.headers || init.headers["x-hub-key"] !== HUB_KEY) return res(401, { error: "unknown key" });
    if (init.redirect !== "error" && init.redirect !== "manual") return res(400, { error: "the client must refuse redirects" });
    const b = init.body ? JSON.parse(init.body) : {};
    h.requests.push({ route, body: b });
    if (route === "/v1/email/send") { h.emails.push(b); return res(200, { status: "sent", provider_id: "e1" }); }
    if (route === "/v1/router/lead") {
      if (h.routerDown) return res(h.routerDown, { error: "router unavailable" });
      h.routed.push(b);
      return res(200, { status: "routed", id: h.routed.length });
    }
    if (route.startsWith("/v1/lofty/")) {
      if (h.down === "throw") throw new TypeError("fetch failed");
      if (typeof h.down === "number") return res(h.down, { error: "the Lofty doorway is switched off (flag lofty_doorway_enabled)" });
      if (h.down && typeof h.down === "object") return res(200, h.down);
    }
    const d = h.deps();
    if (route === "/v1/lofty/lead") {
      const list = h.list(b.email, b.phone);
      const tags = Array.isArray(b.tags) ? b.tags : [];
      if (list.doNotContact) {
        const out = await kit.applyOptOut({ kind: "do_not_contact", email: b.email, phone: b.phone }, d);
        return res(200, { status: "held", held_by: "do_not_contact", tags_dropped: tags, shared_list: list, ...outcomeJson(out) });
      }
      const out = await kit.pushLead({
        lead: { firstName: b.first_name || "", lastName: b.last_name || "", email: b.email, phone: b.phone, source: b.source,
          leadTypes: Array.isArray(b.lead_types) && b.lead_types.length ? b.lead_types : undefined },
        tags: list.emailBlocked ? [] : tags, note: b.note, smsConsent: false, create: b.create !== false, emailOptOut: list.emailOptOut,
      }, d);
      return res(200, { status: statusOf(out), held_by: null, tags_dropped: list.emailBlocked ? tags : [], shared_list: list, ...outcomeJson(out) });
    }
    if (route === "/v1/lofty/note") {
      const out = await kit.noteLead(String(b.lead_id), b.content, d);
      return res(200, { status: out.ok ? "noted" : statusOf(out), ...outcomeJson(out) });
    }
    if (route === "/v1/lofty/consent") {
      const r = await kit.lookupConsent({ leadId: b.lead_id, email: b.email, phone: b.phone }, d);
      if (!r.ok) return res(200, { status: "held", code: r.outcome.code || "unreadable", may_email: false, may_call: false });
      if (!r.found) return res(200, { status: "not_in_lofty", may_email: true, may_call: true });
      const s = r.status;
      return res(200, { status: "found", lead_id: s.leadId, do_not_contact: s.doNotContact, email_opt_out: s.emailOptOut,
        may_email: s.mayEmail, may_call: s.mayCall, may_text: false });
    }
    return res(404, { error: `unknown route ${route}` });
  };
  h.routes = () => h.requests.map((r) => r.route);
  h.leadPushes = () => h.requests.filter((r) => r.route === "/v1/lofty/lead").map((r) => r.body);
  return h;
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
  "FLODESK_API_KEY", "LOFTY_QUEUE_DRAIN"];
function env(extra) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { LOFTY_API_KEY: "own-key-for-tests", HUB_API_URL: HUB_URL, HUB_API_KEY: HUB_KEY }, extra || {});
}
env();

let HUB = fakeHub();
let OWN = fakeLofty();
let ownCalls = [];
let netCalls = 0;
global.fetch = async (url, init) => {
  const s = String(url);
  const i = init || {};
  netCalls++;
  if (s.startsWith("https://hub.example.test/")) return HUB.handle(s, i);
  if (s.startsWith("https://api.lofty.com/")) {
    const u = new URL(s);
    ownCalls.push({ method: i.method || "GET", path: u.pathname, body: i.body ? JSON.parse(i.body) : null });
    return OWN.fetch(s, i);
  }
  throw new Error(`unexpected request ${s}`);
};

const L = require(`${FN_DIR}/lib/_lofty.js`);
const N = require(`${FN_DIR}/lib/_notify.js`);
const H = require(`${FN_DIR}/lib/_lofty-hub.js`);
const P = require(`${FN_DIR}/lib/_form-plans.js`);
const C = require(`${FN_DIR}/lib/_lofty-consent.js`);
const R = require(`${FN_DIR}/lib/_lofty-returning.js`);
const handler = require(`${FN_DIR}/submission-created.js`).handler;

// What this site may still send on its own key with the switch on (the hub has no route for these yet).
function allowedOwn(c) {
  const k = `${c.method} ${c.path}`;
  if (/^GET \/v1\.0\/teamFeatures\/listCustomField$/.test(k) || /^POST \/v1\.0\/teamFeatures\/custom-field$/.test(k)) return true;
  if (/^POST \/v1\.0\/leads\/\d+\/inquiry$/.test(k)) return true;
  if (/^POST \/v2\.0\/tasks$/.test(k) || /^POST \/v2\.0\/sales-agent\/notification\/app-push\/send-task-reminder$/.test(k)) return true;
  return /^PUT \/v1\.0\/leads\/\d+$/.test(k) && !!c.body && Object.keys(c.body).join() === "customAttributeList";
}
const coveredOwn = () => ownCalls.filter((c) => !allowedOwn(c));

function reset(hub, own) {
  HUB = hub || fakeHub();
  OWN = own || fakeLofty();
  ownCalls = [];
  netCalls = 0;
  for (const k of Object.keys(mem)) delete mem[k];
  H.forget();
}

const lines = [];
async function quiet(fn) {
  const keep = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...a) => lines.push(a.map(String).join(" "));
  try { return await fn(); } finally { [console.log, console.warn, console.error] = keep; }
}
const person = (extra) => ({ name: "Pat Buyer", email: "pat@example.com", phone: "(970) 555-0123", ...(extra || {}) });
const event = (form, data, id) => ({ body: JSON.stringify({ payload: { form_name: form, data, id: id || "sub-0001" } }) });
const submit = (form, data, id) => quiet(() => handler(event(form, data, id)));
const tagsOf = (l) => (Array.isArray(l && l.tags) ? l.tags.map((t) => (typeof t === "string" ? t : t.tagName || t.name)) : []);
const deadline = () => Date.now() + 15000;

(async () => {
  // ------------------------------------------------------------------------------------------------------------
  console.log("\n1. The switch: exactly \"on\" (trimmed, any case) moves the Lofty work to the hub");
  for (const v of [undefined, "", "off", "OFF", "yes", "true", "1", "enabled", "onn", "o n"]) {
    check(`LOFTY_VIA_HUB=${JSON.stringify(v)} is today's path`, H.loftyViaHub({ LOFTY_VIA_HUB: v }) === false);
    check(`LEADS_TO_ROUTER=${JSON.stringify(v)} is off`, H.leadsToRouter({ LEADS_TO_ROUTER: v }) === false);
  }
  for (const v of ["on", " On ", "ON", "on\n"]) {
    check(`LOFTY_VIA_HUB=${JSON.stringify(v)} is the hub`, H.loftyViaHub({ LOFTY_VIA_HUB: v }) === true);
    check(`LEADS_TO_ROUTER=${JSON.stringify(v)} is on`, H.leadsToRouter({ LEADS_TO_ROUTER: v }) === true);
  }
  const lead = { firstName: "Pat", lastName: "Buyer", emails: ["pat@example.com"], phones: ["(970) 555-0123"], source: "test", tags: ["Website Lead"], cannotText: true };
  for (const v of [undefined, "yes", "true"]) {
    env(v === undefined ? {} : { LOFTY_VIA_HUB: v });
    reset();
    const r = await quiet(() => L.postLead({ ...lead }, "own-key-for-tests", { deadline: deadline() }));
    check(`LOFTY_VIA_HUB=${JSON.stringify(v)}: postLead uses this site's own key (POST api.lofty.com/v1.0/leads), not the hub`,
      r.ok && ownCalls.length === 1 && ownCalls[0].method === "POST" && ownCalls[0].path === "/v1.0/leads" && HUB.requests.length === 0,
      JSON.stringify({ own: ownCalls, hub: HUB.routes() }));
  }
  env({ LOFTY_VIA_HUB: " On " });
  reset();
  let r = await quiet(() => L.postLead({ ...lead }, "own-key-for-tests", { deadline: deadline() }));
  check("LOFTY_VIA_HUB=\" On \": postLead goes to the hub's /v1/lofty/lead and never to api.lofty.com",
    r.ok && r.viaHub && HUB.routes().join() === "/v1/lofty/lead" && ownCalls.length === 0, JSON.stringify({ r, own: ownCalls }));
  check("...the lead is created in Lofty texting-off, by the hub", HUB.lofty.leads.get(9000) && HUB.lofty.leads.get(9000).cannotText === true);
  check("...and the answer says this contact is the one the hub created", R.leadIdFromResponse(r.responseBody) === "9000" &&
    JSON.parse(r.responseBody).data.leadId === "9000");

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n2. The real form handler through the hub");
  env({ LOFTY_VIA_HUB: "on" });
  reset();
  await submit("buyers-guide", person(), "sub-2001");
  let pushes = HUB.leadPushes();
  const first = pushes[0] || {};
  check("a new contact: ONE push carries the lookup, the create, the lead type, the form's tags and the note",
    first.create === true && JSON.stringify(first.lead_types) === "[2]" && first.email === "pat@example.com" &&
    ["Hot Lead - Website", "Website Lead", "buyers-guide"].every((t) => first.tags.includes(t)) && /NEW WEBSITE LEAD/.test(first.note || ""),
    JSON.stringify(first));
  check("...the plan tag is NOT in that push", !first.tags.includes(PLAN_B1));
  const second = pushes[1] || {};
  check("...then the hub's consent route, then a second push with create:false and the plan tag only",
    HUB.routes().indexOf("/v1/lofty/consent") > HUB.routes().indexOf("/v1/lofty/lead") && pushes.length === 2 &&
    second.create === false && JSON.stringify(second.tags) === JSON.stringify([PLAN_B1]) && !second.note && !second.lead_types,
    JSON.stringify(HUB.requests.map((x) => [x.route, x.body.create, x.body.tags])));
  let made = HUB.lofty.leads.get(9000) || {};
  check("...the new lead carries every tag, the plan tag, its lead type, texting off, and ONE note",
    ["Hot Lead - Website", "Website Lead", "buyers-guide", PLAN_B1].every((t) => tagsOf(made).includes(t)) &&
    JSON.stringify(made.leadTypes) === "[2]" && made.cannotText === true && HUB.lofty.notes.length === 1, JSON.stringify(made));
  check("...the note was not sent a second time (no /v1/lofty/note)", !HUB.routes().includes("/v1/lofty/note"));
  check("...nothing the hub covers went out on this site's own key", coveredOwn().length === 0, JSON.stringify(coveredOwn()));
  check("...the website fields stay on the own key (no hub route yet), for this proven-new contact only",
    ownCalls.some((c) => c.method === "PUT" && Object.keys(c.body || {}).join() === "customAttributeList"));
  check("...the alert email goes to Christine only, never to the lead",
    HUB.emails.length === 1 && HUB.emails[0].to.join() === CHRISTINE && !JSON.stringify(HUB.emails[0].to).includes("pat@example.com"));
  let lastPush = mem["lofty-last-push.json"] || {};
  check("...and /status records the push and the plan tag", lastPush.ok === true && lastPush.viaHub === true &&
    lastPush.planResult && lastPush.planResult.ok === true, JSON.stringify(lastPush.planResult));

  reset(fakeHub({ lofty: fakeLofty([{ leadId: 7, emails: ["pat@example.com"], phones: ["+19705550123"], tags: ["Buyer"], cannotText: true, leadTypes: [1] }]) }));
  await submit("buyers-guide", person(), "sub-2002");
  pushes = HUB.leadPushes();
  let seven = HUB.lofty.leads.get(7);
  check("a returning contact: one push, merged onto the existing lead (its tags kept, the form's added)",
    pushes.length === 1 && ["Buyer", "Hot Lead - Website", "buyers-guide"].every((t) => tagsOf(seven).includes(t)), JSON.stringify(seven.tags));
  check("...no plan tag and no change to its own lead type", !tagsOf(seven).includes(PLAN_B1) && JSON.stringify(seven.leadTypes) === "[1]");
  check("...the Call task goes out on the own key, after the hub's consent route said the lead may be called",
    HUB.routes().includes("/v1/lofty/consent") && ownCalls.map((c) => c.path).join() === "/v2.0/tasks,/v2.0/sales-agent/notification/app-push/send-task-reminder",
    JSON.stringify(ownCalls));
  check("...and nothing the hub covers went out on the own key", coveredOwn().length === 0);

  reset(fakeHub({ lofty: fakeLofty([{ leadId: 8, emails: ["pat@example.com"], phones: ["+19705550123"], tags: [`Consent ${EN} DNC`], cannotText: true }]) }));
  await submit("buyers-guide", person(), "sub-2003");
  const eight = HUB.lofty.leads.get(8);
  check("a returning Do Not Contact lead: the hub holds every tag (Do Not Contact wins)",
    tagsOf(eight).join() === `Consent ${EN} DNC`, JSON.stringify(eight.tags));
  check("...no plan push, no Call task, nothing at all on the own key",
    HUB.leadPushes().length === 1 && ownCalls.length === 0, JSON.stringify(ownCalls));

  // #dnc = phone only (calls/texts); email still allowed — Christine 2026-10-18
  reset(fakeHub({ lofty: fakeLofty([{ leadId: 18, emails: ["pat@example.com"], phones: ["+19705550123"], tags: ["#dnc"], cannotText: false }]) }));
  await submit("buyers-guide", person(), "sub-2013");
  const eighteen = HUB.lofty.leads.get(18);
  check("a returning #dnc lead (phone only): the form's tags go on, #dnc stays, texting is switched off",
    ["#dnc", "Hot Lead - Website", "buyers-guide"].every((t) => tagsOf(eighteen).includes(t)) && eighteen.cannotText === true,
    JSON.stringify(eighteen));
  check("...but no Call task (the hub's consent route says it may not be called), nothing on the own key",
    HUB.routes().includes("/v1/lofty/consent") && ownCalls.length === 0, JSON.stringify(ownCalls));

  reset(fakeHub({ dnc: ["pat@example.com"] }));
  await submit("buyers-guide", person(), "sub-2004");
  check("on the shared opt-out list as Do Not Contact: nothing created in Lofty",
    !HUB.lofty.calls.some((c) => c.method === "POST" && c.path === "/leads") && HUB.lofty.leads.size === 0);
  check("...held for review (never replayed), not queued", (mem["lofty-manual-review.json"] || []).length === 1 &&
    !(mem["lofty-failed-pushes.json"] || []).length && /Do Not Contact/.test((mem["lofty-manual-review.json"] || [{}])[0].reason || ""));
  check("...no consent call, no plan push, nothing on the own key", HUB.leadPushes().length === 1 &&
    !HUB.routes().includes("/v1/lofty/consent") && ownCalls.length === 0);

  reset(fakeHub({ optedOut: ["pat@example.com"] }));
  await submit("buyers-guide", person(), "sub-2005");
  made = HUB.lofty.leads.get(9000) || {};
  check("email opted out on the shared list: the lead is recorded with the opt-out, no tags and no plan tag",
    tagsOf(made).includes(`Consent ${EN} Unsubscribed`) && made.cannotEmail === true && !tagsOf(made).includes(PLAN_B1) &&
    !tagsOf(made).includes("Hot Lead - Website") && HUB.leadPushes().length === 1, JSON.stringify(made));

  reset(fakeHub({ lofty: fakeLofty([{ leadId: 9, emails: ["pat@example.com"], phones: ["+19705550123"], tags: [], cannotText: true }]) }));
  const yes = await quiet(() => C.applyTextingPreference("9", "(970) 555-0123", true, "own-key-for-tests"));
  const nine = HUB.lofty.leads.get(9);
  check("a yes to texts on the hub path is recorded in a note, and texting stays off (10DLC campaign 12744)",
    yes.textingEnabled === false && HUB.lofty.notes.length === 1 && /10DLC campaign 12744/.test(HUB.lofty.notes[0].content) &&
    nine.cannotText === true && !tagsOf(nine).some((t) => kit.isSmsConsentTag(t)) && ownCalls.length === 0, JSON.stringify(yes));
  const no = await quiet(() => C.applyTextingPreference("9", "(970) 555-0199", false, "own-key-for-tests"));
  check("...and without a yes nothing is written by this site (the hub turns a new number's texting off itself)",
    no.textingEnabled === false && ownCalls.length === 0 && HUB.lofty.notes.length === 1);

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n3. Do Not Contact / opted out on TODAY'S path: no plan tag, no re-fire, no texting");
  env();
  const DNC_SPELLINGS = [`Consent ${EN} DNC`, "#dnc", "#DNC", "consent - dnc", "OPTED OUT", "Opted  Out", `Expired Elite ${EN} OPTED OUT`, "expired elite - opted out"];
  for (const tag of DNC_SPELLINGS.filter((t) => !/^#dnc$/i.test(t))) {
    reset(null, fakeLofty([{ leadId: 501, tags: [tag], phones: ["9705550123"], cannotText: true }]));
    const p = await quiet(() => N.addPlanTags("501", [PLAN_B1], "own-key-for-tests"));
    check(`"${tag}": no plan tag (nothing written)`, p.ok === false && p.step === "do-not-contact" && !OWN.calls.some((c) => c.method === "PUT"), JSON.stringify(p));
  }
  // #dnc = phone only (calls/texts); email still allowed — Christine 2026-10-18: a plan (it emails) still starts.
  for (const tag of ["#dnc", "#DNC"]) {
    reset(null, fakeLofty([{ leadId: 511, tags: [tag], phones: ["9705550123"], cannotText: true }]));
    const p = await quiet(() => N.addPlanTags("511", [PLAN_B1], "own-key-for-tests"));
    check(`"${tag}" alone (phone only): the plan tag goes on, #dnc kept`, p.ok === true &&
      JSON.stringify(OWN.leads.get(511).tags) === JSON.stringify([tag, PLAN_B1]), JSON.stringify(p));
  }
  for (const [label, seed] of [["\"Consent – Unsubscribed\"", { tags: [`Consent ${EN} Unsubscribed`] }], ["cannotEmail: true", { tags: [], cannotEmail: true }]]) {
    reset(null, fakeLofty([{ leadId: 502, phones: [], cannotText: true, ...seed }]));
    const p = await quiet(() => N.addPlanTags("502", [PLAN_B1], "own-key-for-tests"));
    check(`email opted out (${label}): no plan tag`, p.ok === false && p.step === "email-opt-out" && !OWN.calls.some((c) => c.method === "PUT"));
  }
  reset(null, fakeLofty([{ leadId: 503, tags: ["Buyer"], phones: [], cannotText: true }]));
  r = await quiet(() => N.addPlanTags("503", [PLAN_B1], "own-key-for-tests"));
  check("...a lead with neither still gets its plan tag (control)", r.ok === true &&
    JSON.stringify(OWN.leads.get(503).tags) === JSON.stringify(["Buyer", PLAN_B1]));
  reset(null, fakeLofty([{ leadId: 504, tags: ["OPTED OUT", "Hot Lead - Website"], phones: [], cannotText: true }]));
  r = await quiet(() => N.refireLoftyTag("504", "Hot Lead - Website", "own-key-for-tests"));
  check("a Do Not Contact lead is never re-fired (its Smart Plan never restarts)", r.ok === false && r.tagRestored === true &&
    !OWN.calls.some((c) => c.method === "PUT"));
  // _lofty-consent.js keeps a copy of the toolkit's Do Not Contact test (its own loader-based tests can't load the
  // toolkit); every spelling must give the toolkit's answer: a yes with the right number turns texting on only
  // when the lead is NOT Do Not Contact.
  for (const tag of [...DNC_SPELLINGS, `Consent ${EN} DNC Email`, "Buyer", "dnc", "Opted Out Email", "OPTED-OUT"]) {
    reset(null, fakeLofty([{ leadId: 505, tags: [tag], phones: ["9705550123"], cannotText: true }]));
    const t = await quiet(() => C.applyTextingPreference("505", "(970) 555-0123", true, "own-key-for-tests"));
    const dnc = kit.isDncTag(tag);
    check(`today's texting rule agrees with the toolkit on "${tag}" (${dnc ? "Do Not Contact: stays off" : "not DNC"})`,
      t.textingEnabled === !dnc && (!dnc || !OWN.calls.some((c) => c.method === "PUT" && c.body && c.body.cannotText === false)), JSON.stringify(t));
  }
  reset(null, fakeLofty([{ leadId: 506, emails: ["pat@example.com"], phones: ["9705550123"], tags: ["#dnc"], cannotText: true }]));
  await submit("buyers-guide", person({ sms_consent: "yes" }), "sub-3001");
  const plansPut = OWN.calls.filter((c) => c.method === "PUT" && c.body && Array.isArray(c.body.tags) && c.body.tags.includes(PLAN_B1));
  check("today's handler, a returning #dnc lead: no plan tag, texting not switched on, the alert email to Christine only",
    plansPut.length === 0 && !OWN.calls.some((c) => c.method === "PUT" && c.body && c.body.cannotText === false) &&
    HUB.emails.length === 1 && HUB.emails[0].to.join() === CHRISTINE && !HUB.leadPushes().length);

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n4. Two writers on the same lead at once never lose a tag (vendored toolkit, one writer per lead)");
  env({ LOFTY_VIA_HUB: "on" });
  const seedAnn = () => fakeLofty([{ leadId: 7, emails: ["ann@example.com"], phones: ["+19705550111"], tags: ["Buyer"], cannotText: true }]);
  const annBody = (tags) => ({ firstName: "Ann", emails: ["ann@example.com"], phones: ["(970) 555-0111"], source: "test", tags });
  reset(fakeHub({ lofty: seedAnn(), lock: null }));
  HUB.race();
  await quiet(() => Promise.all([L.postLead(annBody(["Hot Lead - Website"]), "k", { deadline: deadline() }),
    kit.tagLead("7", ["Router Source - noco-quiz"], HUB.deps())]));
  let annTags = tagsOf(HUB.lofty.leads.get(7));
  check("(control) without the lock, the same race DOES lose a tag -- so this test can see one",
    !(annTags.includes("Hot Lead - Website") && annTags.includes("Router Source - noco-quiz")), annTags.join(", "));
  reset(fakeHub({ lofty: seedAnn() }));
  HUB.race();
  const [a] = await quiet(() => Promise.all([L.postLead(annBody(["Hot Lead - Website", "Website Lead"]), "k", { deadline: deadline() }),
    kit.tagLead("7", ["Router Source - noco-quiz"], HUB.deps())]));
  annTags = tagsOf(HUB.lofty.leads.get(7));
  check("this site (through the hub) and another app at the same moment: every tag kept",
    a.ok && ["Buyer", "Hot Lead - Website", "Website Lead", "Router Source - noco-quiz"].every((t) => annTags.includes(t)), annTags.join(", "));
  check("...and this site sent nothing to api.lofty.com", ownCalls.length === 0);
  reset(fakeHub({ lofty: seedAnn() }));
  HUB.race();
  await quiet(() => Promise.all([L.postLead(annBody(["Hot Lead - Website"]), "k", { deadline: deadline() }),
    L.postLead(annBody(["Website Lead", "buyers-guide"]), "k", { deadline: deadline() })]));
  annTags = tagsOf(HUB.lofty.leads.get(7));
  check("two submissions from this site at once: every tag kept", ["Buyer", "Hot Lead - Website", "Website Lead", "buyers-guide"]
    .every((t) => annTags.includes(t)) && ownCalls.length === 0, annTags.join(", "));
  reset(fakeHub({ lofty: seedAnn() }));
  HUB.race();
  await quiet(() => Promise.all([L.postLead(annBody(["Hot Lead - Website", PLAN_B1]), "k", { deadline: deadline() }),
    kit.applyOptOut({ kind: "do_not_contact", leadId: "7" }, HUB.deps())]));
  const annLead = HUB.lofty.leads.get(7);
  annTags = tagsOf(annLead);
  check("an opt-out racing this site's push: Do Not Contact wins (both DNC tags kept, texting off)",
    annTags.includes(`Consent ${EN} DNC`) && annTags.includes("#dnc") && annLead.cannotText === true && ownCalls.length === 0, annTags.join(", "));

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n5. Fail closed: the hub can't take it -> nothing on the own key, the lead waits with the reason");
  env({ LOFTY_VIA_HUB: "on", HUB_API_URL: "" });
  reset();
  r = await quiet(() => L.postLead({ ...lead }, "own-key-for-tests", { deadline: deadline() }));
  check("hub not configured: not sent, no request at all, the setting named (never its value)",
    !r.ok && !r.manualReview && netCalls === 0 && /HUB_API_URL not set/.test(r.responseBody) && !r.responseBody.includes(HUB_KEY), r.responseBody);
  env({ LOFTY_VIA_HUB: "on", HUB_API_KEY: "not-a-hub-key" });
  reset();
  r = await quiet(() => L.postLead({ ...lead }, "own-key-for-tests", { deadline: deadline() }));
  check("a key that is not a hub key: not sent, no request", !r.ok && netCalls === 0 && !r.responseBody.includes("not-a-hub-key"));
  env({ LOFTY_VIA_HUB: "on" });
  const failures5 = [
    ["the hub unreachable", "throw", (x) => x.hubStatus === "unreachable"],
    ["the doorway switched off (503)", 503, (x) => x.httpStatus === 503 && /switched off/.test(x.responseBody)],
    ["rate limited / busy (another app holds the lead)", { status: "rate_limited", ok: false, code: "busy", retry_after: 5, lead_id: null },
      (x) => x.retryAfter === 5 && /busy/.test(x.responseBody)],
    ["Lofty's lookup failed", { status: "held", ok: false, code: "lookup_failed", needs_review: true, reason: "lookup_failed: HTTP 500", lead_id: null },
      (x) => /lookup_failed/.test(x.responseBody)],
  ];
  for (const [label, down, extra] of failures5) {
    reset();
    HUB.down = down;
    r = await quiet(() => L.postLead({ ...lead }, "own-key-for-tests", { deadline: deadline() }));
    check(`${label}: queued (not held), nothing on the own key`, !r.ok && !r.manualReview && ownCalls.length === 0 && extra(r), JSON.stringify(r));
  }
  reset();
  HUB.down = { status: "held", ok: false, code: "several_leads", needs_review: true, reason: "several_leads: 2 Lofty leads carry this email", match_lead_ids: ["11", "12"], lead_id: null };
  r = await quiet(() => L.postLead({ ...lead }, "own-key-for-tests", { deadline: deadline() }));
  check("several possible leads: held for review (never replayed), nothing on the own key", !r.ok && r.manualReview === true && ownCalls.length === 0);
  reset();
  HUB.down = 503;
  await submit("buyers-guide", person(), "sub-5001");
  const queued = mem["lofty-failed-pushes.json"] || [];
  check("through the handler with the doorway off: the alert email still goes out, the lead is queued with the reason",
    HUB.emails.length === 1 && queued.length === 1 && queued[0].viaHub === true && queued[0].site === SITE &&
    /the hub refused \(HTTP 503\)/.test(queued[0].responseBody) && !(mem["lofty-manual-review.json"] || []).length, JSON.stringify(queued[0]));
  check("...and nothing at all went to api.lofty.com", ownCalls.length === 0, JSON.stringify(ownCalls));
  ownCalls = [];
  let dr = await quiet(() => L.drainFailedPushes(store, "own-key-for-tests", { deadline: Date.now() + 20000 }));
  check("the queue replay with the hub still off: the lead stays queued, retry noted, nothing on the own key",
    dr.attempted === 1 && dr.recovered === 0 && (mem["lofty-failed-pushes.json"] || []).length === 1 &&
    !!mem["lofty-failed-pushes.json"][0].lastRetryAt && ownCalls.length === 0, JSON.stringify(dr));
  HUB.down = null;
  dr = await quiet(() => L.drainFailedPushes(store, "own-key-for-tests", { deadline: Date.now() + 20000 }));
  made = HUB.lofty.leads.get(9000) || {};
  check("...once the hub is back, the replay goes through it: created, tagged, noted, then the plan tag for this new contact",
    dr.recovered === 1 && !(mem["lofty-failed-pushes.json"] || []).length && tagsOf(made).includes("Hot Lead - Website") &&
    tagsOf(made).includes(PLAN_B1) && JSON.stringify(made.leadTypes) === "[2]" && HUB.lofty.notes.length === 1, JSON.stringify({ dr, made }));
  check("...and the replay sent nothing the hub covers on the own key", coveredOwn().length === 0, JSON.stringify(coveredOwn()));

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n6. The router copy (LEADS_TO_ROUTER)");
  const details = (extra) => ({ name: "Pat Buyer", email: "pat@example.com", phone: "(970) 555-0123", source: "x", sourceShort: "x",
    noteText: "note", leadId: null, stamp: "now", submissionId: "sub-6001", formName: "buyers-guide", ...(extra || {}) });
  env();
  reset();
  let sent = await quiet(() => N.sendLeadAlertEmail(details()));
  check("off by default: no router call, and the alert result is exactly what it was", !HUB.routed.length && !("router" in sent) && sent.ok === true);
  env({ LEADS_TO_ROUTER: "on" });
  reset();
  lines.length = 0;
  sent = await quiet(() => N.sendLeadAlertEmail(details()));
  const routed = HUB.routed[0] || {};
  check("on: one /v1/router/lead with this site's source, kind new, the plan's intent and a key from the submission id",
    HUB.routed.length === 1 && routed.source === `${SITE}-form` && routed.kind === "new" && routed.intent === "buyer" &&
    routed.idempotency_key === `${SITE}-form:buyers-guide:sub-6001` && /^[A-Za-z0-9._:-]{8,200}$/.test(routed.idempotency_key) &&
    routed.email === "pat@example.com" && routed.first_name === "Pat", JSON.stringify(routed));
  check("...the alert email still went out, and the result says the router took it", sent.ok === true && HUB.emails.length === 1 &&
    sent.router && sent.router.ok === true);
  check("...no name, email or phone in the log", !lines.some((l) => /pat@example\.com|555|Pat Buyer/.test(l)), lines.join(" | "));
  reset();
  await quiet(() => N.sendLeadAlertEmail(details({ formName: "free-home-valuation", submissionId: "sub-6002" })));
  check("a seller form's intent follows its plan on this site", (HUB.routed[0] || {}).intent === (SITE === "signature" ? "seller_luxury" : "home_value"));
  reset();
  sent = await quiet(() => N.sendLeadAlertEmail(details({ formName: "rent-to-own-options", submissionId: "sub-6006" })));
  const rto = HUB.routed[0] || {};
  check("the rent-to-own form is routed like every other form lead (Christine's lead, 2026-10-23), intent rent_to_own",
    HUB.routed.length === 1 && rto.source === `${SITE}-form` && rto.kind === "new" && rto.intent === "rent_to_own" &&
    rto.idempotency_key === `${SITE}-form:rent-to-own-options:sub-6006` && rto.email === "pat@example.com", JSON.stringify(rto));
  check("...the alert email still went out, and the result says the router took it, nothing skipped",
    sent.ok === true && HUB.emails.length === 1 && sent.router && sent.router.ok === true && !("skipped" in sent.router));
  check("...and it still starts no nurture plan (none until Christine picks one)",
    P.planForSubmission("rent-to-own-options", {}, { site: SITE === "signature" ? "signature" : "main" }).plan === null);
  check("the form intents are rent-to-own's and the cash offer's (they win; any other form sends its plan's intent)",
    JSON.stringify(H.ROUTER_FORM_INTENT) === JSON.stringify({ "rent-to-own-options": "rent_to_own", "cash-offer": "seller_cash" }));
  reset();
  await quiet(() => N.sendLeadAlertEmail(details({ formName: "cash-offer", submissionId: "sub-6009" })));
  check("a cash offer goes to the router as seller_cash (rule NEW-SELLER-CASH), not as its plan's home_value (Christine, 2026-10-23)",
    HUB.routed.length === 1 && HUB.routed[0].intent === "seller_cash" &&
    HUB.routed[0].idempotency_key === `${SITE}-form:cash-offer:sub-6009`, JSON.stringify(HUB.routed));
  check("...and it still starts S2 on this site, like the value forms",
    P.planForSubmission("cash-offer", {}, { site: SITE === "signature" ? "signature" : "main" }).plan === "S2_OPTIONS");
  reset();
  await quiet(() => N.sendLeadAlertEmail(details({ formName: "fsbo-inquiry", submissionId: "sub-6010" })));
  check("the FSBO form goes to the router as seller_fsbo (rule NEW-SELLER-FSBO; it sent no intent before)",
    HUB.routed.length === 1 && HUB.routed[0].intent === "seller_fsbo" &&
    HUB.routed[0].idempotency_key === `${SITE}-form:fsbo-inquiry:sub-6010`, JSON.stringify(HUB.routed));
  reset();
  HUB.routerDown = 503;
  sent = await quiet(() => N.sendLeadAlertEmail(details()));
  check("the router down: the alert email goes out anyway; the router copy is reported, not retried, not in the way",
    sent.ok === true && HUB.emails.length === 1 && sent.router.ok === false);
  reset(null, fakeLofty());
  await submit("buyers-guide", person(), "sub-6003");
  check("through the handler on today's path: exactly one router copy per submission", HUB.routed.length === 1 &&
    HUB.routed[0].idempotency_key === `${SITE}-form:buyers-guide:sub-6003` && OWN.calls.some((c) => c.method === "POST" && c.path === "/leads"));
  reset(null, fakeLofty([{ leadId: 21, emails: ["pat@example.com"] }, { leadId: 22, emails: ["pat@example.com"] }]));
  await submit("buyers-guide", person(), "sub-6004");
  check("...and on the held-for-review path too", HUB.routed.length === 1 && (mem["lofty-manual-review.json"] || []).length === 1);
  reset(null, fakeLofty());
  await submit("rent-to-own-options", person({ message: "hi" }), "sub-6008");
  const rtoCreate = OWN.calls.find((c) => c.method === "POST" && c.path === "/leads");
  check("a rent-to-own submission through the handler: one router copy with intent rent_to_own, the Lofty create as before",
    HUB.routed.length === 1 && HUB.routed[0].intent === "rent_to_own" &&
    HUB.routed[0].idempotency_key === `${SITE}-form:rent-to-own-options:sub-6008` && !!rtoCreate &&
    rtoCreate.body.cannotText === true && !("leadTypes" in rtoCreate.body) &&
    (SITE !== "tllsh" || (rtoCreate.body.tags.includes("Buyer Lead") && rtoCreate.body.tags.includes("Rent-to-Own"))),
    JSON.stringify({ routed: HUB.routed, create: rtoCreate && rtoCreate.body }));
  // A cash offer and an FSBO lead write exactly the same to Lofty with the router copy off and on: the new intents
  // only change what the router is told.
  const loftyWrites = () => ownCalls.filter((c) => c.method !== "GET" && !/\/notes$/.test(c.path)).map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body)}`);
  for (const [form, intent] of [["cash-offer", "seller_cash"], ["fsbo-inquiry", "seller_fsbo"]]) {
    env();
    reset(null, fakeLofty());
    await submit(form, person({ message: "hi" }), "sub-6011");
    const off = loftyWrites();
    const offCreate = OWN.calls.find((c) => c.method === "POST" && c.path === "/leads");
    env({ LEADS_TO_ROUTER: "on" });
    reset(null, fakeLofty());
    await submit(form, person({ message: "hi" }), "sub-6011");
    check(`a ${form} submission through the handler: one router copy with intent ${intent}, the Lofty writes exactly as with the router off`,
      HUB.routed.length === 1 && HUB.routed[0].intent === intent && !!offCreate && offCreate.body.cannotText === true &&
      JSON.stringify(offCreate.body.leadTypes) === "[1]" && off.length > 0 && JSON.stringify(loftyWrites()) === JSON.stringify(off),
      JSON.stringify({ routed: HUB.routed, off, on: loftyWrites() }));
  }
  env({ LEADS_TO_ROUTER: "on", LOFTY_VIA_HUB: "on" });
  reset();
  await submit("buyers-guide", person(), "sub-6005");
  check("...and on the hub path (one router copy, one Lofty push and its plan push)", HUB.routed.length === 1 && HUB.leadPushes().length === 2);

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n7. The vendored toolkit is untouched, and the shared files match the other site's");
  const run = spawnSync(process.execPath, [`${FN_DIR}/lib/suite-kit/check.mjs`], { encoding: "utf8" });
  check("node lib/suite-kit/check.mjs exits 0", run.status === 0 && /suite-kit \d+\.\d+\.\d+/.test(run.stdout), `${run.stdout}${run.stderr}`);
  const hubSrc = fs.readFileSync(`${FN_DIR}/lib/_lofty-hub.js`, "utf8");
  check("lib/_lofty-hub.js names neither site", !/little lady|signature property|thelittleladysellshomes\.com|signaturepropertycollection\.com/i.test(hubSrc));
  check("...and never logs the hub key or the Lofty key", !/console\.[a-z]+\([^)]*(HUB_API_KEY|LOFTY_API_KEY|apiKey)/.test(hubSrc));
  const other = path.join(ROOT, "..", SIBLING, "netlify", "functions", "lib");
  if (fs.existsSync(other)) {
    for (const f of ["_lofty-hub.js", "_lofty-returning.js", "_lofty-consent.js", "_lofty.js", "_form-plans.js"]) {
      check(`lib/${f} is byte-identical to ${SIBLING}'s copy`, fs.readFileSync(path.join(other, f), "utf8") === fs.readFileSync(`${FN_DIR}/lib/${f}`, "utf8"));
    }
    const mine = fs.readdirSync(`${FN_DIR}/lib/suite-kit`).sort();
    const theirs = fs.existsSync(path.join(other, "suite-kit")) ? fs.readdirSync(path.join(other, "suite-kit")).sort() : [];
    check(`lib/suite-kit is the same copy as ${SIBLING}'s`, mine.join() === theirs.join() &&
      mine.every((f) => fs.readFileSync(path.join(other, "suite-kit", f)).equals(fs.readFileSync(`${FN_DIR}/lib/suite-kit/${f}`))));
  } else {
    console.log(`  --   ${SIBLING} checkout not present; skipping the cross-site copy checks`);
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
