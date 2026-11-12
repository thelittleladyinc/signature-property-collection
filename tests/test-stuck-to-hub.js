// The Lofty retry queue's COUNTS go to the Seller Intelligence hub (2026-11-12).
//
// lib/_lead-stuck.js reportStuckToHub, OFF unless LEAD_STUCK_TO_HUB is exactly
// "on": after every drain run, POST {HUB_API_URL}/v1/leads/stuck-report with the
// website's intake key (HUB_INTAKE_KEY, hub scope leads:report) and exactly four
// keys -- site, pending, failed, oldest_age_minutes -- so Command Center's "This
// morning" panel can say a site has stuck website leads. This pins:
//   - off by default: no call of any kind, nothing read;
//   - the body is the four numbers and nothing else (never a name, email, phone);
//   - pending / failed / the oldest's wait are counted from the queue as stored;
//   - a queue that cannot be read sends NOTHING (never zeros);
//   - https only, a redirect is a failure, the key only in x-hub-key, a time limit;
//   - the scheduled drain runs it, also when paused, and its answer never changes.
//
// The same file runs in both repos. Nothing here calls the hub: fetch is a fake.
"use strict";
process.exitCode = 1;
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const SIGNATURE = fs.existsSync(`${FN_DIR}/sync-listings.js`);
const DOMAIN = SIGNATURE ? "signaturepropertycollection.com" : "thelittleladysellshomes.com";
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const HUB = "https://hub.example.test/functions/v1/hub-api";
const INTAKE_KEY = "hub_" + "intake".padEnd(64, "0");
const SECRETS = ["Marisol", "Venkataraman", "marisol.v@example.com", "555-0177", "horse arena"];
const NOW = Date.parse("2026-11-12T15:00:00.000Z");

function blobStore(seed, { failGet = false } = {}) {
  const data = JSON.parse(JSON.stringify(seed || {}));
  return {
    data, writes: 0,
    get: async (k) => { if (failGet) throw new Error("blobs down"); return k in data ? JSON.parse(JSON.stringify(data[k])) : null; },
    setJSON: async function (k, v) { this.writes += 1; data[k] = JSON.parse(JSON.stringify(v)); return { modified: true, etag: "e" }; },
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
const lead = { firstName: "Marisol", lastName: "Venkataraman", emails: ["marisol.v@example.com"], phones: ["(970) 555-0177"],
  notes: "a ranch with a horse arena" };
const entry = (minutesAgo, extra) => ({ at: new Date(NOW - minutesAgo * 60000).toISOString(), formName: "contact", lead, ...extra });

function hubFake(calls, { status = 200, body = { recorded: true }, throws = false } = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (throws) throw Object.assign(new Error(`down ${INTAKE_KEY}`), { name: "TimeoutError" });
    return resp(status, body);
  };
}

(async () => {
  process.env.HUB_API_URL = HUB;
  process.env.HUB_API_KEY = "hub_email_key";
  process.env.HUB_INTAKE_KEY = INTAKE_KEY;
  delete process.env.LEAD_STUCK_TO_HUB; delete process.env.LEAD_STUCK_ALERT; delete process.env.LOFTY_QUEUE_DRAIN;
  fresh();
  const S = require(`${FN_DIR}/lib/_lead-stuck.js`);
  const L = require(`${FN_DIR}/lib/_lofty.js`);

  console.log("\n1. The switch");
  for (const v of ["on", " ON ", "On"]) check(`${JSON.stringify(v)} is on`, S.stuckToHubOn({ LEAD_STUCK_TO_HUB: v }) === true);
  for (const v of [undefined, "", "true", "1", "yes", "onn"]) check(`${JSON.stringify(v)} is off`, S.stuckToHubOn({ LEAD_STUCK_TO_HUB: v }) === false);
  let calls = [];
  let store = blobStore({ [L.FAILED_PUSH_KEY]: [entry(90)] });
  let r = await S.reportStuckToHub(store, { now: NOW, fetchImpl: hubFake(calls) });
  check("off: enabled:false, no call", r.enabled === false && calls.length === 0, JSON.stringify(r));

  console.log("\n2. The counts");
  const counts = S.stuckCounts([
    entry(30), entry(130),
    entry(400, { loftyId: "77", followupsPending: ["note"] }), // Lofty has it: not counted
    entry(10, { manualReview: true }),                          // held for identity review: failed
    { at: new Date(NOW - 5 * 60000).toISOString(), formName: "contact" }, // nothing kept to replay: failed
    { formName: "contact", lead },                               // no readable queue time: failed
    null,
  ], NOW);
  check("pending 2, failed 3, the oldest pending waited 130 minutes", JSON.stringify(counts) === '{"pending":2,"failed":3,"oldest_age_minutes":130}', JSON.stringify(counts));
  check("an empty queue: zeros and no age", JSON.stringify(S.stuckCounts([], NOW)) === '{"pending":0,"failed":0,"oldest_age_minutes":null}' &&
    JSON.stringify(S.stuckCounts(null, NOW)) === '{"pending":0,"failed":0,"oldest_age_minutes":null}');

  const THIS = SIGNATURE ? "signature" : "tllsh";
  const OTHER = SIGNATURE ? "tllsh" : "signature";
  const shared = S.stuckCounts([entry(30, { site: THIS }), entry(200, { site: OTHER }), entry(50), entry(5, { site: OTHER, manualReview: true })], NOW);
  check("a shared store: the other site's entries are not counted (an entry with no site is this site's)",
    JSON.stringify(shared) === '{"pending":2,"failed":0,"oldest_age_minutes":50}', JSON.stringify(shared));
  check("...the site is read from this site's own copy of lib/_notify.js", S.stuckCounts([entry(9, { site: "x" })], NOW, "x").pending === 1 &&
    S.stuckCounts([entry(9, { site: "x" })], NOW).pending === 0);

  console.log("\n3. On: one call, the four numbers only");
  const env = { LEAD_STUCK_TO_HUB: "on", HUB_API_URL: HUB, HUB_INTAKE_KEY: INTAKE_KEY };
  calls = [];
  store = blobStore({ [L.FAILED_PUSH_KEY]: [entry(90), entry(20)] });
  r = await S.reportStuckToHub(store, { now: NOW, env, fetchImpl: hubFake(calls) });
  const c = calls[0] || { init: {} };
  check("one POST to /v1/leads/stuck-report", calls.length === 1 && c.url === `${HUB}/v1/leads/stuck-report` && c.init.method === "POST");
  check("exactly site, pending, failed, oldest_age_minutes", JSON.stringify(Object.keys(c.body || {})) === '["site","pending","failed","oldest_age_minutes"]' &&
    c.body.site === DOMAIN && c.body.pending === 2 && c.body.failed === 0 && c.body.oldest_age_minutes === 90, JSON.stringify(c.body));
  check("the site is a host name the hub accepts", /^[a-z0-9][a-z0-9.-]{0,63}$/.test(c.body.site));
  check("the intake key in x-hub-key, redirect refused, a time limit", c.init.headers && c.init.headers["x-hub-key"] === INTAKE_KEY &&
    c.init.redirect === "manual" && !!c.init.signal);
  for (const s of SECRETS) check(`the report does not contain "${s}"`, !JSON.stringify(c.body).includes(s));
  check("answered ok", r.enabled && r.sent && r.ok === true && r.httpStatus === 200, JSON.stringify(r));
  check("nothing written to the store", store.writes === 0);

  console.log("\n4. When things go wrong");
  calls = [];
  r = await S.reportStuckToHub(blobStore({}, { failGet: true }), { now: NOW, env, fetchImpl: hubFake(calls) });
  check("a queue that cannot be read: nothing sent (never zeros)", calls.length === 0 && r.sent === false && /could not be read/.test(r.reason), JSON.stringify(r));
  for (const bad of [{ leads: [] }, "a string", 42, true]) {
    r = await S.reportStuckToHub(blobStore({ [L.FAILED_PUSH_KEY]: bad }), { now: NOW, env, fetchImpl: hubFake(calls) });
    check(`a stored queue that is not a list (${JSON.stringify(bad)}): unreadable, nothing sent`, calls.length === 0 && r.sent === false &&
      /not a list/.test(r.reason), JSON.stringify(r));
  }
  r = await S.reportStuckToHub(blobStore({}), { now: NOW, env, fetchImpl: hubFake(calls) });
  check("nothing stored at all: an empty queue (zeros are true then)", calls.length === 1 && calls[0].body.pending === 0 && r.ok === true, JSON.stringify(r));
  calls = [];
  r = await S.reportStuckToHub(blobStore({}), { now: NOW, env: { LEAD_STUCK_TO_HUB: "on", HUB_API_URL: HUB }, fetchImpl: hubFake(calls) });
  check("no intake key: nothing sent, the setting named", calls.length === 0 && r.reason === "HUB_INTAKE_KEY not set", JSON.stringify(r));
  r = await S.reportStuckToHub(blobStore({}), { now: NOW, env: { ...env, HUB_API_URL: "http://hub.example.test" }, fetchImpl: hubFake(calls) });
  check("http is refused", calls.length === 0 && /https/.test(r.reason));
  r = await S.reportStuckToHub(blobStore({}), { now: NOW, env, deadline: Date.now() + 100, fetchImpl: hubFake(calls) });
  check("no time left in the run: nothing sent", calls.length === 0 && /no time/.test(r.reason));
  r = await S.reportStuckToHub(blobStore({}), { now: NOW, env, fetchImpl: hubFake(calls, { status: 503, body: { error: "this route is switched off at the hub" } }) });
  check("the hub switched off: a failure with its words", r.sent && r.ok === false && r.httpStatus === 503 && /switched off/.test(r.error), JSON.stringify(r));
  r = await S.reportStuckToHub(blobStore({}), { now: NOW, env, fetchImpl: hubFake(calls, { status: 302, body: "" }) });
  check("a redirect is a failure, not followed", r.ok === false && r.httpStatus === 302);
  r = await S.reportStuckToHub(blobStore({}), { now: NOW, env, fetchImpl: hubFake(calls, { status: 200, body: { recorded: false } }) });
  check("a 200 that does not say recorded is not ok", r.ok === false);
  r = await S.reportStuckToHub(blobStore({}), { now: NOW, env, fetchImpl: hubFake(calls, { throws: true }) });
  check("the hub unreachable: the error name only, never the key", r.ok === false && r.error === "TimeoutError" && !JSON.stringify(r).includes(INTAKE_KEY));

  console.log("\n5. The scheduled drain sends it, also when paused, and its answer is unchanged");
  const runDrain = async (seed) => {
    const st = blobStore(seed);
    require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => st } };
    fresh();
    const out = await require(`${FN_DIR}/lofty-queue-drain.js`).handler();
    return { st, out };
  };
  const reports = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v1/leads/stuck-report")) { reports.push(JSON.parse(init.body)); return resp(200, { recorded: true }); }
    if (/\/leads\?/.test(u)) return resp(200, { leads: [] });
    return resp(401, { message: "bad key" });
  };
  const keep = [console.log, console.warn, console.error];
  const quiet = async (fn) => { console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { [console.log, console.warn, console.error] = keep; } };
  process.env.LEAD_STUCK_TO_HUB = "on";
  process.env.LOFTY_QUEUE_DRAIN = "off";
  const queued = { at: new Date(Date.now() - 75 * 60000).toISOString(), formName: "contact", lead };
  let d = await quiet(() => runDrain({ [L.FAILED_PUSH_KEY]: [queued] }));
  check("paused drain: answer unchanged, one report", /^paused/.test(d.out.body) && reports.length === 1 &&
    reports[0].pending === 1 && reports[0].oldest_age_minutes >= 74, `${d.out.body} / ${JSON.stringify(reports)}`);
  delete process.env.LOFTY_QUEUE_DRAIN;
  process.env.LOFTY_API_KEY = "k";
  reports.length = 0;
  d = await quiet(() => runDrain({ [L.FAILED_PUSH_KEY]: [queued] }));
  check("a drain run: answer ok, one report after it", d.out.statusCode === 200 && reports.length === 1, `${d.out.body} / ${reports.length}`);
  delete process.env.LEAD_STUCK_TO_HUB;
  reports.length = 0;
  d = await quiet(() => runDrain({ [L.FAILED_PUSH_KEY]: [queued] }));
  check("switch off: the drain sends no report", reports.length === 0 && d.out.statusCode === 200);

  console.log("\n6. The drain wires it next to the email check");
  const drainSrc = fs.readFileSync(`${FN_DIR}/lofty-queue-drain.js`, "utf8");
  check("stuckCheck runs the alert check and the report together", /Promise\.all\(\[\s*stuckAlerts\(/.test(drainSrc) && /stuckReport\(getStore/.test(drainSrc));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
