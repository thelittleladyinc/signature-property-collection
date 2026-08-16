// A listing page must carry Christine's own local spots for its town — the thing
// no portal listing page can have — and must degrade to nothing for a town where
// she has no spots yet.
const FN_DIR = "/home/user/signature-property-collection/netlify/functions";
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

function listing(city) {
  return {
    listingId: "IRE123", address: "123 Test St", city, state: "CO", zip: "80538",
    price: 750000, beds: 4, baths: 3, sqft: 2400, status: "Active", mlgCanView: true,
    propertyType: "Residential", agentName: "Someone Else", photoCount: 3,
  };
}
function load(city) {
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
    getStore: () => ({
      // listings.json is a MAP keyed by listing id, not an array.
      get: async (k) => (k === "listings.json" ? { IRE123: listing(city) }
        : k === "sync-state.json" ? { lastRunAt: "2026-08-16T00:00:00Z" } : null),
    }),
  } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  return require(`${FN_DIR}/listing-page.js`).handler;
}
(async () => {
  const res = await load("Loveland")({ queryStringParameters: { id: "IRE123" } });
  const html = res.body || "";
  check("page renders", res.statusCode === 200, String(res.statusCode));
  check("the section appears", /Around Loveland, From Christine/.test(html), html.slice(0, 200));
  check("headline sells judgement, not a database", /actually worth your time/.test(html));
  const titles = [...html.matchAll(/spot-card-title">([^<]+)</g)].map(m => m[1]);
  console.log(`       spots shown: ${titles.join(" | ")}`);
  check("exactly three spots", titles.length === 3, String(titles.length));
  // Derived, not hardcoded: the leader changes as reviews and videos are added.
  // Sweet Heart Winery leads today only because it carries BOTH (1,188 + 1,000).
  const all = require("/home/user/signature-property-collection/netlify/functions/lib/_local-spots.json").spots;
  const total = (s) => (s.views || 0) + (s.reviewViews || 0);
  const expected = all.filter(s => s.city === "Loveland").sort((a, b) => total(b) - total(a))[0];
  check("most-watched first, counting both platforms", titles[0] === expected.name,
    `got ${titles[0]}, expected ${expected.name} (${total(expected).toLocaleString()})`);
  check("her videos are embedded", /youtube-nocookie\.com\/embed\//.test(html));
  check("view counts are shown with their platform", /views on YouTube/.test(html));
  check("uses the shared spot styles", /class="spot-grid"/.test(html));

  const berthoud = await load("Berthoud")({ queryStringParameters: { id: "IRE123" } });
  check("a review-backed town shows her words instead of a video",
    /spot-quote/.test(berthoud.body) && /views on Google/.test(berthoud.body));

  const windsor = await load("Windsor")({ queryStringParameters: { id: "IRE123" } });
  check("a town with no spots renders NO empty heading",
    !/From Christine/.test(windsor.body) && windsor.statusCode === 200);

  const unknown = await load("Nowheresville")({ queryStringParameters: { id: "IRE123" } });
  check("an unknown town degrades silently", !/From Christine/.test(unknown.body));
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("harness error:", e.message); process.exit(1); });
