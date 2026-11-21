"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { intakeBody } = require("../netlify/functions/lib/_hub-intake");
const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const client = read("build/listing_inquiry.js");
const contact = read("site/contact.html");
const shell = read("netlify/functions/lib/_listing-page-shell.html");
assert.ok(contact.includes(client) && shell.includes(client), "Published contact and listing use the same client");
const fields = [...contact.matchAll(/<input[^>]*name="([^"]+)"/g)].map(match => match[1]);
const anchor = {href: "https://signaturepropertycollection.com/contact.html?intent=showing&mls=IRE12345&address=2+Main+St"};
const source = "?utm_source=facebook&utm_medium=paid-social&utm_campaign=spring-2026&utm_ida=123456789012&utm_content=unsafe%40example.com&utm_term=private&fbclid=private";
function run(search, anchors, form, ui) {
  vm.runInNewContext(client, {
    URL, URLSearchParams, window: {location:{search}},
    document: {querySelectorAll:()=>anchors, forms:{namedItem:()=>form}, querySelector:selector=>ui[selector]},
  });
}
run(source, [anchor], null, {});
const target = new URL(anchor.href);
assert.equal(target.searchParams.get("utm_campaign"), "spring-2026");
for (const field of ["utm_term", "fbclid", "utm_content"]) assert.equal(target.searchParams.has(field), false);
function fill(search) {
  const values = Object.fromEntries([...fields, "message"].map(key => [key, {value:""}]));
  values.message.required = true;
  const ui = {h1:{textContent:"Contact Us"}, ".hero .lede":{}, button:{}};
  run(search, [], {elements:{namedItem:key=>values[key]}, querySelector:()=>ui.button}, ui);
  return {values, ui};
}
const {values, ui} = fill(target.search);
assert.equal(values.listing_mls.value, "IRE12345");
assert.equal(values.inquiry_type.value, "Tour");
assert.equal(values.listing_address.value, "2 Main St");
assert.equal(values.message.required, false);
assert.equal(ui.button.textContent, "Send my showing request");
const posted = Object.fromEntries(Object.entries(values).map(([key, field]) => [key, field.value]));
assert.deepEqual(intakeBody({form_name:"contact"}, posted, {kind:"form", site:"signature"}).raw.attribution,
  {utm_source:"facebook", utm_medium:"paid-social", utm_campaign:"spring-2026", utm_ida:"123456789012"});
const question = fill("?intent=question&mls=X-2&address=3+Main");
assert.equal(question.values.message.required, true);
assert.equal(question.values.inquiry_type.value, "Question");
assert.equal(question.ui.button.textContent, "Send my question");
for (const search of ["", "?intent=showing&mls=invalid%2Fid", "?intent=sale&mls=X-2"]) {
  const generic = fill(search);
  assert.equal(generic.ui.h1.textContent, "Contact Us");
  assert.equal(generic.values.inquiry_type.value, "");
  assert.equal(generic.values.message.required, true);
}
assert.match(contact, /name="contact" action="\/thank-you\.html\?from=contact" method="POST"/);
assert.match(contact, /name="terms_agree"[^>]*required/);
assert.doesNotMatch(contact, /name="sms_consent"[^>]*(?:checked|required)/);
console.log("All checks passed.");
