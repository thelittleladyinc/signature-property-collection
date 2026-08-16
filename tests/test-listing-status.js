// What HTTP status a listing page returns, and why each one matters to Google.
//
// 2026-08-16. Christine's Search Console coverage export reported 12 pages under
// "Server error (5xx)". listing-page.js was the only thing on the site capable of
// producing one, and tracing it showed the 500 could only come from the Netlify Blobs
// read failing -- a brief outage or a token problem, not a broken page.
//
// 500 is the wrong answer to that, and not cosmetically. A 500 tells Google the page
// is broken: repeated 500s cost crawl rate across the whole site and can drop pages
// from the index. 503 with Retry-After tells it the truth -- temporarily unavailable
// -- which Google handles without penalty.
//
// The opposite error matters just as much, which is why the 500 case is pinned too:
// reporting a genuine rendering bug as a transient outage would hide it forever.
//
// Repo root derived from this file's own location, never hardcoded: these suites
// run both locally and in GitHub Actions, where the checkout is at
// /home/runner/work/<repo>/<repo>. An absolute path would pass here and fail there.
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const LIVE = {
  IRE900001: {
    id: "IRE900001", address: "1 Test St", city: "Loveland", state: "CO",
    price: 500000, status: "Active", beds: 3, baths: 2, sqft: 1800, photos: [],
  },
  IRE900002: {
    id: "IRE900002", address: "2 Sold Ave", city: "Windsor", state: "CO",
    price: 600000, status: "Closed", photos: [],
  },
};

// store: a function returning the fake store, so each case can fail differently.
function load(store) {
  require.cache[blobsPath] = {
    id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: store },
  };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  return require(`${FN_DIR}/listing-page.js`).handler;
}
const okStore = () => ({
  get: async (k) => (/listings/i.test(k) ? LIVE : { lastRunAt: "2026-08-16T00:00:00Z" }),
  setJSON: async () => {}, list: async () => ({ blobs: [] }),
});

(async () => {
  process.env.BLOBS_SITE_ID = "s"; process.env.BLOBS_TOKEN = "t";

  // --- the happy path still works ------------------------------------------
  let res = await load(okStore)({ queryStringParameters: { id: "IRE900001" } });
  check("a live listing renders 200", res.statusCode === 200, String(res.statusCode));
  check("and is indexable", !/noindex/i.test(JSON.stringify(res.headers || {})));

  // --- genuinely gone is a 404, which is correct and must stay -------------
  res = await load(okStore)({ queryStringParameters: { id: "IRE999999" } });
  check("an unknown listing is 404, not 5xx", res.statusCode === 404, String(res.statusCode));
  res = await load(okStore)({ queryStringParameters: { id: "IRE900002" } });
  check("a sold listing is 404, not 5xx", res.statusCode === 404, String(res.statusCode));
  res = await load(okStore)({ queryStringParameters: { id: "!!bad!!" } });
  check("a malformed id is 404, not 5xx", res.statusCode === 404, String(res.statusCode));

  // --- the actual finding: a Blobs outage must be 503, not 500 -------------
  const downStore = () => ({
    get: async () => { throw new Error("blobs unavailable"); },
    setJSON: async () => {}, list: async () => ({ blobs: [] }),
  });
  res = await load(downStore)({ queryStringParameters: { id: "IRE900001" } });
  check("a listing-store outage is 503, not 500", res.statusCode === 503, String(res.statusCode));
  const h = res.headers || {};
  check("it tells crawlers when to come back", String(h["Retry-After"] || "") !== "",
    JSON.stringify(h));
  check("an outage is never cached as the page's content",
    /no-store/.test(String(h["Cache-Control"] || "")), String(h["Cache-Control"]));
  check("and is not indexed while it is failing",
    /noindex/i.test(String(h["X-Robots-Tag"] || "")));
  check("the visitor is told something useful, not shown a stack trace",
    /refresh/i.test(res.body || "") && !/blobs unavailable/i.test(res.body || ""));

  // --- but a REAL bug must still be a 500 ----------------------------------
  // Store reads fine; the listing data is shaped so rendering throws. If this came
  // back 503 it would mean a genuine defect was being reported as an outage, and
  // nobody would ever chase it.
  const poisonStore = () => ({
    get: async (k) => (/listings/i.test(k)
      ? { IRE900003: { get status() { throw new Error("boom"); } } }
      : null),
    setJSON: async () => {}, list: async () => ({ blobs: [] }),
  });
  res = await load(poisonStore)({ queryStringParameters: { id: "IRE900003" } });
  check("a real rendering fault is still 500, not disguised as an outage",
    res.statusCode === 500, String(res.statusCode));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
