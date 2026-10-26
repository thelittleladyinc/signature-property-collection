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
// queue written back merged with anything queued meanwhile), with a time budget
// (DRAIN_BUDGET_MS below) so the write-back always happens, offset from this site's :00/:30 sync
// and from the Little Lady's :15/:45 drain (netlify.toml). The sync now only
// refreshes her listings and the town figures.
"use strict";

// 2026-10-26 (Netlify request log). One scheduled run (03:05 UTC) answered HTTP 500
// in 0.7 s with no function invocation behind it -- Netlify's side, before this code
// ran; the scheduler sent the run again a second later and it answered 200. Nothing
// here can cause or prevent that. What this file does now so a run always says what
// happened:
//   - its code is loaded inside the handler, so a load failure answers a clear 503
//     with the reason instead of Netlify's crash page;
//   - a paused queue (LOFTY_QUEUE_DRAIN=off) answers "paused" and says so in the log,
//     instead of "ok";
//   - every run logs its outcome, including "nothing queued".
//
// DRAIN_BUDGET_MS. Netlify documents 30 seconds for a scheduled function, but its
// scheduler stops waiting after about 15: in the same log every scheduled run that
// went past it ended HTTP 499 at 14.97 s and was sent again at once (see
// sync-listings.js SCHEDULER_WAIT_MS). A drain killed there never writes the queue
// back, so a lead Lofty already accepted would be replayed again next run (a second
// note, a re-fired tag). No replay starts, or runs, past this budget; the write-back
// after it, and a cold start before it, fit in what is left of the 15 seconds. A
// replay that needs longer finishes on the next run (lib/_lofty.js followupsPending).
const DRAIN_BUDGET_MS = 10000;

const DIAG_STORE = "mls-listings";  // where submission-created.js queues them

function answer(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "text/plain; charset=utf-8" }, body };
}

exports.handler = async () => {
  const startedAt = Date.now();
  let getStore, getBlobStore, drainFailedPushes, queueDrainOff, loftyViaHub;
  try {
    ({ getStore } = require("@netlify/blobs"));
    ({ getBlobStore } = require("./lib/_mls-shared"));
    ({ drainFailedPushes, queueDrainOff } = require("./lib/_lofty"));
    ({ loftyViaHub } = require("./lib/_lofty-hub"));
  } catch (err) {
    console.error("lofty-queue-drain: could not load its code (the queue is untouched):", err && err.message);
    return answer(503, `not run: the drain's code did not load (${(err && err.message) || "unknown error"}); the queue is untouched`);
  }
  if (queueDrainOff()) {
    console.log("lofty-queue-drain: paused (LOFTY_QUEUE_DRAIN is off); the queue is kept as it is.");
    return answer(200, "paused: LOFTY_QUEUE_DRAIN is off; the queue is kept as it is");
  }
  const apiKey = process.env.LOFTY_API_KEY;
  // 2026-10-26: with LOFTY_VIA_HUB=on the replay goes through the hub, not this key.
  if (!apiKey && !loftyViaHub()) {
    console.log("lofty-queue-drain: LOFTY_API_KEY not set — nothing to retry with.");
    return answer(200, "no Lofty key configured");
  }
  try {
    const store = getBlobStore(getStore, DIAG_STORE);
    const result = await drainFailedPushes(store, apiKey, { deadline: startedAt + DRAIN_BUDGET_MS });
    console.log(`lofty-queue-drain: ${result.attempted || result.locked || result.deferred || result.finished
      ? JSON.stringify(result) : "nothing to replay"} (${Date.now() - startedAt} ms)`);
    return answer(200, result.locked ? "skipped: another drain holds the lease" : "ok");
  } catch (err) {
    // Nothing is lost: the queue stays as it was for the next run.
    console.error("lofty-queue-drain failed (queue kept for the next run):", err && err.message);
    return answer(200, "error logged");
  }
};
