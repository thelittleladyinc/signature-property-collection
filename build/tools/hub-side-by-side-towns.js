#!/usr/bin/env node
//
// The side-by-side check for the town figures (Christine, 2026-10-23: "it's very important that we don't lose
// anything at all since everything is completely integrated"). OFF unless HUB_SIDE_BY_SIDE lists mls_read.
//
// Run by .github/workflows/town-market.yml right after this site's own town figures are produced: it reads
// build/data/town_market.json as that step left it and the hub's GET /v1/market/towns, compares them town by town
// (homes for sale, median asking price, price per square foot) with the shared toolkit's rules, and sends one row
// per town (field NAMES only, the town as parityKey's hash) to the hub's ledger, POST /v1/parity/record. At most
// HUB_SIDE_BY_SIDE_MAX towns a run (default 20), a different slice each day.
//
// READ-ONLY for this repository: it writes no file, changes nothing the workflow commits, and ALWAYS exits 0, so it
// can never fail or change the job. Settings (names only): HUB_SIDE_BY_SIDE, HUB_SIDE_BY_SIDE_MAX, HUB_API_URL,
// HUB_API_KEY. Prints counts and field names, never a figure, the address or the key.
//
// The same file runs in both website repos (netlify/functions/lib/_hub-side-by-side.js is byte-identical there).
"use strict";

const path = require("path");

(async () => {
  try {
    const side = require(path.join(__dirname, "..", "..", "netlify", "functions", "lib", "_hub-side-by-side.js"));
    const r = await side.townSideBySide({ ownFile: path.join(__dirname, "..", "data", "town_market.json") });
    if (!r.attempted && r.reason === "off") console.log("Side-by-side town figures: off (HUB_SIDE_BY_SIDE does not list mls_read).");
  } catch (err) {
    console.log("Side-by-side town figures: not run (an error was ignored).");
  }
  process.exit(0);
})();
