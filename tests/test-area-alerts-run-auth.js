// Who may start an area-alerts run (2026-10-18, endpoint audit security flag 10).
//
// Since its schedule was removed (2026-10-13) area-alerts-run is an ordinary
// function anyone can call by URL. A run now needs the header
// x-area-alerts-key = AREA_ALERTS_RUN_KEY (constant-time compare; unset = 503,
// wrong = 401), or Netlify's scheduled-run marker -- and that marker counts only
// while RUNS_ON_SCHEDULE is true, which must match netlify.toml. A refused call
// reads nothing and sends nothing. The hub and Blobs are stubbed: no network.
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// Made-up values only.
const KEY = "made-up-area-alerts-run-key-42";
const MARKER = JSON.stringify({ next_run: "2026-10-18T18:00:00.000Z" });

let blobCalls = 0;
let fetches = 0;
const logs = [];
function load() {
  const store = {
    get: async () => { blobCalls++; return null; },
    setJSON: async () => { blobCalls++; },
    list: async () => { blobCalls++; return { blobs: [] }; },
  };
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => { blobCalls++; return store; } } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  return require(`${FN_DIR}/area-alerts-run.js`);
}

async function run(env, event) {
  for (const k of ["AREA_ALERTS_RUN_KEY", "AREA_ALERTS_APPROVED_BY", "LISTINGS_SOURCE", "IDX_DISPLAY", "HUB_API_URL", "HUB_API_KEY"]) delete process.env[k];
  Object.assign(process.env, { BLOBS_SITE_ID: "s", BLOBS_TOKEN: "t" }, env);
  blobCalls = 0; fetches = 0; logs.length = 0;
  global.fetch = async () => { fetches++; throw new Error("no network in tests"); };
  const mod = load();
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const cap = (...a) => logs.push(a.map(String).join(" "));
  console.log = cap; console.warn = cap; console.error = cap;
  try { return await mod.handler(event); }
  finally { Object.assign(console, orig); }
}

const withKey = (v, name = "x-area-alerts-key") => ({ headers: { [name]: v } });

(async () => {
  console.log("\n1. AREA_ALERTS_RUN_KEY unset (as it is today): nobody can start a run");
  for (const [label, env, event] of [
    ["no event at all", {}, undefined],
    ["a key sent anyway", {}, withKey(KEY)],
    ["a scheduled-run marker", {}, { body: MARKER }],
    ["a blank setting", { AREA_ALERTS_RUN_KEY: "   " }, withKey("   ")],
    ["a setting under 16 characters", { AREA_ALERTS_RUN_KEY: "short-key" }, withKey("short-key")],
  ]) {
    const r = await run(env, event);
    check(`${label}: 503`, r.statusCode === 503 && /^AREA_ALERTS_RUN_KEY is not set on this site/.test(r.body), JSON.stringify(r));
    check(`${label}: nothing read, nothing fetched`, blobCalls === 0 && fetches === 0, `blobs ${blobCalls}, fetches ${fetches}`);
  }

  console.log("\n2. Key set: only the exact key in the header gets in");
  const SET = { AREA_ALERTS_RUN_KEY: KEY, LISTINGS_SOURCE: "lofty" };
  for (const [label, event] of [
    ["no event", undefined],
    ["no headers", {}],
    ["no key header", { headers: { authorization: `Bearer ${KEY}` } }],
    ["a wrong key", withKey("made-up-area-alerts-run-key-43")],
    ["one character short", withKey(KEY.slice(0, -1))],
    ["one character more", withKey(KEY + "x")],
    ["the key in the query string only", { headers: {}, queryStringParameters: { key: KEY } }],
    ["the key in another header", withKey(KEY, "x-hub-key")],
    ["a scheduled-run marker (no schedule, so it counts for nothing)", { body: MARKER }],
    ["a base64 scheduled-run marker", { body: Buffer.from(MARKER).toString("base64"), isBase64Encoded: true }],
  ]) {
    const r = await run(SET, event);
    check(`${label}: 401`, r.statusCode === 401 && r.body === "unauthorized", JSON.stringify(r));
    check(`${label}: nothing read, nothing fetched`, blobCalls === 0 && fetches === 0, `blobs ${blobCalls}, fetches ${fetches}`);
    check(`${label}: the key never appears in the answer or the log`, !r.body.includes(KEY) && !logs.some((l) => l.includes(KEY)), logs.join(" | "));
  }
  let r = await run(SET, withKey(KEY));
  check("the right key: the run goes on to its own gates (paused on Lofty listings, as before)", r.statusCode === 200 && /paused/.test(r.body), JSON.stringify(r));
  r = await run(SET, withKey(` ${KEY} `));
  check("surrounding spaces are ignored, like the toolkit's checkKey", r.statusCode === 200 && /paused/.test(r.body), JSON.stringify(r));
  r = await run(SET, withKey(KEY, "X-Area-Alerts-Key"));
  check("the header name in any case", r.statusCode === 200 && /paused/.test(r.body), JSON.stringify(r));
  r = await run({ ...SET, AREA_ALERTS_RUN_KEY: ` ${KEY} ` }, withKey(KEY));
  check("a setting pasted with spaces still works", r.statusCode === 200, JSON.stringify(r));
  r = await run({ AREA_ALERTS_RUN_KEY: KEY, LISTINGS_SOURCE: "mlsgrid", IDX_DISPLAY: "on" }, withKey(KEY));
  check("with the key, the run's own gates still apply (stale listing data here: nothing sent)", fetches === 0 && /^held: |skipped: /.test(r.body), r.body);

  console.log("\n3. The scheduled-run marker counts only while the function is scheduled");
  const mod = load();
  check("RUNS_ON_SCHEDULE is false today", mod.RUNS_ON_SCHEDULE === false);
  const toml = fs.readFileSync(`${ROOT}/netlify.toml`, "utf8");
  const scheduled = /\[functions\."area-alerts-run"\][^[]*?\bschedule\s*=/.test(toml);
  check("RUNS_ON_SCHEDULE matches netlify.toml (put the schedule back = set it true, and only then)",
    mod.RUNS_ON_SCHEDULE === scheduled, `constant ${mod.RUNS_ON_SCHEDULE}, netlify.toml scheduled ${scheduled}`);
  check("scheduled: Netlify's marker gets in without a key", mod.runRefusal({ body: MARKER }, {}, true) === null);
  check("scheduled: a base64 marker too", mod.runRefusal({ body: Buffer.from(MARKER).toString("base64"), isBase64Encoded: true }, {}, true) === null);
  check("scheduled: anything else still needs the key", mod.runRefusal({ body: "{}" }, {}, true).statusCode === 503 &&
    mod.runRefusal({ body: "not json" }, { AREA_ALERTS_RUN_KEY: KEY }, true).statusCode === 401 &&
    mod.runRefusal({ body: JSON.stringify({ next_run: 1 }) }, { AREA_ALERTS_RUN_KEY: KEY }, true).statusCode === 401 &&
    mod.runRefusal(undefined, { AREA_ALERTS_RUN_KEY: KEY }, true).statusCode === 401);
  check("not scheduled: the marker is refused", mod.runRefusal({ body: MARKER }, { AREA_ALERTS_RUN_KEY: KEY }, false).statusCode === 401);

  console.log("\n4. The compare");
  const src = fs.readFileSync(`${FN_DIR}/area-alerts-run.js`, "utf8");
  check("constant time: SHA-256 digests through crypto.timingSafeEqual", /crypto\.timingSafeEqual\(digest\(got\), digest\(want\)\)/.test(src));
  check("no plain === / !== against the key", !/(===|!==)\s*want\b|\bwant\s*(===|!==)|(===|!==)\s*(process\.)?env\.AREA_ALERTS_RUN_KEY/.test(src));
  check("the gate runs first in the handler", /exports\.handler = async \(event\) => \{\n\s+const refused = runRefusal\(event, process\.env\);/.test(src));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
