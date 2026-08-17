// A card that says "View All 50 Photos" must actually ask for photo 0.
//
// 2026-08-17 (Christine: "still no photos - they worked awhile back"). She was right
// on both counts. This is the bug that had her looking at a grey square all day while
// every explanation offered to her was about rate limits.
//
// THE CONTRADICTION, and it lived inside a single commit from 2026-08-15. That commit
// wrote, for the COUNT:
//
//     "The stored photoCount has to win when photos[] is absent."
//
// ...and then guarded the URL on `listing.photo` / `listing.photos` ONLY. So for a
// listing whose stored photo URLs had expired and been dropped but whose photoCount
// survived, the card simultaneously believed there were 50 photos and refused to emit
// a URL for photo 0.
//
// WHAT IT LOOKED LIKE: a grey box beside the words "View All 50 Photos". And the
// giveaway was in her own DevTools — NO REQUEST for the photo. Not a failed one; none
// at all. Hours went into 429s, cooldowns and placeholder TTLs, all of them real and
// all of them happening to a request the page never made. The empty Network tab was
// the evidence and it got waved away as "DevTools opened after load".
//
// WHY THE GUARD WAS WRONG, not just incomplete: listing-photo.js resolves fresh
// signed URLs from MLS Grid by LISTING ID and needs no stored URL at all. Her own
// debug output said `urlCount: 50` for the exact listing showing nothing.
//
// So what this suite protects is not "photos work" — it is that ONE definition of
// "how many photos does this listing have" drives both the label and the URL.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const SRC = fs.readFileSync(path.join(ROOT, "netlify", "functions", "listings-search.js"), "utf8");

// Lift the three functions out and run them for real. They are module-private, and
// exporting them just for a test would be a worse trade than this.
function load(name) {
  const at = SRC.indexOf(`function ${name}(`);
  if (at === -1) return null;
  return SRC.slice(at, SRC.indexOf("\n}", at) + 2);
}
const bundle = ["isRehosted", "knownPhotoCount", "photoUrlFor", "galleryUrlsFor"].map(load);
check("all four photo functions found", bundle.every(Boolean),
  "the source shape changed — read this file before assuming it is stale");
const { photoUrlFor, galleryUrlsFor, knownPhotoCount } =
  new Function(`${bundle.join("\n")}\nreturn { photoUrlFor, galleryUrlsFor, knownPhotoCount };`)();

const ID = "IRE1059948";  // her Greeley listing — the card that went grey

// --- THE REGRESSION ITSELF. Stored URLs expired and were dropped; the count
// survived. This is the exact shape of the listing behind that grey box.
const expired = { listingId: ID, photoCount: 50 };
check("a listing with photoCount but no stored URL still gets a cover URL",
  photoUrlFor(expired, 0) === `/.netlify/functions/listing-photo?id=${ID}&i=0`,
  "THIS is the bug: the card renders a grey div and never requests the photo");
check("  and its gallery is all 50, not zero",
  galleryUrlsFor(expired).length === 50,
  "View All 50 Photos opening an empty gallery");

// --- THE INVARIANT that makes the contradiction unrepresentable. Whatever the card
// SAYS it has, it must be willing to ASK for.
for (const listing of [
  { listingId: ID, photoCount: 50 },                       // count only
  { listingId: ID, photo: "https://media.mlsgrid.com/x" },  // cover only
  { listingId: ID, photos: ["a", "b", "c"] },               // array only
  { listingId: ID, photoCount: 12, photo: "https://media.mlsgrid.com/x" },
]) {
  const n = knownPhotoCount(listing);
  const urls = galleryUrlsFor(listing);
  check(`the count (${n}) and the URLs (${urls.length}) agree`, n === urls.length,
    "a label and a request built from different rules is what broke the cards");
  if (n > 0) {
    check(`  and photo 0 is requestable when the count is ${n}`, !!photoUrlFor(listing, 0));
  }
}

// --- STILL HONEST ABOUT NOTHING. The guard's original intent must survive: a listing
// with genuinely no photos must not emit a URL that can only render a placeholder.
check("a listing with no photos at all gets no URL",
  photoUrlFor({ listingId: ID }, 0) === null,
  "emitting a URL here spends an MLS Grid call to render a grey square");
check("  explicitly zero is still zero",
  photoUrlFor({ listingId: ID, photoCount: 0 }, 0) === null);
check("  and an index past the end gets no URL",
  photoUrlFor({ listingId: ID, photoCount: 3 }, 7) === null,
  "asking for photo 7 of 3 wastes a call and returns a placeholder");
check("a listing with no id gets no URL", photoUrlFor({ photoCount: 5 }, 0) === null);

// --- CLOUDINARY still wins, and never routes through our function.
const cloud = "https://res.cloudinary.com/listingengine/image/upload/v1/spc/x.jpg";
check("a Cloudinary cover is served directly",
  photoUrlFor({ listingId: ID, cloudinaryPhoto: cloud, photoCount: 50 }, 0) === cloud,
  "re-hosted photos must not cost an MLS Grid lookup");
check("and a Cloudinary gallery entry too",
  photoUrlFor({ listingId: ID, cloudinaryPhotos: [cloud, cloud], photoCount: 50 }, 1) === cloud);

// --- The rule must exist in ONE place. Two copies is the whole bug.
check("knownPhotoCount is the single definition",
  (SRC.match(/typeof listing\.photoCount === "number"/g) || []).length +
  (SRC.match(/typeof l\.photoCount === "number"/g) || []).length === 1,
  "the count rule is written out more than once — they will drift apart again");

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
