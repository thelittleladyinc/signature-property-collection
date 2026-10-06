// Website forms start the right Lofty nurture plan (Smart Plan).
//
// 2026-10-06. lib/_form-plans.js says which plan each form starts;
// submission-created.js sends that plan's lead type on the create and adds the
// plan's tag in a PUT AFTER the lead exists -- because a "Tag Changed -> tag
// added" Smart Plan does not fire for a tag that rides on the create -- and only
// for a contact proven brand new. This pins:
//
//   - the whole form -> plan table, on The Little Lady site ("main") and on the
//     Signature site;
//   - the homepage form's `looking_to` branches;
//   - every form the site renders (and every source label) has a decision;
//   - a plan tag is never in the create body, and is added after it, for a new
//     contact only, keeping every tag already on the lead;
//   - the lead type is on a new contact's create (the minimal retry included)
//     and never on a returning contact's, or one the lookup couldn't rule out;
//   - tags that can't be read are never written;
//   - a queued lead replayed later gets the same lead type and plan tag;
//   - lib/_form-plans.js (and lib/_lofty.js) are byte-identical to the other
//     site's copies.
//
// The same file runs in both repos; only SITE and SIBLING below differ.
//
// Nothing here calls Lofty: fetch is a fake Lofty that records every request.
"use strict";
process.exitCode = 1;
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const SITE = "signature";
const SIBLING = "thelittleladysellshomes";
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// Spelled out here, not imported, so a slip in the table fails this suite. The
// TOF tags use the EN DASH (U+2013) the plan names use, built from its code
// point so no editor can quietly swap it; S2's hyphen is plain ASCII.
const EN_DASH = String.fromCharCode(0x2013);
const TAG = {
  B1: `TOF ${EN_DASH} Website Buyer`,
  B1_FIRST_TIME: `TOF ${EN_DASH} First Time Buyer`,
  B1_VA: `TOF ${EN_DASH} VA Buyer`,
  S1: `TOF ${EN_DASH} Seller Ready to List`,
  S2: "S2 - Seller Options",
  DS1: `TOF ${EN_DASH} Downsizing`,
  SPC: `TOF ${EN_DASH} Luxury / Signature`,
  RECRUIT: "Agent Recruit",
};
const SELLER = 1;
const BUYER = 2;
const ALL_PLAN_TAGS = Object.values(TAG);

// form -> [tag, leadType] (leadType null = none), the same on both sites ...
const EXPECT = {};
const put = (forms, tag, type) => forms.forEach((f) => { EXPECT[f] = [tag, type]; });
put(["listing-inquiry", "listing-alert-request", "neighborhood-quiz", "buyers-page-inquiry", "relocation",
  "lifestyle-search", "buyers-guide", "relocation-guide", "windsor-commute", "eaton-relocation", "eaton-dining",
  "dream-home-finder", "open-house-list", "foreclosure-list-larimer", "foreclosure-list-weld", "loveland-buyers-guide",
  "west-greeley-inquiry", "ault-area-inquiry", "multigenerational-search", "land-property-review",
  "land-due-diligence-checklist", "teacher-homebuying", "signature-buyers-inquiry", "signature-resort-buyer-inquiry",
  "signature-concierge-inquiry", "signature-luxury-market", "luxury-market", "concierge-page-inquiry"], TAG.B1, BUYER);
put(["first-time-homebuyer"], TAG.B1_FIRST_TIME, BUYER);
put(["veteran-home-purchase"], TAG.B1_VA, BUYER);
put(["sellers-guide", "seller-local-proof", "loveland-market-seller", "sellers-page-inquiry"], TAG.S1, SELLER);
put(["free-home-valuation", "cash-offer"], TAG.S2, SELLER);
put(["signature-sellers-inquiry", "signature-expired-inquiry"], TAG.SPC, SELLER);
put(["noco-retirement"], TAG.DS1, SELLER);
put(["lpt-join", "lpt-join-co", "co-license-guide", "agent-coaching"], TAG.RECRUIT, null);
const NO_PLAN = ["contact", "testimonials-page-inquiry", "newsletter-signup", "rent-to-own-options",
  "market-conditions-inquiry", "some-form-nobody-has-built-yet", "", "__proto__", "constructor", "toString"];
// ... except on the Signature site (the luxury brand), where these four start
// the luxury seller plan.
const SIGNATURE_ONLY = { "sellers-page-inquiry": [TAG.SPC, SELLER], "sellers-guide": [TAG.SPC, SELLER],
  "seller-local-proof": [TAG.SPC, SELLER], "free-home-valuation": [TAG.SPC, SELLER] };

// The seller form the end-to-end checks submit: the home-value form, which
// starts S2 here and the luxury seller plan on the Signature site.
const SELLER_FORM = "free-home-valuation";
const [SELLER_TAG, SELLER_PLAN] = SITE === "signature" ? [TAG.SPC, "SPC_LUXURY"] : [TAG.S2, "S2_OPTIONS"];

const P = require(`${FN_DIR}/lib/_form-plans.js`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const expectPlan = (tag, type) => ({ planTags: tag ? [tag] : [], leadTypes: type ? [type] : [] });
const got = (form, data, site) => {
  const r = P.planForSubmission(form, data || {}, site ? { site } : undefined);
  return { planTags: r.planTags, leadTypes: r.leadTypes };
};

function resp(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}

const NEWID = "1149000000000001";
const EXISTING = "1148639689762408";

// A fake Lofty. GET /v1.0/leads/{id} answers the real shape -- { lead: { tags:
// [{ tagName }] } } -- unless readShape says otherwise; a PUT replaces the fields
// it carries, as Lofty's does; a create stores the lead it was sent.
function fakeLofty({ emailHits = [], phoneHits = [], searchStatus = 200, createStatuses = [200], noteStatus = 200,
  readShape = "lead", leads = {} } = {}) {
  const f = { log: [], posts: [], puts: [], leads: JSON.parse(JSON.stringify(leads)) };
  let creates = 0;
  f.fetch = async (url, init = {}) => {
    const s = String(url); const m = init.method || "GET";
    const p = s.replace(/^https:\/\/api\.(lofty|resend)\.com/, "").split("?")[0];
    const body = init.body ? JSON.parse(init.body) : null;
    f.log.push({ m, p, body });
    if (/resend\.com/.test(s)) return resp(200, { id: "e1" });
    if (m === "GET" && /\/v1\.0\/leads\?/.test(s)) {
      if (searchStatus !== 200) return resp(searchStatus, "down");
      return resp(200, { leads: /email=/.test(s) ? emailHits : phoneHits });
    }
    if (m === "POST" && /\/v1\.0\/leads$/.test(s)) {
      f.posts.push(body);
      const st = createStatuses[Math.min(creates, createStatuses.length - 1)];
      creates++;
      if (st !== 200) return resp(st, "refused");
      const id = emailHits.length ? EXISTING : NEWID;
      if (!f.leads[id]) f.leads[id] = { tags: [...(body.tags || body.tagsAdd || [])], phones: body.phones || [], cannotText: true };
      return resp(200, `{"data":{"leadId": ${id}}}`);
    }
    if (/\/notes$/.test(s)) {
      if (noteStatus !== 200) return resp(noteStatus, "notes down");
      return f.leads[String(body.leadId)] ? resp(200, "{}") : resp(404, { message: "errorCode=20006,errorMsg=Lead not exist" });
    }
    if (/\/v2\.0\/tasks$/.test(s)) return resp(200, `{"taskId": 77}`);
    if (/send-task-reminder$/.test(s)) return resp(200, { message: "ok" });
    if (/listCustomField/.test(s)) return resp(200, { data: [] });
    if (/custom-field$/.test(s)) return resp(200, "{}");
    if (/\/inquiry$/.test(s)) return resp(200, "{}");
    const one = s.match(/\/v1\.0\/leads\/(\d+)$/);
    if (one && m === "GET") {
      const l = f.leads[one[1]];
      if (!l) return resp(404, { message: "errorCode=20006,errorMsg=Lead not exist" });
      const lead = { leadId: Number(one[1]), phones: l.phones || [], cannotText: l.cannotText };
      if (readShape === "lead") lead.tags = l.tags.map((t) => ({ tagName: t, tagId: 1 }));
      if (readShape === "objects-without-names") lead.tags = l.tags.map(() => ({ id: 1 }));
      // readShape "no-tags": the field is simply not there (what this account once returned).
      return resp(200, { lead });
    }
    if (one && m === "PUT") {
      const l = f.leads[one[1]];
      f.puts.push({ id: one[1], body, before: l ? [...l.tags] : null, at: f.log.length - 1 });
      if (l) Object.assign(l, body);
      return resp(200, "{}");
    }
    return resp(404, `unexpected ${m} ${s}`);
  };
  return f;
}

// The handler and queue, with Blobs faked in memory.
const mem = {};
const pushes = [];
require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
  getStore: () => ({
    get: async (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : null),
    setJSON: async (k, v, o) => {
      if (o && o.onlyIfNew && k in mem) return { modified: false };
      if (k === "lofty-last-push.json") pushes.push(v);
      mem[k] = JSON.parse(JSON.stringify(v));
      return { modified: true };
    },
    delete: async (k) => { delete mem[k]; },
    list: async () => ({ blobs: [] }),
  }),
} };
for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
process.env.LOFTY_API_KEY = "k";
process.env.RESEND_API_KEY = "r";
delete process.env.FLODESK_API_KEY;
const handler = require(`${FN_DIR}/submission-created.js`).handler;
const L = require(`${FN_DIR}/lib/_lofty.js`);
const N = require(`${FN_DIR}/lib/_notify.js`);

const person = (extra) => ({ name: "Pat Buyer", email: "pat@example.com", phone: "(970) 555-0100", ...extra });
const event = (form, data) => ({ body: JSON.stringify({ payload: { form_name: form, data: person(data) } }) });
const last = () => pushes[pushes.length - 1] || {};
const quiet = async (fn) => {
  const keep = [console.log, console.warn, console.error];
  const lines = [];
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
  try { const r = await fn(); return { r, lines }; } finally { [console.log, console.warn, console.error] = keep; }
};
async function submit(f, form, data) {
  global.fetch = f.fetch;
  for (const k of Object.keys(mem)) delete mem[k];
  return quiet(() => handler(event(form, data)));
}
const tagsOnCreate = (b) => [...((b && b.tags) || []), ...((b && b.tagsAdd) || [])];
const planPuts = (f) => f.puts.filter((p) => Array.isArray(p.body.tags) && p.body.tags.some((t) => ALL_PLAN_TAGS.includes(t)));
const indexOf = (f, pred) => f.log.findIndex(pred);

function blobStore(seed) {
  const data = JSON.parse(JSON.stringify(seed || {}));
  return {
    data,
    get: async (k) => (k in data ? JSON.parse(JSON.stringify(data[k])) : null),
    setJSON: async (k, v, o) => { if (o && o.onlyIfNew && k in data) return { modified: false }; data[k] = JSON.parse(JSON.stringify(v)); return { modified: true }; },
    delete: async (k) => { delete data[k]; },
  };
}

(async () => {
  console.log("\n1. The plan tags, character for character");
  check("all eight plan tags, exactly", same(P.PLAN_TAGS, {
    B1_WEBSITE_BUYER: TAG.B1, B1_FIRST_TIME: TAG.B1_FIRST_TIME, B1_VA: TAG.B1_VA, S1_SELLER: TAG.S1,
    S2_OPTIONS: TAG.S2, DS1_DOWNSIZING: TAG.DS1, SPC_LUXURY: TAG.SPC, RECRUIT: TAG.RECRUIT,
  }), JSON.stringify(P.PLAN_TAGS));
  check("the TOF tags use an EN DASH (U+2013), never a hyphen",
    Object.values(P.PLAN_TAGS).filter((t) => t.startsWith("TOF")).length === 6 &&
    Object.values(P.PLAN_TAGS).filter((t) => t.startsWith("TOF")).every((t) => t.includes(` ${EN_DASH} `) && !t.includes(" - ")));
  check("S2's is a plain ASCII hyphen", P.PLAN_TAGS.S2_OPTIONS === "S2 - Seller Options" && !P.PLAN_TAGS.S2_OPTIONS.includes(EN_DASH));
  check("lead types: Seller 1, Buyer 2", P.LEAD_TYPE.SELLER === 1 && P.LEAD_TYPE.BUYER === 2);

  console.log("\n2. Every form, on The Little Lady site (main) and on the Signature site");
  for (const site of ["main", "signature"]) {
    const wrong = [];
    for (const [form, [tag, type]] of Object.entries(EXPECT)) {
      const want = site === "signature" && SIGNATURE_ONLY[form] ? expectPlan(...SIGNATURE_ONLY[form]) : expectPlan(tag, type);
      if (!same(got(form, {}, site), want)) wrong.push(`${form}: ${JSON.stringify(got(form, {}, site))}`);
    }
    check(`${site}: all ${Object.keys(EXPECT).length} planned forms start the right plan with the right lead type`, wrong.length === 0, wrong.join("; "));
    const leaked = NO_PLAN.filter((form) => !same(got(form, {}, site), expectPlan(null, null)));
    check(`${site}: contact, testimonials, newsletter, rent-to-own, market conditions and unknown forms start nothing`, leaked.length === 0, leaked.join(", "));
  }
  check("no site given = The Little Lady (main) site", same(got("sellers-page-inquiry"), expectPlan(TAG.S1, SELLER)) &&
    same(got("free-home-valuation"), expectPlan(TAG.S2, SELLER)));
  check("Signature: its seller page, seller guide, local proof and home value start the luxury seller plan",
    Object.keys(SIGNATURE_ONLY).every((f) => same(got(f, {}, "signature"), expectPlan(TAG.SPC, SELLER))));
  check("rent-to-own is untouched on both sites", same(got("rent-to-own-options", {}, "main"), expectPlan(null, null)) &&
    same(got("rent-to-own-options", {}, "signature"), expectPlan(null, null)));
  check("agent recruiting forms have a plan tag and NO lead type",
    ["lpt-join", "lpt-join-co", "co-license-guide", "agent-coaching"].every((f) => same(got(f), { planTags: [TAG.RECRUIT], leadTypes: [] })));
  const r1 = P.planForSubmission("listing-inquiry", {});
  r1.planTags.push("mutated"); r1.leadTypes.push(99);
  check("each call returns fresh arrays (a caller can't change the table)", same(got("listing-inquiry"), expectPlan(TAG.B1, BUYER)));

  console.log("\n3. The homepage form (home-lead) goes by `looking_to`");
  for (const site of ["main", "signature"]) {
    check(`${site}: sell -> S1 seller`, same(got("home-lead", { looking_to: "sell" }, site), expectPlan(TAG.S1, SELLER)));
    check(`${site}: both -> S1 seller`, same(got("home-lead", { looking_to: "both" }, site), expectPlan(TAG.S1, SELLER)));
    check(`${site}: value -> S2 seller`, same(got("home-lead", { looking_to: "value" }, site), expectPlan(TAG.S2, SELLER)));
    check(`${site}: buy -> B1 website buyer`, same(got("home-lead", { looking_to: "buy" }, site), expectPlan(TAG.B1, BUYER)));
    check(`${site}: invest, blank, missing or anything else -> nothing`,
      [{ looking_to: "invest" }, { looking_to: "" }, {}, { looking_to: "rent" }, { looking_to: "__proto__" }]
        .every((d) => same(got("home-lead", d, site), expectPlan(null, null))));
  }
  check("tolerates stray case and spaces", same(got("home-lead", { looking_to: " Sell " }), expectPlan(TAG.S1, SELLER)));

  console.log("\n4. Every form has a decision");
  const submission = fs.readFileSync(`${FN_DIR}/submission-created.js`, "utf8");
  const labelBlock = submission.slice(submission.indexOf("const SOURCE_LABELS"), submission.indexOf("function splitName"));
  const labels = new Set([...labelBlock.matchAll(/^\s*"([a-z-]+)":/gm)].map((m) => m[1]));
  const decided = new Set([...Object.keys(EXPECT), "home-lead", ...NO_PLAN]);
  const undecided = [...labels].filter((l) => !decided.has(l));
  check(`every source label (${labels.size}) is a planned form, the homepage form or a deliberate no-plan form`, undecided.length === 0, undecided.join(", "));
  const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".html")) out.push(p); } return out; };
  const rendered = new Set();
  for (const file of walk(path.join(ROOT, "site"))) for (const m of fs.readFileSync(file, "utf8").matchAll(/<form[^>]*\bname="([a-z-]+)"[^>]*>/g)) rendered.add(m[1]);
  const renderedUndecided = [...rendered].filter((n) => !decided.has(n));
  check(`every form rendered on the site (${rendered.size}) has a decision`, rendered.size > 0 && renderedUndecided.length === 0, renderedUndecided.join(", "));
  check("the module's own no-plan list is the one tested here", same([...P.FORMS_WITHOUT_PLAN].sort(), NO_PLAN.slice(0, 5).sort()));
  check(`this site asks for its own plans (site: "${SITE}")`, submission.includes(`planForSubmission(formName, data, { site: "${SITE}" })`));

  console.log("\n5. A new seller: lead type on the create, plan tag added after it");
  let f = fakeLofty();
  let out = await submit(f, SELLER_FORM, { address: "123 Main St, Loveland, CO 80538" });
  let rec = last();
  let create = f.posts[0];
  check("created with the Seller lead type", create && same(create.leadTypes, [SELLER]), JSON.stringify(create));
  check("texting still off on the create", create && create.cannotText === true);
  check("the plan tag is NOT in the create body (Lofty would not fire the plan for it)",
    create && !tagsOnCreate(create).some((t) => ALL_PLAN_TAGS.includes(t)), JSON.stringify(tagsOnCreate(create)));
  check("the create still carries the trigger tag and form tags as before",
    create && Array.isArray(create.tags) && create.tags[0] === "Hot Lead - Website" && create.tags.includes(SELLER_FORM));
  let pp = planPuts(f);
  const createAt = indexOf(f, (c) => c.m === "POST" && c.p === "/v1.0/leads");
  check(`the plan tag ("${SELLER_TAG}") is added in its own PUT after the create`, pp.length === 1 && pp[0].at > createAt &&
    pp[0].body.tags.includes(SELLER_TAG) && pp[0].id === NEWID, JSON.stringify(pp));
  check("that PUT keeps every tag the lead already had", pp[0] && pp[0].before && pp[0].before.length > 0 &&
    pp[0].before.every((t) => pp[0].body.tags.includes(t)), JSON.stringify(pp[0]));
  const triggerReAdd = f.puts.filter((p) => Array.isArray(p.body.tags) && p.body.tags.includes("Hot Lead - Website") &&
    !p.body.tags.some((t) => ALL_PLAN_TAGS.includes(t)));
  check("it comes after the trigger-tag re-add (which still happens, as before)", triggerReAdd.length > 0 && pp[0] &&
    pp[0].at > triggerReAdd[triggerReAdd.length - 1].at, JSON.stringify(f.puts.map((p) => p.body)));
  check("and nothing takes it off again", f.leads[NEWID].tags.includes(SELLER_TAG) && f.leads[NEWID].tags.includes("Hot Lead - Website"), JSON.stringify(f.leads[NEWID].tags));
  check("/status records the plan result", rec.planResult && rec.planResult.ok === true && same(rec.planResult.added, [SELLER_TAG]), JSON.stringify(rec.planResult));
  check("the log says what was added", out.lines.some((l) => l.includes(
    `Nurture plan ${SELLER_PLAN} for "${SELLER_FORM}": added tag "${SELLER_TAG}" after the create (lead type 1 sent on the create)`)),
  out.lines.filter((l) => /Nurture plan/.test(l)).join(" | "));

  console.log("\n6. A new buyer, a first-time buyer, a VA buyer, a downsizer, an agent");
  for (const [form, data, tag, type] of [
    ["listing-inquiry", { listing_address: "1 Elm St", inquiry_type: "Tour" }, TAG.B1, BUYER],
    ["first-time-homebuyer", { message: "hi" }, TAG.B1_FIRST_TIME, BUYER],
    ["veteran-home-purchase", { message: "hi" }, TAG.B1_VA, BUYER],
    ["noco-retirement", { message: "hi" }, TAG.DS1, SELLER],
    ["home-lead", { looking_to: "buy" }, TAG.B1, BUYER],
    ["home-lead", { looking_to: "sell" }, TAG.S1, SELLER],
    ["signature-sellers-inquiry", { address: "9 Peak Rd" }, TAG.SPC, SELLER],
  ]) {
    f = fakeLofty();
    await submit(f, form, data);
    pp = planPuts(f);
    check(`${form}${data.looking_to ? ` (${data.looking_to})` : ""}: lead type ${type} on the create, "${tag}" added after`,
      same(f.posts[0].leadTypes, [type]) && !tagsOnCreate(f.posts[0]).includes(tag) && pp.length === 1 && pp[0].body.tags.includes(tag),
      JSON.stringify({ create: f.posts[0], pp }));
  }
  f = fakeLofty();
  await submit(f, "lpt-join", { message: "split?" });
  pp = planPuts(f);
  // (Only The Little Lady site's handler adds the "Recruiting" tags; the Signature site has no recruiting forms.)
  check("lpt-join: no lead type on the create, \"Agent Recruit\" added after (create tags unchanged)",
    !("leadTypes" in f.posts[0]) && (SITE !== "main" || f.posts[0].tags.includes("Recruiting")) && !f.posts[0].tags.includes(TAG.RECRUIT) &&
    pp.length === 1 && pp[0].body.tags.includes(TAG.RECRUIT), JSON.stringify({ create: f.posts[0], pp }));

  console.log("\n7. Forms with no plan change nothing");
  for (const form of ["contact", "rent-to-own-options", "newsletter-signup", "home-lead"]) {
    f = fakeLofty();
    out = await submit(f, form, form === "home-lead" ? { looking_to: "invest" } : { message: "hi" });
    check(`${form}${form === "home-lead" ? " (invest)" : ""}: no lead type, no plan tag, everything else as before`,
      !("leadTypes" in f.posts[0]) && planPuts(f).length === 0 && last().planResult && last().planResult.attempted === false &&
      f.posts[0].tags[0] === "Hot Lead - Website", JSON.stringify({ create: f.posts[0], plan: last().planResult }));
  }
  if (SITE === "main") {
    f = fakeLofty();
    await submit(f, "rent-to-own-options", { message: "hi" });
    check("rent-to-own-options keeps Buyer Lead + Rent-to-Own and nothing new", f.posts[0].tags.includes("Rent-to-Own") &&
      f.posts[0].tags.includes("Buyer Lead") && !("leadTypes" in f.posts[0]) && planPuts(f).length === 0);
  }

  console.log("\n8. Returning contacts and contacts the lookup can't rule out: no lead type, no plan tag");
  f = fakeLofty({ emailHits: [{ leadId: Number(EXISTING), emails: ["pat@example.com"] }],
    leads: { [EXISTING]: { tags: ["Past Client"], phones: [] } } });
  out = await submit(f, SELLER_FORM, { address: "123 Main St" });
  rec = last();
  check("returning: the create adds its tags (tagsAdd) and carries NO lead type", Array.isArray(f.posts[0].tagsAdd) &&
    !("tags" in f.posts[0]) && !("leadTypes" in f.posts[0]), JSON.stringify(f.posts[0]));
  check("returning: no plan tag anywhere, before or after", !tagsOnCreate(f.posts[0]).some((t) => ALL_PLAN_TAGS.includes(t)) && planPuts(f).length === 0);
  check("returning: still the Call task, as before", f.log.some((c) => c.m === "POST" && c.p === "/v2.0/tasks"));
  check("returning: /status and the log say why", rec.planResult && /returning contact/.test(rec.planResult.skipped || "") &&
    out.lines.some((l) => l.includes(`Nurture plan ${SELLER_PLAN} for "${SELLER_FORM}": skipped -- returning contact`)), JSON.stringify(rec.planResult));

  f = fakeLofty({ phoneHits: [{ leadId: 42, phones: ["9705550100"] }] });
  await submit(f, "listing-inquiry", { listing_address: "1 Elm St" });
  check("phone-only match (could be a spouse): no lead type, no plan tag", !("leadTypes" in f.posts[0]) && planPuts(f).length === 0 &&
    /already on a Lofty contact/.test(last().planResult.skipped || ""), JSON.stringify(last().planResult));

  f = fakeLofty({ searchStatus: 503 });
  await submit(f, "listing-inquiry", { listing_address: "1 Elm St" });
  check("lookup down ('can't tell' is never 'new'): no lead type, no plan tag", !("leadTypes" in f.posts[0]) && planPuts(f).length === 0 &&
    /could not answer/.test(last().planResult.skipped || ""), JSON.stringify(last().planResult));

  f = fakeLofty({ noteStatus: 500 });
  await submit(f, "listing-inquiry", { listing_address: "1 Elm St" });
  check("the new contact didn't take the note (id unconfirmed): no plan tag", planPuts(f).length === 0 &&
    /did not take the note/.test(last().planResult.skipped || ""), JSON.stringify(last().planResult));

  console.log("\n9. Tags that can't be read are never written");
  f = fakeLofty({ readShape: "no-tags" });
  await submit(f, SELLER_FORM, { address: "123 Main St" });
  check("no 'tags' field on the read: no tag PUT at all (plan or trigger)", !f.puts.some((p) => Array.isArray(p.body.tags)) &&
    last().planResult && last().planResult.step === "tags-not-returned" && last().planResult.ok === false, JSON.stringify(last().planResult));
  check("the lead type still went on the create", same(f.posts[0].leadTypes, [SELLER]));
  f = fakeLofty({ readShape: "objects-without-names" });
  await submit(f, "listing-inquiry", { listing_address: "1 Elm St" });
  check("tags in a shape we don't understand: no tag PUT at all", !f.puts.some((p) => Array.isArray(p.body.tags)) &&
    last().planResult.step === "unreadable-tags", JSON.stringify(last().planResult));

  console.log("\n10. addPlanTags on its own");
  const unit = (leadTags, opts = {}) => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      const m = init.method || "GET"; calls.push({ m, body: init.body ? JSON.parse(init.body) : null });
      if (m === "GET") return opts.getStatus ? resp(opts.getStatus, opts.getBody || "down") : resp(200, { lead: { leadId: 7, tags: leadTags.map((t) => ({ tagName: t })) } });
      return resp(opts.putStatus || 200, "{}");
    };
    return calls;
  };
  let calls = unit(["Past Client", "Hot Lead - Website"]);
  let r = await quiet(() => N.addPlanTags("7", [TAG.B1], "k"));
  check("adds the missing plan tag in one PUT, keeping the rest", r.r.ok === true && same(r.r.added, [TAG.B1]) && calls.length === 2 &&
    same(calls[1].body, { tags: ["Past Client", "Hot Lead - Website", TAG.B1] }), JSON.stringify(calls));
  calls = unit(["Past Client", TAG.B1]);
  r = await quiet(() => N.addPlanTags("7", [TAG.B1], "k"));
  check("a plan tag already on the lead is left alone -- no PUT, never taken off", r.r.ok === true && r.r.step === "already-present" &&
    calls.length === 1, JSON.stringify(calls));
  calls = unit([], { getStatus: 500 });
  r = await quiet(() => N.addPlanTags("7", [TAG.B1], "k"));
  check("a failed read writes nothing", r.r.ok === false && r.r.step === "read" && calls.length === 1);
  calls = unit([], { getStatus: 404, getBody: { message: "errorCode=20006,errorMsg=Lead not exist" } });
  r = await quiet(() => N.addPlanTags("7", [TAG.B1], "k"));
  check("a lead that doesn't resolve writes nothing", r.r.step === "lead-missing" && calls.length === 1);
  calls = unit(["Past Client"], { putStatus: 500 });
  r = await quiet(() => N.addPlanTags("7", [TAG.B1], "k"));
  check("a refused PUT is reported, not claimed", r.r.ok === false && same(r.r.added, []) && r.r.httpStatus === 500);
  calls = unit([]);
  check("nothing to add, no lead or no key: no call", (await N.addPlanTags("7", [], "k")).attempted === false &&
    (await N.addPlanTags(null, [TAG.B1], "k")).attempted === false && (await N.addPlanTags("7", [TAG.B1], "")).attempted === false && calls.length === 0);

  console.log("\n11. The minimal-shape retry keeps the lead type (and texting off)");
  f = fakeLofty({ createStatuses: [400, 200] });
  await submit(f, SELLER_FORM, { address: "123 Main St" });
  check("retry body: Seller lead type, cannotText, no tags", f.posts.length === 2 && same(f.posts[1].leadTypes, [SELLER]) &&
    f.posts[1].cannotText === true && !("tags" in f.posts[1]) && !("tagsAdd" in f.posts[1]), JSON.stringify(f.posts[1]));
  check("and the plan tag still goes on after", planPuts(f).length === 1);
  check("minimalLead copies leadTypes only when present", same(L.minimalLead({ emails: ["a@b.co"], leadTypes: [2] }).leadTypes, [2]) &&
    !("leadTypes" in L.minimalLead({ emails: ["a@b.co"] })) && !("leadTypes" in L.minimalLead({ emails: ["a@b.co"], leadTypes: [] })));

  console.log("\n12. A queued lead, replayed later, starts the same plan");
  f = fakeLofty({ createStatuses: [500] });
  await submit(f, SELLER_FORM, { address: "123 Main St" });
  const queuedEntry = (mem[L.FAILED_PUSH_KEY] || [])[0];
  check("the failed create is queued with its plan", queuedEntry && queuedEntry.plan && same(queuedEntry.plan.planTags, [SELLER_TAG]) &&
    same(queuedEntry.plan.leadTypes, [SELLER]), JSON.stringify(queuedEntry && queuedEntry.plan));
  check("the queued body has the lead type and no plan tag", queuedEntry && same(queuedEntry.lead.leadTypes, [SELLER]) &&
    !tagsOnCreate(queuedEntry.lead).some((t) => ALL_PLAN_TAGS.includes(t)));
  check("/status's last-push record carries no form data", !("formData" in (mem[L.LAST_PUSH_KEY] || {})));

  const drain = async (fake, entry) => {
    global.fetch = fake.fetch;
    const store = blobStore({ [L.FAILED_PUSH_KEY]: [entry] });
    const res = await quiet(() => L.drainFailedPushes(store, "k"));
    return { res: res.r, lines: res.lines, store };
  };
  f = fakeLofty();
  let d = await drain(f, queuedEntry);
  pp = planPuts(f);
  check("new on the replay's lookup: recovered, created with the lead type, plan tag not on the create",
    d.res.recovered === 1 && same(f.posts[0].leadTypes, [SELLER]) && Array.isArray(f.posts[0].tagsAdd) &&
    !tagsOnCreate(f.posts[0]).some((t) => ALL_PLAN_TAGS.includes(t)) && f.posts[0].cannotText === true, JSON.stringify(f.posts[0]));
  check("then the plan tag is added after the create, keeping the lead's tags", pp.length === 1 && pp[0].body.tags.includes(SELLER_TAG) &&
    pp[0].at > indexOf(f, (c) => c.m === "POST" && c.p === "/v1.0/leads") && pp[0].before.every((t) => pp[0].body.tags.includes(t)), JSON.stringify(pp));
  check("and the replay log says so", d.lines.some((l) => l.includes(`nurture plan tag added (${SELLER_TAG})`)), d.lines.join(" | "));
  check("nothing left on the queue", (d.store.data[L.FAILED_PUSH_KEY] || []).length === 0);

  f = fakeLofty({ emailHits: [{ leadId: Number(EXISTING), emails: ["pat@example.com"] }], leads: { [EXISTING]: { tags: ["Past Client"], phones: [] } } });
  d = await drain(f, queuedEntry);
  check("found on the replay's lookup: no lead type on the create, no plan tag", d.res.recovered === 1 && !("leadTypes" in f.posts[0]) &&
    planPuts(f).length === 0 && f.log.some((c) => c.p === "/v2.0/tasks"), JSON.stringify(f.posts[0]));

  f = fakeLofty({ searchStatus: 503 });
  d = await drain(f, queuedEntry);
  check("replay lookup can't answer: no lead type, no plan tag", d.res.recovered === 1 && !("leadTypes" in f.posts[0]) && planPuts(f).length === 0,
    JSON.stringify(f.posts[0]));

  const older = { at: "2026-10-01T00:00:00.000Z", formName: SELLER_FORM,
    lead: { firstName: "Pat", emails: ["pat@example.com"], source: "x", notes: "NEW WEBSITE LEAD", tags: ["Hot Lead - Website", "Website Lead", SELLER_FORM] } };
  f = fakeLofty();
  d = await drain(f, older);
  check("an entry queued before plans existed replays exactly as before (no lead type, no plan tag)",
    d.res.recovered === 1 && !("leadTypes" in f.posts[0]) && planPuts(f).length === 0, JSON.stringify(f.posts[0]));

  check("the plan step runs after the trigger tag, before the returning-lead task",
    same(L.FOLLOWUP_STEPS, ["note", "tag", "planTags", "returning", "fields", "inquiry"]), JSON.stringify(L.FOLLOWUP_STEPS));
  const deferred = (steps) => ({ ...queuedEntry, loftyId: NEWID, followupsPending: ["planTags"],
    replay: { newId: NEWID, identity: { ok: true, anyMatch: false, leadId: null }, steps } });
  f = fakeLofty({ leads: { [NEWID]: { tags: ["Hot Lead - Website", "Website Lead"], phones: [] } } });
  d = await drain(f, deferred({ note: { ok: true } }));
  check("a run that ran out of time before the plan tag finishes it next run (no second create)", d.res.finished === 1 &&
    f.posts.length === 0 && planPuts(f).length === 1 && (d.store.data[L.FAILED_PUSH_KEY] || []).length === 0, JSON.stringify({ res: d.res, puts: f.puts }));
  f = fakeLofty({ leads: { [NEWID]: { tags: ["Hot Lead - Website"], phones: [] } } });
  d = await drain(f, deferred({ note: { ok: false } }));
  check("...but not when the note never confirmed the new contact", f.posts.length === 0 && planPuts(f).length === 0);

  console.log(`\n13. Same modules as the other site (${SIBLING})`);
  const other = path.join(ROOT, "..", SIBLING, "netlify", "functions", "lib", "_form-plans.js");
  if (fs.existsSync(other)) {
    check(`lib/_form-plans.js is byte-identical to ${SIBLING}'s copy`,
      fs.readFileSync(other, "utf8") === fs.readFileSync(`${FN_DIR}/lib/_form-plans.js`, "utf8"));
    const otherLofty = path.join(ROOT, "..", SIBLING, "netlify", "functions", "lib", "_lofty.js");
    if (fs.existsSync(otherLofty)) {
      check(`lib/_lofty.js is byte-identical to ${SIBLING}'s copy`,
        fs.readFileSync(otherLofty, "utf8") === fs.readFileSync(`${FN_DIR}/lib/_lofty.js`, "utf8"));
    }
  } else {
    console.log(`  --   ${SIBLING} checkout not present; skipping the _form-plans.js drift check`);
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
