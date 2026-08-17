// Every category the data actually uses must have its own glyph, and a local
// spot must not fall through to the golf flag — the bug this test exists for.
// Repo root derived from this file's own location, never hardcoded: these suites
// run both locally and in GitHub Actions, where the checkout is at
// /home/runner/work/<repo>/<repo>. An absolute path would pass here and fail there.
const ROOT = require("path").resolve(__dirname, "..");
const fs = require("fs");
const { readBuiltAsset } = require("./_assets");
const mapJs = readBuiltAsset(ROOT, "js", "map", ".js");
const spots = require(`${ROOT}/netlify/functions/lib/_local-spots.json`).spots;
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// Pull the POI_ICONS keys straight out of the shipped file.
const block = mapJs.slice(mapJs.indexOf("var POI_ICONS = {"), mapJs.indexOf("var POI_MARKERS"));
const keys = [...block.matchAll(/^\s{4}(\w+):\s*'/gm)].map(m => m[1]);
console.log(`  glyphs defined: ${keys.join(", ")}`);

const used = [...new Set(spots.map(s => s.category))];
check("every category in the data has its own glyph",
  used.every(c => keys.includes(c)), "missing: " + used.filter(c => !keys.includes(c)).join(", "));
check("the lookup reads category, not just icon",
  /POI_ICONS\[poi\.icon \|\| poi\.category\]/.test(mapJs));
check("the fallback is a generic pin, NOT the golf flag",
  /\|\| POI_ICONS\.spot/.test(mapJs) && !/\|\| POI_ICONS\.golf/.test(mapJs));
check("a generic 'spot' glyph exists to fall back to", keys.includes("spot"));
check("restaurants are the most common category, and have a glyph",
  keys.includes("restaurant") && used.includes("restaurant"));

// Simulate the real lookup for each spot.
const glyphFor = (spot) => (keys.includes(spot.icon || spot.category) ? (spot.icon || spot.category) : "spot");
const golfed = spots.filter(s => glyphFor(s) === "golf" && s.category !== "golf");
check("no non-golf spot renders the golf flag", golfed.length === 0,
  golfed.map(s => s.name).join(", "));
const fellBack = spots.filter(s => glyphFor(s) === "spot" && s.category !== "spot");
check("no spot silently falls back", fellBack.length === 0, fellBack.map(s => `${s.name} (${s.category})`).join(", "));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
