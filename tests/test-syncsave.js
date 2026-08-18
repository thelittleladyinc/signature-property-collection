// The store cleanup has to survive a failing run.
//
// 2026-08-18. Two correct cleanups shipped and both measured as doing nothing:
// out-of-area listings stayed, `county` stayed null on towns the town table had
// just learned, and the catalogue did not shrink. The code was right; its
// POSITION was wrong.
//
// pruneAndSlimStore only mutates memory. The first save used to sit ~150 lines
// further down, after the own-photo pass, office discovery and the priority pass
// -- four phases that each call MLS Grid. Christine's runs were failing on
// "The operation was aborted due to timeout" with lastRunPagesFetched 0, so that
// window was being lost over and over: every run recomputed the cleanup and every
// run threw it away.
//
// This runs the real handler against a fake blob store with EVERY network call
// failing, which is the case that was silently discarding the work.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// ---- fake blob store -----------------------------------------------------
const blobs = Object.create(null);
const writes = [];      // key order, so "saved before the network" is checkable
let fetchCount = 0;
let firstFetchAfterWrites = null;

const fakeStore = {
  async get(key, opts) {
    const v = blobs[key];
    if (v === undefined) return null;
    return opts && opts.type === "json" ? JSON.parse(v) : v;
  },
  async setJSON(key, value) { writes.push(key); blobs[key] = JSON.stringify(value); },
  async delete(key) { delete blobs[key]; },
  // The real Netlify Blobs list() honors { prefix }. The first version of this
  // fake did not — it handed pruneUsage EVERY key, and pruneUsage (correctly,
  // for usage keys) deleted "listings.json" as lexicographically stale, which
  // emptied the whole catalogue and made five checks fail against a phantom
  // bug. The fake has to be at least as precise as the API it stands in for.
  async list(opts) {
    const prefix = (opts && opts.prefix) || "";
    return { blobs: Object.keys(blobs).filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
  },
};

require.cache[require.resolve("@netlify/blobs")] = {
  id: require.resolve("@netlify/blobs"),
  filename: require.resolve("@netlify/blobs"),
  loaded: true,
  exports: { getStore: () => fakeStore },
};

// Every MLS Grid call fails exactly the way Christine's runs were failing.
global.fetch = async () => {
  if (fetchCount === 0) firstFetchAfterWrites = writes.slice();
  fetchCount += 1;
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  throw err;
};

// ---- seed the store the way production actually looks --------------------
// Already-slim records (no remarks, no photos[]) carrying the two things the
// cleanups target: a dead MLS Grid signed URL, and a county the old town table
// could not infer.
const DEAD = "https://media.mlsgrid.com/token=abc&expires=1&id=x/images/1.jpeg";
const seeded = {
  "IRE1": { listingId: "IRE1", city: "Fort Collins", county: "larimer", photo: DEAD, photoCount: 8 },
  "IRE2": { listingId: "IRE2", city: "Fraser", county: null, photo: DEAD, photoCount: 3 },
  "IRE3": { listingId: "IRE3", city: "Bayfield", county: null, photo: DEAD, photoCount: 5 },
  "IRE4": { listingId: "IRE4", city: "Bennett", county: null, photo: DEAD, photoCount: 2 },
  "IRE5": { listingId: "IRE5", city: "Cherry Hills Village", county: null, photo: DEAD, photoCount: 9 },
  "IRE6": { listingId: "IRE6", city: "Greeley", county: "weld", photoCount: 4,
            photo: "https://res.cloudinary.com/x/image/upload/v1/a.jpg" },
};
blobs["listings.json"] = JSON.stringify(seeded);
blobs["sync-state.json"] = JSON.stringify({ bootstrapped: true, cursor: null, lastModified: null });

process.env.MLSGRID_API_TOKEN = "test-token";
delete process.env.LOFTY_API_KEY;

// ---- run the real handler -------------------------------------------------
(async () => {
  const { handler } = require(path.join(ROOT, "netlify", "functions", "sync-listings.js"));
  let threw = null;
  try { await handler(); } catch (e) { threw = e; }

  check("the handler survives every MLS Grid call timing out", !threw,
    threw && threw.message);
  check("and it really did try to reach MLS Grid (the failure path was exercised)",
    fetchCount > 0, `fetch was called ${fetchCount} times`);

  const stored = JSON.parse(blobs["listings.json"] || "{}");

  // The point of the whole fix: the cleaned store was written BEFORE the first
  // network call, so nothing downstream can lose it.
  check("the cleanup is saved before the first network call",
    Array.isArray(firstFetchAfterWrites) && firstFetchAfterWrites.includes("listings.json"),
    firstFetchAfterWrites
      ? `writes before first fetch: ${JSON.stringify(firstFetchAfterWrites)}`
      : "no fetch was ever made, so the ordering is untested");

  // ---- and the cleanup itself did what the last two commits claimed --------
  check("an out-of-area listing whose county the table has since learned is dropped (Fraser -> grand)",
    !stored.IRE2, "Fraser is two hours over Berthoud Pass; it was showing on the luxury page");
  check("...and Bayfield -> la plata is dropped too", !stored.IRE3);
  check("an IN-area listing stored with county null gets its county back (Bennett -> adams)",
    stored.IRE4 && stored.IRE4.county === "adams",
    stored.IRE4 ? `county=${JSON.stringify(stored.IRE4.county)}` : "listing was dropped, which is worse");
  check("...and Cherry Hills Village -> arapahoe", 
    stored.IRE5 && stored.IRE5.county === "arapahoe",
    stored.IRE5 ? `county=${JSON.stringify(stored.IRE5.county)}` : "listing was dropped");
  check("a listing already carrying a correct county is left alone",
    stored.IRE1 && stored.IRE1.county === "larimer");

  // The 5MB reclaim.
  const withDeadUrl = Object.values(stored)
    .filter((l) => typeof l.photo === "string" && l.photo.indexOf("res.cloudinary.com") === -1);
  check("no dead MLS Grid photo URL survives in the catalogue",
    withDeadUrl.length === 0,
    `${withDeadUrl.length} still stored — these expire within the hour and nothing may serve them`);
  check("but a re-hosted Cloudinary URL IS kept, because it is what gets served",
    stored.IRE6 && stored.IRE6.photo && stored.IRE6.photo.indexOf("res.cloudinary.com") !== -1);
  check("and the photo COUNT survives the slimming",
    stored.IRE1 && stored.IRE1.photoCount === 8,
    "without it every card renders as having no photos");

  // Observability: the run has to be able to say whether the cleanup happened,
  // instead of us inferring it from totalListingsStored not moving.
  const state = JSON.parse(blobs["sync-state.json"] || "{}");
  check("the run reports how much it cleaned, so this is never guessed again",
    typeof state.lastRunStoreSlimmed === "number" && typeof state.lastRunStoreDropped === "number",
    `slimmed=${state.lastRunStoreSlimmed} dropped=${state.lastRunStoreDropped}`);
  check("...and reports the timeout rather than hiding it",
    typeof state.lastRunError === "string" && /timeout|abort/i.test(state.lastRunError),
    `lastRunError=${JSON.stringify(state.lastRunError)}`);

  // The timeout itself: a 50-record page with $expand=Media is the heaviest
  // response this job takes, and it was held to the same 5s ceiling as a
  // single-record lookup.
  const sync = fs.readFileSync(path.join(ROOT, "netlify", "functions", "sync-listings.js"), "utf8");
  const pageTimeout = Number((sync.match(/const MLS_PAGE_FETCH_TIMEOUT_MS = (\d+)/) || [])[1]);
  const smallTimeout = Number((sync.match(/const MLS_FETCH_TIMEOUT_MS = (\d+)/) || [])[1]);
  const budget = Number((sync.match(/const TIME_BUDGET_MS = (\d+)/) || [])[1]);
  check("the paged crawl gets a longer timeout than a single-record lookup",
    pageTimeout > smallTimeout, `page=${pageTimeout} single=${smallTimeout}`);
  check("and the crawl actually uses it",
    /mlsFetch\(requestUrl, token, store, \{\s*\n\s*timeoutMs: MLS_PAGE_FETCH_TIMEOUT_MS,/.test(sync));
  check("worst case still fits inside Netlify's 30s scheduled-function limit",
    budget + pageTimeout <= 30000, `${budget} + ${pageTimeout} = ${budget + pageTimeout}ms`);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
})();
