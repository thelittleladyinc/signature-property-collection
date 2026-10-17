// A homeowner who asks what their home is worth also goes to the Seller
// Intelligence hub, which drafts a value review for Christine (Build E,
// 2026-10-17; lib/_hub-intake.js, switch WEBSITE_TO_HUB_INTAKE). This pins:
//
//   - off by default: no hub call at all unless the switch is exactly "on";
//   - only the three value forms go (free-home-valuation, sellers-page-inquiry,
//     the homepage form with "value"), new AND returning contacts alike;
//   - its own intake-only key (HUB_INTAKE_KEY), https only, no redirect, a time
//     limit, and nothing personal in /status or the log;
//   - the body the hub reads (the address split as Lofty gets it, the Lofty lead
//     id the note confirmed, the form name and Netlify's submission id);
//   - a failed Lofty create still reaches the hub; a lead held for identity
//     review does not; a hub that is down never breaks the Lofty path;
//   - lib/_hub-intake.js is byte-identical to the other site's copy.
//
// The same file runs in both repos; only SITE and SIBLING below differ. Nothing
// here calls Lofty or the hub: fetch is a fake that records every request.
"use strict";
process.exitCode = 1;
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const SITE = "signature";
const SIBLING = "thelittleladysellshomes";
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const HUB = "https://hub.example.test/functions/v1/hub-api";
const INTAKE_KEY = "hub_" + "intake".padEnd(64, "0");
const NEWID = "1149000000000001";
const EXISTING = "1148639689762408";

function resp(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}

// A fake Lofty plus a fake hub. The hub records every intake call with its headers.
function fakeWorld({ emailHits = [], createStatus = 200, hubStatus = 200, hubBody = { status: "recorded", outcome: "created", value_review: { status: "opened", review_id: 3 } }, hubThrows = false } = {}) {
  const w = { intake: [], other: [], leads: {} };
  w.fetch = async (url, init = {}) => {
    const s = String(url); const m = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (s.startsWith(`${HUB}/v1/intake/`)) {
      w.intake.push({ url: s, headers: init.headers, body, redirect: init.redirect, signal: !!init.signal });
      if (hubThrows) throw Object.assign(new Error(`down ${INTAKE_KEY}`), { name: "TimeoutError" });
      return resp(hubStatus, hubBody);
    }
    if (s.startsWith(HUB)) { w.other.push(s); return resp(200, { status: "sent", provider_id: "e1" }); }
    if (m === "GET" && /\/v1\.0\/leads\?/.test(s)) return resp(200, { leads: /email=/.test(s) ? emailHits : [] });
    if (m === "POST" && /\/v1\.0\/leads$/.test(s)) {
      if (createStatus !== 200) return resp(createStatus, "refused");
      const id = emailHits.length ? EXISTING : NEWID;
      if (!w.leads[id]) w.leads[id] = { tags: [...(body.tags || body.tagsAdd || [])], phones: body.phones || [] };
      return resp(200, `{"data":{"leadId": ${id}}}`);
    }
    if (/\/notes$/.test(s)) return w.leads[String(body.leadId)] ? resp(200, "{}") : resp(404, { message: "errorCode=20006,errorMsg=Lead not exist" });
    if (/\/v2\.0\/tasks$/.test(s)) return resp(200, `{"taskId": 77}`);
    if (/send-task-reminder$/.test(s)) return resp(200, { message: "ok" });
    if (/listCustomField/.test(s)) return resp(200, { data: [] });
    if (/custom-field$/.test(s)) return resp(200, "{}");
    if (/\/inquiry$/.test(s)) return resp(200, "{}");
    const one = s.match(/\/v1\.0\/leads\/(\d+)$/);
    if (one && m === "GET") {
      const l = w.leads[one[1]];
      return l ? resp(200, { lead: { leadId: Number(one[1]), phones: l.phones, tags: l.tags.map((t) => ({ tagName: t })) } }) : resp(404, "{}");
    }
    if (one && m === "PUT") { if (w.leads[one[1]]) Object.assign(w.leads[one[1]], body); return resp(200, "{}"); }
    return resp(404, `unexpected ${m} ${s}`);
  };
  return w;
}

const mem = {};
const pushes = [];
require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
  getStore: () => ({
    get: async (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : null),
    setJSON: async (k, v, o) => {
      if (o && o.onlyIfNew && k in mem) return { modified: false };
      if (k === "lofty-last-push.json") pushes.push(v);
      mem[k] = JSON.parse(JSON.stringify(v));
      return { modified: true };
    },
    delete: async (k) => { delete mem[k]; },
    list: async () => ({ blobs: [] }),
  }),
} };
for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
process.env.LOFTY_API_KEY = "k";
process.env.HUB_API_URL = HUB; process.env.HUB_API_KEY = "hub_email_key";
delete process.env.FLODESK_API_KEY;
delete process.env.WEBSITE_TO_HUB_INTAKE;
delete process.env.HUB_INTAKE_KEY;
const handler = require(`${FN_DIR}/submission-created.js`).handler;
const H = require(`${FN_DIR}/lib/_hub-intake.js`);

const person = (extra) => ({ name: "Pat Q Owner", email: "pat@example.com", phone: "(970) 555-0100", ...extra });
const event = (form, data) => ({ body: JSON.stringify({ payload: { id: "sub-123", created_at: "2026-10-17T15:00:00.000Z", form_name: form, data: person(data) } }) });
const last = () => pushes[pushes.length - 1] || {};
async function submit(w, form, data) {
  global.fetch = w.fetch;
  for (const k of Object.keys(mem)) delete mem[k];
  const keep = [console.log, console.warn, console.error];
  const lines = [];
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
  try { await handler(event(form, data)); } finally { [console.log, console.warn, console.error] = keep; }
  return lines;
}
const on = () => { process.env.WEBSITE_TO_HUB_INTAKE = "on"; process.env.HUB_INTAKE_KEY = INTAKE_KEY; };

(async () => {
  console.log("\n1. The switch and the forms");
  check("off unless exactly on (spaces and case forgiven)", H.hubIntakeOn({ WEBSITE_TO_HUB_INTAKE: " ON " }) &&
    !H.hubIntakeOn({}) && !H.hubIntakeOn({ WEBSITE_TO_HUB_INTAKE: "yes" }) && !H.hubIntakeOn({ WEBSITE_TO_HUB_INTAKE: "true" }));
  check("the three value forms, and nothing else", JSON.stringify(H.valueForm("free-home-valuation", {})) === '{"form_name":"free-home-valuation","form_choice":null}' &&
    H.valueForm("sellers-page-inquiry", {}).form_name === "sellers-page-inquiry" &&
    JSON.stringify(H.valueForm("home-lead", { looking_to: " Value " })) === '{"form_name":"home-lead","form_choice":"value"}' &&
    H.valueForm("home-lead", { looking_to: "sell" }) === null && H.valueForm("cash-offer", {}) === null &&
    H.valueForm("seller-local-proof", {}) === null && H.valueForm("contact", {}) === null && H.valueForm("", {}) === null);
  check("its own intake-only key: HUB_INTAKE_KEY, not the email key", H.intakeEndpoint({ HUB_API_URL: HUB, HUB_API_KEY: "x" }).reason === "HUB_INTAKE_KEY not set" &&
    H.intakeEndpoint({ HUB_API_URL: HUB, HUB_INTAKE_KEY: "k" }).url === `${HUB}/v1/intake/website`);
  check("https only, no user name or password, no query", H.intakeEndpoint({ HUB_API_URL: "http://hub.example.test", HUB_INTAKE_KEY: "k" }).reason === "HUB_API_URL must start with https://" &&
    /must not carry/.test(H.intakeEndpoint({ HUB_API_URL: "https://u:p@hub.example.test", HUB_INTAKE_KEY: "k" }).reason) &&
    H.intakeEndpoint({ HUB_API_URL: `${HUB}/?x=1`, HUB_INTAKE_KEY: "k" }).url === `${HUB}/v1/intake/website`);
  const b = H.intakeBody({ form_name: "free-home-valuation", form_choice: null },
    { name: " Pat  Q Owner ", email: "pat@example.com", phone: "970-555-0100", address: "2411 Glade Rd, Loveland, CO 80538", message: "secret" },
    { loftyLeadId: 1148639689762408, createdAt: "2026-10-17T15:00:00.000Z", submissionId: "sub-1", site: SITE });
  check("the body: name split, the address split as Lofty gets it, the lead id, home_value_view, no free text", b.first_name === "Pat" &&
    b.last_name === "Q Owner" && b.property_address === "2411 Glade Rd" && b.city === "Loveland" && b.state === "CO" && b.zip === "80538" &&
    b.lofty_lead_id === "1148639689762408" && b.event_type === "home_value_view" && b.event_at === "2026-10-17T15:00:00.000Z" &&
    b.raw.submission_id === "sub-1" && b.raw.site === SITE && !JSON.stringify(b).includes("secret"), JSON.stringify(b));
  check("a lead id that is not digits is left out", H.intakeBody({ form_name: "x" }, {}, { loftyLeadId: "12a" }).lofty_lead_id === undefined);

  console.log("\n2. Switch off: nothing goes to the hub");
  let w = fakeWorld();
  await submit(w, "free-home-valuation", { address: "123 Main St, Loveland, CO 80538" });
  check("a home-value lead with the switch off makes no hub intake call", w.intake.length === 0 && last().hubIntake &&
    last().hubIntake.attempted === false && last().hubIntake.reason === "WEBSITE_TO_HUB_INTAKE is off", JSON.stringify(last().hubIntake));
  check("...and Lofty ran exactly as before (create, note)", Object.keys(w.leads).length === 1);
  process.env.WEBSITE_TO_HUB_INTAKE = "on";
  w = fakeWorld();
  await submit(w, "free-home-valuation", { address: "123 Main St" });
  check("switch on but no HUB_INTAKE_KEY: no call, and /status names the setting", w.intake.length === 0 &&
    last().hubIntake.reason === "HUB_INTAKE_KEY not set");

  console.log("\n3. Switch on");
  on();
  w = fakeWorld();
  let lines = await submit(w, "free-home-valuation", { address: "123 Main St, Loveland, CO 80538" });
  const c = w.intake[0] || {};
  check("a new contact: one intake call, after the Lofty create, with the new lead id", w.intake.length === 1 &&
    c.url === `${HUB}/v1/intake/website` && c.body.lofty_lead_id === NEWID && c.body.form_name === "free-home-valuation", JSON.stringify(c.body));
  check("the intake-only key in x-hub-key; redirect refused; a time limit", c.headers && c.headers["x-hub-key"] === INTAKE_KEY &&
    c.redirect === "manual" && c.signal === true);
  check("the address and the submission", c.body.property_address === "123 Main St" && c.body.city === "Loveland" && c.body.zip === "80538" &&
    c.body.event_at === "2026-10-17T15:00:00.000Z" && c.body.raw.submission_id === "sub-123");
  const rec = last().hubIntake || {};
  check("/status keeps the hub's status words only", rec.ok === true && rec.hubStatus === "recorded" && rec.reviewStatus === "opened" &&
    !/pat|example|555|Main/i.test(JSON.stringify(rec)), JSON.stringify(rec));
  check("the log line says what happened and nothing personal", lines.some((l) => l === 'Value review to the hub for "free-home-valuation": recorded, review opened.') &&
    !lines.filter((l) => /Value review/.test(l)).some((l) => /pat|555|Main/i.test(l)), lines.filter((l) => /Value review/.test(l)).join(" | "));

  w = fakeWorld({ emailHits: [{ leadId: Number(EXISTING), emails: ["pat@example.com"] }] });
  w.leads[EXISTING] = { tags: ["Past Client"], phones: [] };
  await submit(w, "sellers-page-inquiry", { address: "9 Elm St, Berthoud, CO 80513" });
  check("a returning contact goes too, with the lead the lookup found", w.intake.length === 1 && w.intake[0].body.lofty_lead_id === EXISTING &&
    w.intake[0].body.form_name === "sellers-page-inquiry", JSON.stringify(w.intake[0] && w.intake[0].body));

  w = fakeWorld();
  await submit(w, "home-lead", { looking_to: "value", message: "what's it worth?" });
  check("the homepage form with \"value\": form_choice value, no address (the hub uses the home on file)", w.intake.length === 1 &&
    w.intake[0].body.form_name === "home-lead" && w.intake[0].body.form_choice === "value" && w.intake[0].body.property_address === undefined &&
    !JSON.stringify(w.intake[0].body).includes("worth?"));
  for (const [form, data] of [["home-lead", { looking_to: "sell" }], ["cash-offer", { address: "1 A St" }], ["contact", { message: "hi" }], ["listing-inquiry", { listing_address: "1 Elm St" }]]) {
    w = fakeWorld();
    await submit(w, form, data);
    check(`${form}${data.looking_to ? ` (${data.looking_to})` : ""}: not a value form, no hub call`, w.intake.length === 0 && last().hubIntake.reason === "not a value form");
  }

  console.log("\n4. When things go wrong");
  w = fakeWorld({ createStatus: 500 });
  await submit(w, "free-home-valuation", { address: "123 Main St, Loveland, CO 80538" });
  check("Lofty refused the create: the review still reaches the hub (no lead id), and the lead is queued as before",
    w.intake.length === 1 && w.intake[0].body.lofty_lead_id === undefined && (mem["lofty-failed-pushes.json"] || []).length === 1 &&
    (mem["lofty-failed-pushes.json"] || [])[0].hubIntake && (mem["lofty-failed-pushes.json"] || [])[0].hubIntake.ok === true,
    JSON.stringify(Object.keys(mem)));
  w = fakeWorld({ hubStatus: 503, hubBody: { error: "hub api is switched off" } });
  await submit(w, "free-home-valuation", { address: "123 Main St" });
  check("the hub switched off: recorded as a failure, the Lofty path untouched", last().hubIntake.ok === false &&
    last().hubIntake.httpStatus === 503 && last().hubIntake.error === "hub api is switched off" && Object.keys(w.leads).length === 1 && last().planResult);
  w = fakeWorld({ hubThrows: true });
  await submit(w, "free-home-valuation", { address: "123 Main St" });
  check("the hub unreachable: recorded by error name only (never the key)", last().hubIntake.ok === false && last().hubIntake.error === "TimeoutError" &&
    !JSON.stringify(last()).includes(INTAKE_KEY));
  w = fakeWorld({ hubStatus: 302, hubBody: "" });
  await submit(w, "free-home-valuation", { address: "123 Main St" });
  check("a redirect is a failure, not followed", last().hubIntake.ok === false && last().hubIntake.httpStatus === 302 && w.intake.length === 1);
  check("the email alert still goes out through the hub's email route", w.other.some((u) => /\/v1\/email\/send$/.test(u)));

  console.log(`\n5. Same module as the other site (${SIBLING})`);
  const other = path.join(ROOT, "..", SIBLING, "netlify", "functions", "lib", "_hub-intake.js");
  if (fs.existsSync(other)) {
    check(`lib/_hub-intake.js is byte-identical to ${SIBLING}'s copy`,
      fs.readFileSync(other, "utf8") === fs.readFileSync(`${FN_DIR}/lib/_hub-intake.js`, "utf8"));
  } else {
    console.log(`  --   ${SIBLING} checkout not present; skipping the drift check`);
  }
  const sub = fs.readFileSync(`${FN_DIR}/submission-created.js`, "utf8");
  check(`this site sends its own name (site: "${SITE}")`, (sub.match(new RegExp(`sendValueFormToHub\\(\\{ formName, data, site: "${SITE}"`, "g")) || []).length === 2);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
