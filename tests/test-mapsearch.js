// Auto-filtering search + "Search This Area" map control + map speed.
//
// 2026-08-18, Christine: "do a search this area polygon and all map functions
// that make it run better - including not having to touch apply when you do
// search homes counties and cities - lets autofilter - and make it more rapid".
//
// Three shipped behaviors pinned here:
//   1. Search Homes auto-runs on ANY filter change (sliders, pickers, pills,
//      chips, More-filters, sort) -- debounced, abortable, briefly cached.
//   2. The communities map grows a "Search This Area" control that resolves
//      the visible viewport to the towns inside it. NOT a per-listing polygon
//      search: the stored listings carry no coordinates (the MLS feed rejects
//      unknown select fields), so towns-in-view is the honest scope until MLS
//      Grid confirms a coordinate field.
//   3. The map draws vectors to canvas and starts its three startup fetches
//      in parallel instead of as a chain.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const searchPage = fs.readFileSync(path.join(ROOT, "site", "search-homes.html"), "utf8");
const cityPage = fs.readFileSync(path.join(ROOT, "site", "communities", "larimer", "loveland.html"), "utf8");
// Built assets get content-hashed names (map.<hash>.js) -- resolve by prefix.
const jsDir = path.join(ROOT, "site", "assets", "js");
const mapFile = fs.readdirSync(jsDir).find((f) => /^map\.[0-9a-f]+\.js$/.test(f) || f === "map.js");
if (!mapFile) { console.log("  FAIL built map.js not found in site/assets/js"); process.exit(1); }
const mapJs = fs.readFileSync(path.join(jsDir, mapFile), "utf8");

// ---- 1. auto-filtering on Search Homes ------------------------------------
for (const [label, page] of [["search-homes", searchPage], ["a city page's embedded search", cityPage]]) {
  check(
    `${label}: one delegated change listener auto-runs the search`,
    page.includes("form.addEventListener('change', function () { autoSearch(); })"),
    "without it, every filter still needs the Search Homes button pressed"
  );
}
check(
  "auto-run is debounced, not per-event",
  /function autoSearch\(\) \{\s*clearTimeout\(autoTimer\);\s*autoTimer = setTimeout\(function \(\) \{ runSearch\(true\); \}, 350\);/.test(searchPage),
  "a slider release plus two checkbox clicks must collapse into ONE request"
);
check(
  "beds/baths pills trigger the auto-run",
  /hiddenInput\.value = btn\.dataset\.value \|\| '';[\s\S]{0,220}?autoSearch\(\);/.test(searchPage),
  "pills are buttons -- they never fire the form's 'change' event on their own"
);
check(
  "chip-remove and clear-buttons trigger it too",
  (searchPage.match(/refreshGeoUi\(\);\s*(?:\/\/[^\n]*\n\s*)*autoSearch\(\);/g) || []).length >= 3,
  "cb.checked = false via script is invisible to the 'change' listener"
);
check(
  "the old sort-only listener is gone (it would double-fire with the delegated one)",
  !searchPage.includes("sortSelect.addEventListener"),
);
check(
  "the Search Homes button still submits (kept as the instant path)",
  searchPage.includes("form.addEventListener('submit'"),
);

// ---- abort + cache: rapid without being chatty ----------------------------
check(
  "a newer search aborts the one on the wire",
  searchPage.includes("if (inflight) { inflight.abort(); inflight = null; }"),
  "otherwise slow response #1 lands on top of search #3's results"
);
check(
  "stale responses are dropped even without AbortController support",
  searchPage.includes("if (ctrl !== inflight) return;"),
);
check(
  "abort is not rendered as an error",
  searchPage.includes("err.name === 'AbortError'"),
  "an aborted fetch rejects; showing 'something went wrong' for it would look broken"
);
check(
  "repeat searches replay from a short in-page cache",
  searchPage.includes("var CACHE_TTL_MS = 2 * 60 * 1000") &&
    searchPage.includes("renderResults(hit.data, hit.at)"),
  "toggling a filter off and back on should cost zero network"
);
check(
  "the cache is capped so a long session can't grow it forever",
  searchPage.includes("if (resultCacheKeys.length > 30) delete resultCache[resultCacheKeys.shift()]"),
);
check(
  "the 'as of' timestamp reports the real fetch time, not the render time",
  searchPage.includes("new Date(fetchedAt).toLocaleString"),
  "a cache replay stamped 'just now' would claim freshness it doesn't have"
);
check(
  "errors from the server still stop the cache (only good data is remembered)",
  /if \(!data\.error\) \{\s*resultCache\[qs\] = \{ data: data, at: Date\.now\(\) \};/.test(searchPage),
  "caching an error page would replay the outage for two minutes after it ends"
);

// ---- 2. the map's Search This Area control --------------------------------
check(
  "map.js defines townsInView over the towns' real coordinates",
  mapJs.includes("function townsInView(map)") && mapJs.includes("bounds.contains([t.lat, t.lng])"),
);
check(
  "the icon cities backstop the drill-down data",
  mapJs.includes("bounds.contains([c.lat, c.lng])"),
  "COUNTY_DATA is fetched -- before it lands, CITY_ICONS is what the view can offer"
);
check(
  "an empty viewport falls back to intersecting counties, never to nothing",
  mapJs.includes("lyr.getBounds().intersects(bounds)"),
);
check(
  "the control exists and is added inside init(), after the typeof L guard",
  mapJs.includes("function addSearchAreaControl(map)") &&
    mapJs.includes("addSearchAreaControl(map);") &&
    mapJs.indexOf("L.Control.extend") > mapJs.indexOf("function addSearchAreaControl"),
  "an L.Control.extend at module scope throws if this file parses before leaflet.js"
);
check(
  "clicking it opens the existing quick-search (price presets included)",
  /openQuickSearch\(\{\s*label: 'This Map Area',\s*cities: townsInView\(map\),\s*covered: true,/.test(mapJs),
);
check(
  "the button doesn't leak clicks through to the map",
  mapJs.includes("L.DomEvent.disableClickPropagation(div)"),
);
check(
  "the control is styled (injected stylesheet)",
  mapJs.includes(".search-area-btn{") && mapJs.includes(".search-area-ctrl{"),
);

// ---- 3. map speed ---------------------------------------------------------
check(
  "vector layers render to canvas",
  mapJs.includes("preferCanvas: true"),
);
check(
  "county data and polygons load in parallel, not as a chain",
  /Promise\.all\(\[\s*loadCountyData\(\),\s*fetch\('\/assets\/data\/noco-counties\.geojson'\)/.test(mapJs),
);
check(
  "the local-spots request starts with them instead of after the polygons draw",
  /var spotsPromise = fetch\('\/\.netlify\/functions\/local-spots'\)[\s\S]*Promise\.all/.test(mapJs),
  "it's the slowest of the three (a function, not a static file) -- chaining it last was the worst possible order"
);
check(
  "spot markers are still only ADDED after the map draws (spotsPromise.then in the draw block)",
  mapJs.includes("spotsPromise.then(function (data) {"),
);

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
