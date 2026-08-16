// Drive time to the nearest restaurant and gas station.
//
// 2026-08-16 (Christine: "maybe do a miles minutes to the closest restaurant and gas
// station"). Every failure mode here is a number, which is the worst kind: a wrong
// mileage looks exactly as authoritative as a right one, and an agent quotes it to a
// buyer standing in the driveway.
//
// So the rules pinned here are about where numbers may come from:
//   * A drive time is shown only when Google returned a route. Never derived from
//     straight-line miles by assuming a speed.
//   * Driving miles and straight-line miles are never mixed in one string. Out past
//     Nunn they differ by a factor of three.
//   * Distance Matrix not being enabled on her key degrades to miles-only. It must
//     not blank the panel and must not throw.
//   * The cache expires PER CATEGORY. A shared timestamp meant a restaurant that
//     closed years ago could be renewed indefinitely by gas-station lookups.
//   * `only=` really limits the Places calls, because the town panel runs on 141
//     pages and each unwanted category is a paid call per town.
//
// Repo root derived from this file's own location, never hardcoded: these suites
// run both locally and in GitHub Actions, where the checkout is at
// /home/runner/work/<repo>/<repo>. An absolute path would pass here and fail there.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
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
  return require(`${FN_DIR}/nearby-places.js`).handler;
}
function memStore() {
  const m = {};
  return { _m: m, get: async (k) => (k in m ? m[k] : null), setJSON: async (k, v) => { m[k] = v; } };
}

// A Google stand-in. Records every call so the test can assert on WHICH APIs were
// hit and how many times -- the cost story is the point of the caching.
function google({ dmStatus = "OK", dmHttp = 200 } = {}) {
  const calls = { geocode: [], places: [], dm: [] };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/geocode/")) {
      calls.geocode.push(u);
      return { ok: true, status: 200, json: async () => ({
        status: "OK", results: [{ geometry: { location: { lat: 40.87, lng: -104.78 } } }] }) };
    }
    if (u.includes("/place/nearbysearch/")) {
      calls.places.push(u);
      const type = (u.match(/[?&]type=([^&]+)/) || [])[1];
      return { ok: true, status: 200, json: async () => ({ status: "OK", results: [
        { name: `${type} one`, place_id: `pid-${type}-1`,
          geometry: { location: { lat: 40.9, lng: -104.7 } } },
        { name: `${type} two`, place_id: `pid-${type}-2`,
          geometry: { location: { lat: 41.0, lng: -104.6 } } },
      ] }) };
    }
    if (u.includes("/distancematrix/")) {
      calls.dm.push(u);
      if (dmHttp !== 200) return { ok: false, status: dmHttp, json: async () => ({}) };
      const n = decodeURIComponent((u.match(/destinations=([^&]+)/) || ["", ""])[1])
        .split("|").filter(Boolean).length;
      return { ok: true, status: 200, json: async () => ({
        status: dmStatus,
        error_message: dmStatus === "OK" ? undefined : "This API project is not authorized",
        rows: [{ elements: Array.from({ length: n }, () => ({
          status: "OK",
          duration: { value: 372 },            // 6.2 min -> 6
          distance: { value: 7402 },           // 4.6 mi
        })) }],
      }) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return calls;
}

process.env.GOOGLE_MAPS_API_KEY = "gkey";
const ev = (qs) => ({ queryStringParameters: qs });

(async () => {
  console.log("\n1. The town panel asks for two categories and pays for two");
  let calls = google();
  let store = memStore();
  let res = await load(store)(ev({ address: "Nunn, Weld County, CO", only: "dining,gas" }));
  let body = JSON.parse(res.body);
  check("200 with a JSON body", res.statusCode === 200 && !body.error, res.body.slice(0, 120));
  check("exactly the two categories asked for",
    JSON.stringify(Object.keys(body.categories).sort()) === '["dining","gas"]',
    JSON.stringify(Object.keys(body.categories)));
  check(`two Places calls, not six (${calls.places.length})`, calls.places.length === 2);
  check("gas really maps to gas_station", calls.places.some((u) => /type=gas_station/.test(u)),
    calls.places.join(" | "));
  check("one geocode", calls.geocode.length === 1);
  check(`one Distance Matrix call for both (${calls.dm.length})`, calls.dm.length === 1);
  check("Distance Matrix asked for driving, imperial",
    /mode=driving/.test(calls.dm[0]) && /units=imperial/.test(calls.dm[0]));

  console.log("\n2. Drive time comes from Google or is absent");
  const dining0 = body.categories.dining[0];
  check("nearest result carries driving minutes", dining0.drivingMinutes === 6,
    JSON.stringify(dining0));
  check("nearest result carries driving miles", dining0.drivingMiles === 4.6,
    String(dining0.drivingMiles));
  check("straight-line miles are still there as the floor",
    typeof dining0.distanceMiles === "number" && dining0.distanceMiles > 0);
  // The two kinds of mile must stay distinguishable, or a caller cannot avoid
  // printing one as the other.
  check("driving miles and straight-line miles are different fields",
    dining0.drivingMiles !== dining0.distanceMiles);
  // Only the NEAREST of each category gets a route -- that is the one shown, and
  // routing all three would triple the Distance Matrix cost for nothing.
  check("the second result has no invented drive time",
    body.categories.dining[1].drivingMinutes === undefined);

  console.log("\n3. Second call for the same address costs Google nothing");
  calls = google();
  res = await load(store)(ev({ address: "Nunn, Weld County, CO", only: "dining,gas" }));
  body = JSON.parse(res.body);
  check("served from cache", body.cached === true);
  check("zero Google calls of any kind",
    calls.geocode.length === 0 && calls.places.length === 0 && calls.dm.length === 0,
    JSON.stringify({ g: calls.geocode.length, p: calls.places.length, d: calls.dm.length }));
  check("still carries the drive time", body.categories.gas[0].drivingMinutes === 6);

  console.log("\n4. The listing panel asks for six and pays only for the four new ones");
  calls = google();
  res = await load(store)(ev({ address: "Nunn, Weld County, CO" }));
  body = JSON.parse(res.body);
  check("all six categories come back", Object.keys(body.categories).length === 6,
    JSON.stringify(Object.keys(body.categories)));
  check(`four Places calls, not six (${calls.places.length})`, calls.places.length === 4);
  check("no second geocode for an address already resolved", calls.geocode.length === 0);
  check("the two already-cached categories kept their drive times",
    body.categories.dining[0].drivingMinutes === 6 && body.categories.gas[0].drivingMinutes === 6);

  console.log("\n5. Each category expires on its own clock");
  // The bug this exists for: one shared timestamp, renewed by any partial fetch.
  // Dining is aged past the TTL while gas stays fresh; only dining may be re-fetched.
  const key = "nunn, weld county, co";
  const entry = store._m[key];
  const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000;
  check("the cache entry stamps each category separately",
    entry && entry.at && Object.keys(entry.at).length === 6, JSON.stringify(entry && entry.at));
  entry.at.dining = Date.now() - THIRTY_ONE_DAYS;
  calls = google();
  res = await load(store)(ev({ address: "Nunn, Weld County, CO", only: "dining,gas" }));
  body = JSON.parse(res.body);
  check("the stale category is re-fetched", calls.places.some((u) => /type=restaurant/.test(u)),
    calls.places.join(" | "));
  check("the fresh one is not", !calls.places.some((u) => /type=gas_station/.test(u)));
  check(`exactly one Places call (${calls.places.length})`, calls.places.length === 1);
  // And the renewal must not have back-dated or renewed the untouched category.
  const after = store._m[key];
  check("the untouched category keeps its original timestamp",
    after.at.gas === entry.at.gas, `${after.at.gas} vs ${entry.at.gas}`);

  console.log("\n6. Distance Matrix not enabled on the key degrades, never breaks");
  calls = google({ dmStatus: "REQUEST_DENIED" });
  store = memStore();
  res = await load(store)(ev({ address: "Carr, CO", only: "dining,gas" }));
  body = JSON.parse(res.body);
  check("still 200", res.statusCode === 200);
  check("still returns places", (body.categories.dining || []).length > 0);
  check("no drive time is invented", body.categories.dining[0].drivingMinutes === undefined &&
    body.categories.dining[0].drivingMiles === undefined, JSON.stringify(body.categories.dining[0]));
  check("straight-line miles still present", body.categories.dining[0].distanceMiles > 0);

  console.log("\n   ...and a Distance Matrix HTTP failure does the same");
  calls = google({ dmHttp: 500 });
  res = await load(memStore())(ev({ address: "Carr, CO", only: "gas" }));
  body = JSON.parse(res.body);
  check("still 200 with places", res.statusCode === 200 && body.categories.gas.length > 0);
  check("no drive time", body.categories.gas[0].drivingMinutes === undefined);

  console.log("\n7. No key at all, and a dead Blobs store");
  delete process.env.GOOGLE_MAPS_API_KEY;
  res = await load(memStore())(ev({ address: "Nunn, CO" }));
  check("says not_configured rather than guessing", JSON.parse(res.body).error === "not_configured");
  process.env.GOOGLE_MAPS_API_KEY = "gkey";
  google();
  const deadStore = { get: async () => { throw new Error("blobs down"); },
    setJSON: async () => { throw new Error("blobs down"); } };
  res = await load(deadStore)(ev({ address: "Nunn, CO", only: "dining,gas" }));
  body = JSON.parse(res.body);
  check("Blobs failure still yields real answers",
    res.statusCode === 200 && (body.categories.dining || []).length > 0, res.body.slice(0, 160));

  console.log("\n8. What the town pages actually shipped");
  const townPages = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".html")) townPages.push(p);
    }
  })(path.join(ROOT, "site", "communities"));
  // Derived, not a number typed in: a town page is one with a "Welcome To <Town>"
  // heading, which excludes the county pages and the Loveland subdivision pages. An
  // absolute threshold here would either pass forever or fail the day she adds a
  // town, and neither tells you whether every town page got the panel.
  const isTown = (p) => /<h2 class="section-title">Welcome To /.test(fs.readFileSync(p, "utf8"));
  const allTowns = townPages.filter(isTown);
  const withPanel = townPages.filter((p) => /class="town-far"/.test(fs.readFileSync(p, "utf8")));
  const townsWithout = allTowns.filter((p) => !withPanel.includes(p));
  check(`every town page has the panel (${withPanel.length} of ${allTowns.length})`,
    townsWithout.length === 0 && allTowns.length > 30,
    townsWithout.slice(0, 3).map((p) => path.relative(ROOT, p)).join(", "));
  // And nothing else does: a county page asking "nearest restaurant to Weld County"
  // would geocode the county centroid and answer a question nobody asked.
  const notTowns = withPanel.filter((p) => !allTowns.includes(p));
  check("and nothing but town pages has it", notTowns.length === 0,
    notTowns.slice(0, 3).map((p) => path.relative(ROOT, p)).join(", "));

  let badTown = [], hardcoded = [], noOnly = [];
  for (const p of withPanel) {
    const html = fs.readFileSync(p, "utf8");
    const town = (html.match(/class="town-far" data-town="([^"]+)"/) || [])[1];
    if (!town || !/, CO$/.test(town)) badTown.push(path.relative(ROOT, p));
    if (!/only=dining,gas/.test(html)) noOnly.push(path.relative(ROOT, p));
    // The whole point is that no mileage is written into the page. A literal
    // "N min drive" or "N mi" in the block's own markup would be a typed-in number.
    const block = (html.match(/How Far Is Everything[\s\S]*?<\/section>/) || [""])[0];
    if (/\d+\s*(?:min drive|mi\b)/.test(block)) hardcoded.push(path.relative(ROOT, p));
  }
  check("every panel names its town with a state", badTown.length === 0, badTown.slice(0, 3).join(", "));
  check("every panel limits itself to two categories", noOnly.length === 0, noOnly.slice(0, 3).join(", "));
  check("no distance or drive time is written into the page",
    hardcoded.length === 0, hardcoded.slice(0, 3).join(", "));

  // The panel leans on window.nearbyDistanceLabel, defined by the shared nearby
  // helpers. If a page ever carries the panel without them it silently falls back to
  // straight-line miles -- which is why the fallback exists, but both must be present.
  const missingHelper = withPanel.filter((p) =>
    !/nearbyDistanceLabel/.test(fs.readFileSync(p, "utf8")));
  check("every page with the panel also has the shared distance formatter",
    missingHelper.length === 0, missingHelper.slice(0, 3).join(", "));

  // Gas is a new tab on the listing panel; it must be wired at both ends or the
  // button returns "No nearby gas stations found" forever.
  const listingJs = fs.readFileSync(path.join(ROOT, "build", "build.py"), "utf8");
  check("the listing panel has a Gas tab", /data-cat="gas"/.test(listingJs));
  check("and a label for it", /gas: 'gas stations'/.test(listingJs));
  const fnSrc = fs.readFileSync(`${FN_DIR}/nearby-places.js`, "utf8");
  check("and the function knows the type", /gas: "gas_station"/.test(fnSrc));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
