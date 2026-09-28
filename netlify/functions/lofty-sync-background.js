// The full Lofty listing refresh, run as a Netlify BACKGROUND function -- the
// "-background" suffix is what gives it 15 minutes instead of a synchronous
// function's 10 seconds. A full refresh reads every page of every county the
// site serves (~255 requests on 2026-09-28) plus details for anything new or
// changed, which does not fit in the 30 seconds a scheduled function gets.
//
// sync-listings.js (the 30-minute schedule) calls this when a refresh is due --
// every two hours, or sooner after a partial one. All the logic, including the
// lock and the "not again within 20 minutes" guard that makes this public URL
// harmless to call, lives in lib/_lofty-listings.js (runFullCrawl).
//
// It writes only the Lofty catalogue keys (LOFTY_KEYS in _mls-shared.js), so it
// is safe to run while the site is still reading MLS Grid -- which is how the
// catalogue gets built and checked before the switch goes live.
"use strict";
const { getStore } = require("@netlify/blobs");
const { getBlobStore, BLOB_STORE_NAME } = require("./lib/_mls-shared");
const { runFullCrawl } = require("./lib/_lofty-listings");

exports.handler = async () => {
  try {
    const store = getBlobStore(getStore, BLOB_STORE_NAME);
    const result = await runFullCrawl({ store, apiKey: process.env.LOFTY_API_KEY });
    console.log("lofty-sync-background:", JSON.stringify(result).slice(0, 1500));
  } catch (err) {
    console.error("lofty-sync-background failed:", err && err.message);
  }
  return { statusCode: 200, body: "" };
};
