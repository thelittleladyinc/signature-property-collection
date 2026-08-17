// A spot backed by a GOOGLE REVIEW and no YouTube video must work end to end.
// Christine's review of one Berthoud restaurant has 10k+ views on its own —
// more than this whole map's YouTube footage combined — so the review path is
// not a fallback, it's the highest-value case.
// Repo root derived from this file's own location, never hardcoded: these suites
// run both locally and in GitHub Actions, where the checkout is at
// /home/runner/work/<repo>/<repo>. An absolute path would pass here and fail there.
const ROOT = require("path").resolve(__dirname, "..");
const fs = require("fs");
const path = require("path");
const FN_DIR = `${ROOT}/netlify/functions`;
const LIB = path.join(FN_DIR, "lib/_local-spots.json");
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const SRC = `${ROOT}/build/data/local_spots.json`;
const original = fs.readFileSync(LIB, "utf8");
const originalSrc = fs.readFileSync(SRC, "utf8");
const data = JSON.parse(original);
data.spots = [{
  name: "Test Cantina",
  category: "restaurant",
  address: "Test Cantina",
  city: "Berthoud",
  cityHref: "/communities/larimer/berthoud.html",
  searchCity: "Berthoud",
  blurb: "A review-backed spot.",
  googleReviewUrl: "https://maps.google.com/example-review",
  reviewViews: 10400,
}];
fs.writeFileSync(LIB, JSON.stringify(data, null, 2));

(async () => {
  try {
    require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true,
      exports: { getStore: () => ({ get: async () => null, setJSON: async () => {} }) } };
    for (const k of Object.keys(require.cache)) {
      if (k.startsWith(FN_DIR) && k !== blobsPath) delete require.cache[k];
    }
    process.env.GOOGLE_MAPS_API_KEY = "gkey";
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      status: "OK", results: [{ geometry: { location: { lat: 40.3, lng: -105.08 } }, formatted_address: "Berthoud" }] }) });

    const res = await require(`${FN_DIR}/local-spots.js`).handler({});
    const body = JSON.parse(res.body);
    check("the review-only spot is returned", body.resolved === 1, JSON.stringify(body));
    const pin = body.spots[0];
    check("it has coordinates", Number.isFinite(pin.lat) && Number.isFinite(pin.lng));
    check("videoId is absent, not empty-string", !("videoId" in pin) || pin.videoId === null, JSON.stringify(pin.videoId));
    check("the review URL is passed through", pin.googleReviewUrl === "https://maps.google.com/example-review");
    check("review views are kept SEPARATE from YouTube views",
      pin.reviewViews === 10400 && pin.views === undefined, JSON.stringify({ r: pin.reviewViews, v: pin.views }));

    // The map's own logic, exercised directly rather than described.
    const mapJs = require("./_assets").readBuiltAsset(ROOT, "js", "map", ".js");
    check("tooltip switches to Read for a review pin", /'★ Read: '/.test(mapJs));
    check("no iframe is built without a videoId", /if \(poi\.videoId\) \{[\s\S]{0,400}youtube-nocookie/.test(mapJs));
    check("media panel is hidden rather than left black", /wrap\.style\.display = 'none'/.test(mapJs));
    check("credit says Reviewed, not Filmed", /Reviewed by Christine/.test(mapJs));
    check("the button promises only what it opens", /See It On Google/.test(mapJs) &&
      !/Read My Review On Google/.test(mapJs));
    check("Google view count is labelled as Google", /views on Google/.test(mapJs));

    // And the build guard: neither source at all must still be rejected.
    data.spots = [{ name: "No Source", category: "restaurant", address: "x", city: "Loveland" }];
    fs.writeFileSync(`${ROOT}/build/data/local_spots.json`,
      JSON.stringify(data, null, 2));
    const { execFileSync } = require("child_process");
    let rejected = false;
    try {
      execFileSync("python3", ["build/build.py"], { cwd: `${ROOT}`, stdio: "pipe" });
    } catch (e) {
      rejected = /carry nothing of Christine/.test(String(e.stdout) + String(e.stderr));
    }
    check("a spot with NO source of hers still fails the build", rejected);
  } finally {
    // Restore from the in-memory copies. This used to `git checkout` the data
    // file, which silently threw away uncommitted work — it ate a spot I had
    // just added and I shipped a commit without it.
    fs.writeFileSync(LIB, original);
    fs.writeFileSync(SRC, originalSrc);
    require("child_process").execFileSync("python3", ["build/build.py"],
      { cwd: `${ROOT}`, stdio: "pipe" });
  }
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
