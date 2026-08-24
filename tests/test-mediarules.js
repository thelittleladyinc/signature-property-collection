// The rules MLS Grid's own documentation lays down for its Media, and which this
// codebase broke in five separate places at once. Every check here corresponds to a
// sentence in their docs, quoted where it matters, because each of these bugs
// produced the same symptom -- a grey card -- and was therefore spent all day being
// mistaken for a rate limit.
//
// The five, in the order they were found:
//   1. Media URLs are SINGLE-USE, and we cached them for forty minutes.
//   2. "You must maintain your own copy of all media files" / "There is NEVER a
//      reason to download the same media more than once" -- and detail pages
//      re-downloaded photos 1-11 on every view.
//   3. The URL format effective 8 Sept 2026 is signed in the PATH, with no query
//      string, which the presigned heuristic could not see.
//   4. "ALL requests... MUST include the HTTP header User-Agent [= the token].
//      Any User-Agent that is not your Oauth 2 access token will be blocked."
//   5. "no more than 5 'or' operators per query", and "Each request must contain a
//      single OriginatingSystemName".
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const media = require(path.join(ROOT, "netlify", "functions", "lib", "_media.js"));

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

function fakeStore() {
  const data = new Map();
  return {
    data,
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async setJSON(key, val) { data.set(key, JSON.parse(JSON.stringify(val))); },
  };
}

// Captures every request the code makes, and answers with whatever the test wants.
function stubFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return handler(String(url), opts || {}, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

// URLSearchParams encodes spaces as '+', so a decoded query still reads as
// "ListingId+in+(...)". Normalise before asserting on the OData, or the assertions
// quietly test the encoding rather than the filter.
function readable(url) {
  return decodeURIComponent(String(url)).replace(/\+/g, " ");
}

function jsonResponse(body, status) {
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    headers: { get: () => null },
    async json() { return body; },
  };
}

const RESOLVE_OPTS = {
  token: "TOKEN123", baseUrl: "https://api.mlsgrid.com/v2/Property",
  selectFields: "ListingId", timeoutMs: 1000,
};

(async () => {
  // ---- 1. SINGLE-USE ------------------------------------------------------
  // "Single-use — the URL may be used to download its image only once. A second
  // request using the same URL will fail."
  {
    const store = fakeStore();
    await media.writeCachedUrls(store, "IRE1", ["u0", "u1", "u2"]);
    let cached = await media.readCachedUrls(store, "IRE1");
    check("a freshly resolved URL is usable", media.usableUrl(cached, 0) === "u0");

    await media.markUrlUsed(store, "IRE1", 0);
    cached = await media.readCachedUrls(store, "IRE1");
    check("a spent URL is never handed out again",
      media.usableUrl(cached, 0) === null,
      "replaying a single-use URL is a guaranteed failure that looks exactly like a 429");
    check("and spending one does not affect the others",
      media.usableUrl(cached, 1) === "u1" && media.usableUrl(cached, 2) === "u2",
      "a gallery would re-resolve on every photo");
    check("a spent URL stays spent even while the entry is fresh",
      cached.fresh === true && media.usableUrl(cached, 0) === null,
      "freshness is a clock; single-use is not");

    // Re-resolving the listing issues new URLs, so the slate is clean again.
    await media.writeCachedUrls(store, "IRE1", ["n0", "n1", "n2"]);
    cached = await media.readCachedUrls(store, "IRE1");
    check("a re-resolve clears the spent marks", media.usableUrl(cached, 0) === "n0");

    // Marking twice must not corrupt the entry or lose the URLs.
    await media.markUrlUsed(store, "IRE1", 0);
    await media.markUrlUsed(store, "IRE1", 0);
    cached = await media.readCachedUrls(store, "IRE1");
    check("marking the same index twice is harmless",
      cached.urls.length === 3 && media.usableUrl(cached, 1) === "n1");

    // A store that throws must not take the request down with it.
    let threw = false;
    try {
      await media.markUrlUsed({ async get() { throw new Error("blobs down"); } }, "IRE1", 0);
    } catch (e) { threw = true; }
    check("a dead store cannot break marking a URL used", !threw);
  }

  // ---- 5. THE QUERY SHAPE -------------------------------------------------
  {
    const store = fakeStore();
    const ids = Array.from({ length: 12 }, (_, i) => `IRE10000${i}`);
    const f = stubFetch(() => jsonResponse({ value: [] }));
    await media.resolveMediaFor(ids, { store, ...RESOLVE_OPTS });
    f.restore();

    check("a 12-listing page is still ONE request", f.calls.length === 1);
    const url = readable(f.calls[0].url);
    check("every request names its OriginatingSystemName",
      url.includes("OriginatingSystemName eq 'ires'"),
      "MLS Grid: 'Each request must contain a single OriginatingSystemName'");
    check("ids go out as an `in` list, not an or-chain",
      /ListingId in \(/.test(url),
      "MLS Grid: 'It is preferred to use the in operator'");
    const ors = (url.match(/ or /g) || []).length;
    check("no more than five `or` operators are ever sent",
      ors <= 5,
      `sent ${ors} — MLS Grid's documented ceiling is 5, and the old or-chain sent 11`);
    check("MlgCanView is still enforced server-side", url.includes("MlgCanView eq true"));
  }

  // The fallback: if this feed ever rejects `in`, photos must not all go grey.
  {
    const store = fakeStore();
    const ids = Array.from({ length: 12 }, (_, i) => `IRE20000${i}`);
    const f = stubFetch((url) => {
      if (/ListingId in \(/.test(readable(url))) return jsonResponse({ error: "no" }, 400);
      return jsonResponse({ value: [] });
    });
    await media.resolveMediaFor(ids, { store, ...RESOLVE_OPTS });
    f.restore();

    const fallbacks = f.calls.slice(1).map((c) => readable(c.url));
    check("a 400 on `in` falls back rather than returning nothing", fallbacks.length > 0,
      "one rejected query syntax must not blank an entire page");
    check("the fallback still covers all twelve ids",
      fallbacks.reduce((n, u) => n + (u.match(/ListingId eq /g) || []).length, 0) === 12);
    const worst = Math.max(...fallbacks.map((u) => (u.match(/ or /g) || []).length));
    check("and every fallback request stays inside the five-`or` ceiling", worst <= 5,
      `worst request had ${worst} or operators`);
    check("the fallback still names the originating system",
      fallbacks.every((u) => u.includes("OriginatingSystemName eq 'ires'")));
  }

  // A batch bigger than the cap must be logged, never silently truncated -- that
  // silence is what let half of a 24-card page go unwarmed with no trace.
  {
    const store = fakeStore();
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(" "));
    const f = stubFetch(() => jsonResponse({ value: [] }));
    await media.resolveMediaFor(Array.from({ length: 40 }, (_, i) => `IRE3${i}`), { store, ...RESOLVE_OPTS });
    f.restore();
    console.warn = realWarn;
    check("an over-cap batch says so out loud",
      warnings.some((w) => /resolveMediaFor: 40 ids requested/.test(w)),
      "silent truncation reads as 'nothing found' forever");
  }

  // The cap must cover the largest page listings-search.js will actually serve.
  {
    const searchSrc = fs.readFileSync(path.join(ROOT, "netlify", "functions", "listings-search.js"), "utf8");
    const m = searchSrc.match(/parseInt\(params\.top, 10\) \|\| 12, (\d+)\)/);
    check("the batch cap covers the biggest page the search will return",
      !!m && media.MAX_IDS_PER_BATCH >= Number(m[1]),
      m ? `top can be ${m[1]} but the batch cap is ${media.MAX_IDS_PER_BATCH}` : "could not read the top clamp");
  }

  // ---- 3. THE NEW MEDIA URL FORMAT ---------------------------------------
  // Effective 8 September 2026 the signature moves into the PATH and there is no
  // query string at all. The old heuristic read only the query string, so it called
  // every new URL unsigned and sent Bearer alongside a signature.
  {
    const NEW_FORMAT = "https://media.mlsgrid.com/token=OlQCGcw0eHIb7&expires=1785214585&" +
      "id=6a5fd94b01ecf70f22bafd26/images/IRE781897278/763177d0.jpeg";
    check("the new path-signed media URL is recognised as signed",
      media.looksPresigned(NEW_FORMAT) === true,
      "an unrecognised signature means Bearer rides along and MLS Grid 403s it");
    check("a legacy pre-signed AWS URL still is too",
      media.looksPresigned("https://s3.amazonaws.com/x/y.jpg?X-Amz-Signature=abc&X-Amz-Credential=d") === true);
    check("an ordinary URL is still treated as unsigned",
      media.looksPresigned("https://example.com/photo.jpg") === false,
      "calling everything signed would drop the token from URLs that need it");
    check("a malformed URL does not throw",
      media.looksPresigned("not a url at all") === false);
  }

  // ---- 4. THE USER-AGENT --------------------------------------------------
  // "Any User-Agent that is not your Oauth 2 access token will be blocked by our
  // service." It was sent in `auth` mode only -- and `anon` is the FIRST mode tried
  // for a signed URL, which is now most of them.
  {
    const f = stubFetch(() => ({ ok: true, status: 200, headers: { get: () => "image/jpeg" } }));
    await media.fetchMediaResponse("https://media.mlsgrid.com/token=a&expires=1&id=b/images/x.jpg", "TOKEN123", 500);
    f.restore();
    const headers = f.calls[0].opts.headers || {};
    check("the anonymous mode is used first for a signed URL",
      headers.Authorization === undefined,
      "a second auth mechanism on a pre-signed URL is a 403");
    check("and it STILL sends the access token as User-Agent",
      headers["User-Agent"] === "TOKEN123",
      "MLS Grid blocks any User-Agent that is not the token — this was the bug");
  }
  {
    const f = stubFetch(() => ({ ok: true, status: 200, headers: { get: () => "image/jpeg" } }));
    await media.fetchMediaResponse("https://example.com/plain.jpg", "TOKEN123", 500);
    f.restore();
    const headers = f.calls[0].opts.headers || {};
    check("an unsigned URL is fetched with the Bearer token",
      headers.Authorization === "Bearer TOKEN123");
    check("and it carries the User-Agent too",
      headers["User-Agent"] === "TOKEN123");
  }
  {
    // Both modes on a failure, and both must be compliant -- the retry is exactly
    // where a missing header would hide.
    const f = stubFetch(() => ({ ok: false, status: 403, headers: { get: () => null } }));
    await media.fetchMediaResponse("https://example.com/plain.jpg", "TOKEN123", 500);
    f.restore();
    check("a 403 retries in the other mode", f.calls.length === 2);
    check("and every attempt sends the User-Agent",
      f.calls.every((c) => (c.opts.headers || {})["User-Agent"] === "TOKEN123"),
      "the retry is the request most likely to be the one that mattered");
  }

  // ---- 2. OUR OWN COPY COMES FIRST ---------------------------------------
  // "You must maintain your own copy of all media files." A stored photo must be
  // answered from the store before MLS Grid is contacted at all -- when the check
  // lived only on the failure paths, every cache hit still cost a resolve.
  {
    const src = fs.readFileSync(path.join(ROOT, "netlify", "functions", "listing-photo.js"), "utf8");
    const handlerAt = src.indexOf("exports.handler");
    const body = src.slice(handlerAt);
    const storedAt = body.indexOf("await readCachedPhoto(");
    const resolveAt = body.indexOf("await resolvePhotoUrl(");
    check("the handler asks its own store before it asks MLS Grid",
      storedAt !== -1 && resolveAt !== -1 && storedAt < resolveAt,
      "MLS Grid: 'There is NEVER a reason to download the same media more than once'");
    check("a stored photo is served even with no API token configured",
      storedAt < body.indexOf("not_configured"),
      "our own copy does not depend on MLS Grid being reachable");
    check("every URL handed to a download is then marked used",
      /await markUrlUsed\(store, listingId, index\)/.test(body),
      "an unmarked URL gets replayed to the next visitor and fails by definition");
    // 2026-08-24: the retry carries the allowResolve gate too — a WARM listing
    // still gets its one fresh-URL retry; a cold one never resolves at all
    // (see tests/test-coldgate.js for the gate itself).
    check("a failed CACHED url is retried once with a fresh one",
      /resolvePhotoUrl\(listingId, index, store, token, true, allowResolve\)/.test(body),
      "otherwise a spent URL is indistinguishable from a dead photo");
    check("but a 429 is never retried",
      /status !== 429/.test(body),
      "retrying into a rate limit is what kept the limit alive");
  }

  // ---- THE PREWARM MUST NOT RESOLVE WHAT WE ALREADY HOLD -----------------
  // A page of listings people have already browsed should cost MLS Grid nothing.
  // Resolving a URL for a photo that will be served from our own store is a
  // request spent on a fetch that never happens -- once per page render, forever.
  {
    const store = fakeStore();
    const listings = [{ listingId: "IRE500001" }, { listingId: "IRE500002" }];
    // One of the two already has its cover stored.
    await store.setJSON(media.photoCacheKey("IRE500001", 0), { b64: "x", contentType: "image/jpeg" });

    const f = stubFetch(() => jsonResponse({ value: [] }));
    await media.prewarmPhotoUrls(listings, { store, ...RESOLVE_OPTS });
    f.restore();

    check("the prewarm still runs for a listing we have never fetched",
      f.calls.length === 1, `made ${f.calls.length} call(s)`);
    const asked = readable(f.calls[0] ? f.calls[0].url : "");
    check("but the already-stored listing is left out of it",
      asked.indexOf("IRE500001") === -1 && asked.indexOf("IRE500002") !== -1,
      "resolving a URL for a photo served from our own store is a wasted request");

    // And with everything stored, the page costs nothing at all.
    await store.setJSON(media.photoCacheKey("IRE500002", 0), { b64: "x", contentType: "image/jpeg" });
    const f2 = stubFetch(() => jsonResponse({ value: [] }));
    const warmed = await media.prewarmPhotoUrls(listings, { store, ...RESOLVE_OPTS });
    f2.restore();
    check("a fully warm page makes NO MLS Grid request at all",
      f2.calls.length === 0 && warmed === 0,
      "this is the steady state the whole photo store exists to reach");
  }

  console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
