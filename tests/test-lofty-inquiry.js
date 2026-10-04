// A buyer's search reaches Lofty as Lofty's own inquiry fields, not only a note.
//
// 2026-09-30 (API audit). "Email me new matches" put the buyer's towns, price,
// beds and baths into the note text only, which Lofty cannot search or alert on.
// POST /v1.0/leads/{leadId}/inquiry ("set a lead's home search wants") now carries
// them for a contact proven brand new; a returning client's record is left alone,
// and a failure changes nothing that worked before.
"use strict";
process.exitCode = 1;
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const R = require(`${FN_DIR}/lib/_lofty-returning.js`);
const EXISTING = "1148639689762408";
const NEWID = "1149000000000001";
function resp(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text };
}

(async () => {
  console.log("\n1. Reading the search off the form");
  let q = R.inquiryFromForm({ alert_query: "cities=Loveland,fort collins&minPrice=950000&maxPrice=2000000&beds=3&baths=2&propertyCategory=condo" });
  check("towns, price range, beds, baths and type", JSON.stringify(q) === JSON.stringify({
    locations: [{ city: "Loveland", state: "CO" }, { city: "Fort Collins", state: "CO" }],
    priceMin: 950000, priceMax: 2000000, bedroomsMin: 3, bathroomsMin: 2, propertyType: ["Condo", "Townhouse"],
  }), JSON.stringify(q));
  q = R.inquiryFromForm({ alert_query: "minPrice=950000" });
  check("no top price when the slider sat at its ceiling (maxPrice absent)", q && q.priceMin === 950000 && !("priceMax" in q));
  q = R.inquiryFromForm({ where_looking: "Loveland or Berthoud, CO" });
  check("a free-text answer naming known towns becomes areas", q && q.locations.map((l) => l.city).join() === "Loveland,Berthoud", JSON.stringify(q));
  check("free text that isn't all towns is left in the note only", R.inquiryFromForm({ where_looking: "near my mom in Loveland" }) === null);
  check("a form with no search sends nothing", R.inquiryFromForm({ message: "hello" }) === null);

  console.log("\n2. The call");
  let seen = [];
  const r = await R.placeInquiry(NEWID, { priceMin: 1 }, "k", {
    fetchImpl: async (url, init) => { seen.push({ url: String(url), init }); return resp(200, "{}"); },
  });
  check("POST /v1.0/leads/{id}/inquiry with the body", seen[0] && seen[0].init.method === "POST" &&
    seen[0].url === `https://api.lofty.com/v1.0/leads/${NEWID}/inquiry` && JSON.parse(seen[0].init.body).priceMin === 1, seen[0] && seen[0].url);
  check("recorded ok with the fields it set", r.ok === true && r.fields.join() === "priceMin");
  const bad = await R.placeInquiry(NEWID, { priceMin: 1 }, "k", { fetchImpl: async () => resp(400, "bad field") });
  check("a refusal is recorded, not thrown", bad.attempted === true && bad.ok === false && bad.httpStatus === 400);

  console.log("\n3. The form handler");
  const mem = {};
  const pushes = [];
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
    getStore: () => ({ get: async (k) => mem[k] || null, setJSON: async (k, v) => { if (k === "lofty-last-push.json") pushes.push(v); mem[k] = v; } }),
  } };
  for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  process.env.LOFTY_API_KEY = "k";
  process.env.RESEND_API_KEY = "r";
  const handler = require(`${FN_DIR}/submission-created.js`).handler;
  const event = (email) => ({ body: JSON.stringify({ payload: { form_name: "listing-alert-request", data: {
    name: "Pat Buyer", email, alert_criteria: "Loveland · $950,000+ · 3+ beds", alert_query: "cities=Loveland&minPrice=950000&beds=3",
  } } }) });
  const route = (existingLeads, inquiryStatus = 200) => {
    const calls = [];
    const inquiries = [];
    const f = async (url, init = {}) => {
      const s = String(url); const m = init.method || "GET";
      calls.push(`${m} ${s.replace(/^https:\/\/api\.(lofty|resend)\.com/, "")}`.split("?")[0]);
      if (/resend\.com/.test(s)) return resp(200, { id: "e1" });
      if (m === "GET" && /\/v1\.0\/leads\?/.test(s)) return resp(200, { leads: existingLeads });
      if (m === "POST" && /\/v1\.0\/leads$/.test(s)) return resp(200, `{"data":{"leadId": ${existingLeads.length ? EXISTING : NEWID}}}`);
      if (/\/inquiry$/.test(s)) { inquiries.push({ url: s, body: JSON.parse(init.body) }); return resp(inquiryStatus, inquiryStatus === 200 ? "{}" : "nope"); }
      if (/\/notes$/.test(s)) return resp(200, "{}");
      if (/\/v2\.0\/tasks$/.test(s)) return resp(200, `{"taskId": 77}`);
      if (/send-task-reminder$/.test(s)) return resp(200, { message: "ok" });
      if (/listCustomField/.test(s)) return resp(200, { data: R.WEBSITE_FIELDS.map((n) => ({ attributeName: n })) });
      if (m === "GET" && /\/v1\.0\/leads\/\d+$/.test(s)) return resp(200, { leadId: 1 });
      if (m === "PUT") return resp(200, "{}");
      return resp(404, "unexpected " + s);
    };
    return { f, calls, inquiries };
  };

  let rt = route([]);
  global.fetch = rt.f;
  await handler(event("new.buyer@example.com"));
  let rec = pushes[pushes.length - 1];
  check("new contact: the search is set on the new lead", rt.inquiries.length === 1 &&
    rt.inquiries[0].url.endsWith(`/v1.0/leads/${NEWID}/inquiry`) &&
    JSON.stringify(rt.inquiries[0].body) === JSON.stringify({ locations: [{ city: "Loveland", state: "CO" }], priceMin: 950000, bedroomsMin: 3 }),
    JSON.stringify(rt.inquiries));
  check("...recorded for /status", rec.inquiryResult && rec.inquiryResult.ok === true);
  check("...and the note and tags are unchanged", rt.calls.includes("POST /v1.0/notes") && rec.noteResult.ok === true);

  rt = route([{ leadId: Number(EXISTING), emails: ["pat@example.com"] }]);
  global.fetch = rt.f;
  await handler(event("pat@example.com"));
  rec = pushes[pushes.length - 1];
  check("returning client: their record's inquiry is left alone", rt.inquiries.length === 0 &&
    rec.inquiryResult.attempted === false, JSON.stringify(rec.inquiryResult));

  rt = route([], 422);
  global.fetch = rt.f;
  await handler(event("new.buyer@example.com"));
  rec = pushes[pushes.length - 1];
  check("Lofty refuses the inquiry: the lead, email and note are unaffected, the refusal is recorded",
    rec.ok === true && rec.emailResult.ok === true && rec.noteResult.ok === true &&
    rec.inquiryResult.ok === false && rec.inquiryResult.httpStatus === 422, JSON.stringify(rec.inquiryResult));

  console.log("\n4. /status says whether the search reached the contact");
  const record = pushes[pushes.length - 1];
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
    getStore: () => ({ get: async (k) => (k === "lofty-last-push.json" ? record : null), setJSON: async () => {}, list: async () => ({ blobs: [] }) }),
  } };
  for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  global.fetch = async () => { throw new Error("no live calls"); };
  const health = await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: { format: "json" } });
  const row = JSON.parse(health.body).checks.find((c) => /Lofty notification will fire/.test(c.name));
  check("a refused inquiry is named, with the note as the fallback", row && /home search was NOT set on the contact \(422\)/.test(row.detail), row && row.detail);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
