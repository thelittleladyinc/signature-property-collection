// Card photos must be requested at card size, not full MLS resolution.
//
// 2026-08-17 (Christine: "pictures just still arent coming through very quickly").
// A listing card renders at roughly 400px wide and was handed the FULL-RESOLUTION
// MLS photo — routinely 1–3MB of JPEG for a slot that needs about 60KB. The bytes
// were the problem, not the pipeline: listing-photo.js already caches hard at the
// CDN, so a repeat view was fast and still enormous.
//
// Netlify's Image CDN resizes and re-encodes at the edge and caches the RESULT, so
// the browser gets a width-appropriate WebP. What this suite protects is the three
// ways that goes wrong quietly.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const page = fs.readFileSync(path.join(ROOT, "site", "current-listings.html"), "utf8");
const sizedSrc = (page.match(/function sizedPhoto[\s\S]*?\n  \}/) || [])[0];
const rawSrc = (page.match(/function rawPhoto[\s\S]*?\n  \}/) || [])[0];
check("the built page ships sizedPhoto()", !!sizedSrc);
check("the built page ships rawPhoto()", !!rawSrc);

if (sizedSrc && rawSrc) {
  // Evaluated in an isolated scope and handed back, so the declarations in the
  // page source cannot collide with names in this file.
  const [sizedPhoto, rawPhoto] =
    new Function(`${sizedSrc}\n${rawSrc}\nreturn [sizedPhoto, rawPhoto];`)();
  const FN = "/.netlify/functions/listing-photo?id=IRE1059808&i=0";
  const out = sizedPhoto(FN, 800);

  check("our own photo endpoint is routed through the Image CDN",
    out.startsWith("/.netlify/images?url="), out);
  check("with an explicit width", /[?&]w=800\b/.test(out), out);
  check("and a modern format", /[?&]fm=webp\b/.test(out), out);

  // The fallback is what makes this safe to ship untested against the live CDN:
  // if the transform ever fails, the img must be able to recover the original.
  check("the transformed URL round-trips back to the raw endpoint",
    rawPhoto(out) === FN, `${rawPhoto(out)} !== ${FN}`);

  // Cloudinary is already re-hosted and optimised, AND is a remote host the Image
  // CDN would need allowlisting for. Wrapping it would break those photos.
  const cloud = "https://res.cloudinary.com/demo/image/upload/v1/x.jpg";
  check("Cloudinary URLs are left alone", sizedPhoto(cloud, 800) === cloud);
  check("a null photo stays null", sizedPhoto(null, 800) === null);
  check("an unrelated path is untouched", sizedPhoto("/assets/img/hero.jpg", 800) === "/assets/img/hero.jpg");
}

// The card must recover on its own if the Image CDN ever fails, rather than
// dropping straight to the grey tile — otherwise an untested platform feature
// becomes a site-wide photo outage.
check("the card falls back to the raw endpoint before giving up",
  /data-raw=/.test(page) && /this\.src\s*=\s*this\.dataset\.raw/.test(page) &&
  /indexOf\(.{0,4}\/\.netlify\/images/.test(page),
  "no fallback path — an Image CDN failure would blank every card");

// Dimensions prevent the layout shifting as each photo arrives, which is half of
// what "slow" feels like even when the bytes are small.
check("card images declare width and height",
  /width="800" height="600"/.test(page));

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
