// Lofty as the listing source (2026-09-28) -- her own listings from Lofty, every
// other search handed to her Lofty home search -- against a fake Lofty.
//
// Christine asked for the site's listings and searches to come from Lofty instead
// of MLS Grid, then approved the shape this suite pins ("lets do it!!!"): her
// Lofty site does the home search (it was faster from click to data), and this
// site keeps her own listings. No network:
//
//   - the 30-minute sync writes ONLY the Lofty keys (the MLS Grid copy, and a
//     switch back, are untouched) and stores ONLY her listings -- two requests;
//   - a complete answer replaces her set, so a withdrawn listing leaves at once;
//   - a failed, partial or empty answer keeps the last good set, and an empty one
//     is believed only after Lofty has said so for two hours;
//   - a whole-market copy left by the earlier design is cut down to hers;
//   - only IRES records are shown (her manual Lofty listing is reported, not
//     shown); a "my listings" record without her name is not shown either;
//   - a public search is answered with the same search on her Lofty site, and
//     no page serves another brokerage's listing, photo or gallery;
//   - nothing on the Lofty path makes a single request to MLS Grid.
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
    // Honors { prefix } like the real API: the MLS Grid path's pruneUsage lists
    // "mls-usage/" keys only, and a fake that handed it every key would let it
    // delete the catalogue (test-syncsave.js learned this the hard way).
    list: async (opts) => {
      const prefix = (opts && opts.prefix) || "";
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
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
    agentName: "Christine Gwinnup", previewPicture: COVER(id), latitude: "40.39", longitude: "-105.07",
    lastPrimaryChangeTime: "2026-09-28 10:00:00", mlsListDateLSort: 1787356800, builtYear: 2006,
    ...over,
  };
}

function reply(status, json) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json),
    json: async () => json, headers: { get: () => "application/json" } };
}

// A fake Lofty: "my" -> records, details by MLS id. Any other search is a bug now.
function fakeLofty(world) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(String(url));
    calls.push(`${(init && init.method) || "GET"} ${u.host}${u.pathname}`);
    if (u.host.includes("mlsgrid")) return reply(500, { error: "MLS Grid must not be called" });
    if (u.host === "img.chime.me") {
      return { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => new ArrayBuffer(30000) };
    }
    if (u.pathname === "/v2.0/listings/search") {
      const body = JSON.parse(init.body);
      if (body.searchScope !== "my") {
        world.marketSearches = (world.marketSearches || 0) + 1;
        return reply(500, { code: 1, message: "only her own listings should ever be asked for" });
      }
      if (world.myFails) return reply(500, { code: 500, message: "Lofty is having a moment" });
      const pool = world.mine || [];
      const size = body.pageSize;
      const items = pool.slice((body.pageNum - 1) * size, body.pageNum * size);
      return reply(200, { listing: items, metadata: {
        totalCount: pool.length, totalPage: Math.ceil(pool.length / size), pageNum: body.pageNum, pageSize: size,
      } });
    }
    if (u.pathname === "/v1.0/listing") {
      if (world.detailsFail) return reply(500, { code: 500, message: "details are down" });
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
const HOUR = 3600e3;

(async () => {
  process.env.LOFTY_API_KEY = "test-key";
  delete process.env.MLSGRID_API_TOKEN;

  // ---------------------------------------------------------------------------
  console.log("\n1. The sync stores her listings, and nothing else");
  const world = {
    mine: [
      rec("IRE1000004", { city: "Greeley", agentName: "Kendra Bajcar", coAgentName: "Christine Gwinnup" }),
      rec("IRE1000005", { listingStatus: "Pending", price: 1250000 }),
      rec("IRE1000006", { listingStatus: "Sold" }),
      rec("IRE1000007", { agentName: "A Teammate" }),
      rec("MANL1774145080001", { mlsOrgId: 0, streetAddress: "1 Pocket Ln" }),
    ],
    details: {
      IRE1000004: { mlsListingId: "IRE1000004", pictureList: [1, 2, 3, 4, 5].map((n) => PIC("IRE1000004", n)),
        detailsDescribe: "Christine's own listing, described in full.", subDivisionName: "Greeley Rural", county: "Weld", agentOrgId: "IRE07444" },
      IRE1000005: { mlsListingId: "IRE1000005", pictureList: [PIC("IRE1000005", 1), PIC("IRE1000005", 2)],
        detailsDescribe: "Riverfront, with a loafing shed.", subDivisionName: "Mariana Butte" },
    },
  };
  const sentinel = { IRE1: { listingId: "IRE1", source: "mlsgrid" } };
  // What the earlier (whole-market) design left behind: someone else's listing.
  const leftover = { IRE9999999: { listingId: "IRE9999999", agentName: "Someone Else", status: "Active" } };
  const store = makeStore({
    "listings.json": sentinel, "sync-state.json": { lastRunAt: "x" }, "mine-listings.json": [],
    "lofty-listings.json": leftover,
  });
  const fetch1 = fakeLofty(world);
  freshModules(store, fetch1);
  const L = require(`${FN_DIR}/lib/_lofty-listings.js`);
  const S = require(`${FN_DIR}/lib/_mls-shared.js`);
  check("the default source is Lofty", S.LISTINGS_SOURCE === "lofty");
  check("the site reads the Lofty keys", S.LISTINGS_KEY === "lofty-listings.json" && S.MINE_LISTINGS_KEY === "lofty-mine-listings.json");
  check("the whole-market refresh is gone", !L.runFullCrawl && !L.runQuickPass && !L.scheduledTick && !L.galleryFor);

  let clock = Date.parse("2026-09-28T18:00:00Z");
  const now = () => clock;
  const run = (extra) => L.runMineSync({ store, apiKey: "test-key", fetchImpl: fetch1, sleepImpl: noSleep, log: () => {}, now, ...(extra || {}) });

  const r1 = await run();
  const cat = store.data.get("lofty-listings.json") || {};
  const mine = store.data.get("lofty-mine-listings.json") || [];
  const state = store.data.get("lofty-sync-state.json") || {};
  check("the answer is accepted", r1.answer === "ok" && r1.accepted === true, JSON.stringify(r1));
  check("her Active and Pending listings are stored (co-listed counts as hers)", !!cat.IRE1000004 && !!cat.IRE1000005);
  check("a Sold listing is refused", !cat.IRE1000006);
  check("a 'my listings' record without her name is not shown", !cat.IRE1000007 && state.skippedNotHers === 1, String(state.skippedNotHers));
  check("her manual (non-MLS) listing is never published", !cat.MANL1774145080001);
  check("...but is reported in state", (state.herNonMlsListings || []).some((x) => x.includes("MANL1774145080001")), JSON.stringify(state.herNonMlsListings));
  check("the earlier whole-market copy is gone", !cat.IRE9999999 && Object.keys(cat).length === 2, Object.keys(cat).join(","));
  check("the small copy is her whole set", mine.length === 2);
  check("the MLS Grid catalogue is untouched", JSON.stringify(store.data.get("listings.json")) === JSON.stringify(sentinel));
  check("the MLS Grid state is untouched", store.data.get("sync-state.json").lastRunAt === "x");
  check("two requests: her listings, then their details", r1.requests === 2 && world.detailCalls === 1, `${r1.requests} / ${world.detailCalls}`);
  check("no search of the whole market", !world.marketSearches);
  const d = cat.IRE1000004 || {};
  check("listing ids keep MLS Grid's IRE form", d.listingId === "IRE1000004");
  check("mapped fields: price, beds, baths, sqft, address, status",
    d.price === 500000 && d.beds === 3 && d.baths === 2 && d.sqft === 2000 && d.address === "IRE1000004 Main St" && d.status === "Active");
  check("coordinates arrive as numbers", d.latitude === 40.39 && d.longitude === -105.07);
  check("her description and whole gallery are kept", /described in full/.test(d.remarks) && Array.isArray(d.photos) && d.photos.length === 5);
  check("subdivision from details, county from the town", d.subdivision === "Greeley Rural" && d.county === "weld", `${d.subdivision} / ${d.county}`);
  check("details are recorded against this version", d.detailsFor === d.modificationTimestamp);
  check("its cover is the stable Lofty URL", L.isLoftyPhoto(d.photo));
  check("empty fields are not stored", !Object.values(d).some((v) => v === null));
  const land = L.mapLoftyListing(rec("IRE1000099", { bedrooms: -1, bathrooms: -1, sqft: -1, builtYear: -1, price: 250000,
    propertyType: "Vacant Land", longitude: "-105.07" }), {});
  check("Lofty's -1 (not provided) becomes blank, so no card says \"-1 bd\"",
    land.beds === null && land.baths === null && land.sqft === null && land.yearBuilt === null, JSON.stringify(land));
  check("...while real values and negative longitudes are kept", land.price === 250000 && land.longitude === -105.07);
  check("state: accepted, bootstrapped, lastSuccessAt is this run",
    state.lastRunAnswer === "ok" && state.bootstrapped === true && state.lastSuccessAt === new Date(clock).toISOString() && !state.lastRunError,
    JSON.stringify(state));
  check("no request went to MLS Grid", !fetch1.calls.some((c) => c.includes("mlsgrid")));

  // ---------------------------------------------------------------------------
  console.log("\n2. A listing she withdraws leaves at the next run");
  world.mine = world.mine.filter((x) => x.mlsListingId !== "IRE1000005");
  clock += 30 * 60e3;
  await run();
  check("the withdrawn listing is gone", !store.data.get("lofty-listings.json").IRE1000005);
  check("...from the small copy too", !(store.data.get("lofty-mine-listings.json") || []).some((x) => x.listingId === "IRE1000005"));

  // ---------------------------------------------------------------------------
  console.log("\n3. A failed read changes nothing but the error");
  const before3 = JSON.stringify(store.data.get("lofty-listings.json"));
  const success3 = store.data.get("lofty-sync-state.json").lastSuccessAt;
  world.myFails = true;
  clock += 30 * 60e3;
  const r3 = await run();
  world.myFails = false;
  const st3 = store.data.get("lofty-sync-state.json");
  check("reported as an error, not accepted", r3.answer === "error" && r3.accepted === false, JSON.stringify(r3));
  check("her listings are kept exactly", JSON.stringify(store.data.get("lofty-listings.json")) === before3);
  check("lastSuccessAt does not advance", st3.lastSuccessAt === success3 && st3.lastRunAt !== success3, `${st3.lastSuccessAt} / ${st3.lastRunAt}`);
  check("Lofty's own words are on /status", /Lofty is having a moment/.test(String(st3.lastRunError)), st3.lastRunError);

  // ---------------------------------------------------------------------------
  console.log("\n4. An empty answer is believed only after two hours");
  const savedMine = world.mine;
  world.mine = [];
  clock += 30 * 60e3;
  const e1 = await run();
  check("the first empty answer keeps her listings", e1.accepted === false && !!store.data.get("lofty-listings.json").IRE1000004);
  check("...says why", /none of Christine's listings/.test(String(store.data.get("lofty-sync-state.json").lastRunError)));
  const since = store.data.get("lofty-sync-state.json").emptyMineSince;
  clock += HOUR;
  await run();
  check("still kept an hour later, and the clock did not restart",
    !!store.data.get("lofty-listings.json").IRE1000004 && store.data.get("lofty-sync-state.json").emptyMineSince === since);
  clock += HOUR + 60e3;
  const e3 = await run();
  check("after two hours of 'none', the site believes it", e3.accepted === true && Object.keys(store.data.get("lofty-listings.json")).length === 0);
  check("...and that counts as a success (nothing stale is shown)",
    store.data.get("lofty-sync-state.json").lastSuccessAt === new Date(clock).toISOString());
  world.mine = savedMine;
  clock += 30 * 60e3;
  await run();
  check("her listings come straight back with the next answer", !!store.data.get("lofty-listings.json").IRE1000004);
  const fresh = makeStore({});
  const e4 = await L.runMineSync({ store: fresh, apiKey: "k", fetchImpl: fakeLofty({ mine: [] }), sleepImpl: noSleep, log: () => {}, now });
  check("with nothing stored, an empty answer is simply accepted", e4.accepted === true && !!fresh.data.get("lofty-sync-state.json").lastSuccessAt);

  // ---------------------------------------------------------------------------
  console.log("\n5. Details: best effort, never fatal");
  world.detailsFail = true;
  world.mine = world.mine.concat([rec("IRE1000008", { price: 2100000 })]);
  clock += 30 * 60e3;
  const r5 = await run();
  world.detailsFail = false;
  const cat5 = store.data.get("lofty-listings.json");
  check("a new listing still appears, with its cover", r5.accepted && !!cat5.IRE1000008 && L.isLoftyPhoto(cat5.IRE1000008.photo));
  check("an unchanged listing keeps what the last details said", (cat5.IRE1000004.photos || []).length === 5 && !!cat5.IRE1000004.remarks);
  check("the details failure is reported", /details: .*details are down/.test(String(store.data.get("lofty-sync-state.json").lastRunError)));

  // ---------------------------------------------------------------------------
  console.log("\n6. A failed first run still cuts a whole-market copy down to hers");
  const old = makeStore({ "lofty-listings.json": {
    IRE1000004: { listingId: "IRE1000004", agentName: "Christine Gwinnup", status: "Active" },
    IRE7777777: { listingId: "IRE7777777", agentName: "Someone Else", status: "Active" },
  } });
  const r6 = await L.runMineSync({ store: old, apiKey: "k", fetchImpl: fakeLofty({ myFails: true }), sleepImpl: noSleep, log: () => {}, now });
  check("not accepted", r6.accepted === false);
  check("but no other brokerage's listing is left to serve",
    !old.data.get("lofty-listings.json").IRE7777777 && !!old.data.get("lofty-listings.json").IRE1000004);

  // ---------------------------------------------------------------------------
  console.log("\n7. The by-hand refresh");
  const siteStoreA = makeStore({});
  freshModules(siteStoreA, fakeLofty({ mine: [rec("IRE3000001")], details: {} }));
  const refresh = require(`${FN_DIR}/refresh-my-listings.js`).handler;
  check("GET is refused", (await refresh({ httpMethod: "GET" })).statusCode === 405);
  const rr1 = await refresh({ httpMethod: "POST" });
  check("POST refreshes her listings now", rr1.statusCode === 200 && JSON.parse(rr1.body).hers === 1, rr1.body);
  check("...and says nothing about the key or the listings themselves", !/test-key|IRE3000001/.test(rr1.body));
  const rr2 = await refresh({ httpMethod: "POST" });
  check("a second POST within a minute is refused", rr2.statusCode === 429 && /less than a minute/.test(rr2.body), rr2.body);

  // ---------------------------------------------------------------------------
  console.log("\n8. The functions, end to end");
  const hersRec = L.slimForStorage(L.applyDetails(L.mapLoftyListing(rec("IRE2000001"), { county: "larimer" }),
    { pictureList: [PIC("IRE2000001", 1), PIC("IRE2000001", 2), PIC("IRE2000001", 3)], detailsDescribe: "Hers." }));
  // A stray other-brokerage record, as if something had written one: nothing may serve it.
  const stray = L.slimForStorage(L.mapLoftyListing(rec("IRE2000002", { agentName: "Someone Else", price: 1500000 }), { county: "larimer" }));
  const siteStore = makeStore({
    "lofty-listings.json": { IRE2000001: hersRec, IRE2000002: stray },
    "lofty-mine-listings.json": [hersRec],
    "lofty-sync-state.json": { lastRunAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastRunAnswer: "ok" },
    "a-bWU": { id: "a-bWU", email: "me@example.com", cities: ["Loveland"] },
  });
  const w8 = { mine: [rec("IRE2000001")], details: {} };
  const fetch8 = fakeLofty(w8);

  // Display switched OFF: her listings are held back; a public search still gets
  // the hand-off (a link to her Lofty search is never listing data).
  delete process.env.IDX_DISPLAY;
  freshModules(siteStore, fetch8);
  let search = require(`${FN_DIR}/listings-search.js`).handler;
  const offMine = JSON.parse((await search({ queryStringParameters: { mine: "true" } })).body);
  check("display OFF: her listings are held back", offMine.idxUnavailable === true && offMine.reason === "disabled" && offMine.totalCount === 0);
  const offPublic = JSON.parse((await search({ queryStringParameters: { city: "Loveland" } })).body);
  check("display OFF: a public search still hands off to her Lofty search",
    offPublic.reason === "home_search" && /thelittleladyhomesearch\.com\/listing\?/.test(offPublic.searchUrl), offPublic.searchUrl);

  process.env.IDX_DISPLAY = "on";
  freshModules(siteStore, fetch8);
  search = require(`${FN_DIR}/listings-search.js`).handler;
  const sres = JSON.parse((await search({ queryStringParameters: { mine: "true" } })).body);
  const card = (sres.listings || [])[0] || {};
  check("her listings search returns hers only", sres.totalCount === 1 && card.listingId === "IRE2000001", JSON.stringify(sres).slice(0, 200));
  check("a card photo is Lofty's 600px image, straight to the browser",
    /^https:\/\/img\.chime\.me\/.*\/w600_original_IRE2000001-cover\.jpeg$/.test(String(card.photo)), card.photo);
  check("internal fields are not sent to browsers", card.source === undefined && card.detailsFor === undefined && card.listingKey === undefined);
  const hand = JSON.parse((await search({ queryStringParameters: { cities: "loveland,berthoud", minPrice: "1200000", beds: "4" } })).body);
  const cond = JSON.parse(new URL(hand.searchUrl).searchParams.get("condition"));
  check("a public search hands off: no listings, a button, the same search on Lofty",
    hand.idxUnavailable === true && hand.reason === "home_search" && hand.totalCount === 0 && (hand.listings || []).length === 0 &&
    cond.location.city.join("|") === "Loveland, CO|Berthoud, CO" && cond.price === "1200000," && cond.beds === "4,", hand.searchUrl);
  check("...labelled for what it is", /homes for sale in these towns from \$1\.2M/.test(hand.message), hand.message);
  const gal = JSON.parse((await search({ queryStringParameters: { listingId: "IRE2000001" } })).body);
  check("her gallery is served at 1200px", (gal.photos || []).length === 3 && gal.photos.every((u) => u.includes("/w1200_original_")));
  const galOther = JSON.parse((await search({ queryStringParameters: { listingId: "IRE2000002" } })).body);
  check("another brokerage's gallery is not served", galOther.error === "not_found", JSON.stringify(galOther));

  const page = require(`${FN_DIR}/listing-page.js`).handler;
  const pres = await page({ path: "/listing/IRE2000001", queryStringParameters: { id: "IRE2000001" } });
  check("her listing page renders", pres.statusCode === 200, String(pres.statusCode));
  const disclaimer = (pres.body.match(/<div class="mls-disclaimer">[\s\S]*?<\/div>/) || [""])[0];
  check("its disclaimer no longer names MLS Grid", !!disclaimer && !/MLS Grid/.test(disclaimer) &&
    /Listings courtesy of IRES MLS/.test(disclaimer), disclaimer.slice(0, 200));
  check("her page shows her whole gallery", (pres.body.match(/img\.chime\.me[^"]*w600_original_IRE2000001-/g) || []).length >= 3);
  check("its hero photo is the 1200px size", /w1200_original_IRE2000001-cover/.test(pres.body));
  const other = await page({ path: "/listing/IRE2000002", queryStringParameters: { id: "IRE2000002" } });
  check("another brokerage's listing page is a 404", other.statusCode === 404, String(other.statusCode));
  check("...that sends the visitor to her Lofty home search", /href="https:\/\/thelittleladyhomesearch\.com\/listing\?condition=/.test(other.body) &&
    /Search Homes For Sale/.test(other.body));
  check("...and says so plainly", /isn’t one of my current listings/.test(other.body));

  const photo = require(`${FN_DIR}/listing-photo.js`).handler;
  const ph = await photo({ queryStringParameters: { id: "IRE2000001", i: "2" } });
  check("her photo link redirects to Lofty's image server", ph.statusCode === 302 && /img\.chime\.me/.test(ph.headers.Location), JSON.stringify(ph.headers));
  const detailsBefore = w8.detailCalls || 0;
  const phOther = await photo({ queryStringParameters: { id: "IRE2000002", i: "1" } });
  check("another brokerage's photo link is not served", phOther.statusCode !== 302);
  check("...and costs no call to Lofty", (w8.detailCalls || 0) === detailsBefore);

  const home = require(`${FN_DIR}/home-search.js`).handler;
  const hs = await home({ queryStringParameters: { city: "Loveland", noFloor: "true" } });
  check("/search-homes.html redirects (302) to the same search on Lofty",
    hs.statusCode === 302 && JSON.parse(new URL(hs.headers.Location).searchParams.get("condition")).location.city[0] === "Loveland, CO",
    JSON.stringify(hs.headers));

  const alerts = require(`${FN_DIR}/area-alerts.js`).handler;
  const al = JSON.parse((await alerts({ httpMethod: "POST", body: JSON.stringify({ email: "a@b.co", cities: ["Loveland"] }) })).body);
  check("a new map alert sign-up is sent to her home search instead", al.ok === false && al.error === "moved" && /thelittleladyhomesearch\.com/.test(al.searchUrl));
  const alRun = await require(`${FN_DIR}/area-alerts-run.js`).handler();
  check("the alert emails are paused", /paused/.test(alRun.body), alRun.body);

  const health = require(`${FN_DIR}/site-health.js`).handler;
  const hres = JSON.parse((await health({ queryStringParameters: { format: "json", probe: "1" } })).body);
  const names = hres.checks.map((c) => c.name);
  check("/status shows the refresh rows for her listings",
    names.includes("Your listings refreshing from Lofty on schedule") && names.includes("Your listings confirmed by Lofty within 12 hours") &&
    names.includes("No Lofty errors on last run") && names.includes("Christine's own listings found"), names.join(" | "));
  check("/status no longer shows the MLS Grid listing-sync rows",
    !names.includes("Sync running on schedule") && !names.includes("No MLS Grid errors on last run"), names.join(" | "));
  const gridRow = hres.checks.find((c) => /Market data from MLS Grid/.test(c.name)) || {};
  check("...only the optional market-data row, which says it is never shown as listings",
    gridRow.optional === true && /never shown as listings|MLSGRID_API_TOKEN isn't set/.test(String(gridRow.detail)), gridRow.detail);
  const showRow = hres.checks.find((c) => /Listings shown on the website/.test(c.name)) || {};
  check("/status says her listings are showing, from Lofty", showRow.ok === true && /own listings are showing, from Lofty/.test(String(showRow.detail)), showRow.detail);
  const searchRow = hres.checks.find((c) => /Home search goes to Lofty/.test(c.name)) || {};
  check("/status names where the home search goes", /thelittleladyhomesearch\.com\/listing/.test(String(searchRow.detail)), searchRow.detail);
  const alertRow = hres.checks.find((c) => /alerts paused/.test(c.name)) || {};
  check("/status counts the paused map alerts", alertRow.optional === true && /\d+ sign-up/.test(String(alertRow.detail)), alertRow.detail);
  const stripRow = hres.checks.find((c) => /Sold & open-houses strip/.test(c.name)) || {};
  check("/status says whether the sold & open-houses strip is on (optional row)",
    stripRow.optional === true && /^(ON|OFF)/.test(String(stripRow.detail)), stripRow.detail);
  const photoRow = hres.checks.find((c) => c.name === "Listing photos load end to end") || {};
  check("the photo check fetches from Lofty's image server", /Lofty's image server/.test(String(photoRow.detail)), photoRow.detail);

  const callsBefore = fetch8.calls.length;
  const sync = require(`${FN_DIR}/sync-listings.js`).handler;
  const syncRes = await sync();
  const syncCalls = fetch8.calls.slice(callsBefore).filter((c) => c.includes("api.lofty.com/v2.0") || c.includes("api.lofty.com/v1.0/listing"));
  check("the 30-minute schedule runs with no MLS Grid token", syncRes.statusCode === 200 && syncRes.body === "ok", JSON.stringify(syncRes));
  check("...and makes exactly two listing requests to Lofty", syncCalls.length === 2, syncCalls.join(", "));
  check("and not one request anywhere in this section went to MLS Grid", !fetch8.calls.some((c) => c.includes("mlsgrid")),
    fetch8.calls.filter((c) => c.includes("mlsgrid")).join(", "));
  check("the background whole-market refresh no longer exists",
    !require("fs").existsSync(`${FN_DIR}/lofty-sync-background.js`));

  // ---------------------------------------------------------------------------
  console.log("\n9. Then MLS Grid, in the background, for the town market figures");
  // Christine, 2026-09-28: "use my mls grid for whatever we need to for all of
  // this - it wasn't shut off after all". Her listings still come from Lofty;
  // the MLS Grid copy is refreshed after them, under its own keys, for the town
  // pages' figures -- and nothing it does may reach what the site shows.
  process.env.MLSGRID_API_TOKEN = "grid-token";
  const gridCalls = [];
  const gridUrls = [];
  const w9 = { mine: [rec("IRE2000001")], details: {} };
  const lofty9 = fakeLofty(w9);
  const fetch9 = async (url, init) => {
    const u = new URL(String(url));
    if (u.host.includes("mlsgrid")) {
      gridCalls.push(u.pathname);
      gridUrls.push(u);
      // 2026-09-30: the sync now asks MLS Grid whether each Lofty listing is
      // still on the market (tests/test-lofty-mls-check.js). Answer "yes" for
      // her listing here so this section keeps testing what it always did:
      // the market-data crawl itself never touches what the site shows.
      const filter = u.searchParams.get("$filter") || "";
      const m = /ListingId eq '([^']+)'/.exec(filter);
      const value = m ? [{ ListingId: m[1], StandardStatus: "Active", MlgCanView: true }]
        // The market crawl: one changed record, one of hers, with no Media.
        : u.searchParams.get("$orderby") ? [{ ListingId: "IRE3", StandardStatus: "Active", MlgCanView: true,
          City: "Loveland", ListPrice: 700000, ListAgentFullName: "Christine Gwinnup",
          ModificationTimestamp: "2026-09-29T00:00:00.000Z" }]
        : [];
      return { ok: true, status: 200, headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ value }), json: async () => ({ value }) };
    }
    return lofty9(url, init);
  };
  const gridSentinel = {
    IRE1: { listingId: "IRE1", source: "mlsgrid", status: "Active", city: "Loveland", county: "larimer", price: 1 },
    // One of HER listings in the MLS Grid copy, photos not yet re-hosted, and her
    // office known: exactly what used to set off the photo passes every run.
    IRE3: { listingId: "IRE3", status: "Active", city: "Loveland", price: 690000, agentName: "Christine Gwinnup",
      photos: ["https://media.mlsgrid.com/a.jpg", "https://media.mlsgrid.com/b.jpg"], photo: "https://media.mlsgrid.com/a.jpg" },
  };
  const store9 = makeStore({
    "listings.json": gridSentinel,
    "sync-state.json": { lastRunAt: "2026-09-28T00:00:00.000Z", herOfficeMlsId: "OFF1" },
    "lofty-listings.json": { IRE2000001: hersRec },
    "lofty-mine-listings.json": [hersRec],
    "lofty-sync-state.json": { lastRunAt: "2026-09-28T00:00:00.000Z", lastSuccessAt: "2026-09-28T00:00:00.000Z" },
  });
  freshModules(store9, fetch9);
  const sync9 = require(`${FN_DIR}/sync-listings.js`);
  const res9 = await sync9.handler();
  check("the schedule still answers ok", res9.statusCode === 200 && res9.body === "ok", JSON.stringify(res9));
  check("her Lofty listings refreshed first", store9.data.get("lofty-sync-state.json").lastRunAt !== "2026-09-28T00:00:00.000Z");
  check("then MLS Grid was read", gridCalls.length > 0, String(gridCalls.length));
  // 2026-09-30 (API audit): the market-data run is for town figures only, so it
  // never asks MLS Grid for photos (the shared account was suspended for over-use).
  check("...and not one of those requests asked for Media",
    gridUrls.every((u) => !u.searchParams.get("$expand")), gridUrls.map((u) => u.search).join(" | "));
  const crawl = gridUrls.filter((u) => /ModificationTimestamp|MlgCanView eq true and \(/.test(u.searchParams.get("$filter") || "") &&
    u.searchParams.get("$orderby"));
  check("...the market crawl pages 1,000 records at a time", crawl.length > 0 &&
    crawl.every((u) => u.searchParams.get("$top") === "1000"), crawl.map((u) => u.searchParams.get("$top")).join(","));
  const ire3 = (store9.data.get("listings.json") || {}).IRE3 || {};
  check("...the crawl updated her record's price but kept its stored photos",
    ire3.price === 700000 && Array.isArray(ire3.photos) && ire3.photos.length === 2, JSON.stringify(ire3).slice(0, 200));
  check("...and makes no per-listing or office photo lookups", gridUrls.every((u) =>
    !/ListOfficeMlsId/.test(u.searchParams.get("$filter") || "") &&
    (!/ListingId eq/.test(u.searchParams.get("$filter") || "") || u.searchParams.get("$select") === "ListingId,StandardStatus,MlgCanView")),
    gridUrls.map((u) => u.searchParams.get("$filter")).join(" | "));
  check("...and its own state moved on", store9.data.get("sync-state.json").lastRunAt !== "2026-09-28T00:00:00.000Z",
    JSON.stringify(store9.data.get("sync-state.json")).slice(0, 200));
  check("what the site shows is untouched by it: still only her listing",
    JSON.stringify(Object.keys(store9.data.get("lofty-listings.json"))) === '["IRE2000001"]');
  check("and the MLS Grid copy was not overwritten with Lofty data", !!(store9.data.get("listings.json") || {}).IRE1 &&
    !(store9.data.get("listings.json") || {}).IRE2000001);
  process.env.MLSGRID_MARKET_DATA = "off";
  gridCalls.length = 0;
  freshModules(store9, fetch9);
  await require(`${FN_DIR}/sync-listings.js`).handler();
  check("MLSGRID_MARKET_DATA=off stops it", gridCalls.length === 0, String(gridCalls.length));
  delete process.env.MLSGRID_MARKET_DATA;
  delete process.env.MLSGRID_API_TOKEN;

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
