// Server-side search over Christine's replicated IRES listing data, backed
// by Netlify Blobs — NOT a live proxy to MLS Grid anymore (see the
// 2026-08-12 note below for why). This keeps the MLS Grid access token
// secret (it never reaches the browser, and this function doesn't even use
// it — only sync-listings.js does) and enforces the IDX compliance rules
// that must be applied no matter what a client sends in the query string:
//   - Only IRES-sourced listings are ever returned, and only in an
//     on-market status (Active only for the general public search; Active +
//     Active Under Contract + Pending for Christine's own mine=true listing
//     showcase) — no sold/closed data, no other MLS's listings. This is
//     enforced twice over: sync-listings.js never even replicates
//     sold/closed data in the first place, and matchesQuery() re-checks
//     status here too.
//   - Only public-safe fields are requested (see SELECT_FIELDS in
//     _mls-shared.js) — nothing from MLS Grid's IDX Rules 21/31 prohibited
//     list (showing instructions, security info, seller/occupant contact).
//
// Full compliance rules this page (and the disclaimer block rendered with
// it in search-homes.html) is built against:
//   https://www.mlsgrid.com/s/MLS-Grid-IDX-Rules.pdf
//
// *** 2026-08-12: WHY THIS FUNCTION NO LONGER QUERIES MLS GRID DIRECTLY ***
// The live search was failing in production with every single query,
// confirmed via a real MLS Grid response:
//   {"error":{"code":400,"message":"Invalid filter field 'ListPrice'",
//   "details":[{"message":"Replication requests to the Property resource
//   can only be filtered using the following fields: MlgCanView,
//   ModificationTimestamp, OriginatingSystemName, StandardStatus,
//   ListingId, PropertyType, ListOfficeMlsId"}]}}
// MLS Grid's Property resource simply does not allow filtering by
// ListPrice, City, BedroomsTotal, etc. — the site's entire "live filtered
// search" design was built on a request shape MLS Grid rejects outright.
// Their own Best Practices Guide describes the only pattern that actually
// works: replicate the allowed dataset into your own storage on a
// schedule, then filter your own copy. sync-listings.js is that
// replication job (runs every 15 minutes via netlify.toml's scheduled
// function config); this function just reads what it wrote and filters in
// JS — see matchesQuery() in _mls-shared.js, which mirrors the exact same
// filtering logic (city/price/beds/baths/subdivision/waterfront/mine) the
// old OData $filter builder used to send to MLS Grid.
//
// Setup required (one-time, Netlify dashboard -> Site settings ->
// Environment variables): MLSGRID_API_TOKEN (used only by sync-listings.js
// now, not this function).
const { getStore } = require("@netlify/blobs");
const {
  LISTINGS_KEY, SYNC_STATE_KEY, matchesQuery, getBlobStore,
} = require("./_mls-shared");

exports.handler = async (event) => {
  const store = getBlobStore(getStore);
  const params = event.queryStringParameters || {};
  const top = Math.min(parseInt(params.top, 10) || 12, 24);
  const skip = Math.max(parseInt(params.skip, 10) || 0, 0);

  try {
    const [allListings, state] = await Promise.all([
      store.get(LISTINGS_KEY, { type: "json" }),
      store.get(SYNC_STATE_KEY, { type: "json" }),
    ]);

    if (!state) {
      // sync-listings.js hasn't completed a single run yet (e.g. right
      // after first deploy, before its first scheduled 15-minute tick, or
      // MLSGRID_API_TOKEN isn't set in Netlify yet) — distinct from a
      // real search returning zero matches, so the UI can say something
      // more accurate than "no homes match your filters."
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "not_configured", listings: [], totalCount: 0 }),
      };
    }

    const listingsById = allListings || {};
    const matched = Object.values(listingsById)
      .filter((l) => matchesQuery(l, params))
      .sort((a, b) => (b.price || 0) - (a.price || 0));

    const page = matched.slice(skip, skip + top).map((l) => {
      // Strip internal-only fields before they reach the browser.
      const { listingKey, modificationTimestamp, mlgCanView, ...publicFields } = l;
      return publicFields;
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        listings: page,
        totalCount: matched.length,
        fetchedAt: state.lastRunAt || null,
      }),
    };
  } catch (err) {
    console.error("listings-search function error:", err);
    // message/name are included in the response (not just server logs)
    // since neither ever contains a secret — just the JS error text — and
    // it means diagnosing a production issue doesn't require dashboard log
    // access at all, only the endpoint's own JSON response.
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "exception",
        message: err && err.message,
        name: err && err.name,
        listings: [],
        totalCount: 0,
      }),
    };
  }
};
