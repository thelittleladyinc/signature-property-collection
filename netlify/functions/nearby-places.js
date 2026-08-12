// Powers the "Nearby & Distances" panel on every listing card (see
// nearbyToggleHtml() / _nearby_places_js_helpers() in build.py) — real
// distance from a specific listing to the nearest grocery stores, schools,
// and parks. Added 2026-08-12 per Christine's request, expanding on the
// earlier walking-distance-to-restaurants idea into three categories with
// a simple button-driven UI (not free-text chat -- confirmed as the right
// scope for v1).
//
// Setup required (one-time, Netlify dashboard -> Site settings ->
// Environment variables): GOOGLE_MAPS_API_KEY, from a Google Cloud project
// with the Geocoding API and Places API enabled, restricted to those two
// APIs (and ideally to this site's domain) so a leaked key can't be abused
// elsewhere. Christine has to create this herself -- Google requires a
// billing-enabled Cloud project even though usage this small stays inside
// the free tier. If the key isn't set yet, this no-ops with
// {"error":"not_configured"}, same pattern as every other optional
// integration on this site (MLSGRID_API_TOKEN, LOFTY_API_KEY, etc.).
//
// Design notes:
// - Straight-line ("as the crow flies") distance, computed ourselves via
//   the haversine formula from the geocoded origin to each place's
//   lat/lng -- not real walking/driving distance from Google's Distance
//   Matrix API. This keeps the integration to two Google APIs instead of
//   three and meaningfully cheaper, at the cost of slight
//   under/over-statement versus an actual route. Good enough for "is the
//   grocery store 1 mile away or 8" -- if Christine wants true route
//   distance later, Distance Matrix is a straightforward addition here.
// - Results are cached in Netlify Blobs, keyed by the normalized address,
//   for 30 days. Grocery stores/schools/parks don't relocate often, and
//   this means the same listing being viewed by 50 different buyers costs
//   Google API quota exactly once, not 50 times.
const { getStore } = require("@netlify/blobs");
const { getBlobStore } = require("./_mls-shared");

const NEARBY_STORE_NAME = "nearby-places-cache";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Google Places "type" values for each category button in the UI.
const CATEGORY_TYPES = {
  grocery: "grocery_or_supermarket",
  school: "school",
  park: "park",
};
const RESULTS_PER_CATEGORY = 3;
const SEARCH_RADIUS_METERS = 8000; // ~5 miles, generous for rural Weld/Larimer parcels

function normalizeAddressKey(address) {
  return address.trim().toLowerCase().replace(/\s+/g, " ");
}

// Haversine formula -- straight-line distance between two lat/lng points,
// in miles.
function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // Earth's radius in miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
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
  return { lat: loc.lat, lng: loc.lng };
}

async function nearbySearch(origin, placeType, apiKey) {
  // rankby=distance requires type/keyword/name and forbids radius -- this
  // returns Google's own nearest-first ordering, which we then re-derive
  // exact mileage for via haversine (Places doesn't return a distance
  // value directly).
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?` +
    `location=${origin.lat},${origin.lng}&rankby=distance&type=${placeType}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Places API HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "OK" && json.status !== "ZERO_RESULTS") {
    throw new Error(`Places API status ${json.status}: ${json.error_message || "unknown error"}`);
  }
  const results = json.results || [];
  return results.slice(0, RESULTS_PER_CATEGORY).map((r) => ({
    name: r.name,
    distanceMiles: Number(
      distanceMiles(origin.lat, origin.lng, r.geometry.location.lat, r.geometry.location.lng).toFixed(2)
    ),
  }));
}

exports.handler = async (event) => {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "not_configured" }),
      };
    }

    const address = (event.queryStringParameters || {}).address;
    if (!address || !address.trim()) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "missing_address" }),
      };
    }

    const cacheKey = normalizeAddressKey(address);
    const store = getBlobStore(getStore, NEARBY_STORE_NAME);

    const cached = await store.get(cacheKey, { type: "json" }).catch(() => null);
    if (cached && cached.cachedAt && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: cached.origin, categories: cached.categories, cached: true }),
      };
    }

    const origin = await geocodeAddress(address, apiKey);
    const categoryEntries = await Promise.all(
      Object.entries(CATEGORY_TYPES).map(async ([key, placeType]) => {
        const results = await nearbySearch(origin, placeType, apiKey);
        return [key, results];
      })
    );
    const categories = Object.fromEntries(categoryEntries);

    await store.setJSON(cacheKey, { origin, categories, cachedAt: Date.now() });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin, categories, cached: false }),
    };
  } catch (err) {
    console.error("nearby-places function error:", err);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "exception",
        message: err && err.message,
        categories: {},
      }),
    };
  }
};
