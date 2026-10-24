// MLS reads through the Seller Intelligence hub (wave 2a, 2026-10-17). OFF unless MLS_SOURCE is exactly "hub".
//
// ONE COPY, BOTH SITES (2026-10-24). Byte-identical in signature-property-collection and thelittleladysellshomes
// (each site's tests compare it with the other checkout when present). On the Signature site it serves the
// market-data run and the on-market check in sync-listings.js; on the main site, the same on-market check in
// lib/_mls-onmarket.js (her listings refreshed by hand there read the Signature site's stored copy). "This site"
// below means whichever site runs it.
//
// WHY. This site, Listing Engine and Expired Elite shared ONE MLS Grid account, and MLS Grid suspends a token for
// the whole account's traffic (2026-08-01). The hub (sellerintelligence hub-api) now keeps its own copy of the
// IRES feed and is the one MLS Grid reader; every app asks it instead. docs/mls-via-hub.md has the whole story,
// the status map and the turn-on steps.
//
// THE SWITCH. MLS_SOURCE, read on every call (never frozen at load, so a test or a redeploy can flip it):
//   - exactly "hub" after trimming whitespace -> the two MLS Grid readers this site still runs move to the hub:
//       1. the market-data copy behind the town figures (sync-listings.js hubMarketDataRun, every 15 minutes),
//       2. "is her Lofty listing really on the market?" (sync-listings.js makeOnMarketConfirmer);
//     and this site makes no MLS Grid request at all.
//   - unset, empty, "mlsgrid", or anything else ("Hub", "on", "true") -> today's MLS Grid path, unchanged. A value
//     that is neither "hub" nor "mlsgrid" is logged once, so a typo is visible instead of silently meaning MLS Grid.
//
// NOT WITH LISTINGS_SOURCE=mlsgrid. That mode shows every brokerage's listings on public pages, which need photos
// (the hub has none) and the listing agent for "Listing courtesy of ..." (only with an extra scope). So the
// combination is refused, fail closed: no listing is displayed (lib/_idx-display.js reason "mls_source_hub"),
// the sync makes no MLS Grid request and records why, and /site-health says so.
//
// FAIL CLOSED. Not configured, unreachable, refused, a bad answer, or a copy that is not ready (503 not_ready, or
// copy.ready not true) is treated exactly like an MLS Grid outage today: nothing is written for that page, the run
// records the reason, and nothing is ever read as "not found" or "zero listings".
//
// Key handling: HUB_API_URL must be https; HUB_API_KEY goes in the x-hub-key header only, through the vendored
// toolkit's client (lib/suite-kit/hub.js: redirects refused, never logged). Nothing here prints either value.
"use strict";

const { SELECT_FIELDS, REPLICATED_STATUSES } = require("./_mls-shared");

// One page of the hub's search or deletion list. The hub serves up to 1,000; the page's own call is capped at
// HUB_PAGE_TIMEOUT_MS, the same 9 s ceiling the MLS Grid crawl gives its biggest page (MLS_PAGE_FETCH_TIMEOUT_MS).
const HUB_PAGE_SIZE = 1000;
const HUB_PAGE_TIMEOUT_MS = 9000;
// The confirmer's single-listing question is small; it gets the MLS Grid lookup's 5 s.
const HUB_LOOKUP_TIMEOUT_MS = 5000;
// Every field the MLS Grid crawl selects. A hub row is cut down to exactly these before mapListing() sees it, so a
// stored record has the same fields whichever source wrote it (the hub also sends ListOfficeMlsId, ListOfficeName,
// dates and coordinates -- useful, but not what the copy has ever held).
const RECORD_FIELDS = SELECT_FIELDS.split(",");

// The vendored toolkit (lib/suite-kit, CommonJS build; never edit it -- see its README), loaded on first use so
// a site on today's path never loads it.
let hubKit = null;
function kitHub() {
  if (!hubKit) hubKit = require("./suite-kit/hub");
  return hubKit;
}

let warnedUnknown = false;
// "hub" or "mlsgrid". Only exactly "hub" (trimmed) turns the hub on.
function mlsSource(env, log) {
  const raw = (env || process.env).MLS_SOURCE;
  const v = String(raw == null ? "" : raw).trim();
  if (v === "hub") return "hub";
  if (v !== "" && v !== "mlsgrid" && !warnedUnknown) {
    warnedUnknown = true;
    (log || console.log)('MLS_SOURCE is set to a value other than "hub" or "mlsgrid"; only exactly "hub" ' +
      "switches the MLS reads to the hub, so MLS Grid is used as before.");
  }
  return "mlsgrid";
}

function listingsFromMlsGrid(env) {
  return String((env || process.env).LISTINGS_SOURCE || "").trim().toLowerCase() === "mlsgrid";
}

// True for the refused combination (see the header).
function gridListingsRefused(env) {
  return listingsFromMlsGrid(env) && mlsSource(env) === "hub";
}
const GRID_VIA_HUB_REFUSAL = "MLS_SOURCE=hub cannot serve LISTINGS_SOURCE=mlsgrid: public listing pages need photos " +
  "(the hub has none) and the listing agent for \"Listing courtesy of\", so no listing is shown and nothing is read " +
  "from MLS Grid. Unset MLS_SOURCE to go back to MLS Grid, or set LISTINGS_SOURCE=lofty (or unset it).";

// Why the hub can't be asked, naming the setting and never its value; null when it can.
function hubProblem(env) {
  const e = env || process.env;
  const url = String(e.HUB_API_URL || "").trim();
  const key = String(e.HUB_API_KEY || "").trim();
  if (!url && !key) return "HUB_API_URL and HUB_API_KEY are not set";
  if (!url) return "HUB_API_URL is not set";
  if (!key) return "HUB_API_KEY is not set";
  if (!kitHub().hubConfigured({ baseUrl: url, key })) return "HUB_API_URL must be https and HUB_API_KEY a hub key (hub_ + 64 hex)";
  return null;
}

function makeHubClient(env, timeoutMs) {
  const e = env || process.env;
  return kitHub().createHubClient({
    baseUrl: String(e.HUB_API_URL || "").trim(),
    key: String(e.HUB_API_KEY || "").trim(),
    timeoutMs,
  });
}

// One hub answer -> { ok: true, body } or { ok: false, why, keepPass }. keepPass says whether a replication pass
// that was part-way through may resume from its saved cursor next time (an outage: yes; a 4xx: no, rebuild the
// question from the checkpoint, as the MLS Grid crawl does after a rejection).
function readAnswer(ans, what) {
  const fail = (why, keepPass) => ({ ok: false, why, keepPass });
  if (!ans || typeof ans !== "object") return fail(`no answer from the hub for ${what}`, true);
  if (!ans.ok) {
    const b = ans.body && typeof ans.body === "object" ? ans.body : {};
    if (ans.reason === "not_configured") return fail("the hub is not configured (HUB_API_URL / HUB_API_KEY)", true);
    if (ans.reason === "unreachable") return fail(`the hub did not answer ${what}`, true);
    if (ans.reason === "bad_answer") return fail(`the hub's answer to ${what} was not JSON (HTTP ${ans.status})`, true);
    if (b.status === "not_ready") {
      const r = b.copy && typeof b.copy.reason === "string" ? `: ${b.copy.reason.slice(0, 80)}` : "";
      return fail(`the hub's MLS copy is not ready${r}`, true);
    }
    const said = typeof b.error === "string" ? `: ${b.error.slice(0, 160)}` : "";
    const outage = ans.status === 429 || ans.status >= 500;
    return fail(`the hub refused ${what} (HTTP ${ans.status}${said})`, outage);
  }
  const b = ans.body;
  if (b.status !== "ok") return fail(`the hub's answer to ${what} did not say ok`, true);
  if (!b.copy || b.copy.ready !== true) return fail("the hub's MLS copy is not ready", true);
  return { ok: true, body: b };
}

function nextCursor(b) {
  return b.next === null || b.next === undefined ? null : (typeof b.next === "string" && b.next ? b.next : undefined);
}

// POST /v1/mls/search page -> { ok, rows, next, copy } or a failure. Every row is checked before any is used, so a
// page is applied whole or not at all.
function readSearchPage(ans) {
  const r = readAnswer(ans, "the listing search");
  if (!r.ok) return r;
  const b = r.body;
  const next = nextCursor(b);
  if (!Array.isArray(b.rows) || next === undefined) return { ok: false, why: "the hub's listing page was malformed", keepPass: false };
  for (const row of b.rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        (typeof row.ListingKey !== "string" && typeof row.ListingId !== "string")) {
      return { ok: false, why: "the hub sent a listing row without a ListingKey or ListingId", keepPass: false };
    }
    // Christine's own listings are told apart by the listing agent's name (isHerListing), and the hub sends
    // agent names only to a key with the mls:agents scope. Without it every record would lose its agent and
    // hers would vanish from mine-listings.json -- so the page is refused instead.
    if (!isWithheld(row) && !Object.prototype.hasOwnProperty.call(row, "ListAgentFullName")) {
      return { ok: false, keepPass: true,
        why: "the hub key has no mls:agents scope, so listing agents are missing and Christine's own listings can't be told apart" };
    }
  }
  return { ok: true, rows: b.rows, next, copy: b.copy };
}

// GET /v1/mls/deleted page -> { ok, rows, next, complete } or a failure.
function readDeletedPage(ans) {
  const r = readAnswer(ans, "the deletion list");
  if (!r.ok) return r;
  const b = r.body;
  const next = nextCursor(b);
  if (!Array.isArray(b.rows) || next === undefined || typeof b.complete !== "boolean") {
    return { ok: false, why: "the hub's deletion list was malformed", keepPass: false };
  }
  for (const row of b.rows) {
    if (!row || typeof row !== "object" || typeof row.ListingKey !== "string" || !row.ListingKey) {
      return { ok: false, why: "the hub sent a deletion without a ListingKey", keepPass: false };
    }
  }
  return { ok: true, rows: b.rows, next, complete: b.complete };
}

function isWithheld(row) {
  return !!(row && row._hub && row._hub.withheld === true);
}

// A hub row -> the MLS Grid record mapListing() already understands. A withheld stub (a listing this key may not
// see) becomes exactly what MLS Grid sends for a listing that left the feed: MlgCanView false.
function recordFromHubRow(row) {
  if (isWithheld(row)) {
    return { ListingKey: row.ListingKey, ListingId: row.ListingId, ModificationTimestamp: row.ModificationTimestamp, MlgCanView: false };
  }
  const rec = {};
  for (const f of RECORD_FIELDS) if (row[f] !== undefined) rec[f] = row[f];
  return rec;
}

// The hub matches ListingId with or without the IRE prefix; compare the same way.
function sameListingId(a, b) {
  const n = (v) => String(v == null ? "" : v).trim().toUpperCase().replace(/^IRE/, "");
  return n(a) !== "" && n(a) === n(b);
}

// "Is this listing on the market?" for makeOnMarketConfirmer -- the hub's answer for one ListingId, in the same
// shape as its MLS Grid lookup: { onMarket: true | false | null, status, why }. null = unknown, which keeps the
// listing. Nothing here touches the stored copy.
async function hubOnMarket(client, id) {
  let ans;
  try {
    ans = await client.call("POST", "/v1/mls/search", { listing_ids: [String(id)], limit: 1 });
  } catch (err) {
    return { onMarket: null, why: `the hub check failed: ${err && err.message}` };
  }
  const page = readAnswer(ans, "the listing check");
  if (!page.ok) return { onMarket: null, why: `the hub check failed: ${page.why}` };
  const rows = Array.isArray(page.body.rows) ? page.body.rows : null;
  if (!rows) return { onMarket: null, why: "the hub check failed: the hub's answer was malformed" };
  const rec = rows.find((r) => r && sameListingId(r.ListingId, id));
  if (!rec) {
    if (rows.length) return { onMarket: null, why: "the hub returned a different listing" };
    return { onMarket: false, why: "the hub's MLS copy has no record of it (IRES no longer carries it)", status: "not in the feed" };
  }
  const status = isWithheld(rec) ? "" : String(rec.StandardStatus || "");
  const onMarket = !isWithheld(rec) && rec.MlgCanView !== false && REPLICATED_STATUSES.includes(status);
  return { onMarket, status, why: onMarket ? "" : `the MLS has it as ${status || "not viewable"}` };
}

// ---- Her listings the hub removed (2026-10-24, nothing lost) ------------------------------------------------
// The one place the hub's answer to "is this listing on the market?" was poorer than MLS Grid's. MLS Grid keeps
// sending a listing it hides (Expired, Canceled, Withdrawn, Hold: MlgCanView=false) for about a week, so its
// single-listing lookup answers "off the market" with the real status. The hub deletes such a record at once
// (unless its off-market keep switch is on and the key carries mls:offmarket), so its lookup answers "no record" --
// and for a listing Lofty says was listed in the last 7 days the confirmers' grace rule turns "no record" into
// "unknown", which KEEPS the listing on the site. MLS Grid would have hidden it.
//
// So the hub market-data run (sync-listings.js hubMarketDataRun) remembers each of HER stored listings it removes,
// with the reason, in HUB_REMOVED_MINE_KEY ({ [listingId]: { at, status } }, kept HUB_REMOVED_KEEP_DAYS days, a
// listing forgotten the moment the hub serves it again). In hub mode a confirmer that hears "no record" first asks
// this memory: a listing the hub removed is "off the market", exactly MLS Grid's answer; anything else goes on to
// the grace rule as before. Her listings only, so the blob stays a handful of entries.
const HUB_REMOVED_MINE_KEY = "hub-removed-mine.json";
const HUB_REMOVED_KEEP_DAYS = 30;

// The memory as stored, or {} for nothing / a malformed blob. A failed READ is the caller's to handle (it must
// not then write, or it would replace the memory with only this run's entries).
function removedMemory(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, v] of Object.entries(raw)) {
    if (id && v && typeof v === "object" && typeof v.at === "string") out[id] = { at: v.at, status: String(v.status || "") };
  }
  return out;
}

// Note one removal (true when the memory changed). `status` is why: the MLS status the hub reported, or a phrase.
function noteRemoved(memory, listingId, status, nowMs) {
  if (!memory || !listingId) return false;
  memory[listingId] = { at: new Date(nowMs || Date.now()).toISOString(), status: String(status || "removed by the MLS") };
  return true;
}

// The hub serves it again (back on the market): forget it. True when the memory changed.
function forgetRemoved(memory, listingId) {
  if (!memory || !listingId || !Object.prototype.hasOwnProperty.call(memory, listingId)) return false;
  delete memory[listingId];
  return true;
}

// Drop entries older than the keep window. True when the memory changed.
function pruneRemoved(memory, nowMs) {
  let changed = false;
  const limit = (nowMs || Date.now()) - HUB_REMOVED_KEEP_DAYS * 24 * 3600e3;
  for (const [id, v] of Object.entries(memory || {})) {
    const t = Date.parse((v && v.at) || "");
    if (!Number.isFinite(t) || t < limit) { delete memory[id]; changed = true; }
  }
  return changed;
}

// For a confirmer in hub mode: the hub said "no record of it"; did the hub remove it? Returns MLS Grid's answer
// (off the market, with the status) or null (not remembered: the grace rule decides, as before). Accepts the id
// with or without the IRE prefix, like the hub.
function rememberedRemoval(memory, id) {
  if (!memory) return null;
  const key = Object.keys(memory).find((k) => sameListingId(k, id));
  if (!key) return null;
  const v = memory[key];
  const status = v.status || "removed by the MLS";
  return { onMarket: false, status, why: `the MLS no longer shows it (the hub removed it on ${v.at.slice(0, 10)}: ${status})` };
}

module.exports = {
  mlsSource,
  gridListingsRefused,
  GRID_VIA_HUB_REFUSAL,
  hubProblem,
  makeHubClient,
  readSearchPage,
  readDeletedPage,
  recordFromHubRow,
  isWithheld,
  hubOnMarket,
  HUB_REMOVED_MINE_KEY,
  HUB_REMOVED_KEEP_DAYS,
  removedMemory,
  noteRemoved,
  forgetRemoved,
  pruneRemoved,
  rememberedRemoval,
  HUB_PAGE_SIZE,
  HUB_PAGE_TIMEOUT_MS,
  HUB_LOOKUP_TIMEOUT_MS,
  _resetWarning: () => { warnedUnknown = false; }, // for tests
};
