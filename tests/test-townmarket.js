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
