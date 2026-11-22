// MY_LISTINGS_ELSEWHERE (Signature move, step 1): exactly "on" stops this site's own refresh of her Lofty listings.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { myListingsElsewhere } = require("../netlify/functions/sync-listings.js");

for (const v of [undefined, "", "yes", "true", "1", "off", "onn"]) assert.strictEqual(myListingsElsewhere({ MY_LISTINGS_ELSEWHERE: v }), false, String(v));
for (const v of ["on", " ON ", "On"]) assert.strictEqual(myListingsElsewhere({ MY_LISTINGS_ELSEWHERE: v }), true, v);
const src = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "sync-listings.js"), "utf8");
const handler = src.slice(src.indexOf("exports.handler = async () => {"));
assert.ok(/myListingsElsewhere\(\)\s*\?[\s\S]*?:\s*await loftyScheduledRun\(side, startedAt\)/.test(handler), "the switch guards her listings' refresh");
assert.ok(handler.indexOf("myListingsElsewhere()") < handler.indexOf("hubMarketDataRun"), "the market-data run still follows");
console.log("All checks passed.");
