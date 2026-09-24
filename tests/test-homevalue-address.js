// Home-value leads must reach Lofty with the property address in the field
// Seller Intelligence's Lofty sync reads (lib/_lead-address.js), and ONLY
// home-value leads -- a buyer's land/listing address is not their home.
const ROOT = require("path").resolve(__dirname, "..");
const path = require("path");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true,
  exports: { getStore: () => ({ get: async () => null, setJSON: async () => {} }) } };

let posts = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  let body = null; try { body = opts.body ? JSON.parse(opts.body) : null; } catch (e) {}
  if (u.endsWith("/v1.0/leads") && opts.method === "POST") posts.push(body);
  const r = u.includes("/leads") && opts.method === "POST" ? { data: { leadId: 42 } } : { data: { tags: [] } };
  return { ok: true, status: 200, text: async () => JSON.stringify(r), json: async () => r, headers: { get: () => null } };
};
process.env.LOFTY_API_KEY = "k"; process.env.RESEND_API_KEY = "r";
const handler = require(path.join(FN_DIR, "submission-created.js")).handler;
const { propertyFromAddress } = require(path.join(FN_DIR, "lib/_lead-address.js"));
const sub = (formName, data) => ({ body: JSON.stringify({ payload: { form_name: formName, data } }) });

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("\nparsing");
check("street, city, state + ZIP", eq(propertyFromAddress("123 Main St, Loveland, CO 80537"),
  { streetAddress: "123 Main St", state: "CO", zipCode: "80537", city: "Loveland" }));
check("street + city only", eq(propertyFromAddress("45 Elm Ct, Windsor"), { streetAddress: "45 Elm Ct", city: "Windsor" }));
check("one line, nothing guessed", eq(propertyFromAddress("789 County Rd 13 Berthoud CO"), { streetAddress: "789 County Rd 13 Berthoud CO" }));
check("empty -> null", propertyFromAddress("  ") === null);

(async () => {
  console.log("\nthrough submission-created");
  for (const [form, field] of [["free-home-valuation", "address"], ["sellers-page-inquiry", "address"],
    ["seller-local-proof", "address"]]) {
    posts = [];
    await handler(sub(form, { name: "A B", email: "a@example.com", [field]: "12 Oak Dr, Loveland, CO 80538" }));
    check(`${form}: Lofty create carries property.streetAddress`,
      posts.length === 1 && posts[0].property && posts[0].property.streetAddress === "12 Oak Dr"
      && posts[0].property.city === "Loveland" && posts[0].property.zipCode === "80538", JSON.stringify(posts[0] && posts[0].property));
  }
  for (const form of ["luxury-market", "contact", "listing-inquiry"]) {
    posts = [];
    await handler(sub(form, { name: "A B", email: "a@example.com", property_address: "9 Ranch Rd", address: "9 Ranch Rd", message: "hi" }));
    check(`${form}: no property on the lead (not their home)`, posts.length === 1 && !("property" in posts[0]));
  }
})().then(() => {
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
});
