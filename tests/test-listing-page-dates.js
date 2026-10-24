// A listing page is dated by its listing, never by the deploy.
//
// 2026-10-24 (CLAUDE.md freshness rule: "a build date is not a content modification
// date"; "MLS/market pages should use the date of the underlying data snapshot").
// /listing/<id> is rendered from lib/_listing-page-shell.html, which build.py writes at
// build time -- so its og:updated_time and last-modified tags and the RealEstateAgent's
// dateModified carried the DEPLOY's date on every listing page, and every deploy moved
// them whatever the listing did. listing-page.js now dates the page by the listing's own
// modificationTimestamp (the MLS's or Lofty's change time), drops the two tags when the
// record has none (and on the not-found / unavailable pages), and drops the agent
// entity's date. Nothing else on the page changes.
"use strict";
process.env.IDX_DISPLAY = "on";
delete process.env.LISTINGS_SOURCE;                 // Lofty, the default
const fs = require("fs");
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const LISTINGS = {
  IRE1061001: {
    listingId: "IRE1061001", address: "1 Test St", city: "Loveland", state: "CO", price: 950000, status: "Active",
    beds: 4, baths: 3, sqft: 3000, agentName: "Christine Gwinnup", photos: [], modificationTimestamp: "2026-10-20T15:04:05.000Z",
  },
  IRE1061002: {
    listingId: "IRE1061002", address: "2 Test St", city: "Windsor", state: "CO", price: 800000, status: "Active",
    agentName: "Christine Gwinnup", photos: [],
  },
};
function load() {
  require.cache[blobsPath] = {
    id: blobsPath, filename: blobsPath, loaded: true,
    exports: { getStore: () => ({
      get: async (k) => (/sync-state/.test(k) ? { lastRunAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString() } : LISTINGS),
      setJSON: async () => {}, list: async () => ({ blobs: [] }),
    }) },
  };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  return require(`${FN_DIR}/listing-page.js`).handler;
}
const meta = (html, re) => { const m = re.exec(html); return m ? m[1] : null; };
const UPDATED = /<meta property="og:updated_time" content="([^"]*)">/;
const MODIFIED = /<meta name="last-modified" content="([^"]*)">/;
const AGENT_DATE = /"@type":\s*"RealEstateAgent"[\s\S]{0,4000}?"dateModified"/;

(async () => {
  process.env.BLOBS_SITE_ID = "s"; process.env.BLOBS_TOKEN = "t";
  const shell = fs.readFileSync(`${FN_DIR}/lib/_listing-page-shell.html`, "utf8");
  check("the shell carries the build's date (what this fixes)", !!meta(shell, UPDATED) && !!meta(shell, MODIFIED) && AGENT_DATE.test(shell));

  const handler = load();
  let res = await handler({ queryStringParameters: { id: "IRE1061001" } });
  check("a listing renders 200", res.statusCode === 200, String(res.statusCode));
  check("og:updated_time is the listing's own change date", meta(res.body, UPDATED) === "2026-10-20", meta(res.body, UPDATED));
  check("last-modified is the listing's own change date", meta(res.body, MODIFIED) === "2026-10-20", meta(res.body, MODIFIED));
  check("the agent entity carries no date", !AGENT_DATE.test(res.body));
  check("...and every JSON-LD block parses (the listing schema is no longer a script tag inside a script tag)", (() => {
    const blocks = [...res.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    try { return blocks.length > 0 && blocks.every((b) => JSON.parse(b)); } catch (e) { return false; }
  })());
  check("the listing schema's datePosted is unchanged (the record's timestamp)", /"datePosted":"2026-10-20T15:04:05.000Z"/.test(res.body));
  check("one RealEstateListing block, wrapped once", (res.body.match(/<script type="application\/ld\+json"><script/g) || []).length === 0 &&
    (res.body.match(/"@type":"RealEstateListing"/g) || []).length === 1);
  check("each tag appears once", (res.body.match(/og:updated_time/g) || []).length === 1 && (res.body.match(/name="last-modified"/g) || []).length === 1);

  res = await handler({ queryStringParameters: { id: "IRE1061002" } });
  check("a listing with no change time: 200, and no date claimed at all",
    res.statusCode === 200 && meta(res.body, UPDATED) === null && meta(res.body, MODIFIED) === null && !AGENT_DATE.test(res.body));

  res = await handler({ queryStringParameters: { id: "IRE9999999" } });
  check("the not-found page (noindex) claims no date either", res.statusCode === 404 && meta(res.body, UPDATED) === null && meta(res.body, MODIFIED) === null);

  const src = fs.readFileSync(`${FN_DIR}/listing-page.js`, "utf8");
  check("every page goes through render(), which dates it (one place)", /return datePage\(out, fields\.DATA_DATE\);/.test(src) &&
    /DATA_DATE: l\.modificationTimestamp \|\| null/.test(src));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
