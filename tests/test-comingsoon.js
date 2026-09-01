// Coming Soon listings: replicated, searchable, labelled, and never confused
// with sold.
//
// 2026-09-01. Christine had a real listing of her own -- 357 Blue Azurite --
// entered in IRES and showing on NEITHER site, and asked the right diagnostic
// question: is it missing because it isn't active yet, or because something
// isn't automated?
//
// It was the first. The automation ran exactly as designed every 30 minutes;
// "Coming Soon" is its own RESO StandardStatus and it appeared in none of the
// three status lists in _mls-shared.js, so sync-listings.js dropped the record
// at the door and neither search mode could have returned it even if it had
// been stored. A filter that never anticipated a status looks identical, from
// the outside, to a broken sync -- which is why this suite exists: so the next
// person can tell those two apart in one command.
//
// The invariant that is easy to get wrong here is the LAST one. Widening the
// replicated set must never widen what gets sent to MLS Grid as a $filter
// value: this feed has 400ed on four separate field names that all looked
// standard, and a 400 on the status clause takes out the crawl that fetches
// every listing, not just the new status.
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const shared = require(`${FN_DIR}/lib/_mls-shared.js`);
const fs = require("fs");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const {
  REPLICATED_STATUSES, FILTER_STATUSES, MINE_STATUSES, PUBLIC_STATUSES,
  matchesQuery,
} = shared;

// --- the status contract ---------------------------------------------------
check("Coming Soon is replicated into storage",
  REPLICATED_STATUSES.includes("Coming Soon"), REPLICATED_STATUSES.join("|"));
check("Coming Soon is visible on her own listings",
  MINE_STATUSES.includes("Coming Soon"), MINE_STATUSES.join("|"));
check("Coming Soon is visible on the public search (Christine's call, 2026-09-01)",
  PUBLIC_STATUSES.includes("Coming Soon"), PUBLIC_STATUSES.join("|"));

// The compliance floor this codebase has held since launch. Sold/Closed must
// never be replicated, searchable, or displayable, whatever else changes.
for (const gone of ["Closed", "Sold", "Expired", "Withdrawn", "Canceled"]) {
  check(`${gone} is still never replicated`,
    !REPLICATED_STATUSES.includes(gone), REPLICATED_STATUSES.join("|"));
}

// --- the 400-safety invariant ----------------------------------------------
check("the $filter status list stays a SUBSET of the replicated list",
  FILTER_STATUSES.every((s) => REPLICATED_STATUSES.includes(s)),
  FILTER_STATUSES.join("|"));
check("no unproven status value is sent to MLS Grid as a $filter value",
  !FILTER_STATUSES.includes("Coming Soon"), FILTER_STATUSES.join("|"));

const sync = fs.readFileSync(`${FN_DIR}/sync-listings.js`, "utf8");
check("statusClause() defaults to the proven list, not the replicated one",
  /function statusClause\(statuses\) \{\s*const list = statuses \|\| FILTER_STATUSES;/.test(sync),
  "statusClause() no longer defaults to FILTER_STATUSES");
check("office-wide discovery falls back instead of giving up on a rejected status",
  /narrowed = true;\s*url = pageUrl\(FILTER_STATUSES\);/.test(sync));

// --- what the search actually returns --------------------------------------
const listing = (over) => ({
  listingId: "IRE900010", address: "357 Blue Azurite", city: "Loveland",
  state: "CO", price: 1200000, beds: 4, baths: 3, sqft: 3000,
  agentName: "Christine Gwinnup", coAgentName: null, mlgCanView: true,
  status: "Coming Soon", ...over,
});

check("her Coming Soon listing is returned by mine=true",
  matchesQuery(listing(), { mine: "true" }) === true);
check("and by the public search",
  matchesQuery(listing(), {}) === true);
check("a Coming Soon listing that is NOT hers stays out of mine=true",
  matchesQuery(listing({ agentName: "Someone Else" }), { mine: "true" }) === false);
check("a sold listing is still returned by neither",
  matchesQuery(listing({ status: "Closed" }), { mine: "true" }) === false &&
  matchesQuery(listing({ status: "Closed" }), {}) === false);
check("a Coming Soon listing still has to clear the luxury floor publicly",
  matchesQuery(listing({ price: 400000 }), {}) === false);
check("and still answers a city filter honestly",
  matchesQuery(listing(), { city: "Greeley" }) === false);

// --- how it is labelled to a visitor ---------------------------------------
// Read off the generated page rather than the source template: what a buyer
// sees is the built HTML, and that is the thing that has regressed before.
const built = fs.readFileSync(`${ROOT}/site/current-listings.html`, "utf8");
check("the card badge says Coming Soon in plain language",
  /label: 'Coming Soon', cls: 'status-coming-soon'/.test(built));
check("a Coming Soon home never offers Request A Tour",
  /label: 'Coming Soon', cls: 'status-coming-soon', tourable: false/.test(built));
check("Coming Soon is matched BEFORE the contract/pending branch",
  built.indexOf("coming soon") < built.indexOf("s.indexOf('contract')"),
  "order swapped — 'Coming Soon' would fall through to Under Contract");
check("it gets its own ribbon, not the under-contract one",
  /ribbon-coming-soon">Coming Soon</.test(built));

const css = fs.readFileSync(`${ROOT}/build/assets/css/style.css`, "utf8");
const colour = (re) => (css.match(re) || [])[1];
check("its badge colour is not the under-contract colour",
  colour(/\.listing-status-badge\.status-coming-soon \{ background: (#[0-9a-f]{6}); \}/) !==
  colour(/\.listing-status-badge\.status-pending \{ background: (#[0-9a-f]{6}); \}/),
  "sharing a colour with Under Contract is how a glance reads the wrong status");

// --- the shared copy on the other site must not drift ----------------------
// thelittleladysellshomes.com proxies every MLS call here, but keeps a
// byte-identical copy of _mls-shared.js. Checked only when that checkout is
// actually present, so this suite still passes in CI where it is not.
const sibling = require("path").resolve(ROOT, "..", "thelittleladysellshomes",
  "netlify", "functions", "lib", "_mls-shared.js");
if (fs.existsSync(sibling)) {
  check("the sibling site's copy of _mls-shared.js is identical",
    fs.readFileSync(sibling, "utf8") === fs.readFileSync(`${FN_DIR}/lib/_mls-shared.js`, "utf8"));
} else {
  console.log("  --   sibling checkout not present; skipping drift check");
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
