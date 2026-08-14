// Powers the "Sold Homes Map" (see build_sold_homes_map() in build.py) --
// Christine's request 2026-08-13: map her sold listings with their video
// tours plotted by real address, "using google api". This geocodes the
// fixed list of sold-home addresses (SOLD_HOME_LOCATIONS in build.py,
// mirrored below) server-side via Google's Geocoding API, so the actual
// map key (used client-side by Leaflet, not Google Maps JS) never touches
// the browser -- same "secret key stays server-side" pattern as
// nearby-places.js.
//
// Setup required (one-time, Netlify dashboard -> Site settings ->
// Environment variables): GOOGLE_MAPS_API_KEY -- Christine confirmed
// 2026-08-13 she already has one. Same key nearby-places.js already uses
// (needs the Geocoding API enabled on it, which nearby-places.js also
// requires, so if that feature already works this one will too with no
// extra setup). If the key isn't set, this no-ops with
// {"error":"not_configured"}, same pattern as every other optional
// integration on this site.
//
// Unlike nearby-places.js's 30-day cache (grocery stores can open/close),
// a street address's lat/lng never changes, so this caches each result
// forever -- once geocoded, a sold address never re-spends Google API
// quota again, even years later.
//
// The address list itself is small (12 as of this writing) and changes
// rarely (only when Christine films a new listing tour for a property that
// later sells -- see _LISTING_VIDEO_ENTRIES / SOLD_HOME_VIDEOS in
// build.py). Keeping it here too (rather than fetching it from build.py,
// which isn't reachable at runtime) means this file needs a manual update
// any time that list grows -- flagged clearly so it isn't missed.
const { getStore } = require("@netlify/blobs");
const { getBlobStore } = require("./lib/_mls-shared");

const GEOCODE_STORE_NAME = "sold-homes-geocode-cache";

// Keep this in sync with SOLD_HOME_LOCATIONS in build.py -- same 12
// sold-status entries from _LISTING_VIDEO_ENTRIES, with a city added (taken
// directly from each video's own title, e.g. "45615 County Rd 27, Pierce
// CO") so the Geocoding API has enough to resolve an exact match instead of
// guessing among same-named streets in other towns.
const SOLD_HOME_LOCATIONS = [
  { address: "32 Victoria Dr, Johnstown, CO", videoId: "9aIGz-SvCtI", title: "Affordable Luxury at 32 Victoria Dr — Johnstown Home Tour" },
  { address: "929 W Independent Ave, LaSalle, CO", videoId: "TpjE36J71zc", title: "Tour 929 W Independent Ave — Modern 4-Bed Home in LaSalle, Colorado" },
  { address: "294 Gila Trail, Ault, CO", videoId: "JvtRGf01JXU", title: "Why Everyone's Talking About This Ault, Colorado Home | 294 Gila Trail" },
  { address: "39243 Boulevard E, Eaton, CO", videoId: "L-uEVzq1bv4", title: "Eaton, CO Home Under $400K — 39243 Boulevard E" },
  { address: "1110 S Quitman St, Denver, CO", videoId: "e7kMY1yV7GI", title: "Denver Home Tour — Charming Mid-Century Ranch at 1110 S Quitman St" },
  { address: "45615 County Rd 27, Pierce, CO", videoId: "dVonJhu_zCo", title: "Dream Ranch on 20 Acres — 45615 County Rd 27, Pierce CO" },
  { address: "504 Graefe Ave, Ault, CO", videoId: "eiFurERq_As", title: "Charming Home for Sale at 504 Graefe Ave, Ault CO" },
  { address: "1316 Cimarron Cir, Eaton, CO", videoId: "xWcrj6foJ-Q", title: "Aspen Meadows Ranch Home in Eaton, CO — 1316 Cimarron Cir" },
  { address: "4986 Stuart St, Denver, CO", videoId: "oNZBc-MxzUg", title: "Stunning Home for Sale — 4986 Stuart St, Denver (Tennyson Art District)" },
  { address: "5705 Snow Mesa Dr, Loveland, CO", videoId: "MDfyzESb1Yk", title: "Why Is Loveland, CO Called the \"Sweetheart City\"? — 5705 Snow Mesa Dr" },
  { address: "475 Homestead Ln, Johnstown, CO", videoId: "6Hrdv6LZIDM", title: "Tour This Stunning Johnstown Home — 475 Homestead Ln (Johnstown Farms)" },
  { address: "913 Green Mountain Dr, Erie, CO", videoId: "e-_3Qs3liQ0", title: "Inside a $1.35M Luxury Home in Small-Town Colorado — 913 Green Mountain Dr, Erie" },
];

function normalizeAddressKey(address) {
  return address.trim().toLowerCase().replace(/\s+/g, " ");
}

async function geocodeAddress(address, apiKey) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding API HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "OK" || !json.results || !json.results.length) {
    throw new Error(`Geocoding API status ${json.status}: ${json.error_message || "no results"}`);
  }
  const loc = json.results[0].geometry.location;
  const formatted = json.results[0].formatted_address;
  return { lat: loc.lat, lng: loc.lng, formatted };
}

exports.handler = async (event) => {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "not_configured", pins: [] }),
      };
    }

    const store = getBlobStore(getStore, GEOCODE_STORE_NAME);

    const pins = await Promise.all(
      SOLD_HOME_LOCATIONS.map(async (loc) => {
        const cacheKey = normalizeAddressKey(loc.address);
        let geo = await store.get(cacheKey, { type: "json" }).catch(() => null);
        if (!geo) {
          try {
            geo = await geocodeAddress(loc.address, apiKey);
            await store.setJSON(cacheKey, geo);
          } catch (err) {
            console.error(`sold-homes-geocode: failed for "${loc.address}":`, err.message);
            return null;
          }
        }
        return {
          address: loc.address,
          lat: geo.lat,
          lng: geo.lng,
          videoId: loc.videoId,
          title: loc.title,
        };
      })
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // Pins essentially never change (a sold address's location is
        // permanent, and this list only grows a couple times a year) --
        // safe to cache aggressively at the CDN edge.
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      },
      body: JSON.stringify({ pins: pins.filter(Boolean), totalCount: SOLD_HOME_LOCATIONS.length }),
    };
  } catch (err) {
    console.error("sold-homes-geocode function error:", err);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "exception", message: err && err.message, pins: [] }),
    };
  }
};
