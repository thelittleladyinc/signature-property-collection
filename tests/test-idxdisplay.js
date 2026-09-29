// IDX display kill switch + 12-hour freshness guard (lib/_idx-display.js).
//
// 2026-09-28. Christine's MLS Grid (IRES) data licence was revoked. Stopping the
// sync stops new data; it does not stop the site SHOWING the copy it already has.
// This suite pins the rule end to end: with IDX_DISPLAY anything but "on" (the
// default), no stored listing, pin, photo or alert email leaves the site -- and
// when it is switched back on, nothing older than 12 hours is served either.
// 2026-09-28: this suite pins the MLS Grid path (the gate is shared; the Lofty
// path's use of it is covered in test-lofty-source.js).
process.env.LISTINGS_SOURCE = "mlsgrid";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const ACTIVE = {
  listingId: "IRE900101", address: "77 Frozen Data Ln", city: "Loveland", state: "CO",
  price: 1500000, status: "Active", beds: 4, baths: 3, sqft: 3200,
  agentName: "Someone Else", officeName: "Other Brokerage",
  cloudinaryPhoto: "https://res.cloudinary.com/demo/image/upload/v1/x.jpg", photoCount: 1,
};
const HERS = { ...ACTIVE, listingId: "IRE900102", address: "12 Her Own Ct", agentName: "Christine Gwinnup" };

// A store whose every read is recorded, so "did it even look at the data" is testable.
function makeStore(state, opts = {}) {
  const reads = [];
  const writes = [];
  const store = {
    reads, writes,
    get: async (k) => {
      reads.push(k);
      if (opts.throwOnRead) throw new Error(`unexpected read of ${k}`);
      if (k === "sync-state.json") return state;
      if (k === "listings.json") return { [ACTIVE.listingId]: ACTIVE, [HERS.listingId]: HERS };
      if (k === "mine-listings.json") return [HERS];
      if (opts.alert && k === "a1") return opts.alert;
      return null;
    },
    setJSON: async (k, v) => { writes.push([k, v]); },
    set: async (k, v) => { writes.push([k, v]); },
    list: async () => ({ blobs: opts.alert ? [{ key: "a1" }] : [] }),
    delete: async () => {},
  };
  return store;
}

function load(fnFile, store) {
  require.cache[blobsPath] = {
    id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => store },
  };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  return require(`${FN_DIR}/${fnFile}`);
}

function setEnv(vars) {
  for (const k of ["IDX_DISPLAY", "IDX_SEARCH_URL"]) delete process.env[k];
  Object.assign(process.env, vars);
}

(async () => {
  process.env.BLOBS_SITE_ID = "s"; process.env.BLOBS_TOKEN = "t";
  delete process.env.MLSGRID_API_TOKEN;
  delete process.env.GOOGLE_MAPS_API_KEY;
  const realFetch = global.fetch;
  let fetches = [];
  global.fetch = async (url) => { fetches.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; };

  const lib = require(`${FN_DIR}/lib/_idx-display.js`);
  const FRESH = { lastRunAt: iso(HOUR), lastSuccessAt: iso(HOUR) };
  const STALE = { lastRunAt: iso(5 * 60 * 1000), lastSuccessAt: iso(13 * HOUR) };

  console.log("\n1. The switch defaults OFF and only \"on\" turns it on");
  for (const [v, want] of [[undefined, false], ["", false], ["off", false], ["true", false],
    ["1", false], ["yes", false], ["on", true], [" ON ", true]]) {
    check(`IDX_DISPLAY=${JSON.stringify(v)} -> ${want ? "on" : "off"}`,
      lib.isIdxDisplayOn(v === undefined ? {} : { IDX_DISPLAY: v }) === want);
  }

  console.log("\n2. Where visitors are sent");
  // 2026-09-28: was thelittleladysellshomes.com, whose search passes through to
  // this site's -- each site's button pointed at the other. Now her Lofty search.
  check("default is her Lofty home search", lib.idxSearchUrl({}) === "https://thelittleladyhomesearch.com/listing");
  check("IDX_SEARCH_URL overrides it", lib.idxSearchUrl({ IDX_SEARCH_URL: "https://search.example.com/homes" }) === "https://search.example.com/homes");
  check("a javascript: URL is refused", lib.idxSearchUrl({ IDX_SEARCH_URL: "javascript:alert(1)" }) === lib.DEFAULT_SEARCH_URL);
  check("garbage is refused", lib.idxSearchUrl({ IDX_SEARCH_URL: "not a url" }) === lib.DEFAULT_SEARCH_URL);
  // 2026-09-29: the Lofty site moved to thelittleladyhomesearch.com. A setting
  // still naming the retired Bold host goes straight to the new one, same path.
  for (const old of ["https://theboldcollectivehomes.com/listing", "http://www.theboldcollectivehomes.com/listing",
    "https://THEBOLDCOLLECTIVEHOMES.COM/listing"]) {
    check(`retired host ${old} -> thelittleladyhomesearch.com`,
      lib.idxSearchUrl({ IDX_SEARCH_URL: old }) === "https://thelittleladyhomesearch.com/listing", lib.idxSearchUrl({ IDX_SEARCH_URL: old }));
  }
  check("no other host is rewritten", lib.idxSearchUrl({ IDX_SEARCH_URL: "https://boldcollectivehomes.example.com/listing" }) === "https://boldcollectivehomes.example.com/listing");
  check("the message is the agreed wording", lib.MESSAGE === "Search homes on my home-search site");

  console.log("\n3. Freshness (IDX: never older than 12 hours)");
  const on = { IDX_DISPLAY: "on" };
  check("12 hours is the limit", lib.IDX_MAX_AGE_MS === 12 * HOUR);
  check("fresh sync -> allowed", lib.idxGate({ env: on, state: FRESH }).allowed === true);
  const st = lib.idxGate({ env: on, state: STALE });
  check("13h-old sync -> refused as stale", !st.allowed && st.reason === "stale", JSON.stringify(st));
  check("no state at all -> refused", lib.idxGate({ env: on, state: null }).reason === "no_sync_record");
  check("lastRunAt alone never counts (failed runs write it too)",
    lib.idxGate({ env: on, state: { lastRunAt: iso(60 * 1000) } }).reason === "no_sync_record");
  check("an unparseable timestamp -> refused",
    lib.idxGate({ env: on, state: { lastSuccessAt: "yesterday-ish" } }).reason === "no_sync_record");
  check("display off wins even over fresh data", lib.idxGate({ env: {}, state: FRESH }).reason === "disabled");

  console.log("\n4. listings-search");
  {
    setEnv({});
    let store = makeStore(FRESH, { throwOnRead: true });
    let res = await load("listings-search.js", store).handler({ queryStringParameters: { noFloor: "true" } });
    let body = JSON.parse(res.body);
    check("off: 200 with no listings", res.statusCode === 200 && body.listings.length === 0 && body.totalCount === 0);
    check("off: flagged idxUnavailable with message + link",
      body.idxUnavailable === true && body.message === lib.MESSAGE && body.searchUrl === lib.DEFAULT_SEARCH_URL, res.body);
    check("off: error stays not_configured so older front ends degrade calmly", body.error === "not_configured");
    check("off: storage is never even read", store.reads.length === 0, store.reads.join(","));
    res = await load("listings-search.js", store).handler({ queryStringParameters: { mine: "true" } });
    check("off: mine=true (her own listings) is refused too", JSON.parse(res.body).listings.length === 0);
    res = await load("listings-search.js", store).handler({ queryStringParameters: { listingId: HERS.listingId } });
    body = JSON.parse(res.body);
    check("off: a gallery request returns no photos", Array.isArray(body.photos) && body.photos.length === 0);

    setEnv({ IDX_DISPLAY: "on", IDX_SEARCH_URL: "https://homes.example.com/" });
    store = makeStore(STALE);
    res = await load("listings-search.js", store).handler({ queryStringParameters: { noFloor: "true" } });
    body = JSON.parse(res.body);
    check("on + stale: no listings", body.listings.length === 0 && body.idxUnavailable === true && body.reason === "stale", res.body);
    check("on + stale: the catalogue is never read", !store.reads.includes("listings.json"), store.reads.join(","));
    check("on + stale: links to IDX_SEARCH_URL", body.searchUrl === "https://homes.example.com/");

    store = makeStore(FRESH);
    res = await load("listings-search.js", store).handler({ queryStringParameters: { noFloor: "true" } });
    body = JSON.parse(res.body);
    check("on + fresh: listings are served as before", body.listings.length === 2 && !body.error && !body.idxUnavailable, res.body.slice(0, 200));
  }

  console.log("\n5. /listing/<id> pages");
  {
    setEnv({});
    let store = makeStore(FRESH, { throwOnRead: true });
    let res = await load("listing-page.js", store).handler({ queryStringParameters: { id: ACTIVE.listingId } });
    check("off: 410 Gone", res.statusCode === 410, String(res.statusCode));
    check("off: noindex header", /noindex/.test(res.headers["X-Robots-Tag"] || ""));
    check("off: noindex meta in the page", /<meta name="robots" content="noindex">/.test(res.body));
    check("off: shows the message and links to the search site",
      res.body.includes(lib.MESSAGE) && res.body.includes(`href="${lib.DEFAULT_SEARCH_URL}"`));
    check("off: no listing fact on the page", !res.body.includes(ACTIVE.address) && !res.body.includes("1,500,000"));
    check("off: storage is never read", store.reads.length === 0);
    res = await load("listing-page.js", store).handler({ queryStringParameters: { id: ACTIVE.listingId, brand: "tllsh" } });
    check("off: the TLLSH-branded page is 410 too", res.statusCode === 410);

    setEnv({ IDX_DISPLAY: "on", IDX_SEARCH_URL: 'https://x.example.com/?a="><script>' });
    store = makeStore(STALE);
    res = await load("listing-page.js", store).handler({ queryStringParameters: { id: ACTIVE.listingId } });
    check("on + stale: 503 (temporary) with Retry-After", res.statusCode === 503 && res.headers["Retry-After"], String(res.statusCode));
    check("on + stale: noindex, no-store", /noindex/.test(res.headers["X-Robots-Tag"]) && res.headers["Cache-Control"] === "no-store");
    check("on + stale: no listing fact on the page", !res.body.includes(ACTIVE.address));
    check("a hostile IDX_SEARCH_URL cannot inject markup", !res.body.includes('"><script>'));

    setEnv({ IDX_DISPLAY: "on" });
    store = makeStore(FRESH);
    res = await load("listing-page.js", store).handler({ queryStringParameters: { id: ACTIVE.listingId } });
    check("on + fresh: the listing renders 200 as before", res.statusCode === 200 && res.body.includes(ACTIVE.address), String(res.statusCode));
  }

  console.log("\n6. my-listings-geo (her map pins)");
  {
    setEnv({});
    process.env.GOOGLE_MAPS_API_KEY = "k";
    let store = makeStore(FRESH, { throwOnRead: true });
    let res = await load("my-listings-geo.js", store).handler({});
    let body = JSON.parse(res.body);
    check("off: empty pins", Array.isArray(body.pins) && body.pins.length === 0 && body.idxUnavailable === true, res.body);
    check("off: storage is never read", store.reads.length === 0);
    setEnv({ IDX_DISPLAY: "on" });
    store = makeStore(STALE);
    body = JSON.parse((await load("my-listings-geo.js", store).handler({})).body);
    check("on + stale: empty pins", body.pins.length === 0 && body.reason === "stale", JSON.stringify(body));
    check("on + stale: her listings are never read", !store.reads.includes("mine-listings.json"));
    delete process.env.GOOGLE_MAPS_API_KEY;
  }

  console.log("\n7. listing-photo (the photo proxy)");
  {
    setEnv({});
    const store = makeStore(FRESH, { throwOnRead: true });
    const res = await load("listing-photo.js", store).handler({ queryStringParameters: { id: ACTIVE.listingId, i: "0" } });
    check("off: a placeholder, not the photo", res.headers["X-Photo-Fallback"] === "idx_display_off", JSON.stringify(res.headers));
    check("off: even our own stored copy is not read", store.reads.length === 0, store.reads.join(","));
  }

  console.log("\n8. Area alert emails");
  {
    process.env.RESEND_API_KEY = "re_test";
    const alert = { id: "a1", email: "buyer@example.com", cities: ["Loveland"], label: "Loveland", knownIds: [] };
    for (const [label, env, state] of [
      ["off", {}, FRESH],
      ["on + stale", { IDX_DISPLAY: "on" }, STALE],
      ["on + no sync record", { IDX_DISPLAY: "on" }, { lastRunAt: iso(60 * 1000) }],
    ]) {
      setEnv(env);
      fetches = [];
      const store = makeStore(state, { alert });
      const res = await load("area-alerts-run.js", store).handler();
      check(`${label}: no email sent`, fetches.length === 0, fetches.join(","));
      check(`${label}: no alert touched (resumes cleanly later)`, store.writes.length === 0);
      check(`${label}: says why`, /skipped/.test(res.body), res.body);
    }
    setEnv({ IDX_DISPLAY: "on" });
    fetches = [];
    const store = makeStore(FRESH, { alert });
    await load("area-alerts-run.js", store).handler();
    check("on + fresh: the alert is emailed as before", fetches.length === 1 && /resend/.test(fetches[0]), fetches.join(","));
    delete process.env.RESEND_API_KEY;
  }

  console.log("\n9. sync-listings records lastSuccessAt only on a clean, caught-up run");
  {
    const sync = load("sync-listings.js", makeStore(null));
    const prev = { lastSuccessAt: "2026-09-01T00:00:00.000Z" };
    const now = "2026-09-28T12:00:00.000Z";
    check("clean + caught up -> now", sync.nextLastSuccessAt(prev, { passComplete: true, lastRunError: null, httpErrorOccurred: false }, now) === now);
    check("mid-pass -> unchanged", sync.nextLastSuccessAt(prev, { passComplete: false, lastRunError: null }, now) === prev.lastSuccessAt);
    check("error -> unchanged", sync.nextLastSuccessAt(prev, { passComplete: true, lastRunError: "MLS Grid 401" }, now) === prev.lastSuccessAt);
    check("http error -> unchanged", sync.nextLastSuccessAt(prev, { passComplete: true, httpErrorOccurred: true }, now) === prev.lastSuccessAt);
    check("no previous value -> null, never invented", sync.nextLastSuccessAt({}, { passComplete: false }, now) === null);
    const src = fs.readFileSync(`${FN_DIR}/sync-listings.js`, "utf8");
    check("both state writes carry lastSuccessAt", (src.match(/lastSuccessAt:/g) || []).length >= 2);
  }

  console.log("\n10. MLS_DISABLED=true stops sync-listings before any MLS Grid request");
  {
    process.env.MLS_DISABLED = "true";
    process.env.MLSGRID_API_TOKEN = "tok";
    fetches = [];
    const store = makeStore(null);
    const res = await load("sync-listings.js", store).handler();
    check("skips with the kill-switch reason", /MLS_DISABLED/.test(res.body), res.body);
    check("no network request at all", fetches.length === 0, fetches.join(","));
    check("sync state is not rewritten (freshness keeps ageing)", !store.writes.some(([k]) => k === "sync-state.json"));
    delete process.env.MLS_DISABLED;
    delete process.env.MLSGRID_API_TOKEN;
  }

  console.log("\n11. Built pages handle the new answer");
  {
    const read = (p) => fs.readFileSync(path.join(ROOT, "site", p), "utf8");
    for (const page of ["search-homes.html", "current-listings.html"]) {
      const html = read(page);
      check(`${page} checks idxUnavailable`, /data\.idxUnavailable/.test(html));
      check(`${page} defines idxOffHtml`, /function idxOffHtml\(data\)/.test(html));
    }
    // Run the real helper out of a built page against hostile input.
    const html = read("search-homes.html");
    const m = html.match(/function idxOffHtml\(data\) \{[\s\S]*?\n  \}\n/);
    check("helper found in the built page", !!m);
    if (m) {
      const idxOffHtml = new Function(`${m[0]}; return idxOffHtml;`)();
      const good = idxOffHtml({ searchUrl: "https://homes.example.com/", message: lib.MESSAGE });
      check("links to the server's URL with the message", good.includes('href="https://homes.example.com/"') && good.includes(lib.MESSAGE));
      const bad = idxOffHtml({ searchUrl: "javascript:alert(1)", message: "<img src=x onerror=alert(1)>" });
      // 2026-09-28: the page's own fallback is this site's search page, which
      // hands off to her Lofty home search (netlify/functions/home-search.js).
      check("a javascript: URL falls back to the search page", bad.includes('href="/search-homes.html"'));
      check("the message is escaped", !bad.includes("<img"));
    }
  }

  global.fetch = realFetch;
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
