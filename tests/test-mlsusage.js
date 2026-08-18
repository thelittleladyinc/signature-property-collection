// The quota guard and the usage log — the instrumentation this site went two days
// without, while three explanations for grey photos were tried and none could be
// checked against a number.
//
// What this suite protects is not "counting works". It is the four ways a guard
// like this quietly becomes decorative:
//
//   1. It measures the wrong limits. The real ones came from the 2026-08-01
//      SUSPENSION notice, not the public docs, and two of them differ.
//   2. It fails OPEN. An unreadable log reporting zero usage is the most
//      permissive answer possible, and turns the guard into a no-op silently.
//      (Expired-Luxury learned this the hard way; its QUOTA-2 note is the source.)
//   3. It can be tuned UP. A well-meant "make it faster" must not be able to cost
//      days of suspension.
//   4. It breaks the thing it measures. Instrumentation that throws on an odd
//      Response is worse than no instrumentation — and it did exactly that on
//      first wiring, which is why bytesFromResponse is tested here by name.
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const LIB = path.join(ROOT, "netlify", "functions", "lib", "_mls-usage.js");
const fs = require("fs");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// The constants are read at module load, so env-dependent behaviour needs a fresh
// require rather than a fresh value.
function loadFresh(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env || {})) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  delete require.cache[require.resolve(LIB)];
  const mod = require(LIB);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return mod;
}

function fakeStore(opts) {
  const o = opts || {};
  const data = new Map();
  return {
    data,
    async get(k) { if (o.throwOnGet) throw new Error("blobs unavailable"); return data.has(k) ? data.get(k) : null; },
    async setJSON(k, v) { if (o.throwOnSet) throw new Error("blobs read-only"); data.set(k, JSON.parse(JSON.stringify(v))); },
    async list() { if (o.throwOnList) throw new Error("no list"); return { blobs: [...data.keys()].map((key) => ({ key })) }; },
    async delete(k) { data.delete(k); },
  };
}

(async () => {
  // ---- 1. THE RIGHT LIMITS -----------------------------------------------
  {
    const m = loadFresh({});
    const b = m.budgets();
    // From the suspension email of 2026-08-01, NOT the published documentation.
    check("the hourly request limit is 7,200", b.hourRequestBudget === 3600,
      `budget is ${b.hourRequestBudget}, so the limit it halves is ${b.hourRequestBudget * 2}`);
    check("the hourly MB limit is 3,072, not the published 4 GB",
      b.hourMBBudget === 1536,
      `budget is ${b.hourMBBudget} MB, implying a ${b.hourMBBudget * 2} MB limit`);
    check("the daily request limit is 40,000", b.dayRequestBudget === 20000);
    check("the daily MB limit is 40 GB — a cap that appears in no public doc",
      b.dayMBBudget === 20480);
    check("budgets are half the real limits by default", m.SAFETY_FRACTION === 0.5);
  }

  // ---- 2. CEILINGS TUNE DOWN, NEVER UP -----------------------------------
  {
    const down = loadFresh({ MLS_QUOTA_HOURLY_REQUESTS: "100" });
    check("an env var can lower a limit", down.budgets().hourRequestBudget === 50);
    const up = loadFresh({ MLS_QUOTA_HOURLY_REQUESTS: "999999" });
    check("but it CANNOT raise one past what MLS Grid enforces",
      up.budgets().hourRequestBudget === 3600,
      "a well-meant 'make it faster' must not be able to cost days of suspension");
    const wild = loadFresh({ MLS_QUOTA_SAFETY_FRACTION: "9" });
    check("and the safety fraction is clamped to something sane",
      wild.SAFETY_FRACTION <= 0.95);
  }

  // ---- 3. COUNTING -------------------------------------------------------
  {
    const m = loadFresh({});
    const store = fakeStore();
    m._resetGuardCache();
    await m.recordMlsCall(store, { kind: "api", status: 200, bytes: 1000 });
    await m.recordMlsCall(store, { kind: "media", status: 200, bytes: 2_000_000 });
    await m.recordMlsCall(store, { kind: "media", status: 429, bytes: 0 });
    const bucket = store.data.get(m.hourKeyFor());
    check("every call lands in this hour's bucket", bucket && bucket.requests === 3);
    check("bytes accumulate", bucket && bucket.bytes === 2_001_000);
    check("errors are counted separately", bucket && bucket.errors === 1);
    check("and API calls are split from photo downloads",
      bucket && bucket.api === 1 && bucket.media === 2,
      "this split is the thing nobody could see: the 429s were always on media");

    const usage = await m.readFullUsage(store);
    check("the 24-hour view sees them too",
      usage.dayRequests === 3 && usage.dayMedia === 2);
    check("and reports per-hour rows for reading on a phone",
      Array.isArray(usage.hours) && usage.hours.length === 24 && usage.hours[0].requests === 3);
  }

  // ---- 4. MEASUREMENT MUST NEVER BREAK THE REQUEST ------------------------
  {
    const m = loadFresh({});
    let threw = false;
    try { await m.recordMlsCall(fakeStore({ throwOnSet: true }), { kind: "api", status: 200, bytes: 1 }); }
    catch (e) { threw = true; }
    check("a store that throws on write does not throw at the caller", !threw);
    try { await m.recordMlsCall(null, { kind: "api" }); } catch (e) { threw = true; }
    check("and neither does no store at all", !threw);

    // The bug this had on first wiring: a Response with no headers is not
    // something the platform makes, but every test double in this repo is one.
    check("a response with no headers measures as zero, not an exception",
      m.bytesFromResponse({ ok: true, status: 200 }) === 0);
    check("a real content-length is read", m.bytesFromResponse({
      headers: { get: () => "4096" },
    }) === 4096);
    check("and a nonsense one is ignored", m.bytesFromResponse({
      headers: { get: () => "not-a-number" },
    }) === 0);
  }

  // ---- 5. THE GUARD ------------------------------------------------------
  {
    const m = loadFresh({ MLS_QUOTA_HOURLY_REQUESTS: "10" }); // budget becomes 5
    const store = fakeStore();
    m._resetGuardCache();
    let q = await m.checkMlsQuota(store);
    check("an idle hour is not blocked", q.blocked === false);

    for (let i = 0; i < 5; i += 1) {
      await m.recordMlsCall(store, { kind: "api", status: 200, bytes: 0 });
    }
    m._resetGuardCache();
    q = await m.checkMlsQuota(store);
    check("the guard blocks at the budget, well before MLS Grid's real limit",
      q.blocked === true, `hourRequests=${q.hourRequests} budget=${q.hourRequestBudget}`);
    check("and says which budget, in numbers a person can act on",
      /requests this hour/.test(q.reason || "") && /self-imposed budget/.test(q.reason || ""),
      q.reason);
  }
  {
    const m = loadFresh({ MLS_QUOTA_HOURLY_MB: "10" }); // budget becomes 5 MB
    const store = fakeStore();
    m._resetGuardCache();
    await m.recordMlsCall(store, { kind: "media", status: 200, bytes: 6 * 1048576 });
    m._resetGuardCache();
    const q = await m.checkMlsQuota(store);
    check("bandwidth is guarded as well as request count", q.blocked === true, q.reason);
    check("and the reason names megabytes", /MB downloaded this hour/.test(q.reason || ""), q.reason);
  }

  // ---- 6. FAILS CLOSED ---------------------------------------------------
  // The most important check here. "Zero usage" is the most permissive answer an
  // unreadable log can give, so reporting it would silently disable the guard.
  {
    const m = loadFresh({});
    m._resetGuardCache();
    const q = await m.checkMlsQuota(fakeStore({ throwOnGet: true }));
    check("an unreadable usage log BLOCKS rather than reporting zero",
      q.blocked === true && q.usageUnknown === true,
      "a guard that fails open is decorative — this is Expired-Luxury's QUOTA-2 lesson");
    check("and says so, rather than blaming MLS Grid",
      /cannot prove we are under quota/.test(q.reason || ""), q.reason);
  }

  // ---- 7. THE KILL SWITCH ------------------------------------------------
  {
    const m = loadFresh({ MLS_DISABLED: "true" });
    m._resetGuardCache();
    const q = await m.checkMlsQuota(fakeStore());
    check("MLS_DISABLED stops everything without touching credentials",
      q.blocked === true && q.disabled === true);
    const off = loadFresh({ MLS_DISABLED: undefined });
    check("and it is off unless explicitly set", off.MLS_DISABLED === false);
  }

  // ---- 8. PRUNING --------------------------------------------------------
  {
    const m = loadFresh({});
    const store = fakeStore();
    const old = m.hourKeyFor(new Date(Date.now() - 72 * 3600_000));
    const recent = m.hourKeyFor(new Date(Date.now() - 2 * 3600_000));
    await store.setJSON(old, { requests: 1 });
    await store.setJSON(recent, { requests: 1 });
    const removed = await m.pruneUsage(store);
    check("buckets past the retention window are dropped", removed === 1 && !store.data.has(old));
    check("recent ones are kept", store.data.has(recent));
    let threw = false;
    try { await m.pruneUsage(fakeStore({ throwOnList: true })); } catch (e) { threw = true; }
    check("and a failure to prune is not fatal", !threw);
  }

  // ---- 9. THE GUARD RUNS BEFORE THE REQUEST ------------------------------
  // A budget checked after the call is a report, not a guard.
  {
    const media = fs.readFileSync(path.join(ROOT, "netlify", "functions", "lib", "_media.js"), "utf8");
    const at = media.indexOf("async function resolveOneBatch(");
    const body = media.slice(at, media.indexOf("\n}", at));
    check("the media resolve checks the budget before it fetches",
      body.indexOf("checkMlsQuota") !== -1 && body.indexOf("checkMlsQuota") < body.indexOf("await fetch("),
      "a budget checked after the request is a report, not a guard");
    check("and records the call whatever the response was",
      /recordMlsCall\(store, \{\s*kind: "api", status: res\.status/.test(body),
      "a 429 is still a request that was made");

    const photo = fs.readFileSync(path.join(ROOT, "netlify", "functions", "listing-photo.js"), "utf8");
    const handler = photo.slice(photo.indexOf("exports.handler"));
    check("the photo handler serves its own stored copy BEFORE consulting the budget",
      handler.indexOf("await readCachedPhoto(") < handler.indexOf("await checkMlsQuota("),
      "otherwise a blocked budget would blank photos we already hold");

    const sync = fs.readFileSync(path.join(ROOT, "netlify", "functions", "sync-listings.js"), "utf8");
    check("every MLS Grid call in the sync goes through the one gated helper",
      !/await fetch\(`\$\{BASE_URL\}/.test(sync) && (sync.match(/await mlsFetch\(/g) || []).length >= 4,
      "an ungated call site is the one that will be running when the account is suspended");
  }

  // ---- 10. THE GUARD MUST NOT COST MORE THAN IT SAVES --------------------
  // The full 24-hour read is up to 24 blob gets. Doing that per call put ~168 of
  // them inside sync-listings' 11-second budget — spending the run's headroom on
  // measuring the run. Per call is the one-hour read; the full picture is checked
  // once at the top.
  {
    const m = loadFresh({});
    const store = fakeStore();
    let gets = 0;
    const counting = {
      ...store,
      async get(k) { gets += 1; return store.get(k); },
      async setJSON(k, v) { return store.setJSON(k, v); },
    };
    m._resetGuardCache();
    await m.checkMlsQuota(counting);
    check("the per-request guard reads exactly one bucket", gets === 1, `${gets} blob reads`);

    gets = 0;
    m._resetGuardCache();
    await m.checkMlsQuota(counting, { full: true });
    check("the full picture reads a day's worth, and is therefore not per-request",
      gets === 24, `${gets} blob reads`);

    gets = 0;
    await m.checkMlsQuota(counting);
    check("and repeat guard checks inside the memo window cost nothing",
      gets === 0, `${gets} blob reads`);

    const sync = fs.readFileSync(path.join(ROOT, "netlify", "functions", "sync-listings.js"), "utf8");
    const helper = sync.slice(sync.indexOf("async function mlsFetch("));
    check("the sync's per-call helper does NOT ask for the full picture",
      /full: full === true/.test(helper.slice(0, 400)),
      "a 24-blob read per call spends an 11-second budget on measuring itself");
    check("but the run as a whole still checks the daily caps once",
      /checkMlsQuota\(store, \{ full: true \}\)/.test(sync));
  }

  console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
