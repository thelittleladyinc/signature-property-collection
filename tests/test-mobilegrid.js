// An inline grid-template-columns override must never land on .grid-3 / .grid-2.
//
// 2026-08-13 this bug was found with a 390px Playwright check and fixed by adding
// .grid-2col to style.css. 2026-08-16 it came straight back, on 37 town pages, by
// someone copying the block next to it — because nothing stopped it. The class
// existed, the comment explaining it existed, and neither is a mechanism.
//
// WHY IT MATTERS: .grid-3 and .grid-2 collapse to one column under
// @media (max-width:900px). A style="" attribute out-specifies a media query, so
// the grid stays two-wide on a phone and the page overflows. Mobile browsers do not
// clip that — they WIDEN the layout viewport to fit, so the whole page renders
// zoomed out and every font on it shrinks. Reproduced here at 390px before the fix:
// layout viewport 405px, grid 2 columns. After: 390px, 1 column.
//
// WHY THIS SUITE IS A STRING CHECK AND NOT A BROWSER CHECK: tests.yml is
// deliberately dependency-free ("no npm install of dev tooling, no matrix ...
// anything heavier would be a second thing to keep working"), and a browser in CI
// is exactly that. The browser found the bug; this pins the cause, which is a
// property of the markup and needs no rendering to detect. Run the real 390px
// check by hand when layout changes — serve site/ and drive it with Playwright.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// A style attribute on a .grid-3/.grid-2 element that sets grid-template-columns.
// Only that property is a problem: margin/padding in a style attribute is fine and
// common, and flagging those would make this suite noise people learn to ignore.
const OFFENDER = /class="[^"]*\bgrid-[23]\b[^"]*"[^>]*style="[^"]*grid-template-columns/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

const pages = walk(SITE);
const hits = [];
for (const f of pages) {
  const m = fs.readFileSync(f, "utf8").match(OFFENDER);
  if (m) hits.push(`${path.relative(SITE, f)} (${m.length})`);
}
check(
  "no inline grid-template-columns on .grid-3 / .grid-2 in built pages",
  hits.length === 0,
  hits.length ? `${hits.length} page(s), e.g. ${hits.slice(0, 3).join(", ")} — use .grid-2col` : ""
);

// And in the generator, so it fails on the line someone actually edits rather than
// only on the 37 files that line produced.
const gen = fs.readFileSync(path.join(ROOT, "build", "build.py"), "utf8");
const genHits = (gen.match(OFFENDER) || []).length;
check(
  "no inline grid-template-columns on .grid-3 / .grid-2 in build.py",
  genHits === 0,
  genHits ? `${genHits} occurrence(s) — use class="grid-2col"` : ""
);

// The class this all depends on must actually exist, with its mobile breakpoint.
// Without the breakpoint .grid-2col is just .grid-2 with extra steps.
// Resolved by stem — build.py content-hashes it. See tests/_assets.js.
const css = require("./_assets").readBuiltAsset(ROOT, "css", "style", ".css");
check("style.css defines .grid-2col", /\.grid-2col\s*\{/.test(css));
check(
  ".grid-2col collapses to one column on small screens",
  /@media[^{]*max-width:\s*\d+px[^{]*\{\s*\.grid-2col\s*\{[^}]*grid-template-columns:\s*1fr/.test(css)
);

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
