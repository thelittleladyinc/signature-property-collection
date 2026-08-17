// Christine's spots must never be hidden by a map view.
//
// 2026-08-17. Building the county drill-down, I hid every base marker on entering
// a county so town pins would not render on top of the city icons for the same
// town. That was right for city icons and wrong for everything else: it also hid
// the POI markers, which are her spots — the "▶ Watch" pins carrying her YouTube
// tours and reviews with their real view counts. She opened a county and wrote
// "all of my embedded videos are all gone!!!! I had so many".
//
// Nothing had been deleted, and that is beside the point. Those pins are the one
// thing this map has that a portal map structurally cannot, and a view that hides
// them is broken whether or not the data survives. Reassurance is not a fix and a
// comment is not a mechanism, so the rule gets pinned here.
//
// WHY A STRING CHECK. tests.yml stays dependency-light and a browser in CI is a
// second thing to keep working — the same reasoning test-mobilegrid.js records for
// the same reason. A browser found this one (9 town pins, 0 city markers, POI
// still present); this pins the cause, which is a property of the source.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// Built copy resolved by stem: build.py content-hashes it (see tests/_assets.js).
const { builtAsset } = require("./_assets");
for (const rel of ["build/assets/js/map.js", null]) {
  const file = rel ? path.join(ROOT, rel) : builtAsset(ROOT, "js", "map", ".js");
  const label = rel ? "source" : "built";
  if (!fs.existsSync(file)) { check(`${label} map.js exists`, false); continue; }
  const src = fs.readFileSync(file, "utf8");

  // The function that places every spot — both the hardcoded POI_MARKERS and the
  // ones local-spots.js resolves at runtime, which is the great majority of them.
  const start = src.indexOf("function addPoiMarker");
  const body = start === -1 ? "" : src.slice(start, src.indexOf("\n  }", start));
  check(`${label}: addPoiMarker() found`, start !== -1);

  if (start !== -1) {
    // The exact regression: registering the spot with the list the county view
    // hides. Any push into a marker registry from here is suspect.
    check(
      `${label}: a spot is never registered with a hide list`,
      !/\w+Markers\.push\(/.test(body),
      "addPoiMarker registers the marker somewhere that can hide it — this is the 2026-08-17 regression"
    );
    // And it must not remove itself when a drill-down is active, which was the
    // other half: spots arriving from local-spots.js after entering a county.
    check(
      `${label}: a spot never removes itself for the county view`,
      !/countyView[\s\S]*removeLayer/.test(body),
      "a spot fetched during a drill-down would vanish"
    );
  }

  // Only city icons and their labels may be hidden. If a second thing starts
  // feeding that list, this is the line that should make someone stop and think.
  const pushes = (src.match(/cityMarkers\.push\(/g) || []).length;
  check(
    `${label}: exactly the two city-marker registrations, nothing more`,
    pushes === 2,
    `${pushes} cityMarkers.push() call(s) — only the city icon and its label belong here`
  );

  // The old name must not come back with the old meaning.
  check(
    `${label}: no baseMarkers registry`,
    !/baseMarkers/.test(src),
    "the catch-all marker list is back; it is what swept up her spots"
  );

  // 2026-08-17: a zoomend handler now exists, to reveal the play badge on pins that
  // carry one of her films. Zoom on this map has been blamed for vanishing pins
  // TWICE -- once wrongly (a stale cached script) and once correctly (the county
  // drill-down hid every base marker). So the rule for anything bound to zoom here
  // is that it may change how a pin LOOKS and never whether it EXISTS.
  const zoomAt = src.indexOf("map.on('zoomend'");
  if (zoomAt !== -1) {
    // The handler body, resolved by name from the binding.
    const fnName = (src.slice(zoomAt, zoomAt + 120).match(/map\.on\('zoomend',\s*(\w+)/) || [])[1];
    const defAt = fnName ? src.indexOf(`function ${fnName}(`) : -1;
    const body = defAt === -1 ? "" : src.slice(defAt, src.indexOf("\n    }", defAt));
    check(`${label}: the zoom handler was found`, !!body, `could not resolve ${fnName}`);
    if (body) {
      for (const [what, re] of [
        ["remove a layer", /removeLayer|\.remove\(\)/],
        ["add a layer", /addLayer|addTo\(/],
        ["hide anything", /display\s*=\s*['"]none|visibility|\.hide\(/],
        ["clear a registry", /=\s*\[\]|\.length\s*=\s*0/],
      ]) {
        check(
          `${label}: the zoom handler cannot ${what}`,
          !re.test(body),
          "zoom may change how a pin looks, never whether it exists — this is the third-time rule"
        );
      }
    }
  }

  // And the badge must be additive: a pin without a video still gets its glyph.
  const iconAt = src.indexOf("function poiIcon");
  const iconBody = iconAt === -1 ? "" : src.slice(iconAt, src.indexOf("\n  }", iconAt));
  if (iconBody) {
    check(
      `${label}: the video badge is added to the glyph, not swapped for it`,
      /glyph \+ badge|glyph\s*\+\s*\w*badge/.test(iconBody),
      "the category glyph must survive — it is what makes the map readable at a glance"
    );
  }
}

// The spots have to still be REACHABLE too — a map that shows them but has
// nothing behind them is its own failure. This is the function the map fetches.
const spotsFn = path.join(ROOT, "netlify", "functions", "local-spots.js");
check("local-spots.js still exists", fs.existsSync(spotsFn));
const mapSrc = fs.readFileSync(path.join(ROOT, "build", "assets", "js", "map.js"), "utf8");
check(
  "the map still fetches her spots at runtime",
  /\/\.netlify\/functions\/local-spots/.test(mapSrc),
  "the map no longer asks for her spots at all"
);
check(
  "and still opens a video modal for one",
  /openPoiModal/.test(mapSrc)
);

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
