// Shared constants + helpers between sync-listings.js (the scheduled job
// that replicates MLS Grid data into Netlify Blobs) and listings-search.js
// (the on-demand function the browser calls, which now reads and filters
// that replicated copy instead of querying MLS Grid live per request).
//
// WHY THIS FILE EXISTS (2026-08-12): MLS Grid's Property resource only
// allows $filter on a fixed set of fields for "replication" requests —
// confirmed directly from a real 400 response:
//   "Replication requests to the Property resource can only be filtered
//   using the following fields: MlgCanView, ModificationTimestamp,
//   OriginatingSystemName, StandardStatus, ListingId, PropertyType,
//   ListOfficeMlsId"
// ListPrice, City, BedroomsTotal, etc. are NOT in that list — every search
// this site does (by price/city/beds/baths) was therefore impossible to
// build as a live pass-through query, which is why the site's search was
// failing in production. The correct MLS Grid integration pattern (per
// their own Best Practices Guide) is: replicate the allowed dataset into
// your own storage on a schedule (they recommend every 15 minutes, and
// require a refresh at least every 12 hours per IDX Rule 12), then filter
// your own copy. See sync-listings.js for the replication job.

const BASE_URL = "https://api.mlsgrid.com/v2/Property";

// 2026-08-12: WaterfrontFeatures pulled after a real 400 from MLS Grid --
// "The field 'WaterfrontFeatures' does not exist or is unable to be
// retrieved" for this IRES feed specifically (this is the field that had
// been silently blocking every sync-listings.js run since launch, well
// past the earlier ListPrice/City $filter fix). WaterfrontYN plus the
// PublicRemarks keyword check in matchesQuery() below is still enough to
// flag waterfront listings without it.
//
// 2026-08-12 (second pass): once WaterfrontFeatures was fixed and the
// poisoned resume-cursor bug in sync-listings.js was also fixed (see that
// file's 2026-08-12 comments), the sync got further and hit a SECOND
// invalid-select-field 400, this time on ListOfficeName -- "The field
// 'ListOfficeName' does not exist or is unable to be retrieved" for this
// same IRES feed. Pulled here too. This is a real gap: IDX Rule 24 wants
// the listing brokerage shown per listing, and right now officeName will
// just be null (the UI already drops it cleanly via .filter(Boolean) in
// the compliance line, so nothing breaks -- it just won't show a per-
// listing office name until we hear back from IRES's Data Feed team,
// RETS@iresmls.com, on what field (if any) actually exposes it on this
// feed. ListAgentFullName/phone/email are unaffected and still display.
//
// 2026-08-12 (third pass): same story again, this time ListAgentDirectPhone
// -- "The field 'ListAgentDirectPhone' does not exist or is unable to be
// retrieved." Pulled here too.
//
// 2026-08-12 (fourth pass, final): rather than keep discovering these one
// per 15-minute sync cycle, tested the exact request shape sync-listings.js
// sends (same $filter/$select/$expand/$top/$orderby) directly against MLS
// Grid's live API with MLSGRID_API_TOKEN, iterating on each 400 until it
// returned 200. ListAgentEmail was also rejected -- "The field
// 'ListAgentEmail' does not exist or is unable to be retrieved" -- and
// after removing it too, the request succeeded end-to-end: 200 OK, real
// listings with real addresses/prices/photos, @odata.nextLink present for
// pagination. This is now a confirmed-working field list, not a guess.
//
// Net effect: this IRES feed exposes ListAgentFullName but neither
// ListAgentDirectPhone nor ListAgentEmail -- no per-listing agent contact
// info comes through at all, only their name. IDX Rule 24's "contact"
// requirement isn't fully satisfiable from this feed as a result; the
// site's own "Ask A Question" / "Request A Tour" buttons on each listing
// card (which route through this site's contact form, not the MLS data)
// are the practical substitute. Same open item as ListOfficeName above:
// worth asking IRES's Data Feed team (RETS@iresmls.com) whether any of
// these three fields (office name, agent phone, agent email) are available
// under a different field name on this feed, since none of the "obvious"
// RESO Data Dictionary names for them work here.
const SELECT_FIELDS = [
  "ListingId", "ListingKey", "StandardStatus", "ListPrice",
  "BedroomsTotal", "BathroomsTotalInteger", "LivingArea",
  "StreetNumber", "StreetName", "StreetSuffix", "City", "StateOrProvince", "PostalCode",
  "PublicRemarks", "PropertyType", "PropertySubType", "SubdivisionName",
  "WaterfrontYN",
  "ListAgentFullName",
  "CoListAgentFullName", "ModificationTimestamp", "MlgCanView",
].join(",");

// Every status either search mode ever needs (mine=true shows Active +
// under-contract; the public search shows Active only) — replicating this
// combined set covers both without needing two separate synced copies.
// Sold/Closed is deliberately never included here, so it's never even
// pulled into storage in the first place — the strictest possible version
// of "no sold/closed data" compliance.
const REPLICATED_STATUSES = ["Active", "Active Under Contract", "Pending"];
const MINE_STATUSES = ["Active", "Active Under Contract", "Pending"];
const PUBLIC_STATUSES = ["Active"];

const AGENT_SURNAME = (process.env.LISTING_AGENT_SURNAME || "gwinnup").toLowerCase();
const LUXURY_PRICE_FLOOR = 950000;

// 2026-08-14 (market-scoping research): borrowed directly from Christine's
// own Expired-Luxury app (lib/mlsSyncRunner.ts), which hit this exact
// problem on this exact IRES feed first. Its own comment: "This MLS feed
// frequently leaves CountyOrParish blank or in a format the filter can't
// match... City is far more reliably populated, so when the county can't
// be matched we infer it from the city." Rather than trust MLS Grid's raw
// county field (or worse, try to filter on it server-side -- Expired-
// Luxury's mlsClient.ts confirms MLS Grid flatly rejects every geographic
// $filter field, including CountyOrParish, City, and PostalCode, with
// "Invalid filter field" 400s), this infers county from City, which this
// site already selects safely. Table copied verbatim from Expired-Luxury
// so both apps agree on the same city->county mapping.
const CO_CITY_COUNTY = {
  // Larimer
  "fort collins": "larimer", "loveland": "larimer", "estes park": "larimer",
  "wellington": "larimer", "timnath": "larimer", "berthoud": "larimer",
  "bellvue": "larimer", "laporte": "larimer", "la porte": "larimer",
  "livermore": "larimer", "red feather lakes": "larimer", "drake": "larimer",
  "masonville": "larimer", "glen haven": "larimer", "waverly": "larimer",
  // Weld
  "greeley": "weld", "evans": "weld", "la salle": "weld", "lasalle": "weld",
  "windsor": "weld", "johnstown": "weld", "milliken": "weld", "mead": "weld",
  "platteville": "weld", "gilcrest": "weld", "kersey": "weld", "eaton": "weld",
  "ault": "weld", "pierce": "weld", "nunn": "weld", "severance": "weld",
  "hudson": "weld", "keenesburg": "weld", "fort lupton": "weld", "dacono": "weld",
  "firestone": "weld", "frederick": "weld", "erie": "weld", "lochbuie": "weld",
  "gill": "weld", "galeton": "weld", "briggsdale": "weld", "grover": "weld",
  "roggen": "weld", "wiggins": "morgan",
  // Broader Front Range -- kept available for a future widen (same as
  // Expired-Luxury's table) but not applied unless OPERATING_COUNTIES below
  // is actually set to include them.
  "denver": "denver", "boulder": "boulder", "longmont": "boulder",
  "lafayette": "boulder", "louisville": "boulder", "superior": "boulder",
  "castle rock": "douglas", "parker": "douglas", "highlands ranch": "douglas",
  "lone tree": "douglas", "aurora": "arapahoe", "centennial": "arapahoe",
  "littleton": "arapahoe", "englewood": "arapahoe", "thornton": "adams",
  "westminster": "adams", "brighton": "adams", "commerce city": "adams",
  "golden": "jefferson", "arvada": "jefferson", "lakewood": "jefferson",
  "wheat ridge": "jefferson", "broomfield": "broomfield",
  "colorado springs": "el paso", "monument": "el paso",
  "breckenridge": "summit", "frisco": "summit", "silverthorne": "summit",
  "vail": "eagle", "avon": "eagle", "edwards": "eagle", "eagle": "eagle",
  "aspen": "pitkin", "snowmass village": "pitkin", "steamboat springs": "routt",
};

function inferCountyFromCity(cityLower) {
  if (!cityLower) return null;
  return CO_CITY_COUNTY[cityLower] || null;
}

// 2026-08-14: OFF by default (empty = no filtering at all, current behavior
// unchanged) -- set OPERATING_COUNTIES in Netlify's env vars (comma-
// separated, e.g. "larimer,weld") once Christine has confirmed which
// counties the public search/current-listings pages should actually cover.
// Deliberately never applied to Christine's OWN listings (see the
// isHerListing() exclusion everywhere this is used) -- she should never
// lose one of her own listings to a geography filter even if it happens to
// be outside the configured set. Important: this can only ever shrink what
// gets STORED, never speed up the crawl itself -- MLS Grid's API rejects
// every geographic $filter field outright (confirmed in both MLS Grid's
// own docs and Expired-Luxury's production history), so every record still
// has to be paged through and inspected regardless; this just decides
// what's worth keeping in Blobs afterward.
const OPERATING_COUNTIES = new Set(
  (process.env.OPERATING_COUNTIES || "")
    .split(",")
    .map((c) => c.toLowerCase().replace(/\s+county$/, "").trim())
    .filter(Boolean)
);

const BLOB_STORE_NAME = "mls-listings";
const LISTINGS_KEY = "listings.json";
const SYNC_STATE_KEY = "sync-state.json";
// 2026-08-13 (performance fix): a small, pre-filtered copy of ONLY
// Christine's own listings (typically 5-10 records), maintained by
// sync-listings.js alongside the full LISTINGS_KEY blob. Every mine=true
// request — used by 97+ pages across the site (blog posts, city pages,
// the homepage spotlight, current-listings.html) via top:1/top:6-style
// widgets — used to force listings-search.js to pull and JSON-parse the
// ENTIRE regional dataset (tens of thousands of listings, tens of MB) just
// to find her handful. Reading this tiny key instead turns that into a
// near-instant lookup. The full-dataset LISTINGS_KEY is still read for the
// general public luxury search (mine not set) and as a one-time fallback
// if this key hasn't been computed yet (e.g. right after this deploy,
// before sync-listings.js's first run since the update).
const MINE_LISTINGS_KEY = "mine-listings.json";

// Netlify's docs promise getStore(name) auto-configures itself with no
// setup inside any Netlify Function — but in production here it actually
// throws MissingBlobsEnvironmentError (confirmed live, 2026-08-12: a real
// request to listings-search returned a 502 with that exact error).
// Whatever's different about this site's environment, the documented,
// guaranteed-to-work fallback is passing siteID/token explicitly — see
// https://docs.netlify.com/build/data-and-storage/netlify-blobs/#external-clients
// BLOBS_SITE_ID is just the site's Project ID (not secret — Project
// configuration > General > Project information > Project ID in the
// Netlify dashboard). BLOBS_TOKEN is a real Personal Access Token
// Christine has to generate herself (User settings > Applications >
// Personal access tokens > New access token) and add as a Netlify env var
// — same pattern as MLSGRID_API_TOKEN, never passed through this codebase.
// If those two env vars aren't set yet, this still tries the zero-config
// path first, in case Netlify's auto-injection starts working on its own.
// storeName defaults to BLOB_STORE_NAME (the MLS listings store) so every
// existing caller (sync-listings.js, listings-search.js) is unaffected;
// nearby-places.js passes its own store name to keep its distance-lookup
// cache separate from the listings data.
function getBlobStore(getStoreFn, storeName) {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  const name = storeName || BLOB_STORE_NAME;
  if (siteID && token) {
    return getStoreFn(name, { siteID, token });
  }
  return getStoreFn(name);
}

// 2026-08-14 (photo order bug): MLS Grid's docs say $expand doesn't support
// $orderby ("We do not support $select or $orderby on the $expand
// resources") — Media items come back in whatever order MLS Grid's API
// happens to return them, which is NOT guaranteed to be display order.
// Confirmed live: a bathroom photo was showing as the cover/primary photo
// for a listing instead of the exterior hero shot the agent actually chose
// in MLS. RESO's Media resource defines a standard "Order" field (0 =
// primary/hero photo, ascending from there) for exactly this reason — sort
// by it ourselves before extracting MediaURLs so the cover photo and
// gallery order match what's actually set in MLS. Falls back to whatever
// order the API returned if Order isn't present on a given feed (stable
// sort — items without a numeric Order keep their relative position at the
// end), so this is a no-op on feeds that don't send it, not a regression.
function sortMediaByOrder(media) {
  return media
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const orderA = typeof a.m?.Order === "number" ? a.m.Order : Number.MAX_SAFE_INTEGER;
      const orderB = typeof b.m?.Order === "number" ? b.m.Order : Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.i - b.i; // stable: preserve original relative order on ties
    })
    .map(({ m }) => m);
}

function mapListing(item) {
  const address = [item.StreetNumber, item.StreetName, item.StreetSuffix]
    .filter(Boolean).join(" ");
  const rawMedia = Array.isArray(item.Media) ? item.Media : [];
  const media = sortMediaByOrder(rawMedia);
  const photos = media.map((m) => m && m.MediaURL).filter(Boolean);
  const photo = photos.length ? photos[0] : null;

  return {
    listingId: item.ListingId || item.ListingKey || null,
    listingKey: item.ListingKey || null,
    price: item.ListPrice ?? null,
    beds: item.BedroomsTotal ?? null,
    baths: item.BathroomsTotalInteger ?? null,
    sqft: item.LivingArea ?? null,
    address: address || null,
    city: item.City || null,
    state: item.StateOrProvince || null,
    zip: item.PostalCode || null,
    status: item.StandardStatus || null,
    remarks: item.PublicRemarks || null,
    propertyType: item.PropertySubType || item.PropertyType || null,
    subdivision: item.SubdivisionName || null,
    waterfront: item.WaterfrontYN === true || null,
    officeName: item.ListOfficeName || null,
    // 2026-08-14: NOT in SELECT_FIELDS above by default -- ListOfficeMlsId is
    // only ever requested by sync-listings.js's isolated, try/caught
    // discoverHerOfficeMlsId() call (see that file), never by the main
    // crawl, specifically because this feed has a real, repeated history of
    // rejecting "obvious" RESO field names under their standard names
    // (WaterfrontFeatures, ListOfficeName, ListAgentDirectPhone,
    // ListAgentEmail all 400'd here before -- see the file comment above).
    // Reading it here unconditionally is harmless either way: item.
    // ListOfficeMlsId is simply undefined on every call that didn't select
    // it, so this is just null for those.
    officeMlsId: item.ListOfficeMlsId || null,
    agentName: item.ListAgentFullName || null,
    coAgentName: item.CoListAgentFullName || null,
    agentPhone: item.ListAgentDirectPhone || null,
    agentEmail: item.ListAgentEmail || null,
    photo,
    photos,
    modificationTimestamp: item.ModificationTimestamp || null,
    mlgCanView: item.MlgCanView !== false,
    // 2026-08-14 (market-scoping): inferred from City only -- see the
    // OPERATING_COUNTIES comment above for why CountyOrParish itself isn't
    // trusted/selected. Null when City isn't in the lookup table yet, which
    // deliberately means "don't filter this one out" wherever this is used.
    county: inferCountyFromCity((item.City || "").toLowerCase().trim()),
  };
}

// Client-side (well, server-side-over-cached-data) equivalent of the old
// OData $filter builder — same filtering logic, same param names/meaning,
// just applied in JS over the replicated array instead of sent to MLS Grid.
function matchesQuery(listing, params) {
  const mine = params.mine === "true";
  const statuses = mine ? MINE_STATUSES : PUBLIC_STATUSES;
  if (!statuses.includes(listing.status)) return false;

  if (mine) {
    const surname = AGENT_SURNAME;
    const agent = (listing.agentName || "").toLowerCase();
    const coAgent = (listing.coAgentName || "").toLowerCase();
    if (!agent.includes(surname) && !coAgent.includes(surname)) return false;
  } else if (params.noFloor !== "true") {
    if (!(listing.price >= LUXURY_PRICE_FLOOR)) return false;
  }

  if (params.city) {
    if ((listing.city || "").toLowerCase() !== String(params.city).toLowerCase()) return false;
  }
  if (params.cities) {
    const cityList = String(params.cities).split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
    if (cityList.length && !cityList.includes((listing.city || "").toLowerCase())) return false;
  }

  const minPrice = parseInt(params.minPrice, 10);
  if (Number.isFinite(minPrice) && minPrice > 0) {
    if (!(listing.price >= minPrice)) return false;
  }
  const maxPrice = parseInt(params.maxPrice, 10);
  if (Number.isFinite(maxPrice) && maxPrice > 0) {
    if (!(listing.price <= maxPrice)) return false;
  }
  const beds = parseInt(params.beds, 10);
  if (Number.isFinite(beds) && beds > 0) {
    if (!(listing.beds >= beds)) return false;
  }
  const baths = parseInt(params.baths, 10);
  if (Number.isFinite(baths) && baths > 0) {
    if (!(listing.baths >= baths)) return false;
  }

  if (params.subdivision) {
    const needle = String(params.subdivision).toLowerCase();
    if (!(listing.subdivision || "").toLowerCase().includes(needle)) return false;
  }

  if (params.waterfront === "true") {
    const remarksLower = (listing.remarks || "").toLowerCase();
    const remarksHit = remarksLower.includes("riverfront") ||
      remarksLower.includes("river frontage") || remarksLower.includes("waterfront");
    if (!(listing.waterfront || remarksHit)) return false;
  }

  return true;
}

module.exports = {
  getBlobStore,
  BASE_URL,
  SELECT_FIELDS,
  REPLICATED_STATUSES,
  MINE_STATUSES,
  PUBLIC_STATUSES,
  AGENT_SURNAME,
  LUXURY_PRICE_FLOOR,
  BLOB_STORE_NAME,
  LISTINGS_KEY,
  SYNC_STATE_KEY,
  MINE_LISTINGS_KEY,
  CO_CITY_COUNTY,
  OPERATING_COUNTIES,
  inferCountyFromCity,
  mapListing,
  matchesQuery,
};
