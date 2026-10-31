// A website lead stuck in the Lofty retry queue is told to Christine, once.
//
// 2026-10-31. A Contact form lead came in at 6:00 AM while Lofty refused the old
// key; it was queued and retried, and nothing said it stayed stuck. Christine:
// "do them all". lib/_lead-stuck.js (OFF unless LEAD_STUCK_ALERT is exactly "on")
// emails her once per lead older than LEAD_STUCK_ALERT_MINUTES (60) that Lofty
// still has not accepted, through the same hub path as the new-lead alert, and
// once more when it goes through; /status gets a "Lofty retry queue" row.
//
// The same file runs in both repos; only SIBLING below differs.
"use strict";
process.exitCode = 1;
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const SIBLING = fs.existsSync(`${FN_DIR}/sync-listings.js`) ? "thelittleladysellshomes" : "signature-property-collection";
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

function blobStore(seed) {
  const data = JSON.parse(JSON.stringify(seed || {}));
  return {
    data, writes: 0,
    get: async (k) => (k in data ? JSON.parse(JSON.stringify(data[k])) : null),
    setJSON: async function (k, v, o) {
      if (o && o.onlyIfNew && k in data) return { modified: false };
      this.writes += 1;
      data[k] = JSON.parse(JSON.stringify(v));
      return { modified: true, etag: "e" };
    },
    delete: async (k) => { delete data[k]; },
    list: async () => ({ blobs: [] }),
  };
}
const resp = (status, body) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body,
});
const fresh = () => {
  for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
};

const SECRETS = ["Marisol", "Venkataraman", "marisol.v@example.com", "555-0177", "a ranch with a horse arena"];
const NOW = Date.parse("2026-10-31T14:00:00.000Z"); // 8:00 AM Mountain
const stuckEntry = () => ({
  at: "2026-10-31T12:02:00.000Z", formName: "contact", submissionId: "sub-stuck-1",
  lead: { firstName: "Marisol", lastName: "Venkataraman", emails: ["marisol.v@example.com"], phones: ["(970) 555-0177"],
    notes: "NEW WEBSITE LEAD — a ranch with a horse arena", source: "Website", tags: ["Hot Lead - Website"] },
  ok: false, httpStatus: 401, responseBody: "invalid token for marisol.v@example.com", retries: 3,
});
const youngEntry = () => ({ ...stuckEntry(), at: "2026-10-31T13:30:00.000Z", submissionId: "sub-young" });
const acceptedEntry = () => ({ ...stuckEntry(), at: "2026-10-31T09:00:00.000Z", submissionId: "sub-acc", loftyId: "77", followupsPending: ["note"] });

function hubFetch(sent, answer) {
  return async (url, init = {}) => {
    const u = String(url);
    if (/hub\.example\.test/.test(u)) { sent.push(JSON.parse(init.body)); return resp(200, answer || { status: "sent", provider_id: "e" }); }
    if (/api\.lofty\.com/.test(u)) {
      if ((init.method || "GET") === "GET" && /\/leads\?/.test(u)) return resp(200, { leads: [] });
      return resp(200, { data: { leadId: 9 }, leadId: 9 });
    }
    return resp(500, "unexpected");
  };
}

(async () => {
  process.env.HUB_API_URL = "https://hub.example.test/functions/v1/hub-api";
  process.env.HUB_API_KEY = "hub_test";
  delete process.env.LEAD_ALERT_TO; delete process.env.LEAD_ALERT_FROM; delete process.env.LOFTY_VIA_HUB;
  delete process.env.LOFTY_QUEUE_DRAIN; delete process.env.LEAD_STUCK_ALERT_MINUTES;
  fresh();
  const S = require(`${FN_DIR}/lib/_lead-stuck.js`);
  const L = require(`${FN_DIR}/lib/_lofty.js`);

  console.log("\n1. The switch and the minutes are read strictly");
  for (const v of ["on", " on "]) check(`${JSON.stringify(v)} is on`, S.leadStuckAlertOn({ LEAD_STUCK_ALERT: v }) === true);
  for (const v of [undefined, "", "ON", "On", "true", "1", "yes", "onn"]) check(`${JSON.stringify(v)} is off`, S.leadStuckAlertOn({ LEAD_STUCK_ALERT: v }) === false);
  check("minutes default to 60", S.stuckMinutes({}) === 60 && S.stuckMinutes({ LEAD_STUCK_ALERT_MINUTES: "abc" }) === 60 &&
    S.stuckMinutes({ LEAD_STUCK_ALERT_MINUTES: "2" }) === 60 && S.stuckMinutes({ LEAD_STUCK_ALERT_MINUTES: "-5" }) === 60);
  check("a whole number from 5 to 10080 is used", S.stuckMinutes({ LEAD_STUCK_ALERT_MINUTES: " 90 " }) === 90 && S.stuckMinutes({ LEAD_STUCK_ALERT_MINUTES: "10080" }) === 10080);

  console.log("\n2. Off: nothing is read, written or sent");
  delete process.env.LEAD_STUCK_ALERT;
  let sent = [];
  let calls = 0;
  global.fetch = async () => { calls++; return resp(200, {}); };
  let store = blobStore({ [L.FAILED_PUSH_KEY]: [stuckEntry()] });
  let r = await S.checkStuckLeads(store, { now: NOW });
  check("it answers enabled:false", r.enabled === false, JSON.stringify(r));
  check("no call of any kind, no write", calls === 0 && store.writes === 0);

  console.log("\n3. On: one email for the stuck lead, through the hub, with no personal data");
  process.env.LEAD_STUCK_ALERT = "on";
  global.fetch = hubFetch(sent);
  store = blobStore({ [L.FAILED_PUSH_KEY]: [youngEntry(), stuckEntry(), acceptedEntry()] });
  r = await S.checkStuckLeads(store, { now: NOW });
  check("one lead is stuck and one email went out", r.stuck === 1 && r.alerted === 1 && sent.length === 1, JSON.stringify(r));
  const msg = sent[0] || {};
  check("kind alert, to Christine, with its own idempotency key",
    msg.kind === "alert" && JSON.stringify(msg.to) === JSON.stringify(["thelittleladyinc@gmail.com"]) && /^lead-stuck:[0-9a-f]{32}$/.test(msg.idempotency_key), JSON.stringify(msg).slice(0, 300));
  check("subject says when it was queued, in Mountain time", msg.subject === "Website lead still not in Lofty (queued since 6:02 AM)", msg.subject);
  check("body names the form, the retries, the last answer code and what to do",
    /contact/.test(msg.html) && /<strong>3 \(after the first try/.test(msg.html) && /HTTP 401/.test(msg.html) &&
    /LOFTY_API_KEY/.test(msg.html) && /retried again automatically|tried again automatically/.test(msg.html), msg.html);
  for (const s of SECRETS) check(`the email does not contain "${s}"`, !JSON.stringify(msg).includes(s));
  check("the alerted lead is recorded", !!(store.data[S.STUCK_ALERT_KEY] && store.data[S.STUCK_ALERT_KEY].alerted["id:sub-stuck-1"]));
  check("the queue itself is untouched", store.data[L.FAILED_PUSH_KEY].length === 3 && store.data[L.FAILED_PUSH_KEY][1].retries === 3);

  console.log("\n4. The next run sends nothing more for it");
  sent.length = 0;
  r = await S.checkStuckLeads(store, { now: NOW + 10 * 60000 });
  check("no second email", sent.length === 0 && r.alerted === 0, JSON.stringify(r));

  console.log("\n5. The drain counts each failed retry");
  store = blobStore({ [L.FAILED_PUSH_KEY]: [{ ...stuckEntry(), retries: undefined }] });
  global.fetch = async (url, init = {}) => (/\/leads\?/.test(String(url)) ? resp(200, { leads: [] }) : resp(401, { message: "bad key" }));
  await L.drainFailedPushes(store, "k");
  check("first failed replay: retries 1", store.data[L.FAILED_PUSH_KEY][0].retries === 1, JSON.stringify(store.data[L.FAILED_PUSH_KEY][0].retries));
  await L.drainFailedPushes(store, "k");
  check("second failed replay: retries 2", store.data[L.FAILED_PUSH_KEY][0].retries === 2);

  console.log("\n6. It goes through: the drain names it, and one short \"now delivered\" note follows");
  sent = [];
  global.fetch = hubFetch(sent);
  store = blobStore({ [L.FAILED_PUSH_KEY]: [stuckEntry()] });
  await S.checkStuckLeads(store, { now: NOW });
  sent.length = 0;
  const drained = await L.drainFailedPushes(store, "k");
  check("the drain recovered it and reports its key", drained.recovered === 1 && JSON.stringify(drained.recoveredKeys) === JSON.stringify(["id:sub-stuck-1"]), JSON.stringify(drained));
  sent.length = 0;
  r = await S.checkStuckLeads(store, { now: NOW + 30 * 60000, recoveredKeys: drained.recoveredKeys });
  check("one note, saying it is now in Lofty", r.delivered === 1 && sent.length === 1 &&
    /^Website lead now delivered to Lofty \(queued since 6:02 AM\)$/.test(sent[0].subject) && /^lead-stuck-done:/.test(sent[0].idempotency_key), JSON.stringify(sent.map((m) => m.subject)));
  for (const s of SECRETS) check(`the note does not contain "${s}"`, !JSON.stringify(sent[0] || {}).includes(s));
  sent.length = 0;
  r = await S.checkStuckLeads(store, { now: NOW + 60 * 60000 });
  check("and never again", sent.length === 0, JSON.stringify(r));

  console.log("\n7. Gone from the queue without the drain seeing it accepted: said plainly, never \"delivered\"");
  sent = [];
  global.fetch = hubFetch(sent);
  store = blobStore({ [L.FAILED_PUSH_KEY]: [stuckEntry()] });
  await S.checkStuckLeads(store, { now: NOW });
  store.data[L.FAILED_PUSH_KEY] = [];
  sent.length = 0;
  r = await S.checkStuckLeads(store, { now: NOW + 30 * 60000 });
  check("one note, \"no longer in the Lofty retry queue\"", r.leftQueue === 1 && sent.length === 1 &&
    /no longer in the Lofty retry queue/.test(sent[0].subject) && !/delivered/i.test(sent[0].subject), JSON.stringify(sent.map((m) => m.subject)));

  console.log("\n8. The hub does not send: nothing is recorded, and the next run asks again under the same key");
  const keys = [];
  global.fetch = async (url, init = {}) => { keys.push(JSON.parse(init.body).idempotency_key); return resp(503, { error: "email_send_enabled is off" }); };
  store = blobStore({ [L.FAILED_PUSH_KEY]: [stuckEntry()] });
  r = await S.checkStuckLeads(store, { now: NOW });
  check("not sent, said so, the lead not recorded as alerted", r.alerted === 0 && r.notSent === 1 &&
    Object.keys(store.data[S.STUCK_ALERT_KEY].alerted).length === 0, JSON.stringify(r));
  check("...and why is kept for /status (no key value)", /email_send_enabled is off/.test(store.data[S.STUCK_ALERT_KEY].lastProblem.reason) &&
    !JSON.stringify(store.data[S.STUCK_ALERT_KEY]).includes("hub_test"), JSON.stringify(store.data[S.STUCK_ALERT_KEY]));
  await S.checkStuckLeads(store, { now: NOW + 30 * 60000 });
  check("asked again with the same idempotency key", keys.length === 2 && keys[0] === keys[1]);
  delete process.env.HUB_API_URL;
  keys.length = 0;
  r = await S.checkStuckLeads(store, { now: NOW });
  check("no hub configured: no call, the reason is named", keys.length === 0 && r.notSent === 1 && /HUB_API_URL/.test(r.reason), JSON.stringify(r));
  process.env.HUB_API_URL = "https://hub.example.test/functions/v1/hub-api";

  console.log("\n9. The scheduled drain runs the check, also when paused");
  const runDrain = async (seed) => {
    const st = blobStore(seed);
    require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => st } };
    fresh();
    const out = await require(`${FN_DIR}/lofty-queue-drain.js`).handler();
    return { st, out };
  };
  const realNow = Date.now();
  const oldEntry = () => ({ ...stuckEntry(), at: new Date(realNow - 3 * 3600000).toISOString() });
  sent = [];
  global.fetch = hubFetch(sent);
  process.env.LOFTY_QUEUE_DRAIN = "off";
  let d = await runDrain({ [L.FAILED_PUSH_KEY]: [oldEntry()] });
  check("paused drain: answer unchanged, one alert sent", /^paused/.test(d.out.body) && sent.length === 1, `${d.out.body} / ${sent.length}`);
  delete process.env.LEAD_STUCK_ALERT;
  sent.length = 0;
  d = await runDrain({ [L.FAILED_PUSH_KEY]: [oldEntry()] });
  check("switch off: the drain sends nothing", sent.length === 0 && !(S.STUCK_ALERT_KEY in d.st.data));
  delete process.env.LOFTY_QUEUE_DRAIN;
  process.env.LEAD_STUCK_ALERT = "on";

  console.log("\n10. /status: the \"Lofty retry queue\" row (Blobs only, counts only)");
  const render = async (st, params) => {
    require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => st } };
    fresh();
    global.fetch = async () => { throw new Error("no live calls in this test"); };
    const health = require(`${FN_DIR}/site-health.js`);
    return (health.localHandler || health.handler)({ queryStringParameters: params });
  };
  let st = blobStore({ [L.FAILED_PUSH_KEY]: [oldEntry(), { ...oldEntry(), at: new Date(realNow - 5 * 60000).toISOString(), submissionId: "s2" }] });
  let out = await render(st, { format: "json" });
  let parsed = JSON.parse(out.body);
  let row = parsed.checks.find((c) => c.name === "Lofty retry queue") || {};
  check("red with the count, the oldest's age and the form", row.ok === false && /^2 website lead\(s\) waiting/.test(row.detail) &&
    /oldest came in 180 minute/.test(row.detail) && /1 waited longer than 60 minutes \(form\(s\): contact\)/.test(row.detail), row.detail);
  for (const s of SECRETS) check(`the status JSON does not contain "${s}"`, !out.body.includes(s));
  st.data[S.STUCK_ALERT_KEY] = { alerted: {}, lastProblem: { at: "2026-10-31T14:00:00.000Z", reason: "HUB_API_URL and HUB_API_KEY not set" } };
  row = JSON.parse((await render(st, { format: "json" })).body).checks.find((c) => c.name === "Lofty retry queue") || {};
  check("a stuck-lead email that could not go out is named, by setting", /could not be sent \(HUB_API_URL and HUB_API_KEY not set/.test(row.detail), row.detail);
  st = blobStore({ [L.FAILED_PUSH_KEY]: [] });
  row = JSON.parse((await render(st, { format: "json" })).body).checks.find((c) => c.name === "Lofty retry queue") || {};
  check("empty queue: green", row.ok === true && /^Empty/.test(row.detail), row.detail);
  delete process.env.LEAD_STUCK_ALERT;
  row = JSON.parse((await render(st, { format: "json" })).body).checks.find((c) => c.name === "Lofty retry queue");
  check("switch off: no row (the page as before)", row === undefined);
  const healthSrc = fs.readFileSync(`${FN_DIR}/site-health.js`, "utf8");
  check("site-health.js documents that the row makes no outbound call", /this[\s/]+row makes no outbound call/.test(healthSrc));

  console.log(`\n11. Same module as the other site (${SIBLING})`);
  const other = path.join(ROOT, "..", SIBLING, "netlify", "functions", "lib", "_lead-stuck.js");
  if (fs.existsSync(other)) {
    check(`lib/_lead-stuck.js is byte-identical to ${SIBLING}'s copy`,
      fs.readFileSync(other, "utf8") === fs.readFileSync(`${FN_DIR}/lib/_lead-stuck.js`, "utf8"));
  } else {
    console.log(`  --   ${SIBLING} checkout not present; skipping the drift check`);
  }
  check("the module names neither site", !/little lady|signature property|thelittleladysellshomes\.com|signaturepropertycollection\.com/i
    .test(fs.readFileSync(`${FN_DIR}/lib/_lead-stuck.js`, "utf8")));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
