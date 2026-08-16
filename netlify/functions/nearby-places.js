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
//   lat/lng. Kept as the floor that is always present, because it needs no
//   third Google API and therefore cannot fail.
// - 2026-08-16 (Christine: "maybe do a miles minutes to the closest
//   restaurant and gas station"): real DRIVING miles and minutes now come
//   from the Distance Matrix API on top of that, for the nearest result in
//   each category. This is the number people actually asked for -- out here
//   straight-line distance and drive time come apart badly, because a place
//   two miles away across a section of dryland wheat is an eight-mile drive
//   around it. Nunn is the case that makes it matter.
//   Distance Matrix has to be enabled on her Google Cloud key. If it is
//   not, the call returns REQUEST_DENIED, that is logged loudly, and the
//   response still carries straight-line miles -- fewer numbers, never
//   wrong ones.
// - Results are cached in Netlify Blobs, keyed by the normalized address,
//   for 30 days. Grocery stores/schools/parks don't relocate often, and
//   this means the same listing being viewed by 50 different buyers costs
//   Google API quota exactly once, not 50 times.
const { getStore } = require("@netlify/blobs");
const { getBlobStore } = require("./lib/_mls-shared");

const NEARBY_STORE_NAME = "nearby-places-cache";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Google Places "type" values for each category button in the UI.
// 2026-08-15 (Christine: "walking distance to a coffee shop or how far from a
// grocery store?"). Coffee and dining added here rather than as search filters:
// each category is one Places call per address, so it's affordable exactly
// because this panel is opened on demand for one listing at a time and cached
// for 30 days. Filtering all 15,000+ stored listings this way is not
// affordable, which is why matchesQuery() has no distance filter -- see the
// note there.
//
// 2026-08-16: gas added. On an acreage listing outside Nunn or Carr it is a more
// pressing question than the coffee shop, and it was the one category a rural buyer
// asks about that this panel could not answer.
const CATEGORY_TYPES = {
  grocery: "grocery_or_supermarket",
  coffee: "cafe",
  dining: "restaurant",
  gas: "gas_station",
  school: "school",
  park: "park",
};
const RESULTS_PER_CATEGORY = 3;
const SEARCH_RADIUS_METERS = 8000; // ~5 miles, generous for rural Weld/Larimer parcels

// Bumped whenever the shape of a cached entry changes, so a 30-day-old entry from
// before that change is treated as a miss instead of being served forever with
// fields the caller now expects. Without this, adding `gas` and driving times would
// have taken a month to appear on any address already in the cache.
// 3 (2026-08-16, hours after 2): Christine enabled the Distance Matrix API on her Google
// Cloud key. Any address looked up in the window before that was cached WITHOUT
// drivingMinutes -- a valid version-2 entry that would have served miles-only for the
// next 30 days, on exactly the pages the drive times were built for. The shape is
// unchanged, so nothing but the version number can invalidate those. Bumping it costs one
// re-fetch per address and is the whole reason this field exists.
const CACHE_SHAPE_VERSION = 3;

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
    // Kept so Distance Matrix can be asked for a route to this exact place rather
    // than to a name Google would have to re-resolve.
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    // 2026-08-15: added alongside the walkability panel. place_id is the one
    // Places field Google exempts from its caching restrictions, and linking
    // each result through it to Google Maps is how the attribution
    // requirement for Places content shown outside a map is properly met --
    // this panel had been displaying Google place names with no attribution
    // at all since launch.
    placeId: r.place_id || null,
    distanceMiles: Number(
      distanceMiles(origin.lat, origin.lng, r.geometry.location.lat, r.geometry.location.lng).toFixed(2)
    ),
  }));
}

// Real driving distance and time from the origin to each place, in ONE Distance
// Matrix call for all of them (it takes up to 25 destinations per request, and we
// send at most one per category).
//
// Mutates the place objects in place, adding drivingMiles/drivingMinutes only where
// Google actually returned a route. Anything it cannot answer is simply left with
// its straight-line mileage: the caller's contract is "distanceMiles is always
// there, driving figures are a bonus", so a disabled API, a rate limit or an
// unroutable destination degrades the panel instead of breaking it.
async function addDrivingTimes(origin, places, apiKey) {
  if (!places.length) return { ok: true, skipped: true };
  const dests = places.map((p) => `${p.lat},${p.lng}`).join("|");
  const url = "https://maps.googleapis.com/maps/api/distancematrix/json?" +
    `origins=${origin.lat},${origin.lng}&destinations=${encodeURIComponent(dests)}` +
    `&mode=driving&units=imperial&key=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Distance Matrix HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== "OK") {
      // Named loudly and specifically: REQUEST_DENIED here almost always means the
      // Distance Matrix API is not enabled on the key, which is a one-click fix in
      // the Google Cloud console and is otherwise completely invisible -- the panel
      // just quietly never shows a drive time.
      throw new Error(`Distance Matrix status ${json.status}: ${json.error_message || ""}`);
    }
    const elements = (json.rows && json.rows[0] && json.rows[0].elements) || [];
    elements.forEach((el, i) => {
      if (!el || el.status !== "OK" || !places[i]) return;
      if (el.duration && typeof el.duration.value === "number") {
        places[i].drivingMinutes = Math.max(1, Math.round(el.duration.value / 60));
      }
      if (el.distance && typeof el.distance.value === "number") {
        places[i].drivingMiles = Number((el.distance.value / 1609.344).toFixed(1));
      }
    });
    return { ok: true };
  } catch (err) {
    console.error(`nearby-places: no driving times (${err && err.message}) — ` +
      "straight-line miles only. If this says REQUEST_DENIED, enable the " +
      "Distance Matrix API on GOOGLE_MAPS_API_KEY in Google Cloud.");
    return { ok: false, reason: err && err.message };
  }
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

    // 2026-08-16: `only` lets a caller ask for a subset. The town pages want the
    // nearest restaurant and gas station and nothing else, and there are 35 of them
    // -- asking for all six categories on each would have been six Places calls per
    // town for four answers nobody on that page requested.
    const only = ((event.queryStringParameters || {}).only || "")
      .split(",").map((s) => s.trim()).filter((s) => s in CATEGORY_TYPES);
    const wanted = only.length ? only : Object.keys(CATEGORY_TYPES);

    const cacheKey = normalizeAddressKey(address);
    const store = getBlobStore(getStore, NEARBY_STORE_NAME);

    const cached = await store.get(cacheKey, { type: "json" }).catch(() => null);
    const usable = cached && cached.v === CACHE_SHAPE_VERSION;
    const now = Date.now();
    // Cached by category rather than all-or-nothing. The listing panel asks for six
    // and the town panel for two against the SAME address key, so an all-or-nothing
    // cache would have had each of them re-fetching everything the other stored.
    //
    // Each category carries its OWN timestamp. Sharing one would mean a partial
    // refetch renewed the whole entry, and a restaurant that closed two years ago
    // would still be named as the nearest one -- an entry topped up every few weeks
    // by some other category would never expire at all.
    const at = (usable && cached.at) || {};
    const have = {};
    if (usable && cached.categories) {
      for (const [k, v] of Object.entries(cached.categories)) {
        if (at[k] && now - at[k] < CACHE_TTL_MS) have[k] = v;
      }
    }
    const missing = wanted.filter((k) => !have[k]);

    if (!missing.length) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: cached.origin,
          categories: Object.fromEntries(wanted.map((k) => [k, have[k]])),
          cached: true,
        }),
      };
    }

    const origin = (usable && cached.origin) || await geocodeAddress(address, apiKey);
    const fetched = Object.fromEntries(await Promise.all(
      missing.map(async (key) => [key, await nearbySearch(origin, CATEGORY_TYPES[key], apiKey)])
    ));

    // One Distance Matrix call covering the nearest result of each category just
    // fetched -- the only ones a caller shows a drive time against.
    await addDrivingTimes(origin, Object.values(fetched).map((v) => v[0]).filter(Boolean), apiKey);

    // Written back whole, including any still-valid category this request did not
    // ask for, so the next caller for this address finds everything either request
    // has already paid Google for.
    const categories = { ...(usable ? cached.categories : {}), ...fetched };
    const stamps = { ...at };
    for (const k of missing) stamps[k] = now;
    await store.setJSON(cacheKey, {
      origin, categories, at: stamps, cachedAt: now, v: CACHE_SHAPE_VERSION,
    }).catch(() => {});

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin,
        categories: Object.fromEntries(wanted.map((k) => [k, categories[k] || []])),
        cached: false,
      }),
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
