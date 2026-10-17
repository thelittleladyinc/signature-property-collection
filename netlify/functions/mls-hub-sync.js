// The quarter-hour market-data read through the Seller Intelligence hub, at :15
// and :45 (netlify.toml), for MLS_SOURCE=hub only.
//
// 2026-10-17 (wave 2a). The 30-minute sync (sync-listings.js, :00 and :30) reads
// the market-data copy behind the town figures after her Lofty listings. Through
// the hub that copy can be up to ~15 minutes behind MLS Grid, so a 30-minute
// read alone would see a change up to 45 minutes late -- later than today's 30.
// This run reads the hub in between, so in hub mode the copy is read every 15
// minutes and a change reaches it within ~30 (15 at the hub + 15 here), the same
// worst case as today.
//
// It does nothing else, and nothing at all unless MLS_SOURCE is exactly "hub":
//   - with MLS Grid (MLS_SOURCE unset, "mlsgrid", anything else) it returns at
//     once, so MLS Grid's request volume and her Lofty refresh (two requests,
//     every 30 minutes) are exactly what they were;
//   - with LISTINGS_SOURCE=mlsgrid it is refused, as in sync-listings.js;
//   - MLSGRID_MARKET_DATA=off stops it, as it stops the 30-minute read.
// It never calls Lofty, so it cannot compete with the Little Lady site's queue
// drain at the same minutes.
"use strict";

const { LISTINGS_SOURCE } = require("./lib/_mls-shared");
const { mlsSource } = require("./lib/_mls-hub");

exports.handler = async () => {
  const startedAt = Date.now();
  if (mlsSource() !== "hub") return { statusCode: 200, body: "MLS_SOURCE is not hub: nothing to do" };
  const sync = require("./sync-listings");
  if (LISTINGS_SOURCE !== "lofty") return sync.refuseGridListingsViaHub();
  if (!sync.mlsGridMarketDataOn()) return { statusCode: 200, body: "market data switched off (MLSGRID_MARKET_DATA=off)" };
  try {
    const res = await sync.hubMarketDataRun({ startedAt });
    console.log("mls-hub-sync (hub market data):", res && res.body);
    return res;
  } catch (err) {
    console.error("mls-hub-sync: hub market-data run failed:", err && err.message);
    return { statusCode: 200, body: `error: ${err && err.message}` };
  }
};
