// Scheduled function (see netlify.toml — runs every 15 minutes, MLS Grid's
// own recommended replication cadence, well inside the 12-hour maximum
// refresh interval required by IDX Rule 12) that replicates Christine's
// licensed IRES listings into Netlify Blobs.
//
// This exists because MLS Grid's Property resource rejects live $filter
// queries on ListPrice/City/etc. — see _mls-shared.js's file comment for
// the exact error and why "replicate on a schedule, filter your own copy"
// is the only integration pattern MLS Grid actually allows. listings-search.js
// (the function the browser calls on every search) reads what this job
// writes; it never talks to MLS Grid directly anymore.
//
// Bootstrap vs. incremental: the very first runs page through EVERY
// currently-allowed listing (there's no way to know the count in advance,
// and MLS Grid's Best Practices Guide explicitly warns against range
// queries on ModificationTimestamp for the initial pull). Each invocation
// is time-boxed well under Netlify's 30s scheduled-function limit — if a
// pass isn't finished, the @odata.nextLink cursor is saved to Blobs and the
// *next* scheduled run (15 min later) picks up exactly where this one left
// off, so a large initial catalog bootstraps over a few runs without ever
// timing out or losing progress. Once bootstrapped, every run is a small,
// fast incremental pull (only records modified since the last completed
// pass), per MLS Grid's own recommended pattern.
const { getStore } = require("@netlify/blobs");
const {
  BASE_URL, SELECT_FIELDS, REPLICATED_STATUSES,
  LISTINGS_KEY, SYNC_STATE_KEY, mapListing, getBlobStore,
} = require("./_mls-shared");

const TIME_BUDGET_MS = 20000; // leave headroom under the 30s function limit
const PAGE_SIZE = 50; // kept small since $expand=Media makes each record heavy
// 2026-08-12 (rate-limit fix): MLS Grid suspended API access today (and
// several times before, per notify@mlsgrid.com emails going back to
// mid-July) for exceeding their request-rate limits. Their own numbers:
// warning at >4 requests/sec at any instant or >7200/hour, temporary
// suspension at >6 req/sec or >18000/hour. This loop was firing requests
// back-to-back with zero delay -- a single bootstrap run was measured
// fetching 140 pages inside the 20s time budget, i.e. ~7 req/sec sustained,
// already past the "warning" line on its own; stacked with anything else
// hitting the same token in the same window (a manual "Run now", overlapping
// invocations, etc.) it's easy to blow past the suspension threshold, which
// is exactly what happened (MLS Grid logged 13 req/sec for this hour).
// Suspension is temporary and self-clears once usage drops back under the
// limit for a while, but it stalls the sync in the meantime, so the real
// fix is to just never send requests that fast. A fixed delay between pages
// keeps this comfortably under every limit above (roughly 1.4 req/sec) at
// the cost of fewer pages per 15-minute run -- the bootstrap pass just takes
// a few more cycles to finish, which is fine; nothing here is time-critical
// beyond IDX Rule 12's 12-hour refresh requirement.
const REQUEST_DELAY_MS = 700;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statusClause() {
  return "(" + REPLICATED_STATUSES.map((s) => `StandardStatus eq '${s}'`).join(" or ") + ")";
}

function baseFilter(sinceTimestamp) {
  const clauses = [
    "OriginatingSystemName eq 'ires'",
    "MlgCanView eq true",
    statusClause(),
  ];
  if (sinceTimestamp) {
    clauses.push(`ModificationTimestamp gt ${sinceTimestamp}`);
  }
  return clauses.join(" and ");
}

exports.handler = async () => {
  const token = process.env.MLSGRID_API_TOKEN;
  if (!token) {
    console.error("sync-listings: MLSGRID_API_TOKEN not set, skipping run.");
    return { statusCode: 200, body: "no token configured" };
  }

  const store = getBlobStore(getStore);
  const startedAt = Date.now();

  let state = (await store.get(SYNC_STATE_KEY, { type: "json" })) || {
    bootstrapped: false,
    cursor: null,
    lastModified: null,
  };

  let listingsById = (await store.get(LISTINGS_KEY, { type: "json" })) || {};
  let requestUrl;
  if (state.cursor) {
    // Mid-pass (bootstrap or incremental) — the saved nextLink already
    // encodes the full query, just keep following it.
    requestUrl = state.cursor;
  } else {
    const filter = baseFilter(state.bootstrapped ? state.lastModified : null);
    const qs = new URLSearchParams({
      "$filter": filter,
      "$select": SELECT_FIELDS,
      "$expand": "Media",
      "$top": String(PAGE_SIZE),
      "$orderby": "ModificationTimestamp asc",
    });
    requestUrl = `${BASE_URL}?${qs.toString()}`;
  }

  let pagesFetched = 0;
  let recordsSeen = 0;
  let maxModTimestampThisPass = state.lastModified;
  // 2026-08-12: surfaced into sync-state.json (and from there into
  // listings-search.js's ?debug=true response) so a failed MLS Grid call
  // is visible from the browser instead of only in Netlify's own function
  // logs, which we don't have a way to read directly.
  let lastRunError = null;
  // 2026-08-12: tracks whether this run ended because MLS Grid rejected a
  // request (4xx/5xx), as opposed to running out of time budget or a
  // network-level exception. Used below to decide whether it's safe to
  // save `requestUrl` as next run's resume cursor.
  let httpErrorOccurred = false;

  try {
    while (requestUrl) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        // Out of time for this invocation — save the cursor and resume on
        // the next scheduled run rather than risk a timeout mid-request.
        break;
      }

      if (pagesFetched > 0) {
        // Throttle: see REQUEST_DELAY_MS comment above. Skipped before the
        // very first request of the run (no prior request to space out
        // from) so it doesn't eat into the time budget for nothing.
        await sleep(REQUEST_DELAY_MS);
      }

      const res = await fetch(requestUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        lastRunError = `MLS Grid ${res.status}: ${text.slice(0, 500)}`;
        console.error(`sync-listings: ${lastRunError}`);
        httpErrorOccurred = true;
        break;
      }
      const json = await res.json();
      const items = json.value || [];
      pagesFetched += 1;
      recordsSeen += items.length;

      for (const item of items) {
        const mapped = mapListing(item);
        if (mapped.mlgCanView === false || !REPLICATED_STATUSES.includes(mapped.status)) {
          // Deleted / no-longer-qualifying / off the replicated status set
          // — remove it if we had it, per MLS Grid's MlgCanView contract.
          if (mapped.listingId) delete listingsById[mapped.listingId];
          continue;
        }
        if (mapped.listingId) listingsById[mapped.listingId] = mapped;
        if (mapped.modificationTimestamp &&
          (!maxModTimestampThisPass || mapped.modificationTimestamp > maxModTimestampThisPass)) {
          maxModTimestampThisPass = mapped.modificationTimestamp;
        }
      }

      requestUrl = json["@odata.nextLink"] || null;
    }
  } catch (err) {
    lastRunError = `exception: ${err && err.message}`;
    console.error("sync-listings: exception during sync", err);
    // Save whatever progress we made before the error, same as a
    // time-budget break — next run resumes from the cursor.
  }

  const passComplete = !requestUrl;
  // 2026-08-12: previously this always saved `requestUrl` as the resume
  // cursor, including when it was the exact URL MLS Grid just rejected
  // with a 4xx (e.g. the WaterfrontFeatures $select bug). That poisoned
  // cursor then got replayed on every subsequent run forever — bypassing
  // the fresh query this code builds from the current SELECT_FIELDS/filter
  // — which is why fixing the underlying field bug in _mls-shared.js never
  // actually took effect in production. On an HTTP rejection specifically,
  // we now discard the cursor instead, so the next run rebuilds a brand
  // new request from scratch using whatever the code currently asks for.
  // (A time-budget break or network exception still resumes from
  // `requestUrl` as before — those aren't proof the query itself is bad.)
  const cursorToSave = httpErrorOccurred ? null : requestUrl;
  await store.setJSON(LISTINGS_KEY, listingsById);
  await store.setJSON(SYNC_STATE_KEY, {
    bootstrapped: state.bootstrapped || passComplete,
    cursor: cursorToSave,
    lastModified: passComplete ? maxModTimestampThisPass : state.lastModified,
    lastRunAt: new Date().toISOString(),
    lastRunPagesFetched: pagesFetched,
    lastRunRecordsSeen: recordsSeen,
    totalListingsStored: Object.keys(listingsById).length,
    lastRunError,
  });

  console.log(
    `sync-listings: fetched ${pagesFetched} page(s), ${recordsSeen} record(s), ` +
    `pass ${passComplete ? "complete" : "paused (resumes next run)"}, ` +
    `${Object.keys(listingsById).length} listing(s) now stored.`
  );

  return { statusCode: 200, body: "ok" };
};
