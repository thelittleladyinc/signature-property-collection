// The site keeps its own copy of Christine's cover photos, so a rate limit at MLS
// Grid stops being something a visitor can see.
//
// 2026-08-17, after she said "photos still arent showing" for the fourth time in a
// day. Every explanation given to her was true and none of them fixed anything: the
// media host was 429ing, the CDN could not help because a photo that never succeeded
// has nothing to cache, and the permanent fix (Cloudinary re-hosting) was blocked on
// credentials only she can set. Meanwhile her main listings page had a hole in it.
//
// What this suite protects is not "the cache works" -- it is the four ways a cache
// like this quietly becomes a liability.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const FN = path.join(ROOT, "netlify", "functions", "listing-photo.js");
const src = fs.readFileSync(FN, "utf8");

// It has to load at all -- every check below is static.
try { require(FN); check("listing-photo.js loads", true); }
catch (err) { check("listing-photo.js loads", false, err && err.message); }

// ---- 1. BOUNDED. This blob store also holds the ~27,000-listing IRES catalogue.
// An image cache with no ceiling over that is gigabytes of storage nobody asked for,
// and it would grow fastest exactly when the site is busiest.
check(
  "only cover photos are cached",
  /PHOTO_CACHE_MAX_INDEX\s*=\s*0/.test(src),
  "caching whole galleries turns 11 listings into hundreds of megabytes"
);
check(
  "and only Christine's own listings",
  /shouldCachePhoto[\s\S]{0,400}?mineListingIds/.test(src),
  "a visitor browsing other agents' listings must not fill this store"
);
check(
  "the index bound is enforced on read as well as write",
  /function readCachedPhoto[\s\S]{0,200}?index > PHOTO_CACHE_MAX_INDEX/.test(src),
  "an unbounded read invites an unbounded write later"
);

// ---- 2. NEVER MAKES THINGS WORSE. A cache miss, a malformed entry or a dead blob
// store must not turn a photo that WOULD have worked into an error.
for (const [what, fn] of [["read", "readCachedPhoto"], ["write", "writeCachedPhoto"]]) {
  const at = src.indexOf(`async function ${fn}(`);
  const body = at === -1 ? "" : src.slice(at, src.indexOf("\n}", at));
  check(`the cache ${what} is wrapped in try/catch`, /try\s*\{/.test(body) && /catch/.test(body),
    `${fn} can throw into the request path`);
}

// ---- 3. THE WRITE MUST ACTUALLY HAPPEN. A Netlify function can be frozen the
// moment it returns, so an unawaited write finishes only sometimes -- and a cache
// that is sometimes written is worse than none, because the failure it exists to
// cover then appears at random and looks like a different bug.
check(
  "the cache write is awaited, not fired and forgotten",
  /await writeCachedPhoto\(/.test(src),
  "unawaited work is not reliably completed before the container freezes"
);

// ---- 4. IT MUST NOT LIE ABOUT WHAT IS MISSING. A stored copy is the right answer
// when the photo exists and we could not fetch it NOW. It is the wrong answer when
// there is no such photo -- serving a stale image for "this listing has no photos"
// or a malformed id would be inventing content.
const RESCUABLE = ["throttled", "media_rate_limited", "image_fetch_failed",
                   "image_http_error", "not_an_image", "too_large"];
for (const reason of RESCUABLE) {
  check(
    `a "${reason}" failure tries the stored copy first`,
    new RegExp(`servedOrPlaceholder\\(store, listingId, index, "${reason}"`).test(src),
    "this is a photo that exists and could not be fetched — the copy is the right answer"
  );
}
const NEVER = ["bad_id", "not_configured", "no_media", "index_out_of_range"];
for (const reason of NEVER) {
  check(
    `a "${reason}" failure does NOT serve a stored copy`,
    new RegExp(`placeholder\\("${reason}"`).test(src) &&
      !new RegExp(`servedOrPlaceholder\\([^)]*"${reason}"`).test(src),
    "there is no such photo — serving one would be inventing content"
  );
}

// ---- 5. DEBUG MUST KEEP TELLING THE TRUTH. ?debug=1 exists to answer "why is this
// photo grey". If it served the cached image it would answer a different question and
// hide the failure being investigated -- and that endpoint is the only tool Christine
// has for this. It has spent all day being the thing that finally explains a photo.
const doorAt = src.indexOf("async function servedOrPlaceholder(");
const door = doorAt === -1 ? "" : src.slice(doorAt, src.indexOf("\n}", doorAt));
check(
  "?debug=1 bypasses the cache and still describes the live fetch",
  /if \(!debug/.test(door),
  "debug output that shows a cached success cannot explain a failure"
);

// And a served copy has to be identifiable in a network tab, or the next person
// debugging a photo cannot tell a live fetch from a stored one.
check(
  "a served copy is labelled in the response headers",
  /X-Photo-Cache/.test(src),
  "an invisible cache is one nobody can debug"
);

// ---- BEHAVIOUR, not just source text. Everything above greps this file; none of it
// proves the cache actually does what the comments claim. These drive the real
// functions against a fake store.
const { __test } = require(FN);
const MINE = "IRE1059948";       // her Greeley listing — the card that went grey
const NOT_MINE = "IRE9999999";   // somebody else's, from the 27k catalogue

function fakeStore(opts) {
  const o = opts || {};
  const data = { "mine-listings.json": [{ listingId: MINE }] };
  return {
    written: data,
    async get(key) {
      if (o.throwOnGet) throw new Error("blobs unavailable");
      return data[key] === undefined ? null : data[key];
    },
    async setJSON(key, val) {
      if (o.throwOnSet) throw new Error("blobs read-only");
      data[key] = val;
    },
  };
}

(async () => {
  // Bounds, for real.
  __test.resetMineCache();
  let store = fakeStore();
  check("behaviour: her cover photo IS cached", await __test.shouldCachePhoto(store, MINE, 0) === true);
  check("behaviour: a gallery photo of hers is NOT", await __test.shouldCachePhoto(store, MINE, 3) === false,
    "index bound not enforced");
  check("behaviour: another agent's cover photo is NOT", await __test.shouldCachePhoto(store, NOT_MINE, 0) === false,
    "this is what keeps 27,000 listings out of the store");

  // Round trip.
  const buf = Buffer.from("fake-jpeg-bytes");
  await __test.writeCachedPhoto(store, MINE, 0, buf, "image/jpeg");
  const hit = await __test.readCachedPhoto(store, MINE, 0);
  check("behaviour: a written photo reads back", !!hit && hit.b64 === buf.toString("base64"));
  check("behaviour: and keeps its content type", hit && hit.contentType === "image/jpeg");
  check("behaviour: a photo never written reads back as a miss",
    (await __test.readCachedPhoto(store, "IRE0000000", 0)) === null);

  // Never fatal. A dead blob store must degrade to "no cache", not to an exception
  // in the request path — that would turn a rate-limited photo into a broken page.
  __test.resetMineCache();
  const deadRead = fakeStore({ throwOnGet: true });
  let threw = false;
  try { await __test.readCachedPhoto(deadRead, MINE, 0); } catch (e) { threw = true; }
  check("behaviour: a store that throws on read does not throw at the caller", !threw);

  __test.resetMineCache();
  const deadWrite = fakeStore({ throwOnSet: true });
  threw = false;
  try { await __test.writeCachedPhoto(deadWrite, MINE, 0, buf, "image/jpeg"); } catch (e) { threw = true; }
  check("behaviour: a store that throws on write does not throw at the caller", !threw);

  // And an unreadable mine-listings key must mean "cache nothing", not "cache all".
  __test.resetMineCache();
  check("behaviour: if her listing list is unreadable, nothing is cached",
    await __test.shouldCachePhoto(fakeStore({ throwOnGet: true }), MINE, 0) === false,
    "failing open here would fill the store with the whole catalogue");

  console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
