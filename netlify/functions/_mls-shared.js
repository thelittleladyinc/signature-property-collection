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

const SELECT_FIELDS = [
  "ListingId", "ListingKey", "StandardStatus", "ListPrice",
  "BedroomsTotal", "BathroomsTotalInteger", "LivingArea",
  "StreetNumber", "StreetName", "StreetSuffix", "City", "StateOrProvince", "PostalCode",
  "PublicRemarks", "PropertyType", "PropertySubType", "SubdivisionName",
  "WaterfrontYN", "WaterfrontFeatures",
  "ListOfficeName", "ListAgentFullName", "ListAgentDirectPhone", "ListAgentEmail",
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

const BLOB_STORE_NAME = "mls-listings";
const LISTINGS_KEY = "listings.json";
const SYNC_STATE_KEY = "sync-state.json";

function mapListing(item) {
  const address = [item.StreetNumber, item.StreetName, item.StreetSuffix]
    .filter(Boolean).join(" ");
  const media = Array.isArray(item.Media) ? item.Media : [];
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
    waterfront: item.WaterfrontYN === true || (Array.isArray(item.WaterfrontFeatures) &&
      item.WaterfrontFeatures.some((f) => f && f !== "None")) || null,
    officeName: item.ListOfficeName || null,
    agentName: item.ListAgentFullName || null,
    coAgentName: item.CoListAgentFullName || null,
    agentPhone: item.ListAgentDirectPhone || null,
    agentEmail: item.ListAgentEmail || null,
    photo,
    photos,
    modificationTimestamp: item.ModificationTimestamp || null,
    mlgCanView: item.MlgCanView !== false,
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
  mapListing,
  matchesQuery,
};
