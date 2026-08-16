// The photo probe must (a) distinguish rate limiting from breakage, and (b) refuse
// to run while throttled, because its own resolve + image fetch would add to the
// very 429 it reports. 2026-08-16: Christine hit a 429 after several ?probe=1
// refreshes and the page told her photos were broken. They weren't.
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
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
  return require(`${FN_DIR}/site-health.js`).handler;
}
const mine = [{ listingId: "IRE1059947" }];
function store(extra = {}) {
  return {
    get: async (k) => (k === "mine-listings.json" ? mine : (k in extra ? extra[k] : null)),
    setJSON: async () => {}, list: async () => ({ blobs: [] }),
  };
}
const mediaJson = { value: [{ ListingId: "IRE1059947", Media: [{ Order: 0, MediaURL: "https://media.mlsgrid.com/x.jpg" }] }] };

(async () => {
  process.env.MLSGRID_API_TOKEN = "t"; process.env.LOFTY_API_KEY = "k";
  process.env.GOOGLE_MAPS_API_KEY = "g";
  const row = (p) => JSON.parse(p.body).checks.find((c) => /Listing photos load end to end/.test(c.name));

  console.log("\n1. MLS Grid returns 429 on the image fetch");
  let imageCalls = 0;
  let h = load(store(), async (url) => {
    if (String(url).includes("media.mlsgrid.com")) {
      imageCalls++;
      return { ok: false, status: 429, headers: { get: () => "text/plain" }, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (String(url).includes("api.mlsgrid.com")) return { ok: true, status: 200, json: async () => mediaJson };
    return { ok: false, status: 503, text: async () => "{}", json: async () => ({}), headers: { get: () => null } };
  });
  let res = await h({ queryStringParameters: { format: "json", probe: "1" } });
  let r = row(res);
  console.log(`       ${r.ok ? "✓" : "✗"} ${r.detail.slice(0, 120)}…`);
  check("says rate limited, NOT broken", /Rate limited, not broken/.test(r.detail));
  check("does NOT claim this is the step breaking photos",
    !/exact step breaking the photos/.test(r.detail), r.detail.slice(0, 80));
  check("explains the limit is per ACCOUNT and shared", /per ACCOUNT and shared/.test(r.detail));
  check("owns that refreshing this page contributes", /refreshing this page/.test(r.detail));
  check("tells her visitors self-heal", /re-tries\s*\n?\s*itself|re-tries itself/.test(r.detail.replace(/\s+/g, " ")));
  check("tells her to re-check before treating it as a fault", /before treating it as a fault/.test(r.detail));

  console.log("\n2. A real 403 keeps the blunt wording — it IS broken");
  h = load(store(), async (url) => {
    if (String(url).includes("media.mlsgrid.com")) {
      return { ok: false, status: 403, headers: { get: () => "text/plain" }, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (String(url).includes("api.mlsgrid.com")) return { ok: true, status: 200, json: async () => mediaJson };
    return { ok: false, status: 503, text: async () => "{}", json: async () => ({}), headers: { get: () => null } };
  });
  r = row(await h({ queryStringParameters: { format: "json", probe: "1" } }));
  check("403 still says it's the breaking step", /exact step breaking the photos/.test(r.detail));
  check("403 is not mislabelled as rate limiting", !/Rate limited/.test(r.detail));

  console.log("\n3. Already throttled — the probe must make NO MLS Grid calls");
  let calls = 0;
  const soon = Date.now() + 40000;
  h = load(store({ "mlsgrid-photo-cooldown.json": { until: soon } }), async (url) => {
    if (/mlsgrid\.com/.test(String(url))) calls++;
    return { ok: true, status: 200, json: async () => mediaJson, headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0), text: async () => "{}" };
  });
  r = row(await h({ queryStringParameters: { format: "json", probe: "1" } }));
  console.log(`       ${r.ok ? "✓" : "✗"} ${r.detail.slice(0, 120)}…`);
  check("zero MLS Grid calls while throttled", calls === 0, `${calls} calls`);
  check("says it declined rather than passing silently", /Not tested just now/.test(r.detail));
  check("shows how long the cool-off has left", /\d+s cool-off/.test(r.detail));
  check("explains it would add to the rate limiting", /add to the rate limiting/.test(r.detail));
  check("not reported as a failure — declining isn't breakage", r.ok === true);

  console.log("\n4. The sync's own suspension flag is respected too");
  calls = 0;
  h = load(store({ "mlsgrid-suspension.json": { suspendedUntil: soon } }), async (url) => {
    if (/mlsgrid\.com/.test(String(url))) calls++;
    return { ok: true, status: 200, json: async () => mediaJson, headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0), text: async () => "{}" };
  });
  r = row(await h({ queryStringParameters: { format: "json", probe: "1" } }));
  check("zero calls during a sync suspension", calls === 0, `${calls} calls`);
  check("same honest wording", /Not tested just now/.test(r.detail));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
