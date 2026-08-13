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
  LISTINGS_KEY, SYNC_STATE_KEY, MINE_LISTINGS_KEY, matchesQuery, getBlobStore,
} = require("./lib/_mls-shared");

exports.handler = async (event) => {
  const store = getBlobStore(getStore);
  const params = event.queryStringParameters || {};
  const top = Math.min(parseInt(params.top, 10) || 12, 24);
  const skip = Math.max(parseInt(params.skip, 10) || 0, 0);
  const mine = params.mine === "true";

  try {
    // 2026-08-13 (performance fix): mine=true is the overwhelming majority
    // of traffic to this function — it's what 97+ pages across the site
    // (blog posts, city pages, the homepage spotlight, current-listings.html)
    // use for their "one of Christine's listings" widgets. Reading the small
    // MINE_LISTINGS_KEY copy instead of the full regional dataset (tens of
    // thousands of records) turns those into a near-instant lookup instead
    // of a full-dataset parse+scan on every single page load. Falls back to
    // the full dataset if the small copy hasn't been computed yet (e.g.
    // right after this deploy, before sync-listings.js's first run since
    // the update) so nothing breaks during rollout.
    let allListings;
    if (mine) {
      const mineOnly = await store.get(MINE_LISTINGS_KEY, { type: "json" });
      if (mineOnly) {
        allListings = Object.fromEntries(
          mineOnly.filter((l) => l && l.listingId).map((l) => [l.listingId, l]),
        );
      }
    }
    const [fullListings, state] = await Promise.all([
      allListings ? Promise.resolve(null) : store.get(LISTINGS_KEY, { type: "json" }),
      store.get(SYNC_STATE_KEY, { type: "json" }),
    ]);
    if (!allListings) allListings = fullListings;

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

    // 2026-08-13 (performance fix): a card only ever shows the cover photo,
    // but every listing was shipping its ENTIRE photos[] array (up to ~50
    // signed MLS Grid URLs) on every list request — dead weight on every
    // single page load. listingId is the on-demand counterpart: when the
    // "View All N Photos" lightbox is actually opened, the browser fetches
    // just that one listing's full gallery via this param instead of it
    // having been in the payload all along. Only ever hit for one of
    // Christine's own listings today (the gallery button only appears on
    // current-listings.html's mine=true cards), so this stays a tiny,
    // cheap lookup even though it's written generically.
    if (params.listingId) {
      const listing = listingsById[params.listingId];
      if (!listing) {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "not_found", photos: [] }),
        };
      }
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        },
        body: JSON.stringify({ photos: listing.photos || [] }),
      };
    }

    // 2026-08-13 (Christine's request): on her own mine=true showcase, a
    // listing going under contract is a good thing to lead with (it shows
    // momentum), not something to bury — she wants it to keep appearing in
    // the same feed (not split into a separate section, which is already
    // how this worked) but sorted to the front, ahead of her still-active
    // listings. Only affects mine=true: the general public search
    // (PUBLIC_STATUSES = ["Active"] in _mls-shared.js) never contains a
    // non-Active status in the first place, so this is a no-op there.
    const isUnderContractOrPending = (l) => {
      const s = String(l.status || "").toLowerCase();
      return s.indexOf("contract") !== -1 || s.indexOf("pending") !== -1;
    };
    const matched = Object.values(listingsById)
      .filter((l) => matchesQuery(l, params))
      .sort((a, b) => {
        if (mine) {
          const aFirst = isUnderContractOrPending(a) ? 1 : 0;
          const bFirst = isUnderContractOrPending(b) ? 1 : 0;
          if (aFirst !== bFirst) return bFirst - aFirst;
        }
        return (b.price || 0) - (a.price || 0);
      });

    const page = matched.slice(skip, skip + top).map((l) => {
      // Strip internal-only fields before they reach the browser. photos[]
      // is trimmed to just the cover photo here — see the listingId block
      // above for how the full gallery is fetched, only when needed.
      const {
        listingKey, modificationTimestamp, mlgCanView, photos, ...publicFields
      } = l;
      return { ...publicFields, photoCount: Array.isArray(photos) ? photos.length : (l.photo ? 1 : 0) };
    });

    const response = {
      listings: page,
      totalCount: matched.length,
      fetchedAt: state.lastRunAt || null,
    };
    if (params.debug === "true") {
      // Opt-in only (?debug=true) so this never shows up in a normal buyer's
      // network tab — added 2026-08-12 while confirming the very first
      // sync-listings.js runs are actually finding/storing listings, since
      // there's no other way to see sync-state.json from outside Netlify's
      // dashboard. Nothing secret in here — no tokens, no raw MLS data.
      response.debug = {
        bootstrapped: !!state.bootstrapped,
        cursorPending: !!state.cursor,
        lastRunPagesFetched: state.lastRunPagesFetched ?? null,
        lastRunRecordsSeen: state.lastRunRecordsSeen ?? null,
        totalListingsStored: state.totalListingsStored ?? null,
        lastModified: state.lastModified || null,
        lastRunError: state.lastRunError || null,
        // 2026-08-13: surfaces why Cloudinary caching isn't kicking in for
        // Christine's own listings even after the env vars are added --
        // see the diagnostics note in sync-listings.js. lastRunCoverPhotos
        // Cached being 0 run after run alongside a non-null
        // lastCloudinaryError means the env vars aren't taking effect (or
        // are wrong); a real error message here means they ARE configured
        // but the actual Cloudinary/MLS Grid call is failing.
        lastRunCoverPhotosCached: state.lastRunCoverPhotosCached ?? null,
        lastCloudinaryError: state.lastCloudinaryError || null,
      };
    }
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // 2026-08-13 (performance fix): the underlying data only changes
        // every 15 minutes (sync-listings.js's schedule), so there's no
        // reason every page load re-runs this function from scratch.
        // Skipped for ?debug=true so live diagnostic checks are never
        // served a stale cached copy. stale-while-revalidate lets Netlify's
        // CDN serve an older-but-still-fresh-enough response instantly
        // while it refreshes in the background, instead of visitors ever
        // waiting on a cold function invocation.
        ...(params.debug === "true" ? {} : {
          "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        }),
      },
      body: JSON.stringify(response),
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
