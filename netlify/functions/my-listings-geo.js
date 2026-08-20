// Christine's OWN listings (11-12 records), geocoded — the layer that lets a
// map show "homes I have for sale right now" as real pins.
//
// 2026-08-20 (Christine, on the Mapbox preview: "I have a lot of listings
// right now - like 11 or 12. How do I make it not lack one feature?"). The
// known blocker on mapping listings (§2.3 in NEXT-SESSION.md: the MLS feed
// carries no coordinates, and geocoding 15,000+ listings is not affordable)
// applies to the FULL regional catalogue, not to hers: mine-listings.json is
// a handful of records, so geocoding them costs ~12 Google calls a month
// under the same 30-day cache the sold-homes map already uses.
//
// Modeled directly on sold-homes-geocode.js — same key, same cache-TTL
// reasoning (Google's terms cap cached Geocoding lat/lng at 30 consecutive
// days; see that file's 2026-08-15 note), same bounded warming, same
// "server-side key, public response" pattern. Reads the listing facts
// (price, beds, status) fresh from the blob on every call, so a price change
// or a pending flip shows up within one sync cycle even while the geocode
// stays cached.
//
// CORS wildcard for the same reason local-spots.js and sold-homes-geocode.js
// carry one: this is public, unauthenticated data the site already shows
// every visitor, and the Mapbox preview page (a local file) needs to read it.
const { getStore } = require("@netlify/blobs");
const { getBlobStore, MINE_LISTINGS_KEY } = require("./lib/_mls-shared");

const GEOCODE_STORE_NAME = "my-listings-geocode-cache";
// Google's ceiling for cached Geocoding coordinates, not a tuning knob.
const GEOCODE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GEOCODE_CONCURRENCY = 4;
const GEOCODE_TIMEOUT_MS = 4000;
const GEOCODE_TIME_BUDGET_MS = 5000;

function fullAddress(l) {
  // City included so the API never guesses between same-named streets in
  // different towns — the lesson sold-homes-geocode.js already carries.
  return [l.address, l.city, l.state || "CO", l.zip].filter(Boolean).join(", ");
}

function normalizeAddressKey(address) {
  return address.trim().toLowerCase().replace(/\s+/g, " ");
}

async function geocodeAddress(address, apiKey) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Geocoding API HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "OK" || !json.results || !json.results.length) {
    throw new Error(`Geocoding API status ${json.status}: ${json.error_message || "no results"}`);
  }
  const loc = json.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
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

function toPin(l, geo) {
  return {
    listingId: l.listingId,
    address: l.address || null,
    city: l.city || null,
    price: l.price ?? null,
    beds: l.beds ?? null,
    baths: l.baths ?? null,
    sqft: l.sqft ?? null,
    status: l.status || null,
    propertyType: l.propertyType || null,
    url: l.listingId ? `/listing/${l.listingId}` : null,
    lat: geo.lat,
    lng: geo.lng,
  };
}

function corsJson(payload, cacheControl) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(payload),
  };
}

exports.handler = async () => {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return corsJson({ error: "not_configured", pins: [] }, "no-store");
    }

    const listingsStore = getBlobStore(getStore); // default: the mls-listings store
    const mine = await listingsStore.get(MINE_LISTINGS_KEY, { type: "json" }).catch(() => null);
    // Sold/expired records don't belong on a "for sale right now" layer; an
    // address is required because it is the only thing to geocode by.
    const active = (Array.isArray(mine) ? mine : []).filter(
      (l) => l && l.address && l.city && String(l.status || "").toLowerCase() !== "closed"
    );
    if (!active.length) {
      return corsJson(
        { pins: [], totalCount: 0, pending: false, note: "No active listings in the store yet." },
        "no-store"
      );
    }

    const geoStore = getBlobStore(getStore, GEOCODE_STORE_NAME);
    const startedAt = Date.now();

    const pins = [];
    let deferred = 0;
    await mapWithConcurrency(active, GEOCODE_CONCURRENCY, async (l) => {
      const key = normalizeAddressKey(fullAddress(l));
      const cached = await geoStore.get(key, { type: "json" }).catch(() => null);
      if (cached && cached.cachedAt && Date.now() - cached.cachedAt < GEOCODE_CACHE_TTL_MS) {
        pins.push(toPin(l, cached));
        return;
      }
      if (Date.now() - startedAt > GEOCODE_TIME_BUDGET_MS) {
        deferred += 1;
        return;
      }
      try {
        const geo = await geocodeAddress(fullAddress(l), apiKey);
        await geoStore.setJSON(key, { ...geo, cachedAt: Date.now() }).catch(() => {});
        pins.push(toPin(l, geo));
      } catch (err) {
        console.error(`my-listings-geo: failed for "${fullAddress(l)}":`, err && err.message);
      }
    });

    const pending = deferred > 0;
    // Short edge cache even when complete: unlike a sold address, a listing's
    // price and status genuinely change, and the facts here are read fresh
    // from the blob each invocation. Five minutes keeps a page of visitors
    // from stampeding the function without freezing a price flip for a day.
    return corsJson(
      { pins, totalCount: active.length, pending },
      pending ? "no-store" : "public, max-age=300, stale-while-revalidate=3600"
    );
  } catch (err) {
    console.error("my-listings-geo function error:", err);
    return corsJson({ error: "exception", message: err && err.message, pins: [] }, "no-store");
  }
};
