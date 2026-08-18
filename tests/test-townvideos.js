// "Homes Christine Has Marketed In <Town>" — the listing tours on each town page.
//
// 2026-08-16 (Christine: "then we can put videos of listing ive sold on each town
// page?"). Yes, and the ways this block can go wrong are all invisible from the
// outside, which is why they are pinned here rather than eyeballed once:
//
//   * The same house shown twice. She filmed 945 Maplebrook in Windsor three times
//     and 475 Homestead in Johnstown twice. A "homes I've marketed here" section
//     showing one house three times reads as padding, and nothing about it looks
//     broken to a build.
//   * The same iframe twice on one page. Two Windsor local spots are backed by
//     Windsor listing tours, so the tour block has to know what the spots already
//     embedded.
//   * A "Sold" label on a house that is not sold. That is a live client's home
//     advertised as gone, and it is the one error here with a real cost.
//   * A price-anchored title turning up under an estate-marketing pitch, which is
//     the luxury-only positioning she set on 2026-08-14 quietly leaking.
//
// Repo root derived from this file's own location, never hardcoded: these suites
// run both locally and in GitHub Actions, where the checkout is at
// /home/runner/work/<repo>/<repo>. An absolute path would pass here and fail there.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const BUILD = fs.readFileSync(path.join(ROOT, "build", "build.py"), "utf8");

// --- read the three tables straight out of build.py -------------------------
// Parsed rather than duplicated here: a copy of the video list in the test would
// pass forever while the site said something else.
function block(name) {
  const m = BUILD.match(new RegExp(`\\n${name} = \\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`${name} not found in build.py`);
  return m[1];
}

// (id, "title", views, key) — 4-tuples, one per line, comments skipped.
const TOWN_VIDEOS = {};   // slug -> [{id, title, views, prop}]
{
  let slug = null;
  for (const line of block("TOWN_LISTING_VIDEOS").split("\n")) {
    const s = line.match(/^\s{4}"([a-z0-9-]+)": \[/);
    if (s) { slug = s[1]; TOWN_VIDEOS[slug] = []; continue; }
    const v = line.match(/^\s+\("([\w-]+)", (".*?"|'.*?'), (\d+), (None|"[^"]*")\),\s*$/);
    if (v && slug) {
      TOWN_VIDEOS[slug].push({
        id: v[1],
        title: v[2].slice(1, -1),
        views: Number(v[3]),
        prop: v[4] === "None" ? null : v[4].slice(1, -1),
      });
    }
  }
}
const OFF_BRAND = new Set(
  [...block("OFF_BRAND_LISTING_VIDEOS").matchAll(/^\s+"([\w-]+)":/gm)].map((m) => m[1]));
// Sold/live statuses used to be read here to verify the "Sold" captions. Christine
// removed those captions on 2026-08-16, and the block now forbids any status wording
// outright -- see the label check below. tests/test-soldclaims.js is what guards the
// status table itself.

console.log("\n1. The data itself");
const towns = Object.keys(TOWN_VIDEOS);
check(`parsed ${towns.length} towns and ` +
      `${Object.values(TOWN_VIDEOS).flat().length} videos out of build.py`,
  towns.length >= 10 && Object.values(TOWN_VIDEOS).flat().length >= 30,
  JSON.stringify(towns));
check(`${OFF_BRAND.size} videos held back, and the parse found them`, OFF_BRAND.size >= 5);

const allIds = Object.values(TOWN_VIDEOS).flat().map((v) => v.id);
check("every id looks like a YouTube id", allIds.every((i) => /^[\w-]{11}$/.test(i)),
  allIds.filter((i) => !/^[\w-]{11}$/.test(i)).join(", "));
// A video filed under two different towns would put one house on two town pages,
// each claiming it as local work.
const dupIds = allIds.filter((i, n) => allIds.indexOf(i) !== n);
check("no video is filed under two towns", dupIds.length === 0, dupIds.join(", "));
// Every town slug must have a page, or its videos are simply invisible with nothing
// reporting it.
const pagesBySlug = {};
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".html")) {
      (pagesBySlug[e.name.replace(/\.html$/, "")] ||= []).push(p);
    }
  }
}
walk(path.join(SITE, "communities"));
// build.py's data slugs carry a "-city" suffix where a town name collides with a
// county name (broomfield-city, denver-city); the page keeps the plain name.
const pageSlug = (s) => s.replace(/-city$/, "");
const missing = towns.filter((t) => !pagesBySlug[pageSlug(t)]);
check("every town with videos has a page", missing.length === 0, missing.join(", "));

console.log("\n2. What actually reached the pages");
const HEAD = /<span class="eyebrow">[^<]*Work In ([^<]+)<\/span>([\s\S]*?)<\/section>/;
const embedded = {};   // page path -> [ids]
let pageCount = 0, embedCount = 0;
for (const paths of Object.values(pagesBySlug)) {
  for (const p of paths) {
    const html = fs.readFileSync(p, "utf8");
    const m = html.match(HEAD);
    if (!m) continue;
    pageCount++;
    const ids = [...m[2].matchAll(/class="yt-facade" data-yt="([\w-]+)"/g)]
      .map((x) => x[1]);
    embedded[path.relative(ROOT, p)] = { ids, section: m[2], town: m[1].trim(), html };
    embedCount += ids.length;
  }
}
check(`the block renders on ${pageCount} town pages with ${embedCount} tours`,
  pageCount >= 9 && embedCount >= 15, `${pageCount} pages / ${embedCount} tours`);

for (const [page, { ids, section, town, html }] of Object.entries(embedded)) {
  const slug = towns.find((t) => pageSlug(t) === path.basename(page, ".html"));
  const data = TOWN_VIDEOS[slug] || [];
  const byId = Object.fromEntries(data.map((v) => [v.id, v]));

  // Every rendered tour must come from this town's own list. A tour from the next
  // town over would read as local work done here.
  const foreign = ids.filter((i) => !byId[i]);
  check(`${page}: every tour is one of ${town}'s own`, foreign.length === 0, foreign.join(", "));

  const held = ids.filter((i) => OFF_BRAND.has(i));
  check(`${page}: no price-anchored tour`, held.length === 0, held.join(", "));

  // The property rule, checked on the rendered page rather than on the data.
  const props = ids.map((i) => byId[i]?.prop).filter(Boolean);
  const dupProp = props.filter((p, n) => props.indexOf(p) !== n);
  check(`${page}: no house shown twice in the block`, dupProp.length === 0, dupProp.join(", "));

  // And the same rule across the WHOLE page, since the header video and the local
  // spots embed tours too.
  const pageIds = [...html.matchAll(/class="yt-facade" data-yt="([\w-]+)"/g)]
    .map((x) => x[1]);
  const pageProps = pageIds.map((i) => byId[i]?.prop).filter(Boolean);
  const dupPageProp = pageProps.filter((p, n) => pageProps.indexOf(p) !== n);
  check(`${page}: no house shown twice anywhere on the page`,
    dupPageProp.length === 0, dupPageProp.join(", "));

  check(`${page}: at most 4 tours`, ids.length <= 4, `${ids.length}`);
  // Most-watched first: the strongest piece of work is the one a visitor sees.
  const views = ids.map((i) => byId[i]?.views ?? 0);
  check(`${page}: ordered most-watched first`,
    views.every((v, n) => n === 0 || views[n - 1] >= v), JSON.stringify(views));

  // The label rule, 2026-08-16. This block used to caption the eight tours whose
  // status was cross-checked as "Sold". Christine dropped it -- "we can always just
  // say examples of marketing in whichever town so they dont have to say sold" --
  // and the absolute version is the stronger check: no status word may appear here
  // at all, so the section can never contradict a listing's real state as it
  // changes. Sold framing lives on /past-sales.html, where every entry is verified.
  check(`${page}: no sold/pending/under-contract wording in the block`,
    !/\b(Sold|Pending|Under Contract|Closed)\b/.test(section.replace(/<iframe[\s\S]*?<\/iframe>/g, "")),
    (section.match(/\b(Sold|Pending|Under Contract|Closed)\b/) || [])[0]);
  check(`${page}: no caption under any tour`, !/video-embed-caption/.test(section));

  // Views are recorded in the data for auditing but must never be printed here --
  // Christine, 2026-08-16: "why would anyone care about how many views?"
  check(`${page}: the block quotes no view counts`, !/\d[\d,]*\s*views/.test(section));

  // Google needs a VideoObject per embed or the tours are invisible to it, which is
  // most of the point of putting them on a ranking page.
  const schemas = [...html.matchAll(/"embedUrl": "https:\/\/www\.youtube-nocookie\.com\/embed\/([\w-]+)"/g)]
    .map((x) => x[1]);
  const unschemad = ids.filter((i) => !schemas.includes(i));
  check(`${page}: every tour carries VideoObject schema`, unschemad.length === 0,
    unschemad.join(", "));
}

console.log("\n3. The heading claims only what is true of all of them");
// Not "Homes Sold In X". Most have no cross-checked sold status and one is a live
// listing; what IS true of every one is that it is an example of her marketing,
// which is also the thing a seller is judging.
for (const [page, { section }] of Object.entries(embedded)) {
  check(`${page}: heading offers examples of the marketing, claims no sale`,
    /Examples Of [^<]*Marketing In/.test(section) && !/Homes Sold In/.test(section));
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
