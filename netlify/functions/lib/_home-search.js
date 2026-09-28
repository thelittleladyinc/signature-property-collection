// Where a home search goes: Christine's Lofty site, already filtered.
//
// 2026-09-28. She approved handing the home search to her Lofty site ("lets do
// it!!!") after we timed both from click to data -- Lofty's search and listing
// pages were the faster of the two (listing ~1.1s vs ~2.4s, results ~0.6s vs
// ~1.0s). So this site keeps her own listings, and every search for anything
// else lands on the Lofty site instead. This module turns the filters this
// site's search links already carry (?city=Loveland&minPrice=950000&beds=3 ...)
// into the same search there, so a visitor who tapped "Loveland, $950K+" does
// not arrive at an unfiltered page and start over.
//
// LOFTY'S SEARCH URL, read off her own Lofty site (theboldcollectivehomes.com)
// and tried there on 2026-09-28 -- not documented anywhere by Lofty:
//
//   /listing?condition=<JSON>&page=1[&listingSort=PRICE_DESC]
//
//   condition.location.city    ["Loveland, CO", ...]     any of them
//   condition.location.county  ["Larimer, CO", ...]      any of them
//   condition.price            "950000,"  "950000,3000000"  ",800000"
//   condition.beds / .baths    "3,"  (at least)
//   condition.sqft             "2500,"
//   condition.propertytype     ["Single Family Home"] | ["Condo","Townhouse"]
//   listingSort                PRICE_DESC | PRICE_ASC | SQFT_DESC | MLS_LIST_DATE_L_DESC
//
//   Checked: Loveland + $950K+ + 3 beds -> 95 homes, every one in Loveland, at
//   or over $950,000, and Lofty's own Min Price / Min Beds boxes filled in.
//   Larimer + Weld, $950K-$3M, PRICE_DESC -> 884 homes from both counties,
//   highest first, capped at $3,000,000.
//
//   Deliberately NOT mapped:
//   - subdivision: Lofty matches the exact name only ("Mariana" finds nothing,
//     "Mariana Butte" does) and several of this site's subdivision pages use a
//     short or local name, so it could land a visitor on "0 homes". Those
//     searches go to the whole city instead.
//   - riverfront / horse property: Lofty has no such filter.
//   - land / farm: Lofty's labels for them didn't match anything when tried.
//   The location group is an OR on Lofty (a city plus a subdivision is "either"),
//   which is one more reason not to combine them.
//
// With NO town named, the search is limited to her operating counties: her
// Lofty site's default search currently shows listings from other states too.
//
// The luxury floor: this site's searches start at $950K unless a link says
// noFloor=true or names its own minimum (matchesQuery in _mls-shared.js), and
// the Lofty search keeps that, so Signature's "Search Homes" stays a luxury search.
//
// The base address is IDX_SEARCH_URL (lib/_idx-display.js), so moving the Lofty
// site to another domain is one Netlify variable. If it ever points somewhere
// that is not a Lofty /listing page, it is used as-is, with no condition added.
"use strict";

const { idxSearchUrl } = require("./_idx-display");
const { OPERATING_COUNTIES, LUXURY_PRICE_FLOOR } = require("./_mls-shared");

const MAX_TOWNS = 25;
const SORTS = {
  "price-desc": "PRICE_DESC",
  "price-asc": "PRICE_ASC",
  "sqft-desc": "SQFT_DESC",
  recent: "MLS_LIST_DATE_L_DESC",
};
const PROPERTY_TYPES = {
  house: ["Single Family Home"],
  condo: ["Condo", "Townhouse"],
};

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

function positiveInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ?city=Loveland and ?cities=loveland,fort collins, together, deduplicated.
function townsFrom(params) {
  const p = params || {};
  const raw = [p.city].concat(String(p.cities || "").split(","));
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const name = String(t || "").replace(/[^A-Za-z .'-]/g, "").trim();
    if (!name || name.length > 40) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(titleCase(name));
    if (out.length >= MAX_TOWNS) break;
  }
  return out;
}

function minPriceFor(params) {
  const p = params || {};
  const asked = positiveInt(p.minPrice);
  if (asked) return asked;
  return p.noFloor === "true" ? null : LUXURY_PRICE_FLOOR;
}

function conditionFor(params, counties) {
  const p = params || {};
  const condition = {};
  const towns = townsFrom(p);
  if (towns.length) {
    condition.location = { city: towns.map((t) => `${t}, CO`) };
  } else {
    const list = [...(counties || OPERATING_COUNTIES)].sort().map((c) => `${titleCase(c)}, CO`);
    if (list.length) condition.location = { county: list };
  }
  const min = minPriceFor(p);
  const max = positiveInt(p.maxPrice);
  if (min || max) condition.price = `${min || ""},${max || ""}`;
  const beds = positiveInt(p.beds);
  if (beds) condition.beds = `${beds},`;
  const baths = positiveInt(p.baths);
  if (baths) condition.baths = `${baths},`;
  const sqft = positiveInt(p.minSqft);
  if (sqft) condition.sqft = `${sqft},`;
  const types = PROPERTY_TYPES[String(p.propertyCategory || "").toLowerCase()];
  if (types) condition.propertytype = types.slice();
  return condition;
}

function isLoftySearchPage(u) {
  return /^\/listing\/?$/.test(u.pathname);
}

// The URL a visitor is sent to for these filters.
function homeSearchUrl(params, opts) {
  const o = opts || {};
  const base = idxSearchUrl(o.env);
  let u;
  try { u = new URL(base); } catch (e) { return base; }
  if (!isLoftySearchPage(u)) return base;
  const p = params || {};
  u.searchParams.set("condition", JSON.stringify(conditionFor(p, o.counties)));
  u.searchParams.set("page", "1");
  const sort = SORTS[String(p.sort || "")];
  if (sort) u.searchParams.set("listingSort", sort);
  return u.toString();
}

function money(n) {
  if (n >= 1000000) return `$${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M`;
  return `$${Math.round(n / 1000)}K`;
}

// The words on the button that leads there. Short, and true to the filter.
function homeSearchLabel(params) {
  const towns = townsFrom(params);
  const where = towns.length === 1 ? `${towns[0]} ` : "";
  const min = minPriceFor(params);
  const from = min ? ` from ${money(min)}` : "";
  return towns.length > 1
    ? `See homes for sale in these towns${from}`
    : `See ${where}homes for sale${from}`;
}

module.exports = { homeSearchUrl, homeSearchLabel, conditionFor, townsFrom, SORTS, PROPERTY_TYPES };
