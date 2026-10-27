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
//   7. the vendored toolkit copy is untouched (its check.mjs), and the shared files match the other site's;
//   8. (2026-10-24, Christine: "Move each one, let's start with Lofty ... I need everything live") EVERY own-key
//      Lofty call goes through the hub with the switch on, with nothing lost: the home-value address, the form's
//      tags in the create body (only the trigger tag is "added" after the create), the website fields and the
//      search wishes (only on a contact the hub created), the yes to texts, a long note in parts, the plan tag by
//      lead id, the returning contact's Call task + push (POST /v1/lofty/task), her listings reads and the /status
//      probes (POST /v1/lofty/read), and the queue replay with every one of them; the hub's failures queue the
//      lead (never the own key); the Lofty side-by-side comparison does not run.
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
  // Which tags each PUT newly ADDED to a lead (what Lofty counts as "Tag Added", which starts a Smart Plan).
  const tagEvents = [];
  const teamFields = new Set();
  const inquiries = [];
  const tasks = [];
  const listings = [];
  let nextId = 9000;
  const names = (v) => (Array.isArray(v) ? v.map((t) => (typeof t === "string" ? t : t && (t.tagName || t.name))) : []);
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
      if (body && Array.isArray(body.tags)) {
        const before = new Set(names(l.tags));
        const added = names(body.tags).filter((t) => !before.has(t));
        if (added.length) tagEvents.push({ leadId: l.leadId, added });
      }
      Object.assign(l, body);
      return res(200, { lead: l });
    }
    if (method === "POST" && p === "/leads") {
      const id = nextId++;
      // A create keeps the tags it carried (they are on the lead, but Lofty does not count them as "added").
      leads.set(id, { leadId: id, ...body, tags: Array.isArray(body.tags) ? body.tags.slice() : [] });
      return res(200, { leadId: id });
    }
    if (method === "POST" && p === "/notes") { notes.push(body); return res(200, { noteId: 1 }); }
    if (method === "GET" && p === "/me") return res(200, { userId: 1, account: "test" });
    if (/\/v2\.0\/listings\/search$/.test(u.pathname)) {
      return res(200, { listing: listings.map((x) => ({ mlsListingId: x.mlsListingId, mlsOrgId: 1054, agentName: x.agentName })),
        metadata: { totalCount: listings.length, totalPage: 1, hasMore: false } });
    }
    if (method === "GET" && p === "/listing") {
      const ids = String(u.searchParams.get("mlsListingIds") || "").split(",");
      return res(200, { listing: listings.filter((x) => ids.includes(x.mlsListingId)) });
    }
    if (/\/v2\.0\/tasks$/.test(u.pathname)) { tasks.push({ body: init.body }); return res(200, { taskId: 77 }); }
    if (/send-task-reminder$/.test(u.pathname)) return res(200, { message: "ok" });
    if (/listCustomField$/.test(u.pathname)) return res(200, { data: [...teamFields].map((attributeName) => ({ attributeName })) });
    if (/custom-field$/.test(u.pathname)) { if (body && body.attributeName) teamFields.add(body.attributeName); return res(200, {}); }
    if (/\/inquiry$/.test(u.pathname)) { inquiries.push({ leadId: (u.pathname.match(/leads\/(\d+)/) || [])[1], body }); return res(200, {}); }
    return res(404, { message: `unknown route ${method} ${p}` });
  }
  return { fetch, leads, calls, notes, tagEvents, teamFields, inquiries, tasks, listings };
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
  texting_not_enabled: o.textingNotEnabled || null,
  ...(o.property ? { address: o.property } : {}), ...(o.createBodyMerged ? { create_body_merged: true } : {}),
});
const statusOf = (o) => (o.ok ? (o.action === "created" ? "created" : "updated")
  : o.code === "rate_limited" || o.code === "busy" ? "rate_limited" : o.code === "not_configured" ? "not_configured" : "held");

function fakeHub(opts) {
  const o = opts || {};
  const h = {
    lofty: o.lofty || fakeLofty(), lock: o.lock === null ? undefined : (o.lock || kit.createMemoryLeadLock()),
    dnc: new Set(o.dnc || []), optedOut: new Set(o.optedOut || []), requests: [], emails: [], routed: [],
    down: null, routerDown: null, together: null,
    // The hub's switches for the parity options and routes (all on live, 2026-10-24): an option asked while its
    // switch is off is a 503 and nothing is sent, as the real hub answers.
    optionsOff: new Set(o.optionsOff || []), taskOff: false, readOff: false,
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
      // The real hub's /lead (supabase/functions/hub-api/lofty.ts createLeadRoute + doorwayPush), options included.
      const asked = ["address", "custom_fields", "inquiry", "create_tags", "lead_id"].filter((k) => b[k] !== undefined && b[k] !== null);
      const off = asked.filter((k) => h.optionsOff.has(k));
      if (off.length) return res(503, { error: `${off.join(", ")}: switched off at the hub; nothing sent` });
      if (h.refuse400 && b[h.refuse400] !== undefined) return res(400, { error: `${h.refuse400} has the wrong shape` });
      if (b.custom_fields && Object.keys(b.custom_fields).some((k) => !["Website Form", "Website First Page", "Website Form Page", "Website Traffic Source"].includes(k))) {
        return res(400, { error: "custom field(s) this app does not write" });
      }
      h.lastFieldsAsked = b.custom_fields || null;
      const list = h.list(b.email, b.phone);
      const tags = Array.isArray(b.tags) ? b.tags : [];
      const createTags = Array.isArray(b.create_tags) ? kit.createBodyTags(b.create_tags) : [];
      if (list.doNotContact) {
        const out = await kit.applyOptOut({ kind: "do_not_contact", email: b.email, phone: b.phone }, d);
        return res(200, { status: "held", held_by: "do_not_contact", tags_dropped: [...tags, ...createTags], shared_list: list, ...outcomeJson(out) });
      }
      const property = b.address ? kit.leadProperty({ streetAddress: b.address.street, city: b.address.city, state: b.address.state, zipCode: b.address.zip }) : null;
      const byId = b.lead_id !== undefined && b.lead_id !== null ? String(b.lead_id) : null;
      const out = await kit.pushLead({
        lead: { firstName: b.first_name || "", lastName: b.last_name || "", email: b.email, phone: b.phone, source: b.source,
          leadTypes: Array.isArray(b.lead_types) && b.lead_types.length ? b.lead_types : undefined, ...(property ? { property } : {}) },
        tags: list.emailBlocked ? [] : tags, note: b.note, smsConsent: b.sms_yes === true, create: b.create !== false && !byId,
        emailOptOut: list.emailOptOut, ...(byId ? { leadId: byId } : {}), ...(createTags.length && !list.emailBlocked ? { createTags } : {}),
      }, d);
      const extras = {};
      if (b.custom_fields || b.inquiry) {
        const created = out.action === "created" && !out.merged && !out.mergedFrom && !!out.leadId;
        if (created && out.ok) {
          if (b.custom_fields) {
            const have = JSON.stringify(await kit.loftyRequest("GET", "/v1.0/teamFeatures/listCustomField", undefined, d));
            for (const n of Object.keys(b.custom_fields)) {
              if (!have.includes(JSON.stringify(n))) await kit.loftyRequest("POST", "/v1.0/teamFeatures/custom-field", { attributeName: n, attributeType: "text", value: "" }, d);
            }
            await kit.loftyRequest("PUT", `/leads/${out.leadId}`, { customAttributeList: Object.entries(b.custom_fields)
              .map(([attributeName, value]) => ({ attributeName, attributeType: "text", value })) }, d);
            extras.fields = "written";
          }
          if (b.inquiry) { await kit.loftyRequest("POST", `/leads/${out.leadId}/inquiry`, b.inquiry, d); extras.inquiry = "written"; }
        } else {
          const why = created ? "skipped_push_failed" : "skipped_not_new";
          if (b.custom_fields) extras.fields = why;
          if (b.inquiry) extras.inquiry = why;
        }
      }
      const dropped = [...(list.emailBlocked ? [...tags, ...createTags] : []), ...(createTags.length && out.action !== "created" && !list.emailBlocked ? createTags : [])];
      return res(200, { status: statusOf(out), held_by: null, tags_dropped: dropped, shared_list: list, ...outcomeJson(out), ...extras });
    }
    if (route === "/v1/lofty/task") {
      // The real hub's /task (hub-api/lofty-parity.ts taskOnLead): read the lead, hold on Do Not Contact / #dnc /
      // cannotCall / a phone on the shared list / an unreadable lead, else POST /v2.0/tasks and the push.
      if (h.taskOff) return res(503, { error: "this route is switched off (flag lofty_tasks_enabled)" });
      const id = String(b.lead_id == null ? "" : b.lead_id);
      if (!/^\d+$/.test(id) || !b.content) return res(400, { error: "lead_id and content are required" });
      h.lastTask = b;
      let lead;
      try { lead = await kit.getLead(id, d); } catch (e) { return res(200, { status: "failed", reason: "the lead could not be read: no task" }); }
      if (!lead || String(lead.leadId) !== id) return res(200, { status: "held", code: "unreadable", reason: "the read returned another lead or none: no task" });
      const st = kit.consentStatus(lead);
      if (!st.tagsReadable) return res(200, { status: "held", code: "unreadable", reason: "the lead's tag list cannot be read: no task" });
      const onList = st.phones.some((ph) => h.dnc.has(ph)) || st.emails.some((e) => h.dnc.has(kit.normEmail(e)));
      if (st.doNotContact || onList) return res(200, { status: "held", code: "do_not_contact", reason: "Do Not Contact: no task" });
      if (!st.mayCall) return res(200, { status: "held", code: "may_not_call", reason: st.phoneDnc ? "#dnc (no calls or texts): no call task" : "Lofty says do not call (cannotCall): no call task" });
      const due = new Date(Date.now() + (Number(b.due_in_minutes) || 1440) * 60000);
      const raw = JSON.stringify({ type: "Call", content: String(b.content).slice(0, 500), assignedRole: "Agent", endAt: kit.denverIso ? kit.denverIso(due) : due.toISOString(), timeZoneCode: "America/Denver", leadId: "__ID__" }).replace('"__ID__"', id);
      const t = await kit.loftyRequestText("POST", "/v2.0/tasks", raw, d);
      const taskId = (/"taskId"\s*:\s*"?(\d+)"?/.exec(t.text) || [])[1] || null;
      let pushed = null;
      if (b.push_reminder === true && taskId) {
        try { await kit.loftyRequestText("POST", "/v2.0/sales-agent/notification/app-push/send-task-reminder", JSON.stringify({ type: "TASK", taskId: Number(taskId) }), d); pushed = true; } catch (e) { pushed = false; }
      }
      return res(200, { status: "created", lead_id: id, task_id: taskId, pushed, phone_dnc: st.phoneDnc });
    }
    if (route === "/v1/lofty/read") {
      // The real hub's /read (hub-api/lofty-parity.ts readPath): one Lofty read, Lofty's JSON as data.
      if (h.readOff) return res(503, { error: "this route is switched off (flag lofty_reads_enabled)" });
      h.reads = h.reads || [];
      h.reads.push(b);
      let m;
      let path;
      let body;
      if (b.resource === "me") { m = "GET"; path = "/me"; }
      else if (b.resource === "lead") { m = "GET"; path = `/leads/${b.lead_id}`; }
      else if (b.resource === "listings") { m = "GET"; path = `/v1.0/listing?${new URLSearchParams({ mlsListingIds: (b.mls_ids || []).join(","), limit: String(b.limit || 1) })}`; }
      else if (b.resource === "listing_search") {
        m = "POST"; path = "/v2.0/listings/search";
        body = { searchScope: b.search_scope || "my", pageNum: b.page_num || 1, pageSize: b.page_size || 100,
          ...(b.sort_fields ? { sortFields: b.sort_fields } : {}), ...(b.filter_conditions ? { filterConditions: b.filter_conditions } : {}) };
      } else return res(400, { error: "resource must be ..." });
      try {
        const r = await kit.loftyRequestText(m, path, body, d);
        let data = null;
        try { data = r.text ? JSON.parse(r.text) : null; } catch (e) { data = null; }
        return res(200, { status: "ok", http_status: r.status || 200, data });
      } catch (e) {
        return res(200, e && e.status === 404 ? { status: "not_found", http_status: 404 } : { status: "failed", code: (e && e.code) || null, http_status: (e && e.status) || null });
      }
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
  "FLODESK_API_KEY", "LOFTY_QUEUE_DRAIN", "HUB_SIDE_BY_SIDE", "VALUE_REVIEW_PLAN"];
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

// 2026-10-24: with the switch on, NOTHING goes out on this site's own key any more (the hub has a route for every
// call: the Call task, the website fields, the search wishes, the listings reads and the /status probes included).
const coveredOwn = () => ownCalls.slice();

const allHubRequests = [];
function reset(hub, own) {
  allHubRequests.push(...HUB.requests);
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
  check("...the plan tag is NOT in that push (not in tags, not in create_tags)", !first.tags.includes(PLAN_B1) &&
    !(first.create_tags || []).includes(PLAN_B1));
  check("...the form's tags ride IN the create body too, all but the trigger tag (create_tags)",
    Array.isArray(first.create_tags) && ["Website Lead", "buyers-guide"].every((t) => first.create_tags.includes(t)) &&
    !first.create_tags.includes("Hot Lead - Website"), JSON.stringify(first.create_tags));
  // 2026-10-26: the Interest tag (and, on the Signature site, "Signature Property Collection") goes the same way; source "Website".
  const INTEREST_BUYER = `Interest ${EN} Buyer`;
  check(`...its Interest tag ("${INTEREST_BUYER}") rides in the create body (create_tags) and the tags; the source is "Website"`,
    first.create_tags.includes(INTEREST_BUYER) && first.tags.includes(INTEREST_BUYER) && first.source === "Website" &&
    (SITE !== "signature" || (first.create_tags.includes("Signature Property Collection") && first.tags.includes("Signature Property Collection"))),
    JSON.stringify({ tags: first.tags, create_tags: first.create_tags, source: first.source }));
  check("...and the four website fields ride on the push (custom_fields), no address for a form without one",
    first.custom_fields && first.custom_fields["Website Form"] && !first.address && !("sms_yes" in first), JSON.stringify(first.custom_fields));
  const second = pushes[1] || {};
  check("...then the hub's consent route, then a second push with create:false and the plan tag only",
    HUB.routes().indexOf("/v1/lofty/consent") > HUB.routes().indexOf("/v1/lofty/lead") && pushes.length === 2 &&
    second.create === false && JSON.stringify(second.tags) === JSON.stringify([PLAN_B1]) && !second.note && !second.lead_types &&
    second.lead_id === "9000" && !second.create_tags && !second.custom_fields,
    JSON.stringify(HUB.requests.map((x) => [x.route, x.body.create, x.body.tags, x.body.lead_id])));
  const events9000 = HUB.lofty.tagEvents.filter((e) => e.leadId === 9000).map((e) => e.added.join("+"));
  check("...in Lofty only the trigger tag counts as ADDED after the create (its plan starts), then the plan tag -- as today",
    JSON.stringify(events9000) === JSON.stringify(["Hot Lead - Website", PLAN_B1]), JSON.stringify(events9000));
  let made = HUB.lofty.leads.get(9000) || {};
  check("...the new lead carries every tag, the plan tag, its lead type, texting off, and ONE note",
    ["Hot Lead - Website", "Website Lead", "buyers-guide", PLAN_B1].every((t) => tagsOf(made).includes(t)) &&
    JSON.stringify(made.leadTypes) === "[2]" && made.cannotText === true && HUB.lofty.notes.length === 1, JSON.stringify(made));
  check("...the note was not sent a second time (no /v1/lofty/note)", !HUB.routes().includes("/v1/lofty/note"));
  check("...nothing the hub covers went out on this site's own key", coveredOwn().length === 0, JSON.stringify(coveredOwn()));
  check("...the website fields are written by the hub on this proven-new contact (never on the own key)",
    Array.isArray(made.customAttributeList) && made.customAttributeList.some((f) => f.attributeName === "Website Form") &&
    !ownCalls.some((c) => c.method === "PUT"), JSON.stringify(made.customAttributeList));
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
  check(`...its Interest tag is added too ("${INTEREST_BUYER}"), the lead's own tags kept`,
    tagsOf(seven).includes(INTEREST_BUYER) && tagsOf(seven).includes("Buyer"), JSON.stringify(seven.tags));
  check("...the Call task + the push to her phone go through the hub's /v1/lofty/task, nothing on the own key",
    HUB.routes().includes("/v1/lofty/task") && HUB.lofty.calls.some((c) => c.method === "POST" && /\/v2\.0\/tasks$/.test(c.path)) &&
    HUB.lofty.calls.some((c) => /send-task-reminder$/.test(c.path)) && ownCalls.length === 0,
    JSON.stringify({ hub: HUB.routes(), own: ownCalls }));
  check("...the task is the one today's code writes: the lead, due in 30 minutes, the agent's push, the same words",
    HUB.lastTask && HUB.lastTask.lead_id === "7" && HUB.lastTask.due_in_minutes === 30 && HUB.lastTask.push_reminder === true &&
    HUB.lastTask.content === R.taskContent({ label: "Buyer's Guide Download", name: "Pat Buyer", phone: "(970) 555-0123", email: "pat@example.com" }).slice(0, 500),
    JSON.stringify(HUB.lastTask));
  check("...no website fields or search wishes on a returning contact (the hub wrote none)",
    !HUB.lofty.calls.some((c) => c.method === "PUT" && c.body && c.body.customAttributeList) && !HUB.lofty.inquiries.length);
  check("...and nothing the hub covers went out on the own key", coveredOwn().length === 0);

  // 2026-10-26 (Christine: "buyer and seller too"): the homepage "both" choice is Seller AND Buyer. The push carries both
  // types on a new contact and on a returning one; the hub puts them on a create, and adds the missing ones to a lead it
  // finds only once its lofty_lead_types_merge_enabled switch is on (this fake hub is the switch off: today's answer).
  reset();
  await submit("home-lead", person({ looking_to: "both" }), "sub-2010");
  pushes = HUB.leadPushes();
  check("home-lead \"both\", a new contact: the push asks lead_types [1, 2]; the hub creates it Seller AND Buyer, texting off",
    pushes.length >= 1 && JSON.stringify(pushes[0].lead_types) === "[1,2]" && pushes[0].create === true &&
    JSON.stringify((HUB.lofty.leads.get(9000) || {}).leadTypes) === "[1,2]" && (HUB.lofty.leads.get(9000) || {}).cannotText === true,
    JSON.stringify({ push: pushes[0], lead: HUB.lofty.leads.get(9000) }));
  reset(fakeHub({ lofty: fakeLofty([{ leadId: 7, emails: ["pat@example.com"], phones: ["+19705550123"], tags: ["Buyer"], cannotText: true, leadTypes: [2] }]) }));
  await submit("home-lead", person({ looking_to: "both" }), "sub-2011");
  pushes = HUB.leadPushes();
  check("home-lead \"both\", a returning contact: the push still asks lead_types [1, 2] (the hub decides); with its switch off the lead keeps [2]",
    pushes.length === 1 && JSON.stringify(pushes[0].lead_types) === "[1,2]" && JSON.stringify(HUB.lofty.leads.get(7).leadTypes) === "[2]" &&
    ownCalls.length === 0, JSON.stringify({ push: pushes[0], lead: HUB.lofty.leads.get(7) }));

  reset(fakeHub({ lofty: fakeLofty([{ leadId: 8, emails: ["pat@example.com"], phones: ["+19705550123"], tags: [`Consent ${EN} DNC`], cannotText: true }]) }));
  await submit("buyers-guide", person(), "sub-2003");
  const eight = HUB.lofty.leads.get(8);
  check("a returning Do Not Contact lead: the hub holds every tag (Do Not Contact wins)",
    tagsOf(eight).join() === `Consent ${EN} DNC`, JSON.stringify(eight.tags));
  check("...no plan push, no Call task (the hub held it: Do Not Contact), nothing at all on the own key",
    HUB.leadPushes().length === 1 && ownCalls.length === 0 && !HUB.lofty.calls.some((c) => /\/v2\.0\/tasks$/.test(c.path)), JSON.stringify(ownCalls));

  // #dnc = phone only (calls/texts); email still allowed — Christine 2026-10-18
  reset(fakeHub({ lofty: fakeLofty([{ leadId: 18, emails: ["pat@example.com"], phones: ["+19705550123"], tags: ["#dnc"], cannotText: false }]) }));
  await submit("buyers-guide", person(), "sub-2013");
  const eighteen = HUB.lofty.leads.get(18);
  check("a returning #dnc lead (phone only): the form's tags go on, #dnc stays, texting is switched off",
    ["#dnc", "Hot Lead - Website", "buyers-guide"].every((t) => tagsOf(eighteen).includes(t)) && eighteen.cannotText === true,
    JSON.stringify(eighteen));
  check("...but no Call task (the hub's task route holds it: #dnc, may not be called), nothing on the own key",
    HUB.routes().includes("/v1/lofty/task") && !HUB.lofty.calls.some((c) => /\/v2\.0\/tasks$/.test(c.path)) && ownCalls.length === 0, JSON.stringify(ownCalls));

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
  check("a rent-to-own submission through the handler: one router copy with intent rent_to_own, the Lofty create typed Buyer (Oct 26)",
    HUB.routed.length === 1 && HUB.routed[0].intent === "rent_to_own" &&
    HUB.routed[0].idempotency_key === `${SITE}-form:rent-to-own-options:sub-6008` && !!rtoCreate &&
    rtoCreate.body.cannotText === true && JSON.stringify(rtoCreate.body.leadTypes) === "[2]" &&
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
  console.log("\n8. Every own-key Lofty call through the hub (2026-10-24): the same effect, nothing on the own key");
  env({ LOFTY_VIA_HUB: "on" });
  const SITE_KEY = SITE === "signature" ? "signature" : "main";
  const planOf = (form, data) => P.planForSubmission(form, data || {}, { site: SITE_KEY, valueReviewPlan: false });
  const lastLeadPush = () => HUB.leadPushes().filter((x) => x.create !== false).slice(-1)[0] || {};
  const HOME = "4821 Elm Street, Loveland, CO 80537";
  const seedPat = (extra) => fakeLofty([{ leadId: 7, emails: ["pat@example.com"], phones: ["+19705550123"], tags: ["Buyer"], cannotText: true, ...(extra || {}) }]);

  // a. The home-value address (lib/_lead-address.js -> Lofty's `property`).
  reset();
  await submit("free-home-valuation", person({ address: HOME }), "sub-8001");
  let p8 = lastLeadPush();
  made = HUB.lofty.leads.get(9000) || {};
  check("the home-value form: the address rides on the push (address: street, city, state, zip)",
    p8.address && p8.address.street === "4821 Elm Street" && p8.address.city === "Loveland" && p8.address.state === "CO" && p8.address.zip === "80537",
    JSON.stringify(p8.address));
  check("...and lands as Lofty's property on the new lead, as today's create sends it",
    made.property && made.property.streetAddress === "4821 Elm Street" && made.property.city === "Loveland" && made.property.zipCode === "80537",
    JSON.stringify(made.property));
  const fhv = planOf("free-home-valuation");
  check("...the form's plan tag(s) go on after the create, every create texting-off, nothing on the own key",
    fhv.planTags.length > 0 && fhv.planTags.every((t) => tagsOf(made).includes(t)) && made.cannotText === true && ownCalls.length === 0,
    JSON.stringify({ plan: fhv.planTags, tags: made.tags, own: ownCalls }));
  reset(fakeHub({ lofty: seedPat() }));
  await submit("free-home-valuation", person({ address: HOME }), "sub-8002");
  check("...a returning contact with no address on file gets it filled (blanks only)",
    (HUB.lofty.leads.get(7).property || {}).streetAddress === "4821 Elm Street", JSON.stringify(HUB.lofty.leads.get(7).property));
  reset(fakeHub({ lofty: seedPat({ property: { streetAddress: "9 Other Rd", city: "Berthoud", zipCode: "80513" } }) }));
  await submit("free-home-valuation", person({ address: HOME }), "sub-8003");
  check("...and one with another address keeps it (never overwritten)",
    HUB.lofty.leads.get(7).property.streetAddress === "9 Other Rd", JSON.stringify(HUB.lofty.leads.get(7).property));

  // b. The search wishes (Lofty's inquiry) and the website fields, on a contact proven new.
  reset();
  const alertData = person({ alert_criteria: "Loveland, 3+ beds", alert_query: "city=Loveland&minPrice=400000&maxPrice=650000&beds=3",
    attribution_first_page: "/search-homes.html", attribution_form_page: "/search-homes.html", utm_source: "google" });
  await submit("listing-alert-request", alertData, "sub-8004");
  p8 = lastLeadPush();
  made = HUB.lofty.leads.get(9000) || {};
  const wantInquiry = R.inquiryFromForm(alertData);
  check("a saved-search form: the search wishes ride on the push (inquiry), exactly what today's code sends",
    JSON.stringify(p8.inquiry) === JSON.stringify(wantInquiry) && wantInquiry.priceMin === 400000 && wantInquiry.bedroomsMin === 3, JSON.stringify(p8.inquiry));
  check("...and the hub writes them on the contact it created (POST /leads/9000/inquiry)",
    HUB.lofty.inquiries.length === 1 && HUB.lofty.inquiries[0].leadId === "9000" &&
    JSON.stringify(HUB.lofty.inquiries[0].body) === JSON.stringify(wantInquiry), JSON.stringify(HUB.lofty.inquiries));
  // 2026-10-26: the lead's Lofty source is "Website"; the "Website Form" field keeps the form's long label.
  check("...the push's Lofty source is \"Website\"", p8.source === "Website", JSON.stringify(p8.source));
  const wantFields = R.websiteFieldValues(SITE === "signature" ? "Signature Property Collection - Listing Alert Request (saved search)"
    : "The Little Lady Sells Homes - Listing Alert Request (saved search)", alertData);
  check("...the four website fields too: the same names and values today's code writes",
    JSON.stringify(Object.entries(p8.custom_fields || {})) === JSON.stringify(wantFields.map((f) => [f.attributeName, f.value])) &&
    JSON.stringify((made.customAttributeList || []).map((f) => [f.attributeName, f.value])) === JSON.stringify(wantFields.map((f) => [f.attributeName, f.value])),
    JSON.stringify({ ask: p8.custom_fields, lead: made.customAttributeList }));
  lastPush = mem["lofty-last-push.json"] || {};
  check("...and /status records both as written through the hub",
    lastPush.fieldsResult && lastPush.fieldsResult.ok === true && lastPush.fieldsResult.viaHub === true &&
    lastPush.inquiryResult && lastPush.inquiryResult.ok === true && lastPush.inquiryResult.viaHub === true,
    JSON.stringify({ f: lastPush.fieldsResult, i: lastPush.inquiryResult }));
  check("...nothing on the own key", ownCalls.length === 0, JSON.stringify(ownCalls));
  reset(fakeHub({ lofty: seedPat() }));
  await submit("listing-alert-request", alertData, "sub-8005");
  lastPush = mem["lofty-last-push.json"] || {};
  check("a returning contact: no website fields and no search wishes written (proven-new rule), /status says why",
    !HUB.lofty.inquiries.length && !(HUB.lofty.leads.get(7).customAttributeList) &&
    lastPush.fieldsResult.attempted === false && /created/.test(lastPush.fieldsResult.reason || "") && lastPush.inquiryResult.attempted === false,
    JSON.stringify({ f: lastPush.fieldsResult, i: lastPush.inquiryResult }));

  // c. A create Lofty folded into another lead: not proven new.
  reset();
  HUB.down = { status: "created", ok: true, lead_id: "9100", action: "created", merged: true, note_added: true, tags_added: [],
    needs_review: true, create_body_merged: true };
  await submit("buyers-guide", person(), "sub-8006");
  lastPush = mem["lofty-last-push.json"] || {};
  check("a create Lofty folded into another lead (merged): no plan-tag push, no consent read, plan skipped with the reason",
    HUB.leadPushes().length === 1 && !HUB.routes().includes("/v1/lofty/consent") && lastPush.planResult &&
    /own id/.test(lastPush.planResult.skipped || ""), JSON.stringify({ routes: HUB.routes(), plan: lastPush.planResult }));
  HUB.down = null;

  // d. The yes to texts.
  reset();
  await submit("buyers-guide", person({ sms_consent: "yes" }), "sub-8007");
  p8 = lastLeadPush();
  made = HUB.lofty.leads.get(9000) || {};
  if (SITE === "tllsh") {
    check("a yes to texts rides on the push (sms_yes): the hub decides and records it in the same note -- ONE note, no second call",
      p8.sms_yes === true && HUB.lofty.notes.length === 1 && /10DLC campaign 12744/.test(HUB.lofty.notes[0].content) &&
      /SMS consent: YES/.test(HUB.lofty.notes[0].content) && !HUB.routes().includes("/v1/lofty/note"), JSON.stringify(HUB.lofty.notes));
  } else {
    check("this site reads no texting yes (its boxes are required): no sms_yes on the push", !("sms_yes" in p8), JSON.stringify(p8));
  }
  check("...texting stays off and the SMS consent tag is never added", made.cannotText === true &&
    !tagsOf(made).some((t) => kit.isSmsConsentTag(t)) && ownCalls.length === 0, JSON.stringify(made));

  // e. A long note goes in parts; nothing is cut.
  reset();
  const longMsg = `Start ${"x".repeat(6200)} end of message`;
  await submit("contact", person({ message: longMsg }), "sub-8008");
  const parts8 = HUB.lofty.notes.map((n) => n.content);
  check("a note longer than the hub keeps (5,000) goes in parts: the push carries the first, /v1/lofty/note the rest",
    (lastLeadPush().note || "").length <= 5000 && HUB.routes().filter((r) => r === "/v1/lofty/note").length === 1 && parts8.length === 2 &&
    /^\(note continued, part 2 of 2\)\n/.test(parts8[1] || ""), JSON.stringify(parts8.map((x) => x.length)));
  const whole8 = parts8[0] + (parts8[1] || "").replace(/^\(note continued, part 2 of 2\)\n/, "");
  check("...and nothing is lost: the whole message and the note's last line are in Lofty",
    whole8.includes(longMsg) && (SITE !== "tllsh" || /Terms\/Privacy box: NOT ticked on this submission$/.test(parts8[1] || "")), whole8.slice(-80));

  // f. The returning contact's Call task: what it does when the hub holds it, and when its route is off.
  reset(fakeHub({ lofty: seedPat({ cannotCall: true }) }));
  await submit("buyers-guide", person(), "sub-8009");
  lastPush = mem["lofty-last-push.json"] || {};
  check("a returning contact Lofty says not to call: the hub holds the task (may not call), nothing on the own key",
    !HUB.lofty.tasks.length && lastPush.tagResult && lastPush.tagResult.task && lastPush.tagResult.task.step === "may-not-call" && ownCalls.length === 0,
    JSON.stringify(lastPush.tagResult));
  reset(fakeHub({ lofty: seedPat() }));
  HUB.taskOff = true;
  await submit("buyers-guide", person(), "sub-8010");
  lastPush = mem["lofty-last-push.json"] || {};
  check("the hub's task route switched off: the lead is still pushed, the task is reported failed (HTTP 503), never sent on the own key",
    lastPush.ok === true && lastPush.tagResult && lastPush.tagResult.task && lastPush.tagResult.task.ok === false &&
    /503/.test(lastPush.tagResult.task.error || "") && ownCalls.length === 0, JSON.stringify(lastPush.tagResult));

  // g. A parity option switched off at the hub: the push is refused (503) and queued with the reason.
  reset(fakeHub({ optionsOff: ["custom_fields"] }));
  await submit("buyers-guide", person(), "sub-8011");
  let q8 = mem["lofty-failed-pushes.json"] || [];
  check("an option switched off at the hub: nothing created, the lead queued (not held) with the reason, nothing on the own key",
    q8.length === 1 && /switched off/.test(q8[0].responseBody || "") && !(mem["lofty-manual-review.json"] || []).length &&
    HUB.lofty.leads.size === 0 && ownCalls.length === 0, JSON.stringify(q8[0] && q8[0].responseBody));

  // h. The queue replay carries every option, and the returning contact's task.
  reset();
  HUB.down = 503;
  const fhvData = person({ address: HOME, attribution_first_page: "/sellers.html", utm_source: "google" });
  await submit("free-home-valuation", fhvData, "sub-8012");
  HUB.down = null;
  dr = await quiet(() => L.drainFailedPushes(store, "own-key-for-tests", { deadline: Date.now() + 20000 }));
  p8 = lastLeadPush();
  made = HUB.lofty.leads.get(9000) || {};
  check("the queue replay through the hub: the address, the create-body tags (not the trigger tag) and the website fields ride along",
    dr.recovered === 1 && p8.address && p8.address.street === "4821 Elm Street" && Array.isArray(p8.create_tags) &&
    !p8.create_tags.includes("Hot Lead - Website") && p8.custom_fields && p8.custom_fields["Website First Page"] === "/sellers.html",
    JSON.stringify({ dr, p8 }));
  check("...the new lead gets its property, fields, the trigger tag after the create and its plan tag(s); nothing on the own key",
    made.property && made.property.streetAddress === "4821 Elm Street" && Array.isArray(made.customAttributeList) &&
    fhv.planTags.every((t) => tagsOf(made).includes(t)) &&
    JSON.stringify(HUB.lofty.tagEvents.filter((e) => e.leadId === 9000)[0]) === JSON.stringify({ leadId: 9000, added: ["Hot Lead - Website"] }) &&
    !(mem["lofty-failed-pushes.json"] || []).length && ownCalls.length === 0, JSON.stringify({ tags: made.tags, events: HUB.lofty.tagEvents }));
  reset(fakeHub({ lofty: seedPat() }));
  HUB.down = 503;
  await submit("buyers-guide", person(), "sub-8013");
  HUB.down = null;
  dr = await quiet(() => L.drainFailedPushes(store, "own-key-for-tests", { deadline: Date.now() + 20000 }));
  check("the queue replay of a returning contact: its Call task + push through the hub's /v1/lofty/task, nothing on the own key",
    dr.recovered === 1 && HUB.lofty.tasks.length === 1 && HUB.routes().includes("/v1/lofty/task") && ownCalls.length === 0,
    JSON.stringify({ dr, routes: HUB.routes() }));
  check("...sent as \"Website\", its Call task named for the form's long label (2026-10-26)",
    lastLeadPush().source === "Website" && HUB.lastTask && HUB.lastTask.content === R.taskContent({
      label: `${SITE === "signature" ? "Signature Property Collection - " : ""}Buyer's Guide Download (queued retry)`,
      name: "Pat Buyer", phone: "(970) 555-0123", email: "pat@example.com" }).slice(0, 500),
    JSON.stringify({ source: lastLeadPush().source, task: HUB.lastTask }));
  // A contact the hub matched that this site's own lookup did not name (a phone-only match, say): its Call task comes
  // from what the push remembered, which is the long label, never "Website".
  reset(fakeHub({ lofty: seedPat() }));
  await quiet(() => L.postLead({ firstName: "Pat", emails: ["pat@example.com"], source: "Website", tags: ["Website Lead"], notes: "hi" },
    "own-key-for-tests", { deadline: deadline(), sourceLabel: "The Little Lady Sells Homes - Buyer's Guide Download" }));
  const ap = H.afterPush("7");
  check("the hub path's returning-contact Call task reads the long label (sourceLabel), not the source \"Website\"",
    ap.kind === "returning" && ap.details && ap.details.label === "Buyer's Guide Download", JSON.stringify(ap));

  // i. Her listings reads (lib/_lofty-listings.js) through POST /v1/lofty/read.
  const LL = require(`${FN_DIR}/lib/_lofty-listings.js`);
  reset();
  HUB.lofty.listings.push({ mlsListingId: "IRE1234567", agentName: "Christine Gwinnup" });
  const page8 = await quiet(() => LL.searchPage({ apiKey: "own-key-for-tests", scope: "my", pageNum: 1 }));
  const det8 = await quiet(() => LL.detailsByMlsIds(["IRE1234567"], { apiKey: "own-key-for-tests" }));
  const reads8 = HUB.reads || [];
  check("her listings search goes to the hub as listing_search (scope my, 100 a page, the same sort), Lofty's answer read as today",
    page8.items.length === 1 && page8.items[0].mlsListingId === "IRE1234567" && reads8[0] && reads8[0].resource === "listing_search" &&
    reads8[0].search_scope === "my" && reads8[0].page_size === 100 && JSON.stringify(reads8[0].sort_fields) === JSON.stringify(["MLS_LIST_DATE_L_DESC"]),
    JSON.stringify(reads8));
  check("...the details as listings (the MLS numbers, the same limit), nothing on the own key",
    det8.get("IRE1234567") && reads8[1] && reads8[1].resource === "listings" && JSON.stringify(reads8[1].mls_ids) === JSON.stringify(["IRE1234567"]) &&
    reads8[1].limit === 1 && ownCalls.length === 0, JSON.stringify({ reads8, own: ownCalls }));
  HUB.readOff = true;
  let threw8 = null;
  await quiet(() => LL.searchPage({ apiKey: "own-key-for-tests", scope: "my", pageNum: 1 }).catch((e) => { threw8 = e; }));
  check("...the hub's read switched off: the read fails like a Lofty failure (kept data stays), never the own key",
    threw8 && threw8.httpStatus === 503 && ownCalls.length === 0, String(threw8 && threw8.message));
  env();
  reset();
  OWN.listings.push({ mlsListingId: "IRE1234567", agentName: "Christine Gwinnup" });
  await quiet(() => LL.searchPage({ apiKey: "own-key-for-tests", scope: "my", pageNum: 1 }));
  check("...with the switch off the search goes to Lofty as before (own key), not to the hub",
    ownCalls.length === 1 && ownCalls[0].path === "/v2.0/listings/search" && !(HUB.reads || []).length, JSON.stringify(ownCalls));
  env({ LOFTY_VIA_HUB: "on" });

  // j. The /status probes (site-health.js) through POST /v1/lofty/read: me, and the last lead read back.
  reset();
  await submit("buyers-guide", person(), "sub-8014");
  ownCalls = [];
  HUB.reads = [];
  const fetchKeep = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://hub.example.test/") || u.startsWith("https://api.lofty.com/")) return fetchKeep(url, init);
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}", headers: { get: () => "application/json" } };
  };
  let healthRes = null;
  try {
    // The Little Lady copy exports localHandler (lib/_backend-mode.js decides who answers); Signature, handler.
    const healthMod = require(`${FN_DIR}/site-health.js`);
    const health = healthMod.localHandler || healthMod.handler;
    healthRes = await quiet(() => health({ queryStringParameters: { format: "json", probe: "1" } }));
  } finally {
    global.fetch = fetchKeep;
  }
  let keyRow = null;
  try { keyRow = JSON.parse(healthRes.body).checks.find((c) => c.name === "Lofty API key valid"); } catch (e) { keyRow = null; }
  check("/status probes through the hub: /me as resource me, the last lead as resource lead, nothing on the own key",
    HUB.reads.some((x) => x.resource === "me") && HUB.reads.some((x) => x.resource === "lead" && x.lead_id === "9000") &&
    !ownCalls.length, JSON.stringify({ reads: HUB.reads, own: ownCalls }));
  check("...and the key row says Lofty answered through the hub", keyRow && keyRow.ok === true &&
    /through the Seller Intelligence hub/.test(keyRow.detail || ""), JSON.stringify(keyRow));

  // k. With the switch on, the Lofty side-by-side comparison does not run (the site already goes through the hub).
  const SBS = require(`${FN_DIR}/lib/_hub-side-by-side.js`);
  check("the side-by-side check is inert with LOFTY_VIA_HUB on (no dry run, no ledger row)",
    SBS.leadSideBySide({ env: { HUB_SIDE_BY_SIDE: "lofty_write", LOFTY_VIA_HUB: "on", HUB_API_URL: HUB_URL, HUB_API_KEY: HUB_KEY }, log: () => {} }).active === false);
  env({ LOFTY_VIA_HUB: "on", HUB_SIDE_BY_SIDE: "lofty_write" });
  reset();
  await submit("buyers-guide", person(), "sub-8015");
  check("...through the handler: no dry_run asked and nothing posted to the parity ledger",
    !HUB.requests.some((x) => x.body && "dry_run" in x.body) && !HUB.routes().includes("/v1/parity/record"), JSON.stringify(HUB.routes()));
  const sample = { body: { firstName: "Pat", emails: ["pat@example.com"], phones: ["(970) 555-0123"], source: "s", tags: ["Hot Lead - Website", "Website Lead"],
    notes: "n", property: { streetAddress: "1 A St", zipCode: "80537" } }, plan: { leadTypes: [2] }, data: alertData, label: "L",
    triggerTag: "Hot Lead - Website", property: { streetAddress: "1 A St", zipCode: "80537" } };
  check("...and the dry run it used to ask is built by the same builder the real push uses (lib/_lofty-hub.js leadAskFor)",
    JSON.stringify(SBS._internal.buildLeadAsk(sample, sample.body.tags)) === JSON.stringify(H.leadAskFor(sample.body, {
      triggerTag: "Hot Lead - Website", leadTypes: [2], note: "n",
      websiteFields: R.websiteFieldValues("L", alertData), inquiry: R.inquiryFromForm(alertData) })));
  env({ LOFTY_VIA_HUB: "on" });

  // m. The note splitter, at its edges.
  check("a note of exactly 5,000 characters goes whole; 5,001 goes in two parts, none over 5,000, nothing lost",
    H.noteParts("y".repeat(5000)).length === 1 && H.noteParts("y".repeat(5001)).length === 2 &&
    H.noteParts("y".repeat(12000)).every((x) => x.length <= 5000) &&
    H.noteParts("y".repeat(12000)).map((x, i) => (i ? x.replace(/^\(note continued, part \d of \d\)\n/, "") : x)).join("") === "y".repeat(12000));
  const lined = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
  check("...cut at a line break when one is near (the line break dropped, every character of text kept)",
    H.noteParts(lined).length === 2 && H.noteParts(lined)[0] === "a".repeat(3000) && H.noteParts(lined)[1].endsWith("b".repeat(3000)));

  // n. Today's path is unchanged with the switch off: the own key does every step, the hub's Lofty routes are not asked.
  env();
  reset(null, fakeLofty());
  await submit("listing-alert-request", alertData, "sub-8016");
  const offPaths = ownCalls.map((c) => `${c.method} ${c.path.replace(/\d{3,}/g, "N")}`);
  check("switch off: the lookup, create, note, re-fire, plan tag, website fields and search wishes all on the own key, as before",
    ["GET /v1.0/leads", "POST /v1.0/leads", "POST /v1.0/notes", "PUT /v1.0/leads/N", "POST /v1.0/leads/N/inquiry"].every((k) => offPaths.includes(k)) &&
    ownCalls.some((c) => c.method === "PUT" && c.body && Array.isArray(c.body.customAttributeList)) &&
    !HUB.routes().some((r) => r.startsWith("/v1/lofty/")), JSON.stringify({ own: offPaths, hub: HUB.routes() }));
  const offCreate = ownCalls.find((c) => c.method === "POST" && c.path === "/v1.0/leads");
  check("...the own-key create is today's: cannotText:true, the form's tags (trigger tag included) in the body",
    offCreate && offCreate.body.cannotText === true && offCreate.body.tags.includes("Hot Lead - Website"), JSON.stringify(offCreate && offCreate.body));
  env({ LOFTY_VIA_HUB: "on" });

  // o. Never stuck in the queue for an option: odd search values are left out; a push the hub refuses as malformed
  // (HTTP 400) for an option is asked once more without the options (today's path does the same with Lofty).
  check("search values the hub would refuse are left out of the push (the note keeps them)",
    JSON.stringify(H.hubInquiry({ priceMin: 5e9, priceMax: 600000, bedroomsMin: 99, locations: [{ city: "Loveland", state: "CO" }, { city: "Fort Collins 2", state: "CO" }] })) ===
    JSON.stringify({ locations: [{ city: "Loveland", state: "CO" }], priceMax: 600000 }) && H.hubInquiry({ priceMin: 5e9 }) === null);
  reset();
  HUB.refuse400 = "custom_fields";
  await submit("free-home-valuation", person({ address: HOME }), "sub-8017");
  const refusedPushes = HUB.leadPushes().filter((x) => x.create !== false);
  made = HUB.lofty.leads.get(9000) || {};
  lastPush = mem["lofty-last-push.json"] || {};
  check("a push refused as malformed (400) for an option: asked once more without the options, the lead created, not queued",
    refusedPushes.length === 2 && refusedPushes[0].custom_fields && !refusedPushes[1].custom_fields && !refusedPushes[1].address &&
    !refusedPushes[1].create_tags && HUB.lofty.leads.size === 1 && made.cannotText === true && !(mem["lofty-failed-pushes.json"] || []).length &&
    lastPush.ok === true && /without/.test(lastPush.payloadShape || "") && ownCalls.length === 0, JSON.stringify({ shape: lastPush.payloadShape, n: refusedPushes.length }));
  check("...and /status says the fields were not written (they are in the note)",
    lastPush.fieldsResult && lastPush.fieldsResult.attempted === false && /note/.test(lastPush.fieldsResult.reason || ""), JSON.stringify(lastPush.fieldsResult));

  // l. Never a Do Not Contact tag, never the SMS consent tag, from this site, on any push above.
  const sentTags = allHubRequests.concat(HUB.requests).filter((x) => x.route === "/v1/lofty/lead")
    .flatMap((x) => [].concat(x.body.tags || [], x.body.create_tags || []));
  check("no push from this site ever carried a Do Not Contact / #dnc / opt-out tag or the SMS consent tag",
    sentTags.length > 0 && !sentTags.some((t) => kit.isDncTag(t) || kit.isDoNotContactTag(t) || kit.isSmsConsentTag(t) || /opted\s*out/i.test(t)),
    JSON.stringify(sentTags.filter((t) => kit.isDncTag(t) || kit.isSmsConsentTag(t))));

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n9. With the switch on, this site's own Lofty key is not needed at all (2026-10-26)");
  env({ LOFTY_VIA_HUB: "on" });
  delete process.env.LOFTY_API_KEY;
  reset();
  await submit("buyers-guide", person(), "sub-9001");
  check("no LOFTY_API_KEY: the form's lead still goes to the hub (the push, then its plan tag), nothing on api.lofty.com",
    HUB.leadPushes().length >= 1 && HUB.leadPushes()[0].email === "pat@example.com" && HUB.leadPushes()[0].create === true &&
    ownCalls.length === 0,
    JSON.stringify({ hub: HUB.routes(), own: ownCalls }));
  reset();
  HUB.down = 503;
  await submit("buyers-guide", person(), "sub-9002");
  check("...a lead the hub could not take is queued as before", (mem["lofty-failed-pushes.json"] || []).length === 1);
  HUB.down = null;
  const dr9 = await quiet(() => L.drainFailedPushes(store, undefined, { deadline: Date.now() + 20000 }));
  check("...and the queue replay runs without the key, through the hub", dr9.recovered === 1 &&
    !(mem["lofty-failed-pushes.json"] || []).length && ownCalls.length === 0, JSON.stringify(dr9));
  const LL9 = require(`${FN_DIR}/lib/_lofty-listings.js`);
  const mine9 = await quiet(() => LL9.runMineSync({ store, apiKey: undefined, manual: false, deadline: Date.now() + 20000 }).catch((e) => ({ threw: String(e && e.message) })));
  check("...her listings refresh is not skipped for the missing key", !(mine9 && mine9.skipped === "LOFTY_API_KEY is not set"), JSON.stringify(mine9));
  env({ LOFTY_VIA_HUB: "off" });
  delete process.env.LOFTY_API_KEY;
  reset();
  await submit("buyers-guide", person(), "sub-9003");
  check("switch off and no key: nothing is pushed anywhere (today's rule, unchanged)", HUB.leadPushes().length === 0 && ownCalls.length === 0);
  const dr9off = await quiet(() => L.drainFailedPushes(store, undefined, { deadline: Date.now() + 20000 }));
  check("...and the queue waits", dr9off.attempted === 0);
  env();

  // ------------------------------------------------------------------------------------------------------------
  console.log("\n7. The vendored toolkit is untouched, and the shared files match the other site's");
  const run = spawnSync(process.execPath, [`${FN_DIR}/lib/suite-kit/check.mjs`], { encoding: "utf8" });
  check("node lib/suite-kit/check.mjs exits 0", run.status === 0 && /suite-kit \d+\.\d+\.\d+/.test(run.stdout), `${run.stdout}${run.stderr}`);
  const hubSrc = fs.readFileSync(`${FN_DIR}/lib/_lofty-hub.js`, "utf8");
  check("lib/_lofty-hub.js names neither site", !/little lady|signature property|thelittleladysellshomes\.com|signaturepropertycollection\.com/i.test(hubSrc));
  check("...and never logs the hub key or the Lofty key", !/console\.[a-z]+\([^)]*(HUB_API_KEY|LOFTY_API_KEY|apiKey)/.test(hubSrc));
  const other = path.join(ROOT, "..", SIBLING, "netlify", "functions", "lib");
  if (fs.existsSync(other)) {
    for (const f of ["_lofty-hub.js", "_lofty-returning.js", "_lofty-consent.js", "_lofty.js", "_form-plans.js", "_hub-side-by-side.js", "_lofty-listings.js"]) {
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
