// IDX display kill switch + freshness guard. ONE place decides whether any
// stored IRES/MLS Grid listing data may be shown to the public.
//
// 2026-09-28. Christine's MLS Grid (IRES) data licence was revoked. Stopping the
// sync (MLS_DISABLED) stops NEW data arriving, but everything already copied into
// Netlify Blobs kept being served: the search, /listing/<id> pages, her map pins,
// the photo proxy, the "recently sold" strip and the area-alert emails. Frozen IDX
// data is still IDX data, and showing it without a licence is the problem, not
// merely showing it late.
//
// So display is now OFF unless IDX_DISPLAY is exactly "on". Default off is the
// point: a missing or mistyped variable must fail closed, never open.
//
// Freshness, for when it is turned back on. IDX rules require displayed data to
// be refreshed at least every 12 hours. `lastSuccessAt` in sync-state.json is
// written by sync-listings.js only when a run finishes with no error AND has
// caught up with MLS Grid (no resume cursor left). lastRunAt is NOT used: it is
// written by failed runs too, so it would call a broken feed "fresh". A state
// blob with no lastSuccessAt (written before this change) counts as stale until
// the first successful sync records one -- at most one sync interval.
//
// Env:
//   IDX_DISPLAY      "on" to show stored listings. Anything else (or unset) = off.
//   IDX_SEARCH_URL   where visitors are sent instead. Default below.
"use strict";

const DEFAULT_SEARCH_URL = "https://www.thelittleladysellshomes.com";
const IDX_MAX_AGE_MS = 12 * 60 * 60 * 1000; // IDX rule: not older than 12 hours
const MESSAGE = "Search homes on my home-search site";

function isIdxDisplayOn(env) {
  const e = env || process.env;
  return String(e.IDX_DISPLAY == null ? "" : e.IDX_DISPLAY).trim().toLowerCase() === "on";
}

// Only an absolute http(s) URL is accepted; anything else (a typo, a
// javascript: URL) falls back to the default rather than reaching a page.
function idxSearchUrl(env) {
  const e = env || process.env;
  const raw = String(e.IDX_SEARCH_URL == null ? "" : e.IDX_SEARCH_URL).trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    } catch (_) { /* fall through */ }
  }
  return DEFAULT_SEARCH_URL;
}

function lastSuccessMs(state) {
  if (!state || !state.lastSuccessAt) return null;
  const t = Date.parse(state.lastSuccessAt);
  return Number.isFinite(t) ? t : null;
}

// The whole decision. `state` is sync-state.json; pass `null` when the caller
// has no state to hand (the result then fails closed on freshness), or pass
// { skipFreshness: true } for the photo proxy, which serves images, not facts.
//
// Returns { allowed: true } or
//         { allowed: false, reason: "disabled"|"no_sync_record"|"stale", ... }
function idxGate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const now = typeof o.now === "number" ? o.now : Date.now();
  const searchUrl = idxSearchUrl(env);
  const deny = (reason, extra) => ({
    allowed: false, reason, message: MESSAGE, searchUrl, ...(extra || {}),
  });
  if (!isIdxDisplayOn(env)) return deny("disabled");
  if (o.skipFreshness) return { allowed: true, searchUrl };
  const last = lastSuccessMs(o.state);
  if (last == null) return deny("no_sync_record");
  const ageMs = now - last;
  if (ageMs > IDX_MAX_AGE_MS) {
    return deny("stale", { lastSuccessAt: new Date(last).toISOString(), ageHours: Math.round(ageMs / 36e5) });
  }
  return { allowed: true, searchUrl, lastSuccessAt: new Date(last).toISOString() };
}

// The JSON a data endpoint returns instead of listings. error stays
// "not_configured" deliberately: every front end already deployed (including the
// TLLSH copy, which proxies here) treats that as a calm "not connected -- contact
// us" message, so even a page that has not been updated degrades gracefully. New
// front ends read idxUnavailable/message/searchUrl and show the link.
function unavailablePayload(gate, extra) {
  return {
    error: "not_configured",
    idxUnavailable: true,
    reason: gate.reason,
    message: gate.message,
    searchUrl: gate.searchUrl,
    listings: [],
    totalCount: 0,
    ...(extra || {}),
  };
}

// Short cache: when display is switched back on, pages recover within minutes.
const UNAVAILABLE_CACHE_CONTROL = "public, max-age=300";

module.exports = {
  DEFAULT_SEARCH_URL, IDX_MAX_AGE_MS, MESSAGE, UNAVAILABLE_CACHE_CONTROL,
  isIdxDisplayOn, idxSearchUrl, idxGate, unavailablePayload, lastSuccessMs,
};
