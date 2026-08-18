// The 2 rps pacer: why listing photos now load two at a time.
//
// 2026-08-18, from Christine's inbox, twice in one afternoon:
//
//   "Your hourly 5.0 requests per second exceeded the 2 requests per second
//    limit."  — MLS Grid API Access Warning, 12:00-13:00 and 14:00-15:00 EDT
//
// Both windows line up with her testing the search page. The burst was the
// page itself: 12 listing cards share one HTTP/2 connection, so the browser
// fired every /listing-photo request in the same instant, and each first-ever
// photo is a live MLS Grid fetch. loading="lazy" does not stagger images
// already near the viewport. Warnings escalate to suspension at 6 rps, and
// this account has been suspended twice (08-01, 08-12) — so the pace of the
// PAGE is now the thing under test, not just the pace of the functions.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const searchPage = fs.readFileSync(path.join(ROOT, "site", "search-homes.html"), "utf8");
const listingPage = fs.readFileSync(path.join(ROOT, "netlify", "functions", "listing-page.js"), "utf8");
const buildPy = fs.readFileSync(path.join(ROOT, "build", "build.py"), "utf8");

// ---- the search page ------------------------------------------------------
check(
  "search cards render photos as data-src, not src",
  searchPage.includes("'<img data-src=\"' + esc(cover)"),
  "a plain src fires the instant the HTML lands — that IS the burst"
);
check(
  "the pacer is defined on the search page",
  /function _pqPump\(\)/.test(searchPage) && /function pacePhotos\(root\)/.test(searchPage)
);
check(
  "and is invoked after cards are inserted",
  /insertAdjacentHTML\([\s\S]{0,200}?pacePhotos\(resultsEl\)/.test(searchPage),
  "defining the queue without calling it would leave every image permanently blank"
);
check(
  "at most 2 photos load concurrently",
  searchPage.includes("_pqActive < 2 &&"),
  "2 in flight is the account-wide rps ceiling MLS Grid enforces"
);
check(
  "off-screen cards still cost nothing (IntersectionObserver gate)",
  searchPage.includes("IntersectionObserver' in window"),
  "without it, pacing would LOAD MORE than lazy did — every below-fold photo"
);
check(
  "a failed photo retries exactly once, after the cooldown",
  searchPage.includes("data-retried") && /80000/.test(searchPage),
  "listing-photo's failure placeholders cache for 60-120s; retrying sooner re-hits the limit"
);
check(
  "the retry busts the negatively-cached placeholder",
  searchPage.includes("'r=1'"),
  "the edge caches by full query string (netlify-vary: query), so the same URL would just replay the failure"
);

// ---- the live-feed widgets (subdivision/blog pages) -----------------------
const feedPages = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) walk(full);
    else if (f.name.endsWith(".html") && fs.readFileSync(full, "utf8").includes("live-feed")) feedPages.push(full);
  }
})(path.join(ROOT, "site"));
const feedsMissingPacer = feedPages.filter((f) => {
  const h = fs.readFileSync(f, "utf8");
  return !h.includes("pacePhotos(resultsEl)");
});
check(
  `every page with an embedded live feed paces its photos (${feedPages.length} page(s))`,
  feedPages.length > 0 && feedsMissingPacer.length === 0,
  feedsMissingPacer.slice(0, 3).map((f) => path.relative(ROOT, f)).join(", ")
);

// ---- the listing detail page ----------------------------------------------
check(
  "the detail gallery's FIRST photo keeps a real src (it is the page's main image)",
  /i === 0\n\s*\? `<img src=/.test(listingPage),
  "pacing the hero would delay the largest contentful paint for no rps benefit — it is one request"
);
check(
  "every other gallery photo is data-src and paced",
  /: `<img data-src=/.test(listingPage) && /_pqActive < 2/.test(listingPage)
);
check(
  "the detail page's pacer self-starts (no pacePhotos() caller exists there)",
  /querySelectorAll\('img\[data-src\]'\)/.test(listingPage),
  "server-rendered HTML has no insertAdjacentHTML moment to hook — the script must sweep on load"
);
check(
  "and the pacer script is emitted AFTER the gallery markup",
  listingPage.indexOf("listing-detail-thumbs") < listingPage.indexOf("${nearbyScript()}"),
  "a sweep that runs before the images exist paces nothing"
);

// ---- the source of truth stays single -------------------------------------
check(
  "build.py's pacer is one shared helper, not copies drifting apart",
  (buildPy.match(/def _paced_photo_js/g) || []).length === 1 &&
    (buildPy.match(/\{_paced_photo_js\(\)\}/g) || []).length === 2,
  "the search block and the live-feed block must interpolate the SAME queue"
);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
