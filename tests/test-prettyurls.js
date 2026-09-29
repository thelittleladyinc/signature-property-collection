// Published links go straight to the page, not through our own 301s (2026-09-29).
//
// Netlify's "Pretty URLs" post-processing rewrote every internal link in the
// PUBLISHED HTML to its extensionless form (/about.html -> /about) after the
// build, and site/_redirects 301'd each of those back to the .html page -- so
// every click went through one of our own redirects. (Same fix as
// thelittleladysellshomes' tests/test-prettyurls.js.)
// This pins the fix:
//   - netlify.toml turns the setting off ([build.processing.html]), which
//     overrides the Netlify UI;
//   - home-page links stay "/", exactly as Pretty URLs served them and as Google
//     indexes the home page, and "/" is a 200 rewrite in _redirects, not a
//     redirect (build.py's header and 404 page emit "/");
//   - no page links to /index.html.
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

console.log("\n1. Netlify's Pretty URLs rewriting is off");
const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
const at = toml.search(/^\[build\.processing\.html\]\s*$/m);
const block = at < 0 ? "" : toml.slice(at).split("\n").slice(1).join("\n").split(/^\[/m)[0];
check("[build.processing.html] pretty_urls = false", /^\s*pretty_urls\s*=\s*false\s*$/m.test(block), block.trim() || "(no block)");

console.log("\n2. The home page keeps the address Google knows");
const redirects = fs.readFileSync(path.join(SITE, "_redirects"), "utf8").split("\n").map((l) => l.trim());
check('"/" is a 200 rewrite to /index.html, not a redirect',
  redirects.some((l) => /^\/\s+\/index\.html\s+200!?$/.test(l)));
const home = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
check("the header's home link is \"/\"", /<a href="\/" class="brand-wordmark"/.test(home));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}
const pages = walk(SITE);
const toIndex = pages.filter((f) => /href="\/index\.html(?=[#?"])/.test(fs.readFileSync(f, "utf8")));
check(`no page links to /index.html (${pages.length} pages)`, toIndex.length === 0,
  toIndex.slice(0, 3).map((f) => path.relative(SITE, f)).join(", "));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
