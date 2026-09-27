// Christine's own street/mailing address is never published.
//
// 2026-09-26 (Christine): she does not want her street address shown anywhere on
// the site. Colorado advertising rules require the brokerage name, not an address,
// so the footer and the Contact card now read
// "Christine Gwinnup · LPT Realty · 303-709-4262 · Serving Northern Colorado" (the
// June 2026 luxury report's sign-off ends "· Serving Northern Colorado"), and
// the RealEstateAgent schema carries a city/region-only PostalAddress.
//
// What this suite protects:
//   1. The address (or its ZIP in schema) creeping back into any built page or the
//      two listing-page shells (Signature and TLLSH brand) the IDX function renders from.
//   2. The replacement line going missing from the footer, so a page would show no
//      brokerage/contact line at all.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
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

const files = walk(path.join(ROOT, "site"));
for (const s of ["_listing-page-shell.html", "_listing-page-shell-tllsh.html"]) files.push(path.join(ROOT, "netlify", "functions", "lib", s));
const ADDRESS = /2411\s+Glade\s+R(?:oa)?d/i;
const NAP = "Christine Gwinnup &middot; LPT Realty &middot; 303-709-4262 &middot; Serving Northern Colorado";

const withAddress = [], noSchemaZip = [], missingNap = [];
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f);
  if (ADDRESS.test(html)) withAddress.push(rel);
  for (const m of html.matchAll(/"@type"\s*:\s*"RealEstateAgent"[\s\S]*?<\/script>/g)) {
    if (/"streetAddress"|"postalCode"/.test(m[0])) noSchemaZip.push(rel);
  }
  if (/<footer\b/.test(html) && !html.includes(NAP)) missingNap.push(rel);
}

check(`no page shows 2411 Glade Rd (${files.length} files)`, withAddress.length === 0, withAddress.slice(0, 5).join(", "));
check("RealEstateAgent schema has no streetAddress/postalCode", noSchemaZip.length === 0, noSchemaZip.slice(0, 5).join(", "));
check("every footer carries the name · brokerage · phone · service-area line", missingNap.length === 0, missingNap.slice(0, 5).join(", "));

const contact = fs.readFileSync(path.join(ROOT, "site", "contact.html"), "utf8");
check("Contact card shows the service-area line", contact.includes(`<br>${NAP}</p>`));

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nAll checks passed.");
