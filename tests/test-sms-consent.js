// Texting consent: no website lead is textable in Lofty unless they said yes.
//
// 2026-09-30 (urgent consent fix). Every website lead gets "Hot Lead - Website",
// which starts her Smart Plan -- and the create call never set Lofty's texting
// switch, so leads who never agreed to texts were textable. This pins
// Christine's consent rule (the Command Center's lib/lofty-lead-update.js and
// lib/quiz-lead.js) through the real form handler and the real queue replay.
//
// On THIS site no form posts a texting consent (each consent box is required
// and has no name), so every lead is created with cannotText:true and nothing
// here ever turns texting on. The queue replay (sync-listings.js) is shared with
// The Little Lady site's leads when both read one Blobs store, so it carries the
// full rule: a recorded yes, every phone on the lead the consented number, tags
// read and merged (never replaced), missing tags = nothing written.
//
// Nothing here calls Lofty: fetch is a fake Lofty that records every request.
"use strict";
process.exitCode = 1;
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// Spelled out here (not imported) so this suite runs, and fails, against code
// that doesn't know the rule yet. EN DASH, as the Command Center writes it.
const CONSENT_TAG = "Consent – SMS Opt-In";
const HOT = "Hot Lead - Website";
const NEWID = "1149000000000001";
const EXISTING = "1148639689762408";

function resp(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}

// A fake Lofty. leads[id] is what GET /v1.0/leads/{id} answers, wrapped as
// { data } (what lib/_notify.js reads) unless wrap: "lead"; a PUT replaces the
// fields it carries, as Lofty's does. Anything else answers 404.
function fakeLofty({ leads = {}, emailHits = [], phoneHits = [], searchStatus = 200, createId = NEWID, createStatus = 200, createStatuses = null, wrap = "data" } = {}) {
  const f = { calls: [], posts: [], puts: [], leads: JSON.parse(JSON.stringify(leads)) };
  let creates = 0;
  f.fetch = async (url, init = {}) => {
    const s = String(url); const m = init.method || "GET";
    const path = s.replace(/^https:\/\/api\.(lofty|resend)\.com/, "").split("?")[0];
    f.calls.push(`${m} ${path}`);
    if (/resend\.com/.test(s)) return resp(200, { id: "e1" });
    if (m === "GET" && /\/v1\.0\/leads\?/.test(s)) {
      if (searchStatus !== 200) return resp(searchStatus, "down");
      return resp(200, { leads: /email=/.test(s) ? emailHits : phoneHits });
    }
    if (m === "POST" && /\/v1\.0\/leads$/.test(s)) {
      f.posts.push(JSON.parse(init.body));
      const st = createStatuses ? createStatuses[creates] : createStatus;
      creates++;
      return st === 200 ? resp(200, `{"data":{"leadId": ${createId}}}`) : resp(st, "bad shape");
    }
    if (/\/notes$/.test(s)) {
      const id = String(JSON.parse(init.body).leadId);
      return f.leads[id] ? resp(200, "{}") : resp(404, { message: "errorCode=20006,errorMsg=Lead not exist" });
    }
    if (/\/v2\.0\/tasks$/.test(s)) return resp(200, `{"taskId": 77}`);
    if (/send-task-reminder$/.test(s)) return resp(200, { message: "ok" });
    if (/listCustomField/.test(s)) return resp(200, { data: [] });
    if (/custom-field$/.test(s)) return resp(200, "{}");
    if (/\/inquiry$/.test(s)) return resp(200, "{}");
    const one = s.match(/\/v1\.0\/leads\/(\d+)$/);
    if (one && m === "GET") {
      const l = f.leads[one[1]];
      if (!l) return resp(404, { message: "errorCode=20006,errorMsg=Lead not exist" });
      const lead = { leadId: Number(one[1]), ...l };
      return resp(200, wrap === "lead" ? { lead } : { data: lead });
    }
    if (one && m === "PUT") {
      const body = JSON.parse(init.body);
      f.puts.push({ id: one[1], body });
      if (f.leads[one[1]]) Object.assign(f.leads[one[1]], body);
      return resp(200, "{}");
    }
    return resp(404, `unexpected ${m} ${s}`);
  };
  return f;
}

// The handler, with Blobs faked in memory.
const mem = {};
const pushes = [];
require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
  getStore: () => ({
    get: async (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : null),
    setJSON: async (k, v) => { if (k === "lofty-last-push.json") pushes.push(v); mem[k] = JSON.parse(JSON.stringify(v)); return { modified: true }; },
    delete: async (k) => { delete mem[k]; },
    list: async () => ({ blobs: [] }),
  }),
} };
for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
process.env.LOFTY_API_KEY = "k";
process.env.RESEND_API_KEY = "r";
delete process.env.FLODESK_API_KEY;
const handler = require(`${FN_DIR}/submission-created.js`).handler;
const L = require(`${FN_DIR}/lib/_lofty.js`);

const event = (data, form = "contact") => ({ body: JSON.stringify({ payload: { form_name: form, data } }) });
const person = (extra) => ({ name: "Pat Buyer", email: "pat@example.com", phone: "(970) 555-0100", message: "Hi", ...extra });
const textingOn = (f) => f.puts.filter((p) => p.body.cannotText === false);
const tagged = (f) => f.puts.filter((p) => Array.isArray(p.body.tags) && p.body.tags.includes(CONSENT_TAG));
const last = () => pushes[pushes.length - 1] || {};
const quiet = async (fn) => { const w = console.warn; const lg = console.log; const e = console.error; console.warn = console.log = console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.log = lg; console.error = e; } };
async function run(f, data, form) {
  global.fetch = f.fetch;
  await quiet(() => handler(event(data, form)));
  return last();
}
const newLead = (extra) => ({ phones: ["+1 970-555-0100"], emails: ["pat@example.com"], tags: [HOT, "Website Lead", "contact"], ...extra });

(async () => {
  console.log("\n1. The create call: texting OFF, always");
  let f = fakeLofty({ leads: { [NEWID]: newLead() } });
  let rec = await run(f, person());
  check("a Signature form lead is created with cannotText:true", f.posts.length === 1 && f.posts[0].cannotText === true, JSON.stringify(f.posts[0]));
  check("nothing turns texting on or adds the consent tag", !textingOn(f).length && !tagged(f).length, JSON.stringify(f.puts));
  f = fakeLofty({ leads: { [NEWID]: newLead() } });
  await run(f, person({ sms_consent: "yes", consent: "yes" }));
  check("even a posted sms_consent/consent yes (no Signature form has one) leaves texting off",
    f.posts[0].cannotText === true && !textingOn(f).length && !tagged(f).length, JSON.stringify(f.puts));
  check("the create never carries the consent tag", !JSON.stringify(f.posts[0]).includes(CONSENT_TAG));

  console.log("\n2. The create folds into an existing client");
  const client = { phones: ["970.555.0100"], emails: ["pat@example.com"], cannotText: false, tags: ["Past Client", CONSENT_TAG] };
  f = fakeLofty({ leads: { [EXISTING]: client }, emailHits: [{ leadId: Number(EXISTING), emails: ["pat@example.com"] }], createId: EXISTING });
  await run(f, person());
  check("the create only ADDS its tags (tagsAdd) and sends cannotText:true",
    Array.isArray(f.posts[0].tagsAdd) && !("tags" in f.posts[0]) && f.posts[0].cannotText === true, JSON.stringify(f.posts[0]));
  check("nothing is written to the client's tags, and their consent tag stays", f.puts.length === 0 && f.leads[EXISTING].tags.includes(CONSENT_TAG), JSON.stringify(f.puts));

  console.log("\n3. A repeat enquiry still re-adds the Hot Lead tag");
  const repeat = { phones: ["9705550100"], emails: ["old@example.com"], tags: ["Past Client", HOT, CONSENT_TAG] };
  f = fakeLofty({ leads: { [EXISTING]: repeat }, phoneHits: [{ leadId: Number(EXISTING), phones: ["9705550100"] }], createId: EXISTING });
  rec = await run(f, person());
  const tagPuts = f.puts.map((p) => JSON.stringify(p.body.tags));
  check("the Hot Lead tag is taken off and put back", tagPuts.length === 2 &&
    tagPuts[0] === JSON.stringify(["Past Client", CONSENT_TAG]) && tagPuts[1] === JSON.stringify(["Past Client", HOT, CONSENT_TAG]) && rec.tagResult.step === "refired", JSON.stringify(f.puts));
  check("...texting is not touched, and a consent tag the lead had is never removed", !textingOn(f).length && f.puts.every((p) => p.body.tags.includes(CONSENT_TAG)));

  console.log("\n4. The minimal-shape retry keeps texting off");
  f = fakeLofty({ leads: { [NEWID]: newLead() }, createStatuses: [400, 200] });
  await run(f, person());
  check("both the full create and the minimal retry send cannotText:true",
    f.posts.length === 2 && f.posts.every((b) => b.cannotText === true) && !("tags" in f.posts[1]), JSON.stringify(f.posts));
  check("minimalLead itself carries it", L.minimalLead({ emails: ["a@b.co"] }).cannotText === true);

  console.log("\n5. No Signature form posts a texting consent");
  const fs0 = require("fs");
  const pathm = require("path");
  const siteDir = pathm.join(ROOT, "site");
  const found = [];
  let forms = 0;
  const walk = (d) => { for (const n of fs0.readdirSync(d)) { const p = pathm.join(d, n); const st = fs0.statSync(p);
    if (st.isDirectory()) walk(p); else if (n.endsWith(".html")) {
      const h = fs0.readFileSync(p, "utf8");
      for (const m of h.matchAll(/<form\b[^>]*data-netlify[^>]*>([\s\S]*?)<\/form>/gi)) {
        forms++;
        for (const i of m[1].matchAll(/<input\b[^>]*\bname=["']([^"']+)["'][^>]*>/gi)) if (/consent|sms|opt.?in|tcpa/i.test(i[1])) found.push(`${n}: ${i[1]}`);
      } } } };
  if (fs0.existsSync(siteDir)) walk(siteDir);
  check(`the ${forms} lead forms in site/ post no consent field (so cannotText:true always)`, forms > 0 && !found.length, found.slice(0, 5).join(", "));

  console.log("\n6. The queue replay (sync-listings) gets the same rule");
  delete mem["lofty-failed-pushes.json"];
  f = fakeLofty({ createStatus: 503 });
  await run(f, person({ sms_consent: "yes" }));
  let queue = mem["lofty-failed-pushes.json"] || [];
  check("a failed Signature create is queued with cannotText:true and no texting yes",
    queue.length === 1 && queue[0].smsConsent !== true && queue[0].lead.cannotText === true, JSON.stringify(queue[0] && { smsConsent: queue[0].smsConsent, cannotText: queue[0].lead.cannotText }));
  const drainStore = require("@netlify/blobs").getStore();
  f = fakeLofty({ leads: { [NEWID]: newLead() } });
  global.fetch = f.fetch;
  let dr = await quiet(() => L.drainFailedPushes(drainStore, "k"));
  check("replayed with cannotText:true and tagsAdd, and texting never turned on",
    dr.recovered === 1 && f.posts[0].cannotText === true && Array.isArray(f.posts[0].tagsAdd) && !textingOn(f).length && !tagged(f).length, JSON.stringify({ post: f.posts[0], puts: f.puts }));

  // A Little Lady lead queued with its recorded yes (both sites can drain one store).
  mem["lofty-failed-pushes.json"] = [{ at: "2026-09-30T10:00:00Z", formName: "contact", ok: false, httpStatus: 503, smsConsent: true,
    lead: { firstName: "Pat", emails: ["pat@example.com"], phones: ["(970) 555-0100"], cannotText: true, tags: [HOT] } }];
  f = fakeLofty({ leads: { [NEWID]: newLead() } });
  global.fetch = f.fetch;
  dr = await quiet(() => L.drainFailedPushes(drainStore, "k"));
  check("a queued yes + a single matching phone: texting on and the consent tag, tags merged",
    dr.recovered === 1 && textingOn(f).length === 1 && JSON.stringify(tagged(f)[0].body.tags) === JSON.stringify([HOT, "Website Lead", "contact", CONSENT_TAG]), JSON.stringify(f.puts));

  const oldEntry = { at: "2026-09-29T10:00:00Z", formName: "contact", ok: false, httpStatus: 503,
    lead: { firstName: "Old", emails: ["old@example.com"], phones: ["9705550100"], tags: [HOT] } };
  mem["lofty-failed-pushes.json"] = [oldEntry];
  f = fakeLofty({ leads: { [NEWID]: newLead() } });
  global.fetch = f.fetch;
  dr = await quiet(() => L.drainFailedPushes(drainStore, "k"));
  check("a lead queued before this fix (no cannotText, no yes) replays with cannotText:true and nothing turns texting on",
    // 2026-10-03: the replay now also re-adds the Hot Lead tag (tags only), so
    // "nothing turns texting on" means no write enables texting or adds consent.
    dr.recovered === 1 && f.posts[0].cannotText === true && !textingOn(f).length && !tagged(f).length &&
    f.puts.every((p) => !("cannotText" in p.body)), JSON.stringify({ post: f.posts[0], puts: f.puts }));

  mem["lofty-failed-pushes.json"] = [{ ...oldEntry, smsConsent: true }];
  f = fakeLofty({ leads: { [NEWID]: newLead({ phones: ["9705550100", "3035550199"] }) } });
  global.fetch = f.fetch;
  dr = await quiet(() => L.drainFailedPushes(drainStore, "k"));
  check("replay, a yes but a second phone on the lead: texting off, consent tag held",
    dr.recovered === 1 && !textingOn(f).length && !tagged(f).length && dr.consentHeld === 1, JSON.stringify({ dr, puts: f.puts }));

  mem["lofty-failed-pushes.json"] = [{ ...oldEntry, smsConsent: true }];
  f = fakeLofty({ leads: { [NEWID]: { phones: ["9705550100"] } } });
  global.fetch = f.fetch;
  dr = await quiet(() => L.drainFailedPushes(drainStore, "k"));
  check("replay onto a lead whose tags can't be read: no PUT", dr.recovered === 1 && f.puts.length === 0, JSON.stringify(f.puts));

  mem["lofty-failed-pushes.json"] = [{ ...oldEntry, smsConsent: true }];
  f = fakeLofty({ leads: { [NEWID]: { phones: ["9705550100"], tags: ["Past Client"] } }, createStatuses: [400, 200] });
  global.fetch = f.fetch;
  dr = await quiet(() => L.drainFailedPushes(drainStore, "k"));
  check("replay through the minimal retry: still cannotText:true, and the merge keeps the client's tags",
    f.posts.length === 2 && f.posts.every((b) => b.cannotText === true) &&
    JSON.stringify(tagged(f)[0] && tagged(f)[0].body.tags) === JSON.stringify(["Past Client", CONSENT_TAG]), JSON.stringify({ posts: f.posts, puts: f.puts }));

  console.log("\n7. The shared consent module");
  let C = null;
  try { C = require(`${FN_DIR}/lib/_lofty-consent.js`); } catch (err) { C = null; }
  check("lib/_lofty-consent.js exists", !!C);
  if (C) {
    check("the tag is spelled with an EN DASH, as in the Command Center", C.CONSENT_TAG === CONSENT_TAG);
    check("sms_consent=yes is a yes", C.smsConsentFromForm({ sms_consent: "yes" }).given === true);
    check("absent, blank, \"no\", \"off\", nonsense are not",
      [{}, { sms_consent: "" }, { sms_consent: "no" }, { sms_consent: "off" }, { sms_consent: "maybe" }].every((d) => C.smsConsentFromForm(d).given === false));
    check("the ROI funnels' required `consent` box is not read as texting consent", C.smsConsentFromForm({ consent: "yes" }).given === false);
    check("{ data }, { lead } and a bare lead all unwrap", [{ data: { leadId: 1 } }, { lead: { leadId: 1 } }, { leadId: 1 }].every((j) => C.unwrapLead(j).leadId === 1));
  }

  console.log("\n8. Same consent module as The Little Lady site");
  const fs = require("fs");
  for (const name of ["_lofty-consent.js"]) {
    const other = require("path").join(ROOT, "..", "thelittleladysellshomes", "netlify", "functions", "lib", name);
    if (fs.existsSync(other)) {
      check(`this site's lib/${name} matches The Little Lady copy`, fs.readFileSync(other, "utf8") === fs.readFileSync(`${FN_DIR}/lib/${name}`, "utf8"));
    } else {
      console.log(`  --   The Little Lady checkout not present; skipping the ${name} drift check`);
    }
  }

  const dncRegression = require('node:child_process').spawnSync(process.execPath,
    ['--test', require('node:path').join(__dirname, 'test-dnc-regression.cjs')], { stdio: 'inherit' });
  check('DNC regression suite passes', dncRegression.status === 0);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
