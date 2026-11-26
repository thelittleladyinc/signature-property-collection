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
// 2026-09-28: listing display is behind the IDX kill switch (default OFF) and a
// 12-hour freshness guard -- see lib/_idx-display.js and test-idxdisplay.js. This
// suite tests what happens once display is ON with current data.
process.env.IDX_DISPLAY = "on";
// Also 2026-09-28: on Lofty this site renders only Christine's own listings (every
// other home is on her Lofty home search -- tests/test-lofty-source.js). These
// status rules are about any listing, so they are pinned to the MLS Grid path.
process.env.LISTINGS_SOURCE = "mlsgrid";
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const COVER = "https://img.chime.me/image/fs01/mls-listing/original_cover-test.jpeg";
const SECOND = "https://img.chime.me/image/fs01/mls-listing/original_kitchen-test.jpeg";
const LIVE = {
  IRE900001: {
    id: "IRE900001", address: "1 Test St", city: "Loveland", state: "CO",
    price: 500000, status: "Active", beds: 3, baths: 2, sqft: 1800, listingId: "IRE900001", photo: COVER, photos: [COVER, SECOND],
  },
  IRE900002: {
    id: "IRE900002", address: "2 Sold Ave", city: "Windsor", state: "CO",
    price: 600000, status: "Closed", photos: [],
  },
  // 2026-09-01: a coming-soon listing is precisely the link a seller wants to
  // send around BEFORE it hits the market, so a 404 on it is the same dead-link
  // failure the 2026-08-18 under-contract note describes, one status earlier.
  IRE900004: {
    id: "IRE900004", address: "357 Blue Azurite", city: "Loveland", state: "CO",
    price: 1200000, status: "Coming Soon", beds: 4, baths: 3, sqft: 3000,
    agentName: "Christine Gwinnup", photos: [],
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
  get: async (k) => (/listings/i.test(k) ? LIVE : { lastRunAt: "2026-08-16T00:00:00Z", lastSuccessAt: new Date().toISOString() }),
  setJSON: async () => {}, list: async () => ({ blobs: [] }),
});

(async () => {
  process.env.BLOBS_SITE_ID = "s"; process.env.BLOBS_TOKEN = "t";

  // --- the happy path still works ------------------------------------------
  let res = await load(okStore)({ queryStringParameters: { id: "IRE900001" } });
  check("a live listing renders 200", res.statusCode === 200, String(res.statusCode));
  check("and is indexable", !/noindex/i.test(JSON.stringify(res.headers || {})));

  const images = html => html.match(/<img\b[^>]+>/g) || [];
  const propertyLinks = [...res.body.matchAll(/href="(\/contact\.html\?intent=[^"]+)"/g)]
    .map(match => new URL(match[1].replace(/&amp;/g, "&"), "https://signaturepropertycollection.com"));
  check("Signature showing and question links carry the correct property",
    ["showing", "question"].every(intent => propertyLinks.some(url =>
      url.searchParams.get("intent") === intent && url.searchParams.get("mls") === "IRE900001" &&
      url.searchParams.get("address") === "1 Test St, Loveland")));
  const defaultCovers = images(res.body).filter(tag => tag.includes("cover-test.jpeg"));
  check("Signature keeps its existing hero and thumbnail", defaultCovers.length === 2 && defaultCovers.every(tag => !tag.includes("srcset=")));
  res = await load(okStore)({ queryStringParameters: { id: "IRE900001", brand: "tllsh" } });
  const littleLadyImages = images(res.body);
  const covers = littleLadyImages.filter(tag => tag.includes("cover-test.jpeg"));
  check("Little Lady uses one high-priority responsive cover", covers.length === 1 &&
    ['fetchpriority="high"', '600w', '720w', '1200w', 'sizes='].every(value => covers[0].includes(value)));
  check("Little Lady keeps its second photo lazy and correctly numbered",
    littleLadyImages.some(tag => tag.includes("kitchen-test.jpeg") && tag.includes('loading="lazy"') && tag.includes("photo 2")));

  // --- genuinely gone is a 404, which is correct and must stay -------------
  res = await load(okStore)({ queryStringParameters: { id: "IRE999999" } });
  check("an unknown listing is 404, not 5xx", res.statusCode === 404, String(res.statusCode));
  res = await load(okStore)({ queryStringParameters: { id: "IRE900002" } });
  check("a sold listing is 404, not 5xx", res.statusCode === 404, String(res.statusCode));
  res = await load(okStore)({ queryStringParameters: { id: "!!bad!!" } });
  check("a malformed id is 404, not 5xx", res.statusCode === 404, String(res.statusCode));

  // --- coming soon renders, and says so rather than claiming to be active ---
  res = await load(okStore)({ queryStringParameters: { id: "IRE900004" } });
  check("a coming-soon listing renders 200, not 404", res.statusCode === 200,
    String(res.statusCode));
  check("and says coming soon on the page", /coming soon/i.test(res.body || ""));
  check("and never calls itself an active listing",
    !/Active IRES MLS listing/.test(res.body || ""),
    "the meta description would be making a false freshness claim");

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
      : { lastSuccessAt: new Date().toISOString() }),
    setJSON: async () => {}, list: async () => ({ blobs: [] }),
  });
  res = await load(poisonStore)({ queryStringParameters: { id: "IRE900003" } });
  check("a real rendering fault is still 500, not disguised as an outage",
    res.statusCode === 500, String(res.statusCode));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
