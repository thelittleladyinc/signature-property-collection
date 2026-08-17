// No market figure appears on a town page unless live data put it there.
//
// 2026-08-16. The town pages now publish real numbers — "there are 214 active
// listings in Loveland, at a median asking price of $689,000" — because that is
// what the pages outranking this site do, and because this site is the only one
// in that result with a raw MLS feed rather than a vendor widget it cannot read
// from.
//
// A number on a page is a liability the moment it stops being true, and this one
// is quoted in FAQPage schema, which is exactly the form a search engine lifts
// out and shows to someone who never visits the site. So the rule pinned here is
// the same one test-soldclaims.js pins for sold homes: the figure requires live
// evidence, and its absence must produce silence rather than a guess.
//
// Concretely, three things must hold:
//
//   1. Every price on a town page traces back to build/data/town_market.json.
//      No hand-typed medians, ever — that is the exact failure mode of the
//      competing pages this block was built to beat.
//   2. When the data is missing or stale, pages fall back to qualitative copy
//      and publish NO figure. Silence is the safe state.
//   3. Towns the generator withheld for being too thin to aggregate (under
//      min_sample active listings) stay withheld. On a small town a "median"
//      of two listings is one identifiable seller's asking price, which is
//      both an IDX problem and a privacy one.
//
// Repo root from this file's own location so the suite runs in CI too.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");
const DATA = path.join(ROOT, "build", "data", "town_market.json");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// The staleness window build.py enforces. Kept in sync deliberately: if someone
// widens it there without thinking, this test starts failing and asks why.
const STALE_DAYS = 21;

function townPages() {
  const out = [];
  const communities = path.join(SITE, "communities");
  for (const county of fs.readdirSync(communities)) {
    const dir = path.join(communities, county);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".html")) continue;
      const p = path.join(dir, f);
      const html = fs.readFileSync(p, "utf8");
      if (/<h1[^>]*>Living In /.test(html)) out.push({ p, html, name: `${county}/${f}` });
    }
  }
  return out;
}

const pages = townPages();
check("town pages found", pages.length > 0, `found ${pages.length}`);

let data = null;
if (fs.existsSync(DATA)) {
  try { data = JSON.parse(fs.readFileSync(DATA, "utf8")); }
  catch (e) { check("town_market.json parses", false, e.message); }
}

// Age of the data, in days, or null when there is none to age.
let ageDays = null;
if (data && data.generated_at) {
  const gen = new Date(`${data.generated_at}T00:00:00Z`);
  if (!isNaN(gen)) ageDays = Math.floor((Date.now() - gen.getTime()) / 86400000);
}
const live = data && ageDays !== null && ageDays <= STALE_DAYS;

// The market-figure sentence the block renders. Matching the shape rather than a
// specific number so this keeps working as inventory moves.
const FIGURE = /there are ([\d,]+) active listings in ([^,]+), at a median asking price of \$([\d,]+)/;

if (!live) {
  const offenders = pages.filter((p) => FIGURE.test(p.html));
  check(
    "no market figures published without fresh data",
    offenders.length === 0,
    offenders.length ? `${offenders.length} page(s) show a price with no fresh source, e.g. ${offenders[0].name}` : ""
  );
  console.log(
    data
      ? `  note  town_market.json is ${ageDays} days old (limit ${STALE_DAYS}) — figures correctly suppressed`
      : "  note  no town_market.json — figures correctly suppressed; run node build/tools/town-market-stats.js"
  );
} else {
  const towns = data.towns || {};
  const minSample = data.min_sample || 0;
  let checkedPages = 0;
  let mismatches = [];
  let leaks = [];

  for (const pg of pages) {
    const m = pg.html.match(FIGURE);
    if (!m) continue;
    checkedPages += 1;
    const [, activeStr, town, medianStr] = m;
    const stats = towns[town.trim()];
    if (!stats) { leaks.push(`${pg.name}: publishes a figure for "${town}" which is not in town_market.json`); continue; }
    const active = Number(activeStr.replace(/,/g, ""));
    const median = Number(medianStr.replace(/,/g, ""));
    if (active !== stats.active) mismatches.push(`${pg.name}: active ${active} != ${stats.active}`);
    if (median !== stats.median_list) mismatches.push(`${pg.name}: median ${median} != ${stats.median_list}`);
    if (minSample && stats.active < minSample) {
      leaks.push(`${pg.name}: ${town} has ${stats.active} active, under min_sample ${minSample}`);
    }
  }

  check("every published figure matches town_market.json exactly", mismatches.length === 0, mismatches.slice(0, 3).join(" · "));
  check("no figure published for a withheld or unknown town", leaks.length === 0, leaks.slice(0, 3).join(" · "));
  check("at least one town page carries live figures", checkedPages > 0, `${checkedPages} pages priced`);

  // The schema copy must agree with the visible copy. If they ever diverge, the
  // number a search engine quotes stops being the number a visitor can see.
  let schemaMismatch = [];
  for (const pg of pages) {
    const vis = pg.html.match(FIGURE);
    const sch = pg.html.match(/median asking price across the ([\d,]+) active listings in ([^"]+?) is \$([\d,]+)/);
    if (!vis || !sch) continue;
    if (vis[1] !== sch[1]) schemaMismatch.push(`${pg.name}: body says ${vis[1]} active, schema says ${sch[1]}`);
  }
  check("FAQ schema agrees with the visible figures", schemaMismatch.length === 0, schemaMismatch.slice(0, 3).join(" · "));
}

// ---------------------------------------------------------------------------
// The stats generator must agree with the sync about the shape of the blob.
//
// 2026-08-17. town-market-stats.js reported "the replicated listings blob is
// empty" and exited 1 while /status said 26,445 listings stored and the
// Loveland page rendered 510 active homes. The feed was fine; the reader was
// broken. It checked Array.isArray(raw) and then raw.listings, but
// sync-listings.js writes an object keyed by listingId, so both checks missed
// and every run silently aggregated nothing — and the failure blamed MLS Grid.
//
// The nasty part is the failure mode: this bug cannot show up as a wrong number
// on a page, only as an absence, and an absence is exactly what this suite's
// other checks call the CORRECT safe state. It could have sat there forever.
// So the shape contract gets pinned directly, on both sides.
const stats = require(path.join(ROOT, "build", "tools", "town-market-stats.js"));

check("town-market-stats.js exports listingsFromBlob", typeof stats.listingsFromBlob === "function");

if (typeof stats.listingsFromBlob === "function") {
  // The real shape: an object keyed by listingId. This is the case that
  // regressed, so it is the case stated first and most explicitly.
  const byId = {
    IRE1051807: { listingId: "IRE1051807", city: "Loveland", price: 15300000, status: "Active" },
    IRE1000031: { listingId: "IRE1000031", city: "Loveland", price: 12000000, status: "Active" },
  };
  const fromObject = stats.listingsFromBlob(byId);
  check(
    "reads the listingId-keyed object sync-listings.js actually writes",
    fromObject.length === 2 && fromObject[0].city === "Loveland",
    `got ${fromObject.length} record(s) — this is the 2026-08-17 regression`
  );

  // A plain array is tolerated so a future shape change degrades loudly
  // rather than silently zeroing.
  check(
    "tolerates a plain array",
    stats.listingsFromBlob([{ city: "Windsor", price: 1 }]).length === 1
  );

  // And genuinely-absent data must still come back empty, or the "silence is
  // the safe state" guarantee above turns into a crash instead.
  for (const [label, value] of [["null", null], ["undefined", undefined], ["empty object", {}]]) {
    check(`${label} yields no listings`, stats.listingsFromBlob(value).length === 0);
  }
}

// The other side of the contract: the writer. If someone changes
// saveListingsCheckpoint to store an array or a wrapper, the assertions above
// keep passing while the tool goes back to reading nothing.
const sync = fs.readFileSync(path.join(ROOT, "netlify", "functions", "sync-listings.js"), "utf8");
check(
  "sync-listings.js still writes the listings blob as an object keyed by id",
  /setJSON\(\s*LISTINGS_KEY\s*,\s*listingsById\s*\)/.test(sync),
  "the write shape changed — re-check listingsFromBlob in build/tools/town-market-stats.js"
);

// Whatever the data state, nothing may hand-type a median into the generator.
const buildPy = fs.readFileSync(path.join(ROOT, "build", "build.py"), "utf8");
const movingBlock = buildPy.slice(buildPy.indexOf("def _moving_to_block"), buildPy.indexOf("def build_city_pages"));
check(
  "no hard-coded dollar figure in the moving-to block",
  !/\$\d[\d,]{3,}/.test(movingBlock),
  "a literal price appears in build.py — it must come from town_market.json"
);

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
