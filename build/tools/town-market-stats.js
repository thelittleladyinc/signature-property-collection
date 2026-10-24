#!/usr/bin/env node
//
// Per-town market statistics for the community pages.
//
// WHY THIS EXISTS (2026-08-16, competitive audit). Searching the queries the
// town pages were just re-aimed at -- "moving to Windsor Colorado", "living in
// Loveland Colorado" -- every page that outranks this site leads with numbers:
//
//   "median list price $672,792 ... 47% of active listings reduced ...
//    92 days on market ... median home value $485,976 ... population 76,739"
//
// Those numbers are why they win the snippet, and increasingly why an AI answer
// engine quotes them instead of us. Our town pages had none, on purpose: the
// copy said "deliberately not a number typed into a page -- an average printed
// today is wrong by spring", which is a correct criticism of how THEY do it.
// Every one of those figures is hand-typed into a blog post and rots quietly.
//
// The answer is not to hand-type our own. It is that this site is the only one
// in that search result with a raw MLS Grid feed wired into its own code rather
// than a vendor IDX widget, and sync-listings.js already replicates the live
// IRES dataset into Netlify Blobs every 15 minutes. So we can compute the same
// statistics from real inventory, regenerate them on a schedule, and bake them
// into the HTML where a crawler can actually read them -- which a client-side
// vendor widget structurally cannot do, no matter how good its data is.
//
// This script reads the ALREADY-REPLICATED copy in Blobs rather than querying
// MLS Grid again. That is deliberate: no extra load on the feed, nothing new to
// rate-limit, and it cannot drift from what the site's own search shows.
//
// COMPLIANCE. IDX rules restrict individual listing content -- addresses,
// photos, specific list prices. Aggregate statistics are what the monthly
// market report already publishes under the same feed (see the _README in
// build/data/market_report.json). This script emits ONLY aggregates, and
// deliberately does NOT emit a min or max price: on a small town the highest
// active price IS one identifiable listing's list price wearing a hat. For the
// same reason a town with fewer than MIN_SAMPLE active listings is skipped
// entirely -- a "median" of two listings is not a statistic, it is a price.
//
// USAGE
//   BLOBS_SITE_ID=... BLOBS_TOKEN=... node build/tools/town-market-stats.js
//   node build/tools/town-market-stats.js --source hub   (HUB_API_URL + HUB_API_KEY;
//                                                         or TOWN_STATS_SOURCE=hub)
//
// THE HUB, OFF UNLESS ASKED FOR (2026-10-24, MLS reads through the hub). With
// `--source hub`, or the setting TOWN_STATS_SOURCE=hub (a repository variable for
// .github/workflows/town-market.yml), the figures are taken from the Seller
// Intelligence hub's GET /v1/market/towns instead of being computed from the
// copy in Netlify Blobs. The hub computes them from its own copy of the IRES feed
// (the one MLS Grid reader for every app) with THIS script's rules -- Active only,
// City trimmed and exact, list price above zero, the same medians, a town under
// MIN_SAMPLE left out -- and answers in exactly this file's shape, so build.py
// needs no change and the main site (thelittleladysellshomes, TOWN_STATS_SOURCE=hub)
// shows the very same numbers. It needs HUB_API_URL and HUB_API_KEY (this site's
// hub key, scope market:read; HUB_APP_KEY is read when HUB_API_KEY is not set),
// sent only as the x-hub-key header. The answer goes through the main site's
// checks (shape, generated_at a real date neither in the future nor past the
// 21-day window nor older than the file here, no town under MIN_SAMPLE, not
// materially fewer towns than the file here). On ANY failure it exits non-zero
// and leaves the committed file exactly as it was, naming settings and never
// their values. Unset or "blobs" is the Blobs path below, unchanged.
//
// Writes build/data/town_market.json. build/build.py READS that file and never
// runs this one: the generator stays offline, deterministic and unable to fail
// because a third-party API had a bad afternoon. If the file is missing or has
// gone stale the town pages fall back to their qualitative copy on their own.

const fs = require("fs");
const path = require("path");

// 2026-09-28: the figures come from the MLS Grid copy of the whole market,
// whatever the site shows. With Lofty as the listing source the site stores only
// Christine's own listings from Lofty, and sync-listings.js keeps replicating
// MLS Grid into these keys in the background precisely so this still has the
// whole market to count (Christine: "use my mls grid for whatever we need to").
const { getBlobStore, BLOB_STORE_NAME, MLSGRID_KEYS } = require("../../netlify/functions/lib/_mls-shared.js");
const { LISTINGS_KEY, SYNC_STATE_KEY } = MLSGRID_KEYS;
// Refuse to publish from a copy that has stopped refreshing: it replicates every
// 30 minutes, so two days without a successful run means something is broken.
const MAX_COPY_AGE_MS = 48 * 60 * 60 * 1000;

// Below this many active listings in a town we publish nothing. See the
// compliance note above -- this is a privacy/IDX floor, not a cosmetic one.
const MIN_SAMPLE = 5;

const OUT_PATH = path.join(__dirname, "..", "data", "town_market.json");

// Whole dollars either way. 2026-10-13 (Town Figures Parity, draft A4): an odd
// count returned the middle price as it was, cents and all, while an even count
// was rounded. Both are rounded now (half up, as an even count already was), so
// the file never carries a figure in cents.
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

// THE SHAPE OF THE LISTINGS BLOB IS AN OBJECT KEYED BY listingId, NOT AN ARRAY.
//
// 2026-08-17: the first real run of this script reported "the replicated
// listings blob is empty" and exited 1, while /status simultaneously said
// 26,445 listings stored and the Loveland town page showed 510 active. Both
// were true. This script was the thing that was wrong: it tested
// Array.isArray(raw), then raw.listings, and LISTINGS_KEY is neither.
// sync-listings.js writes `store.setJSON(LISTINGS_KEY, listingsById)` (see
// saveListingsCheckpoint) — an object of { [listingId]: listing }. Both
// branches missed, it computed over an empty array, and then blamed the feed.
//
// listings-search.js has always read this key correctly as a listingsById
// object, and sync-listings.js itself does Object.values() over it. This
// reader was the only consumer that disagreed with the writer.
//
// Pulled out of main() so tests/test-townmarket.js can exercise it against
// every shape without needing Blobs credentials — including the exact object
// form that used to yield zero. A comment is not a mechanism; a test is.
function listingsFromBlob(raw) {
  if (Array.isArray(raw)) return raw;               // tolerated, not the real shape
  if (raw && typeof raw === "object") return Object.values(raw);  // the real shape
  return [];
}

// The figures themselves, from the stored listings. Pulled out of main() on
// 2026-10-17 (wave 2a) so tests/test-mls-via-hub.js can prove the copy kept
// through the hub gives the same towns, counts and medians as the MLS Grid one.
//
// Active only. "Pending" and "Active Under Contract" are replicated too (see
// REPLICATED_STATUSES) but a pending home is not what someone asking "what do
// homes cost in Severance" is shopping from, and mixing them would quietly
// drag the median toward whatever sold fastest.
function townFigures(listings) {
  const byCity = new Map();
  for (const l of listings) {
    if (!l || l.status !== "Active") continue;
    const city = (l.city || "").trim();
    if (!city || typeof l.price !== "number" || l.price <= 0) continue;
    if (!byCity.has(city)) byCity.set(city, []);
    byCity.get(city).push(l);
  }

  const towns = {};
  let skipped = 0;
  for (const [city, rows] of byCity) {
    if (rows.length < MIN_SAMPLE) {
      skipped += 1;
      continue;
    }
    const prices = rows.map((r) => r.price);
    const ppsf = rows
      .filter((r) => typeof r.sqft === "number" && r.sqft > 200)
      .map((r) => r.price / r.sqft);
    towns[city] = {
      active: rows.length,
      median_list: median(prices),
      median_price_per_sqft: ppsf.length >= MIN_SAMPLE ? Math.round(median(ppsf)) : null,
    };
  }
  return { towns, skipped };
}

// ---- THE HUB SOURCE (off unless asked for; see the header) -------------------
//
// Ported from the main site's build/tools/town-market-stats.js (its hub path,
// 2026-10-06), so both sites take and check the hub's figures the same way. Every
// part takes its inputs as arguments so tests/test-townmarket-hub.js can drive it
// with a fake fetch and a temp file; nothing here runs on require().
const HUB_PATH = "/v1/market/towns";
const HUB_TIMEOUT_MS = 15000;
// Network errors, timeouts and 5xx are tried again; 401, 403 or 404 will not
// change on a retry, so those stop at once.
const HUB_ATTEMPTS = 3;
// The real answer is a few tens of KB. Anything this large is not it.
const HUB_MAX_BYTES = 5 * 1024 * 1024;
// build.py's TOWN_MARKET_STALE_DAYS: figures older than this would be withheld
// on the pages anyway.
const STALE_DAYS = 21;
// A town sitting just above MIN_SAMPLE can drop out between two runs, so the hub
// may list a few fewer towns than the file already here. Losing more than this
// share (never fewer than 2) means a partial answer.
const TOWN_COUNT_TOLERANCE = 0.05;
const TOWN_COUNT_TOLERANCE_MIN = 2;
// How the file says it came from the hub. A path, never the address.
const HUB_COPIED_FROM = "hub:" + HUB_PATH;

// Which source. The flag wins over the setting. Unset, empty or "blobs" is the
// Blobs path; an unknown value is refused rather than guessed at.
function resolveSource(argv, env) {
  let raw;
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a === "--source") {
      raw = i + 1 < args.length ? String(args[i + 1]) : "";
      i += 1;
    } else if (a.startsWith("--source=")) {
      raw = a.slice("--source=".length);
    }
  }
  let from = "--source";
  if (raw === undefined) {
    raw = env && env.TOWN_STATS_SOURCE;
    from = "TOWN_STATS_SOURCE";
  }
  const v = String(raw === undefined || raw === null ? "" : raw).trim().toLowerCase();
  if (v === "" && from === "TOWN_STATS_SOURCE") return { source: "blobs" };
  if (v === "blobs" || v === "hub") return { source: v };
  return { error: `${from} must be "blobs" or "hub"` };
}

class HubError extends Error {}

// This site's hub key: HUB_API_KEY (the name the Netlify functions and the
// workflow use), else HUB_APP_KEY (the main site's name for the same thing).
function hubKeySetting(env) {
  const api = String((env && env.HUB_API_KEY) || "").trim();
  if (api) return { name: "HUB_API_KEY", value: api };
  const app = String((env && env.HUB_APP_KEY) || "").trim();
  if (app) return { name: "HUB_APP_KEY", value: app };
  return null;
}

// Never put an error's own message in the output: a failed connection's message
// carries the address it tried. The class and the system code say enough.
function describeFetchError(err) {
  if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `no answer within ${HUB_TIMEOUT_MS / 1000} seconds`;
  }
  const code = err && ((err.cause && err.cause.code) || err.code);
  return typeof code === "string" && /^[A-Z0-9_]{3,40}$/.test(code)
    ? `the connection failed (${code})`
    : "the connection failed";
}

// The endpoint from HUB_API_URL, or what is wrong with the setting. HTTPS only
// (the key travels in a header), except a loopback address for tests.
function hubEndpoint(rawBase) {
  let u;
  try { u = new URL(rawBase); } catch (e) { throw new HubError("HUB_API_URL is not a valid URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new HubError("HUB_API_URL must start with https://");
  }
  if (u.username || u.password) throw new HubError("HUB_API_URL must not carry a user name or password");
  u.pathname = u.pathname.replace(/\/+$/, "") + HUB_PATH;
  u.search = "";
  u.hash = "";
  return u.toString();
}

async function fetchHub({ env, fetchImpl, sleep }) {
  const base = String((env && env.HUB_API_URL) || "").trim();
  const key = hubKeySetting(env);
  const missing = [];
  if (!base) missing.push("HUB_API_URL");
  if (!key) missing.push("HUB_API_KEY");
  if (missing.length) throw new HubError(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set`);
  const endpoint = hubEndpoint(base);

  let lastReason = "no attempt was made";
  for (let attempt = 1; attempt <= HUB_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(1000 * (attempt - 1));
    let text;
    try {
      const res = await fetchImpl(endpoint, {
        method: "GET",
        headers: { "x-hub-key": key.value, accept: "application/json" },
        // Never follow a redirect: it would carry the key to wherever it points.
        redirect: "manual",
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      });
      if (res.status >= 500) {
        lastReason = `the hub answered HTTP ${res.status}`;
        continue;
      }
      if (res.status !== 200) {
        const hint = res.status === 401 || res.status === 403 ? ` (check ${key.name} and its scope market:read)`
          : res.status === 404 ? " (check HUB_API_URL)" : "";
        throw new HubError(`the hub answered HTTP ${res.status}, expected 200${hint}`);
      }
      text = await res.text();
    } catch (err) {
      if (err instanceof HubError) throw err;
      lastReason = describeFetchError(err);
      continue;
    }
    if (typeof text !== "string" || text.length > HUB_MAX_BYTES) throw new HubError("the hub's answer is too large to be the town figures");
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new HubError("the hub's answer was not JSON");
    }
  }
  throw new HubError(`${lastReason} after ${HUB_ATTEMPTS} attempts`);
}

// The main site's checks (its validatePublished + validateHub). Returns a reason,
// or null when the answer may be written.
function validateHub(pub, current, now) {
  const today = new Date(now || Date.now()).toISOString().slice(0, 10);
  if (!pub || typeof pub !== "object" || Array.isArray(pub)) return "not a JSON object";
  const towns = pub.towns;
  if (Array.isArray(towns)) return "towns is a list, not an object keyed by town";
  if (!towns || typeof towns !== "object" || !Object.keys(towns).length) return "no towns in it";
  const gen = String(pub.generated_at || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gen) || Number.isNaN(Date.parse(gen))) return `generated_at "${gen}" is not a date`;
  if (gen > today) return `generated_at ${gen} is in the future`;
  const ageDays = Math.round((Date.parse(today) - Date.parse(gen)) / 86400000);
  if (ageDays > STALE_DAYS) return `generated_at ${gen} is ${ageDays} days old (limit ${STALE_DAYS})`;
  const mine = current && String(current.generated_at || "");
  if (mine && /^\d{4}-\d{2}-\d{2}$/.test(mine) && gen < mine) return `generated_at ${gen} is older than this repo's ${mine}`;
  if (pub.min_sample !== undefined && !(typeof pub.min_sample === "number" && pub.min_sample >= MIN_SAMPLE)) {
    return `min_sample is below the floor of ${MIN_SAMPLE}`;
  }
  for (const [city, t] of Object.entries(towns)) {
    if (!t || typeof t.active !== "number" || typeof t.median_list !== "number") return `town "${city}" has no figures`;
    if (!Number.isInteger(t.active) || t.active < MIN_SAMPLE) {
      return `town "${city}" has fewer than ${MIN_SAMPLE} active listings`;
    }
    if (!(t.median_list > 0) || !Number.isFinite(t.median_list)) return `town "${city}" has no usable median_list`;
    const ppsf = t.median_price_per_sqft;
    if (ppsf !== undefined && ppsf !== null && !(typeof ppsf === "number" && ppsf > 0 && Number.isFinite(ppsf))) {
      return `town "${city}" has no usable median_price_per_sqft`;
    }
  }
  const have = Object.keys(towns).length;
  const had = current && current.towns && typeof current.towns === "object" ? Object.keys(current.towns).length : 0;
  const allowed = Math.max(TOWN_COUNT_TOLERANCE_MIN, Math.floor(had * TOWN_COUNT_TOLERANCE));
  if (had && have < had - allowed) {
    return `${have} towns, but the file already here has ${had} (at most ${allowed} fewer is tolerated)`;
  }
  return null;
}

const HUB_README = [
  "Per-town ACTIVE-inventory statistics, copied by",
  "build/tools/town-market-stats.js --source hub from the Seller Intelligence",
  "hub's GET /v1/market/towns: the hub computes them from its own copy of the",
  "IRES MLS feed with the same rules as the Blobs path of that script.",
  "",
  "DO NOT HAND-EDIT. Re-run the script instead — the whole point of this",
  "file is that nobody types a market number into this repo by hand.",
  "",
  "build/build.py reads this file and renders the numbers into the town",
  "pages. If it is missing, or older than the staleness window build.py",
  "enforces, the pages silently fall back to qualitative copy rather than",
  "publishing figures that have gone off. That fallback is the safe state:",
  "no number on the page is always better than a wrong one.",
  "",
  "Aggregates only, and towns under " + MIN_SAMPLE + " active listings are omitted —",
  "see the compliance note at the top of the generating script.",
];

// One hub run. Never throws and never exits: it returns { ok, ... } and prints
// through the two sinks, so the caller decides the exit code. The committed file
// is not opened for writing until every check has passed, and the write is a
// rename, so a failure at any point leaves it exactly as it was.
async function runHub(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const outPath = o.outPath || OUT_PATH;
  const fetchImpl = o.fetchImpl || fetch;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = o.log || ((m) => console.log(m));
  const errLog = o.errLog || ((m) => console.error(m));
  // Belt and braces: nothing here prints a key or the address, but if a future
  // edit ever did, it would still not reach the log.
  const secrets = [env.HUB_API_KEY, env.HUB_APP_KEY, env.HUB_API_URL].map((v) => String(v || "").trim()).filter((v) => v.length >= 6);
  const scrub = (m) => secrets.reduce((acc, v) => acc.split(v).join("[hidden]"), String(m));
  const say = (m) => log(scrub(m));
  const refuse = (reason) => {
    errLog(scrub("!! The hub's figures were not used: " + reason + "."));
    errLog("!! Not writing a file — the pages keep their current figures until they expire.");
    return { ok: false, reason: scrub(reason) };
  };

  const keyName = (hubKeySetting(env) || { name: "HUB_API_KEY" }).name;
  say(`TOWN_STATS_SOURCE=hub — taking the town figures from the hub (HUB_API_URL, ${keyName}): GET ${HUB_PATH}`);
  let pub;
  try {
    pub = await fetchHub({ env, fetchImpl, sleep });
  } catch (err) {
    return refuse(err instanceof HubError ? err.message : "unexpected " + ((err && err.name) || "error"));
  }
  let current = null;
  try { current = JSON.parse(fs.readFileSync(outPath, "utf8")); } catch (e) { current = null; }
  const problem = validateHub(pub, current, o.now);
  if (problem) return refuse(problem);

  // The hub answers four keys (generated_at, source, min_sample, towns); the note on
  // how to treat the file says where these figures came from.
  const out = { _README: HUB_README, ...pub, via: "hub", copied_from: HUB_COPIED_FROM };
  const tmp = outPath + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
    fs.renameSync(tmp, outPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { /* nothing to remove */ }
    return refuse("the file could not be written (" + ((err && err.code) || "error") + ")");
  }
  const rel = path.relative(process.cwd(), outPath);
  say(`wrote ${rel}: ${Object.keys(pub.towns).length} towns, generated ${pub.generated_at} by the hub`);
  return { ok: true, towns: Object.keys(pub.towns).length, generated_at: pub.generated_at };
}

async function main() {
  // The Blobs path is everything below this block. Only an explicit request for
  // the hub (--source hub, or TOWN_STATS_SOURCE=hub) goes anywhere else.
  const choice = resolveSource(process.argv.slice(2), process.env);
  if (choice.error) {
    console.error("!! " + choice.error + ". Not writing a file.");
    process.exit(2);
  }
  if (choice.source === "hub") {
    const result = await runHub();
    process.exit(result.ok ? 0 : 1);
  }

  if (!process.env.BLOBS_SITE_ID || !process.env.BLOBS_TOKEN) {
    console.error("!! BLOBS_SITE_ID / BLOBS_TOKEN not set — cannot read the replicated");
    console.error("!! listings. Set both and re-run. Not writing a partial file.");
    process.exit(1);
  }

  const { getStore } = require("@netlify/blobs");
  const store = getBlobStore(getStore, BLOB_STORE_NAME);
  const syncState = await store.get(SYNC_STATE_KEY, { type: "json" }).catch(() => null);
  const lastOk = syncState && syncState.lastSuccessAt ? Date.parse(syncState.lastSuccessAt) : NaN;
  if (!Number.isFinite(lastOk) || Date.now() - lastOk > MAX_COPY_AGE_MS) {
    console.error("!! The MLS Grid copy has no successful refresh in the last 48 hours " +
      `(last: ${syncState && syncState.lastSuccessAt ? syncState.lastSuccessAt : "never"}). ` +
      "Check /status. Not writing a file — stale numbers are worse than none.");
    process.exit(1);
  }
  const raw = await store.get(LISTINGS_KEY, { type: "json" });

  const listings = listingsFromBlob(raw);  // see the note on that function

  if (!listings.length) {
    // Distinguishing these two matters: the first is "the sync has not run",
    // the second is "the sync ran and this reader cannot understand it" —
    // which is the exact failure above, and it must never again be reported
    // as an empty feed.
    if (!raw) {
      console.error("!! No listings blob at " + LISTINGS_KEY + " at all. Has sync-listings.js run?");
    } else {
      console.error("!! The listings blob exists but yielded no records — its shape is not");
      console.error("!! what this script expects (an object keyed by listingId, or an array).");
      console.error("!! Compare against saveListingsCheckpoint() in sync-listings.js.");
    }
    console.error("!! Not writing a file — stale numbers are worse than none.");
    process.exit(1);
  }

  const { towns, skipped } = townFigures(listings);

  const out = {
    _README: [
      "Per-town ACTIVE-inventory statistics, generated by",
      "build/tools/town-market-stats.js from the IRES MLS data that",
      "sync-listings.js already replicates into Netlify Blobs.",
      "",
      "DO NOT HAND-EDIT. Re-run the script instead — the whole point of this",
      "file is that nobody types a market number into this repo by hand.",
      "",
      "build/build.py reads this file and renders the numbers into the town",
      "pages. If it is missing, or older than the staleness window build.py",
      "enforces, the pages silently fall back to qualitative copy rather than",
      "publishing figures that have gone off. That fallback is the safe state:",
      "no number on the page is always better than a wrong one.",
      "",
      "Aggregates only, and towns under " + MIN_SAMPLE + " active listings are omitted —",
      "see the compliance note at the top of the generating script.",
    ],
    generated_at: new Date().toISOString().slice(0, 10),
    source: "IRES MLS",
    min_sample: MIN_SAMPLE,
    towns,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `wrote ${path.relative(process.cwd(), OUT_PATH)}: ` +
      `${Object.keys(towns).length} towns (${skipped} skipped under ${MIN_SAMPLE} active)`
  );
}

// Only run when invoked as a script. `require`-ing this file (which
// tests/test-townmarket.js does, to check listingsFromBlob against every blob
// shape) must not try to reach Netlify Blobs or write build/data.
if (require.main === module) {
  main().catch((err) => {
    console.error("!! town-market-stats failed:", err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  listingsFromBlob, median, townFigures, MIN_SAMPLE,
  // the hub source (2026-10-24)
  resolveSource, validateHub, runHub, fetchHub, hubKeySetting, HubError, HUB_PATH, HUB_ATTEMPTS, HUB_TIMEOUT_MS,
  STALE_DAYS, TOWN_COUNT_TOLERANCE, TOWN_COUNT_TOLERANCE_MIN, HUB_README,
};
