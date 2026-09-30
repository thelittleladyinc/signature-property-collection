// Her map pins come from the coordinates Lofty already sends, not a second lookup.
//
// 2026-09-30 (API audit). my-listings-geo geocoded every one of her listings
// (a paid Google call per address, every 30 days) although the Lofty refresh
// stores each listing's latitude and longitude -- and with no GOOGLE_MAPS_API_KEY
// it returned no pins at all. A listing with coordinates is now pinned from them;
// one without is geocoded exactly as before.
"use strict";
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const fresh = { lastRunAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString() };
const WITH = { listingId: "IRE1", address: "1 Lofty Ln", city: "Loveland", state: "CO", status: "Active",
  price: 900000, latitude: 40.39, longitude: -105.07, agentName: "Christine Gwinnup" };
const WITHOUT = { ...WITH, listingId: "IRE2", address: "2 Plain St", latitude: null, longitude: null };

function load(mine) {
  const store = {
    get: async (k) => (/sync-state/.test(k) ? fresh : /mine-listings/.test(k) ? mine : null),
    setJSON: async () => {},
  };
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => store } };
  for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  return require(`${FN_DIR}/my-listings-geo.js`).handler;
}

(async () => {
  process.env.IDX_DISPLAY = "on";
  delete process.env.MAPBOX_PUBLIC_TOKEN;
  let geocodes = 0;
  global.fetch = async (url) => {
    if (/geocode/.test(String(url))) geocodes += 1;
    return { ok: true, status: 200, json: async () => ({ status: "OK", results: [{ geometry: { location: { lat: 40.5, lng: -105 } }, formatted_address: "x" }] }) };
  };

  console.log("\n1. No Google key, listings that carry coordinates");
  delete process.env.GOOGLE_MAPS_API_KEY;
  let body = JSON.parse((await load([WITH])()).body);
  check("her pin is shown from Lofty's coordinates", body.pins && body.pins.length === 1 &&
    body.pins[0].lat === 40.39 && body.pins[0].lng === -105.07, JSON.stringify(body));
  check("and nothing was geocoded", geocodes === 0);

  console.log("\n2. With a key, a mix");
  process.env.GOOGLE_MAPS_API_KEY = "g";
  geocodes = 0;
  body = JSON.parse((await load([WITH, WITHOUT])()).body);
  check("only the listing without coordinates is geocoded", geocodes === 1 && body.pins.length === 2, `${geocodes} geocode(s)`);

  console.log("\n3. No key and no coordinates still says so");
  delete process.env.GOOGLE_MAPS_API_KEY;
  body = JSON.parse((await load([WITHOUT])()).body);
  check("not_configured, as before", body.error === "not_configured" && body.pins.length === 0, JSON.stringify(body));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
