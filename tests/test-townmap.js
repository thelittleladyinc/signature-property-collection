// Which county a listing is in, decided from its city — and the two ways that
// decision goes wrong.
//
// 2026-08-18. Christine's luxury search showed 1315 Co-131, McCoy — Eagle County,
// three hours from Loveland, not a county she serves. The filter had not failed.
// McCoy was simply absent from the table, and an unplaceable city is deliberately
// KEPT, so that a genuine listing in an unincorporated corner of Larimer is never
// discarded over a missing entry.
//
// The trap sat in the same screenshot: her $18M Cherry Hills Village listing was
// showing for exactly the same reason. Arapahoe County, squarely in her market,
// and equally absent. "Drop what we cannot place" would have removed an
// eighteen-million-dollar listing in order to remove a wrong one.
//
// So this suite protects the asymmetry: in-area towns must resolve to one of the
// nine, out-of-area towns must resolve to something outside them, and the
// keep-when-unknown default must survive — it is the safety net, not the bug.
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const { inferCountyFromCity, OPERATING_COUNTIES, CO_CITY_COUNTY } =
  require(path.join(ROOT, "netlify", "functions", "lib", "_mls-shared.js"));

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// ---- The two towns from the screenshot ---------------------------------
check("McCoy is placed, and placed OUTSIDE the service area",
  inferCountyFromCity("mccoy") === "eagle" && !OPERATING_COUNTIES.has("eagle"),
  "this is the listing that started it — three hours away, on the luxury page");
check("Cherry Hills Village is placed, and placed INSIDE it",
  inferCountyFromCity("cherry hills village") === "arapahoe" &&
    OPERATING_COUNTIES.has("arapahoe"),
  "the $18M listing that a careless fix would have deleted");

// ---- In-area towns that were unplaceable before -------------------------
const IN_AREA = {
  "greenwood village": "arapahoe", "glendale": "arapahoe", "sheridan": "arapahoe",
  "northglenn": "adams", "federal heights": "adams",
  "evergreen": "jefferson", "conifer": "jefferson", "morrison": "jefferson",
  "nederland": "boulder", "lyons": "boulder", "niwot": "boulder",
  "campion": "larimer", "garden city": "weld", "weldona": "morgan",
};
for (const [city, county] of Object.entries(IN_AREA)) {
  check(`${city} → ${county}, inside the service area`,
    inferCountyFromCity(city) === county && OPERATING_COUNTIES.has(county),
    `got ${inferCountyFromCity(city)}`);
}

// ---- Out-of-area towns a Northern Colorado feed actually surfaces -------
const OUT_OF_AREA = [
  "gypsum", "minturn", "basalt", "oak creek", "hayden", "glenwood springs",
  "carbondale", "craig", "walden", "idaho springs", "black hawk", "woodland park",
  "castle pines", "elizabeth", "manitou springs", "grand junction", "montrose",
  "gunnison", "telluride", "durango", "pagosa springs", "cortez", "canon city",
  "pueblo", "trinidad", "lamar",
];
for (const city of OUT_OF_AREA) {
  const county = inferCountyFromCity(city);
  check(`${city} is placed outside the nine counties`,
    !!county && !OPERATING_COUNTIES.has(county),
    county ? `resolved to ${county}, which IS in the service area` : "not in the table at all");
}

// ---- The safety net must stay ------------------------------------------
check("a town nobody has named yet is still unplaceable, not guessed at",
  inferCountyFromCity("some unincorporated hollow") === null,
  "guessing a county for an unknown town is how a real listing gets deleted");
check("and an empty city does not throw",
  inferCountyFromCity("") === null && inferCountyFromCity(null) === null);

// ---- Table hygiene ------------------------------------------------------
// Every key lowercase and trimmed, because that is what the lookup does to the
// City field before asking. A capitalised key is an entry that can never match.
const badKeys = Object.keys(CO_CITY_COUNTY).filter((k) => k !== k.toLowerCase().trim());
check("every town key is lowercase and trimmed", badKeys.length === 0, badKeys.join(", "));
const badValues = Object.entries(CO_CITY_COUNTY)
  .filter(([, v]) => typeof v !== "string" || v !== v.toLowerCase().trim() || !v);
check("every county value is a non-empty lowercase name", badValues.length === 0,
  badValues.map(([k]) => k).join(", "));

// Every one of the nine operating counties should be reachable from at least one
// town, or the filter can never place a listing there at all.
const covered = new Set(Object.values(CO_CITY_COUNTY));
const uncovered = [...OPERATING_COUNTIES].filter((c) => !covered.has(c));
check("all nine operating counties have at least one town in the table",
  uncovered.length === 0, `no towns map to: ${uncovered.join(", ")}`);

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
