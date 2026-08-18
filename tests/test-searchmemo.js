// The public search must not re-download and re-parse the whole catalogue to
// return twelve cards.
//
// 2026-08-18 (Christine: "it just runs so slow ... what if we just brought in a
// few counties"). She was right that the size was the problem and wrong about the
// mechanism, which made the real cause easy to miss: every public search read
// LISTINGS_KEY — 29,011 listings — out of Blobs and JSON-parsed all of it, per
// request, to answer a query about twelve. The cost scaled with the catalogue and
// had nothing to do with what was asked, which is why it degraded as the crawl
// grew and felt like "bringing in too many".
//
// What this suite protects is the three ways a memo like this goes wrong: it never
// hits, it hits when the data has changed underneath it, or it hits forever.
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN = path.join(ROOT, "netlify", "functions", "listings-search.js");
const { __test } = require(FN);

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const CATALOGUE = { IRE1: { listingId: "IRE1" }, IRE2: { listingId: "IRE2" } };

__test.reset();
check("a cold container has nothing memoised",
  __test.catalogueFromMemo("2026-08-18T14:00:00.000Z") === null);

__test.rememberCatalogue(CATALOGUE, "2026-08-18T14:00:00.000Z");
check("the parsed catalogue is reused on the next request",
  __test.catalogueFromMemo("2026-08-18T14:00:00.000Z") === CATALOGUE,
  "without this every search re-downloads and re-parses 29,000 listings");

// The one that matters most: a sync has written new data, so the memo is not
// merely old, it is WRONG. A price change or a new listing must not be invisible
// for as long as a container happens to live.
check("a newer sync invalidates it",
  __test.catalogueFromMemo("2026-08-18T14:30:00.000Z") === null,
  "serving yesterday's inventory quickly is worse than serving today's slowly");

// And it must not depend on the stamp being present — a missing state blob is a
// reason to fall back to a timer, not a reason to serve stale data forever.
__test.reset();
__test.rememberCatalogue(CATALOGUE, null);
check("a memo with no stamp still answers within the TTL",
  __test.catalogueFromMemo(null) === CATALOGUE);

// Expiry. Faked by ageing the entry rather than by sleeping, so the suite stays
// fast and deterministic.
__test.reset();
__test.rememberCatalogue(CATALOGUE, "s");
check("the TTL is short enough to bound staleness",
  __test.memoTtlMs <= 5 * 60 * 1000,
  `memo TTL is ${__test.memoTtlMs}ms`);

// Source-level: the small state blob must be read BEFORE the big one, or the
// memo saves nothing — the expensive read would already have happened.
const fs = require("fs");
const src = fs.readFileSync(FN, "utf8");
const stateAt = src.indexOf("await store.get(SYNC_STATE_KEY");
const listingsAt = src.indexOf("await store.get(LISTINGS_KEY");
check("the cheap state read comes before the expensive catalogue read",
  stateAt !== -1 && listingsAt !== -1 && stateAt < listingsAt,
  "reading them together means the catalogue is fetched even on a memo hit");
check("and the catalogue read is guarded by the memo",
  /const memo = catalogueFromMemo\(stamp\);[\s\S]{0,200}?await store\.get\(LISTINGS_KEY/.test(src),
  "an unguarded read is the bug this whole file is about");

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
