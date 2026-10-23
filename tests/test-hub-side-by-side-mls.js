// The side-by-side check with the hub, the scheduled MLS sync's half (2026-10-23; area mls_read,
// lib/_hub-side-by-side.js mlsSideBySide, docs/hub-side-by-side.md). With HUB_SIDE_BY_SIDE listing mls_read and the
// site reading MLS Grid itself, the 30-minute sync (sync-listings.js) ALSO asks the hub's copy, once, after its own
// work, for her Lofty listings' on-market verdicts and a sample of the stored MLS Grid copy, and compares field by
// field. This pins:
//
//   1. off (unset, another area, MLS_SOURCE=hub): no hub call from the check, the run byte-identical;
//   2. on: the run's own MLS Grid and Lofty requests and every blob it writes are exactly what they are off, with
//      the hub agreeing, differing and failing in every way, and with the ledger post failing;
//   3. the hub agreeing (rows built by the hub's own reference function): `same` rows, listing and on_market;
//   4. a price that differs, a listing the hub lacks, a withheld stub, a copy behind or ahead: the right field names
//      or reasons, never a value;
//   5. every hub failure: not_compared with the matching reason; the cap; too little time left = skipped.
//
// Nothing here touches the network: MLS Grid, Lofty and the hub are fakes.
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
const { hubRowFromMlsGrid } = require("./_hub-mls-reference");

const print = (s) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (l, c, x) => { if (c) print(`  ok   ${l}`); else { failures++; print(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const HUB_URL = "https://hub.test/functions/v1/hub-api";
const HUB_KEY = "hub_" + "ab".repeat(32);
const DAY = 24 * 3600e3;

function makeStore(initial) {
  const data = new Map(Object.entries(initial || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return {
    data,
    get: async (k) => (data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null),
    setJSON: async (k, v) => { data.set(k, JSON.parse(JSON.stringify(v))); },
    set: async (k, v) => { data.set(k, v); },
    delete: async (k) => { data.delete(k); },
    list: async (opts) => ({ blobs: [...data.keys()].filter((k) => k.startsWith((opts && opts.prefix) || "")).map((key) => ({ key })) }),
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
    ListOfficeMlsId: "IRE999", ListOfficeKey: "OK9", PhotosCount: 12, ModificationTimestamp: tick(), ...over,
  };
}
function makeWorld() {
  return { records: new Map(), hubFail: null, recordFail: null, hubEdit: null, hubCalls: [], rows: [] };
}
function put(world, r) { r.ModificationTimestamp = tick(); world.records.set(r.ListingKey, r); }
function seedMarket(world) {
  for (let n = 1; n <= 8; n++) put(world, rec(n));
  put(world, rec(13, { ListAgentFullName: "Christine Gwinnup", ListPrice: 1250000 }));
  put(world, rec(14, { CoListAgentFullName: "Christine Gwinnup", StandardStatus: "Coming Soon" }));
  put(world, rec(18, { PublicRemarks: "Riverfront acreage with a loafing shed and riding arena." }));
}

function reply(status, json) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json), json: async () => json, headers: { get: () => "application/json" } };
}
function mlsGridAnswer(world, u) {
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
async function hubAnswer(world, u, init) {
  const sub = u.pathname.replace("/functions/v1/hub-api", "");
  world.hubCalls.push(`${init.method} ${sub}`);
  if (init.headers["x-hub-key"] !== HUB_KEY) return reply(401, { error: "unknown key" });
  if (init.redirect !== "error") return reply(500, { error: "redirects must be refused" });
  const body = init.body ? JSON.parse(init.body) : {};
  if (sub === "/v1/parity/record") {
    if (world.recordFail === "down") throw new TypeError("fetch failed");
    if (world.recordFail) return reply(503, { status: "off", error: "the side-by-side check is switched off" });
    world.rows.push(...body.rows);
    return reply(200, { status: "ok", recorded: body.rows.length });
  }
  if (init.method === "POST" && sub === "/v1/mls/search") {
    const f = world.hubFail;
    if (f === "down") throw new TypeError("connect ECONNREFUSED");
    if (f === "html") return { ok: true, status: 200, text: async () => "<html>gateway</html>", headers: { get: () => "text/html" } };
    if (f === "not_ready") return reply(503, { status: "not_ready", copy: { ready: false, reason: "catching_up" } });
    if (f === "ready_false") return reply(200, { status: "ok", copy: { ready: false, reason: "stale" }, rows: [], next: null });
    if (f === "500") return reply(500, { error: "internal" });
    if (f === "403") return reply(403, { error: "this key may not read the MLS copy" });
    if (f === "off") return reply(503, { error: "mls_reads_enabled is off" });
    let rows = [...world.records.values()].filter((r) => (body.listing_ids || []).some((id) => normId(id) === normId(r.ListingId)))
      .map((r) => hubRowFromMlsGrid(r, { agents: true, officeName: "Another Office" }));
    if (world.hubEdit) rows = world.hubEdit(rows);
    return reply(200, { status: "ok", copy: COPY(), rows, next: null });
  }
  return reply(404, { error: "no such route" });
}
function loftyAnswer(world, u, init) {
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
  const own = [];
  const f = async (url, init) => {
    const u = new URL(String(url));
    const i = init || {};
    if (u.host === "hub.test") return hubAnswer(world, u, i);
    own.push(`${i.method || "GET"} ${String(url)} ${typeof i.body === "string" ? i.body : ""}`);
    if (u.host === "api.mlsgrid.com") return mlsGridAnswer(world, u);
    if (u.host === "api.lofty.com") return loftyAnswer(world, u, i);
    if (u.host === "img.chime.me") return { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => new ArrayBuffer(30000) };
    throw new Error(`unexpected host ${u.host}`);
  };
  f.own = own;
  return f;
}
function freshModules(store, fetchImpl) {
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => store } };
  for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  global.fetch = fetchImpl;
}
const SETTINGS = ["MLS_SOURCE", "HUB_API_URL", "HUB_API_KEY", "MLSGRID_API_TOKEN", "MLSGRID_MARKET_DATA", "MLS_DISABLED",
  "LISTINGS_SOURCE", "LOFTY_API_KEY", "IDX_DISPLAY", "OPERATING_COUNTIES", "HUB_SIDE_BY_SIDE", "HUB_SIDE_BY_SIDE_MAX"];
function setEnv(vars) {
  for (const k of SETTINGS) delete process.env[k];
  Object.assign(process.env, vars || {});
}
const GRID_ENV = { MLSGRID_API_TOKEN: "grid-test-token", LOFTY_API_KEY: "lofty-test-key", HUB_API_URL: HUB_URL, HUB_API_KEY: HUB_KEY };
const ON = { ...GRID_ENV, HUB_SIDE_BY_SIDE: "mls_read" };

const lines = [];
async function runSync(store, world, env) {
  setEnv(env);
  const f = makeFetch(world);
  freshModules(store, f);
  world.hubCalls = []; world.rows = [];
  const keep = [console.log, console.warn, console.error];
  const start = lines.length;
  console.log = console.warn = console.error = (...a) => lines.push(a.map(String).join(" "));
  let res;
  try { res = await require(`${FN_DIR}/sync-listings.js`).handler(); } finally { [console.log, console.warn, console.error] = keep; }
  return { res, own: f.own.slice(), hub: world.hubCalls.slice(), rows: world.rows.slice(), log: lines.slice(start), fetchSame: global.fetch === f };
}
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
// Timestamps and measured durations differ from run to run whatever the check does (two runs with it off differ too).
const blobs = (store) => JSON.stringify([...store.data.keys()].sort().map((k) => [k, store.data.get(k)])).replace(ISO_RE, "TS")
  .replace(/"(\w*DurationMs)":\d+/g, '"$1":0');
const ownSame = (a, b, sa, sb) => {
  const ok = JSON.stringify(a.res) === JSON.stringify(b.res) && a.own.join("\n").replace(ISO_RE, "TS") === b.own.join("\n").replace(ISO_RE, "TS") && blobs(sa) === blobs(sb);
  return ok;
};
const PRIVATE = ["Elm", "Loveland", "Christine", "Gwinnup", "IRE1000", "Mariana", "Riverfront", "1250000"];
const leaks = (t) => PRIVATE.filter((p) => t.includes(p));

(async () => {
  // A copy bootstrapped by two MLS Grid runs with the check off; her two Lofty listings (one in her MLS copy,
  // one the confirmer has to look up).
  const world = makeWorld();
  seedMarket(world);
  world.loftyMine = [
    { mlsListingId: "IRE1000013", mlsOrgId: 1054, id: 13, listingStatus: "Active", price: 1250000, bedrooms: 3, bathrooms: 2, sqft: 2300,
      streetAddress: "113 Elm St", city: "Loveland", state: "CO", zipCode: "80537", propertyType: "Single Family Home", agentName: "Christine Gwinnup", mlsListDateLSort: 1757356800 },
    { mlsListingId: "IRE1000004", mlsOrgId: 1054, id: 4, listingStatus: "Active", price: 600000, bedrooms: 3, bathrooms: 2, sqft: 2000,
      streetAddress: "104 Elm St", city: "Loveland", state: "CO", zipCode: "80537", propertyType: "Single Family Home", agentName: "Christine Gwinnup", mlsListDateLSort: 1757356800 },
  ];
  const seed = makeStore({});
  await runSync(seed, world, GRID_ENV);
  await runSync(seed, world, GRID_ENV);
  check("the fixture: a stored MLS Grid copy with her listings", Object.keys(seed.data.get("listings.json") || {}).length >= 9 &&
    (seed.data.get("mine-listings.json") || []).length >= 1, `${Object.keys(seed.data.get("listings.json") || {}).length} / ${(seed.data.get("mine-listings.json") || []).length}`);

  // ---------------------------------------------------------------------------
  print("\n1. Off: no hub call from the check, the run byte-identical");
  const offStore = copyOf(seed);
  const off = await runSync(offStore, world, GRID_ENV);
  check("switch unset: the run made no hub call at all", off.hub.length === 0 && off.rows.length === 0, off.hub.join(", "));
  for (const v of ["lofty_write", "rentcast,lofty_read", "MLS-READ"]) {
    const s = copyOf(seed);
    const r = await runSync(s, world, { ...GRID_ENV, HUB_SIDE_BY_SIDE: v });
    check(`HUB_SIDE_BY_SIDE=${JSON.stringify(v)}: no hub call, byte-identical`, r.hub.length === 0 && ownSame(r, off, s, offStore));
  }
  const viaHub = await runSync(copyOf(seed), world, { ...ON, MLS_SOURCE: "hub" });
  check("MLS_SOURCE=hub: the copy IS the hub's, the check asks nothing and records nothing", viaHub.rows.length === 0 &&
    !viaHub.hub.includes("POST /v1/parity/record"), viaHub.hub.join(", "));

  // ---------------------------------------------------------------------------
  print("\n2. On, the hub agreeing: the run byte-identical, `same` rows");
  const onStore = copyOf(seed);
  const on = await runSync(onStore, world, ON);
  check("the run's own MLS Grid and Lofty requests, its answer and every blob are byte-identical", ownSame(on, off, onStore, offStore));
  check("one hub read (the search) and one ledger post", on.hub.filter((c) => c === "POST /v1/mls/search").length === 1 &&
    on.hub.filter((c) => c === "POST /v1/parity/record").length === 1, on.hub.join(", "));
  const ops = (rows, op) => rows.filter((x) => x.op === op);
  check("her two Lofty listings' verdicts compared, the same", ops(on.rows, "on_market").length === 2 && ops(on.rows, "on_market").every((x) => x.outcome === "same"),
    JSON.stringify(ops(on.rows, "on_market")));
  check("every stored listing in the sample compared, the same", ops(on.rows, "listing").length >= 9 && ops(on.rows, "listing").every((x) => x.outcome === "same"),
    JSON.stringify(ops(on.rows, "listing").filter((x) => x.outcome !== "same")));
  check("area mls_read, keys from parityKey, no value", on.rows.every((x) => x.area === "mls_read" && /^k[0-9a-f]{16}$/.test(x.key)) && !leaks(JSON.stringify(on.rows)).length,
    leaks(JSON.stringify(on.rows)).join());
  check("the log line names counts and fields only", on.log.some((l) => /^Side-by-side mls_read: \d+ same\.$/.test(l)) && !leaks(on.log.filter((l) => /Side-by-side/.test(l)).join("\n")).length,
    on.log.filter((l) => /Side-by-side/.test(l)).join(" | "));

  // ---------------------------------------------------------------------------
  print("\n3. On, the hub differing: the right field names and reasons");
  world.hubEdit = (rows) => rows
    .filter((r) => r.ListingKey !== "K5")
    .map((r) => {
      if (r.ListingKey === "K2") return { ...r, ListPrice: r.ListPrice + 1000 };
      if (r.ListingKey === "K6") return { ListingKey: r.ListingKey, ListingId: r.ListingId, ModificationTimestamp: r.ModificationTimestamp, MlgCanView: false, _hub: { withheld: true } };
      if (r.ListingKey === "K7") return { ...r, ModificationTimestamp: new Date(Date.parse(r.ModificationTimestamp) - 60000).toISOString() };
      if (r.ListingKey === "K8") return { ...r, ModificationTimestamp: new Date(Date.parse(r.ModificationTimestamp) + 60000).toISOString(), ListPrice: 1 };
      if (r.ListingKey === "K3") return { ...r, PhotosCount: 30 };
      return r;
    });
  const dStore = copyOf(seed);
  const d = await runSync(dStore, world, ON);
  world.hubEdit = null;
  check("the run's own work byte-identical even so", ownSame(d, off, dStore, offStore));
  const keyOf = async (id) => require(`${FN_DIR}/lib/suite-kit/parity.js`).parityKey(`mls:${id}`);
  const rowFor = async (id) => { const k = await keyOf(id); return d.rows.find((x) => x.op === "listing" && x.key === k); };
  const r2 = await rowFor("IRE1000002"), r5 = await rowFor("IRE1000005"), r6 = await rowFor("IRE1000006"), r7 = await rowFor("IRE1000007"), r8 = await rowFor("IRE1000008"), r3 = await rowFor("IRE1000003");
  check("a price that differs: different price", r2 && r2.outcome === "different" && r2.different.join() === "price", JSON.stringify(r2));
  check("a listing the hub does not have: present own_only (the hub would lose it)", r5 && r5.own_only.join() === "present", JSON.stringify(r5));
  check("a withheld stub: present own_only, withheld hub_only", r6 && r6.own_only.join() === "present" && r6.hub_only.join() === "withheld", JSON.stringify(r6));
  check("the hub's copy behind this site's: not compared, hub_not_ready", r7 && r7.outcome === "not_compared" && r7.reason === "hub_not_ready", JSON.stringify(r7));
  check("this site's copy behind the hub's: not compared, skipped (not a difference)", r8 && r8.outcome === "not_compared" && r8.reason === "skipped", JSON.stringify(r8));
  check("the MLS photo count, where this site stores one", r3 && (r3.outcome === "same" || r3.different.join() === "photo_count"), JSON.stringify(r3));
  check("no value in any row", !leaks(JSON.stringify(d.rows)).length && !/1251000|526000|"30"/.test(JSON.stringify(d.rows)));

  // ---------------------------------------------------------------------------
  print("\n4. On, the hub failing in every way: the run byte-identical, not_compared with the reason");
  for (const [mode, reason] of [["down", "hub_unreachable"], ["500", "hub_refused"], ["403", "hub_refused"], ["off", "hub_off"],
    ["not_ready", "hub_not_ready"], ["ready_false", "hub_not_ready"], ["html", "hub_bad_answer"]]) {
    world.hubFail = mode;
    const s = copyOf(seed);
    const r = await runSync(s, world, ON);
    world.hubFail = null;
    check(`hub ${mode}: the run byte-identical, every row not_compared ${reason}`, ownSame(r, off, s, offStore) && r.rows.length >= 11 &&
      r.rows.every((x) => x.outcome === "not_compared" && x.reason === reason), `${r.rows.length} ${JSON.stringify(r.rows[0])}`);
  }
  for (const mode of ["off", "down"]) {
    world.recordFail = mode;
    const s = copyOf(seed);
    const r = await runSync(s, world, ON);
    world.recordFail = null;
    check(`the ledger post failing (${mode}): a count in the log, the run byte-identical`, ownSame(r, off, s, offStore) &&
      r.log.some((l) => /row\(s\) not recorded/.test(l)), r.log.filter((l) => /Side-by-side/.test(l)).join(" | "));
  }

  // ---------------------------------------------------------------------------
  print("\n5. The cap, the confirmer wrapper, the time limit");
  const cStore = copyOf(seed);
  const capped = await runSync(cStore, world, { ...ON, HUB_SIDE_BY_SIDE_MAX: "3" });
  check("HUB_SIDE_BY_SIDE_MAX=3: three comparisons this run (her verdicts first)", capped.rows.length === 3 &&
    capped.rows.filter((x) => x.op === "on_market").length === 2 && ownSame(capped, off, cStore, offStore), JSON.stringify(capped.rows.map((x) => x.op)));
  setEnv(ON);
  const S = require(`${FN_DIR}/lib/_hub-side-by-side.js`);
  const confirm = async () => ({ onMarket: true, why: "in the site's MLS Grid copy" });
  const answer = await confirm();
  const live = S.mlsSideBySide({ startedAt: Date.now(), log: () => {} });
  const wrapped = live.wrapConfirmer(async (l) => answer);
  check("the wrapped confirmer hands back the very answer the site's own confirmer gave", (await wrapped({ listingId: "IRE1" })) === answer);
  check("off, the confirmer is handed back untouched", S.mlsSideBySide({ env: {}, log: () => {} }).wrapConfirmer(confirm) === confirm);
  check("...and with no confirmer there is still none", live.wrapConfirmer(undefined) === undefined);
  world.rows = []; world.hubCalls = [];
  global.fetch = makeFetch(world);
  const late = S.mlsSideBySide({ startedAt: Date.now() - 22000, log: () => {} });
  await late.finish({ store: copyOf(seed), gridRan: true, listingsKey: "listings.json", mineKey: "mine-listings.json", statuses: ["Active"], toStored: (r) => r });
  check("too little of the run's 30 seconds left: no hub read, one skipped row", !world.hubCalls.includes("POST /v1/mls/search") &&
    world.rows.length === 1 && world.rows[0].reason === "skipped", JSON.stringify(world.rows) + world.hubCalls.join());

  print(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
