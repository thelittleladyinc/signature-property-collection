// The local-spots layer for the county map: Christine's own videos, pinned to
// the real places they were filmed at.
//
// 2026-08-15 (Christine: "make the map way more detailed for how people would
// find me - based on local spots? I have restaurant videos some wide thousands
// of views on my google reviews of other places").
//
// The map already had a POI layer. It had two pins on it, both golf courses, and
// both playing the CITY OF LOVELAND's promotional videos. That is backwards. The
// reason a buyer should use this map instead of Zillow's is that the person who
// drew it has actually eaten, hiked and ridden in these places and has the
// footage -- her El Pueblito video alone has more views than most of her listing
// tours. So the pins are hers now.
//
// Why this is a function rather than baked into the built page: the pins need
// coordinates, and coordinates come from geocoding an address. Doing that at
// build time would mean either committing coordinates I cannot verify (Google's
// APIs are not reachable from the build environment, so I would be typing in
// numbers from memory -- and a pin 300 metres off puts her recommendation on
// someone else's building), or re-geocoding on every single deploy. Doing it
// here means it happens once per address, ever, and the answer is cached in
// Blobs where it survives deploys.
//
// Deliberately the same shape as sold-homes-geocode.js, which already solved
// this exact problem for her sold-listing pins: same 30-day cache TTL (Google's
// own ceiling for storing Geocoding results, not a tuning knob), same bounded
// concurrency, same time budget sized for Netlify's 10s function timeout.
//
// A spot that cannot be geocoded is simply left out of the response, and the
// reason is logged. Fewer pins is a bad day; a pin in the wrong place is a
// business problem.
const { getStore } = require("@netlify/blobs");
const { getBlobStore } = require("./lib/_mls-shared");
const LOCAL_SPOTS_DATA = require("./lib/_local-spots.json");

const GEOCODE_STORE_NAME = "local-spots-geocode-cache";

// Google's Geocoding terms cap how long a resolved coordinate may be stored.
// Same value and same reason as sold-homes-geocode.js -- read that file's note
// before changing it.
const GEOCODE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const GEOCODE_CONCURRENCY = 5;
const GEOCODE_TIMEOUT_MS = 4000;
const GEOCODE_TIME_BUDGET_MS = 5000;

// The pins change only when build/data/local_spots.json does, so the browser and
// the CDN may hold this for a good while. An hour at the edge with a day of
// stale-while-revalidate keeps this function close to zero invocations.
const RESPONSE_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";

const SPOTS = Array.isArray(LOCAL_SPOTS_DATA.spots) ? LOCAL_SPOTS_DATA.spots : [];

// The string handed to the Geocoding API. The city and state matter: "1st St"
// exists in most towns in Weld County, and without them the API picks one.
function fullAddress(spot) {
  return [spot.address, spot.city, spot.state || "CO"].filter(Boolean).join(", ");
}

function cacheKey(address) {
  return address.trim().toLowerCase().replace(/\s+/g, " ");
}

async function geocodeAddress(address, apiKey) {
  const url = "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(address) + "&key=" + apiKey;
  const res = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Geocoding API HTTP ${res.status}`);
  const json = await res.json();
  // Google answers 200 with the failure in the body -- status must be checked.
  if (json.status !== "OK" || !json.results || !json.results.length) {
    throw new Error(`Geocoding API status ${json.status}: ${json.error_message || "no results"}`);
  }
  const loc = json.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, formatted: json.results[0].formatted_address };
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

// What the browser gets. Only the fields the map actually renders, so the
// response stays small and the data file can carry notes without shipping them.
function toPin(spot, geo) {
  const pin = {
    name: spot.name,
    category: spot.category || "spot",
    lat: geo.lat,
    lng: geo.lng,
    city: spot.city || null,
    blurb: spot.blurb || null,
    videoId: spot.videoId || null,
    videoTitle: spot.videoTitle || null,
  };
  if (spot.cityHref) pin.cityHref = spot.cityHref;
  if (spot.searchCity) pin.searchCity = spot.searchCity;
  // Her own view count, shown as social proof: this is not a stock photo of a
  // restaurant, it's a video a few thousand people have watched.
  if (typeof spot.views === "number" && spot.views > 0) pin.views = spot.views;
  if (spot.googlePostUrl) pin.googlePostUrl = spot.googlePostUrl;
  // 2026-08-15: a spot can be backed by a Google review INSTEAD of a video.
  // Christine's review of one Berthoud restaurant has over 10,000 views on its
  // own -- more than this entire map's YouTube footage combined -- so treating
  // YouTube as the only real medium would have thrown away her best-performing
  // local content. reviewViews is kept separate from views so the map can say
  // which platform the number came from rather than implying they're the same.
  if (spot.googleReviewUrl) pin.googleReviewUrl = spot.googleReviewUrl;
  if (typeof spot.reviewViews === "number" && spot.reviewViews > 0) {
    pin.reviewViews = spot.reviewViews;
  }
  // Her words, shown on the map itself. Carrying the quote rather than only a
  // link matters: Google gives no permalink to an individual review, so a link
  // can only ever open the business's listing and leave the visitor hunting for
  // her among the others. The quote puts her actual review in front of them.
  if (spot.reviewQuote) pin.reviewQuote = spot.reviewQuote;
  if (spot.reviewDate) pin.reviewDate = spot.reviewDate;
  return pin;
}

exports.handler = async () => {
  try {
    if (!SPOTS.length) {
      return json200({ spots: [], note: "No local spots configured." });
    }
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      console.error("local-spots: GOOGLE_MAPS_API_KEY isn't set — no pins can be resolved.");
      return json200({ spots: [], note: "Geocoding isn't configured." });
    }

    let store = null;
    try { store = getBlobStore(getStore, GEOCODE_STORE_NAME); } catch (e) { store = null; }

    const startedAt = Date.now();
    const resolved = await mapWithConcurrency(SPOTS, GEOCODE_CONCURRENCY, async (spot) => {
      const address = fullAddress(spot);
      const key = cacheKey(address);

      if (store) {
        const cached = await store.get(key, { type: "json" }).catch(() => null);
        if (cached && typeof cached.lat === "number" && typeof cached.lng === "number" &&
            cached.cachedAt && Date.now() - cached.cachedAt < GEOCODE_CACHE_TTL_MS) {
          return toPin(spot, cached);
        }
      }

      // Past the budget, an unresolved spot waits for the next request rather
      // than pushing this one into a timeout and returning nothing at all.
      if (Date.now() - startedAt > GEOCODE_TIME_BUDGET_MS) return null;

      try {
        const geo = await geocodeAddress(address, apiKey);
        if (store) {
          await store.setJSON(key, { ...geo, cachedAt: Date.now() }).catch(() => {});
        }
        return toPin(spot, geo);
      } catch (err) {
        // Named loudly: a missing pin is otherwise invisible, and this is the
        // one failure that would quietly shrink the map over time.
        console.error(`local-spots: could not geocode "${address}" for ${spot.name}: ${err.message}`);
        return null;
      }
    });

    const pins = resolved.filter(Boolean);
    return json200({
      spots: pins,
      // So /status can say "8 of 10 pins resolved" instead of the map just
      // looking a bit emptier than it did last week.
      total: SPOTS.length,
      resolved: pins.length,
      viewsAsOf: LOCAL_SPOTS_DATA._views_as_of || null,
    });
  } catch (err) {
    console.error("local-spots function error:", err && err.message);
    // An empty list, not a 500: the map must still draw its counties.
    return json200({ spots: [], note: "Local spots temporarily unavailable." });
  }
};

function json200(payload) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": RESPONSE_CACHE_CONTROL },
    body: JSON.stringify(payload),
  };
}
