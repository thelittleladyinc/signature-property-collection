// Shared constants + helpers between sync-listings.js (the scheduled job
// that replicates MLS Grid data into Netlify Blobs) and listings-search.js
// (the on-demand function the browser calls, which now reads and filters
// that replicated copy instead of querying MLS Grid live per request).
//
// WHY THIS FILE EXISTS (2026-08-12): MLS Grid's Property resource only
// allows $filter on a fixed set of fields for "replication" requests —
// confirmed directly from a real 400 response:
//   "Replication requests to the Property resource can only be filtered
//   using the following fields: MlgCanView, ModificationTimestamp,
//   OriginatingSystemName, StandardStatus, ListingId, PropertyType,
//   ListOfficeMlsId"
// ListPrice, City, BedroomsTotal, etc. are NOT in that list — every search
// this site does (by price/city/beds/baths) was therefore impossible to
// build as a live pass-through query, which is why the site's search was
// failing in production. The correct MLS Grid integration pattern (per
// their own Best Practices Guide) is: replicate the allowed dataset into
// your own storage on a schedule (they recommend every 15 minutes, and
// require a refresh at least every 12 hours per IDX Rule 12), then filter
// your own copy. See sync-listings.js for the replication job.

const BASE_URL = "https://api.mlsgrid.com/v2/Property";

// 2026-08-12: WaterfrontFeatures pulled after a real 400 from MLS Grid --
// "The field 'WaterfrontFeatures' does not exist or is unable to be
// retrieved" for this IRES feed specifically (this is the field that had
// been silently blocking every sync-listings.js run since launch, well
// past the earlier ListPrice/City $filter fix). WaterfrontYN plus the
// PublicRemarks keyword check in matchesQuery() below is still enough to
// flag waterfront listings without it.
//
// 2026-08-12 (second pass): once WaterfrontFeatures was fixed and the
// poisoned resume-cursor bug in sync-listings.js was also fixed (see that
// file's 2026-08-12 comments), the sync got further and hit a SECOND
// invalid-select-field 400, this time on ListOfficeName -- "The field
// 'ListOfficeName' does not exist or is unable to be retrieved" for this
// same IRES feed. Pulled here too. This is a real gap: IDX Rule 24 wants
// the listing brokerage shown per listing, and right now officeName will
// just be null (the UI already drops it cleanly via .filter(Boolean) in
// the compliance line, so nothing breaks -- it just won't show a per-
// listing office name until we hear back from IRES's Data Feed team,
// RETS@iresmls.com, on what field (if any) actually exposes it on this
// feed. ListAgentFullName/phone/email are unaffected and still display.
//
// 2026-08-12 (third pass): same story again, this time ListAgentDirectPhone
// -- "The field 'ListAgentDirectPhone' does not exist or is unable to be
// retrieved." Pulled here too.
//
// 2026-08-12 (fourth pass, final): rather than keep discovering these one
// per 15-minute sync cycle, tested the exact request shape sync-listings.js
// sends (same $filter/$select/$expand/$top/$orderby) directly against MLS
// Grid's live API with MLSGRID_API_TOKEN, iterating on each 400 until it
// returned 200. ListAgentEmail was also rejected -- "The field
// 'ListAgentEmail' does not exist or is unable to be retrieved" -- and
// after removing it too, the request succeeded end-to-end: 200 OK, real
// listings with real addresses/prices/photos, @odata.nextLink present for
// pagination. This is now a confirmed-working field list, not a guess.
//
// Net effect: this IRES feed exposes ListAgentFullName but neither
// ListAgentDirectPhone nor ListAgentEmail -- no per-listing agent contact
// info comes through at all, only their name. IDX Rule 24's "contact"
// requirement isn't fully satisfiable from this feed as a result; the
// site's own "Ask A Question" / "Request A Tour" buttons on each listing
// card (which route through this site's contact form, not the MLS data)
// are the practical substitute. Same open item as ListOfficeName above:
// worth asking IRES's Data Feed team (RETS@iresmls.com) whether any of
// these three fields (office name, agent phone, agent email) are available
// under a different field name on this feed, since none of the "obvious"
// RESO Data Dictionary names for them work here.
const SELECT_FIELDS = [
  "ListingId", "ListingKey", "StandardStatus", "ListPrice",
  "BedroomsTotal", "BathroomsTotalInteger", "LivingArea",
  "StreetNumber", "StreetName", "StreetSuffix", "City", "StateOrProvince", "PostalCode",
  "PublicRemarks", "PropertyType", "PropertySubType", "SubdivisionName",
  "WaterfrontYN",
  "ListAgentFullName",
  "CoListAgentFullName", "ModificationTimestamp", "MlgCanView",
].join(",");

// Every status either search mode ever needs (mine=true shows Active +
// under-contract; the public search shows Active only) — replicating this
// combined set covers both without needing two separate synced copies.
// Sold/Closed is deliberately never included here, so it's never even
// pulled into storage in the first place — the strictest possible version
// of "no sold/closed data" compliance.
const REPLICATED_STATUSES = ["Active", "Active Under Contract", "Pending"];
const MINE_STATUSES = ["Active", "Active Under Contract", "Pending"];
const PUBLIC_STATUSES = ["Active"];

const AGENT_SURNAME = (process.env.LISTING_AGENT_SURNAME || "gwinnup").toLowerCase();
const LUXURY_PRICE_FLOOR = 950000;

// 2026-08-14 (market-scoping research): borrowed directly from Christine's
// own Expired-Luxury app (lib/mlsSyncRunner.ts), which hit this exact
// problem on this exact IRES feed first. Its own comment: "This MLS feed
// frequently leaves CountyOrParish blank or in a format the filter can't
// match... City is far more reliably populated, so when the county can't
// be matched we infer it from the city." Rather than trust MLS Grid's raw
// county field (or worse, try to filter on it server-side -- Expired-
// Luxury's mlsClient.ts confirms MLS Grid flatly rejects every geographic
// $filter field, including CountyOrParish, City, and PostalCode, with
// "Invalid filter field" 400s), this infers county from City, which this
// site already selects safely. Table copied verbatim from Expired-Luxury
// so both apps agree on the same city->county mapping.
const CO_CITY_COUNTY = {
  // Larimer
  "fort collins": "larimer", "loveland": "larimer", "estes park": "larimer",
  "wellington": "larimer", "timnath": "larimer", "berthoud": "larimer",
  "bellvue": "larimer", "laporte": "larimer", "la porte": "larimer",
  "livermore": "larimer", "red feather lakes": "larimer", "drake": "larimer",
  "masonville": "larimer", "glen haven": "larimer", "waverly": "larimer",
  // Weld
  "greeley": "weld", "evans": "weld", "la salle": "weld", "lasalle": "weld",
  "windsor": "weld", "johnstown": "weld", "milliken": "weld", "mead": "weld",
  "platteville": "weld", "gilcrest": "weld", "kersey": "weld", "eaton": "weld",
  "ault": "weld", "pierce": "weld", "nunn": "weld", "severance": "weld",
  "hudson": "weld", "keenesburg": "weld", "fort lupton": "weld", "dacono": "weld",
  "firestone": "weld", "frederick": "weld", "erie": "weld", "lochbuie": "weld",
  "gill": "weld", "galeton": "weld", "briggsdale": "weld", "grover": "weld",
  "roggen": "weld",
  // 2026-08-15: Carr added on Christine's correction -- it was missing from
  // this table entirely, which showed up when checking her own sold homes
  // against it (Carr was the one town of 21 it couldn't place). Missing towns
  // are kept rather than dropped, so nothing was ever hidden, but the county
  // was also never inferred for them.
  "carr": "weld",
  // Morgan County (2026-08-15, Christine: "i need morgan county too"). Only
  // Wiggins was here before, so Fort Morgan and Brush -- the two biggest towns
  // in the county -- couldn't be placed at all.
  "wiggins": "morgan", "fort morgan": "morgan", "brush": "morgan",
  "log lane village": "morgan",
  // Broader Front Range -- kept available for a future widen (same as
  // Expired-Luxury's table) but not applied unless OPERATING_COUNTIES below
  // is actually set to include them.
  "denver": "denver", "boulder": "boulder", "longmont": "boulder",
  "lafayette": "boulder", "louisville": "boulder", "superior": "boulder",
  "castle rock": "douglas", "parker": "douglas", "highlands ranch": "douglas",
  "lone tree": "douglas", "aurora": "arapahoe", "centennial": "arapahoe",
  "littleton": "arapahoe", "englewood": "arapahoe", "thornton": "adams",
  "westminster": "adams", "brighton": "adams", "commerce city": "adams",
  "golden": "jefferson", "arvada": "jefferson", "lakewood": "jefferson",
  "wheat ridge": "jefferson", "broomfield": "broomfield",
  "colorado springs": "el paso", "monument": "el paso",
  "breckenridge": "summit", "frisco": "summit", "silverthorne": "summit",
  "vail": "eagle", "avon": "eagle", "edwards": "eagle", "eagle": "eagle",
  "aspen": "pitkin", "snowmass village": "pitkin", "steamboat springs": "routt",
  // 2026-08-15: added because they were the actual symptom. With the operating
  // filter now defaulted on, a listing is only droppable if its county can be
  // inferred -- an unrecognized city keeps its listing, deliberately, so a
  // real in-area sale in an unincorporated place (Bellvue, Livermore, Drake,
  // Glen Haven) is never thrown away over a missing table entry. The cost of
  // that caution is that a genuinely far-away town also stays until it's named
  // here, which is how an $81.6M ranch in FRASER -- Grand County, a two-hour
  // drive over Berthoud Pass -- ended up as the single most prominent result
  // on the public search page, with Breckenridge right behind it. These are the
  // mountain and plains towns most likely to turn up in an IRES/REcolorado
  // reciprocal feed and least likely to be Christine's market.
  "winter park": "grand", "fraser": "grand", "granby": "grand",
  "grand lake": "grand", "tabernash": "grand", "kremmling": "grand",
  "hot sulphur springs": "grand",
  "dillon": "summit", "keystone": "summit", "blue river": "summit",
  "copper mountain": "summit",
  "leadville": "lake", "fairplay": "park", "alma": "park", "bailey": "park",
  "buena vista": "chaffee", "salida": "chaffee",
  // These four are the opposite case -- eastern-plains towns that ARE inside
  // the service area (Adams and Arapahoe) and were being kept only because
  // their county couldn't be inferred. Naming them makes their inclusion
  // deliberate instead of accidental. Bennett prompted this: a $30M land
  // listing there sat at #2 on the public search and looked out-of-area at a
  // glance when it isn't.
  "bennett": "adams", "strasburg": "adams", "watkins": "adams",
  "byers": "arapahoe", "deer trail": "arapahoe",
  "sterling": "logan", "limon": "lincoln", "burlington": "kit carson",
  "akron": "washington", "holyoke": "phillips", "julesburg": "sedgwick",
  "wray": "yuma", "yuma": "yuma",

  // ---- 2026-08-18: the two halves of the same gap ------------------------
  // Christine sent a screenshot of her luxury search with 1315 Co-131, McCoy —
  // three hours away, not in any county she serves. The filter had not failed;
  // McCoy simply was not in this table, and an unplaceable city is KEPT by
  // design (see the note above) so a real listing in an unincorporated corner of
  // Larimer is never thrown away over a missing entry.
  //
  // The trap is that the same screenshot's $18M Cherry Hills Village home was
  // showing for exactly the same reason — Arapahoe County, squarely in her
  // service area, and equally absent from this table. So "drop what we cannot
  // place" would have deleted an eighteen-million-dollar listing to remove a
  // wrong one. The only safe fix is to name more towns, in BOTH directions.
  //
  // IN AREA — municipalities inside her nine counties that were unplaceable.
  // Naming them makes their inclusion deliberate rather than accidental, and
  // means the operating filter still behaves if she ever narrows the counties.
  "cherry hills village": "arapahoe", "greenwood village": "arapahoe",
  "glendale": "arapahoe", "sheridan": "arapahoe", "columbine valley": "arapahoe",
  "foxfield": "arapahoe", "bow mar": "arapahoe",
  "northglenn": "adams", "federal heights": "adams", "henderson": "adams",
  "todd creek": "adams",
  "evergreen": "jefferson", "conifer": "jefferson", "morrison": "jefferson",
  "edgewater": "jefferson", "lakeside": "jefferson", "mountain view": "jefferson",
  "genesee": "jefferson", "indian hills": "jefferson", "kittredge": "jefferson",
  "idledale": "jefferson", "pine": "jefferson", "buffalo creek": "jefferson",
  "nederland": "boulder", "lyons": "boulder", "niwot": "boulder",
  "ward": "boulder", "jamestown": "boulder", "eldorado springs": "boulder",
  "hygiene": "boulder", "allenspark": "boulder", "gold hill": "boulder",
  "gunbarrel": "boulder",
  "campion": "larimer", "rustic": "larimer", "virginia dale": "larimer",
  "garden city": "weld", "lucerne": "weld", "new raymer": "weld",
  "raymer": "weld", "stoneham": "weld", "hereford": "weld",
  "weldona": "morgan", "orchard": "morgan", "snyder": "morgan",
  "goodrich": "morgan", "hillrose": "morgan",

  // OUT OF AREA — the towns a Northern Colorado feed with reciprocal listings
  // actually surfaces. McCoy is the one that prompted this; the rest are its
  // neighbours, added so the next one does not need its own screenshot.
  "mccoy": "eagle", "gypsum": "eagle", "minturn": "eagle", "red cliff": "eagle",
  "wolcott": "eagle", "beaver creek": "eagle", "bond": "eagle", "burns": "eagle",
  "basalt": "eagle", "el jebel": "eagle",
  "oak creek": "routt", "phippsburg": "routt", "yampa": "routt",
  "hayden": "routt", "clark": "routt", "toponas": "routt", "milner": "routt",
  "glenwood springs": "garfield", "carbondale": "garfield", "rifle": "garfield",
  "silt": "garfield", "new castle": "garfield", "parachute": "garfield",
  "battlement mesa": "garfield",
  "craig": "moffat", "maybell": "moffat", "dinosaur": "moffat",
  "walden": "jackson",
  "idaho springs": "clear creek", "georgetown": "clear creek",
  "empire": "clear creek", "silver plume": "clear creek", "dumont": "clear creek",
  "black hawk": "gilpin", "central city": "gilpin", "rollinsville": "gilpin",
  "woodland park": "teller", "divide": "teller", "florissant": "teller",
  "cripple creek": "teller", "victor": "teller",
  "castle pines": "douglas", "sedalia": "douglas", "franktown": "douglas",
  "larkspur": "douglas", "roxborough park": "douglas",
  "elizabeth": "elbert", "kiowa": "elbert", "elbert": "elbert", "simla": "elbert",
  "fountain": "el paso", "falcon": "el paso", "peyton": "el paso",
  "calhan": "el paso", "black forest": "el paso", "manitou springs": "el paso",
  "grand junction": "mesa", "fruita": "mesa", "palisade": "mesa", "clifton": "mesa",
  "montrose": "montrose", "olathe": "montrose",
  "delta": "delta", "cedaredge": "delta", "paonia": "delta", "hotchkiss": "delta",
  "gunnison": "gunnison", "crested butte": "gunnison",
  "mount crested butte": "gunnison",
  "telluride": "san miguel", "mountain village": "san miguel",
  "norwood": "san miguel",
  "ouray": "ouray", "ridgway": "ouray",
  "durango": "la plata", "bayfield": "la plata", "ignacio": "la plata",
  "pagosa springs": "archuleta",
  // 2026-08-18: a $16.9M Creede listing survived the out-of-area cleanup on
  // Christine's live results because the whole San Luis Valley was missing
  // from this table — an unknown town infers no county, and a null county is
  // deliberately kept rather than guessed at. Filled in the valley and the
  // remaining southwest counties so the pruner can finally see them.
  "creede": "mineral",
  "south fork": "rio grande", "del norte": "rio grande", "monte vista": "rio grande",
  "alamosa": "alamosa", "hooper": "alamosa", "mosca": "alamosa",
  "saguache": "saguache", "center": "saguache", "crestone": "saguache",
  "villa grove": "saguache",
  "antonito": "conejos", "la jara": "conejos", "manassa": "conejos",
  "sanford": "conejos",
  "san luis": "costilla", "blanca": "costilla", "fort garland": "costilla",
  "lake city": "hinsdale",
  "silverton": "san juan",
  "rico": "dolores county", "dove creek": "dolores county",
  "naturita": "montrose", "nucla": "montrose",
  "cortez": "montezuma", "mancos": "montezuma", "dolores": "montezuma",
  "meeker": "rio blanco", "rangely": "rio blanco",
  "canon city": "fremont", "florence": "fremont", "penrose": "fremont",
  "westcliffe": "custer", "silver cliff": "custer",
  "poncha springs": "chaffee", "nathrop": "chaffee",
  "twin lakes": "lake",
  "como": "park", "hartsel": "park", "shawnee": "park", "grant": "park",
  "guffey": "park",
  "pueblo": "pueblo", "pueblo west": "pueblo", "rye": "pueblo",
  "colorado city": "pueblo",
  "walsenburg": "huerfano", "la veta": "huerfano",
  "trinidad": "las animas", "aguilar": "las animas",
  "la junta": "otero", "rocky ford": "otero", "fowler": "otero", "swink": "otero",
  "lamar": "prowers", "holly": "prowers", "granada": "prowers", "wiley": "prowers",
  "springfield": "baca", "walsh": "baca",
  "eads": "kiowa county", "ordway": "crowley", "sugar city": "crowley",
  "cheyenne wells": "cheyenne",
  "hugo": "lincoln", "genoa": "lincoln", "arriba": "lincoln",
  "otis": "washington",
  "merino": "logan", "iliff": "logan", "fleming": "logan", "peetz": "logan",
  "ovid": "sedgwick", "haxtun": "phillips", "eckley": "yuma",
  "stratton": "kit carson", "flagler": "kit carson", "seibert": "kit carson",
  "bethune": "kit carson", "vona": "kit carson",
};

function inferCountyFromCity(cityLower) {
  if (!cityLower) return null;
  return CO_CITY_COUNTY[cityLower] || null;
}

// 2026-08-14: OFF by default (empty = no filtering at all) -- set
// OPERATING_COUNTIES in Netlify's env vars (comma-separated) to restrict what
// gets stored.
//
// 2026-08-15 (Christine: "i want all 8 counties"): the intended value is the
// same 8 counties the site has pages for, so search results match the stated
// service area:
//     larimer,weld,boulder,broomfield,jefferson,denver,arapahoe,adams
// All 8 are emitted by CO_CITY_COUNTY below, so all 8 actually match.
//
// MEASURED, so this isn't re-argued later. Against a reconstructed
// 18,925-record store with realistic field sizes, after the field slimming
// added to sync-listings.js the same day:
//     no filter          -> 9.1 MB
//     all 8 counties     -> 8.2 MB   (1,892 records dropped)
//     larimer/weld/boulder only -> 5.5 MB
// i.e. the slimming does nearly all the work (44.3 MB -> 9.1 MB) and the county
// filter adds under a megabyte at 8 counties. So this setting is a BUSINESS
// choice about which listings the public search should return, not a
// performance lever. Don't narrow it hoping to speed anything up.
// Deliberately never applied to Christine's OWN listings (see the
// isHerListing() exclusion everywhere this is used) -- she should never
// lose one of her own listings to a geography filter even if it happens to
// be outside the configured set. Important: this can only ever shrink what
// gets STORED, never speed up the crawl itself -- MLS Grid's API rejects
// every geographic $filter field outright (confirmed in both MLS Grid's
// own docs and Expired-Luxury's production history), so every record still
// has to be paged through and inspected regardless; this just decides
// what's worth keeping in Blobs afterward.
// 2026-08-15: the default is no longer "no filtering at all". Christine asked
// for the site's own counties twice ("i want all 8 counties", then "i need
// morgan county too") and said plainly she wasn't going to set the env var
// ("im not going to set it"), so the value she asked for belongs in code
// rather than in a dashboard field nobody is going to fill in.
//
// This was not cosmetic. With no filter, the top of the public Search Homes
// page was an $81.6M ranch in Fraser (Grand County), $30M of land in Bennett,
// and a $25M house in Breckenridge -- sorted by price, so the three most
// prominent results on a Northern Colorado site were three towns Christine
// doesn't serve. Christine spotted it in a screenshot of her own live page.
//
// The env var still wins if it's ever set, so this is a default, not a
// hardcode. Keep in sync with COUNTIES in build/build.py -- these are the nine
// counties the site publishes pages for.
const DEFAULT_OPERATING_COUNTIES = [
  "larimer", "weld", "boulder", "broomfield",
  "jefferson", "denver", "arapahoe", "adams", "morgan",
];

const OPERATING_COUNTIES = new Set(
  (process.env.OPERATING_COUNTIES || DEFAULT_OPERATING_COUNTIES.join(","))
    .split(",")
    .map((c) => c.toLowerCase().replace(/\s+county$/, "").trim())
    .filter(Boolean)
);

const BLOB_STORE_NAME = "mls-listings";
const LISTINGS_KEY = "listings.json";
const SYNC_STATE_KEY = "sync-state.json";
// 2026-08-13 (performance fix): a small, pre-filtered copy of ONLY
// Christine's own listings (typically 5-10 records), maintained by
// sync-listings.js alongside the full LISTINGS_KEY blob. Every mine=true
// request — used by 97+ pages across the site (blog posts, city pages,
// the homepage spotlight, current-listings.html) via top:1/top:6-style
// widgets — used to force listings-search.js to pull and JSON-parse the
// ENTIRE regional dataset (tens of thousands of listings, tens of MB) just
// to find her handful. Reading this tiny key instead turns that into a
// near-instant lookup. The full-dataset LISTINGS_KEY is still read for the
// general public luxury search (mine not set) and as a one-time fallback
// if this key hasn't been computed yet (e.g. right after this deploy,
// before sync-listings.js's first run since the update).
const MINE_LISTINGS_KEY = "mine-listings.json";

// Netlify's docs promise getStore(name) auto-configures itself with no
// setup inside any Netlify Function — but in production here it actually
// throws MissingBlobsEnvironmentError (confirmed live, 2026-08-12: a real
// request to listings-search returned a 502 with that exact error).
// Whatever's different about this site's environment, the documented,
// guaranteed-to-work fallback is passing siteID/token explicitly — see
// https://docs.netlify.com/build/data-and-storage/netlify-blobs/#external-clients
// BLOBS_SITE_ID is just the site's Project ID (not secret — Project
// configuration > General > Project information > Project ID in the
// Netlify dashboard). BLOBS_TOKEN is a real Personal Access Token
// Christine has to generate herself (User settings > Applications >
// Personal access tokens > New access token) and add as a Netlify env var
// — same pattern as MLSGRID_API_TOKEN, never passed through this codebase.
// If those two env vars aren't set yet, this still tries the zero-config
// path first, in case Netlify's auto-injection starts working on its own.
// storeName defaults to BLOB_STORE_NAME (the MLS listings store) so every
// existing caller (sync-listings.js, listings-search.js) is unaffected;
// nearby-places.js passes its own store name to keep its distance-lookup
// cache separate from the listings data.
function getBlobStore(getStoreFn, storeName) {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  const name = storeName || BLOB_STORE_NAME;
  if (siteID && token) {
    return getStoreFn(name, { siteID, token });
  }
  return getStoreFn(name);
}

// 2026-08-14 (photo order bug): MLS Grid's docs say $expand doesn't support
// $orderby ("We do not support $select or $orderby on the $expand
// resources") — Media items come back in whatever order MLS Grid's API
// happens to return them, which is NOT guaranteed to be display order.
// Confirmed live: a bathroom photo was showing as the cover/primary photo
// for a listing instead of the exterior hero shot the agent actually chose
// in MLS. RESO's Media resource defines a standard "Order" field (0 =
// primary/hero photo, ascending from there) for exactly this reason — sort
// by it ourselves before extracting MediaURLs so the cover photo and
// gallery order match what's actually set in MLS. Falls back to whatever
// order the API returned if Order isn't present on a given feed (stable
// sort — items without a numeric Order keep their relative position at the
// end), so this is a no-op on feeds that don't send it, not a regression.
function sortMediaByOrder(media) {
  return media
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const orderA = typeof a.m?.Order === "number" ? a.m.Order : Number.MAX_SAFE_INTEGER;
      const orderB = typeof b.m?.Order === "number" ? b.m.Order : Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.i - b.i; // stable: preserve original relative order on ties
    })
    .map(({ m }) => m);
}

function mapListing(item) {
  const address = [item.StreetNumber, item.StreetName, item.StreetSuffix]
    .filter(Boolean).join(" ");
  const rawMedia = Array.isArray(item.Media) ? item.Media : [];
  const media = sortMediaByOrder(rawMedia);
  const photos = media.map((m) => m && m.MediaURL).filter(Boolean);
  const photo = photos.length ? photos[0] : null;

  return {
    listingId: item.ListingId || item.ListingKey || null,
    listingKey: item.ListingKey || null,
    price: item.ListPrice ?? null,
    beds: item.BedroomsTotal ?? null,
    baths: item.BathroomsTotalInteger ?? null,
    sqft: item.LivingArea ?? null,
    address: address || null,
    city: item.City || null,
    state: item.StateOrProvince || null,
    zip: item.PostalCode || null,
    status: item.StandardStatus || null,
    remarks: item.PublicRemarks || null,
    propertyType: item.PropertySubType || item.PropertyType || null,
    subdivision: item.SubdivisionName || null,
    waterfront: item.WaterfrontYN === true || null,
    officeName: item.ListOfficeName || null,
    // 2026-08-14: NOT in SELECT_FIELDS above by default -- ListOfficeMlsId is
    // only ever requested by sync-listings.js's isolated, try/caught
    // discoverHerOfficeMlsId() call (see that file), never by the main
    // crawl, specifically because this feed has a real, repeated history of
    // rejecting "obvious" RESO field names under their standard names
    // (WaterfrontFeatures, ListOfficeName, ListAgentDirectPhone,
    // ListAgentEmail all 400'd here before -- see the file comment above).
    // Reading it here unconditionally is harmless either way: item.
    // ListOfficeMlsId is simply undefined on every call that didn't select
    // it, so this is just null for those.
    officeMlsId: item.ListOfficeMlsId || null,
    agentName: item.ListAgentFullName || null,
    coAgentName: item.CoListAgentFullName || null,
    agentPhone: item.ListAgentDirectPhone || null,
    agentEmail: item.ListAgentEmail || null,
    photo,
    photos,
    modificationTimestamp: item.ModificationTimestamp || null,
    mlgCanView: item.MlgCanView !== false,
    // 2026-08-14 (market-scoping): inferred from City only -- see the
    // OPERATING_COUNTIES comment above for why CountyOrParish itself isn't
    // trusted/selected. Null when City isn't in the lookup table yet, which
    // deliberately means "don't filter this one out" wherever this is used.
    county: inferCountyFromCity((item.City || "").toLowerCase().trim()),
  };
}

// Client-side (well, server-side-over-cached-data) equivalent of the old
// OData $filter builder — same filtering logic, same param names/meaning,
// just applied in JS over the replicated array instead of sent to MLS Grid.
function matchesQuery(listing, params) {
  const mine = params.mine === "true";
  const statuses = mine ? MINE_STATUSES : PUBLIC_STATUSES;
  if (!statuses.includes(listing.status)) return false;

  if (mine) {
    const surname = AGENT_SURNAME;
    const agent = (listing.agentName || "").toLowerCase();
    const coAgent = (listing.coAgentName || "").toLowerCase();
    if (!agent.includes(surname) && !coAgent.includes(surname)) return false;
  } else if (params.noFloor !== "true") {
    if (!(listing.price >= LUXURY_PRICE_FLOOR)) return false;
  }

  if (params.city) {
    if ((listing.city || "").toLowerCase() !== String(params.city).toLowerCase()) return false;
  }
  if (params.cities) {
    const cityList = String(params.cities).split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
    if (cityList.length && !cityList.includes((listing.city || "").toLowerCase())) return false;
  }

  const minPrice = parseInt(params.minPrice, 10);
  if (Number.isFinite(minPrice) && minPrice > 0) {
    if (!(listing.price >= minPrice)) return false;
  }
  const maxPrice = parseInt(params.maxPrice, 10);
  if (Number.isFinite(maxPrice) && maxPrice > 0) {
    if (!(listing.price <= maxPrice)) return false;
  }
  const beds = parseInt(params.beds, 10);
  if (Number.isFinite(beds) && beds > 0) {
    if (!(listing.beds >= beds)) return false;
  }
  const baths = parseInt(params.baths, 10);
  if (Number.isFinite(baths) && baths > 0) {
    if (!(listing.baths >= baths)) return false;
  }

  if (params.subdivision) {
    const needle = String(params.subdivision).toLowerCase();
    if (!(listing.subdivision || "").toLowerCase().includes(needle)) return false;
  }

  if (params.waterfront === "true") {
    const remarksLower = (listing.remarks || "").toLowerCase();
    const remarksHit = remarksLower.includes("riverfront") ||
      remarksLower.includes("river frontage") || remarksLower.includes("waterfront");
    if (!(listing.waterfront || remarksHit)) return false;
  }

  // ---- Advanced filters, 2026-08-15 -------------------------------------
  // Christine: "do we want to add an advanced search with riverfront property
  // or if its esquetarian... how far from a grocery store?" Riverfront already
  // worked here (it just had no UI); these are the rest of what this feed's
  // stored fields can actually answer honestly.
  //
  // Distance-to-amenity filtering is deliberately NOT here, and can't be:
  // every listing would need its own Google Places lookups, which is thousands
  // of calls against a per-address 30-day cache ceiling. It stays where it
  // already works -- the per-listing "Nearby & Distances" panel (nearby-places
  // .js, on demand, cached) and the town-level walkability panel.
  if (params.equestrian === "true") {
    const remarksLower = (listing.remarks || "").toLowerCase();
    // Christine's own listings keep their remarks, so they're matched live;
    // everyone else's were pre-computed into the flag before remarks were
    // dropped (see slimForStorage in sync-listings.js).
    const remarksHit = remarksLower.includes("horse property") ||
      remarksLower.includes("equestrian") || remarksLower.includes("loafing shed") ||
      remarksLower.includes("riding arena") || remarksLower.includes("horses allowed");
    if (!(listing.equestrian || remarksHit)) return false;
  }

  // Coarse categories matched by substring rather than an exact list of
  // PropertySubType values, because the exact strings this feed emits aren't
  // documented anywhere we can rely on -- "Single Family Residence",
  // "Residential-Detached" and "House" have all been seen in Colorado feeds.
  // A substring test degrades to "no match" instead of silently filtering
  // everything out if the wording differs.
  if (params.propertyCategory) {
    const type = String(listing.propertyType || "").toLowerCase();
    const cat = String(params.propertyCategory).toLowerCase();
    const matchers = {
      house: ["single family", "detached", "house", "residential"],
      condo: ["condo", "townhouse", "townhome", "attached", "multi-family", "multi family"],
      land: ["land", "lot", "acreage"],
      farm: ["farm", "ranch", "agricultur"],
    };
    const needles = matchers[cat];
    if (!needles) return false;               // unknown category: match nothing
    // "residential" is a broad fallback for feeds that only say that much, but
    // it must not swallow condos -- so a condo-ish type never counts as house.
    if (cat === "house" && matchers.condo.some((n) => type.includes(n))) return false;
    if (!needles.some((n) => type.includes(n))) return false;
  }

  const minSqft = parseInt(params.minSqft, 10);
  if (Number.isFinite(minSqft) && minSqft > 0) {
    // A listing with no LivingArea (land, and some new construction) can't
    // satisfy a square-footage floor, so it's excluded rather than assumed.
    if (!(listing.sqft >= minSqft)) return false;
  }

  return true;
}

module.exports = {
  getBlobStore,
  BASE_URL,
  SELECT_FIELDS,
  REPLICATED_STATUSES,
  MINE_STATUSES,
  PUBLIC_STATUSES,
  AGENT_SURNAME,
  LUXURY_PRICE_FLOOR,
  BLOB_STORE_NAME,
  LISTINGS_KEY,
  SYNC_STATE_KEY,
  MINE_LISTINGS_KEY,
  CO_CITY_COUNTY,
  OPERATING_COUNTIES,
  inferCountyFromCity,
  mapListing,
  matchesQuery,
};
