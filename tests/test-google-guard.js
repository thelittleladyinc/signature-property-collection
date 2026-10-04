// Nobody can make this site spend Google money on an address it never shows.
//
// 2026-09-30 (API audit). nearby-places and walkability answered any ?address= /
// ?place=, each new string a paid geocode plus six or ten Places calls, through
// two public doors (the Little Lady site passes both straight through). Now a
// fresh lookup happens only for a known town, a neighbourhood inside one, or a
// listing the site is showing -- and at most a daily allowance of those. Cached
// answers are unaffected.
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

function memStore(seed) {
  const m = { ...(seed || {}) };
  return { _m: m, get: async (k) => (k in m ? m[k] : null), setJSON: async (k, v) => { m[k] = v; } };
}
function load(name, store) {
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true,
    exports: { getStore: () => store } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  return require(`${FN_DIR}/${name}`).handler;
}
let googleCalls = 0;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes("googleapis.com")) googleCalls += 1;
  if (u.includes("/geocode/")) {
    return { ok: true, status: 200, json: async () => ({ status: "OK", results: [{ geometry: { location: { lat: 40.4, lng: -105.07 } } }] }) };
  }
  if (u.includes("/place/nearbysearch/")) {
    return { ok: true, status: 200, json: async () => ({ status: "OK", results: [
      { name: "A place", place_id: "p1", geometry: { location: { lat: 40.41, lng: -105.06 } } }] }) };
  }
  return { ok: true, status: 200, json: async () => ({ status: "OK", rows: [{ elements: [] }] }) };
};
process.env.GOOGLE_MAPS_API_KEY = "gkey";
const ev = (q) => ({ queryStringParameters: q });

// Her listing, stored where the site keeps what it shows (lofty keys by default).
const HERS = { listingId: "IRE1", address: "123 Example Ct", city: "Loveland", state: "CO", zip: "80537", agentName: "Christine Gwinnup" };

(async () => {
  console.log("\n1. nearby-places");
  for (const [label, address, expectCalls] of [
    ["a town page's drive-time string", "Ault, Weld County, CO", true],
    ["Windsor, which straddles two counties", "Windsor, Larimer County, CO", true],
    ["one of her listings, as the card sends it", "123 Example Ct, Loveland, CO, 80537", true],
    ["any other street address", "1600 Pennsylvania Ave NW, Washington, DC", false],
    ["a made-up county on a real town", "Loveland, Narnia County, CO", false],
    ["a town the site does not know", "Zzyzx, CO", false],
  ]) {
    const store = memStore({ "lofty-mine-listings.json": [HERS] });
    googleCalls = 0;
    const body = JSON.parse((await load("nearby-places.js", store)(ev({ address, only: "gas" }))).body);
    if (expectCalls) check(`${label}: looked up`, googleCalls > 0 && !body.error, JSON.stringify(body).slice(0, 120));
    else check(`${label}: refused, no Google call`, googleCalls === 0 && body.error === "unknown_address", JSON.stringify(body));
  }

  console.log("\n2. walkability");
  for (const [label, q, expectCalls] of [
    ["a town page", { place: "Loveland, CO" }, true],
    ["a neighbourhood page", { place: "Mariana Butte, Loveland, CO", near: "Loveland, CO" }, true],
    ["a neighbourhood claiming a different town", { place: "Anything, Berthoud, CO", near: "Loveland, CO" }, false],
    ["any other place", { place: "Paris, France" }, false],
  ]) {
    googleCalls = 0;
    const body = JSON.parse((await load("walkability.js", memStore())(ev(q))).body);
    if (expectCalls) check(`${label}: scored`, googleCalls > 0 && !body.error, JSON.stringify(body).slice(0, 120));
    else check(`${label}: refused, no Google call`, googleCalls === 0 && body.error === "unknown_place", JSON.stringify(body));
  }

  console.log("\n3. The daily allowance");
  const { DAILY_LIMITS, BUDGET_PREFIX } = require(`${FN_DIR}/lib/_google-guard.js`);
  const today = new Date().toISOString().slice(0, 10);
  let store = memStore({ [`${BUDGET_PREFIX}nearby-places/${today}`]: { used: DAILY_LIMITS["nearby-places"] } });
  googleCalls = 0;
  let body = JSON.parse((await load("nearby-places.js", store)(ev({ address: "Ault, Weld County, CO" }))).body);
  check("a spent allowance refuses even a known town", googleCalls === 0 && body.error === "daily_limit", JSON.stringify(body));
  store = memStore({ [`${BUDGET_PREFIX}walkability/${today}`]: { used: DAILY_LIMITS.walkability } });
  googleCalls = 0;
  body = JSON.parse((await load("walkability.js", store)(ev({ place: "Loveland, CO" }))).body);
  check("...on walkability too", googleCalls === 0 && body.error === "daily_limit", JSON.stringify(body));
  store = memStore();
  await load("nearby-places.js", store)(ev({ address: "Ault, Weld County, CO", only: "gas" }));
  check("a fresh lookup is counted", (store._m[`${BUDGET_PREFIX}nearby-places/${today}`] || {}).used === 1);

  console.log("\n4. Cached answers are free and unaffected");
  const cachedStore = memStore({
    "paris, france": { place: "Paris, France", score: 90, categories: [], cachedAt: Date.now() },
  });
  googleCalls = 0;
  body = JSON.parse((await load("walkability.js", cachedStore)(ev({ place: "Paris, France" }))).body);
  check("a cached entry is still served", body.score === 90 && googleCalls === 0, JSON.stringify(body));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
