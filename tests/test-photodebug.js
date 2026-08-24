// ?debug=1 must explain a FAILING photo, which is the only time anyone asks.
//
// 2026-08-17. listing-photo.js handled ?debug=1 in a single block at the very
// bottom of the handler -- after every `return placeholder(...)`. So it described
// only photos that already worked. Christine opened the debug URL for a land
// listing that renders grey and got back a grey rectangle: the one tool built to
// explain a blank photo could not explain a blank photo. She tried the second
// listing and got the same thing.
//
// The reason was never missing -- X-Photo-Fallback carries it on every
// placeholder -- but that means opening devtools to find out why a photo is grey,
// which is not a reasonable thing to ask of anyone.
//
// So this pins the property that was actually wrong: for EVERY failure path,
// debug=1 returns JSON naming the reason. A test per path, because the bug was
// precisely that one path (success) was covered and the rest were not.
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = path.join(ROOT, "netlify", "functions");
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

function load(blobs, fetchImpl) {
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true,
    exports: { getStore: () => blobs } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  global.fetch = fetchImpl;
  return require(path.join(FN_DIR, "listing-photo.js")).handler;
}

function store(seed = {}) {
  // 2026-08-24: every scenario here describes a WARM listing — one this site is
  // allowed to resolve live. Cold listings no longer reach any of these paths:
  // they get a `cold_backfill_pending` placeholder without a single MLS Grid
  // request (the fan-out fix; see resolvePhotoUrl in listing-photo.js and
  // tests/test-coldgate.js). Seeding the listing as Christine's own is the
  // warmth that doesn't short-circuit the photo store the way a stored cover
  // would.
  const data = new Map(Object.entries({
    "mine-listings.json": [{ listingId: ID }],
    ...seed,
  }));
  return {
    get: async (k) => (data.has(k) ? data.get(k) : null),
    setJSON: async (k, v) => { data.set(k, v); },
    list: async () => ({ blobs: [] }),
  };
}

const ID = "IRE1000029"; // one of the two land listings that reported this
const call = (h, extra = {}) => h({ queryStringParameters: { id: ID, i: "0", ...extra } });

// A media response that resolves one URL for ID.
const mediaOk = { value: [{ ListingId: ID, Media: [{ Order: 0, MediaURL: "https://media.test/a.jpg" }] }] };
const imgHeaders = (ct) => ({ get: (k) => (String(k).toLowerCase() === "content-type" ? ct : null) });

function apiThen(imageImpl, api = mediaOk) {
  return async (url) => {
    if (String(url).includes("media.test")) return imageImpl();
    return { ok: true, status: 200, json: async () => api };
  };
}

(async () => {
  process.env.MLSGRID_API_TOKEN = "t";

  // Each entry: label, fetch impl, seed, expected reason, and a field that must
  // be present so the JSON is actually useful and not just a bare code.
  const cases = [
    {
      label: "no media at all",
      fetchImpl: apiThen(null, { value: [{ ListingId: ID, Media: [] }] }),
      reason: "no_media",
      field: "urlCount",
    },
    {
      label: "the media host 403s (expired signature)",
      fetchImpl: apiThen(() => ({ ok: false, status: 403, headers: imgHeaders("text/plain") })),
      reason: "image_http_error",
      field: "httpStatus",
    },
    {
      label: "the media host 404s (photo gone)",
      fetchImpl: apiThen(() => ({ ok: false, status: 404, headers: imgHeaders("text/plain") })),
      reason: "image_http_error",
      field: "httpStatus",
    },
    {
      label: "the image is over the inline ceiling",
      // 5 MB: downloads fine, cannot be returned through a function.
      fetchImpl: apiThen(() => ({
        ok: true, status: 200, headers: imgHeaders("image/jpeg"),
        arrayBuffer: async () => new ArrayBuffer(5 * 1024 * 1024),
      })),
      reason: "too_large",
      field: "bytes",
    },
    {
      label: "the response isn't an image",
      fetchImpl: apiThen(() => ({
        ok: true, status: 200, headers: imgHeaders("text/html"),
        arrayBuffer: async () => new ArrayBuffer(10),
      })),
      reason: "not_an_image",
      field: "contentType",
    },
    {
      label: "the image fetch dies outright",
      fetchImpl: apiThen(() => { throw new Error("socket hang up"); }),
      reason: "image_fetch_failed",
      field: "listingId",
    },
    {
      label: "rate-limited, so no request was made",
      fetchImpl: apiThen(null),
      seed: { "mlsgrid-photo-cooldown.json": { until: Date.now() + 30_000 } },
      reason: "throttled",
      field: "retryAfterSeconds",
    },
    {
      label: "a malformed listing id",
      fetchImpl: apiThen(null),
      extra: { id: "!!" },
      reason: "bad_id",
      field: "listingId",
    },
  ];

  for (const c of cases) {
    const h = load(store(c.seed || {}), c.fetchImpl);
    const res = await call(h, { debug: "1", ...(c.extra || {}) });
    const ct = res.headers["Content-Type"];

    if (ct !== "application/json") {
      check(`${c.label} → JSON, not a grey square`, false,
        `got ${ct} — this is the 2026-08-17 bug: debug=1 ignored on a failure path`);
      continue;
    }
    let body;
    try { body = JSON.parse(res.body); } catch (e) {
      check(`${c.label} → parseable JSON`, false, e.message); continue;
    }
    const okReason = body.reason === c.reason;
    const okField = body[c.field] !== undefined && body[c.field] !== null;
    const okExpl = typeof body.explanation === "string" &&
      body.explanation.length > 20 &&
      !body.explanation.startsWith("Unrecognised");
    check(
      `${c.label} → reason "${c.reason}" + ${c.field} + explanation`,
      okReason && okField && okExpl && body.ok === false,
      `reason=${body.reason} ${c.field}=${body[c.field]} explanation=${JSON.stringify(String(body.explanation).slice(0, 40))}`
    );
  }

  // ---- Both auth modes must be tried before a 404 is believed ----------------
  // 2026-08-17, from Christine's live debug output on a grey land listing:
  //   {"reason":"image_http_error","httpStatus":404,"authMode":"auth","urlCount":4}
  // MLS Grid resolved 4 photo URLs and the image came back 404 -- but the retry
  // only fired on 401/403, so that photo had only ever been fetched ONE way. A 404
  // is not trustworthy until both modes have been tried, because S3/CloudFront
  // answer 404 rather than 403 for objects a caller may not know exists, and
  // looksPresigned() is a heuristic a path-signed URL slips past.
  console.log("\n  both auth modes on a 404:");
  {
    const seen = [];
    const h = load(store(), apiThen(() => {
      seen.push("img");
      return { ok: false, status: 404, headers: imgHeaders("text/plain") };
    }));
    const res = await call(h, { debug: "1" });
    const body = JSON.parse(res.body);
    check("  a 404 is retried with the other auth mode", seen.length === 2,
      `${seen.length} image request(s) — a 404 is being believed after one try`);
    check("  and every attempt is reported", Array.isArray(body.attempts) && body.attempts.length === 2,
      JSON.stringify(body.attempts));
    check("  naming both modes tried",
      Array.isArray(body.attempts) &&
      body.attempts.map((a) => a.mode).sort().join(",") === "anon,auth",
      JSON.stringify(body.attempts));
    check("  with the status each returned",
      Array.isArray(body.attempts) && body.attempts.every((a) => a.status === 404));
  }
  {
    // A 500 is still not worth a second request — this must not become "retry
    // everything", which would double every failure against a shared-quota API.
    const seen = [];
    const h = load(store(), apiThen(() => {
      seen.push("img");
      return { ok: false, status: 500, headers: imgHeaders("text/plain") };
    }));
    await call(h, { debug: "1" });
    check("  a 500 is NOT retried", seen.length === 1, `${seen.length} image request(s)`);
  }
  {
    // And a photo that works on the SECOND mode must actually be served — the
    // outcome this change exists to make possible.
    let n = 0;
    const h = load(store(), apiThen(() => {
      n += 1;
      if (n === 1) return { ok: false, status: 404, headers: imgHeaders("text/plain") };
      return { ok: true, status: 200, headers: imgHeaders("image/jpeg"),
        arrayBuffer: async () => new ArrayBuffer(4096) };
    }));
    const res = await call(h);
    check("  a photo that 404s on one mode and works on the other IS served",
      res.headers["Content-Type"] === "image/jpeg", res.headers["Content-Type"]);
  }

  // ---- A media-host 429 must cause an actual BACKOFF -------------------------
  // 2026-08-17, Christine's second debug reading:
  //   {"httpStatus":429,"mediaHost":"media.mlsgrid.com","attempts":[{"mode":"auth","status":429}]}
  // setPhotoCooldown() had exactly one caller -- resolveMediaFor(), for API 429s.
  // A 429 from the MEDIA host returned a grey placeholder and changed nothing, so
  // a dozen cards kept requesting into a limit that therefore never cleared. The
  // grey box was both the symptom and the cause of the next one.
  console.log("\n  media-host rate limiting:");
  {
    const s2 = store();
    const writes = [];
    s2.setJSON = async (k, v) => { writes.push(k); };
    const h = load(s2, apiThen(() => ({
      ok: false, status: 429,
      headers: { get: (k) => (String(k).toLowerCase() === "retry-after" ? "20" : null) },
    })));
    const res = await call(h, { debug: "1" });
    const body = JSON.parse(res.body);
    check("  a media 429 is reported as rate limiting, not a broken photo",
      body.reason === "media_rate_limited", body.reason);
    check("  a cooldown is actually written", writes.includes("mlsgrid-media-cooldown.json"),
      JSON.stringify(writes) + " — nothing backed off, so the limit sustains itself");
    check("  and Retry-After is honoured", body.retryAfterSeconds === 20, String(body.retryAfterSeconds));
  }
  {
    // While that cooldown is live, no further image request may go out at all.
    let imgCalls = 0;
    const h = load(
      store({ "mlsgrid-media-cooldown.json": { until: Date.now() + 30_000 } }),
      apiThen(() => { imgCalls += 1; return { ok: true, status: 200, headers: imgHeaders("image/jpeg"), arrayBuffer: async () => new ArrayBuffer(10) }; })
    );
    const res = await call(h, { debug: "1" });
    const body = JSON.parse(res.body);
    check("  during the cooldown no image request is made", imgCalls === 0, `${imgCalls} request(s)`);
    check("  and the reason says so", body.reason === "media_rate_limited", body.reason);
    check("  with the wait time", body.retryAfterSeconds > 0 && body.retryAfterSeconds <= 30,
      String(body.retryAfterSeconds));
  }
  {
    // The two cooldowns must stay SEPARATE. An API-resolve cooldown blanking a
    // photo whose URL is already cached and would serve fine is its own
    // crying-wolf failure — the exact mistake this file has made before.
    let imgCalls = 0;
    const h = load(
      store({
        "mlsgrid-photo-cooldown.json": { until: Date.now() + 30_000 },   // API cooldown
        "photo-urls/IRE1000029.json": { urls: ["https://media.test/a.jpg"], cachedAt: Date.now() },
      }),
      apiThen(() => { imgCalls += 1; return { ok: true, status: 200, headers: imgHeaders("image/jpeg"), arrayBuffer: async () => new ArrayBuffer(10) }; })
    );
    const res = await call(h);
    check("  an API cooldown does NOT block a cached photo from serving",
      res.headers["Content-Type"] === "image/jpeg" && imgCalls === 1,
      `${res.headers["Content-Type"]}, ${imgCalls} image request(s)`);
  }

  // ---- A failure's cache lifetime must match WHY it failed --------------------
  // 2026-08-17. Every placeholder was cached 300s regardless of reason, which put a
  // permanent floor under our own request rate: a photo that is never coming back
  // re-asked MLS Grid every five minutes, forever, from every CDN edge. Across the
  // failing photos on the site that is a steady drip against an account whose
  // limits are shared with two other apps -- feeding the 429s that then grey out
  // photos which would otherwise have worked.
  //
  // Both directions are a real cost, so both are pinned: too long on a transient
  // failure freezes a working photo grey, too short on a permanent one is the drip.
  console.log("\n  placeholder cache lifetime by reason:");
  {
    const maxAge = (h) => {
      const m = /max-age=(\d+)/.exec(h["Cache-Control"] || "");
      return m ? Number(m[1]) : null;
    };

    // Transient: must expire fast so photos return the moment the limit clears.
    let h = load(store({ "mlsgrid-media-cooldown.json": { until: Date.now() + 30_000 } }), apiThen(null));
    let res = await call(h);
    check("  a rate-limited photo is cached briefly", maxAge(res.headers) <= 60, String(maxAge(res.headers)));

    // Permanent: must stop asking.
    h = load(store(), apiThen(null, { value: [{ ListingId: ID, Media: [] }] }));
    res = await call(h);
    check("  a listing with no media is cached for an hour", maxAge(res.headers) >= 3600, String(maxAge(res.headers)));

    // A 404 confirmed on BOTH modes is permanent; one unconfirmed try is not.
    h = load(store(), apiThen(() => ({ ok: false, status: 404, headers: imgHeaders("text/plain") })));
    res = await call(h);
    check("  a 404 confirmed on both auth modes is cached for an hour",
      maxAge(res.headers) >= 3600, String(maxAge(res.headers)));

    // A 403 is usually an expired signature — a fresh resolve may fix it, so it
    // must NOT be frozen for an hour.
    h = load(store(), apiThen(() => ({ ok: false, status: 403, headers: imgHeaders("text/plain") })));
    res = await call(h);
    check("  a 403 stays short, since a fresh signature may fix it",
      maxAge(res.headers) <= 300, String(maxAge(res.headers)));

    // A working photo's cache must be untouched by any of this.
    h = load(store(), apiThen(() => ({
      ok: true, status: 200, headers: imgHeaders("image/jpeg"),
      arrayBuffer: async () => new ArrayBuffer(2048),
    })));
    res = await call(h);
    check("  a working photo still caches for a day", maxAge(res.headers) >= 86400,
      res.headers["Cache-Control"]);
  }

  // The success path must keep working — it was the only one that ever did.
  {
    const h = load(store(), apiThen(() => ({
      ok: true, status: 200, headers: imgHeaders("image/jpeg"),
      arrayBuffer: async () => new ArrayBuffer(50_000),
    })));
    const res = await call(h, { debug: "1" });
    const body = JSON.parse(res.body);
    check("a working photo still reports ok:true with its byte count",
      body.ok === true && body.bytes === 50_000, JSON.stringify(body));
  }

  // And WITHOUT debug, every failure must still render as a silent grey image.
  // A visitor must never be shown JSON where a photo belongs.
  {
    const h = load(store(), apiThen(() => ({ ok: false, status: 403, headers: imgHeaders("text/plain") })));
    const res = await call(h);
    check("without debug, a failure is still a silent grey image",
      res.headers["Content-Type"] === "image/svg+xml" && /svg/.test(res.body));
    check("and the reason still rides along as a header",
      res.headers["X-Photo-Fallback"] === "image_http_error", res.headers["X-Photo-Fallback"]);
  }

  // Every reason the handler can emit needs an explanation, or debug output
  // degrades to a bare code exactly when someone is depending on it.
  {
    const src = require("fs").readFileSync(path.join(FN_DIR, "listing-photo.js"), "utf8");
    const emitted = [...src.matchAll(/placeholder\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const explained = [...src.matchAll(/^\s{2}([a-z_]+):\s*"/gm)].map((m) => m[1]);
    const missing = [...new Set(emitted)].filter((r) => !explained.includes(r));
    check("every emitted reason has a plain-English explanation", missing.length === 0,
      missing.length ? `no explanation for: ${missing.join(", ")}` : "");
  }

  console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
