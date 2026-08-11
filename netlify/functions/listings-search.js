// Server-side proxy for live property search, backed by MLS Grid's RESO Web
// API (IRES MLS data). This keeps the MLS Grid access token secret (it never
// reaches the browser) and enforces the IDX compliance rules that must be
// applied at the API level, not just in the UI:
//   - Only IRES-sourced listings are ever returned, and only in an
//     on-market status (see MINE_STATUSES/PUBLIC_STATUSES below — Active
//     only for the general public search; Active + Active Under Contract +
//     Pending for Christine's own mine=true listing showcase, so it reflects
//     when her listings go live and go under contract automatically) — no
//     sold/closed data, no other MLS's listings, regardless of what a
//     client sends in the query string.
//   - Only public-safe fields are requested (see SELECT_FIELDS) — nothing
//     from MLS Grid's IDX Rules 21/31 prohibited list (showing
//     instructions, security info, seller/occupant contact info).
//
// Full compliance rules this page (and the disclaimer block rendered with
// it in search-homes.html) is built against:
//   https://www.mlsgrid.com/s/MLS-Grid-IDX-Rules.pdf
//
// Setup required (one-time, Netlify dashboard -> Site settings ->
// Environment variables): add MLSGRID_API_TOKEN. Confirmed working against
// Christine's real MLS Grid account on 2026-08-11 — see
// notes/verify-mlsgrid-api.mjs for how that was tested (safely, read-only,
// from her own machine, without the key ever passing through this repo).

const BASE_URL = "https://api.mlsgrid.com/v2/Property";

const SELECT_FIELDS = [
  "ListingId", "ListingKey", "StandardStatus", "ListPrice",
  "BedroomsTotal", "BathroomsTotalInteger", "LivingArea",
  "StreetNumber", "StreetName", "StreetSuffix", "City", "StateOrProvince", "PostalCode",
  "PublicRemarks", "PropertyType", "PropertySubType", "SubdivisionName",
  "WaterfrontYN", "WaterfrontFeatures",
  "ListOfficeName", "ListAgentFullName", "ListAgentDirectPhone", "ListAgentEmail",
  "CoListAgentFullName",
].join(",");

// Surname used to filter to Christine's (and her co-listing partner Kendra's
// listings, when Christine is still the primary/co-agent) own active
// inventory for the listing showcase — matched with contains()+tolower()
// rather than an exact name match, since MLS Grid's ListAgentFullName
// formatting (middle initials, suffixes) isn't something we can predict
// from outside. A surname substring match is far more robust and, for a
// distinctive name like this, effectively risk-free of false positives.
const AGENT_SURNAME = (process.env.LISTING_AGENT_SURNAME || "gwinnup").toLowerCase();

// Always-on, non-negotiable filter — never controlled by the client. IRES
// only (this repo's MLS); status is handled separately below since it
// differs between the two search modes.
const BASE_FILTER = `OriginatingSystemName eq 'ires'`;

// Which StandardStatus values count as "still worth showing," per search
// mode. Christine's own listing showcase (mine=true) shows Active AND
// under-contract listings, so a listing's lifecycle no longer has to be
// tracked by hand — MLS Grid itself is now the single source of truth for
// when something goes live and when it goes under contract (per Christine's
// request 2026-08-11; this used to only surface via her separate internal
// "Each Listing SOP" tracker). The general public search (Search Homes)
// stays Active-only — showing an under-contract home in general buyer
// search is a different product decision she hasn't asked for.
//
// RESO's Data Dictionary defines both "Active Under Contract" and "Pending"
// as valid under-contract-style statuses; we don't have a live example to
// confirm which one(s) IRES actually populates, so both are included — same
// safe-by-default pattern as LISTING_VIDEOS' address-spelling variants in
// build.py: an unused value simply never matches anything, no harm done.
const MINE_STATUSES = ["Active", "Active Under Contract", "Pending"];
const PUBLIC_STATUSES = ["Active"];

function statusClause(statuses) {
  return "(" + statuses.map((s) => `StandardStatus eq '${s}'`).join(" or ") + ")";
}

// The $950K floor applies ONLY to the general public search (mine=false —
// Search Homes): this site is Christine's luxury/editorial brand, and
// TheLittleLadySellsHomes.com is her general-market search site, so the two
// are deliberately kept from competing for the same broad buyer/queries (see
// notes/websites-strategy.md). It does NOT apply when mine=true (Current
// Listings, the blog spotlight) — that's specifically "show Christine's own
// active inventory," at any price, per her explicit request 2026-08-11.
const LUXURY_PRICE_FLOOR = 950000;

function odataEscape(value) {
  return String(value).replace(/'/g, "''");
}

function buildFilter(params) {
  const clauses = [BASE_FILTER];
  const mine = params.mine === "true";

  clauses.push(statusClause(mine ? MINE_STATUSES : PUBLIC_STATUSES));

  if (mine) {
    clauses.push(
      `(contains(tolower(ListAgentFullName),'${AGENT_SURNAME}') or ` +
      `contains(tolower(CoListAgentFullName),'${AGENT_SURNAME}'))`
    );
  } else {
    clauses.push(`ListPrice ge ${LUXURY_PRICE_FLOOR}`);
  }

  if (params.city) {
    clauses.push(`City eq '${odataEscape(params.city)}'`);
  }
  const minPrice = parseInt(params.minPrice, 10);
  if (Number.isFinite(minPrice) && minPrice > 0) {
    clauses.push(`ListPrice ge ${minPrice}`);
  }
  const maxPrice = parseInt(params.maxPrice, 10);
  if (Number.isFinite(maxPrice) && maxPrice > 0) {
    clauses.push(`ListPrice le ${maxPrice}`);
  }
  const beds = parseInt(params.beds, 10);
  if (Number.isFinite(beds) && beds > 0) {
    clauses.push(`BedroomsTotal ge ${beds}`);
  }
  const baths = parseInt(params.baths, 10);
  if (Number.isFinite(baths) && baths > 0) {
    clauses.push(`BathroomsTotalInteger ge ${baths}`);
  }

  // Subdivision-scoped feeds (Buckhorn, Mariana Butte, etc. — see
  // build_subdivision_pages() in build.py). Matched with contains()+tolower()
  // rather than an exact match since MLS Grid/IRES subdivision naming isn't
  // fully predictable (e.g. "Buckhorn Ranch" vs "Buckhorn Ranch PUD").
  if (params.subdivision) {
    clauses.push(`contains(tolower(SubdivisionName),'${odataEscape(params.subdivision.toLowerCase())}')`);
  }

  // Waterfront-specific feed (added 2026-08-11 for the West Loveland /
  // riverfront page — Christine asked for "a feed directing specifically
  // for waterfront property"). RESO Data Dictionary defines both a
  // WaterfrontYN boolean and a WaterfrontFeatures multi-value lookup
  // (values include "River Front", "River Access", "Lake Front",
  // "Waterfront" — see dd.reso.org/DD1.7/Property). Per-MLS population of
  // these fields is optional and IRES joined MLS Grid recently (Nov 2025),
  // so a PublicRemarks keyword fallback is OR'd in as a safety net in case
  // IRES listings aren't yet consistently tagging the structured fields —
  // this may surface occasional false positives (e.g. "River Street") but
  // that's a better trade-off than silently returning zero real riverfront
  // listings because of an unpopulated structured field.
  if (params.waterfront === "true") {
    clauses.push(
      "(WaterfrontYN eq true or " +
      "WaterfrontFeatures/any(f: f eq 'River Front' or f eq 'River Access' or " +
      "f eq 'Lake Front' or f eq 'Waterfront' or f eq 'Creek' or f eq 'Pond') or " +
      "contains(tolower(PublicRemarks),'riverfront') or " +
      "contains(tolower(PublicRemarks),'river frontage') or " +
      "contains(tolower(PublicRemarks),'waterfront'))"
    );
  }

  return clauses.join(" and ");
}

function mapListing(item) {
  const address = [item.StreetNumber, item.StreetName, item.StreetSuffix]
    .filter(Boolean).join(" ");
  const media = Array.isArray(item.Media) ? item.Media : [];
  // Full photo set (for the on-page gallery) plus `photo` (first image) kept
  // separately so older callers that only look at `photo` still work.
  const photos = media.map((m) => m && m.MediaURL).filter(Boolean);
  const photo = photos.length ? photos[0] : null;

  return {
    listingId: item.ListingId || item.ListingKey || null,
    price: item.ListPrice ?? null,
    beds: item.BedroomsTotal ?? null,
    baths: item.BathroomsTotalInteger ?? null,
    sqft: item.LivingArea ?? null,
    address: address || null,
    city: item.City || null,
    state: item.StateOrProvince || null,
    zip: item.PostalCode || null,
    status: item.StandardStatus || null,
    remarks: item.PublicRemarks || null,
    propertyType: item.PropertySubType || item.PropertyType || null,
    subdivision: item.SubdivisionName || null,
    waterfront: item.WaterfrontYN === true || (Array.isArray(item.WaterfrontFeatures) &&
      item.WaterfrontFeatures.some((f) => f && f !== "None")) || null,
    officeName: item.ListOfficeName || null,
    agentName: item.ListAgentFullName || null,
    coAgentName: item.CoListAgentFullName || null,
    agentPhone: item.ListAgentDirectPhone || null,
    agentEmail: item.ListAgentEmail || null,
    photo,
    photos,
  };
}

exports.handler = async (event) => {
  const token = process.env.MLSGRID_API_TOKEN;
  if (!token) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "not_configured", listings: [], totalCount: 0 }),
    };
  }

  const params = event.queryStringParameters || {};
  const top = Math.min(parseInt(params.top, 10) || 12, 24);
  const skip = Math.max(parseInt(params.skip, 10) || 0, 0);

  const filter = buildFilter(params);
  const qs = new URLSearchParams({
    "$filter": filter,
    "$select": SELECT_FIELDS,
    "$expand": "Media",
    "$top": String(top),
    "$skip": String(skip),
    "$orderby": "ListPrice desc",
    "$count": "true",
  });

  try {
    const res = await fetch(`${BASE_URL}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`MLS Grid ${res.status}: ${text.slice(0, 500)}`);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "upstream_error", status: res.status, listings: [], totalCount: 0 }),
      };
    }

    const json = await res.json();
    const listings = (json.value || []).map(mapListing);
    const totalCount = json["@odata.count"] ?? listings.length;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listings, totalCount, fetchedAt: new Date().toISOString() }),
    };
  } catch (err) {
    console.error("listings-search function error:", err);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "exception", listings: [], totalCount: 0 }),
    };
  }
};
