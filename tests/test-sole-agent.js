// Christine only: no second agent's name or number on any built page.
//
// 2026-09-30 (PR #73). Signature Property Collection presented a duo, Christine
// and a second agent. Christine is a solo agent (her decision, 2026-09-27), and
// every page here now carries her only. 2026-10-04 (re-audit): the Little Lady
// site has guarded its pages against the second agent's details since they moved
// there; this site, where the duo lived, had no such guard, so a stray mention in
// a data file or a template would have shipped unnoticed. This suite fails the
// build if the second agent's first name, surname or phone number reaches any
// built page, feed, sitemap, redirect file or listing-page shell -- in any of the
// ways a phone number gets written.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html|xml|txt|json|js)$/.test(e.name) || e.name === "_redirects") out.push(p);
  }
  return out;
}

const files = walk(path.join(ROOT, "site"));
for (const shell of ["_listing-page-shell.html", "_listing-page-shell-tllsh.html"]) {
  const f = path.join(ROOT, "netlify", "functions", "lib", shell);
  if (fs.existsSync(f)) files.push(f);
}

const NAME = /\bkendra\b/i;
const SURNAME = /bajcar/i;
// 970-571-0525 as it is written anywhere: dashes, dots, spaces, brackets, a
// +1 prefix, or all ten digits run together (tel: links).
const PHONE = /(?:\+?1[\s.-]?)?\(?970\)?[\s.-]?571[\s.-]?0525/;

const hits = { name: [], surname: [], phone: [] };
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f);
  if (NAME.test(text)) hits.name.push(rel);
  if (SURNAME.test(text)) hits.surname.push(rel);
  if (PHONE.test(text)) hits.phone.push(rel);
}

check(`no built file names "Kendra" (${files.length} files)`, hits.name.length === 0, hits.name.slice(0, 5).join(", "));
check("no built file names \"Bajcar\"", hits.surname.length === 0, hits.surname.slice(0, 5).join(", "));
check("no built file carries 970-571-0525, in any format", hits.phone.length === 0, hits.phone.slice(0, 5).join(", "));

// The patterns themselves, so a loosened regex cannot pass the suite silently.
for (const s of ["970-571-0525", "970.571.0525", "(970) 571-0525", "9705710525", "+1 970 571 0525", "tel:+19705710525"]) {
  check(`the phone pattern catches "${s}"`, PHONE.test(s));
}
check("the name pattern catches \"Kendra\" in any case", NAME.test("Christine and KENDRA"));
check("and does not flag an ordinary word", !NAME.test("Kendrick Lamar") && !SURNAME.test("Bajcarz".slice(0, 4)));

// The home page and both listing-page shells are in the scan, so an empty site/
// cannot pass it.
check("the home page was built and scanned", files.some((f) => f.endsWith(`${path.sep}site${path.sep}index.html`)));
check("both listing-page shells were scanned", files.filter((f) => /_listing-page-shell(-tllsh)?\.html$/.test(f)).length === 2);

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nAll checks passed.");
