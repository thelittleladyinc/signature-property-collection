// A listing that resolves to no photos must be REMEMBERED, and an outage must not be.
//
// 2026-08-17. resolveMediaFor() skipped any listing that came back with an empty
// Media array and wrote nothing to the cache. The cache is the only thing that
// stops a lookup, so that listing was re-resolved on every page view, forever --
// prewarmPhotoUrls() rebuilt it into `needed` on every single request.
//
// Why that costs photos rather than just requests: the MLS Grid account's rate
// limits are shared with Christine's two other apps, and every 429 sets the
// photo cooldown, which makes listing-photo.js serve grey placeholders for the
// OTHER cards on the same page. So a couple of photo-less listings sitting in a
// popular result set could take out photos on listings that had them.
//
// The dangerous half of the fix is the half this suite mostly exists for: a
// negative cache must record "the feed answered, and the answer was no photos",
// never "the feed was down". Caching an outage as an empty verdict would blank
// real photos for the length of the TTL, which is strictly worse than the bug
// being fixed. So each failure mode gets its own check.
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const media = require(path.join(ROOT, "netlify", "functions", "lib", "_media.js"));

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// Minimal in-memory Blobs stand-in that records what was written.
function fakeStore() {
  const data = new Map();
  return {
    data,
    get: async (k) => (data.has(k) ? data.get(k) : null),
    setJSON: async (k, v) => { data.set(k, v); },
    list: async () => ({ blobs: [] }),
  };
}

const OPTS = (store, fetchImpl) => {
  global.fetch = fetchImpl;
  return { store, token: "test-token", baseUrl: "https://api.mlsgrid.test/Property", selectFields: "ListingId" };
};

const withMedia = (id, n) => ({
  ListingId: id,
  Media: Array.from({ length: n }, (_, i) => ({ Order: i, MediaURL: `https://media.test/${id}-${i}.jpg` })),
});

const ok = (value) => async () => ({ ok: true, status: 200, json: async () => ({ value }) });

(async () => {
  // -- 1. The happy path still caches real URLs. ---------------------------
  {
    const store = fakeStore();
    let calls = 0;
    const out = await media.resolveMediaFor(["A1"], OPTS(store, async (...a) => { calls++; return ok([withMedia("A1", 3)])(...a); }));
    check("a listing with media resolves to its URLs", (out.A1 || []).length === 3, JSON.stringify(out));
    const cached = await media.readCachedUrls(store, "A1");
    check("its URLs are cached and fresh", !!cached && cached.fresh && cached.urls.length === 3);
    check("one API call", calls === 1, `made ${calls}`);
  }

  // -- 2. THE BUG: a listing the feed says has no media. -------------------
  {
    const store = fakeStore();
    let calls = 0;
    const fetchImpl = async (...a) => { calls++; return ok([{ ListingId: "B2", Media: [] }])(...a); };
    const out = await media.resolveMediaFor(["B2"], OPTS(store, fetchImpl));
    check("a listing with no media is not reported as resolved", !out.B2);

    const cached = await media.readCachedUrls(store, "B2");
    check(
      "the empty verdict IS cached",
      !!cached && Array.isArray(cached.urls) && cached.urls.length === 0,
      cached === null ? "nothing was written — this is the 2026-08-17 bug" : JSON.stringify(cached)
    );
    check("and it counts as fresh, so lookups stop", !!cached && cached.fresh);

    // The actual regression: a second visit must not touch the API again.
    // prewarmPhotoUrls is the real caller, so drive it rather than assert on
    // the cache shape alone.
    const before = calls;
    await media.prewarmPhotoUrls([{ listingId: "B2" }], OPTS(store, fetchImpl));
    check(
      "a second page view makes NO further API call",
      calls === before,
      `${calls - before} extra call(s) — every page view re-queries MLS Grid`
    );
  }

  // -- 3. An id the feed omits entirely is also a real answer. -------------
  {
    const store = fakeStore();
    const out = await media.resolveMediaFor(["C3"], OPTS(store, ok([])));
    check("an omitted id resolves to nothing", !out.C3);
    const cached = await media.readCachedUrls(store, "C3");
    check("an omitted id is negative-cached too", !!cached && cached.urls.length === 0);
  }

  // -- 4. OUTAGES MUST NOT BE CACHED. -------------------------------------
  // Each of these would, if cached as "no photos", blank a listing's real
  // photos for the whole TTL. That is worse than the bug being fixed, so they
  // are checked one by one rather than as a group.
  const outages = [
    ["429 rate limit", async () => ({ ok: false, status: 429, json: async () => ({}) })],
    ["500 from the feed", async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ["403 forbidden", async () => ({ ok: false, status: 403, json: async () => ({}) })],
    ["a thrown network error", async () => { throw new Error("socket hang up"); }],
    ["a timeout", async () => { const e = new Error("The operation was aborted"); e.name = "TimeoutError"; throw e; }],
    ["unparseable JSON", async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })],
  ];
  for (const [label, fetchImpl] of outages) {
    const store = fakeStore();
    const out = await media.resolveMediaFor(["D4"], OPTS(store, fetchImpl));
    const cached = await media.readCachedUrls(store, "D4");
    check(
      `${label} caches NOTHING`,
      cached === null && !out.D4,
      cached ? "an outage was cached as an empty verdict — real photos would go grey" : "resolved unexpectedly"
    );
  }

  // -- 5. A 429 still sets the cooldown (that behaviour must survive). -----
  {
    const store = fakeStore();
    await media.resolveMediaFor(["E5"], OPTS(store, async () => ({ ok: false, status: 429, json: async () => ({}) })));
    check("a 429 still sets the photo cooldown", (await media.isThrottled(store)) !== null);
  }

  // -- 6. A mixed batch: some with photos, some without. ------------------
  // The realistic shape of a search page, and the case where a bad negative
  // cache would do the most damage.
  {
    const store = fakeStore();
    const out = await media.resolveMediaFor(
      ["F1", "F2", "F3"],
      OPTS(store, ok([withMedia("F1", 5), { ListingId: "F2", Media: [] }, withMedia("F3", 2)]))
    );
    check("mixed batch: the two with photos resolve", (out.F1 || []).length === 5 && (out.F3 || []).length === 2);
    check("mixed batch: the empty one is not resolved", !out.F2);
    const [c1, c2, c3] = await Promise.all(["F1", "F2", "F3"].map((id) => media.readCachedUrls(store, id)));
    check("mixed batch: real photos cached as photos", c1.urls.length === 5 && c3.urls.length === 2);
    check("mixed batch: the empty one cached as empty", c2 && c2.urls.length === 0);
  }

  // -- 7. An empty verdict must expire sooner than a signed URL. ----------
  // A listing that gets its photos uploaded an hour late should not be stuck
  // showing a placeholder for the full URL TTL.
  {
    const store = fakeStore();
    await media.writeCachedUrls(store, "G7", []);
    const entry = store.data.get(media.cacheKey("G7"));
    entry.cachedAt = Date.now() - (15 * 60 * 1000); // 15 min old
    const cached = await media.readCachedUrls(store, "G7");
    check(
      "a 15-minute-old empty verdict has expired",
      !!cached && !cached.fresh,
      "an empty verdict is being held as long as a signed URL"
    );
    // While a real URL list of the same age is still fresh.
    await media.writeCachedUrls(store, "G8", ["https://media.test/x.jpg"]);
    const e8 = store.data.get(media.cacheKey("G8"));
    e8.cachedAt = Date.now() - (15 * 60 * 1000);
    const c8 = await media.readCachedUrls(store, "G8");
    check("a 15-minute-old real URL list is still fresh", !!c8 && c8.fresh);
  }

  console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
