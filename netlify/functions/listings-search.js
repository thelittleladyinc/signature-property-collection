// Server-side proxy for live property search, backed by MLS Grid's RESO Web
// API (IRES MLS data). This keeps the MLS Grid access token secret (it never
// reaches the browser) and enforces the IDX compliance rules that must be
// applied at the API level, not just in the UI:
//   - Only IRES-sourced, Active listings are ever returned (see BASE_FILTER
//     below) — no sold/closed data, no other MLS's listings, regardless of
//     what a client sends in the query string.
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
  "PublicRemarks", "PropertyType", "PropertySubType",
  "ListOfficeName", "ListAgentFullName", "ListAgentDirectPhone", "ListAgentEmail",
].join(",");

// Always-on, non-negotiable filters — never controlled by the client. IRES
// only (this repo's MLS), Active listings only (buyer-facing search; sold
// data has its own separate display rules we haven't scoped yet), and a
// hard $950K floor: this site is Christine's luxury/editorial brand, and
// TheLittleLadySellsHomes.com is her general-market search site — the two
// are deliberately kept from competing for the same buyers/queries (see
// notes/websites-strategy.md). Buyers under $950K are pointed to that site
// instead of shown results here.
const LUXURY_PRICE_FLOOR = 950000;
const BASE_FILTER =
  `OriginatingSystemName eq 'ires' and StandardStatus eq 'Active' and ListPrice ge ${LUXURY_PRICE_FLOOR}`;

function odataEscape(value) {
  return String(value).replace(/'/g, "''");
}

function buildFilter(params) {
  const clauses = [BASE_FILTER];

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

  return clauses.join(" and ");
}

function mapListing(item) {
  const address = [item.StreetNumber, item.StreetName, item.StreetSuffix]
    .filter(Boolean).join(" ");
  const media = Array.isArray(item.Media) ? item.Media : [];
  const photo = media.length ? (media[0].MediaURL || null) : null;

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
    officeName: item.ListOfficeName || null,
    agentName: item.ListAgentFullName || null,
    agentPhone: item.ListAgentDirectPhone || null,
    agentEmail: item.ListAgentEmail || null,
    photo,
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
