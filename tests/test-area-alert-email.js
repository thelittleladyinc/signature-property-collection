// The saved-area alert email a subscriber receives: signed with LPT Realty,
// phone and site; escapes what the subscriber typed; carries unsubscribe,
// EHO and per-listing courtesy; no retired brand or street address.
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => ({}) } };
const { emailHtml } = require(`${FN_DIR}/area-alerts-run.js`);

let failures = 0;
const check = (l, c) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}`); } };

delete process.env.ALERT_MAILING_ADDRESS;
const alert = { id: "a1", label: "<b>My</b> area", cities: ["Loveland", "Berthoud"] };
const listings = [{ listingId: "IR1", price: 525000, address: "945 Maplebrook Dr", city: "Loveland", beds: 3, baths: 2, sqft: 1800, agentName: "Pat Agent" }];
const html = emailHtml(alert, listings);
for (const s of ["Christine Gwinnup", "LPT Realty", "303-709-4262", "signaturepropertycollection.com", "Unsubscribe", "Equal Housing Opportunity", "Listing courtesy of Pat Agent"]) {
  check(`has ${s}`, html.includes(s));
}
check("escapes the label", !html.includes("<b>My</b>") && html.includes("&lt;b&gt;My&lt;/b&gt;"));
check("no retired brand, other brand in the sign-off, or street address", !/bold\s*collective|little lady sells homes|2411\s+glade/i.test(html));
process.env.ALERT_MAILING_ADDRESS = "PO Box 1, Loveland, CO 80539";
check("adds the postal line when configured", emailHtml(alert, listings).includes("PO Box 1, Loveland, CO 80539"));

if (failures) { console.log(`${failures} check(s) FAILED`); process.exit(1); }
console.log("All checks passed");
