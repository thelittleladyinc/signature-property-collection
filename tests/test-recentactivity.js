// The "Recently sold & open houses" strip (2026-09-27).
//
// netlify/functions/recent-activity.js is the only thing on this site that talks
// to Listing Engine's key-guarded feed. What this suite pins:
//   1. the key goes out in a header and never in a URL or a response;
//   2. the response is an allow-list -- a field Listing Engine adds later cannot
//      ride through onto the site;
//   3. every failure (unset key, 401, 500, bad JSON, network error) is an empty
//      list with a 200, which the front end reads as "stay hidden";
//   4. the windows: sold in the last 60 days, open houses today..+14 days on the
//      Denver clock, at most four cards;
//   5. the built pages carry the strip hidden, and the browser script never
//      writes feed data as HTML.
// fetch is stubbed throughout -- nothing here touches the network.
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const FN = path.join(ROOT, "netlify", "functions", "recent-activity.js");
const { _internals: RA } = require(FN);
const KEY = "test-feed-key-7f3a";

// 2026-10-01 18:00 UTC = 12:00 MDT, a Thursday.
const NOW = Date.parse("2026-10-01T18:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

let calls = [];
function stubFetch(handler) {
  calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers || {} });
    const r = await handler(String(url), calls.length);
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => { if (typeof r.body === "string") return JSON.parse(r.body); return r.body; },
    };
  };
}

const listing = (over = {}) => ({
  id: 12, address: "123 Example St", city: "Loveland", state: "CO", zip: "80537",
  price: 525000, beds: 3, baths: 2.5, sqft: 1850, status: "active", mls_number: "IR1234567",
  public_url: "https://thelittleladysellshomes.com/idx/listing/IRES/IR1234567/123-Example-St",
  photo_url: "https://res.cloudinary.com/demo/image/upload/v1/listing.jpg", ...over,
});
const ev = (id, type, over = {}) => ({
  id: String(id), event_type: type, occurred_at: daysAgo(3), detected_at: daysAgo(3),
  listing: listing(), ...over,
});

async function call(env, events, opts = {}) {
  RA.resetCache();
  stubFetch(opts.fetch || (async () => ({ status: 200, body: { status: "success", events, has_more: false, next_after_id: null } })));
  const res = await RA.handler({}, {}, { env, now: () => opts.now || NOW });
  return { res, body: JSON.parse(res.body) };
}

(async () => {
  // IDX kill switch on (lib/_idx-display.js), and -- since 2026-09-28, while the
  // listings come from Lofty -- the strip's own switch too (see stripAllowed()).
  const ENV = { LISTING_FEED_KEY: KEY, IDX_DISPLAY: "on", RECENT_ACTIVITY_DISPLAY: "on" };

  console.log("\n1. No key, no call");
  {
    const { res, body } = await call({}, [ev(1, "just_sold")]);
    check("unset LISTING_FEED_KEY returns 200", res.statusCode === 200);
    check("...with an empty list", Array.isArray(body.items) && body.items.length === 0);
    check("...and never calls Listing Engine", calls.length === 0, String(calls.length));
  }

  console.log("\n1b. IDX display off (lib/_idx-display.js): empty, and no call");
  {
    for (const [label, env] of [
      ["IDX_DISPLAY unset", { LISTING_FEED_KEY: KEY }],
      ["IDX_DISPLAY=off", { LISTING_FEED_KEY: KEY, IDX_DISPLAY: "off" }],
      ["IDX_DISPLAY=true (only \"on\" counts)", { LISTING_FEED_KEY: KEY, IDX_DISPLAY: "true" }],
    ]) {
      const { res, body } = await call(env, [ev(1, "just_sold")]);
      check(`${label} -> 200 with an empty list`, res.statusCode === 200 && body.items.length === 0, res.body);
      check(`${label} -> never calls Listing Engine`, calls.length === 0, String(calls.length));
    }
    // A list cached while display was on must not survive the switch going off.
    RA.resetCache();
    stubFetch(async () => ({ status: 200, body: { events: [ev(1, "just_sold")], has_more: false } }));
    const on = JSON.parse((await RA.handler({}, {}, { env: ENV, now: () => NOW })).body);
    const off = JSON.parse((await RA.handler({}, {}, { env: { LISTING_FEED_KEY: KEY }, now: () => NOW + 1000 })).body);
    check("switching off hides an already-cached list at once", on.items.length === 1 && off.items.length === 0,
      `${on.items.length} then ${off.items.length}`);
  }

  console.log("\n1c. Her Lofty listings switched on does not switch this strip on");
  {
    const lofty = { LISTING_FEED_KEY: KEY, IDX_DISPLAY: "on" };
    const { res, body } = await call(lofty, [ev(1, "just_sold")]);
    check("IDX_DISPLAY=on alone, on Lofty -> empty (the events come from Listing Engine, not Lofty)",
      res.statusCode === 200 && body.items.length === 0, res.body);
    check("...and Listing Engine is never called", calls.length === 0, String(calls.length));
    const own = await call({ ...lofty, RECENT_ACTIVITY_DISPLAY: "on" }, [ev(1, "just_sold")]);
    check("RECENT_ACTIVITY_DISPLAY=on turns it on", own.body.items.length === 1, own.res.body);
    const grid = await call({ ...lofty, LISTINGS_SOURCE: "mlsgrid" }, [ev(1, "just_sold")]);
    check("with LISTINGS_SOURCE=mlsgrid it follows IDX_DISPLAY alone, as before", grid.body.items.length === 1, grid.res.body);
  }

  console.log("\n2. The request");
  {
    await call(ENV, [ev(1, "just_sold")]);
    const c = calls[0];
    check("calls the default Listing Engine host",
      c.url.startsWith("https://listing-engine-api.onrender.com/api/feed/listing-events?"), c.url);
    check("the key travels in x-listing-engine-key", c.headers["x-listing-engine-key"] === KEY);
    check("the key is never in the URL", !c.url.includes(KEY));
    const q = new URL(c.url).searchParams;
    check("asks only for just_sold + open_house_scheduled", q.get("types") === "just_sold,open_house_scheduled", q.get("types"));
    check("sends an ISO `since`", !Number.isNaN(Date.parse(q.get("since"))) && Date.parse(q.get("since")) < NOW);
    check("does not override owner_only (feed default = the owner's listings)", !q.has("owner_only"));
    await call({ ...ENV, LISTING_ENGINE_URL: "https://le.example.test/" }, []);
    check("LISTING_ENGINE_URL overrides the host (trailing slash tolerated)",
      calls[0].url.startsWith("https://le.example.test/api/feed/listing-events?"), calls[0].url);
  }

  console.log("\n3. Every failure is an empty 200");
  for (const [label, f] of [
    ["401", async () => ({ status: 401, body: { status: "error" } })],
    ["503", async () => ({ status: 503, body: {} })],
    ["malformed JSON", async () => ({ status: 200, body: "{not json" })],
    ["network error", async () => new Error("ECONNRESET")],
    ["unexpected shape", async () => ({ status: 200, body: { events: "nope" } })],
  ]) {
    const { res, body } = await call(ENV, null, { fetch: f });
    check(`${label} -> 200 with no items`, res.statusCode === 200 && body.items.length === 0, res.body);
    check(`${label} -> the key is not in the response`, !res.body.includes(KEY));
  }

  console.log("\n4. The allow-list");
  {
    const leaky = ev(5, "just_sold", {
      payload: { agent_email: "x@example.com" }, secret: "s",
      listing: listing({ mls_number: "IR999", agent_phone: "555-0100", notes: "private", listing_data: { a: 1 } }),
    });
    const { res, body } = await call(ENV, [leaky]);
    const item = body.items[0] || {};
    const allowed = ["address", "city", "beds", "baths", "sqft", "photo_url", "url", "type", "price",
      "price_label", "sold_on", "sold_label", "open_house"];
    const extra = Object.keys(item).filter((k) => !allowed.includes(k));
    check("a card carries only allow-listed fields", extra.length === 0, extra.join(", "));
    for (const s of ["x@example.com", "555-0100", "private", "IR999", "agent_", "payload", "status"]) {
      check(`the response does not carry "${s}"`, !res.body.includes(s));
    }
    check("the response has cache headers for the CDN",
      /s-maxage=600/.test(res.headers["Netlify-CDN-Cache-Control"] || ""), JSON.stringify(res.headers));
  }

  console.log("\n5. Only https URLs survive");
  {
    const { body } = await call(ENV, [
      ev(1, "just_sold", { listing: listing({ address: "1 A St", photo_url: "http://insecure.example/p.jpg", public_url: "javascript:alert(1)" }) }),
      ev(2, "just_sold", { listing: listing({ address: "2 B St", photo_url: "//cdn.example/p.jpg", public_url: "http://example.com/x" }) }),
    ]);
    check("http / protocol-relative photos are dropped", body.items.every((i) => i.photo_url === null), JSON.stringify(body.items.map((i) => i.photo_url)));
    check("javascript: / http links are dropped", body.items.every((i) => i.url === null), JSON.stringify(body.items.map((i) => i.url)));
    const ok = RA.httpsUrl("https://res.cloudinary.com/x/y.jpg");
    check("https passes", ok === "https://res.cloudinary.com/x/y.jpg", ok);
  }

  console.log("\n6. Sold: last 60 days, honest price label");
  {
    const { body } = await call(ENV, [
      ev(1, "just_sold", { occurred_at: daysAgo(10), listing: listing({ address: "10 Recent Rd" }) }),
      ev(2, "just_sold", { occurred_at: daysAgo(59), listing: listing({ address: "59 Edge Rd" }) }),
      ev(3, "just_sold", { occurred_at: daysAgo(61), listing: listing({ address: "61 Old Rd" }) }),
      ev(4, "just_sold", { occurred_at: null, detected_at: daysAgo(2), listing: listing({ address: "2 Fallback Rd" }) }),
    ]);
    const addrs = body.items.map((i) => i.address);
    check("10 and 59 days ago are in", addrs.includes("10 Recent Rd") && addrs.includes("59 Edge Rd"), addrs.join(" | "));
    check("61 days ago is out", !addrs.includes("61 Old Rd"));
    check("falls back to detected_at when occurred_at is missing", addrs.includes("2 Fallback Rd"));
    check("newest sale first", addrs[0] === "2 Fallback Rd", addrs.join(" | "));
    const s = body.items.find((i) => i.address === "10 Recent Rd");
    check("a list price next to Sold is labelled 'list', never 'sold'", s.price === 525000 && s.price_label === "list", JSON.stringify(s));
    check("sold date on the Denver clock", s.sold_on === "2026-09-21" && s.sold_label === "Sep 21", `${s.sold_on} ${s.sold_label}`);
    const { body: b2 } = await call(ENV, [ev(1, "just_sold", { close_price: 512000 })]);
    check("a real close price is used and labelled 'sold'", b2.items[0].price === 512000 && b2.items[0].price_label === "sold", JSON.stringify(b2.items[0]));
    const { body: b3 } = await call(ENV, [ev(1, "just_sold", { listing: listing({ price: null }) })]);
    check("no price -> no label", b3.items[0].price === null && b3.items[0].price_label === null);
  }

  console.log("\n7. Open houses: today..+14 days, America/Denver");
  {
    const oh = (id, addr, start, end) => ev(id, "open_house_scheduled", {
      occurred_at: null, listing: listing({ address: addr }), open_house: { start, end },
    });
    const { body } = await call(ENV, [
      oh(1, "UTC Instant Way", "2026-10-04T19:00Z", "2026-10-04T15:00"),   // Sat 1-3pm MDT
      oh(2, "Wall Clock Ct", "2026-10-03T10:00", "2026-10-03T12:00"),     // Sat 10-12 local
      oh(3, "Too Far Ln", "2026-10-16", null),                             // day 15
      oh(4, "Yesterday Dr", "2026-09-30T13:00", "2026-09-30T15:00"),
      oh(5, "Earlier Today Ave", "2026-10-01T09:00", "2026-10-01T11:00"),  // ended 11am, now noon
      oh(6, "Later Today Pl", "2026-10-01T15:00", "2026-10-01T17:00"),
    ]);
    const addrs = body.items.map((i) => i.address);
    check("past, finished-today and >14-day open houses are dropped",
      !addrs.includes("Too Far Ln") && !addrs.includes("Yesterday Dr") && !addrs.includes("Earlier Today Ave"), addrs.join(" | "));
    check("soonest first", addrs.join(" | ") === "Later Today Pl | Wall Clock Ct | UTC Instant Way", addrs.join(" | "));
    const utc = body.items.find((i) => i.address === "UTC Instant Way");
    check("a UTC start is shown on the Denver clock (19:00Z = 1:00 PM MDT)",
      utc.open_house.start === "13:00" && utc.open_house.label === "Sun, Oct 4 · 1:00 PM – 3:00 PM", JSON.stringify(utc.open_house));
    const wall = body.items.find((i) => i.address === "Wall Clock Ct");
    check("a wall-clock start is kept as written", wall.open_house.label === "Sat, Oct 3 · 10:00 AM – 12:00 PM", wall.open_house.label);
    const { body: b2 } = await call(ENV, [oh(1, "Date Only Rd", "2026-10-15", null)]);
    check("a date-only open house on day 14 is in, with no time", b2.items[0] && b2.items[0].open_house.label === "Thu, Oct 15" && b2.items[0].open_house.start === null, JSON.stringify(b2.items));
    const { body: b3 } = await call(ENV, [oh(1, "Bad End Rd", "2026-10-04T13:00", "2026-10-04T12:00")]);
    check("an end before the start is dropped, the start kept", b3.items[0].open_house.end === null && b3.items[0].open_house.start === "13:00");
    // Winter: MST is UTC-7.
    const s = RA.denverSlot("2026-12-05T20:00Z");
    check("December UTC -> MST (20:00Z = 13:00)", s.date === "2026-12-05" && s.time === "13:00", JSON.stringify(s));
    const t = RA.denverWallToMs("2026-07-04", "12:00");
    check("Denver wall clock -> instant in summer (12:00 MDT = 18:00Z)", new Date(t).toISOString() === "2026-07-04T18:00:00.000Z", new Date(t).toISOString());
  }

  console.log("\n8. Four cards, open houses first, one card per house");
  {
    const evs = [];
    for (let i = 0; i < 6; i++) evs.push(ev(i + 1, "just_sold", { occurred_at: daysAgo(i + 1), listing: listing({ address: `${i} Sold St` }) }));
    evs.push(ev(20, "open_house_scheduled", { listing: listing({ address: "9 Open Ave" }), open_house: { start: "2026-10-05T13:00", end: null } }));
    evs.push(ev(21, "open_house_scheduled", { listing: listing({ address: "9 Open Ave" }), open_house: { start: "2026-10-06T13:00", end: null } }));
    const { body } = await call(ENV, evs);
    check(`at most ${RA.MAX_ITEMS} cards`, body.items.length === 4, String(body.items.length));
    check("the open house leads", body.items[0].type === "open_house");
    check("a house with two open houses shows once (the sooner)",
      body.items.filter((i) => i.address === "9 Open Ave").length === 1 && body.items[0].open_house.date === "2026-10-05");
    check("rows without an address are skipped",
      (await call(ENV, [ev(1, "just_sold", { listing: listing({ address: "  " }) })])).body.items.length === 0);
    check("other event types are ignored",
      (await call(ENV, [ev(1, "price_improved")])).body.items.length === 0);
  }

  console.log("\n9. Paging and caching");
  {
    RA.resetCache();
    stubFetch(async (url, n) => {
      const after = new URL(url).searchParams.get("after_id");
      if (!after) return { status: 200, body: { events: [ev(1, "just_sold", { listing: listing({ address: "Page One" }) })], has_more: true, next_after_id: "1" } };
      return { status: 200, body: { events: [ev(2, "just_sold", { listing: listing({ address: "Page Two" }) })], has_more: false, next_after_id: "2" } };
    });
    const r1 = JSON.parse((await RA.handler({}, {}, { env: ENV, now: () => NOW })).body);
    check("follows next_after_id", calls.length === 2 && r1.items.length === 2, `${calls.length} calls, ${r1.items.length} items`);
    await RA.handler({}, {}, { env: ENV, now: () => NOW + 5 * 60000 });
    check("a second request within 10 minutes is served from memory", calls.length === 2, String(calls.length));
    await RA.handler({}, {}, { env: ENV, now: () => NOW + 11 * 60000 });
    check("after 10 minutes it asks again", calls.length === 4, String(calls.length));

    RA.resetCache();
    stubFetch(async () => ({ status: 500, body: {} }));
    await RA.handler({}, {}, { env: ENV, now: () => NOW });
    await RA.handler({}, {}, { env: ENV, now: () => NOW + 90000 });
    check("an empty/failed result is only cached briefly (retried after 60s)", calls.length === 2, String(calls.length));
    RA.resetCache();
    stubFetch(async () => ({ status: 200, body: { events: [ev(1, "just_sold")], has_more: true, next_after_id: "1" } }));
    await RA.handler({}, {}, { env: ENV, now: () => NOW });
    check("a feed that repeats the same cursor cannot loop", calls.length === 2, String(calls.length));
  }

  console.log("\n10. The built pages and the browser script");
  {
    const SITE_DIR = path.join(ROOT, "site");
    const js = fs.readFileSync(path.join(ROOT, "build", "assets", "js", "recent-activity.js"), "utf8");
    check("the browser script never writes HTML", !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js));
    check("the browser script only follows https links/photos", /isHttps\(item\.url\)/.test(js) && /isHttps\(item\.photo_url\)/.test(js));
    for (const page of ["index.html"]) {
      const f = path.join(SITE_DIR, page);
      if (!fs.existsSync(f)) { check(`${page} was built`, false, "run the build first"); continue; }
      const html = fs.readFileSync(f, "utf8");
      const sec = /<section[^>]*id="recent-activity"[^>]*>/.exec(html);
      check(`${page} carries the strip`, !!sec);
      check(`${page}: the strip ships hidden`, sec && /\shidden[\s>]/.test(sec[0]), sec && sec[0]);
      check(`${page}: it points at the function, not at Listing Engine`,
        sec && sec[0].includes('data-recent-activity="/.netlify/functions/recent-activity"'));
      check(`${page}: loads the content-hashed script, deferred`,
        /<script src="\/assets\/js\/recent-activity\.[0-9a-f]{8,}\.js" defer><\/script>/.test(html));
      check(`${page}: has a real heading for the region`, /id="recent-activity-title"[^>]*>Recently Sold &amp; Open Houses</.test(html));
    }
    const leaks = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(html|js)$/.test(e.name) && /listing-engine-api|x-listing-engine-key|LISTING_FEED_KEY/.test(fs.readFileSync(p, "utf8"))) leaks.push(path.relative(ROOT, p));
      }
    })(SITE_DIR);
    check("nothing published names Listing Engine's API or key header", leaks.length === 0, leaks.slice(0, 5).join(", "));
  }

  console.log(failures === 0 ? "\nAll checks passed" : `\n${failures} check(s) FAILED`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log("  FAIL crashed:", e && e.stack); process.exit(1); });
