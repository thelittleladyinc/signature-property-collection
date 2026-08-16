// The seller page is the listing-appointment pitch: real numbers per town, and a
// form that reaches Lofty tagged as a SELLER lead rather than another browse.
// Repo root derived from this file's own location, never hardcoded: these suites
// run both locally and in GitHub Actions, where the checkout is at
// /home/runner/work/<repo>/<repo>. An absolute path would pass here and fail there.
const ROOT = require("path").resolve(__dirname, "..");
const fs = require("fs");
const html = fs.readFileSync(`${ROOT}/site/seller-local-proof.html`, "utf8");
const spots = require(`${ROOT}/netlify/functions/lib/_local-spots.json`).spots;
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const total = spots.reduce((n, s) => n + (s.views || 0) + (s.reviewViews || 0), 0);
check("page exists and states the real grand total",
  html.includes(total.toLocaleString("en-US")), total.toLocaleString("en-US"));
check("headline is the seller pitch, not a buyer one", /Your Neighborhood Already Has An Audience/.test(html));
check("town picker is present", /id="spt-town"/.test(html) && /Choose your town/.test(html));

// Every town with spots must be selectable, and none without.
const opts = [...html.matchAll(/<option value="\d+">([^<]+?) &mdash; ([\d,]+) views<\/option>/g)]
  .map(m => ({ town: m[1], views: Number(m[2].replace(/,/g, "")) }));
console.log(`       towns offered: ${opts.map(o => `${o.town} ${o.views.toLocaleString()}`).join(" · ")}`);
check("at least 8 towns offered", opts.length >= 8, String(opts.length));
check("ordered by audience, biggest first",
  opts.every((o, i) => i === 0 || opts[i - 1].views >= o.views), JSON.stringify(opts.map(o => o.views)));
check("Bellvue is NOT offered — it has no town page", !opts.some(o => o.town === "Bellvue"),
  opts.map(o => o.town).join(","));
check("Berthoud shows its 10,000-view review", opts.some(o => o.town === "Berthoud" && o.views >= 10000));

// The form: this is the point of the page.
check("form posts to Netlify", /name="seller-local-proof"[\s\S]{0,200}data-netlify="true"/.test(html));
check("address is required — a seller lead without one is useless",
  /name="address"[^>]*required/.test(html));
check("the chosen town travels with the lead", /name="local_proof_town"/.test(html));
check("consent checkbox present", /class="consent"/.test(html));
check("honeypot present", /netlify-honeypot="bot-field"/.test(html));

// And the Lofty side.
const fn = fs.readFileSync(`${ROOT}/netlify/functions/submission-created.js`, "utf8");
check("Lofty labels it a listing lead", /Seller Local Proof \(listing lead\)/.test(fn));
check("Lofty tags it Seller Lead", /"Seller Lead", "Local Proof"/.test(fn));
check("the town is written into the Lofty note", /Saw the local-proof numbers for/.test(fn));

// Reachable, not orphaned.
check("linked from the sellers page", /seller-local-proof/.test(fs.readFileSync(`${ROOT}/site/sellers.html`, "utf8")));
check("in the sitemap", /seller-local-proof/.test(fs.readFileSync(`${ROOT}/site/sitemap.xml`, "utf8")));
check("no unrendered template braces leaked", !/\{\{|\}\}|\{esc\(/.test(html.replace(/\{\{/g, "")) || !/\{esc\(/.test(html));
console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
