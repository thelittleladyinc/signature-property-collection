// The health page must be live, or it is worse than not existing.
//
// 2026-08-17. Christine: "confirm that all is valid and live for the health status
// or else there is no reason for it." She said that after "I feel like I already
// did the cloud thing yesterday" -- and she had. The page was still showing the
// pre-fix Cloudinary verdict, I read it, and I told her it was still broken.
//
// The cause was structural, not cosmetic. Five rows on that page are live probes
// whose results are cached in Blobs: Google, the photo chain, Cloudinary, the
// Lofty key, the Lofty lead. All five were gated behind ?probe=1, so a plain
// /status visit rendered whatever the last probe concluded -- with no cap on its
// age, and for three of the five, no date printed at all. A verdict from days ago
// was indistinguishable from one from this second.
//
// MY FIRST FIX WAS THE WRONG ONE, and that is worth recording. I made the probes
// refresh themselves. It broke three suites, each guarding a lesson this codebase
// had already paid for: a plain page load makes no outbound calls
// (test-leadprobe.js); rows must not go red for things that are not actually
// broken -- "the crying-wolf mistake the Cloudinary row already taught us"
// (test-optional.js); a considered cached verdict must not be silently overwritten
// (test-tagsnotreturned.js). Probing was never the missing piece. DISCLOSURE was.
//
// So this suite pins the properties that make the page mean something without
// spending a cent of quota:
//
//   1. A plain load still makes NO outbound calls. That promise stands.
//   2. A stale reading SAYS it is stale, in absolute time and in words, and stops
//      counting as a pass or a fail -- because it is neither.
//   3. A summary row at the top names everything that is not live, and how to
//      make it live. One click, not five rows of date arithmetic.
//   4. A FRESH failure still fails. Staleness must never become an excuse.
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = path.join(ROOT, "netlify", "functions");
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const MINUTE = 60 * 1000;
const CLOUD_KEY = "cloudinary-usage-check.json";

function load(blobs, fetchImpl) {
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true,
    exports: { getStore: () => blobs } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  global.fetch = fetchImpl;
  return require(path.join(FN_DIR, "site-health.js")).handler;
}

// Blobs stand-in that records writes, so "did it re-probe" is answerable.
function store(seed = {}) {
  const data = new Map(Object.entries(seed));
  const writes = [];
  return {
    data, writes,
    get: async (k) => (data.has(k) ? data.get(k) : null),
    setJSON: async (k, v) => { writes.push(k); data.set(k, v); },
    list: async () => ({ blobs: [] }),
  };
}

// A Cloudinary verdict of a chosen age. Cloudinary is the row this started on.
const cloudVerdict = (ageMs, ok) => ({
  checkedAt: new Date(Date.now() - ageMs).toISOString(),
  ok,
  ...(ok ? { plan: "Free", creditsUsed: "12%" } : { httpCode: 401, error: "cloud_name mismatch" }),
});

// Nothing outbound should be needed for these assertions; anything that does go
// out gets a benign answer so a probe can "succeed" without real credentials.
const inertFetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ status: "OK", results: [], value: [] }),
  text: async () => "{}",
  headers: { get: () => "application/json" },
});

const row = (res, name) => JSON.parse(res.body).checks.find((c) => c.name === name);
const CLOUD_ROW = "Cloudinary account healthy (optional)";

(async () => {
  // Credentials present so the rows are exercised rather than short-circuited.
  process.env.CLOUDINARY_CLOUD_NAME = "cloud";
  process.env.CLOUDINARY_API_KEY = "key";
  process.env.CLOUDINARY_API_SECRET = "secret";
  process.env.MLSGRID_API_TOKEN = "t";

  console.log("\n1. A plain load must still make NO outbound calls");
  {
    // This promise is load-bearing and stays. I briefly replaced it with
    // self-refreshing probes; that broke three suites, each guarding a lesson
    // already paid for here -- see the note above freshen(). Probing was never the
    // missing piece. Disclosure was.
    const s = store({ [CLOUD_KEY]: cloudVerdict(3 * 24 * 60 * MINUTE, false) });
    const seen = [];
    const h = load(s, async (u) => { seen.push(String(u)); return inertFetch(); });
    await h({ queryStringParameters: { format: "json" } });
    check("no outbound calls on a plain page load", seen.length === 0, JSON.stringify(seen).slice(0, 160));
    check("and no verdict was overwritten", !s.writes.includes(CLOUD_KEY));
  }

  console.log("\n2. But a stale reading must SAY it is stale");
  {
    // The actual bug. A 3-day-old failure rendered identically to a live one, so I
    // read Christine's pre-fix Cloudinary verdict and told her it was current.
    const s = store({ [CLOUD_KEY]: cloudVerdict(3 * 24 * 60 * MINUTE, false) });
    const h = load(s, inertFetch);
    const res = await h({ queryStringParameters: { format: "json" } });
    const r = row(res, CLOUD_ROW);
    check("the row states when it was checked", r && /Checked \d{4}-\d{2}-\d{2}/.test(r.detail),
      r && String(r.detail).slice(0, 90));
    check("in words readable at a glance", r && /\b3 days ago\b/.test(r.detail), r && String(r.detail).slice(0, 120));
    check("it warns before the reading is acted on", r && /THIS READING IS OLD/.test(r.detail),
      "a days-old failure shown with no warning — this is the original bug");
    check("and a stale failure does not stand as a current failure", r && r.ok === true,
      "an old failure still turning the row red is what made me tell her it was broken");
  }

  console.log("\n3. ?probe=1 still re-checks against the real services");
  {
    const s = store({ [CLOUD_KEY]: cloudVerdict(3 * 24 * 60 * MINUTE, false) });
    const h = load(s, inertFetch);
    await h({ queryStringParameters: { format: "json", probe: "1" } });
    check("?probe=1 refreshes a stale verdict", s.writes.includes(CLOUD_KEY));
  }

  console.log("\n4. A summary row must name everything that is not live");
  {
    // Per-row notes are the backstop; this is the part that answers "is this page
    // telling me the truth right now" without reading five rows and doing date
    // arithmetic on each.
    const s = store({ [CLOUD_KEY]: cloudVerdict(3 * 24 * 60 * MINUTE, false) });
    const h = load(s, inertFetch);
    const res = await h({ queryStringParameters: { format: "json" } });
    const sum = row(res, "Live checks are current");
    check("the summary row exists", !!sum);
    check("it is first on the page", JSON.parse(res.body).checks[0].name === "Live checks are current",
      JSON.parse(res.body).checks[0].name);
    check("it reports the readings are not current", sum && sum.ok === false);
    check("it names the stale check", sum && /Cloudinary account/.test(sum.detail), sum && sum.detail);
    check("it says how to make them live", sum && /\?probe=1/.test(sum.detail));
    check("it cannot turn the page red by itself", sum && sum.optional === true);
  }

  console.log("\n5. A fresh failure MUST still fail — staleness must not become an excuse");
  {
    const s = store({ [CLOUD_KEY]: cloudVerdict(1 * MINUTE, false) });
    const h = load(s, inertFetch);
    const res = await h({ queryStringParameters: { format: "json" } });
    const r = row(res, CLOUD_ROW);
    check("a 1-minute-old failure is reported as a failure", r && r.ok === false,
      r ? `ok=${r.ok}` : "row missing");
    check("and carries no stale warning", r && !/THIS READING IS OLD/.test(r.detail));
    check("but still says when it was checked", r && /Checked \d{4}/.test(r.detail));
  }

  console.log("\n6. Every probe-backed row discloses its age when the verdict is old");
  {
    // All five probes seeded old, and every probe failing, so the page must fall
    // back to cache on all of them at once.
    const old = (extra) => ({ checkedAt: new Date(Date.now() - 2 * 24 * 60 * MINUTE).toISOString(), ok: false, ...extra });
    const s = store({
      [CLOUD_KEY]: old({ httpCode: 401, error: "cloud_name mismatch" }),
      "google-api-check.json": old({ geocoding: { ok: false, status: "REQUEST_DENIED" }, places: { ok: false, status: "REQUEST_DENIED" } }),
      "photo-pipeline-check.json": old({ detail: "photo chain broke somewhere." }),
      "lofty-key-check.json": old({ httpStatus: 401, body: "bad key" }),
      "lofty-lead-check.json": old({ leadId: "777", httpStatus: 500, body: "boom" }),
      "mine-listings.json": [{ listingId: "IRE1" }],
    });
    process.env.GOOGLE_MAPS_API_KEY = "g";
    process.env.LOFTY_API_KEY = "k";
    // Hangs rather than throws, for the reason explained in case 4.
    const h = load(s, () => new Promise(() => {}));
    const res = await h({ queryStringParameters: { format: "json" } });

    const named = [
      CLOUD_ROW,
      "Geocoding API enabled",
      "Places API enabled",
      "Listing photos load end to end",
      "Lofty API key valid",
      "What Lofty says about your last lead",
    ];
    const silent = named.filter((n) => {
      const r = row(res, n);
      return !r || !/THIS READING IS OLD/.test(r.detail);
    });
    check(
      "all six probe-backed rows disclose a 2-day-old verdict",
      silent.length === 0,
      silent.length ? `silent about their age: ${silent.join(" · ")}` : ""
    );
  }

  console.log("\n7. When a probe never answers, the cached verdict must be labelled old");
  {
    // A third party that never answers must not turn the health page into a
    // timeout -- an unreachable health page is the least useful kind. This is also
    // the ONLY path that renders a cached verdict, so it is where the disclosure
    // that would have caught the original bug has to hold.
    process.env.GOOGLE_MAPS_API_KEY = "g"; // set explicitly, not inherited from case 6
    process.env.LOFTY_API_KEY = "k";
    const s = store({ [CLOUD_KEY]: cloudVerdict(3 * 24 * 60 * MINUTE, false) });
    const h = load(s, () => new Promise(() => {})); // never resolves
    const started = Date.now();
    const res = await h({ queryStringParameters: { format: "json" } });
    const elapsed = Date.now() - started;
    check("it responds at all", res && res.statusCode === 200);
    check(`it responds inside the probe budget (took ${elapsed}ms)`, elapsed < 9000, `${elapsed}ms`);
    const r = row(res, CLOUD_ROW);
    check("it falls back to the cached verdict", !!r);
    if (r) {
      check(
        "it says the age in words a person reads at a glance",
        /\b3 days ago\b/.test(r.detail),
        String(r.detail).slice(0, 120)
      );
      check(
        "it warns before the reading is acted on",
        /THIS READING IS OLD/.test(r.detail),
        "a days-old failure presented with no warning — this is the original bug"
      );
      check(
        "and a stale failure does not stand as a current failure",
        r.ok === true,
        "an old failure still turning the row red is what made me tell her it was broken"
      );
    }
  }

  console.log("");
  console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
