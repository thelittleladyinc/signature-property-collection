// Powers the "How Walkable Is <town>?" panel on every city and subdivision
// page (see _walkability_block() in build.py).
//
// 2026-08-15 (Christine's request): "a much more detailed walkability score
// -- maybe add more than school, park and grocery store?" The site already
// had a nearby-places.js panel on listing cards covering exactly three
// categories (grocery, school, park). This is the community-page version and
// it looks at ten, weights them, and turns them into a single number plus
// the actual named places behind it.
//
// WHAT THIS IS NOT: this is not Walk Score(R), which is a registered
// trademark and a licensed product of Redfin. Nothing here is derived from
// their data or methodology and the UI never uses their name -- it presents
// this as Christine's own estimate, with the method stated plainly on the
// page. If she ever wants the official score instead, that needs a paid
// Walk Score API subscription plus their required attribution and link-back,
// and would replace this file rather than extend it.
//
// Setup: GOOGLE_MAPS_API_KEY, same key nearby-places.js and
// sold-homes-geocode.js already use (Geocoding API + Places API enabled).
// No key set = {"error":"not_configured"} and the panel hides itself, same
// pattern as every other optional integration here.
//
// Cost: ten Places calls per town, cached 30 days. With 27 city pages and 10
// subdivision pages that is at most ~370 calls a month no matter how much
// traffic the pages get, because the cache is keyed by town rather than by
// visitor.
//
// 30 days is a CEILING set by Google, not a number picked for cost. The Maps
// Platform Service Specific Terms allow lat/lng from the Geocoding API to be
// cached for up to 30 consecutive calendar days and require deletion after
// that; place IDs are the one field exempt from the caching restrictions and
// may be stored indefinitely. Nothing here may cache longer than that, and
// the TTL is checked on read so an entry can never be served stale past it.
const { getStore } = require("@netlify/blobs");
const { getBlobStore } = require("./lib/_mls-shared");

const WALK_STORE_NAME = "walkability-cache";
// 30 days, matching nearby-places.js and (since 2026-08-15) sold-homes-geocode.js.
// This is Google's ceiling, not a tuning choice -- see the note above.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const PLACES_TIMEOUT_MS = 4000;
const PLACES_CONCURRENCY = 5;

// Subdivision pages pass a `near` (their parent town) alongside the place, and
// the geocoded place has to land within this many miles of it or the lookup is
// treated as failed. Neighborhood names are not unique -- "Pyrenees, Loveland,
// CO" is one bad geocode away from a mountain range in France -- and a
// confident, plausible-looking score for the wrong place is far worse on a
// neighborhood page than no score at all. City pages send no `near`; the city
// IS the place, so there is nothing to check it against.
const MAX_PLACE_DRIFT_MILES = 12;

// The ten categories, their Google Places type, the label shown on the page,
// and their weight in the score. Weights sum to 100 and encode how much each
// one actually matters for daily life on foot: being able to buy food and
// eat out counts for more than being near a library.
//
// `examples` is how many named places to return per category for the "what's
// actually near here" list under the score.
const CATEGORIES = [
  { key: "grocery",    type: "grocery_or_supermarket", label: "Grocery",     weight: 15 },
  { key: "restaurant", type: "restaurant",             label: "Restaurants", weight: 12 },
  { key: "school",     type: "school",                 label: "Schools",     weight: 12 },
  { key: "cafe",       type: "cafe",                   label: "Coffee",      weight: 10 },
  { key: "park",       type: "park",                   label: "Parks",       weight: 10 },
  { key: "pharmacy",   type: "pharmacy",               label: "Pharmacy",    weight: 10 },
  { key: "transit",    type: "transit_station",        label: "Transit",     weight: 10 },
  { key: "gym",        type: "gym",                    label: "Gyms",        weight: 7 },
  { key: "library",    type: "library",                label: "Library",     weight: 7 },
  { key: "doctor",     type: "doctor",                 label: "Doctors",     weight: 7 },
];
const EXAMPLES_PER_CATEGORY = 3;

// Derived, not hardcoded to 100: `coverage` below is "what share of the
// scoreable weight actually answered", and that stays correct if the weights
// above are ever retuned and no longer happen to sum to 100.
const TOTAL_WEIGHT = CATEGORIES.reduce((sum, c) => sum + c.weight, 0);

// Distance decay, in miles, applied to the NEAREST place in each category.
// Full credit inside a short walk, tapering to nothing by the point where
// nobody is walking it. Deliberately linear and stated on the page rather
// than a tuned curve nobody can explain to a client.
const FULL_CREDIT_MILES = 0.25;
const NO_CREDIT_MILES = 1.5;

function normalizeKey(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// Haversine -- straight-line miles. Same approach and same caveat as
// nearby-places.js: this is "as the crow flies", not a routed walking
// distance, which would need the Distance Matrix API as a third billed
// product. The page says so rather than implying a routed number.
function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function creditFor(miles) {
  if (miles == null) return 0;
  if (miles <= FULL_CREDIT_MILES) return 1;
  if (miles >= NO_CREDIT_MILES) return 0;
  return (NO_CREDIT_MILES - miles) / (NO_CREDIT_MILES - FULL_CREDIT_MILES);
}

// Plain-English band, so the number is never the only thing on the page. A
// buyer reads "most errands need a car" faster than they read "38".
function bandFor(score) {
  if (score >= 80) return "Most errands on foot";
  if (score >= 60) return "Many errands on foot";
  if (score >= 40) return "Some errands on foot";
  if (score >= 20) return "A car for most errands";
  return "A car for nearly everything";
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function geocodePlace(place, apiKey) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(place)}&key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(PLACES_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Geocoding API HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "OK" || !json.results || !json.results.length) {
    throw new Error(`Geocoding API status ${json.status}: ${json.error_message || "no results"}`);
  }
  const loc = json.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, formatted: json.results[0].formatted_address };
}

async function nearestInCategory(origin, cat, apiKey) {
  // rankby=distance gives Google's nearest-first ordering and forbids a
  // radius, so nothing is silently cut off in a rural town where the closest
  // pharmacy is genuinely 6 miles away -- it comes back, scores zero, and the
  // page can still say how far it is. Same call shape as nearby-places.js.
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?` +
    `location=${origin.lat},${origin.lng}&rankby=distance&type=${cat.type}&key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(PLACES_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Places API HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "OK" && json.status !== "ZERO_RESULTS") {
    throw new Error(`Places API status ${json.status}: ${json.error_message || "unknown"}`);
  }
  const places = (json.results || [])
    .filter((r) => r.geometry && r.geometry.location)
    .map((r) => ({
      name: r.name,
      // Carried so the page can link the amenity straight to Google Maps --
      // both a genuine convenience (it's what Zillow and Redfin do with
      // nearby amenities) and the clearest way to satisfy Google's
      // attribution requirement for Places content shown outside a map.
      placeId: r.place_id || null,
      miles: Number(
        distanceMiles(origin.lat, origin.lng, r.geometry.location.lat, r.geometry.location.lng)
          .toFixed(2)
      ),
    }))
    .sort((a, b) => a.miles - b.miles);

  return {
    key: cat.key,
    label: cat.label,
    weight: cat.weight,
    nearestMiles: places.length ? places[0].miles : null,
    examples: places.slice(0, EXAMPLES_PER_CATEGORY),
  };
}

async function computeWalkability(place, near, apiKey) {
  const origin = await geocodePlace(place, apiKey);

  if (near) {
    const anchor = await geocodePlace(near, apiKey);
    const drift = distanceMiles(origin.lat, origin.lng, anchor.lat, anchor.lng);
    if (drift > MAX_PLACE_DRIFT_MILES) {
      throw new Error(
        `"${place}" geocoded ${drift.toFixed(1)} mi from "${near}" -- refusing to score ` +
        `what is probably the wrong place`
      );
    }
  }

  const cats = await mapWithConcurrency(CATEGORIES, PLACES_CONCURRENCY, (cat) =>
    nearestInCategory(origin, cat, apiKey).catch((err) => {
      console.error(`walkability: ${cat.key} failed for "${place}":`, err.message);
      return null;
    })
  );
  const categories = cats.filter(Boolean);

  // Score over the categories that actually answered, so one failed Places
  // call drags the score down by its weight instead of silently rescaling
  // the whole thing... except when several fail, where rescaling is the
  // honest choice. availableWeight makes that explicit: the score is always
  // "out of the weight we could actually check", and coverage is reported so
  // the page can stay quiet if the data is too thin to mean anything.
  const availableWeight = categories.reduce((sum, c) => sum + c.weight, 0);
  const earned = categories.reduce((sum, c) => sum + c.weight * creditFor(c.nearestMiles), 0);
  const score = availableWeight ? Math.round((earned / availableWeight) * 100) : null;

  return {
    place,
    near: near || null,
    origin,
    score,
    band: score == null ? null : bandFor(score),
    categories,
    coverage: TOTAL_WEIGHT ? Math.round((availableWeight / TOTAL_WEIGHT) * 100) : 0,
    checkedAt: new Date().toISOString(),
    method: {
      fullCreditMiles: FULL_CREDIT_MILES,
      noCreditMiles: NO_CREDIT_MILES,
      categoryCount: CATEGORIES.length,
    },
  };
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

    const params = event.queryStringParameters || {};
    const place = (params.place || "").trim();
    const near = (params.near || "").trim();
    if (!place) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "missing_place" }),
      };
    }

    const store = getBlobStore(getStore, WALK_STORE_NAME);
    // `near` is part of the key: it changes whether a result is accepted at
    // all, so a cached entry from a call without it must not satisfy one with.
    const cacheKey = normalizeKey(near ? `${place} | near ${near}` : place);

    const cached = await store.get(cacheKey, { type: "json" }).catch(() => null);
    if (cached && cached.cachedAt && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        },
        // checkedAt deliberately survives -- it is when the data was actually
        // fetched from Google, which is what the page reports to the reader.
        body: JSON.stringify({ ...cached, cachedAt: undefined, cached: true }),
      };
    }

    const result = await computeWalkability(place, near, apiKey);
    await store.setJSON(cacheKey, { ...result, cachedAt: Date.now() });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      },
      body: JSON.stringify({ ...result, cached: false }),
    };
  } catch (err) {
    console.error("walkability function error:", err);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "exception", message: err && err.message }),
    };
  }
};
