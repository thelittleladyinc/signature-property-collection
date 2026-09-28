// Refresh Christine's own listings from Lofty now, instead of waiting for the
// 30-minute schedule (sync-listings.js).
//
// 2026-09-28. Scheduled functions only run on the published site and cannot be
// called by URL, so without this there is no way to see a new listing of hers
// on the site sooner than half an hour -- or to check a deploy preview at all.
//
// POST /.netlify/functions/refresh-my-listings
//   -> { answer, accepted, hers, requests, errors } -- counts and Lofty's own
//      error text only; no key, no listing data.
//
// It is a public URL, so it refuses to run within a minute of the last refresh
// (lib/_lofty-listings.js MIN_MANUAL_GAP_MS): at most two Lofty requests a
// minute, against Lofty's 500-a-minute limit.
"use strict";

const { getStore } = require("@netlify/blobs");
const { getBlobStore, LISTINGS_SOURCE } = require("./lib/_mls-shared");
const { runMineSync } = require("./lib/_lofty-listings");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (!event || event.httpMethod !== "POST") {
    return json(405, { error: "POST to refresh Christine's listings from Lofty now." });
  }
  if (LISTINGS_SOURCE !== "lofty") {
    return json(409, { error: "Listings come from MLS Grid on this site (LISTINGS_SOURCE=mlsgrid)." });
  }
  const apiKey = process.env.LOFTY_API_KEY;
  if (!apiKey) return json(503, { error: "LOFTY_API_KEY is not set in Netlify." });
  try {
    const store = getBlobStore(getStore);
    const result = await runMineSync({ store, apiKey, manual: true });
    return json(result.skipped ? 429 : 200, result);
  } catch (err) {
    console.error("refresh-my-listings:", err && err.message);
    return json(500, { error: err && err.message });
  }
};
