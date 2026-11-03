// The status key: with STATUS_KEY set, /status shows row names and lights to
// everyone and its details only to the key; /mls-usage and refresh-my-listings
// need the key. With STATUS_KEY unset, every page answers exactly as before.
//
// 2026-11-03 (endpoint audit): /status printed listing street addresses (one a
// Lofty record the MLS says is off the market), the last lead's form and time,
// the retry queue and which settings are on; ?format=json returned raw records;
// ?probe=1 ran live Google and Lofty checks for anyone. The hub's daily
// Connections check reads /status?format=json for allOk and each check's name,
// ok and optional, so those stay public. lib/_status-key.js is shared byte for
// byte by both websites.
"use strict";
process.exitCode = 1;
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${String(x).slice(0, 300)}` : ""}`); } };

const ADDRESS = "742 Evergreen Terrace";
const state = { lastRun: "2026-11-03T15:00:00.000Z", mlsCheck: "checked", hiddenOffMarket: [
  { listingId: "IRE1000001", address: ADDRESS, city: "Loveland", status: "Active", why: "the MLS says Expired" },
] };
const mine = [{ id: "IRE1000002", address: "1 Main St", detailsFor: "x" }];
const lastPush = { at: "2026-11-03T14:00:00.000Z", formName: "contact", ok: true, httpStatus: 200, payloadShape: "full",
  leadId: "1148639689762408", emailResult: { attempted: true, ok: true, httpStatus: 200 },
  noteResult: { attempted: true, ok: true, httpStatus: 200 }, tagResult: { attempted: true, ok: true, step: "added", tagRestored: true } };

let fetches = 0;
function load(name) {
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
    getStore: () => ({
      get: async (k) => (/sync-state\.json$/.test(k) ? state : /mine-listings\.json$/.test(k) ? mine : k === "lofty-last-push.json" ? lastPush : null),
      setJSON: async () => {}, set: async () => {}, list: async () => ({ blobs: [] }),
    }),
  } };
  for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  process.env.LOFTY_API_KEY = "k";
  process.env.HUB_API_URL = "https://hub.example.test/functions/v1/hub-api"; process.env.HUB_API_KEY = "hub_test";
  global.fetch = async () => { fetches++; throw new Error("no live calls in this test"); };
  const mod = require(`${FN_DIR}/${name}.js`);
  return mod.localHandler || mod.handler;
}
const quiet = async (fn) => { const w = console.warn, l = console.log, e = console.error; console.warn = console.log = console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; console.error = e; } };
const status = (params, headers) => quiet(() => load("site-health")({ queryStringParameters: params || {}, headers: headers || {} }));
const KEY = "status-test-key-7f3a";

(async () => {
  console.log("\n1. STATUS_KEY unset: everything exactly as before");
  delete process.env.STATUS_KEY;
  let html = (await status({})).body;
  let json = JSON.parse((await status({ format: "json" })).body);
  check("the page shows the hidden listing's address", html.includes(ADDRESS));
  check("the JSON carries the details and the raw records", json.checks.some((c) => typeof c.detail === "string") && json.raw && typeof json.allOk === "boolean");
  check("the page does not mention a status key", !/status key/i.test(html));
  const openNames = json.checks.map((c) => c.name);

  console.log("\n2. STATUS_KEY set, no key presented: names and lights only");
  process.env.STATUS_KEY = KEY;
  const res = await status({});
  html = res.body;
  check("the page still answers 200", res.statusCode === 200);
  check("no address on the page", !html.includes(ADDRESS), html.match(/Evergreen[^<]*/) && html.match(/Evergreen[^<]*/)[0]);
  check("no form name or push time on the page", !html.includes("contact") && !html.includes(lastPush.at));
  const escaped = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  check("every row name is still on the page", openNames.every((n) => html.includes(escaped(n))), openNames.filter((n) => !html.includes(escaped(n))).join(" | "));
  check("the page says the details need the status key", /status key/i.test(html) && /STATUS_KEY/.test(html));
  check("the key itself is not on the page", !html.includes(KEY));
  const jres = await status({ format: "json" });
  json = JSON.parse(jres.body);
  check("JSON: allOk and the checks, each with name, ok and optional only",
    typeof json.allOk === "boolean" && Array.isArray(json.checks) && json.checks.length === openNames.length &&
    json.checks.every((c) => typeof c.name === "string" && typeof c.ok === "boolean" && typeof c.optional === "boolean" && Object.keys(c).length === 3),
    JSON.stringify(json.checks[0]));
  check("JSON: no detail, no raw records, no settings", !("raw" in json) && !("cloudinaryConfig" in json) && !jres.body.includes(ADDRESS) && !jres.body.includes(lastPush.at));
  check("JSON says why", json.details === "hidden" && /status key/i.test(json.why) && !jres.body.includes(KEY));
  fetches = 0;
  await status({ probe: "1" });
  await status({ google: "1", lofty: "true" });
  check("?probe=1 (and ?google=1 / ?lofty=1) run no live check without the key", fetches === 0, `${fetches} fetch call(s)`);

  console.log("\n3. The right key opens the details; a wrong one does not");
  html = (await status({ key: KEY })).body;
  check("?key= shows the address again", html.includes(ADDRESS));
  json = JSON.parse((await status({ format: "json", key: KEY })).body);
  check("?key= gives the full JSON again", json.raw && json.checks.some((c) => typeof c.detail === "string"));
  html = (await status({}, { "x-status-key": KEY })).body;
  check("the x-status-key header works too", html.includes(ADDRESS));
  html = (await status({ key: KEY + "x" })).body;
  check("a wrong key hides the details", !html.includes(ADDRESS));
  html = (await status({ key: "" })).body;
  check("an empty key hides the details", !html.includes(ADDRESS));

  console.log("\n4. refresh-my-listings and /mls-usage need the key");
  const refresh = load("refresh-my-listings");
  let r = await quiet(() => refresh({ httpMethod: "POST", queryStringParameters: {}, headers: {} }));
  check("a POST without the key is refused with 401", r.statusCode === 401 && /status key/i.test(r.body) && !r.body.includes(KEY), JSON.stringify(r));
  r = await quiet(() => refresh({ httpMethod: "POST", queryStringParameters: { key: KEY }, headers: {} }));
  check("with the key the request goes past the gate (not 401)", r.statusCode !== 401, JSON.stringify(r));
  r = await quiet(() => refresh({ httpMethod: "GET", queryStringParameters: {}, headers: {} }));
  check("a GET is still 405, as before", r.statusCode === 405);
  const usage = load("mls-usage");
  r = await quiet(() => usage({ queryStringParameters: {}, headers: {} }));
  check("/mls-usage without the key is refused with 401", r.statusCode === 401 && /status key/i.test(r.body), JSON.stringify(r));
  r = await quiet(() => usage({ queryStringParameters: {}, headers: { "x-status-key": KEY } }));
  check("/mls-usage with the key answers (not 401)", r.statusCode !== 401, JSON.stringify(r).slice(0, 200));
  delete process.env.STATUS_KEY;
  r = await quiet(() => usage({ queryStringParameters: {}, headers: {} }));
  check("/mls-usage with STATUS_KEY unset answers as before (not 401)", r.statusCode !== 401);

  console.log("\n5. One shared helper, the same on both sites");
  const helper = fs.readFileSync(`${FN_DIR}/lib/_status-key.js`, "utf8");
  check("the helper compares keys in constant time", /timingSafeEqual/.test(helper));
  for (const other of ["thelittleladysellshomes", "signature-property-collection"]) {
    const p = path.join(ROOT, "..", other, "netlify", "functions", "lib", "_status-key.js");
    if (path.resolve(path.join(ROOT, "..", other)) === ROOT) continue;
    if (fs.existsSync(p)) check(`lib/_status-key.js matches the ${other} copy`, fs.readFileSync(p, "utf8") === helper);
    else console.log(`  --   ${other} checkout not present; skipping the drift check`);
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
