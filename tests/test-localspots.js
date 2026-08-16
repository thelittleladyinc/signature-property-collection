// The local-spots endpoint must geocode once, cache, and never return a pin it
// couldn't place — a wrong pin puts Christine's recommendation on the wrong
// business, so "fewer pins" has to be the failure mode.
// Repo root derived from this file's own location, never hardcoded: these suites
// run both locally and in GitHub Actions, where the checkout is at
// /home/runner/work/<repo>/<repo>. An absolute path would pass here and fail there.
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

function load(store) {
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true,
    exports: { getStore: () => store } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  return require(`${FN_DIR}/local-spots.js`).handler;
}
function memStore() {
  const m = {};
  return { _m: m, get: async (k) => (k in m ? m[k] : null), setJSON: async (k, v) => { m[k] = v; } };
}

process.env.GOOGLE_MAPS_API_KEY = "gkey";
const curatedSpots = require(`${ROOT}/netlify/functions/lib/_local-spots.json`).spots;

(async () => {
  console.log("\n1. All spots geocode cleanly");
  let calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({
      status: "OK",
      results: [{ geometry: { location: { lat: 40.4, lng: -105.1 } }, formatted_address: "somewhere, CO" }],
    }) };
  };
  const store = memStore();
  let res = await load(store)({});
  let body = JSON.parse(res.body);
  check("returns 200", res.statusCode === 200);
  check("every curated spot resolved", body.resolved >= 14 && body.total >= 14, JSON.stringify({ r: body.resolved, t: body.total }));
  // Two spots can legitimately share an address (Downtown Loveland and Taste of
  // Loveland are the same street), and the cache dedupes them within one run —
  // so calls <= spots, never more. Asserting equality punished correct dedup.
  const addrs = new Set(curatedSpots.map(s => [s.address, s.city, "CO"].filter(Boolean).join(", ").toLowerCase()));
  check("no address is geocoded more than once", calls.length === addrs.size,
    `${calls.length} calls for ${addrs.size} distinct addresses`);
  check("address includes city AND state", /Loveland%2C%20CO|Loveland,%20CO/.test(calls.join("|")) || calls.some(c => /Loveland/.test(c) && /CO/.test(c)));
  check("every pin has coordinates", body.spots.every(s => typeof s.lat === "number" && typeof s.lng === "number"));
  check("every pin carries something of HERS (video or review)",
    body.spots.every(s => !!s.videoId || !!s.reviewQuote || !!s.googleReviewUrl));
  // A spot may be pinned before its numbers are known (Bobcat Ridge is), so the
  // rule is that a count, when present, is a real positive number.
  check("view counts, where present, are real numbers",
    body.spots.every(s => (s.views === undefined || s.views > 0) &&
                          (s.reviewViews === undefined || s.reviewViews > 0)));
  check("most pins do carry a view count",
    body.spots.filter(s => s.views || s.reviewViews).length >= body.spots.length - 2);
  // Derived from the data file rather than hardcoded: the top pin changes as
  // she adds videos, and a test that names one becomes a lie the day it does.
  const curated = require(`${ROOT}/netlify/functions/lib/_local-spots.json`).spots;
  const expectedTop = curated.slice().sort((a, b) => (b.views || 0) - (a.views || 0))[0].name;
  check("the top-viewed pin matches the curated data", 
    body.spots.slice().sort((a, b) => b.views - a.views)[0].name === expectedTop, expectedTop);
  check("categories are varied, not all one glyph", new Set(body.spots.map(s => s.category)).size >= 6,
    JSON.stringify([...new Set(body.spots.map(s => s.category))]));
  check("internal notes are NOT shipped to the browser", !/_why|_generated/.test(res.body));
  check("response is cached at the edge", /max-age=3600/.test(res.headers["Cache-Control"]));

  console.log("\n2. Second request is served entirely from cache");
  calls = [];
  res = await load(store)({});
  body = JSON.parse(res.body);
  check("zero geocoding calls", calls.length === 0, `${calls.length} calls`);
  check("still every pin", body.resolved === body.total);

  console.log("\n3. A spot Google can't find is DROPPED, not guessed");
  calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (/El\+Pueblito|1499/.test(String(url))) {
      return { ok: true, status: 200, json: async () => ({ status: "ZERO_RESULTS", results: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({
      status: "OK", results: [{ geometry: { location: { lat: 40.4, lng: -105.1 } }, formatted_address: "x" }] }) };
  };
  res = await load(memStore())({});
  body = JSON.parse(res.body);
  check("exactly one pin fewer than the full set", body.resolved === body.total - 1 && body.total > 1, JSON.stringify({ r: body.resolved, t: body.total }));
  check("the unplaceable spot is absent", !body.spots.some(s => s.name === "El Pueblito Mexican Restaurant"));
  check("no pin has a null/NaN coordinate", body.spots.every(s => Number.isFinite(s.lat) && Number.isFinite(s.lng)));

  console.log("\n4. Google returning 200-with-error-in-body is treated as failure");
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "REQUEST_DENIED", error_message: "key not authorized" }) });
  res = await load(memStore())({});
  body = JSON.parse(res.body);
  check("no pins invented", body.spots.length === 0, JSON.stringify(body.spots));
  check("still HTTP 200 so the map draws", res.statusCode === 200);

  console.log("\n5. No key, and no Blobs, must both degrade quietly");
  delete process.env.GOOGLE_MAPS_API_KEY;
  res = await load(memStore())({});
  check("empty list with a reason", JSON.parse(res.body).spots.length === 0 && /Geocoding isn't configured/.test(res.body));
  process.env.GOOGLE_MAPS_API_KEY = "gkey";
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    status: "OK", results: [{ geometry: { location: { lat: 1, lng: 2 } }, formatted_address: "x" }] }) });
  const brokenStore = { get: async () => { throw new Error("blobs down"); }, setJSON: async () => { throw new Error("blobs down"); } };
  res = await load(brokenStore)({});
  var b5 = JSON.parse(res.body);
  check("Blobs failure still yields every pin", b5.resolved === b5.total && b5.total > 0, JSON.stringify({ r: b5.resolved, t: b5.total }));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
