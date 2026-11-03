// Texting consent: no website lead is textable in Lofty unless they said yes.
//
// 2026-11-03: ported from The Little Lady site, the day this site's forms got the
// same two consent boxes (the required Terms/Privacy box and the OPTIONAL
// `sms_consent` box; tests/test-consent-boxes.js). Until then no Signature form
// posted a texting consent, so this suite only pinned "texting off, always". It
// now pins Christine's whole rule through the real form handler and the real
// queue replay: every create is cannotText:true; texting goes on only after the
// create, only on an explicit yes, and only when every phone on the lead is the
// consented number; tags are read and merged, never replaced; a tag list that
// cannot be read means nothing is written. The shared libraries are byte for
// byte The Little Lady site's.
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
    const path = s.replace(/^https:\/\/(api\.lofty\.com|hub\.example\.test\/functions\/v1\/hub-api)/, "").split("?")[0];
    f.calls.push(`${m} ${path}`);
    if (/hub\.example\.test/.test(s)) return resp(200, { status: "sent", provider_id: "e1" });
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
process.env.HUB_API_URL = "https://hub.example.test/functions/v1/hub-api"; process.env.HUB_API_KEY = "hub_test";
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
  check("no consent box: the create sends cannotText:true", f.posts.length === 1 && f.posts[0].cannotText === true, JSON.stringify(f.posts[0]));
  check("no consent box: nothing turns texting on or adds the consent tag", !textingOn(f).length && !tagged(f).length, JSON.stringify(f.puts));
  check("no consent box: a safety read precedes the tag re-add", f.calls.filter((c) => c === `GET /v1.0/leads/${NEWID}`).length === 2, JSON.stringify(f.calls));

  f = fakeLofty({ leads: { [NEWID]: newLead() } });
  await run(f, person({ sms_consent: "no" }));
  check("a \"no\": cannotText:true, texting never turned on", f.posts[0].cannotText === true && !textingOn(f).length && !tagged(f).length);

  f = fakeLofty({ leads: { [NEWID]: newLead() } });
  rec = await run(f, person({ sms_consent: "yes" }));
  check("a yes: the create STILL sends cannotText:true (texting goes on only after the phone check)", f.posts[0].cannotText === true, JSON.stringify(f.posts[0]));
  check("the create never carries the consent tag", !JSON.stringify(f.posts[0]).includes(CONSENT_TAG));

  console.log("\n2. A yes, and the lead's only phone is the consented number");
  const consentPut = textingOn(f)[0];
  check("one write turns texting on (cannotText:false) on the new lead", textingOn(f).length === 1 && consentPut.id === NEWID, JSON.stringify(f.puts));
  check("...and adds the consent tag, keeping every tag the lead had",
    consentPut && JSON.stringify(consentPut.body.tags) === JSON.stringify([HOT, "Website Lead", "contact", CONSENT_TAG]), JSON.stringify(consentPut && consentPut.body));
  check("...and never writes the phones list (PUT replaces it)", consentPut && !("phones" in consentPut.body));
  const iConsent = f.calls.indexOf(`PUT /v1.0/leads/${NEWID}`);
  check("texting is settled before the Hot Lead re-add starts the Smart Plan", iConsent >= 0 && f.puts[0] === consentPut, JSON.stringify(f.calls));
  check("the lead ends textable, with the consent tag and the Hot Lead tag",
    f.leads[NEWID].cannotText === false && f.leads[NEWID].tags.includes(CONSENT_TAG) && f.leads[NEWID].tags.includes(HOT), JSON.stringify(f.leads[NEWID]));
  check("/status records it without the phone number", rec.consentResult && rec.consentResult.textingEnabled === true &&
    !JSON.stringify(rec.consentResult).includes("555"), JSON.stringify(rec.consentResult));

  // 2026-10-03: Lofty's real GET answers { lead: {...} }. Both shapes must now
  // produce exactly the same writes -- the consent write AND the Hot Lead
  // remove/re-add that starts the Smart Plan (which never ran on the { lead }
  // shape before, because the tag reader only looked at the top level / data).
  const fData = fakeLofty({ leads: { [NEWID]: newLead() } });
  await run(fData, person({ sms_consent: "yes" }));
  f = fakeLofty({ leads: { [NEWID]: newLead() }, wrap: "lead" });
  await run(f, person({ sms_consent: "yes" }));
  check("a read that wraps the lead as { lead } is read the same way",
    textingOn(f).length === 1 && JSON.stringify(f.puts) === JSON.stringify(fData.puts), JSON.stringify(f.puts));
  check("...including the Hot Lead re-add that starts the Smart Plan",
    f.puts.some((p) => Array.isArray(p.body.tags) && !p.body.tags.includes(HOT)) &&
    f.leads[NEWID].tags.includes(HOT), JSON.stringify(f.puts));

  console.log("\n3. A yes, but the lead has another phone number");
  f = fakeLofty({ leads: { [NEWID]: newLead({ phones: ["970-555-0100", "303-555-0199"] }) } });
  rec = await run(f, person({ sms_consent: "yes" }));
  check("texting stays off (no cannotText:false anywhere)", !textingOn(f).length && f.leads[NEWID].cannotText !== false, JSON.stringify(f.puts));
  check("the consent tag is held", !tagged(f).length && !f.leads[NEWID].tags.includes(CONSENT_TAG));
  check("/status says why", rec.consentResult && /another phone/.test(rec.consentResult.textingNotEnabled || ""), JSON.stringify(rec.consentResult));
  f = fakeLofty({ leads: { [NEWID]: newLead({ phones: ["9705550100"], phone: "3035550199" }) } });
  await run(f, person({ sms_consent: "yes" }));
  check("a second number in the single `phone` field counts too", !textingOn(f).length && !tagged(f).length);
  f = fakeLofty({ leads: { [NEWID]: newLead({ phones: [] }) } });
  await run(f, person({ sms_consent: "yes" }));
  check("a lead with no phone on it: held", !textingOn(f).length && !tagged(f).length);
  f = fakeLofty({ leads: { [NEWID]: newLead() } });
  await run(f, person({ sms_consent: "yes", phone: "" }));
  check("a yes with no phone on the form: held", !textingOn(f).length && !tagged(f).length);

  console.log("\n4. Tags that can't be read: nothing written");
  // (A contact the lookup proved brand new still gets its website fields --
  // customAttributeList, unchanged by this fix; nothing may touch tags or texting.)
  const tagOrText = (fk) => fk.puts.filter((p) => "tags" in p.body || "cannotText" in p.body || "phones" in p.body);
  f = fakeLofty({ leads: { [NEWID]: { phones: ["9705550100"], emails: ["pat@example.com"] } } });
  rec = await run(f, person({ sms_consent: "yes" }));
  check("missing tags on the lead: no PUT of tags or texting", tagOrText(f).length === 0, JSON.stringify(f.puts));
  check("...and texting stays off", f.leads[NEWID].cannotText !== false && rec.consentResult && rec.consentResult.textingEnabled === false);
  f = fakeLofty({ leads: { [NEWID]: { phones: ["9705550100"], tags: null } } });
  await run(f, person({ sms_consent: "yes" }));
  check("tags: null: no PUT of tags or texting", tagOrText(f).length === 0, JSON.stringify(f.puts));
  f = fakeLofty({ leads: { [NEWID]: { phones: ["9705550100"], tags: [{ tagId: 1 }] } } });
  await run(f, person({ sms_consent: "yes" }));
  check("a tag with no name: no PUT of tags or texting", tagOrText(f).length === 0, JSON.stringify(f.puts));
  f = fakeLofty({ leads: { [EXISTING]: { phones: ["9705550100"], emails: ["pat@example.com"] } }, emailHits: [{ leadId: Number(EXISTING), emails: ["pat@example.com"] }], createId: NEWID });
  await run(f, person({ sms_consent: "yes" }));
  check("an existing lead (found by email) with missing tags: no PUT at all", f.puts.length === 0, JSON.stringify(f.puts));
  f = fakeLofty({ leads: {} });
  await run(f, person({ sms_consent: "yes" }));
  check("the returned id doesn't resolve (a merge's absorbed record): no PUT", f.puts.length === 0);

  console.log("\n5. The create folds into an existing client");
  const client = { phones: ["970.555.0100"], emails: ["pat@example.com"], tags: [{ tagId: 9, tagName: "Past Client" }, { tagId: 8, tagName: "Sphere" }] };
  f = fakeLofty({ leads: { [EXISTING]: client }, emailHits: [{ leadId: Number(EXISTING), emails: ["pat@example.com"] }], createId: EXISTING, wrap: "lead" });
  await run(f, person({ sms_consent: "yes" }));
  check("the create only ADDS its tags (tagsAdd) and still sends cannotText:true",
    Array.isArray(f.posts[0].tagsAdd) && !("tags" in f.posts[0]) && f.posts[0].cannotText === true, JSON.stringify(f.posts[0]));
  const put5 = f.puts.find((p) => p.id === EXISTING);
  check("the consent write keeps the client's own tags and only adds the consent tag",
    put5 && JSON.stringify(put5.body.tags) === JSON.stringify(["Past Client", "Sphere", CONSENT_TAG]), JSON.stringify(f.puts));
  check("no write ever drops a tag the client had", f.puts.every((p) => !p.body.tags || ["Past Client", "Sphere"].every((t) => p.body.tags.includes(t))));
  f = fakeLofty({ leads: { [EXISTING]: { phones: ["9705550100"], emails: ["pat@example.com"] } }, emailHits: [{ leadId: Number(EXISTING), emails: ["pat@example.com"] }], createId: EXISTING, wrap: "lead" });
  await run(f, person({ sms_consent: "yes" }));
  check("folded into a client whose read has no tags: no PUT (never 'no tags yet')", f.puts.length === 0, JSON.stringify(f.puts));
  f = fakeLofty({ leads: { [EXISTING]: { ...client, cannotText: false, tags: ["Past Client", CONSENT_TAG] } }, emailHits: [{ leadId: Number(EXISTING), emails: ["pat@example.com"] }], createId: EXISTING });
  await run(f, person({ sms_consent: "" }));
  check("a blank on a client who agreed before: nothing written, the consent tag stays",
    f.puts.length === 0 && f.leads[EXISTING].tags.includes(CONSENT_TAG), JSON.stringify(f.puts));

  console.log("\n6. A repeat enquiry still re-adds the Hot Lead tag");
  // Lofty merges on the phone (the email lookup finds nobody), and hands back the
  // lead that already carries the Hot Lead tag: remove it, put it back.
  const repeat = { phones: ["9705550100"], emails: ["old@example.com"], tags: ["Past Client", HOT] };
  f = fakeLofty({ leads: { [EXISTING]: repeat }, phoneHits: [{ leadId: Number(EXISTING), phones: ["9705550100"] }], createId: EXISTING });
  rec = await run(f, person());
  const tagPuts = f.puts.map((p) => JSON.stringify(p.body.tags));
  check("no consent: the Hot Lead tag is taken off and put back", tagPuts.length === 2 &&
    tagPuts[0] === JSON.stringify(["Past Client"]) && tagPuts[1] === JSON.stringify(["Past Client", HOT]) && rec.tagResult.step === "refired", JSON.stringify(f.puts));
  check("...and texting is not touched", !textingOn(f).length);
  f = fakeLofty({ leads: { [EXISTING]: repeat }, phoneHits: [{ leadId: Number(EXISTING), phones: ["9705550100"] }], createId: EXISTING });
  rec = await run(f, person({ sms_consent: "yes" }));
  check("a yes: texting on + consent tag first, then the Hot Lead re-add keeps the consent tag",
    f.puts.length === 3 && f.puts[0].body.cannotText === false &&
    JSON.stringify(f.puts[2].body.tags) === JSON.stringify(["Past Client", HOT, CONSENT_TAG]) && rec.tagResult.step === "refired", JSON.stringify(f.puts));
  f = fakeLofty({ leads: { [EXISTING]: { ...repeat, tags: ["Past Client", HOT, CONSENT_TAG], cannotText: false } }, phoneHits: [{ leadId: Number(EXISTING), phones: ["9705550100"] }], createId: EXISTING });
  await run(f, person({ sms_consent: "no" }));
  check("a later \"no\" never removes the consent tag (the re-add keeps it)",
    f.puts.length === 2 && f.puts.every((p) => p.body.tags.includes(CONSENT_TAG)) && !textingOn(f).length, JSON.stringify(f.puts));

  console.log("\n7. A legacy required `consent` box is not a yes to texts");
  f = fakeLofty({ leads: { [NEWID]: newLead() } });
  await run(f, { name: "Rae Renter", email: "rae@example.com", phone: "970-555-0100", consent: "yes" }, "contact");
  check("a posted consent=yes (the old unnamed box's successor on a cached page): created cannotText:true, never turned on",
    f.posts[0].cannotText === true && !textingOn(f).length && !tagged(f).length, JSON.stringify(f.puts));
  check("...and the note says the required box doesn't count", /REQUIRED to submit/.test(f.posts[0].notes || ""), f.posts[0].notes);

  console.log("\n8. The minimal-shape retry keeps texting off");
  f = fakeLofty({ leads: { [NEWID]: newLead() }, createStatuses: [400, 200] });
  await run(f, person());
  check("both the full create and the minimal retry send cannotText:true",
    f.posts.length === 2 && f.posts.every((b) => b.cannotText === true) && !("tags" in f.posts[1]), JSON.stringify(f.posts));
  check("minimalLead itself carries it", L.minimalLead({ emails: ["a@b.co"] }).cannotText === true);

  console.log("\n9. The queue replay (lofty-queue-drain) gets the same rule");
  delete mem["lofty-failed-pushes.json"];
  f = fakeLofty({ createStatus: 503 });
  await run(f, person({ sms_consent: "yes" }));
  let queue = mem["lofty-failed-pushes.json"] || [];
  check("a failed create is queued with its texting yes and cannotText:true",
    queue.length === 1 && queue[0].smsConsent === true && queue[0].lead.cannotText === true, JSON.stringify(queue[0] && { smsConsent: queue[0].smsConsent, cannotText: queue[0].lead.cannotText }));
  const drainStore = require("@netlify/blobs").getStore();
  f = fakeLofty({ leads: { [NEWID]: newLead() } });
  global.fetch = f.fetch;
  let dr = await quiet(() => L.drainFailedPushes(drainStore, "k"));
  check("replayed with cannotText:true and tagsAdd", dr.recovered === 1 && f.posts[0].cannotText === true && Array.isArray(f.posts[0].tagsAdd), JSON.stringify(f.posts[0]));
  check("the recorded yes + a single matching phone: texting on and the consent tag, tags merged",
    textingOn(f).length === 1 && JSON.stringify(tagged(f)[0].body.tags) === JSON.stringify([HOT, "Website Lead", "contact", CONSENT_TAG]), JSON.stringify(f.puts));

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

  console.log("\n10. Reading the form's answer");
  let C = null;
  try { C = require(`${FN_DIR}/lib/_lofty-consent.js`); } catch (err) { C = null; }
  check("lib/_lofty-consent.js exists", !!C);
  if (C) {
    check("the tag is spelled with an EN DASH, as in the Command Center", C.CONSENT_TAG === CONSENT_TAG);
    check("sms_consent=yes is a yes", C.smsConsentFromForm({ sms_consent: "yes" }).given === true);
    check("absent, blank, \"no\", \"off\", nonsense are not",
      [{}, { sms_consent: "" }, { sms_consent: "no" }, { sms_consent: "off" }, { sms_consent: "maybe" }].every((d) => C.smsConsentFromForm(d).given === false));
    check("a legacy required `consent` box is not read as texting consent", C.smsConsentFromForm({ consent: "yes" }).given === false);
    check("{ data }, { lead } and a bare lead all unwrap", [{ data: { leadId: 1 } }, { lead: { leadId: 1 } }, { leadId: 1 }].every((j) => C.unwrapLead(j).leadId === 1));
  }

  console.log("\n11. Same consent module as The Little Lady site");
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
