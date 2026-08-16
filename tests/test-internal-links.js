// Internal link structure — the thing that decided whether pages got indexed.
//
// 2026-08-16 (Christine: "can you review the ones the did index conmpared to the ones
// they didnt and then make the rest much better?").
//
// Measured against her Search Console coverage export: 39 pages indexed, 62 "Crawled
// - currently not indexed". Auditing all 144 built pages found the cause was
// structural, not editorial:
//
//   * 31 town pages had exactly ONE inbound internal link each -- their county page.
//     They were not thin: 650-940 unique non-template words, above the site median.
//     Google had read them and declined, which is what it does with pages the site
//     itself treats as unimportant.
//   * /communities/index.html -- the hub, itself linked from all 144 pages -- linked
//     the 20 COUNTY pages and not one town page. Its authority stopped one level short
//     of the pages targeting "homes for sale in <town>".
//   * The 10 Loveland subdivision pages had the same problem, 1 inbound link each.
//
// After the fix every one of those pages has 6+ inbound links and the only page with
// none is 404.html, which correctly has none.
//
// This suite exists because that regression would be invisible. Nothing would look
// broken, no page would 404, and the cost would appear months later as pages quietly
// dropping out of the index.
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

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}
const files = walk(SITE);
const urlOf = (f) => "/" + path.relative(SITE, f).split(path.sep).join("/");
const html = new Map(files.map((f) => [urlOf(f), fs.readFileSync(f, "utf8")]));

// Inbound internal links, resolved the way a crawler would.
const inbound = new Map([...html.keys()].map((u) => [u, 0]));
for (const [from, body] of html) {
  const seen = new Set();
  for (const m of body.matchAll(/href="(\/[^"#?]*)"/g)) {
    let t = m[1];
    if (t.endsWith("/")) t += "index.html";
    if (!t.endsWith(".html")) continue;
    if (t === from || seen.has(t)) continue;   // count each linking PAGE once
    seen.add(t);
    if (inbound.has(t)) inbound.set(t, inbound.get(t) + 1);
  }
}

const townPages = [...html.keys()].filter((u) => /^\/communities\/[a-z-]+\/[a-z-]+\.html$/.test(u));
const subdivisions = townPages.filter((u) => u.startsWith("/communities/loveland/"));
const towns = townPages.filter((u) => !u.startsWith("/communities/loveland/"));

check(`town pages were found (${towns.length})`, towns.length >= 25, String(towns.length));
check(`subdivision pages were found (${subdivisions.length})`, subdivisions.length >= 8,
  String(subdivisions.length));

// The threshold that matters. One inbound link is what these pages had while Google
// was declining to index them; 3 is a floor well clear of that without pinning the
// exact county sizes, which change as towns are added.
const MIN = 3;
for (const [label, group] of [["town", towns], ["subdivision", subdivisions]]) {
  const starved = group.filter((u) => inbound.get(u) < MIN);
  const min = Math.min(...group.map((u) => inbound.get(u)));
  check(`every ${label} page has ${MIN}+ inbound links (lowest: ${min})`,
    starved.length === 0,
    starved.slice(0, 4).map((u) => `${u}=${inbound.get(u)}`).join(", "));
}

// The specific regression: the hub must reach the towns directly. Losing this is how
// they were starved in the first place.
const hub = html.get("/communities/index.html") || "";
const linkedFromHub = towns.filter((u) => hub.includes(`href="${u}"`));
check(`the communities hub links every town page (${linkedFromHub.length}/${towns.length})`,
  linkedFromHub.length === towns.length,
  towns.filter((u) => !linkedFromHub.includes(u)).slice(0, 4).join(", "));

// And towns must reach each other, so a reader comparing two towns has a route and
// the county's pages form a mesh rather than a fan.
const sample = towns.filter((u) => u.startsWith("/communities/weld/"));
const crossLinked = sample.filter((u) =>
  sample.some((o) => o !== u && html.get(u).includes(`href="${o}"`)));
check(`towns link their county siblings (${crossLinked.length}/${sample.length} in Weld)`,
  sample.length > 1 && crossLinked.length === sample.length);

// Orphans. This first asserted "404.html is the only one", and immediately caught
// /thank-you.html -- reached only through a form's action= attribute, which no crawler
// follows. That is correct for a noindex confirmation page, so the real rule is: a page
// with no inbound links must be one we never wanted indexed.
const sitemap = fs.readFileSync(path.join(SITE, "sitemap.xml"), "utf8");
const noindex = (u) => /name="robots"[^>]*noindex/.test(html.get(u) || "");
const orphans = [...inbound].filter(([, n]) => n === 0).map(([u]) => u);
const badOrphans = orphans.filter((u) => u !== "/404.html" && !noindex(u));
check(`every orphan page is one we don't want indexed (${orphans.join(", ")})`,
  badOrphans.length === 0, badOrphans.join(", "));

// The contradiction that orphan check exposed, now pinned. A noindex page listed in
// the sitemap is submitting a URL that tells Google not to index it, which Search
// Console reports as an error rather than ignoring -- so it would have surfaced in her
// next coverage export as a NEW problem, caused by a fix.
const noindexed = [...html.keys()].filter(noindex);
const contradictory = noindexed.filter((u) => sitemap.includes(u));
check(`no noindex page is submitted in the sitemap (${noindexed.length} noindex)`,
  contradictory.length === 0, contradictory.join(", "));
check("404.html is not in the sitemap", !sitemap.includes("/404.html"));

// A directory entry pointing at a page that doesn't exist would be worse than no
// directory: it manufactures 404s on the site's most-linked page.
const broken = [];
for (const m of hub.matchAll(/href="(\/communities\/[^"#?]*\.html)"/g)) {
  if (!html.has(m[1])) broken.push(m[1]);
}
check("no directory entry points at a missing page", broken.length === 0, broken.join(", "));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
