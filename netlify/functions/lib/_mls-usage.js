// What this site spends at MLS Grid, measured rather than assumed.
//
// 2026-08-18. This exists because of a gap that cost days: on 2026-08-16 and -17
// this codebase chased grey photos through five separate explanations, and the
// one question that would have settled it in ten minutes -- "how many requests
// are we actually making, and when" -- could not be answered at all. NEXT-SESSION
// §2.6 ends in a guess for exactly that reason.
//
// The model is Expired-Luxury's lib/mlsClient.ts, which is the most disciplined of
// Christine's three MLS Grid integrations because it is the one that got the
// ACCOUNT SUSPENDED on 2026-08-01 and had to write a reinstatement plan. It logs
// every call with its byte count, reads that log before issuing another, and
// refuses to go past half of any published limit. Everything below is that idea,
// rebuilt for a serverless runtime that has no shared process memory.
//
// THE REAL LIMITS. Not the published ones -- these come from the suspension email
// MLS Grid sent on 2026-08-01, recorded in Expired-Luxury's MLS_REINSTATEMENT.md:
//
//     1. No more than 7,200 requests in any given hour
//     2. No more than 3,072 MB downloaded in any given hour   <- docs say 4 GB
//     3. No more than 4 requests per second at all times       <- docs say 2
//     4. No more than 40,000 requests in a rolling 24 hours
//     5. No more than 40 GB downloaded in any given 24 hours   <- not in the docs
//
// And the sentence the suspension actually fired on:
//
//     "Your hourly 6.0 requests per second exceeded the 2 requests per second limit."
//
// So both rates are real and they are different things: 4 rps is the instantaneous
// ceiling, 2 rps is the SUSTAINED HOURLY AVERAGE -- which is the same statement as
// limit 1 (7,200/hr is 2/sec for an hour), and it is the one that suspends a token.
//
// WHY THE COUNTS ARE APPROXIMATE, AND WHY THAT IS FINE. Netlify Functions are many
// separate containers, so there is no process to hold a counter and Blobs has no
// atomic increment. Two invocations writing the same hour bucket in the same
// instant can lose one of the two counts. The response is to under-count slightly
// and budget at HALF the real limit, so the error is absorbed many times over. An
// approximate number that exists beats an exact number that does not.
const USAGE_PREFIX = "mls-usage/";

// Keep two days: enough for the 24-hour rolling window plus a margin to look back
// at yesterday when something went wrong overnight.
const RETENTION_HOURS = 48;

// The published ceilings, as above. Env vars may tune these DOWN but never up --
// stolen directly from Expired-Luxury's MLS_GRID_RPS_CEILING, and for the reason
// its comment gives: a well-meant "make it faster" must not be able to cost days
// of downtime.
function tuneDown(envName, ceiling) {
  const raw = Number(process.env[envName]);
  if (!isFinite(raw) || raw <= 0) return ceiling;
  return Math.min(ceiling, raw);
}

const LIMIT_HOUR_REQUESTS = tuneDown("MLS_QUOTA_HOURLY_REQUESTS", 7200);
const LIMIT_HOUR_MB = tuneDown("MLS_QUOTA_HOURLY_MB", 3072);
const LIMIT_DAY_REQUESTS = tuneDown("MLS_QUOTA_DAILY_REQUESTS", 40000);
const LIMIT_DAY_MB = tuneDown("MLS_QUOTA_DAILY_MB", 40960);

// Stop well before the real ceiling. A suspension costs days of grey photos; a
// skipped sync cycle costs thirty minutes of freshness.
const SAFETY_FRACTION = (() => {
  const raw = Number(process.env.MLS_QUOTA_SAFETY_FRACTION);
  if (!isFinite(raw)) return 0.5;
  return Math.min(0.95, Math.max(0.05, raw));
})();

// The kill switch. One env var stops every MLS Grid code path on this site without
// removing the token, so recovering from a suspension does not mean editing
// credentials under pressure. Also the honest answer to "turn it off NOW".
const MLS_DISABLED = /^(1|true|yes|on)$/i.test(String(process.env.MLS_DISABLED || ""));

// Guard reads are memoised briefly: a page of twelve photos is twelve invocations
// that may share a warm container, and none of them needs its own blob read.
const GUARD_CACHE_MS = 30 * 1000;
let _guardCache = null;

function hourKeyFor(date) {
  const d = date || new Date();
  // YYYY-MM-DDTHH, UTC. Sorts lexically, which is what the prune relies on.
  return `${USAGE_PREFIX}${d.toISOString().slice(0, 13)}.json`;
}

// Instrumentation must never be the thing that breaks a request. A Response
// without headers is not something the platform produces, but it IS what a test
// double produces, and a measurement helper that throws on one would have made
// every fake in the suite look like an MLS Grid outage -- which is exactly how it
// announced itself the first time this was wired up.
function bytesFromResponse(res) {
  try {
    const raw = res && res.headers && typeof res.headers.get === "function"
      ? res.headers.get("content-length")
      : null;
    const n = Number(raw);
    return isFinite(n) && n > 0 ? n : 0;
  } catch (err) {
    return 0;
  }
}

function emptyBucket() {
  return { requests: 0, bytes: 0, errors: 0, api: 0, media: 0 };
}

// Records one MLS Grid call. Never throws and never blocks the caller's real work:
// a lost measurement must not cost a photo.
//
// `kind` is "api" (api.mlsgrid.com) or "media" (media.mlsgrid.com) -- the split
// that mattered most and that nobody could see. `bytes` counts toward the MB caps;
// `status` records whether MLS Grid was refusing us at the time.
async function recordMlsCall(store, { kind, status, bytes } = {}) {
  if (!store) return;
  const key = hourKeyFor();
  try {
    const current = (await store.get(key, { type: "json" })) || emptyBucket();
    const next = {
      requests: (current.requests || 0) + 1,
      bytes: (current.bytes || 0) + (Number(bytes) || 0),
      errors: (current.errors || 0) + (status && status >= 400 ? 1 : 0),
      api: (current.api || 0) + (kind === "api" ? 1 : 0),
      media: (current.media || 0) + (kind === "media" ? 1 : 0),
      // Kept so a reader can tell a stalled counter from a quiet hour.
      lastAt: new Date().toISOString(),
    };
    await store.setJSON(key, next);
    // The in-process guard cache would otherwise serve a count from before this
    // call, which is exactly wrong during a burst -- the one time it matters.
    if (_guardCache) {
      _guardCache.usage.hourRequests += 1;
      _guardCache.usage.hourBytes += Number(bytes) || 0;
    }
  } catch (err) {
    console.warn("recordMlsCall failed:", err && err.message);
  }
}

// Adds bytes to this hour WITHOUT counting another request.
//
// 2026-08-18, found on Christine's live health page an hour after deploy: it read
// "2 request(s) and 0 MB this hour ... 3 API + 1 photo". A photo download is never
// zero bytes. MLS Grid gzips its API responses and streams media, so neither sends
// a Content-Length header, and bytesFromResponse() had nothing to read — which
// meant the MB half of the budget could never register and the bandwidth guard was
// inert. Only the request-count half was doing any work.
//
// The bytes are known slightly later, once the caller has actually read the body,
// so they are added in a second step rather than guessed at the header. Splitting
// it this way is what keeps the request count honest: topping up bytes must never
// look like another request.
async function recordMlsBytes(store, bytes) {
  const n = Number(bytes);
  if (!store || !isFinite(n) || n <= 0) return;
  const key = hourKeyFor();
  try {
    const current = (await store.get(key, { type: "json" })) || emptyBucket();
    await store.setJSON(key, { ...current, bytes: (current.bytes || 0) + n });
    if (_guardCache) _guardCache.usage.hourBytes += n;
  } catch (err) {
    console.warn("recordMlsBytes failed:", err && err.message);
  }
}

// Reads the current hour only -- one blob get, which is what a per-request guard
// can afford. The hourly limits are the binding ones anyway: 7,200/hr IS the 2 rps
// sustained average that suspends tokens.
async function readHourUsage(store) {
  const bucket = await store.get(hourKeyFor(), { type: "json" });
  if (!bucket) return { hourRequests: 0, hourBytes: 0, known: true };
  return {
    hourRequests: Number(bucket.requests) || 0,
    hourBytes: Number(bucket.bytes) || 0,
    known: true,
  };
}

// The full picture: this hour and the rolling 24. Costs up to 24 blob gets, so it
// belongs in the sync job and the usage endpoint, not in a photo request.
async function readFullUsage(store) {
  const now = Date.now();
  const keys = [];
  for (let h = 0; h < 24; h += 1) keys.push(hourKeyFor(new Date(now - h * 3600_000)));
  const buckets = await Promise.all(
    keys.map((k) => store.get(k, { type: "json" }).catch(() => null))
  );
  const totals = { dayRequests: 0, dayBytes: 0, dayErrors: 0, dayApi: 0, dayMedia: 0 };
  const hours = [];
  buckets.forEach((b, i) => {
    const bucket = b || emptyBucket();
    totals.dayRequests += Number(bucket.requests) || 0;
    totals.dayBytes += Number(bucket.bytes) || 0;
    totals.dayErrors += Number(bucket.errors) || 0;
    totals.dayApi += Number(bucket.api) || 0;
    totals.dayMedia += Number(bucket.media) || 0;
    hours.push({
      hour: keys[i].slice(USAGE_PREFIX.length, -5),
      requests: Number(bucket.requests) || 0,
      mb: Number(((Number(bucket.bytes) || 0) / 1048576).toFixed(2)),
      api: Number(bucket.api) || 0,
      media: Number(bucket.media) || 0,
      errors: Number(bucket.errors) || 0,
    });
  });
  const first = buckets[0] || emptyBucket();
  return {
    ...totals,
    hourRequests: Number(first.requests) || 0,
    hourBytes: Number(first.bytes) || 0,
    hours,
  };
}

function budgets() {
  return {
    hourRequestBudget: Math.floor(LIMIT_HOUR_REQUESTS * SAFETY_FRACTION),
    hourMBBudget: Math.floor(LIMIT_HOUR_MB * SAFETY_FRACTION),
    dayRequestBudget: Math.floor(LIMIT_DAY_REQUESTS * SAFETY_FRACTION),
    dayMBBudget: Math.floor(LIMIT_DAY_MB * SAFETY_FRACTION),
  };
}

// The gate. Returns { blocked, reason, ... } and is called BEFORE a request is
// issued, which is the difference between this and a cooldown: a cooldown reacts
// to a 429 that has already happened, a budget refuses the request that would
// cause one.
//
// ON FAILING CLOSED. Expired-Luxury's QUOTA-2 note makes the argument better than
// I can: "zero usage is not a neutral default -- it is the most permissive answer
// this function can give", so an unreadable log silently turns the guard into a
// no-op. That reasoning holds here, with one adjustment for a public website: a
// blocked photo still falls back to our own stored copy (listing-photo.js checks
// the photo store BEFORE any of this), so failing closed costs a placeholder on a
// photo nobody has loaded yet, not a blank page. That is a price worth paying to
// avoid a second suspension.
async function checkMlsQuota(store, opts) {
  const full = !!(opts && opts.full);
  const b = budgets();
  const base = {
    ...b,
    limits: {
      hourRequests: LIMIT_HOUR_REQUESTS, hourMB: LIMIT_HOUR_MB,
      dayRequests: LIMIT_DAY_REQUESTS, dayMB: LIMIT_DAY_MB,
    },
    safetyFraction: SAFETY_FRACTION,
    disabled: MLS_DISABLED,
  };

  if (MLS_DISABLED) {
    return { ...base, blocked: true, reason: "MLS_DISABLED kill switch is set", hourRequests: 0, hourMB: 0 };
  }
  if (!store) {
    return { ...base, blocked: false, reason: null, hourRequests: 0, hourMB: 0, usageUnknown: true };
  }

  if (!full && _guardCache && Date.now() - _guardCache.at < GUARD_CACHE_MS) {
    return verdict(base, _guardCache.usage);
  }

  let usage;
  try {
    usage = full ? await readFullUsage(store) : await readHourUsage(store);
  } catch (err) {
    // Cannot prove we are under quota. See the note above.
    return {
      ...base, blocked: true, usageUnknown: true,
      reason: `usage log unreadable (${err && err.message}) — cannot prove we are ` +
        `under quota, so the guard fails closed`,
      hourRequests: 0, hourMB: 0,
    };
  }
  // A full read is a superset of the hourly one, so it primes the memo too --
  // otherwise sync-listings' top-of-run full check would be immediately followed by
  // per-call checks that each re-read the same bucket. Only the hour fields are
  // kept, so what is cached always means the same thing.
  _guardCache = {
    at: Date.now(),
    usage: { hourRequests: usage.hourRequests || 0, hourBytes: usage.hourBytes || 0 },
  };
  return verdict(base, usage);
}

function verdict(base, usage) {
  const hourMB = (usage.hourBytes || 0) / 1048576;
  const dayMB = (usage.dayBytes || 0) / 1048576;
  let reason = null;
  if ((usage.hourRequests || 0) >= base.hourRequestBudget) {
    reason = `${usage.hourRequests} requests this hour (self-imposed budget ` +
      `${base.hourRequestBudget} of MLS Grid's ${base.limits.hourRequests}/hr)`;
  } else if (hourMB >= base.hourMBBudget) {
    reason = `${hourMB.toFixed(0)} MB downloaded this hour (self-imposed budget ` +
      `${base.hourMBBudget} MB of MLS Grid's ${base.limits.hourMB} MB/hr)`;
  } else if (usage.dayRequests != null && usage.dayRequests >= base.dayRequestBudget) {
    reason = `${usage.dayRequests} requests in 24h (self-imposed budget ` +
      `${base.dayRequestBudget} of MLS Grid's ${base.limits.dayRequests}/day)`;
  } else if (usage.dayBytes != null && dayMB >= base.dayMBBudget) {
    reason = `${dayMB.toFixed(0)} MB downloaded in 24h (self-imposed budget ` +
      `${base.dayMBBudget} MB of MLS Grid's ${base.limits.dayMB} MB/day)`;
  }
  return {
    ...base,
    hourRequests: usage.hourRequests || 0,
    hourMB: Number(hourMB.toFixed(2)),
    ...(usage.dayRequests != null ? {
      dayRequests: usage.dayRequests,
      dayMB: Number(dayMB.toFixed(2)),
      dayApi: usage.dayApi, dayMedia: usage.dayMedia, dayErrors: usage.dayErrors,
      hours: usage.hours,
    } : {}),
    blocked: !!reason,
    reason,
  };
}

// Drops buckets older than RETENTION_HOURS. Called from the sync job, which
// already runs on a schedule and already has a time budget to respect.
async function pruneUsage(store) {
  try {
    const cutoff = hourKeyFor(new Date(Date.now() - RETENTION_HOURS * 3600_000));
    const listing = await store.list({ prefix: USAGE_PREFIX });
    const stale = (listing && listing.blobs ? listing.blobs : [])
      .map((b) => b.key)
      .filter((k) => k < cutoff);
    for (const key of stale) await store.delete(key).catch(() => {});
    return stale.length;
  } catch (err) {
    console.warn("pruneUsage failed:", err && err.message);
    return 0;
  }
}

// ---- Per-second pacing ----------------------------------------------------
// 2026-08-18, from the account's own Usage Log after the third suspension:
// the hour that tripped it held only 44 requests — but TEN of them landed in
// the same second (15:16:57), one per concurrent listing-photo lambda, and
// MLS Grid's per-second limit is 2 sustained / 4 burst. Every guard built
// before this one measured VOLUME (hourly, daily); none spaced requests
// within a second, and the browser-side photo pacer only paces one visitor's
// browser — ten simultaneous viewers (or PageSpeed's robots) are ten browsers.
//
// This is a coarse cross-invocation gate on Blobs: at most PACE_PER_SECOND
// starts per wall-clock second, everyone else backs off with jitter and
// retries. Blobs reads race, so it undercounts under heavy concurrency —
// that is fine: collapsing a 10-in-one-second burst to 2-4 spread over a few
// seconds is the difference between a suspension and a quiet log. Cost is
// ~2 blob ops (~100-200ms) per COLD MLS call only; stored photos never pass
// through here.
const PACE_KEY = "mls-pace.json";
const PACE_PER_SECOND = 2;
const PACE_MAX_WAITS = 4;

async function paceMlsCall(store) {
  if (!store) return;
  // De-synchronize first: N lambdas born in the same instant all read the
  // bucket before any of them has written it, and every one of them sees
  // count=0 — the race the first version of this lost completely (10 callers,
  // 10 releases, 1ms). A random 0-900ms delay before the first read spreads
  // the reads out so later callers see earlier callers' writes. Jitter is not
  // a substitute for the bucket — it is what makes the bucket readable.
  await new Promise((r) => setTimeout(r, Math.random() * 1800));
  for (let attempt = 0; attempt <= PACE_MAX_WAITS; attempt++) {
    let bucket = null;
    try { bucket = await store.get(PACE_KEY, { type: "json" }); } catch (err) { bucket = null; }
    const sec = Math.floor(Date.now() / 1000);
    if (!bucket || bucket.sec !== sec) bucket = { sec, count: 0 };
    if (bucket.count < PACE_PER_SECOND) {
      bucket.count += 1;
      try { await store.setJSON(PACE_KEY, bucket); } catch (err) { /* pacing is best-effort */ }
      return;
    }
    // This second is spoken for — wait out the rest of it plus jitter so the
    // herd doesn't re-collide on the next boundary.
    await new Promise((r) => setTimeout(r, 350 + Math.random() * 900));
  }
  // After PACE_MAX_WAITS full waits, proceed anyway: a photo that takes an
  // extra 3s is fine, one that never loads is not.
}

// Tests reach in here rather than waiting 30 seconds for the guard cache.
function _resetGuardCache() { _guardCache = null; }

module.exports = {
  paceMlsCall,
  USAGE_PREFIX,
  bytesFromResponse,
  RETENTION_HOURS,
  MLS_DISABLED,
  SAFETY_FRACTION,
  hourKeyFor,
  recordMlsCall,
  recordMlsBytes,
  readHourUsage,
  readFullUsage,
  checkMlsQuota,
  pruneUsage,
  budgets,
  _resetGuardCache,
};
