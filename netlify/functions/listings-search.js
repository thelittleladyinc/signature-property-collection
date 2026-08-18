// Server-side search over Christine's replicated IRES listing data, backed
// by Netlify Blobs — NOT a live proxy to MLS Grid anymore (see the
// 2026-08-12 note below for why). This keeps the MLS Grid access token
// secret (it never reaches the browser, and this function doesn't even use
// it — only sync-listings.js does) and enforces the IDX compliance rules
// that must be applied no matter what a client sends in the query string:
//   - Only IRES-sourced listings are ever returned, and only in an
//     on-market status (Active only for the general public search; Active +
//     Active Under Contract + Pending for Christine's own mine=true listing
//     showcase) — no sold/closed data, no other MLS's listings. This is
//     enforced twice over: sync-listings.js never even replicates
//     sold/closed data in the first place, and matchesQuery() re-checks
//     status here too.
//   - Only public-safe fields are requested (see SELECT_FIELDS in
//     _mls-shared.js) — nothing from MLS Grid's IDX Rules 21/31 prohibited
//     list (showing instructions, security info, seller/occupant contact).
//
// Full compliance rules this page (and the disclaimer block rendered with
// it in search-homes.html) is built against:
//   https://www.mlsgrid.com/s/MLS-Grid-IDX-Rules.pdf
//
// *** 2026-08-12: WHY THIS FUNCTION NO LONGER QUERIES MLS GRID DIRECTLY ***
// The live search was failing in production with every single query,
// confirmed via a real MLS Grid response:
//   {"error":{"code":400,"message":"Invalid filter field 'ListPrice'",
//   "details":[{"message":"Replication requests to the Property resource
//   can only be filtered using the following fields: MlgCanView,
//   ModificationTimestamp, OriginatingSystemName, StandardStatus,
//   ListingId, PropertyType, ListOfficeMlsId"}]}}
// MLS Grid's Property resource simply does not allow filtering by
// ListPrice, City, BedroomsTotal, etc. — the site's entire "live filtered
// search" design was built on a request shape MLS Grid rejects outright.
// Their own Best Practices Guide describes the only pattern that actually
// works: replicate the allowed dataset into your own storage on a
// schedule, then filter your own copy. sync-listings.js is that
// replication job (runs every 15 minutes via netlify.toml's scheduled
// function config); this function just reads what it wrote and filters in
// JS — see matchesQuery() in _mls-shared.js, which mirrors the exact same
// filtering logic (city/price/beds/baths/subdivision/waterfront/mine) the
// old OData $filter builder used to send to MLS Grid.
//
// Setup required (one-time, Netlify dashboard -> Site settings ->
// Environment variables): MLSGRID_API_TOKEN (used only by sync-listings.js
// now, not this function).
const { getStore } = require("@netlify/blobs");
const {
  LISTINGS_KEY, SYNC_STATE_KEY, MINE_LISTINGS_KEY, matchesQuery, getBlobStore,
  BASE_URL, SELECT_FIELDS,
} = require("./lib/_mls-shared");
const { prewarmPhotoUrls } = require("./lib/_media");

// ---- THE CATALOGUE, PARSED ONCE PER CONTAINER ---------------------------
// 2026-08-18 (Christine: "it just runs so slow ... what if we just brought in a
// few counties"). Her instinct was right and the mechanism was worse than she
// thought. Every public search did this, per request:
//
//   store.get(LISTINGS_KEY, { type: "json" })   // download the WHOLE catalogue
//   Object.values(...).filter(...).sort(...)    // then walk all of it
//
// That is 29,011 listings downloaded and JSON-parsed to return twelve cards, on
// every single search, every time. The work scales with the catalogue and has
// nothing to do with what was asked for — which is exactly why it got slower as
// the crawl grew, and why it felt like "bringing in too many".
//
// Netlify keeps a container warm between requests, so the parse can be done once
// and reused. The memo is invalidated by the SYNC's own clock rather than by a
// timer alone: sync-state.json carries lastRunAt, it is a tiny read, and it
// changes exactly when the data changes. The TTL is a backstop for the case
// where the state blob is unreadable.
//
// mine=true traffic never took this path (it reads the small MINE_LISTINGS_KEY
// copy), which is why her own listings always felt fast and the public search
// did not.
const CATALOGUE_MEMO_MS = 60 * 1000;
let _catalogue = null; // { byId, stamp, at }

function catalogueFromMemo(stamp) {
  if (!_catalogue) return null;
  if (Date.now() - _catalogue.at > CATALOGUE_MEMO_MS) return null;
  // A sync that has written new data since we parsed makes the memo wrong, not
  // merely old. Compared as strings because that is what the state blob holds.
  if (stamp && _catalogue.stamp && stamp !== _catalogue.stamp) return null;
  return _catalogue.byId;
}

function rememberCatalogue(byId, stamp) {
  _catalogue = { byId, stamp: stamp || null, at: Date.now() };
}

// Exported for tests: a memo nobody can reset is a memo nobody can test.
exports.__test = {
  catalogueFromMemo, rememberCatalogue,
  reset: () => { _catalogue = null; },
  memoTtlMs: CATALOGUE_MEMO_MS,
};

// ---- Photo URLs the browser can actually load ----------------------------
// 2026-08-15 (Christine: "still no photos", with a screenshot of a Search
// Homes page where every card's image was broken). A stored MLS Grid media URL
// is signed and expires in ~1-2 hours, so for any listing the sync hasn't
// re-touched recently -- which, at 15,471 stored listings and a 5-per-run
// refresh sweep, is nearly all of them -- the URL in storage is dead on
// arrival. Never send one to a browser again.
//
// Cloudinary URLs are the exception and the preference: those are already
// re-hosted permanently (Christine's own listings, see
// cacheCoverPhotoIfHers() in sync-listings.js) and cost nothing to serve, so
// they go straight through. Everything else is served by listing-photo.js from
// this site's own domain.
function isRehosted(url) {
  return typeof url === "string" && url.indexOf("res.cloudinary.com") !== -1;
}

// How many photos this listing is believed to have. ONE definition, used by the
// gallery count, the card's "View All N Photos" label AND the decision to emit a
// cover-photo URL — because those disagreeing is what broke the cards.
//
// 2026-08-17 (Christine: "still no photos - they worked awhile back"). She was right
// on both counts, and the cause was a contradiction inside a single commit from
// 2026-08-15. That commit wrote, for the COUNT: "The stored photoCount has to win
// when photos[] is absent." It then guarded the URL on `listing.photo` and
// `listing.photos` only, ignoring photoCount. So for a listing whose stored photo
// URLs had expired and been dropped but whose photoCount survived, the card
// simultaneously believed there were 50 photos and refused to ask for photo 0.
//
// The visible result was a grey box next to the words "View All 50 Photos", and the
// giveaway was in her own DevTools: NO REQUEST for the photo at all. Not a failed
// one — none. Every rate limit, cooldown and placeholder we chased for hours was
// real and was happening to a request the page never made. I dismissed that empty
// Network tab as "DevTools opened after load"; it was the actual evidence.
//
// The guard's intent was sound — don't emit a URL that can only render a
// placeholder — but it tested the wrong thing. listing-photo.js resolves fresh
// signed URLs from MLS Grid by LISTING ID (resolvePhotoUrls) and needs no stored
// URL whatsoever, which her own debug output proved while the card sat grey:
// urlCount: 50 for the very listing that was showing nothing.
function knownPhotoCount(listing) {
  if (Array.isArray(listing.photos) && listing.photos.length) return listing.photos.length;
  if (typeof listing.photoCount === "number") return listing.photoCount;
  return listing.photo ? 1 : 0;
}

function photoUrlFor(listing, index) {
  const i = index || 0;
  const rehosted = Array.isArray(listing.cloudinaryPhotos) ? listing.cloudinaryPhotos[i] : null;
  if (isRehosted(rehosted)) return rehosted;
  if (i === 0 && isRehosted(listing.cloudinaryPhoto)) return listing.cloudinaryPhoto;
  const stored = i === 0
    ? listing.photo
    : (Array.isArray(listing.photos) ? listing.photos[i] : null);
  if (isRehosted(stored)) return stored;
  if (!listing.listingId) return null;
  // Genuinely no photos? Don't send a URL that can only render a placeholder.
  // Asked of the SAME count the card displays, so the two can never contradict
  // each other again.
  if (i >= knownPhotoCount(listing)) return null;
  return `/.netlify/functions/listing-photo?id=${encodeURIComponent(listing.listingId)}&i=${i}`;
}

function galleryUrlsFor(listing) {
  const count = knownPhotoCount(listing);
  const urls = [];
  for (let i = 0; i < count; i += 1) {
    const url = photoUrlFor(listing, i);
    if (url) urls.push(url);
  }
  return urls;
}

// ---- WHERE THE TIME ACTUALLY GOES ---------------------------------------
// 2026-08-18 (Christine: "how can we test what to do to make the mls stuff load
// faster? Sites being slow loses people"). She is right, and until now every
// answer to it — including mine — has been a theory. Server-Timing turns it into
// a measurement: Chrome shows these phases natively in DevTools → Network → click
// the request → Timing, with no tooling to install and nothing to interpret.
//
// The phases are chosen to separate the candidate causes, because "the search is
// slow" has at least four different fixes depending on which of these dominates:
//   state     - reading sync-state.json (tiny; should be single-digit ms)
//   catalogue - fetching and parsing ~29,000 listings, or reusing the memo
//   filter    - matchesQuery + sort over all of them
//   prewarm   - resolving photo URLs at MLS Grid before responding
function timer() {
  const marks = [];
  let last = Date.now();
  const started = last;
  return {
    mark(name, desc) {
      const now = Date.now();
      marks.push({ name, dur: now - last, desc });
      last = now;
    },
    header() {
      const total = Date.now() - started;
      return marks
        .concat([{ name: "total", dur: total }])
        .map((m) => `${m.name};dur=${m.dur}` + (m.desc ? `;desc="${m.desc}"` : ""))
        .join(", ");
    },
    summary() {
      const total = Date.now() - started;
      const out = {};
      marks.forEach((m) => { out[m.name] = m.desc ? `${m.dur}ms (${m.desc})` : `${m.dur}ms`; });
      out.total = `${total}ms`;
      return out;
    },
  };
}

exports.handler = async (event) => {
  const timing = timer();
  const store = getBlobStore(getStore);
  const params = event.queryStringParameters || {};
  const top = Math.min(parseInt(params.top, 10) || 12, 24);
  const skip = Math.max(parseInt(params.skip, 10) || 0, 0);
  const mine = params.mine === "true";

  try {
    // 2026-08-13 (performance fix): mine=true is the overwhelming majority
    // of traffic to this function — it's what 97+ pages across the site
    // (blog posts, city pages, the homepage spotlight, current-listings.html)
    // use for their "one of Christine's listings" widgets. Reading the small
    // MINE_LISTINGS_KEY copy instead of the full regional dataset (tens of
    // thousands of records) turns those into a near-instant lookup instead
    // of a full-dataset parse+scan on every single page load. Falls back to
    // the full dataset if the small copy hasn't been computed yet (e.g.
    // right after this deploy, before sync-listings.js's first run since
    // the update) so nothing breaks during rollout.
    let allListings;
    if (mine) {
      const mineOnly = await store.get(MINE_LISTINGS_KEY, { type: "json" });
      if (mineOnly) {
        allListings = Object.fromEntries(
          mineOnly.filter((l) => l && l.listingId).map((l) => [l.listingId, l]),
        );
      }
    }
    // The state blob first and on its own: it is small, and it decides whether the
    // catalogue needs reading at all.
    const state = await store.get(SYNC_STATE_KEY, { type: "json" });
    timing.mark("state");
    if (!allListings) {
      const stamp = state && state.lastRunAt ? String(state.lastRunAt) : null;
      const memo = catalogueFromMemo(stamp);
      if (memo) {
        allListings = memo;
        timing.mark("catalogue", "memo");
      } else {
        allListings = await store.get(LISTINGS_KEY, { type: "json" });
        if (allListings) rememberCatalogue(allListings, stamp);
        timing.mark("catalogue", "blob read + parse");
      }
    } else {
      timing.mark("catalogue", "mine-only copy");
    }

    if (!state) {
      // sync-listings.js hasn't completed a single run yet (e.g. right
      // after first deploy, before its first scheduled 15-minute tick, or
      // MLSGRID_API_TOKEN isn't set in Netlify yet) — distinct from a
      // real search returning zero matches, so the UI can say something
      // more accurate than "no homes match your filters."
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "not_configured", listings: [], totalCount: 0 }),
      };
    }

    const listingsById = allListings || {};

    // 2026-08-13 (performance fix): a card only ever shows the cover photo,
    // but every listing was shipping its ENTIRE photos[] array (up to ~50
    // signed MLS Grid URLs) on every list request — dead weight on every
    // single page load. listingId is the on-demand counterpart: when the
    // "View All N Photos" lightbox is actually opened, the browser fetches
    // just that one listing's full gallery via this param instead of it
    // having been in the payload all along. Only ever hit for one of
    // Christine's own listings today (the gallery button only appears on
    // current-listings.html's mine=true cards), so this stays a tiny,
    // cheap lookup even though it's written generically.
    if (params.listingId) {
      const listing = listingsById[params.listingId];
      if (!listing) {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "not_found", photos: [] }),
        };
      }
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          // Same reasoning as the main search response below: this returns a
          // gallery's photo URLs, which are either stable /listing-photo paths or
          // permanent Cloudinary ones, against data that changes every 30 minutes.
          "Cache-Control": "public, max-age=300, stale-while-revalidate=1800",
        },
        // 2026-08-15: the gallery used to hand the browser stored MLS Grid
        // URLs, which are expired for anything the sync hasn't touched in the
        // last hour or two. Now every photo goes through our own domain -- see
        // photoUrlFor() and listing-photo.js. One MLS Grid call resolves the
        // whole gallery, so a 30-photo lightbox is one request, not thirty.
        body: JSON.stringify({ photos: galleryUrlsFor(listing) }),
      };
    }

    // 2026-08-13 (Christine's request): on her own mine=true showcase, a
    // listing going under contract is a good thing to lead with (it shows
    // momentum), not something to bury — she wants it to keep appearing in
    // the same feed (not split into a separate section, which is already
    // how this worked) but sorted to the front, ahead of her still-active
    // listings. Only affects mine=true: the general public search
    // (PUBLIC_STATUSES = ["Active"] in _mls-shared.js) never contains a
    // non-Active status in the first place, so this is a no-op there.
    const isUnderContractOrPending = (l) => {
      const s = String(l.status || "").toLowerCase();
      return s.indexOf("contract") !== -1 || s.indexOf("pending") !== -1;
    };
    // 2026-08-15 (Christine: "No sort control. Results are always
    // most-expensive-first"). That default is why an $81.6M ranch was the first
    // thing on her public search page. Four orderings, and the labels in the UI
    // say exactly what each one sorts by:
    //
    // "recent" uses modificationTimestamp, which is honestly labelled
    // "Recently updated" rather than "Newest" -- it moves when a price changes
    // or a status flips, not only when a listing first appears. A true
    // on-market date would mean adding OnMarketDate/ListingContractDate to
    // $select, and this feed has a documented history of 400ing standard RESO
    // field names, which would break the whole crawl. Worth probing separately
    // in an isolated try/catch; not worth risking the sync for a sort option.
    const SORTS = {
      "price-desc": (a, b) => (b.price || 0) - (a.price || 0),
      "price-asc": (a, b) => (a.price || Infinity) - (b.price || Infinity),
      "sqft-desc": (a, b) => (b.sqft || 0) - (a.sqft || 0),
      "recent": (a, b) =>
        String(b.modificationTimestamp || "").localeCompare(String(a.modificationTimestamp || "")),
    };
    const sortFn = SORTS[params.sort] || SORTS["price-desc"];
    // 2026-08-18 (persona test at the $2.3M tier): the same property showed
    // twice — "9126 Gold Mine Rd" and "9126 Goldmine Rd", and two identical
    // "4163 Rainbow View Ln" entries — because a relist or co-list gives one
    // house two IRES numbers, and the store keeps both faithfully. Correct
    // data, sloppy shelf. Deduped here at serve time by normalized
    // address+city (spaces and punctuation stripped, so the Gold Mine /
    // Goldmine spelling variants collide on purpose); listings without a
    // street address (bare land) can't be safely matched and are never
    // deduped. When two collide, the one that survives is Active over
    // under-contract, then the higher MLS number (the newer listing).
    const dedupeListings = (list) => {
      const byKey = new Map();
      const keyless = [];
      for (const l of list) {
        const addr = String(l.address || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!addr) { keyless.push(l); continue; }
        const key = addr + "|" + String(l.city || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const prev = byKey.get(key);
        if (!prev) { byKey.set(key, l); continue; }
        const rank = (x) => (String(x.status || "").toLowerCase() === "active" ? 1 : 0);
        const better =
          rank(l) !== rank(prev) ? (rank(l) > rank(prev) ? l : prev)
          : (String(l.listingId || "") > String(prev.listingId || "") ? l : prev);
        byKey.set(key, better);
      }
      return [...byKey.values(), ...keyless];
    };
    const matched = dedupeListings(Object.values(listingsById)
      .filter((l) => matchesQuery(l, params)))
      .sort((a, b) => {
        if (mine) {
          const aFirst = isUnderContractOrPending(a) ? 1 : 0;
          const bFirst = isUnderContractOrPending(b) ? 1 : 0;
          if (aFirst !== bFirst) return bFirst - aFirst;
        }
        return sortFn(a, b);
      });

    timing.mark("filter", `${Object.keys(listingsById).length} listing(s) scanned`);

    const page = matched.slice(skip, skip + top).map((l) => {
      // Strip internal-only fields before they reach the browser. photos[]
      // is trimmed to just the cover photo here — see the listingId block
      // above for how the full gallery is fetched, only when needed.
      const {
        listingKey, modificationTimestamp, mlgCanView, photos,
        cloudinaryPhotos, cloudinaryPhoto, ...publicFields
      } = l;
      return {
        ...publicFields,
        // Always a URL this browser can load: a Cloudinary copy where one
        // exists, otherwise our own /listing-photo endpoint. The raw signed
        // MLS Grid URL never leaves the server now.
        photo: photoUrlFor(l, 0),
        // The stored photoCount has to win when photos[] is absent. It usually
        // IS absent: slimForStorage() drops photos[] for every listing that
        // isn't Christine's and records the count instead. Recomputing from
        // l.photo alone reported "1 photo" for a listing with 40 -- which the
        // gallery button reads, so it silently hid most photos on most cards.
        //
        // 2026-08-17: this now goes through knownPhotoCount(), the SAME function
        // photoUrlFor() asks before deciding whether to emit a cover URL. Having
        // two copies of this rule is what broke her cards: this one trusted
        // photoCount and the URL guard did not, so a card could say "View All 50
        // Photos" beside a grey square and never request photo 0 at all.
        photoCount: knownPhotoCount(Array.isArray(photos) ? { ...l, photos } : l),
      };
    });

    // 2026-08-15 (Christine: "why some photos in and some are not?"). Resolve
    // this page's photo URLs in ONE MLS Grid call before responding, so the 12
    // image requests the browser is about to fire are cache hits instead of 12
    // separate API calls racing each other into MLS Grid's rate limit. Awaited
    // deliberately -- doing it after the response isn't reliable in a Netlify
    // function -- but bounded, best-effort, and skipped entirely when the cache
    // is already warm, so search results are never held up for long and a
    // failure here costs a placeholder, not a broken page.
    // 2026-08-18, measured on Christine's own luxury search rather than guessed:
    //
    //   state;dur=366, catalogue;dur=1768, filter;dur=122, prewarm;dur=2482,
    //   total;dur=4738
    //
    // The prewarm was the single largest cost on the page — 2.5 of 4.7 seconds
    // spent holding the entire response back while MLS Grid resolved photo URLs
    // nobody had asked for yet. Filtering all 29,150 listings, which I had assumed
    // was the expensive part, took 122ms.
    //
    // The prewarm still earns its place: without it a page of cold listings fires
    // a dozen separate resolves at an API limited to two requests a second. But it
    // is an OPTIMISATION, and an optimisation must never cost more than it saves.
    // It now runs against a hard deadline: whatever has resolved by then is
    // cached and helps, and the response goes out regardless. Anything unresolved
    // simply resolves later, on demand, in listing-photo.js — which is the exact
    // path that already handles a direct hit or a shared link.
    //
    // Deliberately NOT fire-and-forget: a Netlify container can freeze the moment
    // it returns, so work nobody waits for is work that only sometimes happens.
    // Waiting a bounded amount is honest; waiting indefinitely was not.
    const PREWARM_DEADLINE_MS = 700;
    let prewarmOutcome = "completed";
    await Promise.race([
      prewarmPhotoUrls(page, {
        store,
        token: process.env.MLSGRID_API_TOKEN,
        baseUrl: BASE_URL,
        selectFields: SELECT_FIELDS,
        timeoutMs: PREWARM_DEADLINE_MS,
      }),
      new Promise((resolve) => setTimeout(() => {
        prewarmOutcome = `gave up after ${PREWARM_DEADLINE_MS}ms — photos resolve on demand`;
        resolve();
      }, PREWARM_DEADLINE_MS)),
    ]);

    timing.mark("prewarm", prewarmOutcome);

    const response = {
      listings: page,
      totalCount: matched.length,
      fetchedAt: state.lastRunAt || null,
    };
    if (params.debug === "true") {
      // Opt-in only (?debug=true) so this never shows up in a normal buyer's
      // network tab — added 2026-08-12 while confirming the very first
      // sync-listings.js runs are actually finding/storing listings, since
      // there's no other way to see sync-state.json from outside Netlify's
      // dashboard. Nothing secret in here — no tokens, no raw MLS data.
      response.debug = {
        bootstrapped: !!state.bootstrapped,
        cursorPending: !!state.cursor,
        lastRunPagesFetched: state.lastRunPagesFetched ?? null,
        lastRunRecordsSeen: state.lastRunRecordsSeen ?? null,
        totalListingsStored: state.totalListingsStored ?? null,
        lastModified: state.lastModified || null,
        lastRunError: state.lastRunError || null,
        // 2026-08-13: surfaces why Cloudinary caching isn't kicking in for
        // Christine's own listings even after the env vars are added --
        // see the diagnostics note in sync-listings.js. lastRunCoverPhotos
        // Cached being 0 run after run alongside a non-null
        // lastCloudinaryError means the env vars aren't taking effect (or
        // are wrong); a real error message here means they ARE configured
        // but the actual Cloudinary/MLS Grid call is failing.
        lastRunCoverPhotosCached: state.lastRunCoverPhotosCached ?? null,
        lastCloudinaryError: state.lastCloudinaryError || null,
        // The same numbers as the Server-Timing header, for anyone reading JSON
        // rather than DevTools.
        timing: timing.summary(),
      };
    }
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // Chrome shows this natively: DevTools → Network → click the request →
        // Timing. No tooling, no interpretation — it says which phase is slow.
        "Server-Timing": timing.header(),
        // 2026-08-13 (performance fix): the underlying data only changes
        // every 15 minutes (sync-listings.js's schedule), so there's no
        // reason every page load re-runs this function from scratch.
        // Skipped for ?debug=true so live diagnostic checks are never
        // served a stale cached copy. stale-while-revalidate lets Netlify's
        // CDN serve an older-but-still-fresh-enough response instantly
        // while it refreshes in the background, instead of visitors ever
        // waiting on a cold function invocation.
        ...(params.debug === "true" ? {} : {
          // 2026-08-18: was 60 seconds, against data that only changes every 30
          // minutes (netlify.toml's sync schedule). Sixty seconds was far more
          // conservative than the data warranted, and it meant the default page
          // view — the one most visitors see — paid the full cold cost several
          // times an hour for nothing.
          //
          // Five minutes fresh, thirty stale-while-revalidate: a visitor never
          // waits for a revalidation, and the worst case is a listing appearing
          // five minutes later than it otherwise would, on a feed that is itself
          // half an hour behind.
          //
          // Note this cannot fix everything: Netlify keys the cache by query
          // string (netlify-vary: query), so every filter or sort change is a
          // different entry and lands on the origin cold. That is why the origin
          // itself still has to be fast.
          "Cache-Control": "public, max-age=300, stale-while-revalidate=1800",
        }),
      },
      body: JSON.stringify(response),
    };
  } catch (err) {
    console.error("listings-search function error:", err);
    // message/name are included in the response (not just server logs)
    // since neither ever contains a secret — just the JS error text — and
    // it means diagnosing a production issue doesn't require dashboard log
    // access at all, only the endpoint's own JSON response.
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "exception",
        message: err && err.message,
        name: err && err.name,
        listings: [],
        totalCount: 0,
      }),
    };
  }
};
