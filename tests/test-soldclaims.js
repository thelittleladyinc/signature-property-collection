// Nothing may be published as SOLD without Christine's own evidence.
//
// 2026-08-16. She read /past-sales.html and said: "32 victoria was not sold either was
// homestead". Both were on the sold-homes map and in the "How I Sold These Homes"
// showcase. Neither had sold.
//
// The cause was an inference made on 2026-08-11, written down in build.py as though it
// were a fact: her "Each Listing SOP" sheet was checked, and every address NOT on it as
// Stage = Live was recorded as "sold" -- "it doesn't appear, meaning as far as we can
// tell that listing has closed or moved on". "Moved on" is where the lie lives. A
// listing missing from a live-listings sheet may have closed, expired, been withdrawn,
// or never gone live at all. Two of the twelve she could check were wrong, which says
// nothing good about the other ten.
//
// This is not a cosmetic bug. Advertising sales you did not make is a real problem for a
// licensed agent, and the site was doing it on two pages in her name.
//
// So the rule is inverted and pinned here: "sold" requires evidence, not the absence of
// evidence to the contrary. In practice that means a matching entry in sold_homes.json,
// which only ever receives addresses Christine has published herself.
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
const SOLD_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, "build", "data", "sold_homes.json"), "utf8"));

// Parsed out of build.py rather than restated here: a second copy of the status table
// inside the test would agree with itself forever while the site said otherwise.
const entries = [...BUILD.matchAll(
  /\(\[([^\]]+)\],\s*\n\s*"([\w-]+)", (?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'), "(sold|live|not-sold|unconfirmed)"\)/g
)].map((m) => ({
  addrs: m[1].split(",").map((a) => a.trim().replace(/^["']|["']$/g, "")).filter(Boolean),
  vid: m[2],
  status: m[3],
}));

const streetKey = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const pinKeys = new Set(SOLD_JSON.homes.map((h) => streetKey(h.address)));

console.log("\n1. The status table parses, and the four values are all in use");
check(`parsed ${entries.length} listing-video entries`, entries.length >= 15, String(entries.length));
const byStatus = {};
for (const e of entries) (byStatus[e.status] ||= []).push(e);
// Every status in use must be one of the four, and the three that make a claim must all
// be represented. "unconfirmed" deliberately is NOT required: it is a holding pen, and
// emptying it is the goal -- Christine cleared the last of it on 2026-08-16 ("i sold 294
// gila, bold 3 rounty rd 27 not indpendevent or cimaron"). Requiring it made an
// improvement fail the build, which is the same mistake five earlier tests here made:
// encoding a moment instead of a rule.
const VALID = ["sold", "live", "not-sold", "unconfirmed"];
const unknown = Object.keys(byStatus).filter((k) => !VALID.includes(k));
check("no status outside the four documented values", unknown.length === 0, unknown.join(", "));
check("statuses in use: " + Object.keys(byStatus).sort().join(", "),
  ["sold", "live", "not-sold"].every((s) => byStatus[s]),
  JSON.stringify(Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, v.length]))));

console.log("\n2. Every 'sold' entry has evidence behind it");
// The whole rule, in one check. A "sold" status with no sold_homes.json pin means
// somebody inferred it again.
for (const e of byStatus.sold) {
  check(`${e.addrs[0]} is backed by a sold_homes.json entry`,
    e.addrs.some((a) => pinKeys.has(streetKey(a))),
    `no pin matches any of: ${e.addrs.join(" | ")}`);
}

console.log("\n3. The two she corrected are not claimed anywhere");
// Named explicitly. This is the regression that actually happened, and a generic rule
// would not tell you it was these two houses if it broke again.
const CORRECTED = ["32 victoria dr", "475 homestead ln"];
for (const addr of CORRECTED) {
  const e = entries.find((x) => x.addrs.some((a) => streetKey(a) === streetKey(addr)));
  check(`${addr} is recorded as not-sold`, e && e.status === "not-sold", e && e.status);
  check(`${addr} has no pin on the sold-homes map`, !pinKeys.has(streetKey(addr)));
}

console.log("\n4. Nothing unproven reaches a page that says sold");
// Checked against the built HTML, because the data being right is only half of it --
// the question is what a visitor is told. Any address whose status is not "sold" must
// not appear on the sold map, the sold data the map's geocoder reads, or past-sales.
const suspect = entries.filter((e) => e.status !== "sold");
const soldPages = [
  "site/past-sales.html",
  "site/sold-homes-map.html",
  "netlify/functions/lib/_sold-homes-data.json",
];
for (const rel of soldPages) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { check(`${rel} exists`, false); continue; }
  const text = fs.readFileSync(p, "utf8").toLowerCase();
  const leaked = [];
  for (const e of suspect) {
    // Match on the address, and on the video id -- an embed with no address text
    // beside it still puts that house in a "homes I sold" grid.
    if (e.addrs.some((a) => text.includes(a.toLowerCase()))) leaked.push(`${e.addrs[0]} (${e.status})`);
    else if (text.includes(e.vid.toLowerCase())) leaked.push(`${e.addrs[0]} video (${e.status})`);
  }
  check(`${rel} claims nothing unproven`, leaked.length === 0, leaked.join(", "));
}

console.log("\n5. The full list shows every verified sale, not just the filmed ones");
// Christine, 2026-08-16: "maybe a page with all sold listings not just hte ones with
// videos". The showcase renders only sales she happened to film -- four of forty-two --
// so a page headed "Past Sales" was showing under a tenth of them.
const past = fs.readFileSync(path.join(SITE, "past-sales.html"), "utf8");
const missing = SOLD_JSON.homes.filter((h) => !past.includes(h.address));
check(`all ${SOLD_JSON.homes.length} verified sales are listed`, missing.length === 0,
  missing.slice(0, 4).map((h) => h.address).join(", "));
const filmed = SOLD_JSON.homes.filter((h) => h.videoId).length;
check(`and the list is bigger than the filmed subset (${SOLD_JSON.homes.length} vs ${filmed})`,
  SOLD_JSON.homes.length > filmed * 2);
// Grouped newest-first with undated last: the undated group led the list on the first
// build because the sort key ranked it above every year.
const years = [...past.matchAll(/class="sold-year-head">([^<]*?)\s*<span>/g)].map((m) => m[1].trim());
const dated = years.filter((y) => /^\d{4}$/.test(y));
check(`years run newest first (${years.join(", ")})`,
  dated.every((y, i) => i === 0 || Number(dated[i - 1]) > Number(y)), years.join(", "));
check("an undated group, if present, comes last",
  !years.includes("Year not recorded") || years[years.length - 1] === "Year not recorded",
  years.join(", "));

console.log("\n6. No MLS-licensed listing data is republished with these sales");
// sold_homes.json's own rule: her transaction history is hers to publish, the MLS's
// listing content is not. So address, town and year only -- no price, beds or sq ft.
const soldSection = (past.match(/The Full List[\s\S]*?<\/section>/) || [""])[0];
check("no prices in the sold list", !/\$[\d,]{4,}/.test(soldSection),
  (soldSection.match(/\$[\d,]{4,}/) || [])[0]);
check("no bed/bath/sq-ft figures in the sold list",
  !/\b\d+\s*(?:bed|bd|bath|ba)\b/i.test(soldSection) && !/sq\.?\s*ft/i.test(soldSection));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
