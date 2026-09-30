// 2026-09-30: a listing Lofty reports as Christine's and Active must still be on
// the market per the MLS, or the site hides it.
//
// Why: Lofty's copy of the IRES feed carried IRE1043314 (212 N 54th, Greeley),
// expired November 2025, as Active and listed by her -- on this site, on her
// Lofty home search, and on every other Lofty-powered site. The sync now asks
// the MLS (the site's own MLS Grid copy first, then one MLS Grid request for a
// listing that copy does not have) and hides what the MLS says is off-market.
//
// Covers: lib/_lofty-listings.js runMineSync's confirmOnMarket hook, and
// sync-listings.js makeOnMarketConfirmer (copy hit, one-record lookup, 24-hour
// verdict cache, the new-listing grace, and every failure keeping the listing).
"use strict";
process.env.LISTINGS_SOURCE = "lofty";

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

function makeStore(initial) {
  const data = new Map(Object.entries(initial || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return {
    data,
    get: async (k) => (data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null),
    setJSON: async (k, v) => { data.set(k, JSON.parse(JSON.stringify(v))); },
    set: async (k, v) => { data.set(k, v); },
    delete: async (k) => { data.delete(k); },
    list: async (opts) => {
      const prefix = (opts && opts.prefix) || "";
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

const COVER = (id) => `https://img.chime.me/image/fs01/mls-listing/20260827/21/original_${id}-cover.jpeg`;
function rec(id, over) {
  return {
    mlsListingId: id, mlsOrgId: 1054, id: Number(String(id).replace(/\D/g, "")) || 1,
    listingStatus: "Active", price: 500000, bedrooms: 3, bathrooms: 2, sqft: 2000,
    streetAddress: `${id} Main St`, city: "Loveland", state: "CO", zipCode: "80537",
    propertyType: "Single Family Home", propertyTypeSecondary: "Single Family Residence",
    agentName: "Christine Gwinnup", previewPicture: COVER(id), latitude: "40.39", longitude: "-105.07",
    lastPrimaryChangeTime: "2026-09-28 10:00:00", mlsListDateLSort: 1787356800, builtYear: 2006,
    ...over,
  };
}
function reply(status, json) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json),
    json: async () => json, headers: { get: () => "application/json" } };
}

// Lofty answers "my" with world.mine; MLS Grid answers one-record lookups from world.grid.
function fakeFeeds(world) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(String(url));
    calls.push(`${(init && init.method) || "GET"} ${u.host}${u.pathname}${u.search}`);
    if (u.host === "img.chime.me") {
      return { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => new ArrayBuffer(30000) };
    }
    if (u.host.includes("mlsgrid")) {
      world.gridCalls = (world.gridCalls || 0) + 1;
      if (world.gridThrows) throw new Error("socket hang up");
      if (world.gridStatus) return reply(world.gridStatus, {});
      const m = /ListingId eq '([^']+)'/.exec(u.searchParams.get("$filter") || "");
      const id = m && m[1];
      const found = (world.grid || {})[id];
      return reply(200, { value: found ? [found] : [] });
    }
    if (u.pathname === "/v2.0/listings/search") {
      const body = JSON.parse(init.body);
      const pool = world.mine || [];
      const size = body.pageSize;
      const items = pool.slice((body.pageNum - 1) * size, body.pageNum * size);
      return reply(200, { listing: items, metadata: {
        totalCount: pool.length, totalPage: Math.ceil(pool.length / size), pageNum: body.pageNum, pageSize: size,
      } });
    }
    if (u.pathname === "/v1.0/listing") return reply(200, { listIng: [], soldListing: [] });
    return reply(404, {});
  };
  f.calls = calls;
  return f;
}

function freshModules(store, fetchImpl) {
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => store } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  global.fetch = fetchImpl;
}

const noSleep = async () => {};
const DAY = 24 * 3600e3;

(async () => {
  process.env.LOFTY_API_KEY = "test-key";
  process.env.MLSGRID_API_TOKEN = "grid-test-token";
  process.env.MLS_ORIGINATING_SYSTEM = "ires";
  delete process.env.MLSGRID_MARKET_DATA;

  // ---------------------------------------------------------------------------
  console.log("\n1. runMineSync hides what the MLS says is off the market, and nothing else");
  const world = {
    mine: [
      rec("IRE1000004"),
      rec("IRE1043314", { streetAddress: "212 N 54th", city: "Greeley", zipCode: "80634", price: 625000 }),
      rec("IRE1000009", { streetAddress: "9 New Ln" }),
    ],
  };
  const store = makeStore({ "lofty-listings.json": {}, "mine-listings.json": [] });
  const fetch1 = fakeFeeds(world);
  freshModules(store, fetch1);
  const L = require(`${FN_DIR}/lib/_lofty-listings.js`);
  const verdicts = {
    IRE1000004: true,
    IRE1043314: { onMarket: false, why: "the MLS has it as Expired" },
    IRE1000009: null,
  };
  const asked = [];
  const logs = [];
  const r1 = await L.runMineSync({
    store, apiKey: "test-key", fetchImpl: fetch1, sleepImpl: noSleep, log: (m) => logs.push(m),
    confirmOnMarket: async (l) => { asked.push(l.listingId); return verdicts[l.listingId]; },
  });
  const cat1 = store.data.get("lofty-listings.json");
  const mine1 = store.data.get("lofty-mine-listings.json");
  const st1 = store.data.get("lofty-sync-state.json");
  check("every listing Lofty returned was checked", asked.sort().join(",") === "IRE1000004,IRE1000009,IRE1043314", asked.join(","));
  check("the answer is still accepted", r1.answer === "ok" && r1.accepted === true, JSON.stringify(r1));
  check("the expired listing is not stored", !cat1.IRE1043314, Object.keys(cat1).join(","));
  check("...and not in the small copy the pages read", !mine1.some((l) => l.listingId === "IRE1043314"));
  check("the confirmed listing is kept", !!cat1.IRE1000004);
  check("an unknown verdict keeps the listing", !!cat1.IRE1000009);
  check("the state names what was hidden and why",
    st1.hiddenOffMarket.length === 1 && st1.hiddenOffMarket[0].listingId === "IRE1043314" &&
    st1.hiddenOffMarket[0].address === "212 N 54th" && /Expired/.test(st1.hiddenOffMarket[0].why),
    JSON.stringify(st1.hiddenOffMarket));
  check("the state counts the unconfirmed one", st1.mlsCheck === "checked" && st1.mlsUnconfirmed === 1, `${st1.mlsCheck} / ${st1.mlsUnconfirmed}`);
  check("the hidden listing is not an error (the last-good-set rule must not fire)", !st1.lastRunError, st1.lastRunError);
  check("the log says so in plain words", logs.some((m) => /HIDDEN IRE1043314 \(212 N 54th, Greeley\)/.test(m)), logs.join("\n"));
  check("the result reports it too", r1.hiddenOffMarket.length === 1 && r1.hers === 2, JSON.stringify(r1));

  // ---------------------------------------------------------------------------
  console.log("\n2. Hiding every listing is still a complete answer, not an 'empty' one to hold back");
  const world2 = { mine: [rec("IRE1043314", { streetAddress: "212 N 54th", city: "Greeley" })] };
  const store2 = makeStore({ "lofty-listings.json": { IRE1043314: { listingId: "IRE1043314", agentName: "Christine Gwinnup", status: "Active" } } });
  const fetch2 = fakeFeeds(world2);
  freshModules(store2, fetch2);
  const L2 = require(`${FN_DIR}/lib/_lofty-listings.js`);
  const r2 = await L2.runMineSync({ store: store2, apiKey: "test-key", fetchImpl: fetch2, sleepImpl: noSleep, log: () => {},
    confirmOnMarket: async () => ({ onMarket: false, why: "the MLS has it as Expired" }) });
  check("accepted with zero listings", r2.answer === "ok" && r2.accepted === true && r2.hers === 0, JSON.stringify(r2));
  check("the stale record is gone from the store", Object.keys(store2.data.get("lofty-listings.json")).length === 0);

  // ---------------------------------------------------------------------------
  console.log("\n3. Without the hook (or with a broken one) nothing changes");
  const world3 = { mine: [rec("IRE1000004")] };
  const store3 = makeStore({ "lofty-listings.json": {} });
  const fetch3 = fakeFeeds(world3);
  freshModules(store3, fetch3);
  const L3 = require(`${FN_DIR}/lib/_lofty-listings.js`);
  const r3 = await L3.runMineSync({ store: store3, apiKey: "test-key", fetchImpl: fetch3, sleepImpl: noSleep, log: () => {} });
  const st3 = store3.data.get("lofty-sync-state.json");
  check("no hook: listing stored, state says the check was not available", r3.hers === 1 && st3.mlsCheck === "not available" && st3.hiddenOffMarket.length === 0, JSON.stringify(st3));
  const r3b = await L3.runMineSync({ store: store3, apiKey: "test-key", fetchImpl: fetch3, sleepImpl: noSleep, log: () => {},
    now: () => Date.now() + 120e3, confirmOnMarket: async () => { throw new Error("blob store down"); } });
  check("a hook that throws keeps the listing", r3b.hers === 1 && r3b.hiddenOffMarket.length === 0, JSON.stringify(r3b));
  check("...without becoming a Lofty error", !store3.data.get("lofty-sync-state.json").lastRunError);
  const r3c = await L3.runMineSync({ store: store3, apiKey: "test-key", fetchImpl: fetch3, sleepImpl: noSleep, log: () => {},
    now: () => Date.now() + 240e3, confirmOnMarket: async () => "yes, probably" });
  check("a nonsense verdict counts as unknown", r3c.hers === 1 && store3.data.get("lofty-sync-state.json").mlsUnconfirmed === 1);

  // ---------------------------------------------------------------------------
  console.log("\n4. makeOnMarketConfirmer: the MLS Grid copy first, then one request, then the cache");
  const world4 = {
    grid: {
      IRE1043314: { ListingId: "IRE1043314", StandardStatus: "Expired", MlgCanView: false },
      IRE1000010: { ListingId: "IRE1000010", StandardStatus: "Active", MlgCanView: true },
      IRE1000011: { ListingId: "IRE1000011", StandardStatus: "Closed", MlgCanView: true },
    },
  };
  const store4 = makeStore({ "mine-listings.json": [{ listingId: "IRE1000004", status: "Active" }] });
  const fetch4 = fakeFeeds(world4);
  freshModules(store4, fetch4);
  const Sync = require(`${FN_DIR}/sync-listings.js`);
  let t = Date.parse("2026-09-30T14:00:00Z");
  const now = () => t;
  const logs4 = [];
  const paused = [];
  const confirm = Sync.makeOnMarketConfirmer({ store: store4, token: "grid-test-token", now, log: (m) => logs4.push(m), sleepImpl: async (ms) => { paused.push(ms); } });
  const v1 = await confirm({ listingId: "IRE1000004", listDate: "2026-08-01" });
  check("in the MLS Grid copy: on the market, no request", v1.onMarket === true && (world4.gridCalls || 0) === 0, JSON.stringify(v1));
  const v2 = await confirm({ listingId: "IRE1043314", listDate: "2025-09-10" });
  check("not in the copy: one MLS Grid request", world4.gridCalls === 1);
  const gridCall = new URL("https://" + fetch4.calls.find((c) => c.includes("mlsgrid")).replace(/^GET /, ""));
  const filter = gridCall.searchParams.get("$filter") || "";
  check("...for that one listing, without the MlgCanView filter", /ListingId eq 'IRE1043314'/.test(filter) && /OriginatingSystemName eq 'ires'/.test(filter) && !/MlgCanView/.test(filter), filter);
  check("...asking only for id, status and viewability", gridCall.searchParams.get("$select") === "ListingId,StandardStatus,MlgCanView" && !gridCall.searchParams.get("$expand"), gridCall.search);
  check("Expired = off the market, with the status in the reason", v2.onMarket === false && /Expired/.test(v2.why), JSON.stringify(v2));
  const saved = store4.data.get(Sync.VERDICT_KEY);
  check("the verdict is saved", saved && saved.IRE1043314 && saved.IRE1043314.onMarket === false && saved.IRE1043314.checkedAt, JSON.stringify(saved));
  t += 6 * 3600e3;
  const v2b = await confirm({ listingId: "IRE1043314", listDate: "2025-09-10" });
  check("six hours later the saved verdict is used, no second request", v2b.onMarket === false && world4.gridCalls === 1);
  t += 20 * 3600e3;
  const v2c = await confirm({ listingId: "IRE1043314", listDate: "2025-09-10" });
  check("after a day it is asked again", v2c.onMarket === false && world4.gridCalls === 2);
  check("the second lookup of that run waited REQUEST_DELAY_MS first", paused.length === 1 && paused[0] === 1500, JSON.stringify(paused));
  const v3x = await confirm({ listingId: "IRE1000010", listDate: "2026-09-01" });
  check("a third lookup in one run is refused: unknown, kept, no request", v3x.onMarket === null && /spent/.test(v3x.why) && world4.gridCalls === 2, JSON.stringify(v3x));
  // Each run builds its own confirmer, so each run gets its own two lookups.
  const confirmB = Sync.makeOnMarketConfirmer({ store: store4, token: "grid-test-token", now, log: (m) => logs4.push(m), sleepImpl: async () => {} });
  const v3 = await confirmB({ listingId: "IRE1000010", listDate: "2026-09-01" });
  check("Active in MLS Grid (not yet in the copy): on the market", v3.onMarket === true, JSON.stringify(v3));
  const v4 = await confirmB({ listingId: "IRE1000011", listDate: "2026-06-01" });
  check("Closed = off the market", v4.onMarket === false && /Closed/.test(v4.why), JSON.stringify(v4));
  const confirmC = Sync.makeOnMarketConfirmer({ store: store4, token: "grid-test-token", now, log: (m) => logs4.push(m), sleepImpl: async () => {} });
  const v5 = await confirmC({ listingId: "IRE1000012", listDate: "2025-01-15" });
  check("unknown to MLS Grid and listed long ago: off the market", v5.onMarket === false && /no record/.test(v5.why), JSON.stringify(v5));
  const fresh = new Date(t - 2 * DAY).toISOString().slice(0, 10);
  const v6 = await confirmC({ listingId: "IRE1000013", listDate: fresh });
  check("unknown to MLS Grid but listed two days ago: unknown, kept", v6.onMarket === null && /new/.test(v6.why), JSON.stringify(v6));
  check("...and that is not saved as a verdict", !store4.data.get(Sync.VERDICT_KEY).IRE1000013);
  check("...but is logged", logs4.some((m) => /could not confirm IRE1000013/.test(m)), logs4.join("\n"));

  // ---------------------------------------------------------------------------
  console.log("\n5. Every MLS Grid failure is 'unknown', never 'off the market'");
  const world5 = { gridStatus: 429 };
  const store5 = makeStore({});
  const fetch5 = fakeFeeds(world5);
  freshModules(store5, fetch5);
  const Sync5 = require(`${FN_DIR}/sync-listings.js`);
  const c5 = Sync5.makeOnMarketConfirmer({ store: store5, token: "grid-test-token", now, log: () => {}, sleepImpl: async () => {} });
  const v7 = await c5({ listingId: "IRE1043314", listDate: "2025-09-10" });
  check("a 429 keeps the listing", v7.onMarket === null && /429/.test(v7.why), JSON.stringify(v7));
  check("...and records the suspension for the market-data run", !!store5.data.get("mlsgrid-suspension.json"));
  world5.gridStatus = 500;
  const v8 = await c5({ listingId: "IRE1043314", listDate: "2025-09-10" });
  check("a 500 keeps the listing", v8.onMarket === null && /500/.test(v8.why), JSON.stringify(v8));
  delete world5.gridStatus;
  world5.gridThrows = true;
  const c5b = Sync5.makeOnMarketConfirmer({ store: store5, token: "grid-test-token", now, log: () => {}, sleepImpl: async () => {} });
  const v9 = await c5b({ listingId: "IRE1043314", listDate: "2025-09-10" });
  check("a network error keeps the listing", v9.onMarket === null && /hang up/.test(v9.why), JSON.stringify(v9));
  check("nothing was saved as a verdict", !store5.data.get(Sync5.VERDICT_KEY));

  // ---------------------------------------------------------------------------
  console.log("\n6. The wiring: both refresh paths pass the check, health names hidden listings");
  const sync = fs.readFileSync(`${FN_DIR}/sync-listings.js`, "utf8");
  const manual = fs.readFileSync(`${FN_DIR}/refresh-my-listings.js`, "utf8");
  const health = fs.readFileSync(`${FN_DIR}/site-health.js`, "utf8");
  check("the scheduled run passes confirmOnMarket", /runMineSync\(\{ store, apiKey, confirmOnMarket \}\)/.test(sync));
  check("the manual refresh passes it too", /makeOnMarketConfirmer/.test(manual) && /manual: true, confirmOnMarket/.test(manual));
  check("neither runs the check without an MLS Grid token", /mlsGridMarketDataOn\(\)\s*\?\s*makeOnMarketConfirmer/.test(sync) && /mlsGridMarketDataOn\(\)\s*\?\s*makeOnMarketConfirmer/.test(manual));
  check("site-health has a row for hidden listings", /hiddenOffMarket/.test(health) && /Ask Lofty support/.test(health));
  delete process.env.MLSGRID_API_TOKEN;
  freshModules(makeStore({}), fakeFeeds({}));
  const SyncOff = require(`${FN_DIR}/sync-listings.js`);
  check("with no MLS Grid token the market-data run (and so the check) is off", SyncOff.mlsGridMarketDataOn() === false);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
