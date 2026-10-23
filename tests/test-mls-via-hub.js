// MLS reads through the Seller Intelligence hub (wave 2a, 2026-10-17) -- MLS_SOURCE=hub.
//
// The two MLS Grid readers this site still runs (the market-data copy behind the
// town figures, and "is her Lofty listing really on the market?") must behave the
// same whichever source they read. So every status change below is fed to BOTH:
//   - the MLS Grid path, against a fake MLS Grid answering from fixture records;
//   - the hub path, against a fake hub answering with rows built from the SAME
//     records by the hub's own reference function (tests/_hub-mls-reference.js,
//     copied verbatim from the hub contract);
// and the results must match: listings.json, mine-listings.json, the town figures
// (build/tools/town-market-stats.js townFigures) and the confirmer's verdicts.
//
// Also pinned: the switch (only exactly "hub", trimmed), every hub failure failing
// closed (nothing applied, checkpoint and lastSuccessAt held, the reason visible),
// zero MLS Grid requests in hub mode, the 15-minute hub cadence that leaves MLS
// Grid's volume alone, and the refused LISTINGS_SOURCE=mlsgrid + MLS_SOURCE=hub
// combination. No network: every host is a fake.
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
const { hubRowFromMlsGrid } = require("./_hub-mls-reference");
const { townFigures } = require(`${ROOT}/build/tools/town-market-stats.js`);

// The code under test logs every run; only this suite's own lines are printed
// (the functions' logs are muted below and restored before any crash is shown).
const print = (s) => process.stdout.write(`${s}\n`);
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let failures = 0;
const check = (l, c, x) => { if (c) print(`  ok   ${l}`); else { failures++; print(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const HUB_URL = "https://hub.test/functions/v1/hub-api";
const HUB_KEY = "hub_" + "ab".repeat(32);
const DAY = 24 * 3600e3;
const SELECT = ["ListingId", "ListingKey", "StandardStatus", "ListPrice", "BedroomsTotal", "BathroomsTotalInteger",
  "LivingArea", "StreetNumber", "StreetName", "StreetSuffix", "City", "StateOrProvince", "PostalCode", "PublicRemarks",
  "PropertyType", "PropertySubType", "SubdivisionName", "WaterfrontYN", "ListAgentFullName", "CoListAgentFullName",
  "ModificationTimestamp", "MlgCanView"];

// ---- fakes ---------------------------------------------------------------------
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
const copyOf = (store) => makeStore(Object.fromEntries([...store.data.entries()]));

let clock = Date.now() - 30 * DAY;
const tick = () => new Date(clock += 60000).toISOString();

function rec(n, over) {
  return {
    ListingKey: `K${n}`, ListingId: `IRE${1000000 + n}`, OriginatingSystemName: "ires", StandardStatus: "Active",
    ListPrice: 500000 + n * 25000, BedroomsTotal: 3, BathroomsTotalInteger: 2, LivingArea: 1800 + n * 37,
    StreetNumber: String(100 + n), StreetName: "Elm", StreetSuffix: "St", City: "Loveland", StateOrProvince: "CO",
    PostalCode: "80537", PublicRemarks: "A well kept home.", PropertyType: "Residential",
    PropertySubType: "Single Family Residence", SubdivisionName: "Mariana Butte", WaterfrontYN: false,
    ListAgentFullName: "Other Brokerage", CoListAgentFullName: null, MlgCanView: true, MlgCanUse: ["IDX"],
    ListOfficeMlsId: "IRE999", ListOfficeKey: "OK9", ModificationTimestamp: tick(), ...over,
  };
}

// The market both fakes answer from. hidden: "deleted" (the hub drops an
// MlgCanView=false listing and lists it at /v1/mls/deleted) or "stub" (it keeps
// it and answers this key with a withheld stub).
function makeWorld(hidden) {
  const w = { records: new Map(), deletions: [], hidden: hidden || "deleted", pageSize: 4, deletedComplete: true,
    agents: true, hubFail: null, hubCalls: 0, delId: 0 };
  return w;
}
function put(world, r) {
  r.ModificationTimestamp = tick();
  const was = world.records.get(r.ListingKey);
  world.records.set(r.ListingKey, r);
  if (r.MlgCanView === false && world.hidden === "deleted" && !(was && was.MlgCanView === false)) {
    world.deletions.push({ id: ++world.delId, ListingKey: r.ListingKey, reason: "mlg_can_view_false", deleted_at: new Date().toISOString() });
  }
}
function change(world, key, over) {
  const r = { ...world.records.get(key), ...over };
  put(world, r);
}

function reply(status, json) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json),
    json: async () => json, headers: { get: () => "application/json" } };
}

function mlsGridAnswer(world, u) {
  world.gridCalls = (world.gridCalls || 0) + 1;
  const filter = u.searchParams.get("$filter") || "";
  const select = (u.searchParams.get("$select") || "").split(",");
  const pick = (r) => Object.fromEntries(select.filter((f) => f in r).map((f) => [f, r[f]]));
  const one = /ListingId eq '([^']+)'/.exec(filter);
  if (one) {
    const r = [...world.records.values()].find((x) => x.ListingId === one[1]);
    return reply(200, { value: r ? [pick(r)] : [] });
  }
  let rows = [...world.records.values()];
  const gt = /ModificationTimestamp gt (\S+)/.exec(filter);
  if (gt) rows = rows.filter((r) => r.ModificationTimestamp > gt[1]);
  if (/MlgCanView eq true/.test(filter)) {
    const statuses = [...filter.matchAll(/StandardStatus eq '([^']+)'/g)].map((m) => m[1]);
    rows = rows.filter((r) => r.MlgCanView === true && statuses.includes(r.StandardStatus));
  }
  rows.sort((a, b) => a.ModificationTimestamp.localeCompare(b.ModificationTimestamp));
  return reply(200, { value: rows.map(pick) });
}

const COPY = () => ({ ready: true, reason: "ok", last_success_at: new Date(Date.now() - 5 * 60e3).toISOString(), age_hours: 0.1, max_age_hours: 48 });
const normId = (v) => String(v || "").toUpperCase().replace(/^IRE/, "");
function hubRows(world) {
  const out = [];
  for (const r of world.records.values()) {
    if (r.MlgCanView === false) {
      if (world.hidden === "stub") {
        out.push({ ListingKey: r.ListingKey, ListingId: r.ListingId,
          ModificationTimestamp: new Date(Date.parse(r.ModificationTimestamp)).toISOString(), MlgCanView: false, _hub: { withheld: true } });
      }
      continue;
    }
    out.push(hubRowFromMlsGrid(r, { agents: world.agents, officeName: "Another Office" }));
  }
  return out;
}
const SEARCH_KEYS = new Set(["statuses", "property_types", "cities", "counties", "postal_codes", "street_number", "listing_ids",
  "listing_keys", "list_office_mls_ids", "min_list_price", "max_list_price", "min_close_price", "modified_since",
  "closed_from", "closed_to", "order", "after", "limit", "include_open_houses"]);
function page(world, rows, after, limit) {
  const offset = after ? Number(String(after).slice(2)) : 0;
  const size = Math.min(limit || 500, world.pageSize);
  const slice = rows.slice(offset, offset + size);
  return { rows: slice, next: offset + slice.length < rows.length ? `o:${offset + slice.length}` : null };
}
async function hubAnswer(world, u, init) {
  world.hubCalls += 1;
  world.hubLog = (world.hubLog || []).concat(`${init.method} ${u.pathname}${u.search}`);
  if (init.headers["x-hub-key"] !== HUB_KEY) return reply(401, { error: "unknown key" });
  if (init.redirect !== "error") return reply(500, { error: "redirects must be refused" });
  const f = world.hubFail;
  if (f && (!f.onCall || f.onCall === world.hubCalls)) {
    if (f.mode === "down") throw new Error("connect ECONNREFUSED");
    if (f.mode === "html") return { status: 200, text: async () => "<html>gateway</html>" };
    if (f.mode === "not_ready") return reply(503, { status: "not_ready", copy: { ready: false, reason: "catching_up" } });
    if (f.mode === "ready_false") return reply(200, { status: "ok", copy: { ready: false, reason: "stale" }, rows: [], next: null });
    if (f.mode === "500") return reply(500, { error: "internal" });
    if (f.mode === "off") return reply(503, { error: "mls_reads_enabled is off" });
    const deletions = /\/deleted$/.test(u.pathname);
    if (f.mode === "bad_row") {
      return reply(200, { status: "ok", copy: COPY(), rows: [deletions ? { id: 1, deleted_at: new Date().toISOString() } : { City: "Loveland" }],
        next: null, ...(deletions ? { complete: true, kept_days: 30 } : {}) });
    }
    if (f.mode === "bad_next") return reply(200, { status: "ok", copy: COPY(), rows: [], next: 42, ...(deletions ? { complete: true } : {}) });
  }
  const sub = u.pathname.replace("/functions/v1/hub-api", "");
  if (init.method === "POST" && sub === "/v1/mls/search") {
    const body = JSON.parse(init.body);
    for (const k of Object.keys(body)) if (!SEARCH_KEYS.has(k)) return reply(400, { error: `unknown key ${k}` });
    let rows = hubRows(world);
    if (body.statuses) rows = rows.filter((r) => !(r._hub && r._hub.withheld) && body.statuses.includes(r.StandardStatus));
    if (body.modified_since) rows = rows.filter((r) => Date.parse(r.ModificationTimestamp) >= Date.parse(body.modified_since));
    if (body.listing_ids) rows = rows.filter((r) => body.listing_ids.some((id) => normId(id) === normId(r.ListingId)));
    rows.sort(body.order === "modified"
      ? (a, b) => a.ModificationTimestamp.localeCompare(b.ModificationTimestamp) || a.ListingKey.localeCompare(b.ListingKey)
      : (a, b) => a.ListingKey.localeCompare(b.ListingKey));
    const p = page(world, rows, body.after, body.limit);
    return reply(200, { status: "ok", copy: COPY(), coverage: { offmarket_kept: world.hidden === "stub", offmarket_complete: false }, ...p });
  }
  if (init.method === "GET" && sub === "/v1/mls/deleted") {
    const since = u.searchParams.get("since");
    const rows = world.deletions.filter((d) => Date.parse(d.deleted_at) >= Date.parse(since));
    const p = page(world, rows, u.searchParams.get("after"), Number(u.searchParams.get("limit")) || 500);
    return reply(200, { status: "ok", copy: COPY(), kept_days: 30, complete: world.deletedComplete, ...p });
  }
  return reply(404, { error: "no such route" });
}

const LOFTY_COVER = (id) => `https://img.chime.me/image/fs01/mls-listing/20260827/21/original_${id}-cover.jpeg`;
function loftyAnswer(world, u, init) {
  world.loftyCalls = (world.loftyCalls || 0) + 1;
  if (u.pathname === "/v2.0/listings/search") {
    const body = JSON.parse(init.body);
    const pool = world.loftyMine || [];
    const items = pool.slice((body.pageNum - 1) * body.pageSize, body.pageNum * body.pageSize);
    return reply(200, { listing: items, metadata: { totalCount: pool.length, totalPage: 1, pageNum: body.pageNum, pageSize: body.pageSize } });
  }
  if (u.pathname === "/v1.0/listing") return reply(200, { listIng: [], soldListing: [] });
  return reply(404, {});
}

function makeFetch(world) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ host: u.host, url: String(url), init: init || {} });
    if (u.host === "api.mlsgrid.com") return mlsGridAnswer(world, u);
    if (u.host === "hub.test") return hubAnswer(world, u, init || {});
    if (u.host === "api.lofty.com") return loftyAnswer(world, u, init || {});
    if (u.host === "img.chime.me") return { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => new ArrayBuffer(30000) };
    throw new Error(`unexpected host ${u.host}`);
  };
  f.calls = calls;
  f.grid = () => calls.filter((c) => c.host.includes("mlsgrid")).length;
  return f;
}

function freshModules(store, fetchImpl) {
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => store } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  global.fetch = fetchImpl;
}

const SETTINGS = ["MLS_SOURCE", "HUB_API_URL", "HUB_API_KEY", "MLSGRID_API_TOKEN", "MLSGRID_MARKET_DATA", "MLS_DISABLED",
  "LISTINGS_SOURCE", "LOFTY_API_KEY", "IDX_DISPLAY", "OPERATING_COUNTIES"];
function setEnv(vars) {
  for (const k of SETTINGS) delete process.env[k];
  Object.assign(process.env, vars || {});
}
const GRID_ENV = { MLSGRID_API_TOKEN: "grid-test-token" };
const HUB_ENV = { MLS_SOURCE: "hub", HUB_API_URL: HUB_URL, HUB_API_KEY: HUB_KEY };

// One scheduled run of the 30-minute sync (no Lofty key: only the market-data run).
async function runSync(store, world, env) {
  setEnv(env);
  const f = makeFetch(world);
  freshModules(store, f);
  const res = await require(`${FN_DIR}/sync-listings.js`).handler();
  return { res, fetch: f };
}

// What the two copies must agree on. photosRefreshedAt is the run's own clock.
function snapshot(store) {
  const listings = store.data.get("listings.json") || {};
  const norm = {};
  for (const id of Object.keys(listings).sort()) {
    const l = { ...listings[id] };
    delete l.photosRefreshedAt;
    norm[id] = Object.fromEntries(Object.keys(l).sort().map((k) => [k, l[k]]));
  }
  const mine = (store.data.get("mine-listings.json") || []).map((l) => l.listingId).sort();
  return { listings: norm, mine, towns: townFigures(Object.values(listings)).towns };
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
// A snapshot without some listings (their town figures are unaffected: only Active counts).
function minus(s, ids) {
  const listings = { ...s.listings };
  for (const id of ids) delete listings[id];
  return { listings, mine: s.mine.filter((id) => !ids.includes(id)), towns: s.towns };
}
function diff(a, b) {
  const out = [];
  for (const id of new Set([...Object.keys(a.listings), ...Object.keys(b.listings)])) {
    if (JSON.stringify(a.listings[id]) !== JSON.stringify(b.listings[id])) out.push(`${id}: grid ${JSON.stringify(a.listings[id])} hub ${JSON.stringify(b.listings[id])}`);
  }
  if (!same(a.mine, b.mine)) out.push(`mine ${a.mine} vs ${b.mine}`);
  if (!same(a.towns, b.towns)) out.push(`towns ${JSON.stringify(a.towns)} vs ${JSON.stringify(b.towns)}`);
  return out.join(" | ").slice(0, 1500);
}

// A market with enough Active listings in two towns for figures (MIN_SAMPLE 5).
function seedMarket(world) {
  for (let n = 1; n <= 6; n++) put(world, rec(n, n === 2 ? { ListPrice: 649999.99, LivingArea: 2150.5 } : {}));
  for (let n = 7; n <= 12; n++) put(world, rec(n, { City: "Windsor", PostalCode: "80550", StreetNumber: n === 8 ? 2411 : String(100 + n) }));
  put(world, rec(13, { ListAgentFullName: "Christine Gwinnup", ListPrice: 1250000 }));               // hers, Active
  put(world, rec(14, { CoListAgentFullName: "Christine Gwinnup", StandardStatus: "Coming Soon" }));  // hers, Coming Soon
  put(world, rec(15, { City: "Windsor", StandardStatus: "Pending" }));
  put(world, rec(16, { StandardStatus: "Active Under Contract" }));
  put(world, rec(17, { City: "Fraser", PostalCode: "80442" }));                                       // out of area
  put(world, rec(18, { PublicRemarks: "Riverfront acreage with a loafing shed and riding arena." }));
  put(world, rec(19, { StandardStatus: "Closed" }));                                                  // never stored
}

// Both paths start from the SAME stored copy and checkpoint (what an MLS Grid
// bootstrap left), then see the same changes.
async function bootstrapPair(hidden) {
  const world = makeWorld(hidden);
  seedMarket(world);
  const gridStore = makeStore({});
  await runSync(gridStore, world, GRID_ENV);      // MLS Grid bootstrap (Active/AUC/Pending)
  await runSync(gridStore, world, GRID_ENV);      // + its first incremental (brings Coming Soon in)
  return { world, gridStore, hubStore: copyOf(gridStore) };
}

(async () => {
  console.log = console.warn = console.error = () => {};

  // ---------------------------------------------------------------------------
  print("\n1. The switch: only exactly \"hub\" (trimmed), read at call time");
  {
    setEnv({});
    freshModules(makeStore({}), makeFetch(makeWorld()));
    const H = require(`${FN_DIR}/lib/_mls-hub.js`);
    const notes = [];
    for (const [v, want] of [[undefined, "mlsgrid"], ["", "mlsgrid"], ["mlsgrid", "mlsgrid"], ["Hub", "mlsgrid"],
      ["HUB", "mlsgrid"], ["on", "mlsgrid"], [" hub ", "hub"], ["hub", "hub"], ["\thub\n", "hub"]]) {
      check(`MLS_SOURCE=${JSON.stringify(v)} -> ${want}`, H.mlsSource(v === undefined ? {} : { MLS_SOURCE: v }, (m) => notes.push(m)) === want);
    }
    check("an unrecognised value is noted in one line, once", notes.length === 1 && /only exactly "hub"/.test(notes[0]), notes.join(" / "));
    check("...and the note never prints the value", !notes.some((m) => /HUB|\bon\b/.test(m.replace(/"hub"|"mlsgrid"/g, ""))), notes[0]);
    const S = require(`${FN_DIR}/sync-listings.js`);
    check("MLS Grid mode still needs its token for the market data", S.mlsGridMarketDataOn({}) === false &&
      S.mlsGridMarketDataOn({ MLSGRID_API_TOKEN: "t" }) === true);
    check("hub mode needs no MLS Grid token", S.mlsGridMarketDataOn({ MLS_SOURCE: "hub" }) === true);
    check("MLSGRID_MARKET_DATA=off stops it in hub mode too", S.mlsGridMarketDataOn({ MLS_SOURCE: "hub", MLSGRID_MARKET_DATA: "off" }) === false);
    check("a hub that is not set up is not 'off' (the run reports why instead)", S.mlsGridMarketDataOn({ MLS_SOURCE: "hub" }) === true &&
      H.hubProblem({}) === "HUB_API_URL and HUB_API_KEY are not set");
    check("hub settings are checked, never printed", H.hubProblem({ HUB_API_URL: "http://hub.test", HUB_API_KEY: HUB_KEY }) ===
      "HUB_API_URL must be https and HUB_API_KEY a hub key (hub_ + 64 hex)" && H.hubProblem({ HUB_API_URL: HUB_URL, HUB_API_KEY: HUB_KEY }) === null);
    check("only LISTINGS_SOURCE=mlsgrid with MLS_SOURCE=hub is refused",
      H.gridListingsRefused({ LISTINGS_SOURCE: "mlsgrid", MLS_SOURCE: "hub" }) === true &&
      H.gridListingsRefused({ LISTINGS_SOURCE: "mlsgrid", MLS_SOURCE: "Hub" }) === false &&
      H.gridListingsRefused({ MLS_SOURCE: "hub" }) === false && H.gridListingsRefused({ LISTINGS_SOURCE: "lofty", MLS_SOURCE: "hub" }) === false);

    // Read at call time: one loaded module, the setting flipped between runs.
    const world = makeWorld();
    seedMarket(world);
    const store = makeStore({});
    const f = makeFetch(world);
    setEnv(GRID_ENV);
    freshModules(store, f);
    const sync = require(`${FN_DIR}/sync-listings.js`);
    await sync.handler();
    check("unset: the run read MLS Grid", f.grid() > 0 && world.hubCalls === 0, `${f.grid()} / ${world.hubCalls}`);
    const gridBefore = f.grid();
    Object.assign(process.env, HUB_ENV);
    delete process.env.MLSGRID_API_TOKEN;
    await sync.handler();
    check("then MLS_SOURCE=hub on the same loaded module: the hub, and no MLS Grid request", world.hubCalls > 0 && f.grid() === gridBefore,
      `${world.hubCalls} hub / ${f.grid() - gridBefore} grid`);
    process.env.MLS_SOURCE = "Hub";
    process.env.MLSGRID_API_TOKEN = "grid-test-token";
    const hubBefore = world.hubCalls;
    await sync.handler();
    check("\"Hub\" is not hub: MLS Grid again", f.grid() > gridBefore && world.hubCalls === hubBefore);
  }

  // ---------------------------------------------------------------------------
  for (const hidden of ["deleted", "stub"]) {
    print(`\n2. The same status changes through both paths (the hub ${hidden === "deleted" ? "drops an MlgCanView=false listing and lists it at /v1/mls/deleted" : "answers withheld stubs"})`);
    const { world, gridStore, hubStore } = await bootstrapPair(hidden);
    const steps = [
      ["first hub run after switching (one full snapshot, then incremental)", () => {}],
      ["Coming Soon -> Active (hers)", () => change(world, "K14", { StandardStatus: "Active" })],
      ["Active -> Pending", () => change(world, "K3", { StandardStatus: "Pending" })],
      ["Active -> Active Under Contract", () => change(world, "K9", { StandardStatus: "Active Under Contract" })],
      ["Pending -> Closed", () => change(world, "K15", { StandardStatus: "Closed", MlgCanView: true })],
      ["Pending -> Active (back on market)", () => change(world, "K3", { StandardStatus: "Active" })],
      ["Active -> Expired (MLS Grid marks it MlgCanView=false)", () => change(world, "K4", { StandardStatus: "Expired", MlgCanView: false })],
      ["Active -> Withdrawn (still viewable)", () => change(world, "K10", { StandardStatus: "Withdrawn" })],
      ["Active -> Canceled and gone from the feed (MlgCanView=false)", () => change(world, "K11", { StandardStatus: "Canceled", MlgCanView: false })],
      ["Active -> Hold", () => change(world, "K12", { StandardStatus: "Hold" })],
      ["a price change", () => change(world, "K1", { ListPrice: 512345 })],
      ["a new Active listing, and one of hers going Pending", () => {
        put(world, rec(20, { City: "Windsor", PostalCode: "80550", ListPrice: 777000 }));
        change(world, "K13", { StandardStatus: "Pending" });
      }],
      ["Expired -> Active (relisted, viewable again)", () => change(world, "K4", { StandardStatus: "Active", MlgCanView: true })],
      ["a quiet run (nothing changed)", () => {}],
    ];
    let allGridFree = true;
    for (const [label, act] of steps) {
      act();
      await runSync(gridStore, world, GRID_ENV);
      const h = await runSync(hubStore, world, HUB_ENV);
      if (h.fetch.grid() !== 0) allGridFree = false;
      const a = snapshot(gridStore);
      const b = snapshot(hubStore);
      if (label.startsWith("first hub run")) {
        // The first hub run is a full snapshot, which also holds her Coming Soon
        // listing at once (MLS Grid's bootstrap cannot ask for that status and
        // waits for its next change; see section 3). Everything else is the same.
        check(`${label}: same listings.json, mine-listings.json and town figures, plus her Coming Soon listing`,
          same(a, minus(b, ["IRE1000014"])) && !a.listings.IRE1000014 && b.listings.IRE1000014 &&
          b.listings.IRE1000014.status === "Coming Soon" && b.mine.includes("IRE1000014"), diff(a, minus(b, ["IRE1000014"])));
      } else {
        check(`${label}: same listings.json, mine-listings.json and town figures`, same(a, b), diff(a, b));
      }
      const st = hubStore.data.get("sync-state.json");
      check(`${label}: the hub pass completed and is current`, !st.lastRunError && !st.hubPass && st.lastRunVia === "hub" &&
        Date.now() - Date.parse(st.lastSuccessAt) < 60e3, JSON.stringify(st).slice(0, 300));
    }
    check("not one MLS Grid request on the hub path", allGridFree);
    const fin = snapshot(hubStore);
    check("the copy holds what it should (sanity)", !fin.listings.IRE1000017 && !fin.listings.IRE1000019 && !fin.listings.IRE1000011 &&
      !fin.listings.IRE1000010 && !fin.listings.IRE1000012 && fin.listings.IRE1000004 && fin.listings.IRE1000020 &&
      fin.listings.IRE1000013.status === "Pending" && fin.listings.IRE1000018.waterfront === true && fin.listings.IRE1000018.equestrian === true,
      Object.keys(fin.listings).join(","));
    check("her listings are in mine-listings.json on both", same(fin.mine, ["IRE1000013", "IRE1000014"]), fin.mine.join(","));
    check("town figures: same towns, counts and medians (Windsor fell under 5 Active, so both omit it)",
      !!fin.towns.Loveland && !fin.towns.Windsor && same(fin.towns, snapshot(gridStore).towns), JSON.stringify(fin.towns));
    const hubSt = hubStore.data.get("sync-state.json");
    check("the hub path keeps no MLS Grid resume link once a pass has moved past it", hubSt.cursor === null);
    // Her records are stored whole (not slimmed), so they would show any extra field the hub sends.
    const hers = fin.listings.IRE1000013;
    check("the hub's extra fields (ListOfficeName, ListOfficeMlsId, ...) are not stored: same shape as MLS Grid's",
      hers.officeName === null && hers.officeMlsId === null && !("latitude" in hers) && hers.remarks === "A well kept home.", JSON.stringify(hers));
  }

  // ---------------------------------------------------------------------------
  print("\n3. Bootstrap from nothing, and the snapshot rules");
  {
    // A market with no Coming Soon: an MLS Grid bootstrap and a hub snapshot agree exactly.
    const world = makeWorld();
    for (let n = 1; n <= 9; n++) put(world, rec(n, n % 3 === 0 ? { StandardStatus: "Pending" } : {}));
    put(world, rec(10, { StandardStatus: "Closed" }));
    put(world, rec(11, { ListAgentFullName: "Christine Gwinnup" }));
    const g = makeStore({});
    const h = makeStore({});
    await runSync(g, world, GRID_ENV);
    const r = await runSync(h, world, HUB_ENV);
    check("a snapshot from nothing equals an MLS Grid bootstrap", same(snapshot(g), snapshot(h)), diff(snapshot(g), snapshot(h)));
    const st = h.data.get("sync-state.json");
    check("...read in pages (4 a page here) and marked current only at the end", st.bootstrapped === true && !!st.lastSuccessAt &&
      world.hubLog.filter((l) => /search/.test(l)).length === 3 && r.res.statusCode === 200, world.hubLog.join(" | "));
    check("...asking only for the stored statuses", world.hubLog.every((l) => !/search/.test(l)) ||
      /statuses/.test(JSON.stringify(r.fetch.calls.find((c) => /search/.test(c.url)).init.body)));
    check("...and its checkpoint is wound back an hour before the hub's own last pass, so changes during it are re-read",
      Date.parse(st.lastModified) <= Date.now() - 60 * 60e3, st.lastModified);
    check("the snapshot's working list is cleaned up", !h.data.has("hub-snapshot-seen.json"));

    // Coming Soon: an MLS Grid bootstrap cannot ask for it (unproven $filter value);
    // the hub can, so the hub's snapshot has it from the start.
    put(world, rec(12, { StandardStatus: "Coming Soon", ListAgentFullName: "Christine Gwinnup" }));
    const g2 = makeStore({});
    const h2 = makeStore({});
    await runSync(g2, world, GRID_ENV);
    await runSync(h2, world, HUB_ENV);
    check("a Coming Soon listing is in the hub snapshot at once (MLS Grid's bootstrap waits for its next change)",
      !!snapshot(h2).listings.IRE1000012 && !snapshot(g2).listings.IRE1000012);
    await runSync(g2, world, GRID_ENV);
    check("...and once MLS Grid's incremental runs, the two agree", same(snapshot(g2), snapshot(h2)), diff(snapshot(g2), snapshot(h2)));

    // The deletion list no longer reaches back far enough: a full re-read, and
    // whatever it did not return is removed.
    const stale = copyOf(h2);
    const listings = stale.data.get("listings.json");
    listings.IRE1999999 = { ...listings.IRE1000001, listingId: "IRE1999999", listingKey: "K999999" };
    stale.data.set("listings.json", listings);
    world.deletedComplete = false;
    const before = world.hubCalls;
    await runSync(stale, world, HUB_ENV);
    world.deletedComplete = true;
    const s3 = stale.data.get("sync-state.json");
    check("an incomplete deletion list turns into a full re-read in the same run", world.hubLog.slice(before - world.hubCalls).some((l) => /deleted/.test(l)) &&
      !snapshot(stale).listings.IRE1999999 && !s3.lastRunError && !!s3.lastSuccessAt, JSON.stringify(s3).slice(0, 300));
    check("...after which the copy equals the truth", same(snapshot(stale), snapshot(h2)), diff(snapshot(stale), snapshot(h2)));

    // The first hub run after the MLS Grid crawl (2026-10-23): that copy can hold
    // listings MLS Grid no longer serves (a removal missed while the crawl was
    // paused). The first hub run reads one full snapshot and drops them; the
    // runs after it are incremental again.
    {
      const pair = await bootstrapPair("deleted");
      const listingsG = pair.hubStore.data.get("listings.json");
      listingsG.IRE1888888 = { ...listingsG.IRE1000001, listingId: "IRE1888888", listingKey: "K888888" };
      pair.hubStore.data.set("listings.json", listingsG);
      check("(set-up) the MLS Grid copy holds a listing the market no longer has, and no hub check yet",
        !!pair.hubStore.data.get("listings.json").IRE1888888 && !pair.hubStore.data.get("sync-state.json").hubReconciledAt);
      pair.world.hubLog = [];
      const first = await runSync(pair.hubStore, pair.world, HUB_ENV);
      const s6 = pair.hubStore.data.get("sync-state.json");
      const firstSearch = first.fetch.calls.find((c) => /\/v1\/mls\/search/.test(c.url));
      check("the first hub run reads a full snapshot (stored statuses, no checkpoint)", !!firstSearch &&
        /statuses/.test(firstSearch.init.body) && !/modified_since/.test(firstSearch.init.body), firstSearch && firstSearch.init.body);
      check("...drops the listing the hub does not have, is current, and records the check",
        !pair.hubStore.data.get("listings.json").IRE1888888 && !s6.lastRunError && !!s6.lastSuccessAt && !!s6.hubReconciledAt,
        JSON.stringify(s6).slice(0, 300));
      await runSync(pair.gridStore, pair.world, GRID_ENV);
      const gridNow = snapshot(pair.gridStore);
      const hubNow = snapshot(pair.hubStore);
      check("...and leaves the MLS Grid crawl's copy, minus that listing, plus her Coming Soon listing",
        same(gridNow, minus(hubNow, ["IRE1000014"])) && !!hubNow.listings.IRE1000014, diff(gridNow, minus(hubNow, ["IRE1000014"])));
      change(pair.world, "K5", { StandardStatus: "Pending" });
      const second = await runSync(pair.hubStore, pair.world, HUB_ENV);
      const secondSearch = second.fetch.calls.find((c) => /\/v1\/mls\/search/.test(c.url));
      const s7 = pair.hubStore.data.get("sync-state.json");
      check("the next hub run is incremental (deletion list, then changes since the checkpoint)",
        second.fetch.calls.some((c) => /\/v1\/mls\/deleted/.test(c.url)) && !!secondSearch && /modified_since/.test(secondSearch.init.body) &&
        pair.hubStore.data.get("listings.json").IRE1000005.status === "Pending" && s7.hubReconciledAt === s6.hubReconciledAt,
        secondSearch && secondSearch.init.body);
    }

    // A short or empty full read is not a market: nothing removed, not current.
    const short = copyOf(h2);
    const shortState = short.data.get("sync-state.json");
    short.data.set("sync-state.json", { ...shortState, bootstrapped: false });
    const thin = makeWorld();
    put(thin, rec(1));
    const keptBefore = JSON.stringify(short.data.get("listings.json"));
    await runSync(short, thin, HUB_ENV);
    const s4 = short.data.get("sync-state.json");
    check("a full read returning far fewer than are stored removes nothing", JSON.parse(keptBefore).IRE1000005 &&
      !!short.data.get("listings.json").IRE1000005, Object.keys(short.data.get("listings.json")).join(","));
    check("...is not marked current, and says why", s4.lastSuccessAt === shortState.lastSuccessAt && /too few to be the whole market/.test(s4.lastRunError), s4.lastRunError);
    const empty = makeStore({ "sync-state.json": { bootstrapped: false } });
    await runSync(empty, makeWorld(), HUB_ENV);
    const s5 = empty.data.get("sync-state.json");
    check("a full read returning nothing at all is a failure, never 'zero listings'", !s5.lastSuccessAt && /returned 0 listing/.test(s5.lastRunError), s5.lastRunError);
  }

  // ---------------------------------------------------------------------------
  print("\n4. Every hub failure fails closed");
  {
    const { world, hubStore } = await bootstrapPair("deleted");
    await runSync(hubStore, world, HUB_ENV);                // a good hub run first
    change(world, "K5", { StandardStatus: "Pending" });     // a change waiting to be read
    change(world, "K6", { StandardStatus: "Expired", MlgCanView: false });
    const good = hubStore.data.get("sync-state.json");
    const modes = [
      ["not configured", { MLS_SOURCE: "hub" }, null, /HUB_API_URL and HUB_API_KEY are not set/],
      ["a key that is not a hub key", { MLS_SOURCE: "hub", HUB_API_URL: HUB_URL, HUB_API_KEY: "sk_live_x" }, null, /hub key/],
      ["unreachable", HUB_ENV, { mode: "down" }, /did not answer/],
      ["not JSON", HUB_ENV, { mode: "html" }, /not JSON/],
      ["503 not_ready", HUB_ENV, { mode: "not_ready" }, /not ready: catching_up/],
      ["200 but the copy not ready", HUB_ENV, { mode: "ready_false" }, /not ready/],
      ["503 reads switched off", HUB_ENV, { mode: "off" }, /refused .*503/],
      ["500", HUB_ENV, { mode: "500" }, /refused .*500/],
      ["a deletion with no ListingKey", HUB_ENV, { mode: "bad_row" }, /without a ListingKey/],
      ["a malformed cursor", HUB_ENV, { mode: "bad_next" }, /malformed/],
      ["the deletions read, then the search fails", HUB_ENV, { mode: "down", onCall: "second" }, /did not answer/, true],
      ["the deletions read, then a listing row with no ListingKey", HUB_ENV, { mode: "bad_row", onCall: "second" }, /without a ListingKey/, true],
      ["the deletions read, then a page that is not ready", HUB_ENV, { mode: "not_ready", onCall: "second" }, /not ready/, true],
    ];
    for (const [label, env, fail, why, appliedDeletion] of modes) {
      const store = copyOf(hubStore);
      const listingsBefore = JSON.stringify(store.data.get("listings.json"));
      const mineBefore = JSON.stringify(store.data.get("mine-listings.json"));
      world.hubCalls = 0;
      world.hubFail = fail && fail.onCall === "second" ? { mode: fail.mode, onCall: 2 } : fail;
      const { res, fetch: f } = await runSync(store, world, env);
      world.hubFail = null;
      const st = store.data.get("sync-state.json");
      check(`${label}: listings ${appliedDeletion ? "only lose what the deletion list said" : "untouched"}`,
        appliedDeletion ? !store.data.get("listings.json").IRE1000006 && store.data.get("listings.json").IRE1000005.status === "Active"
          : JSON.stringify(store.data.get("listings.json")) === listingsBefore && JSON.stringify(store.data.get("mine-listings.json")) === mineBefore);
      check(`${label}: checkpoint and lastSuccessAt held, the reason recorded`, st.lastModified === good.lastModified &&
        st.lastSuccessAt === good.lastSuccessAt && why.test(String(st.lastRunError)), `${st.lastRunError}`);
      check(`${label}: no MLS Grid request, and the run still answers`, f.grid() === 0 && res.statusCode === 200);
      // The next good run picks everything up.
      await runSync(store, world, HUB_ENV);
      const after = store.data.get("listings.json");
      const st2 = store.data.get("sync-state.json");
      check(`${label}: the next good run catches up`, after.IRE1000005.status === "Pending" && !after.IRE1000006 && !st2.lastRunError &&
        st2.lastSuccessAt !== good.lastSuccessAt, String(st2.lastRunError));
    }

    // Missing the mls:agents scope: her listings could no longer be told apart.
    const store = copyOf(hubStore);
    const before = JSON.stringify(store.data.get("mine-listings.json"));
    world.agents = false;
    await runSync(store, world, HUB_ENV);
    world.agents = true;
    const st = store.data.get("sync-state.json");
    check("a key without mls:agents: nothing applied, her listings kept, the scope named",
      JSON.stringify(store.data.get("mine-listings.json")) === before && /mls:agents/.test(st.lastRunError) && st.lastSuccessAt === good.lastSuccessAt, st.lastRunError);

    // Out of time before the first page: nothing read, resumes next run.
    const late = copyOf(hubStore);
    setEnv(HUB_ENV);
    freshModules(late, makeFetch(world));
    world.hubCalls = 0;
    const r = await require(`${FN_DIR}/sync-listings.js`).hubMarketDataRun({ startedAt: Date.now() - 60e3, log: () => {} });
    const sl = late.data.get("sync-state.json");
    check("out of time: no hub request, paused, not current", world.hubCalls === 0 && /paused/.test(r.body) && sl.lastSuccessAt === good.lastSuccessAt && !!sl.hubPass);
    await runSync(late, world, HUB_ENV);
    check("...and the next run finishes that pass", !late.data.get("sync-state.json").hubPass && late.data.get("listings.json").IRE1000005.status === "Pending");
  }

  // ---------------------------------------------------------------------------
  print("\n5. The on-market check: same verdicts from MLS Grid and from the hub");
  for (const hidden of ["deleted", "stub"]) {
    const world = makeWorld(hidden);
    seedMarket(world);
    change(world, "K4", { StandardStatus: "Expired", MlgCanView: false });
    change(world, "K5", { StandardStatus: "Closed" });
    change(world, "K6", { StandardStatus: "Withdrawn" });
    const cases = [
      ["IRE1000001", "2026-01-10", "Active"], ["IRE1000015", "2026-01-10", "Pending"], ["IRE1000016", "2026-01-10", "Active Under Contract"],
      ["IRE1000014", "2026-01-10", "Coming Soon"], ["IRE1000004", "2025-09-10", "Expired, MlgCanView=false"],
      ["IRE1000005", "2025-09-10", "Closed"], ["IRE1000006", "2025-09-10", "Withdrawn"],
      ["IRE1000099", "2025-01-15", "not in the feed, listed long ago"],
      ["IRE1000098", new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10), "not in the feed, listed two days ago"],
      ["1000001", "2026-01-10", "asked without the IRE prefix"],
    ];
    for (const [id, listDate, label] of cases) {
      const answers = {};
      for (const [mode, env] of [["grid", GRID_ENV], ["hub", HUB_ENV]]) {
        setEnv(env);
        const f = makeFetch(world);
        freshModules(makeStore({}), f);
        const S = require(`${FN_DIR}/sync-listings.js`);
        const confirm = S.makeOnMarketConfirmer({ store: makeStore({}), token: process.env.MLSGRID_API_TOKEN, log: () => {}, sleepImpl: async () => {} });
        answers[mode] = await confirm({ listingId: id, listDate });
        answers[mode + "Grid"] = f.grid();
      }
      // Lofty's IRES ids always carry the prefix, so this never arises in practice;
      // pinned because the two differ: MLS Grid's exact ListingId filter finds no
      // record ("off the market"), the hub matches either form and finds it.
      if (id === "1000001") {
        check(`${hidden}: ${label}: the hub finds the listing (MLS Grid's exact filter does not)`,
          answers.hub.onMarket === true && answers.grid.onMarket === false, `${JSON.stringify(answers.grid)} / ${JSON.stringify(answers.hub)}`);
        continue;
      }
      check(`${hidden}: ${label}: same verdict (${answers.grid.onMarket})`, answers.grid.onMarket === answers.hub.onMarket,
        `${JSON.stringify(answers.grid)} / ${JSON.stringify(answers.hub)}`);
      check(`${hidden}: ${label}: the hub check made no MLS Grid request`, answers.hubGrid === 0);
    }
    // Her listing already in the copy: on the market without a request, either way.
    setEnv(HUB_ENV);
    const f = makeFetch(world);
    freshModules(makeStore({}), f);
    const S = require(`${FN_DIR}/sync-listings.js`);
    world.hubCalls = 0;
    const c = S.makeOnMarketConfirmer({ store: makeStore({ "mine-listings.json": [{ listingId: "IRE1000013" }] }), log: () => {} });
    const v = await c({ listingId: "IRE1000013", listDate: "2026-01-01" });
    check(`${hidden}: in the copy: on the market, no hub request`, v.onMarket === true && world.hubCalls === 0);
  }
  {
    // Every hub failure is "unknown" -- the listing is kept, and nothing is saved.
    const world = makeWorld();
    seedMarket(world);
    for (const [label, env, fail] of [["not configured", { MLS_SOURCE: "hub" }, null], ["unreachable", HUB_ENV, { mode: "down" }],
      ["not ready", HUB_ENV, { mode: "not_ready" }], ["ready false", HUB_ENV, { mode: "ready_false" }], ["500", HUB_ENV, { mode: "500" }],
      ["not JSON", HUB_ENV, { mode: "html" }], ["switched off", HUB_ENV, { mode: "off" }]]) {
      setEnv(env);
      const f = makeFetch(world);
      freshModules(makeStore({}), f);
      const store = makeStore({});
      world.hubFail = fail;
      const logs = [];
      const c = require(`${FN_DIR}/sync-listings.js`).makeOnMarketConfirmer({ store, log: (m) => logs.push(m), sleepImpl: async () => {} });
      const v = await c({ listingId: "IRE1000004", listDate: "2025-01-01" });
      world.hubFail = null;
      check(`check, ${label}: unknown, kept, nothing saved, no MLS Grid request`, v.onMarket === null && !store.data.has("lofty-mls-verdicts.json") &&
        f.grid() === 0 && logs.some((m) => /could not confirm IRE1000004/.test(m)), JSON.stringify(v));
    }
  }

  // ---------------------------------------------------------------------------
  print("\n6. The whole 30-minute run in hub mode: her Lofty listings, the check and the copy, zero MLS Grid");
  {
    const { world, hubStore } = await bootstrapPair("deleted");
    world.loftyMine = [
      { mlsListingId: "IRE1000013", mlsOrgId: 1054, id: 13, listingStatus: "Active", price: 1250000, bedrooms: 3, bathrooms: 2, sqft: 2300,
        streetAddress: "113 Elm St", city: "Loveland", state: "CO", zipCode: "80537", propertyType: "Single Family Home",
        agentName: "Christine Gwinnup", previewPicture: LOFTY_COVER("IRE1000013"), mlsListDateLSort: 1787356800 },
      { mlsListingId: "IRE1000004", mlsOrgId: 1054, id: 4, listingStatus: "Active", price: 600000, bedrooms: 3, bathrooms: 2, sqft: 2000,
        streetAddress: "104 Elm St", city: "Loveland", state: "CO", zipCode: "80537", propertyType: "Single Family Home",
        agentName: "Christine Gwinnup", previewPicture: LOFTY_COVER("IRE1000004"), mlsListDateLSort: 1757356800 },
    ];
    change(world, "K4", { StandardStatus: "Expired", MlgCanView: false });
    const { res, fetch: f } = await runSync(hubStore, world, { ...HUB_ENV, LOFTY_API_KEY: "test-key" });
    const st = hubStore.data.get("lofty-sync-state.json") || {};
    check("the run answers ok", res.statusCode === 200 && res.body === "ok", JSON.stringify(res));
    check("her Lofty listings refreshed first, with the MLS check on (through the hub)", st.mlsCheck === "checked" &&
      Object.keys(hubStore.data.get("lofty-listings.json") || {}).join() === "IRE1000013", JSON.stringify(st).slice(0, 300));
    check("the expired one Lofty still calls Active is hidden, and named", (st.hiddenOffMarket || []).some((h) => h.listingId === "IRE1000004"),
      JSON.stringify(st.hiddenOffMarket));
    check("the market-data copy was read from the hub too", hubStore.data.get("sync-state.json").lastRunVia === "hub" && !hubStore.data.get("listings.json").IRE1000004);
    check("and not one request went to MLS Grid", f.grid() === 0, f.calls.filter((c) => c.host.includes("mlsgrid")).map((c) => c.url).join(" "));
    check("the hub key travelled only in the header, never in a URL", f.calls.filter((c) => c.host === "hub.test")
      .every((c) => !c.url.includes(HUB_KEY) && c.init.headers["x-hub-key"] === HUB_KEY && c.init.redirect === "error"));
  }

  // ---------------------------------------------------------------------------
  print("\n7. Cadence: every 15 minutes through the hub, MLS Grid's volume unchanged");
  {
    const toml = fs.readFileSync(`${ROOT}/netlify.toml`, "utf8");
    const cron = (name) => ((toml.slice(toml.indexOf(`[functions."${name}"]`)).match(/schedule\s*=\s*"([^"]+)"/) || [])[1]);
    check("sync-listings still runs every 30 minutes (:00, :30)", cron("sync-listings") === "*/30 * * * *", cron("sync-listings"));
    check("mls-hub-sync runs in between (:15, :45)", cron("mls-hub-sync") === "15,45 * * * *", cron("mls-hub-sync"));
    const minutes = new Set();
    for (let m = 0; m < 60; m += 30) minutes.add(m);
    for (const m of cron("mls-hub-sync").split(" ")[0].split(",")) minutes.add(Number(m));
    const sorted = [...minutes].sort((a, b) => a - b);
    const gaps = sorted.map((m, i) => ((sorted[(i + 1) % sorted.length] - m + 60) % 60) || 60);
    const health = fs.readFileSync(`${FN_DIR}/site-health.js`, "utf8");
    const declared = Number((health.match(/const HUB_SYNC_INTERVAL_MINUTES\s*=\s*(\d+)/) || [])[1]);
    check("together: a hub read every 15 minutes, matching /site-health", gaps.every((g) => g === 15) && declared === 15, `${gaps} / ${declared}`);
    check("the hub row's lateness is derived from it", /const HUB_SYNC_LATE_AFTER_MINUTES\s*=\s*HUB_SYNC_INTERVAL_MINUTES\s*[*+]/.test(health));

    const world = makeWorld();
    seedMarket(world);
    for (const env of [{}, GRID_ENV, { ...GRID_ENV, MLS_SOURCE: "mlsgrid" }, { ...GRID_ENV, MLS_SOURCE: "Hub" }, { ...GRID_ENV, LOFTY_API_KEY: "k" }]) {
      setEnv(env);
      const f = makeFetch(world);
      const store = makeStore({});
      freshModules(store, f);
      const r = await require(`${FN_DIR}/mls-hub-sync.js`).handler();
      check(`mls-hub-sync with ${JSON.stringify(env)}: nothing at all (no request, no write)`, f.calls.length === 0 && store.data.size === 0 && /not hub/.test(r.body));
    }
    setEnv({ ...HUB_ENV, LOFTY_API_KEY: "k" });
    const f = makeFetch(world);
    const store = makeStore({});
    freshModules(store, f);
    const r = await require(`${FN_DIR}/mls-hub-sync.js`).handler();
    check("mls-hub-sync with MLS_SOURCE=hub reads the hub copy", r.statusCode === 200 && r.body === "ok" &&
      store.data.get("sync-state.json").lastRunVia === "hub", r.body);
    check("...and never calls Lofty or MLS Grid", f.calls.every((c) => c.host === "hub.test"), f.calls.map((c) => c.host).join(","));
    setEnv({ ...HUB_ENV, MLSGRID_MARKET_DATA: "off" });
    const f2 = makeFetch(world);
    freshModules(makeStore({}), f2);
    const r2 = await require(`${FN_DIR}/mls-hub-sync.js`).handler();
    check("...and MLSGRID_MARKET_DATA=off stops it", f2.calls.length === 0 && /switched off/.test(r2.body));
  }

  // ---------------------------------------------------------------------------
  print("\n8. /site-health in hub mode reads the stored state only");
  {
    const { world, hubStore } = await bootstrapPair("deleted");
    await runSync(hubStore, world, HUB_ENV);
    const rowOf = async (store, env) => {
      setEnv(env);
      const f = makeFetch(world);
      freshModules(store, f);
      const before = world.hubCalls;
      const out = JSON.parse((await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: { format: "json" } })).body);
      return { row: out.checks.find((c) => /Market data from the hub/.test(c.name)) || {}, hubCalls: world.hubCalls - before, f };
    };
    let { row, hubCalls, f } = await rowOf(hubStore, HUB_ENV);
    check("a good hub run: the hub row is green and says no MLS Grid request is made", row.ok === true && row.optional === true &&
      /no MLS Grid request is made/.test(row.detail) && /every 15 minutes/.test(row.detail), row.detail);
    check("...and the page load itself asked nobody", hubCalls === 0 && f.calls.length === 0, f.calls.map((c) => c.url).join(" "));
    world.hubFail = { mode: "not_ready" };
    await runSync(hubStore, world, HUB_ENV);
    world.hubFail = null;
    ({ row } = await rowOf(hubStore, HUB_ENV));
    check("a failed hub run: red, with the reason", row.ok === false && /not ready/.test(row.detail), row.detail);
    ({ row } = await rowOf(hubStore, { MLS_SOURCE: "hub" }));
    check("hub not set up: red, naming the settings", row.ok === false && /HUB_API_URL and HUB_API_KEY are not set/.test(row.detail), row.detail);
  }

  // ---------------------------------------------------------------------------
  print("\n9. LISTINGS_SOURCE=mlsgrid with MLS_SOURCE=hub is refused, fail closed");
  {
    const world = makeWorld();
    seedMarket(world);
    const FRESH = { bootstrapped: true, lastRunAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastModified: tick() };
    const store = makeStore({ "sync-state.json": FRESH, "listings.json": { IRE1000013: { listingId: "IRE1000013", status: "Active",
      agentName: "Christine Gwinnup", city: "Loveland", price: 1250000 } }, "mine-listings.json": [{ listingId: "IRE1000013", status: "Active", agentName: "Christine Gwinnup" }] });
    const env = { ...HUB_ENV, ...GRID_ENV, LISTINGS_SOURCE: "mlsgrid", IDX_DISPLAY: "on" };
    setEnv(env);
    const f = makeFetch(world);
    freshModules(store, f);
    const lib = require(`${FN_DIR}/lib/_idx-display.js`);
    const gate = lib.idxGate({ state: FRESH });
    check("the display gate holds every listing back", gate.allowed === false && gate.reason === "mls_source_hub");
    check("...the photo proxy's switch-only gate too", lib.idxGate({ skipFreshness: true }).reason === "mls_source_hub");
    check("...while Lofty with MLS_SOURCE=hub is unaffected", lib.idxGate({ env: { IDX_DISPLAY: "on", MLS_SOURCE: "hub" }, state: FRESH }).allowed === true);
    const res = await require(`${FN_DIR}/sync-listings.js`).handler();
    const st = store.data.get("sync-state.json");
    check("the sync is refused: no request anywhere", /^refused/.test(res.body) && f.calls.length === 0, f.calls.map((c) => c.url).join(" "));
    check("...the reason is recorded, lastSuccessAt left to age", /cannot serve LISTINGS_SOURCE=mlsgrid/.test(st.lastRunError) && st.lastSuccessAt === FRESH.lastSuccessAt);
    const hs = await require(`${FN_DIR}/mls-hub-sync.js`).handler();
    check("mls-hub-sync refuses it the same way", /^refused/.test(hs.body) && f.calls.length === 0);
    const search = JSON.parse((await require(`${FN_DIR}/listings-search.js`).handler({ queryStringParameters: { mine: "true" } })).body);
    check("the search answers 'unavailable', no listings", search.idxUnavailable === true && search.reason === "mls_source_hub" && search.listings.length === 0);
    const photo = await require(`${FN_DIR}/listing-photo.js`).handler({ queryStringParameters: { id: "IRE1000013" } });
    check("a photo request gets a placeholder, and no MLS Grid request", photo.headers["X-Photo-Fallback"] === "mls_source_hub" && f.calls.length === 0);
    const backfill = await require(`${FN_DIR}/photo-backfill-background.js`).handler({});
    check("the overnight photo walk stands down", backfill.statusCode === 200 && f.calls.length === 0);
    const page = await require(`${FN_DIR}/listing-page.js`).handler({ queryStringParameters: { id: "IRE1000013" } });
    check("a listing page is a temporary 503 (noindex), not the listing", page.statusCode === 503 && page.headers["X-Robots-Tag"] === "noindex");
    const health = JSON.parse((await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: { format: "json", probe: "1" } })).body);
    const refusal = health.checks.find((c) => c.name === "MLS source setting") || {};
    check("/site-health leads with a red 'MLS source setting' row", refusal.ok === false && /LISTINGS_SOURCE=lofty/.test(refusal.detail), refusal.detail);
    const shown = health.checks.find((c) => /Listings shown on the website/.test(c.name)) || {};
    check("...says the listings are held back and why", shown.ok === false && /Held back — MLS_SOURCE=hub/.test(shown.detail), shown.detail);
    const photos = health.checks.find((c) => c.name === "Listing photos load end to end") || {};
    // 2026-10-23: ?probe=1 also runs the hub key check (one GET /v1/health to the hub); that is the only call allowed.
    const notHubKeyCheck = f.calls.filter((c) => !/\/v1\/health$/.test(new URL(c.url).pathname));
    check("...and even ?probe=1 makes no MLS Grid photo request", /Not tested/.test(photos.detail) && notHubKeyCheck.length === 0, photos.detail + " " + notHubKeyCheck.map((c) => c.url).join(" "));
  }

  setEnv({});
  Object.assign(console, realConsole);
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { Object.assign(console, realConsole); console.error(e); process.exit(1); });
