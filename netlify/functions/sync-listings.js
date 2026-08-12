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

  try {
    while (requestUrl) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        // Out of time for this invocation — save the cursor and resume on
        // the next scheduled run rather than risk a timeout mid-request.
        break;
      }

      const res = await fetch(requestUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`sync-listings: MLS Grid ${res.status}: ${text.slice(0, 500)}`);
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
    console.error("sync-listings: exception during sync", err);
    // Save whatever progress we made before the error, same as a
    // time-budget break — next run resumes from the cursor.
  }

  const passComplete = !requestUrl;
  await store.setJSON(LISTINGS_KEY, listingsById);
  await store.setJSON(SYNC_STATE_KEY, {
    bootstrapped: state.bootstrapped || passComplete,
    cursor: requestUrl,
    lastModified: passComplete ? maxModTimestampThisPass : state.lastModified,
    lastRunAt: new Date().toISOString(),
    lastRunPagesFetched: pagesFetched,
    lastRunRecordsSeen: recordsSeen,
    totalListingsStored: Object.keys(listingsById).length,
  });

  console.log(
    `sync-listings: fetched ${pagesFetched} page(s), ${recordsSeen} record(s), ` +
    `pass ${passComplete ? "complete" : "paused (resumes next run)"}, ` +
    `${Object.keys(listingsById).length} listing(s) now stored.`
  );

  return { statusCode: 200, body: "ok" };
};
