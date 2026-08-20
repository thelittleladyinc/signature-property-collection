// Powers the "Sold Homes Map" (see build_sold_homes_map() in build.py) --
// Christine's request 2026-08-13: map her sold listings with their video
// tours plotted by real address, "using google api". This geocodes her sold
// addresses server-side via Google's Geocoding API, so the map key never
// touches the browser -- same "secret key stays server-side" pattern as
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
// 2026-08-15 -- CACHE TTL CORRECTED. This used to cache each geocode forever,
// on the reasoning that a street address's lat/lng never changes. That
// reasoning is sound geographically and wrong contractually: Google's Maps
// Platform Service Specific Terms permit caching lat/lng from the Geocoding
// API for up to 30 consecutive calendar days and require deletion after that.
// Place IDs are the only field exempt from the caching restrictions. So the
// cache is now capped at 30 days like nearby-places.js, and entries written
// under the old scheme (which carry no timestamp) are treated as expired and
// re-fetched.
//
// Cost of the correction is small and bounded: one call per address per 30
// days -- for 150 sold homes, about 150 calls a month, comfortably inside the
// free tier. The progressive warming below already handles a partly cold
// cache, so an expiry wave degrades to "fills in over the next couple of page
// loads", not "map goes blank".
//
// 2026-08-14 -- TWO CHANGES, both prompted by Christine asking why only 12
// of her 150+ sales were on the map:
//
// 1. The address list is no longer hand-copied into this file. It used to
//    be, with a comment conceding that "this file needs a manual update any
//    time that list grows -- flagged clearly so it isn't missed". Being
//    flagged did not stop it being missed. It's now generated into
//    lib/_sold-homes-data.json by build.py from build/data/sold_homes.json,
//    the same source the page itself is built from, so the two cannot
//    disagree. A pin no longer requires a YouTube tour to exist either --
//    videoId is optional in that file.
//
// 2. That list is now expected to run to 150+ entries rather than 12, which
//    breaks the old "Promise.all over every address at once" approach on a
//    cold cache: 150 simultaneous outbound calls invites Google's rate
//    limiter, and a function that tries to finish all of them in one
//    invocation hits Netlify's execution ceiling and returns nothing (the
//    same failure mode already fixed once in sync-listings.js, see its
//    2026-08-14 timeout commit). So geocoding is now bounded on three axes:
//    a small concurrency window, a per-request timeout, and an overall time
//    budget after which no NEW lookups start. Whatever is already cached
//    always returns immediately and in full, so the map is never empty
//    while the cache warms -- it fills in over the first couple of loads
//    and is permanent from then on. The response reports pending work so
//    the client can pick up the rest without a page refresh.
const { getStore } = require("@netlify/blobs");
const { getBlobStore } = require("./lib/_mls-shared");
const { geocodeAddress } = require("./lib/_geocode");
const SOLD_HOMES_DATA = require("./lib/_sold-homes-data.json");

const GEOCODE_STORE_NAME = "sold-homes-geocode-cache";

// Google's ceiling for cached Geocoding coordinates, not a tuning knob --
// read the note above before raising it.
const GEOCODE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Tuned for Netlify's 10s default function timeout. GEOCODE_TIME_BUDGET_MS
// is when we stop STARTING lookups, not a hard abort -- in-flight requests
// still get their own GEOCODE_TIMEOUT_MS to land, so the worst case is
// roughly budget + timeout, comfortably inside the ceiling.
const GEOCODE_CONCURRENCY = 5;
const GEOCODE_TIMEOUT_MS = 4000;
const GEOCODE_TIME_BUDGET_MS = 5000;
const CACHE_READ_CONCURRENCY = 25;

const SOLD_HOME_LOCATIONS = Array.isArray(SOLD_HOMES_DATA.homes) ? SOLD_HOMES_DATA.homes : [];

// The string handed to the Geocoding API, and shown in the pin popup. The
// city matters: without it the API guesses between same-named streets in
// different towns, which is how a Loveland sale ends up pinned in Denver.
function fullAddress(loc) {
  return [loc.address, loc.city, loc.state || "CO"].filter(Boolean).join(", ");
}

function normalizeAddressKey(address) {
  return address.trim().toLowerCase().replace(/\s+/g, " ");
}


// Runs `worker` over `items` with at most `limit` in flight at once,
// preserving input order in the returned array.
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

function toPin(loc, geo) {
  const pin = {
    address: fullAddress(loc),
    lat: geo.lat,
    lng: geo.lng,
  };
  if (loc.year) pin.year = String(loc.year);
  // Optional since 2026-08-14 -- a home with no tour filmed still gets a
  // pin, it just gets an address-only popup.
  if (loc.videoId) {
    pin.videoId = loc.videoId;
    pin.title = loc.title || null;
  }
  return pin;
}

exports.handler = async () => {
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
    const startedAt = Date.now();

    // Pass 1: everything already cached. Reads hit our own storage only --
    // no Google calls, nothing to rate limit -- so this stays fast even at
    // 150+ addresses, and it means a warm cache always returns the complete
    // map regardless of the time budget below. Still windowed rather than a
    // flat Promise.all so 150 addresses don't open 150 simultaneous Blobs
    // connections.
    const cached = await mapWithConcurrency(
      SOLD_HOME_LOCATIONS,
      CACHE_READ_CONCURRENCY,
      async (loc) => {
        const geo = await store
          .get(normalizeAddressKey(fullAddress(loc)), { type: "json" })
          .catch(() => null);
        if (!geo) return null;
        // No cachedAt = written under the old forever-cache scheme, so it is
        // past the 30-day limit by definition. Expired either way: drop it
        // and let pass 2 re-fetch.
        if (!geo.cachedAt || Date.now() - geo.cachedAt >= GEOCODE_CACHE_TTL_MS) return null;
        return geo;
      }
    );

    const pins = [];
    const missing = [];
    SOLD_HOME_LOCATIONS.forEach((loc, i) => {
      const geo = cached[i];
      if (geo && typeof geo.lat === "number" && typeof geo.lng === "number") {
        pins.push(toPin(loc, geo));
      } else {
        missing.push(loc);
      }
    });

    // Pass 2: geocode what's left, bounded, and only until the time budget
    // runs out. Anything not reached this time is reported as pending and
    // picked up on the next request -- permanently, once cached.
    let deferred = 0;
    if (missing.length) {
      const fresh = await mapWithConcurrency(missing, GEOCODE_CONCURRENCY, async (loc) => {
        if (Date.now() - startedAt > GEOCODE_TIME_BUDGET_MS) {
          deferred += 1;
          return null;
        }
        const address = fullAddress(loc);
        try {
          const geo = await geocodeAddress(address, apiKey);
          await store.setJSON(normalizeAddressKey(address), { ...geo, cachedAt: Date.now() });
          return toPin(loc, geo);
        } catch (err) {
          console.error(`sold-homes-geocode: failed for "${address}":`, err.message);
          return null;
        }
      });
      fresh.filter(Boolean).forEach((pin) => pins.push(pin));
    }

    const pending = deferred > 0;

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // A sold address's location is permanent, so a fully-resolved
        // response is safe to cache hard at the edge -- this is the CDN's copy
        // of OUR response, not our storage of Google's data, so the 30-day
        // Geocoding cache limit above does not govern it. A partial one is not:
        // caching it would freeze the half-built map in place for a day and
        // stop the cache from warming, so those go uncached.
        "Cache-Control": pending
          ? "no-store"
          : "public, max-age=86400, stale-while-revalidate=604800",
        // 2026-08-20: same reasoning as local-spots.js -- this is public,
        // unauthenticated data already served to every visitor; the wildcard
        // lets mapbox/preview.html (a local file) draw the sold-homes layer.
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        pins,
        totalCount: SOLD_HOME_LOCATIONS.length,
        pending,
      }),
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
