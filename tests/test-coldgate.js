// The cold-listing gate: why a first-ever photo view no longer costs MLS Grid
// anything.
//
// 2026-08-24, from the account's own raw usage log: 552 of 1,000 requests were
// listing-photo.js resolving photos ON DEMAND for listings this site had never
// stored — one MLS Grid call per cold listing, across a 15,471-listing
// catalogue, all first views. Every burst second that tripped a warning was
// four of those from four different IPs. paceMlsCall cannot hold that herd (by
// its own final comment it proceeds unpaced after PACE_MAX_WAITS), so the fix
// is that the visitor path simply does not resolve cold listings any more:
//
//   - listing-photo.js serves a short-TTL placeholder for a listing whose
//     cover isn't in the photo store (unless it's Christine's own), and leaves
//     a photo-demand/ note;
//   - sync-listings.js drains those notes FIRST in its per-run backfill, whose
//     resolves are now batched (one `in` call per 24 listings, not one each);
//   - photo-backfill-background.js walks the whole catalogue overnight so
//     "cold" is a state a listing passes through once, off-peak.
//
// These checks pin the shape of that agreement across the four files, plus the
// prewarm-deadline fix (a 700ms deadline lost the race to paceMlsCall's own
// 0-1800ms jitter, which is why only ~20 of 1,000 logged requests were batched
// resolves).
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

(async () => {
  const photoSrc = fs.readFileSync(path.join(ROOT, "netlify", "functions", "listing-photo.js"), "utf8");
  const mediaSrc = fs.readFileSync(path.join(ROOT, "netlify", "functions", "lib", "_media.js"), "utf8");
  const searchSrc = fs.readFileSync(path.join(ROOT, "netlify", "functions", "listings-search.js"), "utf8");
  const syncSrc = fs.readFileSync(path.join(ROOT, "netlify", "functions", "sync-listings.js"), "utf8");
  const bgPath = path.join(ROOT, "netlify", "functions", "photo-backfill-background.js");

  // ---- listing-photo.js: the gate itself ---------------------------------
  check("resolvePhotoUrl refuses to resolve when allowResolve is false",
    /if \(!allowResolve\)[\s\S]{0,300}cold: !cachedUrl/.test(photoSrc),
    "the cold return must come BEFORE any resolveMediaFor call");
  check("the cold return precedes the live resolve in resolvePhotoUrl",
    photoSrc.indexOf("if (!allowResolve)") !== -1 &&
      photoSrc.indexOf("if (!allowResolve)") < photoSrc.indexOf("await resolveMediaFor([listingId]"),
    "order matters: a cold caller must never reach resolveMediaFor");
  check("warm means: her own listing, or a cover already in the photo store",
    /mine\.has\(listingId\)/.test(photoSrc) && /readCachedPhoto\(store, listingId, 0\)/.test(photoSrc));
  check("a cold request leaves a demand note for the backfill",
    /resolved\.cold/.test(photoSrc) && /recordPhotoDemand\(store, listingId\)/.test(photoSrc));
  check("cold placeholder is short-lived so backfilled photos appear on their own",
    /cold_backfill_pending: 300/.test(photoSrc),
    "PLACEHOLDER_TTL.cold_backfill_pending should be ~300s — long enough not to drip, short enough to heal");
  check("debug mode explains the cold state in plain English",
    /cold_backfill_pending:.*aren't in this site's own store yet/.test(photoSrc));
  check("the cached-URL retry cannot force a resolve on a cold listing",
    /allowResolve && resolved\.fromCache/.test(photoSrc));

  // ---- _media.js: the demand queue ---------------------------------------
  check("_media.js exports the demand queue helpers",
    /recordPhotoDemand/.test(mediaSrc) && /listPhotoDemand/.test(mediaSrc) &&
      /clearPhotoDemand/.test(mediaSrc) && /PHOTO_DEMAND_PREFIX = "photo-demand\/"/.test(mediaSrc));

  // Behavioral: the queue round-trips against a fake store and never throws.
  {
    const media = require(path.join(ROOT, "netlify", "functions", "lib", "_media.js"));
    const blobs = new Map();
    const fake = {
      setJSON: async (k, v) => { blobs.set(k, v); },
      get: async (k) => blobs.get(k) || null,
      delete: async (k) => { blobs.delete(k); },
      list: async ({ prefix }) => ({
        blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      }),
    };
    await media.recordPhotoDemand(fake, "IRE123");
    await media.recordPhotoDemand(fake, "IRE456");
    const ids = await media.listPhotoDemand(fake, 10);
    check("demand notes round-trip through the store",
      ids.length === 2 && ids.includes("IRE123") && ids.includes("IRE456"), JSON.stringify(ids));
    await media.clearPhotoDemand(fake, "IRE123");
    const after = await media.listPhotoDemand(fake, 10);
    check("a cleared demand note stays cleared", after.length === 1 && after[0] === "IRE456");
    const broken = { setJSON: async () => { throw new Error("boom"); }, list: async () => { throw new Error("boom"); }, delete: async () => { throw new Error("boom"); } };
    let threw = false;
    try {
      await media.recordPhotoDemand(broken, "IRE1");
      await media.listPhotoDemand(broken, 5);
      await media.clearPhotoDemand(broken, "IRE1");
    } catch (e) { threw = true; }
    check("demand helpers are best-effort — a broken store never throws", !threw);
  }

  // ---- listings-search.js: the prewarm actually runs now ------------------
  {
    const m = searchSrc.match(/PREWARM_DEADLINE_MS = (\d+)/);
    check("prewarm deadline clears paceMlsCall's 0-1800ms jitter",
      m && Number(m[1]) >= 2000,
      `found ${m && m[1]}ms — anything under the jitter ceiling loses the race to its own pacer`);
    check("prewarm resolve keeps its own full fetch timeout",
      !/timeoutMs: PREWARM_DEADLINE_MS/.test(searchSrc),
      "aborting the fetch at the deadline spends an MLS request and caches nothing");
  }

  // ---- sync-listings.js: demand first, batched resolves, overnight kick ---
  check("the per-run backfill drains demand notes before the price walk",
    /listPhotoDemand\(store, BACKFILL_PER_RUN\)/.test(syncSrc));
  check("the backfill resolves in one batched call, not one per listing",
    /resolveMediaFor\(needResolve, \{/.test(syncSrc));
  check("the sync kicks the overnight background walk",
    /photo-backfill-background/.test(syncSrc) && /OVERNIGHT_UTC_HOURS/.test(syncSrc));

  // ---- photo-backfill-background.js: the catalogue walk -------------------
  check("the background walker exists", fs.existsSync(bgPath));
  if (fs.existsSync(bgPath)) {
    const bgSrc = fs.readFileSync(bgPath, "utf8");
    check("walker refuses to run outside the overnight window",
      /OVERNIGHT_UTC_HOURS\.includes\(new Date\(\)\.getUTCHours\(\)\)/.test(bgSrc));
    const syncHours = (syncSrc.match(/OVERNIGHT_UTC_HOURS = \[([\d, ]+)\]/) || [])[1];
    const bgHours = (bgSrc.match(/OVERNIGHT_UTC_HOURS = \[([\d, ]+)\]/) || [])[1];
    check("kicker and walker agree on the overnight hours",
      !!syncHours && syncHours === bgHours, `sync: [${syncHours}] vs walker: [${bgHours}]`);
    check("walker holds a lock so overlapping kicks collapse to one worker",
      /LOCK_KEY/.test(bgSrc) && /another run holds the lock/.test(bgSrc));
    check("walker has a hard per-run request cap",
      /MAX_REQUESTS_PER_RUN/.test(bgSrc) && /request cap reached/.test(bgSrc));
    check("walker checks the quota guard per batch",
      /checkMlsQuota\(store\)/.test(bgSrc));
    check("walker stops for the night on a media-host 429",
      /429/.test(bgSrc) && /stopping for the night/.test(bgSrc));
    check("walker batches resolves at the documented in-filter ceiling",
      /RESOLVE_BATCH = 24/.test(bgSrc),
      "resolveMediaFor caps at MAX_IDS_PER_BATCH (24); a bigger batch silently truncates");
    check("walker downloads go through the shared paced media fetch",
      /fetchMediaResponse\(/.test(bgSrc),
      "fetchMediaResponse carries paceMlsCall and the usage log — raw fetch would be invisible");
  }

  console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
