// What the catalogue blob costs to read, and why.
//
// 2026-08-18, measured on Christine's live luxury search rather than guessed:
//
//   state;dur=366, catalogue;dur=1768, filter;dur=122, prewarm;dur=2482
//
// Reading and parsing 29,150 stored listings is 1.7 seconds of every cold search.
// Filtering all of them is 122ms — so the cost is the SIZE of what is stored, not
// the work done over it, and the fix is to store less rather than to scan faster.
//
// The largest removable field turned out to be `photo`: an MLS Grid signed media
// URL, ~180 characters of token, expiry and object id, written for every listing —
// and one that listings-search.js can never serve, because photoUrlFor() only ever
// returns a STORED url when it is a Cloudinary one. Dead on arrival, expiring
// within the hour, and about 5MB across the catalogue.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const sync = fs.readFileSync(path.join(ROOT, "netlify", "functions", "sync-listings.js"), "utf8");
const search = fs.readFileSync(path.join(ROOT, "netlify", "functions", "listings-search.js"), "utf8");

// The invariant that makes the deletion safe: a stored URL is only ever served
// when it is a Cloudinary one. If that ever stops being true, dropping the field
// starts costing real photos, so it is asserted rather than assumed.
check(
  "a stored photo URL is only served when it is a re-hosted Cloudinary one",
  /const stored = i === 0[\s\S]{0,160}?if \(isRehosted\(stored\)\) return stored;/.test(search),
  "if a raw MLS Grid URL can reach a browser, deleting the field would break photos — " +
  "and serving one would be out of spec anyway"
);
check(
  "so the sync drops non-Cloudinary photo URLs before storing",
  /indexOf\("res\.cloudinary\.com"\) === -1\)\s*\{\s*\n\s*delete slim\.photo;/.test(sync),
  "~180 bytes x 29,150 listings of URLs nothing can use"
);
check(
  "and keeps Cloudinary ones, which ARE served and are permanent",
  /Kept when it IS a Cloudinary URL/.test(sync)
);

// photoCount is what the card actually reads. Deleting `photo` must not take the
// count with it, or every card silently believes it has no photos.
check(
  "the photo COUNT is still stored",
  /slim\.photoCount = slim\.photos\.length;/.test(sync),
  "knownPhotoCount() falls back to `photo ? 1 : 0` — without the count, a 50-photo " +
  "listing would render as having none"
);
const countFn = search.slice(search.indexOf("function knownPhotoCount"));
check(
  "and the card's count prefers it over the photo field",
  /photoCount === "number"\) return listing\.photoCount;/.test(countFn.slice(0, 400)),
  "the order matters: count first, the field only as a last resort"
);

// The cache TTL should be proportionate to how often the data can actually change.
{
  const m = search.match(/max-age=(\d+), stale-while-revalidate=(\d+)/);
  const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  const cron = (toml.match(/schedule = "\*\/(\d+) \* \* \* \*"/) || [])[1];
  check("the search response is cached for minutes, not seconds",
    !!m && Number(m[1]) >= 300,
    m ? `max-age=${m[1]}` : "no Cache-Control found");
  check("but never longer than the sync interval that refreshes the data",
    !!m && !!cron && Number(m[1]) <= Number(cron) * 60,
    m && cron ? `max-age=${m[1]}s vs sync every ${cron}m` : "could not compare");
  check("and stale-while-revalidate covers the gap so nobody waits on a refresh",
    !!m && Number(m[2]) >= Number(m[1]) * 3);
}

// ---- The cleanup has to REACH the listings already stored ------------------
// Both changes below would otherwise have measured as doing nothing at all.
// pruneAndSlimStore only re-slims a record when it still looks like the OLD fat
// shape, and 29,000 already-slimmed records carry neither remarks nor photos[].
// A new field worth dropping has to be named in that test or it is skipped
// forever — and at the crawl's fifty records a run, "eventually" is months.
{
  const fn = sync.slice(sync.indexOf("function pruneAndSlimStore"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  check("the cleanup re-slims records carrying a dead photo URL",
    /hasDeadPhotoUrl/.test(body) && /l\.remarks \|\| Array\.isArray\(l\.photos\) \|\| hasDeadPhotoUrl/.test(body),
    "already-slim records have no remarks and no photos[] — without naming the new " +
    "field, the 5MB stays exactly where it is");

  // Same class of staleness, different field. Christine's luxury page kept showing
  // Fraser because it was stored with county null before "fraser" was in the town
  // table, and a null county is deliberately kept.
  check("the county is re-inferred from the stored city, not trusted",
    /inferCountyFromCity\(String\(l\.city/.test(body),
    "the town table grew from 110 towns to 295 — that has to reach stored listings");
  check("and the re-inferred county is written back",
    /if \(county && county !== l\.county\) l\.county = county;/.test(body),
    "otherwise every run re-derives it and nothing is ever learned");
  check("out-of-area listings are dropped on the re-inferred county",
    /!OPERATING_COUNTIES\.has\(county\)/.test(body),
    "dropping on the STORED county is what let Fraser survive the table fix");
}

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
