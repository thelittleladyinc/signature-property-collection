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

// ---- 1. BOUNDED. This blob store also holds the ~27,000-listing IRES catalogue, so
// the ceiling matters. The bound that does the work is the INDEX.
//
// 2026-08-17: raised from 0 to 11, and the reasoning inverted. Cover-only was chosen
// because "galleries are roughly 40x the volume for photos a visitor has to click to
// see". True of a 50-photo lightbox; false of the photos the site actually renders.
// listing-page.js shows Math.min(count, 12) of them, and every index above 0 was
// re-downloaded from MLS Grid on every view that missed a CDN edge -- against a
// documented rule that leaves no room: "There is NEVER a reason to download the same
// media more than once."
//
// So the bound must be exactly what a page renders. Below it, the difference is
// handed straight back to MLS Grid; above it, we store photos nobody is shown.
check(
  "the cache covers exactly the photos a listing page renders",
  /PHOTO_CACHE_MAX_INDEX\s*=\s*11/.test(src),
  "the bound has to match listing-page.js's Math.min(count, 12)"
);
// The two really do have to move together, so read the other file rather than
// trusting a comment about it.
{
  const pageSrc = fs.readFileSync(path.join(ROOT, "netlify", "functions", "listing-page.js"), "utf8");
  const m = pageSrc.match(/Math\.min\(count,\s*(\d+)\)/);
  check(
    "and that is still what listing-page.js renders",
    !!m && Number(m[1]) === 12,
    m ? `listing-page renders ${m[1]} photos but the cache bound is 12` : "listing-page's photo count is unreadable"
  );
}
// 2026-08-17, revised the same evening. This used to require the cache to be
// restricted to her own listings. That bound was aimed at the wrong number: she
// found grey cards on her LUXURY SEARCH page, where nothing is hers, and a search
// page full of holes is still a broken search page. Growth is bounded by TRAFFIC --
// a cover is only written after somebody looks at that listing -- not by the size
// of the catalogue. The index bound below is the one doing the real work.
check(
  "the cache is not restricted by ownership any more",
  !/shouldCachePhoto\([^)]*\)\s*\{[^}]*mineListingIds/.test(src),
  "restricting to her listings leaves the public search pages grey"
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
  check("behaviour: a photo her listing page renders IS cached too",
    await __test.shouldCachePhoto(store, MINE, 3) === true,
    "a rendered photo that isn't stored is re-downloaded from MLS Grid on every view");
  check("behaviour: another agent's cover photo IS cached too",
    await __test.shouldCachePhoto(store, NOT_MINE, 0) === true,
    "her public search pages show other agents' listings and they went grey as well");
  check("behaviour: and so are their rendered gallery photos",
    await __test.shouldCachePhoto(store, NOT_MINE, 11) === true,
    "index 11 is the last photo listing-page.js draws");
  check("behaviour: but a photo past what any page shows is NOT",
    await __test.shouldCachePhoto(store, NOT_MINE, 12) === false,
    "storing photos nobody is shown is unbounded growth for no benefit");

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

  // A dead blob store must not change what gets cached -- the decision is now a
  // pure function of the index, so it cannot depend on a read that might fail.
  __test.resetMineCache();
  check("behaviour: the cache decision survives an unreadable store",
    await __test.shouldCachePhoto(fakeStore({ throwOnGet: true }), MINE, 0) === true,
    "the bound must not depend on a blob read that can fail");
  check("behaviour: and still refuses an index past what any page renders",
    await __test.shouldCachePhoto(fakeStore({ throwOnGet: true }), MINE, 40) === false);

  console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
