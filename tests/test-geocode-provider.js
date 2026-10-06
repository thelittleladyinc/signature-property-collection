// Every geocoded pin records which service placed it.
//
// 2026-10-06 (triage item 9). lib/_geocode.js tries Mapbox and, on ANY failure,
// falls through to Google with only a console.warn -- and the result it returned
// ({lat, lng, formatted}) said nothing about which one answered. The three callers
// store that result in their caches, so once a pin was cached nobody could tell
// whether it was Mapbox's (storable indefinitely) or Google's (30-day limit). The
// result now carries provider: "mapbox" | "google", the callers' existing
// `{ ...geo, cachedAt }` writes persist it with no change of their own, and a
// per-process count of Google fallbacks is logged each time it changes.
//
// What this pins, besides the field itself:
//   - no geocoding call was added or removed, and the Mapbox -> Google fallback
//     still happens on every kind of Mapbox failure;
//   - both services failing still throws, exactly as before;
//   - the field never reaches a visitor (public pins are built field by field);
//   - cache entries written BEFORE this change (no provider) are still served.
// No live call is made: fetch is stubbed before anything is loaded, and the keys
// used here are made-up strings.
"use strict";
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// ---- stubbed network --------------------------------------------------------
// mapboxMode / googleMode choose what each service says. Any other host throws,
// which would show up as a failed check rather than a real request.
let mapboxMode = "ok";
let googleMode = "ok";
let calls = [];
const MB_COORDS = { lat: 40.5853, lng: -105.0844 }; // distinct from Google's so a mix-up shows
const G_COORDS = { lat: 40.4, lng: -105.1 };
global.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.startsWith("https://api.mapbox.com/")) {
    if (mapboxMode === "401") return { ok: false, status: 401, json: async () => ({}) };
    if (mapboxMode === "throw") throw new Error("network down");
    if (mapboxMode === "empty") return { ok: true, status: 200, json: async () => ({ features: [] }) };
    return { ok: true, status: 200, json: async () => ({ features: [{
      geometry: { coordinates: [MB_COORDS.lng, MB_COORDS.lat] },
      properties: { full_address: "Mapbox Formatted, CO" },
    }] }) };
  }
  if (u.startsWith("https://maps.googleapis.com/")) {
    if (googleMode === "500") return { ok: false, status: 500, json: async () => ({}) };
    if (googleMode === "denied") {
      return { ok: true, status: 200, json: async () => ({ status: "REQUEST_DENIED", error_message: "no" }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: "OK", results: [{
      geometry: { location: G_COORDS }, formatted_address: "Google Formatted, CO",
    }] }) };
  }
  throw new Error(`unexpected outbound call in test: ${u.split("?")[0]}`);
};
const mapboxCalls = () => calls.filter((c) => c.startsWith("https://api.mapbox.com/")).length;
const googleCalls = () => calls.filter((c) => c.startsWith("https://maps.googleapis.com/")).length;

// Made-up credentials. The checks below prove they never reach a log line.
const FAKE_MAPBOX = "pk.test-mapbox-token-0000";
const FAKE_GOOGLE = "test-google-key-0000";
process.env.GOOGLE_MAPS_API_KEY = FAKE_GOOGLE;
process.env.MAPBOX_PUBLIC_TOKEN = FAKE_MAPBOX;
process.env.IDX_DISPLAY = "on";

// ---- capture console.warn so the logging can be inspected --------------------
let warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(" ")); };
const restoreWarn = () => { console.warn = realWarn; };

function freshGeocode() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && !k.endsWith(".json")) delete require.cache[k];
  }
  return require(`${FN_DIR}/lib/_geocode.js`);
}

// Blob stores that remember what was written, one per store name, so a test can
// read the cache back exactly as the next request would. `seed` pre-fills a named
// store; `listingsGet` answers the listings store (sync state, her listings) the way
// test-mylistings-coords.js does -- by key shape.
function blobsWorld({ seed, listingsGet } = {}) {
  const stores = {};
  const mk = (name) => {
    if (stores[name]) return stores[name];
    const s = { _m: {} };
    s.get = async (k) => {
      if (seed && seed[name] && k in seed[name]) return seed[name][k];
      if (k in s._m) return s._m[k];
      if (listingsGet && !/geocode-cache$/.test(String(name))) {
        const v = listingsGet(k);
        if (v !== undefined) return v;
      }
      return null;
    };
    s.setJSON = async (k, v) => { s._m[k] = JSON.parse(JSON.stringify(v)); };
    return (stores[name] = s);
  };
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true,
    exports: { getStore: (name) => mk(name) } };
  return stores;
}
function loadFn(name) {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  return require(`${FN_DIR}/${name}`).handler;
}

(async () => {
  // =====================================================================
  console.log("\n1. Mapbox answers");
  mapboxMode = "ok"; googleMode = "ok"; calls = []; warns = [];
  let g = freshGeocode();
  let r = await g.geocodeAddress("1 Test St, Loveland, CO", FAKE_GOOGLE);
  check("provider is 'mapbox'", r.provider === "mapbox", JSON.stringify(r));
  check("lat/lng/formatted are Mapbox's, unchanged in shape",
    r.lat === MB_COORDS.lat && r.lng === MB_COORDS.lng && r.formatted === "Mapbox Formatted, CO");
  check("one Mapbox call, no Google call", mapboxCalls() === 1 && googleCalls() === 0, `${mapboxCalls()}/${googleCalls()}`);
  check("fallback counter still 0", g._internals.googleFallbackCount() === 0);
  check("nothing logged", warns.length === 0, warns.join(" | "));

  // =====================================================================
  console.log("\n2. Mapbox refuses (401: billing not enabled), Google answers");
  mapboxMode = "401"; googleMode = "ok"; calls = []; warns = [];
  g = freshGeocode();
  r = await g.geocodeAddress("2 Test St, Loveland, CO", FAKE_GOOGLE);
  check("provider is 'google'", r.provider === "google", JSON.stringify(r));
  check("coordinates are Google's", r.lat === G_COORDS.lat && r.lng === G_COORDS.lng && r.formatted === "Google Formatted, CO");
  check("exactly one call to each service (no call added or removed)",
    mapboxCalls() === 1 && googleCalls() === 1, `${mapboxCalls()}/${googleCalls()}`);
  check("fallback counter went 0 -> 1", g._internals.googleFallbackCount() === 1);
  check("the existing 'Mapbox permanent path failed' warning is still logged",
    warns.some((w) => /Mapbox permanent path failed \(Mapbox geocode HTTP 401\)/.test(w)), warns.join(" | "));
  check("and the count is logged when it changes", warns.some((w) => /1 so far in this process/.test(w)), warns.join(" | "));
  const logged = warns.join("\n");
  check("no key, token or address in any log line",
    !logged.includes(FAKE_MAPBOX) && !logged.includes(FAKE_GOOGLE) && !/Test St/.test(logged), logged);

  r = await g.geocodeAddress("3 Test St, Loveland, CO", FAKE_GOOGLE);
  check("a second fallback makes it 2 and logs again",
    g._internals.googleFallbackCount() === 2 && warns.some((w) => /2 so far in this process/.test(w)));
  g._internals.resetGoogleFallbackCount();
  check("the counter can be reset (tests only)", g._internals.googleFallbackCount() === 0);

  // =====================================================================
  console.log("\n3. Every kind of Mapbox failure still falls back to Google");
  for (const mode of ["empty", "throw"]) {
    mapboxMode = mode; googleMode = "ok"; calls = []; warns = [];
    g = freshGeocode();
    r = await g.geocodeAddress("4 Test St, Loveland, CO", FAKE_GOOGLE);
    check(`Mapbox "${mode}" -> provider 'google', counter 1`,
      r.provider === "google" && g._internals.googleFallbackCount() === 1, JSON.stringify(r));
  }

  // =====================================================================
  console.log("\n4. No Mapbox token configured: Google serves it, and that is not a fallback");
  delete process.env.MAPBOX_PUBLIC_TOKEN;
  mapboxMode = "ok"; googleMode = "ok"; calls = []; warns = [];
  g = freshGeocode();
  r = await g.geocodeAddress("5 Test St, Loveland, CO", FAKE_GOOGLE);
  check("provider is 'google'", r.provider === "google");
  check("Mapbox was never called", mapboxCalls() === 0 && googleCalls() === 1);
  check("fallback counter stays 0, nothing logged", g._internals.googleFallbackCount() === 0 && warns.length === 0);
  process.env.MAPBOX_PUBLIC_TOKEN = FAKE_MAPBOX;

  // =====================================================================
  console.log("\n5. Both services failing still throws, as before");
  mapboxMode = "401"; googleMode = "500"; calls = []; warns = [];
  g = freshGeocode();
  let threw = null;
  try { await g.geocodeAddress("6 Test St, Loveland, CO", FAKE_GOOGLE); } catch (e) { threw = e; }
  check("throws Google's own error", threw && /Geocoding API HTTP 500/.test(threw.message), threw && threw.message);
  check("a lookup nobody served is not counted as a Google fallback", g._internals.googleFallbackCount() === 0);

  googleMode = "denied";
  g = freshGeocode();
  threw = null;
  try { await g.geocodeAddress("6 Test St, Loveland, CO", FAKE_GOOGLE); } catch (e) { threw = e; }
  check("a Google REQUEST_DENIED still throws", threw && /REQUEST_DENIED/.test(threw.message), threw && threw.message);

  delete process.env.GOOGLE_MAPS_API_KEY;
  mapboxMode = "401"; googleMode = "ok"; calls = [];
  g = freshGeocode();
  threw = null;
  try { await g.geocodeAddress("6 Test St, Loveland, CO", undefined); } catch (e) { threw = e; }
  check("Mapbox failing with no Google key still throws 'no geocoder available'",
    threw && /no geocoder available/.test(threw.message), threw && threw.message);
  check("and no Google call was made", googleCalls() === 0);
  process.env.GOOGLE_MAPS_API_KEY = FAKE_GOOGLE;

  // =====================================================================
  // The three callers. Same stubs; the question is what lands in each cache and
  // what a visitor's browser receives.
  const fresh = { lastRunAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString() };
  const LISTING = { listingId: "IRE9", address: "9 Plain St", city: "Loveland", state: "CO", zip: "80537",
    status: "Active", price: 500000, latitude: null, longitude: null };
  const listingsGet = (k) => (/sync-state/.test(k) ? fresh : /mine-listings/.test(k) ? [LISTING] : undefined);

  const callers = [
    { name: "my-listings-geo.js", store: "my-listings-geocode-cache", listingsGet,
      run: () => loadFn("my-listings-geo.js")({}), pins: (b) => b.pins },
    { name: "sold-homes-geocode.js", store: "sold-homes-geocode-cache",
      run: () => loadFn("sold-homes-geocode.js")({}), pins: (b) => b.pins },
    { name: "local-spots.js", store: "local-spots-geocode-cache",
      run: () => loadFn("local-spots.js")({}), pins: (b) => b.spots },
  ];

  for (const [label, mb, g2, expected] of [
    ["Mapbox answers", "ok", "ok", "mapbox"],
    ["Mapbox refuses, Google answers", "401", "ok", "google"],
  ]) {
    for (const c of callers) {
      console.log(`\n6. ${c.name}: ${label}`);
      mapboxMode = mb; googleMode = g2; calls = []; warns = [];
      const stores = blobsWorld({ listingsGet: c.listingsGet });
      const res = await c.run();
      const body = JSON.parse(res.body);
      const pins = c.pins(body) || [];
      const cache = (stores[c.store] && stores[c.store]._m) || {};
      const entries = Object.values(cache);
      check("pins were produced", pins.length > 0, res.body.slice(0, 160));
      check("something was cached", entries.length > 0);
      check(`every cached entry carries provider '${expected}'`,
        entries.length > 0 && entries.every((e) => e.provider === expected), JSON.stringify(entries[0]));
      check("cached entries keep lat, lng, formatted and cachedAt",
        entries.every((e) => typeof e.lat === "number" && typeof e.lng === "number" && e.formatted && e.cachedAt));
      check("the response a visitor receives never mentions provider", !/provider/i.test(res.body));
      check("no pin carries provider or formatted",
        pins.every((p) => !("provider" in p) && !("formatted" in p)));
      check("no key or token in the response", !res.body.includes(FAKE_MAPBOX) && !res.body.includes(FAKE_GOOGLE));
    }
  }

  // =====================================================================
  // Rollback: a cache full of entries written before this change must behave
  // exactly as it did. No provider, no call to any geocoder, same pins.
  for (const c of callers) {
    console.log(`\n7. ${c.name}: cache written BEFORE this change (no provider field)`);
    // First learn which keys the caller uses, from a throwaway warm-up run.
    mapboxMode = "ok"; googleMode = "ok"; calls = [];
    const warm = blobsWorld({ listingsGet: c.listingsGet });
    const warmBody = JSON.parse((await c.run()).body);
    const keys = Object.keys(warm[c.store]._m);
    const legacy = {};
    for (const k of keys) {
      const { provider, ...old } = warm[c.store]._m[k];   // exactly what the old code stored
      legacy[k] = { ...old, cachedAt: Date.now() - 60 * 1000 };
    }
    check("legacy entries really have no provider", keys.length > 0 && Object.values(legacy).every((e) => !("provider" in e)));

    calls = [];
    blobsWorld({ listingsGet: c.listingsGet, seed: { [c.store]: legacy } });
    const res = await c.run();
    const body = JSON.parse(res.body);
    check("served entirely from the old cache: no geocoder was called", calls.length === 0, `${calls.length} call(s)`);
    check("same number of pins as the fresh run", c.pins(body).length === c.pins(warmBody).length,
      `${c.pins(body).length} vs ${c.pins(warmBody).length}`);
    check("pin coordinates come from the old entries",
      c.pins(body).every((p) => typeof p.lat === "number" && typeof p.lng === "number"));
  }

  restoreWarn();
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { restoreWarn(); console.error(e); process.exit(1); });
