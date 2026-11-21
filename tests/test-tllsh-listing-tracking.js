// /listing/<id> on thelittleladysellshomes.com carries GA4 and the Meta Pixel.
//
// 2026-11-20 (ads audit). thelittleladysellshomes.com still passes /listing/<id>
// through to this function with ?brand=tllsh (its BACKEND_MODE is not "local" in
// production), and the TLLSH shell checked in here was copied on 2026-08-19
// WITHOUT Google Analytics or the Meta Pixel. So every listing page on her main
// site, including the one the expired-seller ad sent people to, measured nothing
// and fed no retargeting audience. The shell now carries the main site's own
// tags, copied byte for byte from its built pages: GA4 G-4Q36KQWK2M and pixel
// 785995940287531 (deferred until the first interaction, as everywhere on that
// site), one PageView, and the Contact click event. Never a Lead here (a Lead
// belongs to the thank-you page only), and never pixel 1292637128972060.
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };
const count = (s, needle) => s.split(needle).length - 1;

function tags(html, label) {
  console.log(label);
  const head = html.slice(0, html.indexOf("</head>"));
  check("GA4 loads once, in the head", count(head, "googletagmanager.com/gtag/js?id=G-4Q36KQWK2M") === 1);
  check("GA4 is configured once", count(html, "gtag('config','G-4Q36KQWK2M')") === 1);
  check("the Meta Pixel is initialised once, in the head", count(head, "fbq('init','785995940287531')") === 1 && count(html, "fbq('init'") === 1);
  check("one PageView", count(html, "fbq('track','PageView')") === 1);
  check("fbevents.js waits for an interaction (not on the critical path)", /addEventListener\(x,G,\{once:!0,passive:!0\}\)/.test(head));
  check("the noscript pixel", count(html, "facebook.com/tr?id=785995940287531&ev=PageView&noscript=1") === 1);
  check("never a Lead on a listing page", !/fbq\('track','Lead'/.test(html));
  check("never the retired pixel 1292637128972060", !html.includes("1292637128972060"));
  check("never StreetText's pixel 1772864573240190", !html.includes("1772864573240190"));
}

const shellPath = path.join(ROOT, "netlify", "functions", "lib", "_listing-page-shell-tllsh.html");
tags(fs.readFileSync(shellPath, "utf8"), "1. The checked-in TLLSH shell");

const signature = fs.readFileSync(path.join(ROOT, "netlify", "functions", "lib", "_listing-page-shell.html"), "utf8");
console.log("2. The Signature shell is untouched by this change");
check("no Little Lady GA4 ID in the Signature shell", !signature.includes("G-4Q36KQWK2M"));

(async () => {
  // 3. A real render through the function, brand=tllsh, for an id that is not a
  //    listing: the "Listing Unavailable" page is rendered into the same shell.
  const { handler } = require(path.join(ROOT, "netlify", "functions", "listing-page.js"));
  const res = await handler({ httpMethod: "GET", queryStringParameters: { id: "not a listing id", brand: "tllsh" }, rawQuery: "id=not%20a%20listing%20id&brand=tllsh", headers: {} });
  check("3. the function answers", res && typeof res.body === "string" && res.body.length > 1000, res && res.statusCode);
  if (res && typeof res.body === "string") tags(res.body, "   and the rendered page carries the tags");
  if (failures) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log("\nAll checks passed.");
})().catch((e) => { console.log("FAIL", e && e.message); process.exit(1); });
