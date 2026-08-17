// The Cloudinary rows must name the right cause, and must never print a secret.
//
// 2026-08-17. Christine has TWO Cloudinary accounts. Listing-Engine (on Render)
// uploads to one without trouble; this site's uploads 403 against the other,
// because that other one is a Media Optimization account — a delivery-only
// product with no upload API at all.
//
// The health page had two problems with that, and the second is the expensive one:
//
//   1. It printed no cloud name, so the one question that resolves this —
//      WHICH account is this site pointed at — could not be answered from the page.
//   2. Its advice fell through to "check the three variables against cloudinary.com
//      → Dashboard", which is the single thing that CANNOT fix it. Cloudinary
//      authenticated those keys and then named the account type; re-copying them
//      from that same Dashboard reproduces the identical 403. That advice sends
//      her to do work that is guaranteed not to help, and I nearly did exactly
//      that in conversation before she said "i have it working in other apps".
//
// A wrong fix printed confidently on a health page is worse than no advice.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const src = fs.readFileSync(path.join(ROOT, "netlify", "functions", "site-health.js"), "utf8");

// --- The diagnosis has to be reachable ---
check(
  "the media-optimization case is detected",
  /media optimization/i.test(src),
  "the account-type 403 falls through to generic credential advice"
);

// It must be tested BEFORE the generic advice, or the fallthrough wins again.
const mediaAt = src.search(/\/media optimization\/i\.test/);
const genericAt = src.search(/Check the three CLOUDINARY_\* variables/);
check(
  "it is checked before the generic 'check your variables' fallback",
  mediaAt !== -1 && genericAt !== -1 && mediaAt < genericAt,
  "the generic branch is reached first, so the wrong fix is what she reads"
);

// And it must NOT tell her to re-copy from the same Dashboard, which cannot work.
// Bounded at the START of the next branch: a fixed-length slice runs into the
// cloud_name-mismatch advice below, where that Dashboard instruction is correct.
const mediaBranch = mediaAt === -1
  ? ""
  : src.slice(mediaAt, genericAt === -1 ? mediaAt + 1400 : src.indexOf("/cloud_name mismatch/i.test", mediaAt));
check(
  "the media-optimization advice does not send her back to the same Dashboard",
  !/cloudinary\.com\s*→\s*Dashboard/.test(mediaBranch),
  "this is the one fix guaranteed not to work for this error"
);
// The row must name the account that actually works. Christine has TWO Cloudinary
// accounts: "the-little-lady" (Media Optimization, delivery-only, no upload API)
// and "listingengine" (Programmable Media — its console has Assets and an Upload
// section). This site is on the first; the fix is to point it at the second.
check(
  "it names the working cloud, not just 'the wrong account'",
  /listingengine/.test(mediaBranch),
  "without the cloud name she has to go hunting for which account is which"
);
check(
  "it says how to tell the two accounts apart",
  /Assets/.test(mediaBranch) && /Upload/.test(mediaBranch),
  "the sidebar difference is the fastest way to confirm the right one"
);

// The misreading that cost an evening, pinned so it is not repeated. The Product
// Environments page counts environments in the SIGNED-IN account, not across
// accounts; I read "1 product environment (limit 1)" as "she has only one
// environment anywhere" and wrongly declared the whole thing unfixable.
check(
  "it warns that the environment count is per-account",
  /SIGNED INTO|signed into/.test(mediaBranch) && /limit 1/.test(mediaBranch),
  "this is the exact misreading that produced a wrong 'unfixable' verdict"
);

// --- The cloud name makes it verifiable ---
check(
  "the env-vars row prints which cloud name is in use",
  /cloud name.*CLOUDINARY_CLOUD_NAME|CLOUDINARY_CLOUD_NAME\}/.test(src),
  "without it there is no way to tell the two accounts apart, or confirm a swap took"
);

// The two mistakes actually made while switching accounts, both of which look
// identical to "all three env vars are present":
//   - CLOUDINARY_CLOUD_NAME set to the API key's NAME ("Signature Property
//     Collection") instead of the environment's cloud name.
//   - a key id paired with a different key's secret, which Cloudinary reports as
//     "api_secret mismatch".
// Naming them costs one sentence and saves a deploy cycle each.
check(
  "it warns that the cloud name is not the API key's name",
  /NOT the name[\s\S]{0,60}API key|not the name you gave an API key/i.test(src),
  "this exact mix-up happened 2026-08-17 and cost a deploy round-trip"
);
check(
  "it warns that key and secret must be a matched pair",
  /matched pair/i.test(src) && /api_secret mismatch/i.test(src),
  "the second mix-up of the same evening"
);

// Naming the right cloud in ADVICE is good. COMPARING against it in code is not:
// the row exists to report what is actually configured, and a hardcoded expectation
// would keep asserting an answer that was true one evening in August.
//
// Distinguishing these by quote style would be an accident of escaping, so this
// looks for the shapes a real comparison takes.
const compares = [
  /[=!]==?\s*["'`]listingengine/,          // === "listingengine"
  /["'`]listingengine["'`]\s*[=!]==?/,     // "listingengine" ===
  /\.(includes|indexOf|startsWith|endsWith|match|test)\(\s*["'`]?listingengine/,
  /listingengine[^"'`\n]*["'`]\s*\)\s*\?/, // ternary on the literal
];
check(
  "the expected cloud name is reported, never compared against",
  !compares.some((re) => re.test(src)),
  "a hardcoded expected value turns a live reading into a stale assumption"
);

// --- But never the credentials themselves ---
// The cloud name is public (first path segment of every delivery URL). The key
// and secret are not, and a health page is a page she opens in front of people.
for (const secret of ["CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) {
  // Interpolating the value into a detail string is the failure; testing whether
  // it is SET is fine.
  const interpolated = new RegExp(`\\$\\{[^}]*process\\.env\\.${secret}[^}]*\\}`);
  check(
    `${secret} is never interpolated into a health-page string`,
    !interpolated.test(src),
    "a credential would be rendered on a page she opens in front of people"
  );
}

// The schedule constant this file now depends on must survive too — a missing
// constant here is a ReferenceError at request time, i.e. the whole page 500s.
check(
  "SYNC_INTERVAL_MINUTES is defined before use",
  /const SYNC_INTERVAL_MINUTES\s*=/.test(src)
);

// The file has to actually load; every check above is static.
try {
  require(path.join(ROOT, "netlify", "functions", "site-health.js"));
  check("site-health.js loads", true);
} catch (err) {
  check("site-health.js loads", false, err && err.message);
}

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
