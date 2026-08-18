// "How can we test what to do to make the MLS stuff load faster? Sites being slow
// loses people." — Christine, 2026-08-18, and she is right on both counts.
//
// Every answer given to that question today, mine included, has been a theory:
// the catalogue parse, the photo fetches, the cold starts. Theories are how an
// afternoon disappears. Server-Timing turns it into a measurement Chrome renders
// natively — DevTools → Network → the request → Timing — with nothing to install.
//
// What this suite protects is that the phases stay SEPARABLE. A single "total"
// tells you nothing you did not already know from watching the page; the value is
// entirely in being able to tell a slow catalogue parse from a slow photo fetch,
// because those have completely different fixes.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const search = fs.readFileSync(path.join(ROOT, "netlify", "functions", "listings-search.js"), "utf8");
const photo = fs.readFileSync(path.join(ROOT, "netlify", "functions", "listing-photo.js"), "utf8");

// ---- The search: four phases, four different fixes ----------------------
for (const [phase, why] of [
  ["state", "reading sync-state.json — should be single-digit ms"],
  ["catalogue", "fetching and parsing ~29,000 listings, or reusing the memo"],
  ["filter", "matchesQuery and sort across the whole catalogue"],
  ["prewarm", "resolving photo URLs at MLS Grid before responding"],
]) {
  check(`the search reports its "${phase}" phase`,
    new RegExp(`timing\\.mark\\("${phase}"`).test(search), why);
}
check("and the catalogue phase says WHICH path it took",
  /timing\.mark\("catalogue", "memo"\)/.test(search) &&
    /timing\.mark\("catalogue", "blob read \+ parse"\)/.test(search),
  "a memo hit and a full parse differ by orders of magnitude — the number is " +
  "meaningless without knowing which one happened");
check("the header goes out on the real response, not only in debug",
  /"Server-Timing": timing\.header\(\)/.test(search),
  "a measurement you have to opt into is one nobody takes");

// ---- The photo: the fast path and the slow path must be distinguishable --
check("a photo served from our own store says so",
  /timing\.header\(\s*\n?\s*stored\.redirectUrl \? "redirect to Cloudinary" : "our own stored copy"\)/.test(photo) ||
    /our own stored copy/.test(photo),
  "this is the whole point of the photo store — it has to be visible when it works");
check("a photo fetched live from MLS Grid says so too",
  /fetched live from MLS Grid/.test(photo),
  "the slow path must be identifiable, or 'some photos are slow' stays unanswerable");
check("the MLS Grid download is timed separately from resolving its URL",
  /timing\.mark\("resolveUrl"\)/.test(photo) && /timing\.mark\("mlsGridDownload"\)/.test(photo),
  "a slow resolve and a slow download are different problems with different fixes");
check("and the store lookup is timed on its own",
  /timing\.mark\("ourStore"\)/.test(photo),
  "if the cache lookup itself is slow, everything else is noise");

// ---- It must not become the slow thing it measures -----------------------
check("timing uses plain clock reads, nothing that can fail or block",
  !/await .*timing|timing.*await/.test(search.replace(/\/\/.*/g, "")),
  "instrumentation that awaits anything can become the latency it reports");

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
