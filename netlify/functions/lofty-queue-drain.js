// Retries website leads Lofty refused, on its own schedule.
//
// 2026-10-04 (re-audit). submission-created.js queues every lead Lofty refuses
// (lofty-failed-pushes.json in the "mls-listings" Blobs store, with the full lead)
// so it can be replayed. Until now the replay ran FIRST inside the 30-minute
// listing sync (sync-listings.js), with no deadline, in the same 30 seconds
// Netlify gives a scheduled function. A slow Lofty -- three leads, each a 2-second
// lookup, up to two 6-second creates and the follow-up steps -- could get the run
// killed before the queue was written back, so an accepted lead was replayed
// again next run (a duplicate note, a re-fired tag), and before her own listings
// were refreshed at all.
//
// The Little Lady site already runs the drain as its own schedule; this is the
// same function (lib/_lofty.js drainFailedPushes: at most 3 leads a run, a
// create-only lease so two schedules never replay the same lead at once, the
// queue written back merged with anything queued meanwhile), with a 20-second
// budget so the write-back always happens, offset from this site's :00/:30 sync
// and from the Little Lady's :15/:45 drain (netlify.toml). The sync now only
// refreshes her listings and the town figures.
"use strict";
const { getStore } = require("@netlify/blobs");
const { getBlobStore } = require("./lib/_mls-shared");
const { drainFailedPushes } = require("./lib/_lofty");

const DIAG_STORE = "mls-listings";  // where submission-created.js queues them
// Netlify stops a scheduled function at 30 seconds. No replay starts, or runs,
// past this, so the queue is always written back.
const DRAIN_BUDGET_MS = 20000;

exports.handler = async () => {
  const apiKey = process.env.LOFTY_API_KEY;
  if (!apiKey) {
    console.log("lofty-queue-drain: LOFTY_API_KEY not set — nothing to retry with.");
    return { statusCode: 200, body: "no Lofty key configured" };
  }
  try {
    const store = getBlobStore(getStore, DIAG_STORE);
    const result = await drainFailedPushes(store, apiKey, { deadline: Date.now() + DRAIN_BUDGET_MS });
    if (result.attempted || result.locked) {
      console.log(`lofty-queue-drain: ${JSON.stringify(result)}`);
    }
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    // Nothing is lost: the queue stays as it was for the next run.
    console.error("lofty-queue-drain failed (queue kept for the next run):", err && err.message);
    return { statusCode: 200, body: "error logged" };
  }
};
