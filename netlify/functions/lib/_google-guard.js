// Who may make this site spend Google money.
//
// 2026-09-30 (API audit). nearby-places.js answered ANY ?address= and
// walkability.js ANY ?place=, and each new string is a paid geocode plus six (or
// ten) Places Nearby Searches and a Distance Matrix call. The 30-day cache only
// helps when the same string comes back, so anyone varying the text could run up
// the bill without limit -- through two public doors, because the Little Lady
// site passes both endpoints straight through to this one (lib/_sig-proxy.js
// there). A Referer check would not help: that pass-through sends none, and a
// script can send any.
//
// What the pages actually ask for is a short, known list, so a lookup that would
// cost money is only made for:
//   - a town the site knows (CO_CITY_COUNTY, the same table the listings use):
//       "Loveland, CO"   "Ault, Weld County, CO" (the town pages' drive times)
//   - a neighbourhood page's place inside a known town, with that town as `near`:
//       "Mariana Butte, Loveland, CO" near "Loveland, CO"
//   - the address of a listing the site is showing right now (nearby-places)
// and, behind that, at most DAILY_LIMITS fresh lookups a day per endpoint, so
// even text that passes the checks cannot turn into an open-ended bill. Anything
// already cached is answered exactly as before, at no cost, whatever it is.
"use strict";

const { CO_CITY_COUNTY, inferCountyFromCity, MINE_LISTINGS_KEY, LISTINGS_KEY } = require("./_mls-shared");

// Fresh (uncached) lookups per UTC day. The pages' whole working set -- about 40
// town strings, a dozen of her listings, ~50 walkability places -- is cached for
// 30 days, so a normal day needs a handful; these leave room for the day a batch
// of entries expires together.
const DAILY_LIMITS = { "nearby-places": 60, walkability: 40 };
const BUDGET_PREFIX = "google-budget/";

const KNOWN_COUNTIES = new Set(Object.values(CO_CITY_COUNTY));

function parts(s) {
  return String(s || "").split(",").map((p) => p.trim().replace(/\s+/g, " ")).filter(Boolean);
}

function isKnownTown(name) {
  return !!inferCountyFromCity(String(name || "").toLowerCase().trim());
}

// "Loveland, CO"
function isTownPlace(s) {
  const p = parts(s);
  return p.length === 2 && p[1].toLowerCase() === "co" && isKnownTown(p[0]);
}

// "Ault, Weld County, CO" -- the town pages' drive-time block. Windsor sits in two
// counties, so the county only has to be one the site knows, not the town's own.
function isTownCountyPlace(s) {
  const p = parts(s);
  if (p.length !== 3 || p[2].toLowerCase() !== "co" || !isKnownTown(p[0])) return false;
  const m = /^(.+) county$/i.exec(p[1]);
  return !!m && KNOWN_COUNTIES.has(m[1].toLowerCase());
}

// "Mariana Butte, Loveland, CO" near "Loveland, CO" -- a neighbourhood page.
function isNeighborhoodPlace(place, near) {
  const p = parts(place);
  if (p.length !== 3 || p[2].toLowerCase() !== "co" || p[0].length > 60) return false;
  if (!isTownPlace(near)) return false;
  return p[1].toLowerCase() === parts(near)[0].toLowerCase();
}

function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// The address strings the listing cards and listing pages send for one listing.
function listingAddresses(l) {
  if (!l || !l.address) return [];
  return [
    [l.address, l.city, l.state, l.zip],
    [l.address, l.city, l.state || "CO", l.zip],
    [l.address, l.city, l.state],
  ].map((a) => normalize(a.filter(Boolean).join(", ")));
}

// True when this address belongs to a listing the site is showing now. Her own
// listings first (a handful of records); the full listings key only when that
// misses, which under Lofty is also just her listings.
async function isShownListingAddress(address, store) {
  const want = normalize(address);
  if (!want || !store) return false;
  const mine = await store.get(MINE_LISTINGS_KEY, { type: "json" }).catch(() => null);
  if ((Array.isArray(mine) ? mine : []).some((l) => listingAddresses(l).includes(want))) return true;
  const all = await store.get(LISTINGS_KEY, { type: "json" }).catch(() => null);
  const list = Array.isArray(all) ? all : (all && typeof all === "object" ? Object.values(all) : []);
  return list.some((l) => listingAddresses(l).includes(want));
}

// One fresh lookup from today's allowance, or a refusal. Counted in the
// endpoint's own cache store. Blobs has no atomic increment, so two simultaneous
// requests can both read the same count -- a slight undercount on a backstop is
// fine. An unreadable counter lets the lookup through, the same way these
// endpoints already answer when their cache can't be read
// (tests/test-distances.js pins that); the checks above still apply.
async function takeDailyLookup(store, name, now) {
  const limit = DAILY_LIMITS[name] || 0;
  const key = `${BUDGET_PREFIX}${name}/${new Date(now || Date.now()).toISOString().slice(0, 10)}`;
  let used;
  try {
    const cur = await store.get(key, { type: "json" });
    used = (cur && Number(cur.used)) || 0;
  } catch (err) {
    return { ok: true, limit, uncounted: true };
  }
  if (used >= limit) return { ok: false, used, limit };
  await Promise.resolve(store.setJSON(key, { used: used + 1 })).catch(() => {});
  return { ok: true, used: used + 1, limit };
}

module.exports = {
  DAILY_LIMITS, BUDGET_PREFIX,
  isKnownTown, isTownPlace, isTownCountyPlace, isNeighborhoodPlace,
  listingAddresses, isShownListingAddress, takeDailyLookup,
};
