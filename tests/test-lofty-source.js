// Lofty as the listing source (2026-09-28) -- the whole path, against a fake Lofty.
//
// Christine asked for the site's listings and searches to come from Lofty instead
// of MLS Grid. The facts the code is built on were measured live through her own
// key (see lib/_lofty-listings.js's header); this suite pins the BEHAVIOUR built on
// them, with no network:
//
//   - the refresh writes ONLY the Lofty keys, so the MLS Grid copy (and a switch
//     back) is untouched;
//   - a complete refresh replaces the catalogue (sold/withdrawn listings leave);
//     a partial one only adds and updates, never removes on partial evidence --
//     except her own listings, which are known exactly and leave at once;
//   - only IRES records are published (her manual Lofty listing is reported, not
//     shown); statuses outside the replicated set are refused;
//   - other brokers' listings are slimmed to the fields the site uses, with the
//     riverfront / horse-property flags read from the description first;
//   - details are fetched once per version of a listing, not every refresh;
//   - nothing on the Lofty path -- refresh, schedule, search, listing page, photo
//     link, status page -- makes a single request to MLS Grid.
"use strict";
process.env.LISTINGS_SOURCE = "lofty";

const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// ---- fakes ---------------------------------------------------------------------
function makeStore(initial) {
  const data = new Map(Object.entries(initial || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return {
    data,
    get: async (k) => (data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null),
    setJSON: async (k, v) => { data.set(k, JSON.parse(JSON.stringify(v))); },
    set: async (k, v) => { data.set(k, v); },
    delete: async (k) => { data.delete(k); },
    list: async () => ({ blobs: [...data.keys()].map((key) => ({ key })) }),
  };
}

const PIC = (id, n) => `https://img.chime.me/image/fs01/mls-listing/20260828/6/w600_original_${id}-${n}.jpeg`;
const COVER = (id) => `https://img.chime.me/image/fs01/mls-listing/20260827/21/original_${id}-cover.jpeg`;

function rec(id, over) {
  return {
    mlsListingId: id, mlsOrgId: 1054, id: Number(String(id).replace(/\D/g, "")) || 1,
    listingStatus: "Active", price: 500000, bedrooms: 3, bathrooms: 2, sqft: 2000,
    streetAddress: `${id} Main St`, city: "Loveland", state: "CO", zipCode: "80537",
    propertyType: "Single Family Home", propertyTypeSecondary: "Single Family Residence",
    agentName: "Someone Else", previewPicture: COVER(id), latitude: "40.39", longitude: "-105.07",
    lastPrimaryChangeTime: "2026-09-28 10:00:00", mlsListDateLSort: 1787356800, builtYear: 2006,
    ...over,
  };
}

function reply(status, json) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json),
    json: async () => json, headers: { get: () => "application/json" } };
}

// A fake Lofty: counties -> records, "my" -> records, details by MLS id.
function fakeLofty(world) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(String(url));
    calls.push(`${(init && init.method) || "GET"} ${u.host}${u.pathname}`);
    if (u.host.includes("mlsgrid")) return reply(500, { error: "MLS Grid must not be called" });
    if (u.host === "img.chime.me") {
      return { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => new ArrayBuffer(30000) };
    }
    if (u.pathname.endsWith("/lofty-sync-background")) return { status: 202 };
    if (u.pathname === "/v2.0/listings/search") {
      const body = JSON.parse(init.body);
      let pool;
      if (body.searchScope === "my") {
        pool = world.mine || [];
      } else {
        const county = body.filterConditions.location.county[0].split(",")[0];
        if ((world.failing || []).includes(county)) return reply(500, { code: 1, message: "Lofty is down for this one" });
        pool = (world.counties || {})[county] || [];
        if (body.filterConditions.daysOnSite) pool = pool.filter((x) => x.__newToday);
      }
      const size = body.pageSize;
      const items = pool.slice((body.pageNum - 1) * size, body.pageNum * size);
      return reply(200, { listing: items, metadata: {
        totalCount: pool.length, totalPage: Math.ceil(pool.length / size), pageNum: body.pageNum, pageSize: size,
      } });
    }
    if (u.pathname === "/v1.0/listing") {
      const ids = String(u.searchParams.get("mlsListingIds") || "").split(",");
      world.detailCalls = (world.detailCalls || 0) + 1;
      world.detailIds = (world.detailIds || []).concat(ids);
      return reply(200, { listIng: ids.map((id) => (world.details || {})[id]).filter(Boolean), soldListing: [] });
    }
    return reply(404, {});
  };
  f.calls = calls;
  return f;
}

function freshModules(store, fetchImpl) {
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true,
    exports: { getStore: () => store } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  global.fetch = fetchImpl;
}

const noSleep = async () => {};

(async () => {
  process.env.LOFTY_API_KEY = "test-key";
  delete process.env.MLSGRID_API_TOKEN;

  // ---------------------------------------------------------------------------
  console.log("\n1. A complete refresh builds the Lofty catalogue and nothing else");
  const world = {
    counties: {
      Larimer: [
        rec("IRE1000001", { propertyTypeSecondary: "Farm/Ranch" }),
        rec("IRE1000002", { listingStatus: "Pending", city: "Fort Collins" }),
        rec("IRE1000003", { listingStatus: "Sold" }),
        rec("MANL999", { mlsOrgId: 0 }),
      ],
      Weld: [rec("IRE1000004", { city: "Greeley", agentName: "Kendra Bajcar", coAgentName: "Christine Gwinnup" })],
    },
    mine: [
      rec("IRE1000004", { city: "Greeley", agentName: "Kendra Bajcar", coAgentName: "Christine Gwinnup" }),
      rec("MANL1774145080001", { mlsOrgId: 0, agentName: "Christine Gwinnup", streetAddress: "1 Pocket Ln" }),
    ],
    details: {
      IRE1000001: { mlsListingId: "IRE1000001", pictureList: [PIC("IRE1000001", 1), PIC("IRE1000001", 2), PIC("IRE1000001", 3)],
        detailsDescribe: "Riverfront acreage, horse property with a loafing shed.", subDivisionName: "Airpark", county: "Larimer", agentOrgId: "IRE0FCOM" },
      IRE1000004: { mlsListingId: "IRE1000004", pictureList: [1, 2, 3, 4, 5].map((n) => PIC("IRE1000004", n)),
        detailsDescribe: "Christine's own listing, described in full.", subDivisionName: "Greeley Rural", county: "Weld", agentOrgId: "IRE07444" },
    },
  };
  const sentinel = { IRE1: { listingId: "IRE1", source: "mlsgrid" } };
  const store = makeStore({ "listings.json": sentinel, "sync-state.json": { lastRunAt: "x" }, "mine-listings.json": [] });
  const fetch1 = fakeLofty(world);
  freshModules(store, fetch1);
  const L = require(`${FN_DIR}/lib/_lofty-listings.js`);
  const S = require(`${FN_DIR}/lib/_mls-shared.js`);
  check("the default source is Lofty", S.LISTINGS_SOURCE === "lofty");
  check("the site reads the Lofty keys", S.LISTINGS_KEY === "lofty-listings.json" && S.MINE_LISTINGS_KEY === "lofty-mine-listings.json");

  // Only operating counties are queried; this world has two with listings.
  const r1 = await L.runFullCrawl({ store, apiKey: "test-key", fetchImpl: fetch1, sleepImpl: noSleep, log: () => {} });
  const cat = store.data.get("lofty-listings.json") || {};
  const mine = store.data.get("lofty-mine-listings.json") || [];
  const state = store.data.get("lofty-sync-state.json") || {};
  check("the refresh reports complete", r1.complete === true, JSON.stringify(r1.incomplete));
  check("Active and Pending IRES listings are stored", !!cat.IRE1000001 && !!cat.IRE1000002 && !!cat.IRE1000004);
  check("a Sold listing is refused", !cat.IRE1000003);
  check("a non-MLS (manual) record is never published", !cat.MANL999 && !cat.MANL1774145080001);
  check("her manual Lofty listing is reported in state instead",
    (state.herNonMlsListings || []).some((x) => x.includes("MANL1774145080001")), JSON.stringify(state.herNonMlsListings));
  check("the MLS Grid catalogue is untouched", JSON.stringify(store.data.get("listings.json")) === JSON.stringify(sentinel));
  check("the MLS Grid state is untouched", store.data.get("sync-state.json").lastRunAt === "x");
  const a = cat.IRE1000001 || {};
  check("listing ids keep MLS Grid's IRE form", a.listingId === "IRE1000001");
  check("mapped fields: price, beds, baths, sqft, address, status",
    a.price === 500000 && a.beds === 3 && a.baths === 2 && a.sqft === 2000 && a.address === "IRE1000001 Main St" && a.status === "Active");
  check("coordinates arrive as numbers (MLS Grid never had them)", a.latitude === 40.39 && a.longitude === -105.07);
  check("county comes from the county queried", a.county === "larimer" && (cat.IRE1000004 || {}).county === "weld");
  check("subdivision from details", a.subdivision === "Airpark");
  check("riverfront and horse-property flags read from the description", a.waterfront === true && a.equestrian === true);
  check("another brokerage's description and gallery are not stored (slimmed)", a.remarks === undefined && a.photos === undefined);
  check("...but its photo count is", a.photoCount === 3);
  check("its cover is the stable Lofty URL", L.isLoftyPhoto(a.photo));
  check("empty fields are not stored", !Object.values(a).some((v) => v === null));
  const d = cat.IRE1000004 || {};
  check("her co-listed listing is hers", L.isHers(d));
  check("hers keeps its full description and gallery", d.remarks && Array.isArray(d.photos) && d.photos.length === 5);
  check("the small copy of hers is written", mine.length === 1 && mine[0].listingId === "IRE1000004");
  check("state: complete, bootstrapped, per-county counts",
    state.lastFullCrawlComplete === true && state.bootstrapped === true && state.byCounty.larimer === 2 && state.byCounty.weld === 1,
    JSON.stringify(state.byCounty));
  check("state: last COMPLETE refresh time recorded", !!state.lastCompleteFullCrawlAt);
  check("state: lastSuccessAt (what the IDX 12-hour guard reads) is the complete refresh", state.lastSuccessAt === state.lastCompleteFullCrawlAt);
  check("the lock is released", !!(store.data.get(L.CRAWL_LOCK_KEY) || {}).finishedAt);
  check("no request went to MLS Grid", !fetch1.calls.some((c) => c.includes("mlsgrid")));

  // ---------------------------------------------------------------------------
  console.log("\n2. Details are fetched once per version, and the public URL can't be hammered");
  const again = await L.runFullCrawl({ store, apiKey: "test-key", fetchImpl: fetch1, sleepImpl: noSleep, log: () => {} });
  check("a refresh within 20 minutes of a complete one is refused", /less than 20 minutes/.test(String(again.skipped)));
  world.detailIds = [];
  await L.runFullCrawl({ store, apiKey: "test-key", fetchImpl: fetch1, sleepImpl: noSleep, log: () => {}, force: true });
  check("unchanged listings are not re-detailed; hers always are",
    world.detailIds.includes("IRE1000004") && !world.detailIds.includes("IRE1000001"), world.detailIds.join(","));
  check("...and the flags survive being carried forward",
    (store.data.get("lofty-listings.json").IRE1000001 || {}).equestrian === true);
  world.counties.Larimer[0] = { ...world.counties.Larimer[0], lastPrimaryChangeTime: "2026-09-28 16:00:00", price: 475000 };
  world.detailIds = [];
  await L.runFullCrawl({ store, apiKey: "test-key", fetchImpl: fetch1, sleepImpl: noSleep, log: () => {}, force: true });
  check("a changed listing IS re-detailed", world.detailIds.includes("IRE1000001"));
  check("...and its new price is stored", store.data.get("lofty-listings.json").IRE1000001.price === 475000);

  // ---------------------------------------------------------------------------
  console.log("\n3. Complete refresh: a listing that left the market leaves the site");
  world.counties.Larimer = world.counties.Larimer.filter((x) => x.mlsListingId !== "IRE1000002");
  await L.runFullCrawl({ store, apiKey: "test-key", fetchImpl: fetch1, sleepImpl: noSleep, log: () => {}, force: true });
  check("the pending listing that disappeared is gone", !store.data.get("lofty-listings.json").IRE1000002);

  // ---------------------------------------------------------------------------
  console.log("\n4. Partial refresh: adds and updates, never removes -- except her own");
  const cat4 = store.data.get("lofty-listings.json");
  cat4.IRE7777777 = { listingId: "IRE7777777", status: "Active", city: "Greeley", county: "weld", price: 1 };
  cat4.IRE8888888 = { listingId: "IRE8888888", status: "Active", city: "Loveland", agentName: "Christine Gwinnup", price: 2 };
  await store.setJSON("lofty-listings.json", cat4);
  world.failing = ["Weld"];
  const r4 = await L.runFullCrawl({ store, apiKey: "test-key", fetchImpl: fetch1, sleepImpl: noSleep, log: () => {}, force: true });
  world.failing = [];
  const after4 = store.data.get("lofty-listings.json");
  check("the refresh reports partial", r4.complete === false && r4.incomplete.some((x) => /weld/i.test(x)), JSON.stringify(r4.incomplete));
  check("a listing Lofty could not be asked about is kept", !!after4.IRE7777777);
  check("her listing that Lofty no longer lists as hers is removed anyway", !after4.IRE8888888);
  check("state says partial and names the county",
    store.data.get("lofty-sync-state.json").lastFullCrawlComplete === false &&
    /weld/i.test((store.data.get("lofty-sync-state.json").lastFullCrawlIncomplete || []).join(" ")));
  check("the last COMPLETE time is kept from before", !!store.data.get("lofty-sync-state.json").lastCompleteFullCrawlAt);
  check("a partial refresh does not advance lastSuccessAt",
    store.data.get("lofty-sync-state.json").lastSuccessAt === store.data.get("lofty-sync-state.json").lastCompleteFullCrawlAt &&
    store.data.get("lofty-sync-state.json").lastSuccessAt !== store.data.get("lofty-sync-state.json").lastFullCrawlAt);

  // ---------------------------------------------------------------------------
  console.log("\n5. The 30-minute quick pass");
  world.counties.Larimer.push(rec("IRE1000009", { __newToday: true }));
  // She has another listing still on the market, and IRE1000004 was withdrawn.
  world.mine = world.mine.filter((x) => x.mlsListingId !== "IRE1000004")
    .concat([rec("IRE1000010", { agentName: "Christine Gwinnup" })]);
  await store.setJSON(L.CRAWL_LOCK_KEY, { startedAt: new Date().toISOString() });
  const q0 = await L.runQuickPass({ store, apiKey: "test-key", fetchImpl: fetch1, sleepImpl: noSleep });
  check("it stands aside while a full refresh holds the lock", /full refresh is running/.test(String(q0.skipped)));
  await store.setJSON(L.CRAWL_LOCK_KEY, { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  const q = await L.runQuickPass({ store, apiKey: "test-key", fetchImpl: fetch1, sleepImpl: noSleep });
  const after5 = store.data.get("lofty-listings.json");
  check("a listing that came on the market today is added", !!after5.IRE1000009 && q.added >= 1);
  check("her withdrawn listing leaves within the half hour", !after5.IRE1000004);
  check("...and her small copy follows", !(store.data.get("lofty-mine-listings.json") || []).some((x) => x.listingId === "IRE1000004"));
  check("state records the quick pass", !!store.data.get("lofty-sync-state.json").lastQuickPassAt);
  const cat5 = store.data.get("lofty-listings.json");
  cat5.IRE5555555 = { listingId: "IRE5555555", status: "Active", city: "Loveland", agentName: "Christine Gwinnup", price: 3 };
  await store.setJSON("lofty-listings.json", cat5);
  const savedMine = world.mine;
  world.mine = [];
  await L.runQuickPass({ store, apiKey: "test-key", fetchImpl: fetch1, sleepImpl: noSleep });
  world.mine = savedMine;
  check("an EMPTY answer about her listings never wipes them (a glitch is likelier than zero)",
    !!store.data.get("lofty-listings.json").IRE5555555);

  // ---------------------------------------------------------------------------
  console.log("\n6. The schedule starts a full refresh only when one is due");
  const kicks = [];
  const kickFetch = async (url, init) => { if (String(url).includes("lofty-sync-background")) kicks.push(url); return fetch1(url, init); };
  const st = store.data.get("lofty-sync-state.json");
  await store.setJSON("lofty-sync-state.json", { ...st, lastFullCrawlAt: new Date().toISOString(), lastFullCrawlComplete: true });
  await L.scheduledTick({ store, apiKey: "test-key", siteUrl: "https://example.test", fetchImpl: kickFetch, sleepImpl: noSleep });
  check("not due: no refresh started", kicks.length === 0);
  const st2 = store.data.get("lofty-sync-state.json");
  await store.setJSON("lofty-sync-state.json", { ...st2, lastFullCrawlAt: new Date(Date.now() - 3 * 3600e3).toISOString() });
  await L.scheduledTick({ store, apiKey: "test-key", siteUrl: "https://example.test", fetchImpl: kickFetch, sleepImpl: noSleep });
  check("due: the background refresh is started", kicks.length === 1 && kicks[0] === "https://example.test/.netlify/functions/lofty-sync-background");
  check("...and the start request is recorded for /status", (store.data.get(L.CRAWL_KICK_KEY) || {}).httpStatus === 202);

  // ---------------------------------------------------------------------------
  console.log("\n7. The functions, end to end, with Lofty as the source");
  // A catalogue with one of hers (full gallery) and one other brokerage's listing.
  const hersRec = L.slimForStorage(L.applyDetails(L.mapLoftyListing(rec("IRE2000001", { agentName: "Christine Gwinnup" }), { county: "larimer" }),
    { pictureList: [PIC("IRE2000001", 1), PIC("IRE2000001", 2)], detailsDescribe: "Hers." }));
  const other = L.slimForStorage(L.applyDetails(L.mapLoftyListing(rec("IRE2000002", { price: 1500000 }), { county: "larimer" }),
    { pictureList: [PIC("IRE2000002", 1), PIC("IRE2000002", 2), PIC("IRE2000002", 3)] }));
  const siteStore = makeStore({
    "lofty-listings.json": { IRE2000001: hersRec, IRE2000002: other },
    "lofty-mine-listings.json": [hersRec],
    "lofty-sync-state.json": { lastRunAt: new Date().toISOString(), lastFullCrawlAt: new Date().toISOString(),
      lastCompleteFullCrawlAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(),
      lastFullCrawlComplete: true, byCounty: { larimer: 2 } },
  });
  const w7 = { details: { IRE2000002: { mlsListingId: "IRE2000002", pictureList: [PIC("IRE2000002", 1), PIC("IRE2000002", 2), PIC("IRE2000002", 3)] } } };
  const fetch7 = fakeLofty(w7);
  freshModules(siteStore, fetch7);

  // The IDX kill switch (lib/_idx-display.js) governs Lofty data exactly as it
  // governed MLS Grid data: off unless IDX_DISPLAY is "on".
  delete process.env.IDX_DISPLAY;
  const offRes = JSON.parse((await require(`${FN_DIR}/listings-search.js`).handler({ queryStringParameters: { noFloor: "true" } })).body);
  check("display switched OFF: Lofty listings are held back too", offRes.idxUnavailable === true && offRes.totalCount === 0);
  process.env.IDX_DISPLAY = "on";
  freshModules(siteStore, fetch7);

  const search = require(`${FN_DIR}/listings-search.js`).handler;
  const sres = JSON.parse((await search({ queryStringParameters: { noFloor: "true" } })).body);
  const card = (sres.listings || []).find((l) => l.listingId === "IRE2000002") || {};
  check("search returns the Lofty listings", sres.totalCount === 2, JSON.stringify(sres).slice(0, 200));
  check("a card photo is Lofty's 600px image, straight to the browser",
    /^https:\/\/img\.chime\.me\/.*\/w600_original_IRE2000002-cover\.jpeg$/.test(String(card.photo)), card.photo);
  check("internal fields are not sent to browsers", card.source === undefined && card.detailsFor === undefined && card.listingKey === undefined);
  const gal = JSON.parse((await search({ queryStringParameters: { listingId: "IRE2000001" } })).body);
  check("her gallery is served at 1200px", (gal.photos || []).length === 2 && gal.photos.every((u) => u.includes("/w1200_original_")));

  const page = require(`${FN_DIR}/listing-page.js`).handler;
  const pres = await page({ path: "/listing/IRE2000002", queryStringParameters: { id: "IRE2000002" } });
  check("a listing page renders", pres.statusCode === 200, String(pres.statusCode));
  const disclaimer = (pres.body.match(/<div class="mls-disclaimer">[\s\S]*?<\/div>/) || [""])[0];
  check("its disclaimer no longer names MLS Grid", !!disclaimer && !/MLS Grid/.test(disclaimer) &&
    /Listings courtesy of IRES MLS/.test(disclaimer), disclaimer.slice(0, 200));
  check("another brokerage's page shows its whole gallery, fetched from Lofty",
    (pres.body.match(/img\.chime\.me[^"]*w600_original_IRE2000002-/g) || []).length >= 2);
  check("its hero photo is the 1200px size", /w1200_original_IRE2000002-cover/.test(pres.body));

  const photo = require(`${FN_DIR}/listing-photo.js`).handler;
  const ph = await photo({ queryStringParameters: { id: "IRE2000002", i: "2" } });
  check("a photo link redirects to Lofty's image server", ph.statusCode === 302 && /img\.chime\.me/.test(ph.headers.Location), JSON.stringify(ph.headers));

  const health = require(`${FN_DIR}/site-health.js`).handler;
  const hres = JSON.parse((await health({ queryStringParameters: { format: "json", probe: "1" } })).body);
  const names = hres.checks.map((c) => c.name);
  check("/status shows the Lofty refresh rows",
    names.includes("Listings refreshing from Lofty on schedule") && names.includes("Every listing re-read from Lofty within 12 hours") &&
    names.includes("No Lofty errors on last run"), names.join(" | "));
  check("/status no longer shows MLS Grid sync rows", !names.some((n) => /MLS Grid/.test(n)), names.join(" | "));
  const showRow = hres.checks.find((c) => /Listings shown on the website/.test(c.name)) || {};
  check("/status says listings are showing, from Lofty", showRow.ok === true && /from Lofty/.test(String(showRow.detail)), showRow.detail);
  const photoRow = hres.checks.find((c) => c.name === "Listing photos load end to end") || {};
  check("the photo check fetches from Lofty's image server", /Lofty's image server/.test(String(photoRow.detail)), photoRow.detail);

  const sync = require(`${FN_DIR}/sync-listings.js`).handler;
  const syncRes = await sync();
  check("the 30-minute schedule runs with no MLS Grid token", syncRes.statusCode === 200 && syncRes.body === "ok", JSON.stringify(syncRes));
  check("and not one request anywhere in this section went to MLS Grid", !fetch7.calls.some((c) => c.includes("mlsgrid")),
    fetch7.calls.filter((c) => c.includes("mlsgrid")).join(", "));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
