// "Recently sold & open houses" strip -- server side.
//
// 2026-09-27. The homepage strip is fed live from Listing Engine's key-guarded
// listing feed (GET /api/feed/listing-events on listing-engine-api). That feed
// needs LISTING_FEED_KEY in an x-listing-engine-key header, and the key must
// NEVER reach a browser -- so the page calls this function, and only this
// function talks to Listing Engine.
//
// What leaves this function is an allow-list, rebuilt field by field: address,
// city, a price with an honest label, beds/baths/sqft, an https photo, an https
// listing link, the event type and open-house times. Nothing is passed through
// wholesale, so a field Listing Engine adds later cannot leak onto the site.
//
// Failure is silent on purpose: an unset key, a slow or sleeping API, a 401, a
// malformed body -- every one of them returns 200 with an empty list, and the
// front end then leaves the strip hidden. A marketing strip must never be the
// reason a page shows an error.
//
// Env:
//   IDX_DISPLAY          must be "on", else always empty (lib/_idx-display.js)
//   LISTING_FEED_KEY     required; unset -> always empty
//   LISTING_ENGINE_URL   optional; default https://listing-engine-api.onrender.com
"use strict";

const { idxGate } = require("./lib/_idx-display");

const DEFAULT_BASE = "https://listing-engine-api.onrender.com";
const TZ = "America/Denver";
const SOLD_WINDOW_DAYS = 60;      // "Just sold" = closed in the last 60 days
const OPEN_HOUSE_AHEAD_DAYS = 14; // "Open house" = today through 14 days out (Denver)
// Open houses are recorded when first seen, which can be weeks before the date,
// so the feed is read further back than the sold window alone would need.
const LOOKBACK_DAYS = 75;
const MAX_ITEMS = 4;
const MAX_PAGES = 5;              // 5 x 100 events is far more than a year of her activity
const FETCH_TIMEOUT_MS = 7000;    // Netlify's function limit is 10s
const CACHE_OK_MS = 10 * 60 * 1000;
const CACHE_EMPTY_MS = 60 * 1000; // a blip should not hide the strip for ten minutes

let cache = null; // { at, ttl, items }

// ---------------------------------------------------------------- helpers --

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Only absolute https URLs are ever returned -- no http (mixed content), no
// javascript:, no protocol-relative tricks.
function httpsUrl(v) {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.toString() : null;
  } catch (e) {
    return null;
  }
}

// Parts of an instant as a Denver wall clock.
const DENVER_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function denverParts(ms) {
  const o = {};
  for (const p of DENVER_PARTS.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}` };
}

// A Denver wall-clock "YYYY-MM-DDTHH:MM" -> the UTC instant it names.
function denverWallToMs(date, time) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall + 7 * 3600 * 1000; // MST; corrected below for MDT
  for (let i = 0; i < 2; i++) {
    const p = denverParts(guess);
    const [py, pmo, pd] = p.date.split("-").map(Number);
    const [ph, pmi] = p.time.split(":").map(Number);
    guess += wall - Date.UTC(py, pmo - 1, pd, ph, pmi);
  }
  return guess;
}

function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Listing Engine's open-house times come in three shapes (see its
 * listing-events/normalize.ts): "2026-10-04T19:00Z" (UTC instant),
 * "2026-10-04T13:00" (Denver wall clock) and "2026-10-04" (date only).
 * Returns { date, time|null } on the Denver clock, or null if unreadable.
 */
function denverSlot(v) {
  const s = str(v);
  if (!s) return null;
  let m = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (m) return { date: m[1], time: null };
  m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (m) return { date: m[1], time: m[2] };
  const t = Date.parse(s); // anything carrying Z or an offset is an instant
  if (!Number.isFinite(t)) return null;
  return denverParts(t);
}

const DAY_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
function dayLabel(date) {
  const [y, m, d] = date.split("-").map(Number);
  return DAY_FMT.format(new Date(Date.UTC(y, m - 1, d)));
}
function timeLabel(time) {
  let [h, mi] = time.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(mi).padStart(2, "0")} ${ampm}`;
}

// ------------------------------------------------------------- shaping ----

function baseCard(listing) {
  const l = listing && typeof listing === "object" ? listing : {};
  const address = str(l.address);
  if (!address) return null;
  return {
    address,
    city: str(l.city),
    beds: num(l.beds),
    baths: num(l.baths),
    sqft: num(l.sqft),
    photo_url: httpsUrl(l.photo_url),
    url: httpsUrl(l.public_url),
  };
}

// Normalised street key for de-duplicating one house seen twice.
function addressKey(c) {
  return `${c.address} ${c.city || ""}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Raw feed events -> at most MAX_ITEMS public-safe cards, open houses first
 * (they are time-sensitive), soonest first; then sales, newest first.
 */
function shapeEvents(events, nowMs) {
  const today = denverParts(nowMs).date;
  const lastDay = addDays(today, OPEN_HOUSE_AHEAD_DAYS);
  const soldCutoff = nowMs - SOLD_WINDOW_DAYS * 86400000;

  const opens = [];
  const sold = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== "object") continue;
    const card = baseCard(e.listing);
    if (!card) continue;
    const listing = e.listing || {};

    if (e.event_type === "open_house_scheduled") {
      const oh = e.open_house && typeof e.open_house === "object" ? e.open_house : {};
      const start = denverSlot(oh.start);
      if (!start || start.date < today || start.date > lastDay) continue;
      let end = denverSlot(oh.end);
      if (end && (end.date !== start.date || !end.time || !start.time || end.time <= start.time)) end = null;
      // Drop one that has already finished today.
      const finish = end ? end.time : start.time;
      if (start.date === today && finish && denverWallToMs(today, finish) <= nowMs) continue;
      const price = num(listing.price);
      opens.push({
        ...card,
        type: "open_house",
        price,
        price_label: price ? "list" : null,
        open_house: {
          date: start.date,
          start: start.time,
          end: end ? end.time : null,
          label: dayLabel(start.date) +
            (start.time ? ` · ${timeLabel(start.time)}${end ? ` – ${timeLabel(end.time)}` : ""}` : ""),
        },
        sort: `${start.date}T${start.time || "00:00"}`,
      });
    } else if (e.event_type === "just_sold") {
      const t = Date.parse(e.occurred_at || e.detected_at || "");
      if (!Number.isFinite(t) || t < soldCutoff || t > nowMs + 86400000) continue;
      // A sale price only when the feed actually carries one. The feed's
      // listing.price is the LIST price, and printing that next to "Sold" would
      // read as the sale price -- so it is labelled as what it is.
      const close = num(e.close_price) || num(listing.close_price);
      const price = close || num(listing.price);
      const d = denverParts(t).date;
      sold.push({
        ...card,
        type: "just_sold",
        price,
        price_label: close ? "sold" : price ? "list" : null,
        sold_on: d,
        sold_label: dayLabel(d).replace(/^\w+, /, ""),
        sort: String(t),
      });
    }
  }

  opens.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  sold.sort((a, b) => Number(b.sort) - Number(a.sort));

  const out = [];
  const seen = new Set();
  for (const c of [...opens, ...sold]) {
    const k = `${c.type}|${addressKey(c)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    delete c.sort;
    out.push(c);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// ---------------------------------------------------------------- fetch ----

async function fetchJson(url, key, signal) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-listing-engine-key": key },
    signal,
  });
  if (!res.ok) throw new Error(`listing feed answered ${res.status}`);
  return res.json();
}

async function loadEvents(env, nowMs) {
  const key = str(env.LISTING_FEED_KEY);
  if (!key) return [];
  let base = str(env.LISTING_ENGINE_URL) || DEFAULT_BASE;
  base = base.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return [];

  const since = new Date(nowMs - LOOKBACK_DAYS * 86400000).toISOString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const events = [];
  try {
    let afterId = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams({ since, types: "just_sold,open_house_scheduled", limit: "100" });
      if (afterId) qs.set("after_id", afterId);
      const body = await fetchJson(`${base}/api/feed/listing-events?${qs}`, key, ctrl.signal);
      if (!body || !Array.isArray(body.events)) break;
      events.push(...body.events);
      if (!body.has_more || !body.next_after_id || body.next_after_id === afterId) break;
      afterId = String(body.next_after_id);
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

function respond(items, maxAge) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Browser keeps it briefly; Netlify's CDN holds it for everyone else.
      "Cache-Control": `public, max-age=${Math.min(maxAge, 300)}`,
      "Netlify-CDN-Cache-Control": `public, s-maxage=${maxAge}, stale-while-revalidate=300`,
      "X-Content-Type-Options": "nosniff",
    },
    body: JSON.stringify({ items }),
  };
}

async function handler(event, context, deps = {}) {
  const now = typeof deps.now === "function" ? deps.now() : Date.now();
  const env = deps.env || process.env;
  // 2026-09-28: these events are MLS-derived listing data (Listing Engine records
  // them from the IRES feed), so they obey the same IDX display kill switch as the
  // search (lib/_idx-display.js). Off -> an empty list, which the front end
  // already treats as "keep the strip hidden". Checked before the memo so a
  // switch-off takes effect immediately, not after a cached list expires.
  if (!idxGate({ env, skipFreshness: true }).allowed) return respond([], 300);
  if (cache && now - cache.at < cache.ttl) {
    return respond(cache.items, Math.round((cache.ttl - (now - cache.at)) / 1000) || 1);
  }
  let items = [];
  try {
    items = shapeEvents(await loadEvents(env, now), now);
  } catch (err) {
    // Log the reason, never the key or the URL's query.
    console.warn("[recent-activity] feed unavailable:", err && err.name === "AbortError" ? "timeout" : err && err.message);
    items = [];
  }
  const ttl = items.length ? CACHE_OK_MS : CACHE_EMPTY_MS;
  cache = { at: now, ttl, items };
  return respond(items, ttl / 1000);
}

exports.handler = (event, context) => handler(event, context);
exports._internals = {
  handler, shapeEvents, denverSlot, denverWallToMs, httpsUrl,
  resetCache: () => { cache = null; },
  MAX_ITEMS, DEFAULT_BASE,
};
