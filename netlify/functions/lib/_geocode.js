// Shared geocoder: Mapbox permanent first, Google as fallback.
//
// 2026-08-20, the licensing cleanup from the portal audit (mapbox/README.md):
// Google's Maps terms bar displaying Geocoding results on non-Google maps,
// and this site now renders its pins on Mapbox GL. Mapbox's PERMANENT
// geocoding tier (~$5/1k, requires billing enabled on the Mapbox account)
// both fixes that and allows indefinite coordinate storage.
//
// Behavior: try Mapbox permanent; on ANY failure (billing not enabled yet ->
// 401/403/422, network, no match) fall back to the Google geocoder exactly as
// before, logged loudly so /status watchers can see which path served. The
// moment Christine enables billing on the Mapbox account, every new geocode
// silently switches to the compliant path with no deploy.
//
// Cache TTLs in the callers stay at 30 days for now: cached entries don't
// record which service produced them, and Google-sourced coordinates must
// still expire per Google's terms. Once the caches have cycled entirely onto
// Mapbox (30 days after billing is enabled), the TTLs can become permanent.
const GEOCODE_TIMEOUT_MS = 4000;

async function mapboxGeocode(address, token) {
  const url = "https://api.mapbox.com/search/geocode/v6/forward?q=" +
    encodeURIComponent(address) +
    "&permanent=true&limit=1&country=US&proximity=-104.9,40.4&access_token=" +
    encodeURIComponent(token);
  const res = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Mapbox geocode HTTP ${res.status}`);
  const json = await res.json();
  const f = json.features && json.features[0];
  if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) {
    throw new Error("Mapbox geocode: no match");
  }
  return {
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    formatted: (f.properties && f.properties.full_address) || address,
  };
}

async function googleGeocode(address, apiKey) {
  const url = "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(address) + "&key=" + apiKey;
  const res = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Geocoding API HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "OK" || !json.results || !json.results.length) {
    throw new Error(`Geocoding API status ${json.status}: ${json.error_message || "no results"}`);
  }
  const loc = json.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, formatted: json.results[0].formatted_address };
}

// Same signature the three callers already use; googleKey may be undefined.
async function geocodeAddress(address, googleKey) {
  const mapboxToken = process.env.MAPBOX_PUBLIC_TOKEN;
  if (mapboxToken) {
    try {
      return await mapboxGeocode(address, mapboxToken);
    } catch (err) {
      console.warn(`_geocode: Mapbox permanent path failed (${err && err.message}) — ` +
        "falling back to Google. If this says HTTP 401/403/422, permanent " +
        "geocoding isn't enabled on the Mapbox account yet (needs billing).");
    }
  }
  const key = googleKey || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("no geocoder available: neither Mapbox permanent nor GOOGLE_MAPS_API_KEY");
  return googleGeocode(address, key);
}

module.exports = { geocodeAddress };
