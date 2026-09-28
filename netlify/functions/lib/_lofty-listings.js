// Lofty as the listing source -- the replacement for MLS Grid on this site.
//
// 2026-09-28 (Christine: "I need the backend of my websites to link to Lofty's API
// for the listings and searches on my website ... I need them switched to Lofty",
// then, after an MLS Grid email about the feed the same morning, "I'd rather just
// switch to Lofty").
//
// WHAT WAS MEASURED, not assumed -- read live through this site's own
// LOFTY_API_KEY by netlify/functions/lofty-listings-probe.js on a deploy preview:
//
//   POST /v2.0/listings/search  (Lofty's own CLI uses it; not in the public
//     reference). Works with the API key as `Authorization: token <key>`. Body:
//     { searchScope: "all"|"my"|"office", pageNum, pageSize (1-100), sortFields,
//       filterConditions: { price, beds, ..., daysOnSite, location: { city:
//       ["Loveland, CO"], county: ["Larimer, CO"], zipCode: [...] } } }.
//     Answers { listing: [...], metadata: { totalCount, totalPage, hasMore } }.
//     Default statuses: Active, Active Under Contract, Pending (same words the
//     site already uses). Every record carries mlsOrgId 1054 (IRES), an
//     mlsListingId in the SAME "IRE1234567" form MLS Grid used -- so listing
//     URLs, area-alert ids and photo keys all carry over -- price, bedrooms,
//     bathrooms, sqft, streetAddress/city/state/zipCode, latitude/longitude
//     (MLS Grid never gave us coordinates), agentName/coAgentName,
//     lastPrimaryChangeTime and ONE photo (previewPicture).
//     County sizes on 2026-09-28: Larimer 3,695, Weld 3,089, Boulder 2,460,
//     Broomfield 415, Jefferson 3,619, Denver 4,669, Arapahoe 3,512,
//     Adams 3,073, Morgan 363 -- ~25,000 in all, ~255 pages of 100. Page 30
//     of Larimer still returned a full page, so deep paging works.
//   GET /v1.0/listing?mlsListingIds=A,B,C&limit=3 (documented). Works for
//     OTHER brokers' listings too, and adds what search leaves out: pictureList
//     (the whole gallery), detailsDescribe (the description), subDivisionName,
//     county, agentOrgId. Records come back in any order -- match by id.
//   Photos live on img.chime.me, Lofty's image server, as stable URLs (not
//     MLS Grid's single-use signed ones) and it resizes on request: prefix the
//     file name with w300_/w600_/w800_/w1024_/w1200_. A 600px card photo is
//     ~30KB where MLS Grid handed every card a 1-3MB original -- which settles
//     NEXT-SESSION.md 2.9b ("slow photos") by itself. It answered browsers,
//     social-preview bots and Node's fetch; only curl's default agent got 403.
//
// DESIGN, and why:
//   - The Lofty catalogue is written in exactly the shape mapListing() gave the
//     MLS Grid one, under its own keys (LOFTY_KEYS in _mls-shared.js), so every
//     page that reads listings keeps working unchanged and switching back to
//     MLS Grid is one env var.
//   - A FULL refresh (every operating county, every page) replaces the
//     catalogue only when it read everything -- a complete snapshot is the one
//     honest way to learn a listing has left the market, because search has no
//     "changed since" filter. A partial run only adds and updates; it never
//     removes on partial evidence. It runs in a background function
//     (lofty-sync-background.js, 15-minute limit) every two hours.
//   - A QUICK pass every 30 minutes (the existing sync schedule) refreshes her
//     own listings -- so a withdrawal leaves her pages within half an hour, the
//     945 Maplebrook lesson -- and adds listings that came on the market today.
//   - Details (description, subdivision, gallery count) are fetched once per
//     version of a listing (detailsFor === modificationTimestamp), 50 at a time,
//     so a steady-state refresh costs a handful of detail calls, not hundreds.
//   - Only IRES records (mlsOrgId 1054) are published. Her Lofty account also
//     holds a manual listing ("MANL..." id) that is not on the MLS; it is
//     counted in state but not shown, because everything on these pages is
//     presented as IRES MLS data.
"use strict";

const {
  LOFTY_KEYS, OPERATING_COUNTIES, REPLICATED_STATUSES, MINE_STATUSES, AGENT_SURNAME,
  inferCountyFromCity, hasEquestrianKeywords, hasWaterfrontKeywords,
} = require("./_mls-shared");

const LOFTY_API = "https://api.lofty.com";
const SEARCH_PATH = "/v2.0/listings/search";
const DETAILS_PATH = "/v1.0/listing";
const IRES_MLS_ORG_ID = 1054;
const PHOTO_HOST = "img.chime.me";

const PAGE_SIZE = 100;                       // Lofty's maximum for search
const MAX_PAGES_PER_QUERY = 150;             // 15,000 -- the biggest county is 4,669
const DETAILS_BATCH = 50;
// Lofty's documented default limit is 500 requests a minute. One request at a
// time with this gap stays far under it however fast Lofty answers.
const REQUEST_GAP_MS = 150;
const REQUEST_TIMEOUT_MS = 20000;
const CRAWL_DEADLINE_MS = 12 * 60 * 1000;    // background functions are stopped at 15 minutes
const CRAWL_LOCK_TTL_MS = 16 * 60 * 1000;
const FULL_CRAWL_EVERY_MS = 2 * 60 * 60 * 1000;
// The background endpoint is public (Netlify gives it a URL), so a completed
// refresh refuses to start another for this long. Bounds what anyone could make
// it cost to ~3 refreshes an hour, which Lofty would not notice.
const MIN_CRAWL_GAP_MS = 20 * 60 * 1000;
const CRAWL_LOCK_KEY = "lofty-crawl-lock.json";
const CRAWL_KICK_KEY = "lofty-crawl-kick.json";
const GALLERY_KEY_PREFIX = "lofty-gallery/";
const GALLERY_TTL_MS = 6 * 60 * 60 * 1000;

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
// REPLICATED_STATUSES, exactly as before.
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

// Same idea as slimForStorage() in sync-listings.js: her listings are kept whole;
// everyone else's description is reduced to the two flags the search filters on
// and the gallery to a count. Nulls are dropped -- at 25,000 records every empty
// field costs hundreds of kilobytes on every cold search.
function slimForStorage(l) {
  const out = {};
  for (const [k, v] of Object.entries(l)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  if (isHers(l)) return out;
  const remarks = String(l.remarks || "").toLowerCase();
  if (remarks) {
    if (hasWaterfrontKeywords(remarks)) out.waterfront = true;
    if (hasEquestrianKeywords(remarks)) out.equestrian = true;
  }
  delete out.remarks;
  delete out.photos;
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

// ---- Saving the catalogue ------------------------------------------------------

async function saveCatalogue(store, listingsById, state) {
  const mine = Object.values(listingsById).filter(isHers);
  await store.setJSON(LOFTY_KEYS.LISTINGS_KEY, listingsById);
  await store.setJSON(LOFTY_KEYS.MINE_LISTINGS_KEY, mine);
  await store.setJSON(LOFTY_KEYS.SYNC_STATE_KEY, { ...state, herListings: mine.length });
  return mine.length;
}

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

async function readLock(store) {
  return store.get(CRAWL_LOCK_KEY, { type: "json" }).catch(() => null);
}

function lockIsHeld(lock, nowMs) {
  return !!(lock && lock.startedAt && !lock.finishedAt &&
    nowMs - Date.parse(lock.startedAt) < CRAWL_LOCK_TTL_MS);
}

// Fetches every page of one query (a county, or her own listings).
async function readAllPages({ apiKey, scope, county, filters, pace, fetchImpl, outOfTime, maxPages }) {
  const items = [];
  let pageNum = 1;
  let totalPage = 1;
  let totalCount = null;
  let endedEmpty = false;
  while (pageNum <= totalPage && pageNum <= (maxPages || MAX_PAGES_PER_QUERY)) {
    if (outOfTime && outOfTime()) {
      return { items, totalCount, complete: false, why: `ran out of time at page ${pageNum} of ${totalPage}` };
    }
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
  // Listings move between pages while a query is being read (a new listing
  // pushes the rest down, a removal pulls them up -- which can also leave the
  // last page empty), so small differences are normal. A large shortfall means
  // pages were skipped.
  if (totalCount && items.length < totalCount * 0.97) {
    return { items, totalCount, complete: false, why: `read ${items.length} of ${totalCount}` };
  }
  return { items, totalCount, complete: true };
}

// Fetches details for the given ids, 50 at a time, and applies them in place.
async function enrich(ids, listingsById, { apiKey, pace, fetchImpl, outOfTime, errors }) {
  let fetched = 0;
  for (let i = 0; i < ids.length; i += DETAILS_BATCH) {
    if (outOfTime && outOfTime()) return { fetched, pending: ids.length - i };
    const batch = ids.slice(i, i + DETAILS_BATCH);
    try {
      const byId = await pace.run(() => detailsByMlsIds(batch, { apiKey, fetchImpl }));
      for (const id of batch) {
        const l = listingsById[id];
        if (!l) continue;
        applyDetails(l, byId.get(id));
        listingsById[id] = slimForStorage(l);
        if (byId.get(id)) fetched += 1;
      }
    } catch (err) {
      errors.push(`details: ${err.message}`);
      return { fetched, pending: ids.length - i };
    }
  }
  return { fetched, pending: 0 };
}

// ---- The full refresh (background function, every two hours) ----------------

async function runFullCrawl(opts) {
  const { store, apiKey, fetchImpl, sleepImpl } = opts;
  const now = opts.now || Date.now;
  const log = opts.log || console.log;
  if (!apiKey) return { skipped: "LOFTY_API_KEY is not set" };

  const started = now();
  const lock = await readLock(store);
  if (lockIsHeld(lock, started)) return { skipped: "another full refresh is already running" };
  const prevState = (await store.get(LOFTY_KEYS.SYNC_STATE_KEY, { type: "json" }).catch(() => null)) || {};
  if (!opts.force && prevState.lastFullCrawlComplete && prevState.lastFullCrawlAt &&
      started - Date.parse(prevState.lastFullCrawlAt) < MIN_CRAWL_GAP_MS) {
    return { skipped: "the last full refresh finished less than 20 minutes ago" };
  }
  const runId = `${started}-${Math.random().toString(36).slice(2, 8)}`;
  await store.setJSON(CRAWL_LOCK_KEY, { runId, startedAt: new Date(started).toISOString() });

  // Released in finally{}: a refresh that throws must not leave the lock held
  // and silently block every refresh after it for the lock's 16 minutes.
  try {
    const pace = pacer({ now, sleepImpl });
    const outOfTime = () => now() - started > (opts.deadlineMs || CRAWL_DEADLINE_MS);
    const previous = (await store.get(LOFTY_KEYS.LISTINGS_KEY, { type: "json" }).catch(() => null)) || {};
    const fresh = {};
    const byCounty = {};
    const byStatus = {};
    const incomplete = [];
    const errors = [];
    const herNonMls = [];
    let skippedNotIres = 0;

    const accept = (item, county) => {
      if (!isIres(item)) { skippedNotIres += 1; return null; }
      const l = mapLoftyListing(item, { county });
      if (!l.listingId || !REPLICATED_STATUSES.includes(l.status)) return null;
      if (fresh[l.listingId]) return fresh[l.listingId];
      fresh[l.listingId] = carryForward(l, previous[l.listingId]);
      byStatus[l.status] = (byStatus[l.status] || 0) + 1;
      if (county) byCounty[county] = (byCounty[county] || 0) + 1;
      return fresh[l.listingId];
    };

    for (const county of [...OPERATING_COUNTIES].sort()) {
      try {
        const r = await readAllPages({ apiKey, county, pace, fetchImpl, outOfTime });
        for (const it of r.items) accept(it, county);
        if (!r.complete) incomplete.push(`${county}: ${r.why}`);
      } catch (err) {
        incomplete.push(`${county}: ${err.message}`);
        errors.push(`${county}: ${err.message}`);
      }
    }

    // Her own listings, wherever they are -- one of hers outside the nine
    // counties is still hers to show. Lofty's "my" scope is agent OR co-agent,
    // the same rule isHers() applies.
    let herQueryOk = false;
    const herIds = new Set();
    try {
      const r = await readAllPages({ apiKey, scope: "my", pace, fetchImpl, outOfTime, maxPages: 10 });
      for (const it of r.items) {
        if (!isIres(it)) {
          herNonMls.push([it.mlsListingId || it.id, it.address || it.streetAddress || "", it.listingStatus || ""].join(" · "));
          continue;
        }
        const l = mapLoftyListing(it, {});
        if (!MINE_STATUSES.includes(l.status)) continue;
        if (!fresh[l.listingId]) fresh[l.listingId] = carryForward(l, previous[l.listingId]);
        herIds.add(l.listingId);
      }
      // An EMPTY answer is not treated as "she has no listings": she always has
      // some, and a glitch that returned nothing must not wipe her pages. If she
      // truly has none, the next complete refresh removes them anyway.
      herQueryOk = r.complete && herIds.size > 0;
      if (!r.complete) incomplete.push(`her listings: ${r.why}`);
    } catch (err) {
      incomplete.push(`her listings: ${err.message}`);
      errors.push(`her listings: ${err.message}`);
    }

    // Details: hers every time (her pages show the description and the whole
    // gallery), everyone else's once per version. Hers first, then the newest.
    const needDetails = Object.values(fresh)
      .filter((l) => isHers(l) || l.detailsFor !== l.modificationTimestamp)
      .sort((a, b) => (isHers(b) - isHers(a)) || String(b.listDate || "").localeCompare(String(a.listDate || "")))
      .map((l) => l.listingId);
    const needSet = new Set(needDetails);
    for (const l of Object.values(fresh)) {
      if (!needSet.has(l.listingId)) fresh[l.listingId] = slimForStorage(l);
    }
    const details = await enrich(needDetails, fresh, { apiKey, pace, fetchImpl, outOfTime, errors });

    const complete = incomplete.length === 0;
    // Complete: the snapshot IS the market, so anything missing from it has left.
    // Partial: add and update only -- never remove a listing on partial evidence.
    const catalogue = complete ? fresh : { ...previous, ...fresh };
    if (!complete && herQueryOk) {
      // Her own listings are known exactly even on a partial run, so a withdrawn
      // or sold one of hers still leaves her pages now rather than at the next
      // complete refresh.
      for (const [id, l] of Object.entries(catalogue)) {
        if (isHers(l) && !herIds.has(id)) delete catalogue[id];
      }
    }
    for (const [id, l] of Object.entries(catalogue)) catalogue[id] = slimForStorage(l);

    const finishedAt = new Date(now()).toISOString();
    const state = {
      ...prevState,
      source: "lofty",
      bootstrapped: !!(prevState.bootstrapped || complete),
      lastRunAt: finishedAt,
      lastRunError: errors.length ? errors.slice(0, 5).join(" | ").slice(0, 900) : null,
      lastFullCrawlAt: finishedAt,
      lastFullCrawlComplete: complete,
      lastCompleteFullCrawlAt: complete ? finishedAt : (prevState.lastCompleteFullCrawlAt || null),
      // What the IDX 12-hour freshness guard reads (lib/_idx-display.js): only a
      // COMPLETE refresh -- every listing re-read -- proves the whole copy is
      // current. Quick passes and partial refreshes carry it forward unchanged.
      lastSuccessAt: complete ? finishedAt : (prevState.lastSuccessAt || null),
      lastFullCrawlIncomplete: incomplete.slice(0, 20),
      lastFullCrawlDurationMs: now() - started,
      lastFullCrawlRequests: pace.requests,
      totalListingsStored: Object.keys(catalogue).length,
      byCounty,
      byStatus,
      skippedNotIres,
      herNonMlsListings: herNonMls.slice(0, 20),
      detailsFetchedLastRun: details.fetched,
      detailsPending: details.pending,
    };
    const herCount = await saveCatalogue(store, catalogue, state);
    log(`lofty full refresh: ${complete ? "complete" : "PARTIAL"} — ${state.totalListingsStored} listing(s) stored ` +
      `(${herCount} hers), ${pace.requests} request(s), ${details.fetched} detail record(s), ` +
      `${Math.round(state.lastFullCrawlDurationMs / 1000)}s` + (incomplete.length ? `; incomplete: ${incomplete.join("; ")}` : ""));
    return { complete, stored: state.totalListingsStored, hers: herCount, requests: pace.requests, incomplete, errors };
  } finally {
    await store.setJSON(CRAWL_LOCK_KEY, {
      runId, startedAt: new Date(started).toISOString(), finishedAt: new Date(now()).toISOString(),
    }).catch(() => {});
  }
}

// ---- The quick pass (scheduled every 30 minutes) ------------------------------

async function runQuickPass(opts) {
  const { store, apiKey, fetchImpl, sleepImpl } = opts;
  const now = opts.now || Date.now;
  if (!apiKey) return { skipped: "LOFTY_API_KEY is not set" };
  const started = now();
  if (lockIsHeld(await readLock(store), started)) {
    return { skipped: "a full refresh is running; it covers everything this pass would" };
  }
  const state = (await store.get(LOFTY_KEYS.SYNC_STATE_KEY, { type: "json" }).catch(() => null)) || {};
  const catalogue = (await store.get(LOFTY_KEYS.LISTINGS_KEY, { type: "json" }).catch(() => null)) || {};
  const pace = pacer({ now, sleepImpl });
  // The schedule allows 30 seconds and the catalogue still has to be written after this.
  const outOfTime = () => now() - started > (opts.deadlineMs || 15000);
  const errors = [];
  const touched = [];

  // 1. Her own listings, exactly.
  let herRefreshed = false;
  const herIds = new Set();
  try {
    const r = await readAllPages({ apiKey, scope: "my", pace, fetchImpl, outOfTime, maxPages: 10 });
    for (const it of r.items) {
      if (!isIres(it)) continue;
      const l = mapLoftyListing(it, {});
      if (!MINE_STATUSES.includes(l.status)) continue;
      catalogue[l.listingId] = carryForward(l, catalogue[l.listingId]);
      herIds.add(l.listingId);
      touched.push(l.listingId);
    }
    // Same rule as the full refresh: an empty answer never removes her listings.
    if (r.complete && herIds.size > 0) {
      for (const [id, l] of Object.entries(catalogue)) {
        if (isHers(l) && !herIds.has(id)) delete catalogue[id];
      }
      herRefreshed = true;
    }
  } catch (err) {
    errors.push(`her listings: ${err.message}`);
  }

  // 2. What came on the market in the last day, county by county.
  let added = 0;
  for (const county of [...OPERATING_COUNTIES].sort()) {
    if (outOfTime()) break;
    try {
      const page = await pace.run(() => searchPage({
        apiKey, county, filters: { daysOnSite: ",1" }, pageNum: 1, fetchImpl,
      }));
      for (const it of page.items) {
        if (!isIres(it)) continue;
        const l = mapLoftyListing(it, { county });
        if (!l.listingId || !REPLICATED_STATUSES.includes(l.status)) continue;
        if (!catalogue[l.listingId]) added += 1;
        catalogue[l.listingId] = carryForward(l, catalogue[l.listingId]);
        touched.push(l.listingId);
      }
    } catch (err) {
      errors.push(`${county} (new today): ${err.message}`);
    }
  }

  const needDetails = [...new Set(touched)].filter((id) => {
    const l = catalogue[id];
    return l && (isHers(l) || l.detailsFor !== l.modificationTimestamp);
  });
  const details = await enrich(needDetails, catalogue, { apiKey, pace, fetchImpl, outOfTime, errors });
  for (const id of new Set(touched)) if (catalogue[id]) catalogue[id] = slimForStorage(catalogue[id]);

  const finishedAt = new Date(now()).toISOString();
  const next = {
    ...state,
    source: "lofty",
    lastRunAt: finishedAt,
    lastQuickPassAt: finishedAt,
    lastQuickPassAdded: added,
    lastQuickPassRequests: pace.requests,
    lastQuickPassError: errors.length ? errors.join(" | ").slice(0, 900) : null,
    lastRunError: errors.length ? errors.slice(0, 5).join(" | ").slice(0, 900) : (state.lastFullCrawlComplete === false ? state.lastRunError : null),
    totalListingsStored: Object.keys(catalogue).length,
    herListingsConfirmedAt: herRefreshed ? finishedAt : (state.herListingsConfirmedAt || null),
  };
  const herCount = await saveCatalogue(store, catalogue, next);
  return { added, hers: herCount, requests: pace.requests, errors, herRefreshed };
}

// ---- What the 30-minute schedule does ----------------------------------------

function fullCrawlDue(state, nowMs) {
  if (!state || !state.lastFullCrawlAt) return true;
  // No recorded success means the IDX freshness guard is holding every listing
  // back, so a refresh is due now -- runFullCrawl's own 20-minute guard still
  // stops this from repeating faster than that.
  if (!state.lastSuccessAt) return nowMs - Date.parse(state.lastFullCrawlAt) >= MIN_CRAWL_GAP_MS;
  const age = nowMs - Date.parse(state.lastFullCrawlAt);
  if (!state.lastFullCrawlComplete) return age >= MIN_CRAWL_GAP_MS;
  return age >= FULL_CRAWL_EVERY_MS;
}

async function scheduledTick(opts) {
  const { store, apiKey, siteUrl } = opts;
  const now = opts.now || Date.now;
  const doFetch = opts.fetchImpl || fetch;
  if (!apiKey) return { skipped: "LOFTY_API_KEY is not set" };

  let quick;
  try {
    quick = await runQuickPass(opts);
  } catch (err) {
    quick = { error: err && err.message };
  }

  const state = (await store.get(LOFTY_KEYS.SYNC_STATE_KEY, { type: "json" }).catch(() => null)) || {};
  let kick = null;
  if (fullCrawlDue(state, now()) && !lockIsHeld(await readLock(store), now())) {
    const res = await doFetch(`${siteUrl}/.netlify/functions/lofty-sync-background`, {
      method: "POST",
      signal: AbortSignal.timeout(4000),
    }).catch((err) => ({ status: 0, err }));
    kick = { at: new Date(now()).toISOString(), siteUrl, httpStatus: res.status || 0, error: res.err ? String(res.err.message) : null };
    await store.setJSON(CRAWL_KICK_KEY, kick).catch(() => {});
  }
  return { quick, kick };
}

// ---- One listing's gallery, on demand (listing pages, photo links) -----------

async function galleryFor(store, listingId, { apiKey, fetchImpl, now } = {}) {
  const clock = now || Date.now;
  const key = `${GALLERY_KEY_PREFIX}${listingId}.json`;
  const cached = await store.get(key, { type: "json" }).catch(() => null);
  if (cached && Array.isArray(cached.photos) && clock() - Date.parse(cached.at) < GALLERY_TTL_MS) {
    return cached.photos;
  }
  if (!apiKey) return cached && Array.isArray(cached.photos) ? cached.photos : [];
  try {
    const byId = await detailsByMlsIds([listingId], { apiKey, fetchImpl });
    const d = byId.get(listingId);
    const photos = d && Array.isArray(d.pictureList) ? d.pictureList.filter((u) => typeof u === "string" && u) : [];
    await store.setJSON(key, { at: new Date(clock()).toISOString(), photos }).catch(() => {});
    return photos;
  } catch (err) {
    return cached && Array.isArray(cached.photos) ? cached.photos : [];
  }
}

module.exports = {
  LOFTY_API,
  SEARCH_PATH,
  DETAILS_PATH,
  IRES_MLS_ORG_ID,
  PHOTO_HOST,
  CARD_PHOTO_WIDTH,
  LARGE_PHOTO_WIDTH,
  CRAWL_LOCK_KEY,
  CRAWL_KICK_KEY,
  FULL_CRAWL_EVERY_MS,
  MIN_CRAWL_GAP_MS,
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
  fullCrawlDue,
  runFullCrawl,
  runQuickPass,
  scheduledTick,
  galleryFor,
};
