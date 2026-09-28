// Christine's own listings, from Lofty -- the replacement for MLS Grid on this site.
//
// 2026-09-28 (Christine: "I need the backend of my websites to link to Lofty's API
// for the listings and searches on my website ... I need them switched to Lofty",
// then, after an MLS Grid email about the feed the same morning, "I'd rather just
// switch to Lofty").
//
// THE SHAPE, as she approved it the same day ("lets do it!!!") after we timed
// both: her Lofty site is faster from click to data, so Lofty's own site does
// the home search and the listing pages for every home on the market, and HER
// sites keep what only they have -- her own listings, with their video tours,
// and the town pages. So this module no longer copies the whole market (it did,
// for a few hours: ~25,000 listings every two hours through a background
// function). It keeps exactly one thing current: her own listings.
//
//   - Every 30 minutes (sync-listings.js's schedule) it asks Lofty for "my"
//     listings -- Lofty's scope for agent OR co-agent, the same rule isHers()
//     applies -- plus their details (description, subdivision, whole gallery),
//     one request for up to 50 of them. Two requests a run.
//   - A complete, non-empty answer REPLACES the stored set, so a listing she
//     withdraws or sells leaves her pages within half an hour (the 945
//     Maplebrook lesson), and records lastSuccessAt -- what the IDX 12-hour
//     guard in lib/_idx-display.js reads.
//   - Anything less changes nothing. A failed or partial read keeps the last
//     good set; an EMPTY answer is trusted only once Lofty has said so for two
//     hours running (a glitch is likelier than her having nothing listed, but a
//     permanent "keep the old ones" would show sold homes forever).
//   - Only IRES records (mlsOrgId 1054) are shown. Her Lofty account also holds
//     a manual listing ("MANL..." id) that is not on the MLS; it is reported on
//     /status, not shown, because these pages present listings as IRES MLS data.
//   - Every public search on the site now hands off to her Lofty site: see
//     lib/_home-search.js.
//
// WHAT WAS MEASURED, not assumed -- read live through this site's own
// LOFTY_API_KEY on a deploy preview:
//
//   POST /v2.0/listings/search  (Lofty's own CLI uses it; not in the public
//     reference). Works with the API key as `Authorization: token <key>`. Body:
//     { searchScope: "all"|"my"|"office", pageNum, pageSize (1-100), sortFields,
//       filterConditions: { price, beds, ..., location: { city: [...] } } }.
//     Answers { listing: [...], metadata: { totalCount, totalPage, hasMore } }.
//     Default statuses: Active, Active Under Contract, Pending. Every record
//     carries mlsOrgId 1054 (IRES) and an mlsListingId in the SAME "IRE1234567"
//     form MLS Grid used -- so /listing/<id> URLs, and her pages' links, carry
//     over -- plus price, beds, baths, sqft, address, latitude/longitude,
//     agentName/coAgentName, lastPrimaryChangeTime and ONE photo.
//   GET /v1.0/listing?mlsListingIds=A,B,C&limit=3 (documented) adds what search
//     leaves out: pictureList (the whole gallery), detailsDescribe (the
//     description), subDivisionName, county, agentOrgId. Records come back in
//     any order -- match by id.
//   Photos live on img.chime.me, Lofty's image server, as stable URLs (not
//     MLS Grid's single-use signed ones) that resize on request: prefix the
//     file name with w300_/w600_/w800_/w1024_/w1200_. A 600px card photo is
//     ~30KB. It answered browsers, social-preview bots and Node's fetch; only
//     curl's default agent got 403.
"use strict";

const {
  LOFTY_KEYS, MINE_STATUSES, AGENT_SURNAME, inferCountyFromCity,
} = require("./_mls-shared");

const LOFTY_API = "https://api.lofty.com";
const SEARCH_PATH = "/v2.0/listings/search";
const DETAILS_PATH = "/v1.0/listing";
const IRES_MLS_ORG_ID = 1054;
const PHOTO_HOST = "img.chime.me";

const PAGE_SIZE = 100;                       // Lofty's maximum for search
const MINE_MAX_PAGES = 5;                    // 500 of her own listings; she has about a dozen
const DETAILS_BATCH = 50;
// Lofty's documented default limit is 500 requests a minute. One request at a
// time with this gap stays far under it however fast Lofty answers.
const REQUEST_GAP_MS = 150;
const REQUEST_TIMEOUT_MS = 20000;
// How long Lofty must keep saying "no listings" before the site believes it.
const EMPTY_TRUSTED_AFTER_MS = 2 * 60 * 60 * 1000;
// The by-hand refresh (refresh-my-listings.js) is a public URL, so it refuses to
// run within this long of the last run. Two Lofty requests a minute at most.
const MIN_MANUAL_GAP_MS = 60 * 1000;

const CARD_PHOTO_WIDTH = 600;
const LARGE_PHOTO_WIDTH = 1200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class LoftyError extends Error {
  constructor(message, httpStatus, code) {
    super(message);
    this.httpStatus = httpStatus || 0;
    this.code = code || null;
  }
}

// ---- Small helpers ----------------------------------------------------------

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Lofty sends -1 for "not provided" (land and commercial listings mostly), and a
// card that prints "-1 bd · -1 ba · -1 sqft" is worse than printing nothing -- it
// did exactly that on the preview (2026-09-28). Counts, sizes and prices below
// zero are therefore unknown, and a size or year of 0 is too. Coordinates must
// never go through this: every Colorado longitude is negative.
function known(v) {
  const n = toNumber(v);
  return n !== null && n >= 0 ? n : null;
}
function positive(v) {
  const n = toNumber(v);
  return n !== null && n > 0 ? n : null;
}

function titleCase(s) {
  return String(s || "").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Lofty already uses the RESO words the site filters on; this only tidies the
// few spellings a feed might use for the same thing. Anything else (Sold,
// Expired, Withdrawn) passes through unchanged and is then refused by
// MINE_STATUSES.
function normalizeStatus(raw) {
  const s = String(raw || "").trim();
  const l = s.toLowerCase();
  if (!l) return null;
  if (l.includes("coming soon")) return "Coming Soon";
  if (l.includes("under contract") || l.includes("contingent")) return "Active Under Contract";
  if (l.includes("pending")) return "Pending";
  if (l === "active" || l === "new") return "Active";
  return s;
}

// "2026-09-28 17:49:13" -- Lofty does not state the zone. It is used for ONE
// thing, ordering the "Recently updated" sort (and as the version marker for
// details), where a constant offset cannot change anything.
function loftyTimestamp(s) {
  if (!s) return null;
  const t = String(s).trim().replace(" ", "T");
  return /(Z|[+-]\d\d:?\d\d)$/.test(t) ? t : `${t}Z`;
}

function isLoftyPhoto(url) {
  if (typeof url !== "string" || !url) return false;
  try { return new URL(url).host === PHOTO_HOST; } catch (e) { return false; }
}

// Asks Lofty's image server for the size a slot actually needs.
function sizedPhoto(url, width) {
  if (!isLoftyPhoto(url) || !width) return url || null;
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/(?:w\d+_)?original_/, `/w${width}_original_`);
    return u.toString();
  } catch (e) {
    return url;
  }
}

function isHers(l) {
  const surname = String(AGENT_SURNAME || "").toLowerCase();
  if (!surname || !l) return false;
  return String(l.agentName || "").toLowerCase().includes(surname) ||
    String(l.coAgentName || "").toLowerCase().includes(surname);
}

function isIres(item) {
  return !!item && Number(item.mlsOrgId) === IRES_MLS_ORG_ID && !!item.mlsListingId;
}

// ---- Mapping onto the site's listing shape ---------------------------------
// Same fields mapListing() in _mls-shared.js produced from MLS Grid, so nothing
// downstream can tell the difference; plus the coordinates MLS Grid never had.
function mapLoftyListing(item, opts) {
  const o = opts || {};
  const city = item.city || null;
  const photo = item.previewPicture || null;
  const listDate = toNumber(item.mlsListDateLSort);
  return {
    listingId: item.mlsListingId || null,
    listingKey: item.id !== undefined && item.id !== null ? String(item.id) : null,
    price: known(item.price),
    beds: known(item.bedrooms),
    baths: known(item.bathrooms),
    sqft: positive(item.sqft),
    address: item.streetAddress || (item.address ? String(item.address).split(",")[0].trim() : null),
    city,
    state: item.state || null,
    zip: item.zipCode || null,
    status: normalizeStatus(item.listingStatus),
    remarks: null,
    propertyType: item.propertyTypeSecondary || item.propertyType || item.propertyTypePrimary || null,
    subdivision: null,
    officeMlsId: null,
    agentName: item.agentName || null,
    coAgentName: item.coAgentName || null,
    photo,
    photoCount: photo ? 1 : 0,
    latitude: toNumber(item.latitude),
    longitude: toNumber(item.longitude),
    yearBuilt: positive(item.builtYear),
    listDate: listDate ? new Date(listDate * 1000).toISOString().slice(0, 10) : null,
    modificationTimestamp: loftyTimestamp(item.lastPrimaryChangeTime),
    mlgCanView: true,
    county: o.county || inferCountyFromCity(String(city || "").toLowerCase().trim()),
    source: "lofty",
  };
}

// What the v1 details record adds. Recorded against the version it describes,
// so it is fetched again only when the listing itself changes.
function applyDetails(listing, d) {
  if (!listing) return listing;
  listing.detailsFor = listing.modificationTimestamp || "unknown";
  if (!d) return listing;
  const pics = Array.isArray(d.pictureList) ? d.pictureList.filter((u) => typeof u === "string" && u) : [];
  if (pics.length) {
    listing.photos = pics;
    listing.photoCount = pics.length;
    if (!listing.photo) listing.photo = pics[0];
  }
  if (d.detailsDescribe) listing.remarks = String(d.detailsDescribe);
  const sub = d.subDivisionName || d.community;
  if (sub) listing.subdivision = String(sub);
  if (d.county && !listing.county) {
    listing.county = String(d.county).toLowerCase().replace(/\s+county$/, "").trim() || listing.county;
  }
  if (d.agentOrgId) listing.officeMlsId = String(d.agentOrgId);
  return listing;
}

// Keeps what the previous refresh learned from details when this version of the
// listing is the one those details described.
function carryForward(listing, previous) {
  if (!listing || !previous || !previous.detailsFor) return listing;
  if (previous.detailsFor !== listing.modificationTimestamp) return listing;
  for (const k of ["subdivision", "officeMlsId", "waterfront", "equestrian", "remarks", "photos"]) {
    if (previous[k] !== undefined && previous[k] !== null) listing[k] = previous[k];
  }
  if (typeof previous.photoCount === "number" && previous.photoCount > (listing.photoCount || 0)) {
    listing.photoCount = previous.photoCount;
  }
  listing.detailsFor = previous.detailsFor;
  return listing;
}

// Only her own listings are stored, and each is kept whole (her pages show the
// description and the full gallery). Nulls are dropped so the stored copy says
// only what Lofty actually said.
function slimForStorage(l) {
  const out = {};
  for (const [k, v] of Object.entries(l || {})) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// ---- HTTP ------------------------------------------------------------------

async function loftyRequest(method, path, { apiKey, body, fetchImpl, timeoutMs } = {}) {
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(LOFTY_API + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `token ${apiKey}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs || REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* reported below */ }
  if (!res.ok) {
    const said = json && (json.message || json.errorMsg);
    throw new LoftyError(`Lofty answered HTTP ${res.status}${said ? `: ${said}` : ""}`,
      res.status, json && (json.code || json.errorCode));
  }
  if (!json || typeof json !== "object") {
    throw new LoftyError(`Lofty answered HTTP ${res.status} with something that is not JSON`, res.status);
  }
  return json;
}

// One retry for the failures that are worth one: rate limits, Lofty's own
// errors, and network trouble. A 4xx about the request itself is not.
async function withRetry(fn, sleepImpl) {
  try {
    return await fn();
  } catch (err) {
    const status = err && err.httpStatus;
    if (status && status !== 429 && status < 500) throw err;
    await (sleepImpl || sleep)(status === 429 ? 10000 : 2000);
    return fn();
  }
}

async function searchPage({ apiKey, scope, county, filters, pageNum, pageSize, sortFields, fetchImpl }) {
  const body = {
    searchScope: scope || "all",
    pageNum: pageNum || 1,
    pageSize: pageSize || PAGE_SIZE,
    sortFields: sortFields || ["MLS_LIST_DATE_L_DESC"],
  };
  const conditions = { ...(filters || {}) };
  if (county) conditions.location = { county: [`${titleCase(county)}, CO`] };
  if (Object.keys(conditions).length) body.filterConditions = conditions;
  const json = await loftyRequest("POST", SEARCH_PATH, { apiKey, body, fetchImpl });
  // Lofty can report an error inside an HTTP 200 envelope.
  if (!("listing" in json) && !json.metadata) {
    throw new LoftyError(`Lofty listing search returned no listings` +
      (json.code || json.message ? ` (${[json.code, json.message].filter(Boolean).join(": ")})` : ""),
    200, json.code);
  }
  const meta = json.metadata || {};
  return {
    items: Array.isArray(json.listing) ? json.listing : [],
    totalCount: toNumber(meta.totalCount) || 0,
    totalPage: toNumber(meta.totalPage) || 0,
  };
}

async function detailsByMlsIds(ids, { apiKey, fetchImpl }) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return new Map();
  const qs = new URLSearchParams({ mlsListingIds: list.join(","), limit: String(Math.min(1000, list.length)) });
  const json = await loftyRequest("GET", `${DETAILS_PATH}?${qs.toString()}`, { apiKey, fetchImpl });
  const items = Array.isArray(json.listIng) ? json.listIng : (Array.isArray(json.listing) ? json.listing : []);
  const byId = new Map();
  for (const it of items) if (it && it.mlsListingId) byId.set(it.mlsListingId, it);
  return byId;
}

// ---- Reading her listings ------------------------------------------------------

function pacer({ now, sleepImpl }) {
  let last = 0;
  let count = 0;
  const clock = now || Date.now;
  return {
    get requests() { return count; },
    async run(fn) {
      const wait = last + REQUEST_GAP_MS - clock();
      if (wait > 0) await (sleepImpl || sleep)(wait);
      last = clock();
      count += 1;
      return withRetry(fn, sleepImpl);
    },
  };
}

// Every page of one query. Her own listings fit on one page; the loop is there
// so a bigger answer is read whole rather than silently cut off at 100.
async function readAllPages({ apiKey, scope, county, filters, pace, fetchImpl, maxPages }) {
  const items = [];
  let pageNum = 1;
  let totalPage = 1;
  let totalCount = null;
  let endedEmpty = false;
  while (pageNum <= totalPage && pageNum <= (maxPages || MINE_MAX_PAGES)) {
    const page = await pace.run(() => searchPage({ apiKey, scope, county, filters, pageNum, fetchImpl }));
    totalPage = page.totalPage;
    totalCount = page.totalCount;
    items.push(...page.items);
    if (!page.items.length) { endedEmpty = true; break; }
    pageNum += 1;
  }
  if (pageNum <= totalPage && !endedEmpty) {
    return { items, totalCount, complete: false, why: `stopped at page ${pageNum} of ${totalPage}` };
  }
  // A listing can move between pages while a query is read; a small difference
  // is normal, a large shortfall means pages were skipped.
  if (totalCount && items.length < totalCount * 0.97) {
    return { items, totalCount, complete: false, why: `read ${items.length} of ${totalCount}` };
  }
  return { items, totalCount, complete: true };
}

// Details for the given ids, 50 at a time, applied in place. A failure keeps
// whatever the previous run learned (carryForward) and is reported, never fatal:
// a listing with its cover and no description is still worth showing.
async function enrich(ids, listingsById, { apiKey, pace, fetchImpl, errors }) {
  let fetched = 0;
  for (let i = 0; i < ids.length; i += DETAILS_BATCH) {
    const batch = ids.slice(i, i + DETAILS_BATCH);
    try {
      const byId = await pace.run(() => detailsByMlsIds(batch, { apiKey, fetchImpl }));
      for (const id of batch) {
        const l = listingsById[id];
        if (!l) continue;
        const d = byId.get(id);
        if (d) {
          applyDetails(l, d);
          fetched += 1;
        }
      }
    } catch (err) {
      errors.push(`details: ${err.message}`);
    }
  }
  for (const id of ids) {
    if (listingsById[id]) listingsById[id] = slimForStorage(listingsById[id]);
  }
  return { fetched };
}

// ---- The 30-minute sync -----------------------------------------------------------

async function runMineSync(opts) {
  const { store, apiKey, fetchImpl, sleepImpl } = opts;
  const now = opts.now || Date.now;
  const log = opts.log || console.log;
  if (!apiKey) return { skipped: "LOFTY_API_KEY is not set" };

  const started = now();
  const prevState = (await store.get(LOFTY_KEYS.SYNC_STATE_KEY, { type: "json" }).catch(() => null)) || {};
  if (opts.manual && prevState.lastRunAt && started - Date.parse(prevState.lastRunAt) < MIN_MANUAL_GAP_MS) {
    return { skipped: "refreshed less than a minute ago" };
  }
  const previousRaw = (await store.get(LOFTY_KEYS.LISTINGS_KEY, { type: "json" }).catch(() => null)) || {};
  // What an earlier version of this module stored was the whole market; only
  // her listings from it can count as "the last good set".
  const previous = {};
  for (const [id, l] of Object.entries(previousRaw)) if (isHers(l)) previous[id] = l;

  const pace = pacer({ now, sleepImpl });
  const errors = [];
  const herNonMls = [];
  const fresh = {};
  let skippedNotHers = 0;
  let answer = "error";   // "ok" | "empty" | "incomplete" | "error"
  let loftyTotal = null;

  try {
    const r = await readAllPages({ apiKey, scope: "my", pace, fetchImpl, maxPages: MINE_MAX_PAGES });
    loftyTotal = r.totalCount;
    for (const it of r.items) {
      if (!isIres(it)) {
        herNonMls.push([it.mlsListingId || it.id, it.address || it.streetAddress || "", it.listingStatus || ""]
          .filter(Boolean).join(" · "));
        continue;
      }
      const l = mapLoftyListing(it, {});
      if (!l.listingId || !MINE_STATUSES.includes(l.status)) continue;
      // Lofty's "my" scope and the site's own rule should agree; if they ever
      // don't, the site's rule wins (every page decides "hers" with isHers).
      if (!isHers(l)) { skippedNotHers += 1; continue; }
      fresh[l.listingId] = carryForward(l, previous[l.listingId]);
    }
    if (!r.complete) {
      answer = "incomplete";
      errors.push(`her listings: ${r.why}`);
    } else {
      answer = Object.keys(fresh).length ? "ok" : "empty";
    }
  } catch (err) {
    errors.push(`her listings: ${err.message}`);
  }

  // Is this answer the new truth?
  let emptySince = prevState.emptyMineSince || null;
  let accept = false;
  if (answer === "ok") {
    accept = true;
  } else if (answer === "empty") {
    emptySince = emptySince || new Date(started).toISOString();
    const heldFor = started - Date.parse(emptySince);
    // Nothing stored means nothing to protect.
    accept = !Object.keys(previous).length || heldFor >= EMPTY_TRUSTED_AFTER_MS;
    if (!accept) {
      errors.push(`Lofty returned none of Christine's listings; keeping the last ${Object.keys(previous).length} ` +
        `until Lofty has said so for 2 hours (since ${emptySince})`);
    }
  }

  let details = { fetched: 0 };
  if (accept) {
    details = await enrich(Object.keys(fresh), fresh, { apiKey, pace, fetchImpl, errors });
  }
  const catalogue = accept ? fresh : previous;
  const mine = Object.values(catalogue).filter(isHers);

  const finishedAt = new Date(now()).toISOString();
  const state = {
    source: "lofty",
    scope: "mine",
    bootstrapped: !!(prevState.bootstrapped || accept),
    lastRunAt: finishedAt,
    lastRunAnswer: answer,
    lastRunError: errors.length ? errors.slice(0, 5).join(" | ").slice(0, 900) : null,
    // What the IDX 12-hour freshness guard reads (lib/_idx-display.js): only an
    // answer the site accepted as her complete, current set counts.
    lastSuccessAt: accept ? finishedAt : (prevState.lastSuccessAt || null),
    emptyMineSince: answer === "ok" || accept ? null : (answer === "empty" ? emptySince : (prevState.emptyMineSince || null)),
    lastRunRequests: pace.requests,
    lastRunDurationMs: now() - started,
    loftyMyCount: loftyTotal,
    totalListingsStored: Object.keys(catalogue).length,
    herListings: mine.length,
    herNonMlsListings: herNonMls.slice(0, 20),
    skippedNotHers,
    detailsFetchedLastRun: details.fetched,
  };
  // A stored set that still holds anyone else's listing (the whole-market copy
  // an earlier version wrote) is cut down to hers even when this answer is not
  // accepted, so no page can serve another brokerage's listing from it.
  const purge = Object.keys(previousRaw).length !== Object.keys(previous).length;
  if (accept || purge) {
    await store.setJSON(LOFTY_KEYS.LISTINGS_KEY, catalogue);
    await store.setJSON(LOFTY_KEYS.MINE_LISTINGS_KEY, mine);
  }
  await store.setJSON(LOFTY_KEYS.SYNC_STATE_KEY, state);
  log(`lofty (her listings): ${answer}${accept ? "" : " — kept the last good set"} — ${mine.length} listing(s), ` +
    `${pace.requests} request(s), ${details.fetched} detail record(s)` + (errors.length ? `; ${errors.join("; ")}` : ""));
  return { answer, accepted: accept, hers: mine.length, requests: pace.requests, errors };
}

module.exports = {
  LOFTY_API,
  SEARCH_PATH,
  DETAILS_PATH,
  IRES_MLS_ORG_ID,
  PHOTO_HOST,
  CARD_PHOTO_WIDTH,
  LARGE_PHOTO_WIDTH,
  EMPTY_TRUSTED_AFTER_MS,
  MIN_MANUAL_GAP_MS,
  LoftyError,
  normalizeStatus,
  loftyTimestamp,
  isLoftyPhoto,
  sizedPhoto,
  isHers,
  mapLoftyListing,
  applyDetails,
  carryForward,
  slimForStorage,
  searchPage,
  detailsByMlsIds,
  runMineSync,
};
