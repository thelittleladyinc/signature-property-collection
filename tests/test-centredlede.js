// A centred section's lede must actually be centred.
//
// 2026-08-17 (Christine, on /sellers.html: "spacing is odd pn this page too").
// She was right that something was off and reasonable to call it spacing. It was
// centring: `.lede` is capped at max-width 680px, and in a centred section the TEXT
// centred inside that box while the BOX stayed pinned to the left of the wrap. The
// paragraph therefore sat ~50px left of the heading above it on four pages.
//
// This is the kind of defect worth a test precisely BECAUSE nothing looks broken.
// There is no error, no gap, no overflow — it just reads as slightly wrong, and a
// person notices the wrongness long before they can name it. That makes it easy to
// reintroduce and hard to spot in review.
//
// WHY A STRING CHECK rather than a browser: same reasoning as test-mobilegrid.js and
// test-mapspots.js — tests.yml stays dependency-light. What is pinned here is the
// property that produces the layout, not the rendered pixels.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const { builtAsset } = require("./_assets");
const css = fs.readFileSync(builtAsset(ROOT, "css", "style", ".css"), "utf8");

// The rule itself.
check(
  ".center exists and centres text",
  /\.center\s*\{[^}]*text-align:\s*center/.test(css),
  "the class the markup now uses is not defined"
);
const rule = (css.match(/\.center\s+\.lede\s*\{[^}]*\}/) || [])[0] || "";
check(".center .lede rule exists", !!rule);
check(
  "and it gives the box automatic side margins",
  /margin-left:\s*auto/.test(rule) && /margin-right:\s*auto/.test(rule),
  "without both, a max-width lede stays pinned left inside a centred section"
);

// The markup has to keep using the class. An inline style="text-align:center" would
// still LOOK centred while silently losing the margins again — the original bug.
const pages = ["sellers.html", "current-listings.html", "expired-listings.html",
               "listing-video-portfolio.html"];
let checkedPages = 0;
for (const page of pages) {
  const file = path.join(ROOT, "site", page);
  if (!fs.existsSync(file)) { check(`${page} exists`, false); continue; }
  const html = fs.readFileSync(file, "utf8");

  // Only assert on pages that actually have a centred lede — this list is the
  // record of which pages had the bug, not a requirement that they keep the layout.
  const centred = /<div class="wrap center"[^>]*>[\s\S]*?class="lede"/.test(html);
  const inlineCentred = /<div class="wrap"[^>]*style="[^"]*text-align:\s*center[^"]*"[^>]*>[\s\S]{0,2000}?class="lede"/.test(html);

  check(
    `${page}: a centred lede uses the .center class, not an inline style`,
    !inlineCentred,
    "inline centring returns the original bug — the text centres, the box does not"
  );
  if (centred) checkedPages++;
}
check(
  "at least one page still exercises this",
  checkedPages > 0,
  "no centred lede found anywhere — if that is deliberate, delete this suite"
);

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
