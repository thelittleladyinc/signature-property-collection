// Where a home search goes: her Lofty site, already filtered (lib/_home-search.js).
//
// 2026-09-28 (Christine approved it: "lets do it!!!"). Every public search on this
// site now opens the same search on her Lofty site, which was the faster of the two
// from click to data. The URL format below was read off her own Lofty site and
// tried there the same day -- Lofty does not document it -- so this suite pins the
// exact shapes that were seen to work, and the choices made where they did not:
//
//   Loveland, $950K+, 3+ beds             -> 95 homes, all Loveland, all >= $950K
//   Larimer + Weld, $950K-$3M, PRICE_DESC  -> 884 homes, both counties, highest first
//   Loveland + Fort Collins, $1.2M+, 4+ beds, PRICE_ASC -> 106 homes, as generated here
//   subdivision "Mariana" -> nothing (Lofty wants "Mariana Butte"), so not mapped
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

delete process.env.IDX_SEARCH_URL;
delete process.env.OPERATING_COUNTIES;
const H = require(`${FN_DIR}/lib/_home-search.js`);
const cond = (url) => JSON.parse(new URL(url).searchParams.get("condition"));

console.log("\n1. The URL Lofty's site understands");
const u1 = H.homeSearchUrl({ city: "Loveland", minPrice: "950000", beds: "3" });
check("her Lofty site's search page", u1.startsWith("https://theboldcollectivehomes.com/listing?"), u1);
check("the tried-and-working condition for Loveland, $950K+, 3+ beds",
  JSON.stringify(cond(u1)) === JSON.stringify({ location: { city: ["Loveland, CO"] }, price: "950000,", beds: "3," }), JSON.stringify(cond(u1)));
check("page 1", new URL(u1).searchParams.get("page") === "1");
const u2 = H.homeSearchUrl({ cities: "loveland,fort collins", minPrice: "1200000", beds: "4", sort: "price-asc" });
check("several towns, lower-case in the link, become Lofty's \"Town, CO\"",
  cond(u2).location.city.join("|") === "Loveland, CO|Fort Collins, CO", JSON.stringify(cond(u2)));
check("the site's sort names map to Lofty's", new URL(u2).searchParams.get("listingSort") === "PRICE_ASC");
check("every site sort has a Lofty one", Object.keys(H.SORTS).join(",") === "price-desc,price-asc,sqft-desc,recent" &&
  H.SORTS.recent === "MLS_LIST_DATE_L_DESC");
check("no sort asked, none sent (Lofty's own default order)", !new URL(u1).searchParams.has("listingSort"));
check("city and cities together, deduplicated",
  cond(H.homeSearchUrl({ city: "Loveland", cities: "loveland,Berthoud" })).location.city.join("|") === "Loveland, CO|Berthoud, CO");
check("markup in a town name is dropped, not passed to Lofty",
  !/[<>"]/.test(cond(H.homeSearchUrl({ city: 'Love<b>"land' })).location.city[0]));
check("an absurdly long \"town\" is dropped", cond(H.homeSearchUrl({ city: "x".repeat(80), noFloor: "true" })).location.county !== undefined);

console.log("\n2. The luxury floor, as the site applies it");
check("no price asked: $950K+ (Signature's luxury floor)", cond(H.homeSearchUrl({ city: "Windsor" })).price === "950000,");
check("noFloor=true: any price", cond(H.homeSearchUrl({ city: "Windsor", noFloor: "true" })).price === undefined);
check("a minimum in the link wins", cond(H.homeSearchUrl({ city: "Windsor", minPrice: "500000", noFloor: "true" })).price === "500000,");
check("a maximum is kept", cond(H.homeSearchUrl({ minPrice: "950000", maxPrice: "3000000" })).price === "950000,3000000");
check("junk prices are ignored", cond(H.homeSearchUrl({ noFloor: "true", minPrice: "abc", maxPrice: "-5" })).price === undefined);

console.log("\n3. Filters that map, and the ones that deliberately don't");
const c3 = cond(H.homeSearchUrl({ city: "Loveland", baths: "2", minSqft: "2500", propertyCategory: "condo" }));
check("baths, square feet", c3.baths === "2," && c3.sqft === "2500,");
check("condo -> Lofty's Condo + Townhouse", JSON.stringify(c3.propertytype) === '["Condo","Townhouse"]');
check("house -> Single Family Home", JSON.stringify(cond(H.homeSearchUrl({ propertyCategory: "house" })).propertytype) === '["Single Family Home"]');
check("land and farm are not sent (Lofty's labels for them matched nothing)",
  cond(H.homeSearchUrl({ propertyCategory: "land" })).propertytype === undefined &&
  cond(H.homeSearchUrl({ propertyCategory: "farm" })).propertytype === undefined);
const c4 = cond(H.homeSearchUrl({ city: "Loveland", subdivision: "Mariana", waterfront: "true", equestrian: "true" }));
check("a subdivision search opens the whole town (Lofty matches exact names only)",
  JSON.stringify(c4.location) === '{"city":["Loveland, CO"]}' && !JSON.stringify(c4).includes("Mariana"), JSON.stringify(c4));
check("riverfront / horse property have no Lofty filter and are not sent", !/waterfront|equestrian/i.test(JSON.stringify(c4)));

console.log("\n4. No town named: Northern Colorado (Larimer + Weld), not the whole country");
const c5 = cond(H.homeSearchUrl({}));
check("Larimer and Weld, as Lofty's \"County, CO\" (Christine: \"weld and larimer counties\")",
  JSON.stringify(c5.location) === '{"county":["Larimer, CO","Weld, CO"]}', JSON.stringify(c5.location));
const c6 = cond(H.homeSearchUrl({}, { env: { HOME_SEARCH_COUNTIES: "Larimer County, weld, Boulder" } }));
check("HOME_SEARCH_COUNTIES changes that, tidying the names", JSON.stringify(c6.location) === '{"county":["Larimer, CO","Weld, CO","Boulder, CO"]}',
  JSON.stringify(c6.location));
check("a link that names a town outside NoCo still searches that town",
  JSON.stringify(cond(H.homeSearchUrl({ cities: "breckenridge,frisco" })).location) === '{"city":["Breckenridge, CO","Frisco, CO"]}');

console.log("\n5. The address is a setting");
const custom = H.homeSearchUrl({ city: "Loveland" }, { env: { IDX_SEARCH_URL: "https://search.thelittleladysellshomes.com/listing" } });
check("a new Lofty domain is used as given", custom.startsWith("https://search.thelittleladysellshomes.com/listing?condition="), custom);
check("an address that is not a Lofty /listing page is used as-is",
  H.homeSearchUrl({ city: "Loveland" }, { env: { IDX_SEARCH_URL: "https://example.com/homes" } }) === "https://example.com/homes");
check("a javascript: address falls back to her Lofty search",
  H.homeSearchUrl({}, { env: { IDX_SEARCH_URL: "javascript:alert(1)" } }).startsWith("https://theboldcollectivehomes.com/listing?"));

console.log("\n6. The words on the button");
check("one town", H.homeSearchLabel({ city: "loveland" }) === "See Loveland homes for sale from $950K", H.homeSearchLabel({ city: "loveland" }));
check("any price", H.homeSearchLabel({ city: "Berthoud", noFloor: "true" }) === "See Berthoud homes for sale");
check("several towns, a million-plus floor",
  H.homeSearchLabel({ cities: "vail,avon", minPrice: "2500000" }) === "See homes for sale in these towns from $2.5M");
check("nothing named", H.homeSearchLabel({ noFloor: "true" }) === "See homes for sale");

console.log("\n7. The built site sends /search-homes to the hand-off");
const redirects = fs.readFileSync(path.join(ROOT, "site", "_redirects"), "utf8").split("\n");
const idx = (p) => redirects.findIndex((l) => l.split(/\s+/)[0] === p);
for (const p of ["/search-homes.html", "/search-homes/", "/search-homes"]) {
  check(`${p} is a forced rewrite to home-search`,
    /^\S+\s+\/\.netlify\/functions\/home-search\s+200!$/.test(redirects[idx(p)] || ""), redirects[idx(p)]);
}
check("each is the FIRST rule for its path (Netlify applies the first match)",
  ["/search-homes/", "/search-homes"].every((p) => redirects.filter((l) => l.split(/\s+/)[0] === p).length === 1));
const fn = fs.readFileSync(path.join(FN_DIR, "home-search.js"), "utf8");
check("the redirect is a 302, so a domain change is never cached by browsers", /statusCode: 302/.test(fn) && !/statusCode: 301/.test(fn));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
