// Website leads -> Lofty through the Seller Intelligence hub (Wave 1b, 2026-10-17). OFF unless switched on.
//
// BYTE-IDENTICAL in thelittleladysellshomes and signature-property-collection (tests/test-lofty-via-hub.js
// compares the two when both checkouts sit side by side). It names neither site: the site's id comes in from
// lib/_notify.js BRAND_SITE.
//
// WHY. Lofty's PUT /leads/{id} replaces a lead's whole tag list, so two apps writing the same lead at the same
// moment can each read it, add their own tag and write -- and the first tag is lost. The hub (sellerintelligence
// hub-api, the "doorway") is the one writer: it checks the ONE shared opt-out list first, looks the person up
// (email, then phone), creates with cannotText:true, adds tags by read-merge-write AFTER the create, holds tags on
// a Do Not Contact lead, and holds a per-lead lease around every read-merge-write (hub migration 0055), so two
// apps writing the same lead take turns and never lose a tag.
//
// THE SWITCH. LOFTY_VIA_HUB -- exactly "on" (trimmed, any case) -- moves this site's form -> Lofty work to the hub:
//   - the lookup, the create (with the plan's lead type, which the hub sends on a create only), the form's tags
//     and the note: ONE POST /v1/lofty/lead (lib/_lofty.js postLead; lib/_lofty-returning.js findExistingLead
//     makes no call of its own -- the hub looks the person up);
//   - the nurture-plan tag, still only on a contact proven new (the hub answered action "created" and merged
//     false, and the note landed): a SECOND POST /v1/lofty/lead with create:false and only the plan tag, after
//     the hub's consent route says the lead may be emailed (lib/_notify.js addPlanTags). The hub's per-lead lease
//     makes that second write safe: it re-reads the lead under the lease, so the first push's tags (and any other
//     app's) are kept, and a writer that cannot get the lease in time is told "busy" and writes nothing;
//   - a note the push did not already carry: POST /v1/lofty/note (lib/_notify.js addLoftyNote);
//   - texting: never switched on. A yes is recorded in a note only (texting stays off until Lofty approves 10DLC
//     campaign 12744); the hub itself turns texting off when a new number arrives without a yes;
//   - the queue replay (lib/_lofty.js drainFailedPushes) goes through the same calls.
// Unset, or anything else ("yes", "true", "1"), keeps today's path exactly as it was.
//
// FAIL CLOSED. With the switch on, an operation the hub covers is NEVER sent with this site's own LOFTY_API_KEY.
// Hub not configured, unreachable, switched off (503), rate limited or busy: the submission goes to the existing
// retry queue with the reason. Held (Do Not Contact, several possible leads, nothing to look the person up by):
// the existing held-lead record, never replayed.
//
// 2026-10-24 (Christine: "Move each one, let's start with Lofty ... I need everything live"): EVERY Lofty call this
// site makes now goes through the hub when the switch is on -- nothing is left on this site's own key, and nothing is
// lost (sellerintelligence docs/hub-parity.md, "Websites"; profile `website`):
//   - the push also carries the home-value address (`address`, Lofty's `property` on a create; blanks only on an
//     existing lead), the form's tags IN the create body except the trigger tag (`create_tags`: a tag sent on the
//     create starts no "Tag Added" plan; the trigger tag goes on after the create, so its plan starts, exactly as
//     today's create + re-fire), the four website fields (`custom_fields`) and the search wishes (`inquiry`) -- the
//     hub writes those two only on a contact this push created and Lofty did not fold into another, after the note
//     landed: the sites' own "proven new" rule -- and the yes to texts (`sms_yes`; the hub decides, and keeps texting
//     off until 10DLC campaign 12744 is approved);
//   - a note longer than the hub takes in one go (5,000 characters) is sent in parts, the first with the push and the
//     rest right after it (/v1/lofty/note), so the consent record at the end of a long message is never cut off;
//   - the plan tag's second push names the lead the first push created (`lead_id`): no search, so a lead Lofty has
//     not indexed yet still gets its plan tag;
//   - the Call task + the agent's app push for a returning contact: POST /v1/lofty/task {lead_id, content,
//     due_in_minutes: 30, push_reminder: true} (the hub holds it on Do Not Contact, #dnc, cannotCall or an unreadable
//     lead, as the consent check here did);
//   - her listings reads (POST /v2.0/listings/search, GET /v1.0/listing): POST /v1/lofty/read listing_search /
//     listings; the /status probes (GET /v1.0/me, GET /v1.0/leads/{id}): /v1/lofty/read me / lead.
// LOFTY_API_KEY stays set (the existing "is Lofty set up here?" checks still read it), but with the switch on it is
// never sent anywhere.
//
// THE ROUTER COPY. LEADS_TO_ROUTER -- exactly "on" -- also records every website form lead with
// POST /v1/router/lead (source "<site>-form", kind "new", the form's own intent from ROUTER_FORM_INTENT when it
// has one, else its plan's intent, and an idempotency key built from Netlify's submission id), so Command
// Center's call list sees it. Rent-to-own leads are Christine's, like every other lead (Christine, 2026-10-23):
// they go to the router with intent "rent_to_own", whose rule NEW-RENT-TO-OWN starts no plan until she
// approves one. Cash-offer and FSBO leads go with their own intents, "seller_cash" and "seller_fsbo"
// (Christine, 2026-10-23), so the router's rules NEW-SELLER-CASH and NEW-SELLER-FSBO can match them. It runs alongside the alert email (lib/_notify.js sendLeadAlertEmail), never throws,
// has its own 4-second limit and never changes the Lofty path. Log lines carry no name, email or phone.
//
// Key handling: HUB_API_URL must be https; HUB_API_KEY goes in the x-hub-key header only (the vendored toolkit's
// client, lib/suite-kit/hub.js: redirects refused, never logged). Nothing here prints either value.
"use strict";

const crypto = require("crypto");
const { planForSubmission } = require("./_form-plans");

// The vendored toolkit (lib/suite-kit, CommonJS build; never edit it -- see its README), loaded on first use: a
// site on today's path never loads it, and the tests that load these lib files through their own module loader
// (tests/test-texting-preference.cjs) keep working. Netlify's bundler still sees these require() calls.
let kitCache = null;
function kit() {
  if (!kitCache) {
    kitCache = { hub: require("./suite-kit/hub"), lofty: require("./suite-kit/lofty"), contact: require("./suite-kit/contact") };
  }
  return kitCache;
}
const cleanTag = (t) => kit().lofty.cleanTag(t);
const normEmail = (v) => kit().contact.normEmail(v);
const normPhone = (v) => kit().contact.normPhone(v);
const textingOffReason = () => kit().lofty.TEXTING_OFF_REASON;

const HUB_TIMEOUT_MS = 20000;
// Below this, a hub call is not started at all (the caller queues instead).
const MIN_HUB_MS = 1500;
const ROUTER_TIMEOUT_MS = 4000;
// The hub takes at most 20 tags on a push.
const MAX_HUB_TAGS = 20;
// The hub keeps at most 5,000 characters of a note (push or /v1/lofty/note); a longer note goes in parts.
const MAX_HUB_NOTE = 5000;
// The Call task for a returning contact: due in 30 minutes, pushed to the agent's phone (lib/_lofty-returning.js).
const TASK_DUE_MINUTES = 30;
// What the hub path writes into a push result's responseBody, so lib/_lofty-returning.js leadIdFromResponse can
// tell "the hub created this contact" from "the hub found an existing one".
const HUB_MARK = "lofty-hub";
// The router's intent word for a form that says what the person wants more exactly than its plan does; it wins
// over the plan's intent. Rent-to-own leads are Christine's (2026-10-23) and start no plan; this intent puts them
// under the router's rule NEW-RENT-TO-OWN, which starts no plan until she approves one. A cash offer shares S2
// with the value forms, so its plan alone would say "home_value"; "seller_cash" is the router's rule
// NEW-SELLER-CASH (Christine, 2026-10-23).
const ROUTER_FORM_INTENT = Object.freeze({ "rent-to-own-options": "rent_to_own", "cash-offer": "seller_cash" });
// The router's intent words for a form's nurture plan (lib/_form-plans.js), when the plan says it. FSBO (the
// "fsbo-inquiry" form) is the router's rule NEW-SELLER-FSBO (Christine, 2026-10-23).
const ROUTER_INTENT = Object.freeze({
  B1_WEBSITE_BUYER: "buyer",
  B1_FIRST_TIME: "buyer",
  B1_VA: "buyer",
  S1_SELLER: "seller",
  S2_OPTIONS: "home_value",
  SPC_LUXURY: "seller_luxury",
  DS1_DOWNSIZING: "downsizing",
  FSBO: "seller_fsbo",
});

function exactlyOn(v) {
  return String(v == null ? "" : v).trim().toLowerCase() === "on";
}
// LOFTY_VIA_HUB: exactly "on" (trimmed, any case). Anything else is today's path.
function loftyViaHub(env) {
  return exactlyOn((env || process.env).LOFTY_VIA_HUB);
}
// LEADS_TO_ROUTER: exactly "on" (trimmed, any case).
function leadsToRouter(env) {
  return exactlyOn((env || process.env).LEADS_TO_ROUTER);
}

// Why the hub can't be asked, naming the setting and never its value; null when it can.
function hubProblem(env) {
  const e = env || process.env;
  const url = String(e.HUB_API_URL || "").trim();
  const key = String(e.HUB_API_KEY || "").trim();
  if (!url && !key) return "HUB_API_URL and HUB_API_KEY not set";
  if (!url) return "HUB_API_URL not set";
  if (!key) return "HUB_API_KEY not set";
  if (!kit().hub.hubConfigured({ baseUrl: url, key })) return "HUB_API_URL must be https and HUB_API_KEY a hub key (hub_ + 64 hex)";
  return null;
}

function client(o) {
  const e = o.env || process.env;
  const left = (o.deadline || Infinity) - Date.now();
  return kit().hub.createHubClient({
    baseUrl: String(e.HUB_API_URL || "").trim(),
    key: String(e.HUB_API_KEY || "").trim(),
    fetch: o.fetch,
    timeoutMs: Math.max(1, Math.min(o.timeoutMs || HUB_TIMEOUT_MS, left)),
  });
}

// A failed hub call in words: the hub's own status word and error text (it carries no personal data), never a key.
function whyNot(ans) {
  if (!ans || ans.reason === "not_configured") return "the hub is not configured (HUB_API_URL / HUB_API_KEY)";
  if (ans.reason === "unreachable") return "the hub did not answer";
  if (ans.reason === "bad_answer") return `the hub's answer could not be read${ans.status ? ` (HTTP ${ans.status})` : ""}`;
  const err = ans.body && typeof ans.body.error === "string" ? ans.body.error.slice(0, 160) : "";
  return `the hub refused (HTTP ${ans.status})${err ? `: ${err}` : ""}`;
}

const digits = (v) => {
  const s = v == null ? "" : String(v).trim();
  return /^[0-9]{1,20}$/.test(s) ? s : null;
};
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const short = (v, n) => String(v == null ? "" : v).slice(0, n || 200);

// ---- What this run learned from the hub, per lead ---------------------------------------------------------
// submission-created.js calls the follow-up steps (note, plan tag, the returning-lead step) with a lead id only,
// and the hub's /v1/lofty/lead finds a lead by email or phone, not by id. So the push remembers, for this lead,
// who the person is and what the hub answered. A Netlify function handles one submission at a time, so within
// one run this is that submission's answer; entries expire after ten minutes and never leave the function.
const MEMO_TTL_MS = 10 * 60 * 1000;
const MEMO_MAX = 50;
const recent = new Map();

function remember(leadId, info) {
  const id = digits(leadId);
  if (!id) return;
  recent.delete(id);
  recent.set(id, { ...info, at: Date.now() });
  while (recent.size > MEMO_MAX) recent.delete(recent.keys().next().value);
}

function recall(leadId) {
  const id = digits(leadId);
  const m = id ? recent.get(id) : null;
  if (!m || Date.now() - m.at > MEMO_TTL_MS) return null;
  return m;
}

function forget() { recent.clear(); }

// A queued lead whose EARLIER hub push created this contact (and was cut short before its tags or note landed):
// the replay finds it as an existing lead, but it is still the contact this site created.
function confirmCreated(leadId) {
  const m = recall(leadId);
  if (m) remember(leadId, { ...m, created: true, merged: false });
}

// The person a lead body (or a queued lead) describes.
function personOf(body) {
  const b = body || {};
  return {
    firstName: b.firstName || null,
    lastName: b.lastName || null,
    email: b.email || (Array.isArray(b.emails) && b.emails[0]) || null,
    phone: b.phone || (Array.isArray(b.phones) && b.phones[0]) || null,
  };
}

const hasLookupKey = (who) => !!(who && (normEmail(who.email) || normPhone(who.phone)));

// ---- The push ----------------------------------------------------------------------------------------------

// The home's address as the hub takes it (Lofty's `property`: streetAddress, city, state, zipCode), or null.
function hubAddress(p) {
  if (!p || typeof p !== "object") return null;
  const street = typeof p.streetAddress === "string" ? p.streetAddress.trim() : "";
  if (!street) return null;
  return { street, ...(p.city ? { city: String(p.city) } : {}), ...(p.state ? { state: String(p.state) } : {}),
    ...(p.zipCode ? { zip: String(p.zipCode) } : {}) };
}

// The search wishes as the hub takes them (hub-api/lofty.ts cleanInquiry: towns of letters with a two-letter state, at
// most 25; whole-dollar prices up to 1,000,000,000, the top not under the bottom; beds and baths over 0 up to 50; at
// most 10 property types), or null when nothing is left. Anything the hub would refuse is left out here, so a push is
// never refused (and stuck in the queue) for one odd value; the note keeps the whole search either way.
function hubInquiry(q) {
  if (!q || typeof q !== "object" || Array.isArray(q)) return null;
  const out = {};
  const word = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  if (Array.isArray(q.locations)) {
    const locs = q.locations.map((l) => ({ city: word(l && l.city, 40), state: word(l && l.state, 2) }))
      .filter((l) => l.city && /^[A-Za-z .'-]+$/.test(l.city) && l.state && /^[A-Za-z]{2}$/.test(l.state)).slice(0, 25)
      .map((l) => ({ city: l.city, state: l.state.toUpperCase() }));
    if (locs.length) out.locations = locs;
  }
  const int = (v) => (Number.isInteger(v) && v > 0 && v <= 1e9 ? v : null);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 50 ? v : null);
  const min = int(q.priceMin);
  const max = int(q.priceMax);
  if (min) out.priceMin = min;
  if (max && (!min || max >= min)) out.priceMax = max;
  if (num(q.bedroomsMin)) out.bedroomsMin = q.bedroomsMin;
  if (num(q.bathroomsMin)) out.bathroomsMin = q.bathroomsMin;
  if (Array.isArray(q.propertyType)) {
    const types = q.propertyType.map((t) => word(t, 40)).filter(Boolean).slice(0, 10);
    if (types.length) out.propertyType = types;
  }
  return Object.keys(out).length ? out : null;
}

// The parity options a push can carry. A hub that refuses a push carrying them as malformed (HTTP 400) is asked once
// more without them -- today's own-key path does the same with Lofty (its minimal-shape retry) -- so a lead is never
// stuck in the queue for an option; what was left out is in the note.
const PUSH_OPTIONS = Object.freeze(["create_tags", "address", "custom_fields", "inquiry"]);

// The /v1/lofty/lead body for one website push. ONE builder: the real push below and the side-by-side dry run
// (lib/_hub-side-by-side.js buildLeadAsk) both use it, so the hub is asked for real exactly what the dry run asked.
//   body: the lead body this site builds (firstName, lastName, emails/email, phones/phone, source, tags, tagsAdd,
//         notes, leadTypes, property);
//   x:    { triggerTag, leadTypes (instead of body.leadTypes), note (instead of body.notes; null = none),
//           websiteFields [{ attributeName, value }], inquiry {}, smsYes }.
// The form's tags go after the create by read-merge-write (`tags`); on a create they also ride IN the create body
// except the trigger tag (`create_tags`, only when the trigger tag is named), so only the trigger tag counts as
// "added" in Lofty and starts its plan -- today's create followed by the trigger tag's re-fire.
function leadAskFor(body, x) {
  const b = body || {};
  const o = x || {};
  const who = personOf(b);
  const tags = Array.from(new Set([...(Array.isArray(b.tags) ? b.tags : []), ...(Array.isArray(b.tagsAdd) ? b.tagsAdd : [])]
    .map(cleanTag).filter(Boolean))).slice(0, MAX_HUB_TAGS);
  const trigger = typeof o.triggerTag === "string" && o.triggerTag.trim() ? cleanTag(o.triggerTag) : null;
  const createTags = trigger ? tags.filter((t) => t !== trigger) : [];
  const types = Array.isArray(o.leadTypes) ? o.leadTypes : Array.isArray(b.leadTypes) ? b.leadTypes : [];
  const leadTypes = types.filter((n) => Number.isInteger(n) && n > 0 && n < 100);
  const note = o.note !== undefined ? o.note : typeof b.notes === "string" && b.notes.trim() ? b.notes : null;
  const ask = {
    ...(who.firstName ? { first_name: String(who.firstName) } : {}),
    ...(who.lastName ? { last_name: String(who.lastName) } : {}),
    ...(who.email ? { email: String(who.email) } : {}),
    ...(who.phone ? { phone: String(who.phone) } : {}),
    ...(b.source ? { source: String(b.source) } : {}),
    tags,
    ...(typeof note === "string" && note.trim() ? { note } : {}),
    ...(leadTypes.length ? { lead_types: leadTypes } : {}),
    create: true,
  };
  if (createTags.length) ask.create_tags = createTags;
  const address = hubAddress(b.property);
  if (address) ask.address = address;
  const fields = (Array.isArray(o.websiteFields) ? o.websiteFields : [])
    .filter((f) => f && typeof f.attributeName === "string" && f.attributeName && f.value != null && String(f.value) !== "");
  if (fields.length) ask.custom_fields = Object.fromEntries(fields.map((f) => [f.attributeName, String(f.value)]));
  const inquiry = hubInquiry(o.inquiry);
  if (inquiry) ask.inquiry = inquiry;
  if (o.smsYes === true) ask.sms_yes = true;
  return ask;
}

// A note in parts the hub keeps whole (at most MAX_HUB_NOTE characters each, cut at a line break where one is near).
// Parts after the first say so, so a reader in Lofty sees they belong together.
const NOTE_PART_ROOM = MAX_HUB_NOTE - 100;
function noteParts(text) {
  const s = String(text == null ? "" : text);
  if (s.length <= MAX_HUB_NOTE) return s.trim() ? [s] : [];
  const parts = [];
  let rest = s;
  while (rest.length > NOTE_PART_ROOM) {
    let cut = rest.lastIndexOf("\n", NOTE_PART_ROOM);
    if (cut < NOTE_PART_ROOM / 2) cut = NOTE_PART_ROOM;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) parts.push(rest);
  return parts.filter((p) => p.trim()).map((p, i, all) => (i === 0 ? p : `(note continued, part ${i + 1} of ${all.length})\n${p}`));
}

// The note parts after the first, each a /v1/lofty/note on this lead. -> the parts that did not land.
async function sendNoteRest(leadId, rest, o) {
  const left = [];
  for (const part of rest) {
    if (left.length || (o.deadline || Infinity) - Date.now() < MIN_HUB_MS) { left.push(part); continue; }
    const ans = await client(o).loftyNote({ lead_id: leadId, content: part });
    if (!(ans.ok && ans.body && ans.body.status === "noted")) left.push(part);
  }
  return left;
}

// One POST /v1/lofty/lead for a website lead: lookup, create (cannotText:true, the lead type, the form's tags except
// the trigger tag and the home's address on a create only), the form's tags after the create, the note, and -- only
// on a contact this push created -- the website fields and the search wishes. Returns the shape lib/_lofty.js
// postLead returns, so submission-created.js and the queue read it exactly as before:
//   ok:true  -> the lead exists in Lofty; responseBody carries its id (and, only when the hub CREATED it and
//               nothing merged, created_lead_id -- what makes a contact "proven new");
//   ok:false -> manualReview:true for a hold (never replayed), otherwise queued for the next drain.
// opts: { deadline, withoutNote, env, fetch, triggerTag, websiteFields, inquiry, smsYes }.
async function pushLeadViaHub(body, opts) {
  const o = opts || {};
  const b = body || {};
  const base = { payloadShape: "hub", viaHub: true };
  const who = personOf(b);
  const problem = hubProblem(o.env);
  if (problem) {
    return { ...base, ok: false, httpStatus: 0, hubStatus: "not_configured",
      responseBody: `not sent: ${problem}; queued for the hub (this site's own Lofty key is not used while LOFTY_VIA_HUB is on)` };
  }
  if (!hasLookupKey(who)) {
    const reason = "no usable email or phone to look the person up by: not created in Lofty; add them by hand";
    return { ...base, ok: false, manualReview: true, httpStatus: "held", hubStatus: "held", reason, responseBody: reason };
  }
  if ((o.deadline || Infinity) - Date.now() < MIN_HUB_MS) {
    return { ...base, ok: false, httpStatus: 0, hubStatus: "no_time", responseBody: "no time left to ask the hub; queued" };
  }
  const allTags = new Set([...(Array.isArray(b.tags) ? b.tags : []), ...(Array.isArray(b.tagsAdd) ? b.tagsAdd : [])].map(cleanTag).filter(Boolean));
  if (allTags.size > MAX_HUB_TAGS) console.warn(`Lofty via hub: ${allTags.size - MAX_HUB_TAGS} tag(s) over the hub's limit of ${MAX_HUB_TAGS} not sent.`);
  const fullNote = !o.withoutNote && typeof b.notes === "string" && b.notes.trim() ? b.notes : null;
  const parts = fullNote ? noteParts(fullNote) : [];
  const ask = leadAskFor(b, { triggerTag: o.triggerTag, note: parts[0] || null, websiteFields: o.websiteFields,
    inquiry: o.inquiry, smsYes: o.smsYes === true });
  let ans = await client(o).loftyLead(ask);
  let optionsDropped = [];
  let firstAttempt = null;
  const carried = PUSH_OPTIONS.filter((k) => k in ask);
  if (!ans.ok && ans.status === 400 && carried.length && (o.deadline || Infinity) - Date.now() >= MIN_HUB_MS) {
    firstAttempt = { httpStatus: 400, responseBody: whyNot(ans) };
    console.error(`Lofty via hub: the hub refused the push as malformed (HTTP 400); asking once more without ${carried.join(", ")}.`);
    for (const k of carried) delete ask[k];
    optionsDropped = carried;
    ans = await client(o).loftyLead(ask);
  }
  if (!ans.ok) {
    return { ...base, ok: false, httpStatus: ans.status || 0, hubStatus: ans.reason, ...(firstAttempt ? { firstAttempt } : {}),
      responseBody: `${whyNot(ans)}; queued, nothing sent with this site's own Lofty key` };
  }
  if (optionsDropped.length) base.payloadShape = `hub (without ${optionsDropped.join(", ")}: the hub refused them)`;
  const j = ans.body || {};
  const leadId = digits(j.lead_id);
  const created = j.action === "created";
  const merged = j.merged === true;
  const shared = j.shared_list && typeof j.shared_list === "object" ? j.shared_list : {};
  const hub = {
    status: short(j.status, 20), leadId, action: j.action || null, created, merged, matchedBy: j.matched_by || null,
    noteAdded: j.note_added === true, tagsAdded: list(j.tags_added), tagsHeld: list(j.tags_held), tagsDropped: list(j.tags_dropped),
    doNotContact: j.do_not_contact === true || j.held_by === "do_not_contact" || shared.doNotContact === true,
    emailBlocked: shared.emailBlocked === true || shared.emailOptOut === true || j.email_turned_off === true,
    textingTurnedOff: j.texting_turned_off === true, code: j.code || null,
    // What the parity options did (null when not asked or not reported).
    address: ask.address ? (typeof j.address === "string" ? short(j.address, 20) : null) : null,
    fields: ask.custom_fields ? (typeof j.fields === "string" ? short(j.fields, 40) : null) : null,
    inquiry: ask.inquiry ? (typeof j.inquiry === "string" ? short(j.inquiry, 40) : null) : null,
    createTagsSent: list(ask.create_tags).length, createBodyMerged: j.create_body_merged === true,
    smsYes: ask.sms_yes === true, textingNotEnabled: typeof j.texting_not_enabled === "string" ? short(j.texting_not_enabled, 200) : null,
    noteParts: parts.length,
    ...(optionsDropped.length ? { optionsDropped } : {}),
  };
  let notePending = [];
  if (leadId && hub.noteAdded && parts.length > 1) {
    notePending = await sendNoteRest(leadId, parts.slice(1), o);
    if (notePending.length) console.error(`Lofty via hub: ${notePending.length} of ${parts.length - 1} later part(s) of a long note did not land on lead ${leadId}.`);
  }
  hub.notePartsPending = notePending.length;
  if (leadId) {
    remember(leadId, { person: who, created, merged, noteAdded: hub.noteAdded, noteText: fullNote, notePending,
      doNotContact: hub.doNotContact, emailBlocked: hub.emailBlocked, source: b.source || null, smsYes: hub.smsYes,
      textingNotEnabled: hub.textingNotEnabled });
  }
  if ((j.status === "created" || j.status === "updated") && j.ok !== false && leadId) {
    return {
      ...base, ok: true, httpStatus: 200, hubStatus: j.status, hub, ...(firstAttempt ? { firstAttempt } : {}),
      responseBody: JSON.stringify({ via: HUB_MARK, data: { leadId }, created_lead_id: created && !merged ? leadId : null,
        action: hub.action, merged }),
    };
  }
  const reason = short(j.reason || j.code || j.status || "held by the hub", 200);
  if (j.held_by === "do_not_contact") {
    const why = "Do Not Contact on the shared opt-out list: nothing created or tagged in Lofty";
    return { ...base, ok: false, manualReview: true, doNotContact: true, httpStatus: "held", hubStatus: "held", hub, reason: why, responseBody: why };
  }
  const transient = j.status === "rate_limited" || j.status === "not_configured" || j.code === "lookup_failed" ||
    j.code === "busy" || j.code === "rate_limited";
  if (!transient && j.needs_review === true) {
    const why = `${j.code || "needs review"}: ${reason}`;
    return { ...base, ok: false, manualReview: true, httpStatus: "held", hubStatus: "held", hub, reason: why, responseBody: why,
      ...(list(j.match_lead_ids).length ? { matchLeadIds: list(j.match_lead_ids) } : {}) };
  }
  return {
    ...base, ok: false, httpStatus: j.status || "held", hubStatus: j.status || "held", hub,
    ...(Number(j.retry_after) > 0 ? { retryAfter: Number(j.retry_after) } : {}),
    responseBody: `hub ${j.status || "held"}${j.code ? ` (${j.code})` : ""}: ${reason}; queued`,
  };
}

// What the push's website fields / search wishes came to, in the shape lib/_lofty-returning.js setWebsiteFields /
// placeInquiry return. kind: "fields" | "inquiry"; asked: what was sent (the field list, or the inquiry).
function hubExtraResult(kind, hub, asked) {
  const names = kind === "fields" ? (Array.isArray(asked) ? asked.map((f) => f && f.attributeName).filter(Boolean) : [])
    : asked && typeof asked === "object" ? Object.keys(asked) : [];
  if (!names.length) return { attempted: false };
  const v = hub ? hub[kind] : null;
  if (v === "written") return { attempted: true, ok: true, viaHub: true, step: "written", fields: names };
  if (v === "skipped_not_new") return { attempted: false, viaHub: true, reason: "the hub writes these only on a contact this push created; they are in the note" };
  if (!v) return { attempted: false, viaHub: true, reason: "the hub's push did not write them; they are in the note" };
  return { attempted: true, ok: false, viaHub: true, step: v, error: `the hub answered "${v}"`, fields: names };
}

// The contact the hub created in this push, or null when it found or merged into an existing one -- read from a
// postLead responseBody. undefined when the text is not a hub answer (today's path reads Lofty's own answer).
function hubCreatedLeadId(text) {
  if (typeof text !== "string" || text.indexOf(HUB_MARK) < 0) return undefined;
  let j;
  try { j = JSON.parse(text); } catch (err) { return undefined; }
  if (!j || typeof j !== "object" || j.via !== HUB_MARK) return undefined;
  return digits(j.created_lead_id);
}

// ---- Note, consent, plan tag, texting -----------------------------------------------------------------------

// A note on a lead. The push already carried the form's note; that one is not sent twice (only any later part of a
// long note that did not land with it). A note longer than the hub keeps goes in parts (noteParts); the first part
// landing is what confirms the lead (ok), and parts that did not land are counted.
async function noteViaHub(leadId, content, opts) {
  const o = opts || {};
  const id = digits(leadId);
  if (!id || !content) return { attempted: false, viaHub: true };
  const m = recall(id);
  const problem = hubProblem(o.env);
  if (m && m.noteAdded && m.noteText === content) {
    const pending = Array.isArray(m.notePending) ? m.notePending : [];
    if (!pending.length) return { attempted: true, ok: true, viaHub: true, step: "with-push" };
    const left = problem ? pending : await sendNoteRest(id, pending, o);
    remember(id, { ...m, notePending: left });
    return { attempted: true, ok: true, viaHub: true, step: "with-push", ...(left.length ? { notePartsPending: left.length } : {}) };
  }
  if (problem) return { attempted: false, ok: false, viaHub: true, error: problem };
  const parts = noteParts(content);
  if (!parts.length) return { attempted: false, viaHub: true };
  const ans = await client(o).loftyNote({ lead_id: id, content: parts[0] });
  if (!ans.ok) return { attempted: true, ok: false, viaHub: true, httpStatus: ans.status || 0, error: whyNot(ans) };
  const j = ans.body || {};
  const ok = j.status === "noted";
  if (!ok) return { attempted: true, ok, viaHub: true, step: short(j.status, 20), error: short(j.reason || j.code || j.status) };
  const left = parts.length > 1 ? await sendNoteRest(id, parts.slice(1), o) : [];
  if (left.length) console.error(`Lofty via hub: ${left.length} of ${parts.length - 1} later part(s) of a long note did not land on lead ${id}.`);
  return { attempted: true, ok, viaHub: true, step: "noted", ...(parts.length > 1 ? { noteParts: parts.length } : {}),
    ...(left.length ? { notePartsPending: left.length } : {}) };
}

// What the hub's consent route says about one lead. Anything but "found" is unknown, and unknown holds.
async function consentViaHub(leadId, opts) {
  const o = opts || {};
  const id = digits(leadId);
  if (!id) return { known: false, reason: "no lead id" };
  const problem = hubProblem(o.env);
  if (problem) return { known: false, reason: problem };
  const ans = await client(o).loftyConsent({ lead_id: id });
  if (!ans.ok) return { known: false, reason: whyNot(ans) };
  const j = ans.body || {};
  if (j.status !== "found") return { known: false, reason: `the hub's consent answer was "${short(j.status, 20)}"${j.code ? ` (${short(j.code, 40)})` : ""}` };
  return {
    known: true, doNotContact: j.do_not_contact === true, emailOptOut: j.email_opt_out === true,
    mayEmail: j.may_email === true, mayCall: j.may_call === true,
  };
}

// The nurture-plan tag on a contact proven new: a second /v1/lofty/lead with create:false, the plan tag only, and the
// lead the first push created named by its id (`lead_id`: no search, so a lead Lofty has not indexed yet still gets
// it; the email and phone ride along only so the hub checks the shared opt-out list). Refused when this run's push
// says the hub did not create the contact, and held unless the hub's consent route says the lead may be emailed (a
// plan emails). opts.person: who the lead is, when this run has no memory of the push (a queued lead finished on a
// later run).
async function planTagsViaHub(leadId, planTags, opts) {
  const o = opts || {};
  const id = digits(leadId);
  const wanted = Array.from(new Set((Array.isArray(planTags) ? planTags : []).map(cleanTag).filter(Boolean)));
  const out = (x) => ({ planTags: wanted, added: [], viaHub: true, ...x });
  if (!id || !wanted.length) return { attempted: false, viaHub: true };
  const m = recall(id);
  if (m && !(m.created && !m.merged)) return out({ attempted: false, ok: false, step: "not-new", error: "the hub did not create this contact" });
  if (m && m.doNotContact) return out({ attempted: false, ok: false, step: "dnc", error: "Do Not Contact: no plan tag" });
  if (m && m.emailBlocked) return out({ attempted: false, ok: false, step: "email-opt-out", error: "email opted out: no plan tag" });
  const who = (m && m.person) || (o.person ? personOf(o.person) : null) || {};
  const problem = hubProblem(o.env);
  if (problem) return out({ attempted: false, ok: false, step: "hub", error: problem });
  const c = await consentViaHub(id, o);
  if (!c.known) return out({ attempted: false, ok: false, step: "consent-unknown", error: `plan tag held: ${c.reason}` });
  if (c.doNotContact) return out({ attempted: false, ok: false, step: "dnc", error: "Do Not Contact: no plan tag" });
  if (!c.mayEmail) return out({ attempted: false, ok: false, step: "email-opt-out", error: "the lead may not be emailed: no plan tag" });
  const ans = await client(o).loftyLead({
    lead_id: id,
    ...(who.email ? { email: String(who.email) } : {}),
    ...(who.phone ? { phone: String(who.phone) } : {}),
    tags: wanted, create: false,
  });
  if (!ans.ok) return out({ attempted: true, ok: false, step: "hub", httpStatus: ans.status || 0, error: whyNot(ans) });
  const j = ans.body || {};
  const landed = digits(j.lead_id);
  if ((j.status === "updated" || j.status === "created") && j.ok !== false) {
    if (landed !== id) return out({ attempted: true, ok: false, step: "other-lead", error: `the hub found lead ${landed || "(none)"}, not ${id}` });
    const added = list(j.tags_added).filter((t) => wanted.includes(t));
    return out({ attempted: true, ok: true, step: added.length ? "added" : "already-present", added,
      alreadyPresent: wanted.filter((t) => !added.includes(t)) });
  }
  return out({ attempted: true, ok: false, step: j.status === "rate_limited" ? "busy" : "held",
    error: short(j.reason || j.code || j.status || "held by the hub") });
}

// Texting on the hub path: the push hands the hub the yes (sms_yes) and the hub decides; it keeps texting off until
// 10DLC campaign 12744 is approved and records the yes in the lead's note. Without a yes the hub has already turned
// texting off itself if a new number arrived.
async function textingViaHub(leadId, consentGiven, opts) {
  if (consentGiven !== true) {
    return { attempted: false, ok: true, changed: false, textingEnabled: false, viaHub: true,
      reason: "hub path: texting stays off (the hub turns it off itself when a new number arrives without a yes)" };
  }
  const id = digits(leadId);
  if (!id) return { attempted: false, changed: false, textingEnabled: false, viaHub: true, textingNotEnabled: `no lead id; ${textingOffReason()}` };
  // The push carried the yes (sms_yes): the hub decided -- texting stays off until 10DLC campaign 12744 is approved,
  // and only ever on when every phone on the lead is the number that said yes -- and wrote why into the push's note.
  const m = recall(id);
  if (m && m.smsYes && m.noteAdded) {
    return { attempted: true, ok: true, changed: false, textingEnabled: false, viaHub: true, step: "held",
      textingNotEnabled: `${m.textingNotEnabled || textingOffReason()} (the hub recorded the yes in the lead's note)` };
  }
  const n = await noteViaHub(id, `SMS consent: yes on this form, but ${textingOffReason()}.`, opts);
  return {
    attempted: true, ok: n.ok === true, changed: false, textingEnabled: false, viaHub: true, step: "held",
    textingNotEnabled: `${textingOffReason()} (the yes is recorded in a note${n.ok ? "" : `; that note did not land: ${n.error || "failed"}`})`,
  };
}

// What the hub path does where today's path re-fires the trigger tag: nothing for a contact the hub created (the
// trigger tag went on after the create, so Lofty sees it as added and its plan starts), and for a contact it found or
// merged into, the details lib/_notify.js needs for the Call task (the website profile takes no tag off, so a tag
// already on a lead cannot be taken off and put back through the hub).
function afterPush(leadId) {
  const m = recall(leadId);
  if (!m) return { kind: "unknown" };
  if (m.created && !m.merged) return { kind: "new" };
  const who = m.person || {};
  return {
    kind: "returning",
    details: {
      label: String(m.source || "website form").replace(/^.*? - /, ""),
      name: [who.firstName, who.lastName].filter(Boolean).join(" "),
      phone: who.phone || null, email: who.email || null,
    },
  };
}

// ---- The Call task and the reads ----------------------------------------------------------------------------

// The Call task + the agent's app push for a returning contact: ONE POST /v1/lofty/task {lead_id, content,
// due_in_minutes: 30, push_reminder: true} -- what lib/_lofty-returning.js alertReturningLead sends Lofty itself
// (POST /v2.0/tasks, then the push). The hub reads the lead first and creates no task on Do Not Contact (the lead's
// tags or the shared list), #dnc, cannotCall, a phone on the shared do-not-call list, or a lead it cannot read.
// Answers in alertReturningLead's shape. Never throws.
async function taskViaHub(leadId, content, opts) {
  const o = opts || {};
  const id = digits(leadId);
  if (!id || !content) return { attempted: false, viaHub: true };
  const problem = hubProblem(o.env);
  if (problem) return { attempted: false, ok: false, step: "hub", viaHub: true, error: `call task not sent: ${problem}` };
  if ((o.deadline || Infinity) - Date.now() < MIN_HUB_MS) {
    return { attempted: false, ok: false, step: "hub", viaHub: true, error: "call task not sent: no time left to ask the hub" };
  }
  let ans;
  try {
    ans = await client(o).loftyTask({ lead_id: id, content: String(content).slice(0, 500), due_in_minutes: TASK_DUE_MINUTES, push_reminder: true });
  } catch (err) {
    ans = null;
  }
  if (!ans || !ans.ok) return { attempted: true, ok: false, step: "task", viaHub: true, httpStatus: (ans && ans.status) || 0, error: whyNot(ans) };
  const j = ans.body || {};
  if (j.status === "created") {
    const taskId = digits(j.task_id);
    const pushed = j.pushed === true;
    return { attempted: true, ok: pushed, step: pushed ? "pushed" : "push", viaHub: true, ...(taskId ? { taskId } : {}),
      ...(pushed ? {} : { error: "the task was created, but the push to the agent's phone did not go out" }) };
  }
  const why = short(j.reason || j.code || j.status || "no answer", 160);
  if (j.status === "held" && j.code === "do_not_contact") {
    return { attempted: false, ok: false, step: "do-not-contact", viaHub: true, skipped: "Do Not Contact: no call task" };
  }
  if (j.status === "held" && j.code === "may_not_call") {
    return { attempted: false, ok: false, step: "may-not-call", viaHub: true, skipped: `the lead may not be called: no call task (${why})` };
  }
  if (j.status === "held") return { attempted: false, ok: false, step: "consent", viaHub: true, error: `call task held: ${why}` };
  return { attempted: true, ok: false, step: "task", viaHub: true, error: `hub ${short(j.status, 20) || "answer"}: ${why}`,
    ...(Number(j.retry_after) > 0 ? { retryAfter: Number(j.retry_after) } : {}) };
}

// One Lofty read through the hub: POST /v1/lofty/read (her listings: listing_search / listings; the /status probes:
// me / lead). -> { ok: true, httpStatus, data } | { ok: false, status, httpStatus, error }. Never throws.
//   opts: { env, fetch, timeoutMs }
async function readViaHub(ask, opts) {
  const o = opts || {};
  const problem = hubProblem(o.env);
  if (problem) return { ok: false, status: "not_configured", httpStatus: 0, error: problem };
  let ans;
  try { ans = await client(o).loftyRead(ask); } catch (err) { ans = null; }
  if (!ans || !ans.ok) return { ok: false, status: (ans && ans.reason) || "refused", httpStatus: (ans && ans.status) || 0, error: whyNot(ans) };
  const j = ans.body || {};
  if (j.status === "ok") return { ok: true, status: "ok", httpStatus: Number(j.http_status) || 200, data: j.data === undefined ? null : j.data };
  const st = short(j.status, 20) || "failed";
  return {
    ok: false, status: st,
    httpStatus: Number(j.http_status) || (st === "rate_limited" ? 429 : st === "not_found" ? 404 : 0),
    ...(Number(j.retry_after) > 0 ? { retryAfter: Number(j.retry_after) } : {}),
    error: `the hub's Lofty read answered "${st}"${j.code ? ` (${short(j.code, 40)})` : ""}`,
  };
}

// ---- The router copy ----------------------------------------------------------------------------------------

function routerKey(site, form, d) {
  const safe = (v, n) => String(v == null ? "" : v).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, n);
  const f = safe(form || "form", 60) || "form";
  const id = safe(d.submissionId, 100);
  if (id) return `${site}-form:${f}:${id}`;
  const h = crypto.createHash("sha256").update(JSON.stringify([d.name || "", d.email || "", d.phone || "", d.noteText || ""]))
    .digest("hex").slice(0, 32);
  return `${site}-form:${f}:h${h}`;
}

// Records one website form lead with the router. Never throws; resolves { attempted:false } when switched off.
// details: what lib/_notify.js sendLeadAlertEmail is given (name, email, phone, formName, submissionId, noteText).
async function routerCopy(details, opts) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    if (!leadsToRouter(env)) return { attempted: false };
    const d = details || {};
    const form = String(d.formName || "");
    const site = String(o.site || "site").replace(/[^a-z0-9_-]/g, "").slice(0, 30) || "site";
    const problem = hubProblem(env);
    if (problem) {
      console.error(`Router copy NOT recorded: ${problem}.`);
      return { attempted: false, ok: false, error: problem };
    }
    const email = normEmail(d.email);
    const phone = normPhone(d.phone);
    if (!email && !phone) {
      console.error("Router copy NOT recorded: no usable email or phone on the submission.");
      return { attempted: false, ok: false, error: "no usable email or phone" };
    }
    const parts = String(d.name || "").trim().split(/\s+/).filter(Boolean);
    const plan = planForSubmission(form, {}, { site: site === "signature" ? "signature" : "main" }).plan;
    const intent = Object.prototype.hasOwnProperty.call(ROUTER_FORM_INTENT, form) ? ROUTER_FORM_INTENT[form]
      : plan && Object.prototype.hasOwnProperty.call(ROUTER_INTENT, plan) ? ROUTER_INTENT[plan] : null;
    const ans = await client({ env, fetch: o.fetch, timeoutMs: ROUTER_TIMEOUT_MS }).routerLead({
      idempotency_key: routerKey(site, form, d), source: `${site}-form`, kind: "new",
      ...(intent ? { intent } : {}),
      ...(parts[0] ? { first_name: parts[0] } : {}), ...(parts.length > 1 ? { last_name: parts.slice(1).join(" ") } : {}),
      ...(email ? { email } : {}), ...(phone ? { phone } : {}),
      event_at: new Date().toISOString(), note: `Website form: ${form || "unknown"}`, detail: { form, site },
    });
    if (!ans.ok) {
      const error = whyNot(ans);
      console.error(`Router copy NOT recorded: ${error}.`);
      return { attempted: true, ok: false, httpStatus: ans.status || 0, error };
    }
    const j = ans.body || {};
    const status = short(j.status, 20);
    const ok = status === "routed" || status === "held" || status === "duplicate";
    console.log(`Router copy: ${status || "no status"}${j.id != null ? ` (router id ${short(j.id, 30)})` : ""}.`);
    return { attempted: true, ok, status, ...(j.id != null ? { id: short(j.id, 30) } : {}) };
  } catch (err) {
    console.error("Router copy error:", short((err && err.message) || err, 120));
    return { attempted: true, ok: false, error: short((err && err.message) || err, 120) };
  }
}

module.exports = {
  HUB_MARK,
  MIN_HUB_MS,
  MAX_HUB_NOTE,
  TASK_DUE_MINUTES,
  ROUTER_TIMEOUT_MS,
  ROUTER_INTENT,
  ROUTER_FORM_INTENT,
  loftyViaHub,
  leadsToRouter,
  hubProblem,
  personOf,
  pushLeadViaHub,
  leadAskFor,
  hubInquiry,
  noteParts,
  hubExtraResult,
  taskViaHub,
  readViaHub,
  hubCreatedLeadId,
  noteViaHub,
  consentViaHub,
  planTagsViaHub,
  textingViaHub,
  afterPush,
  routerKey,
  routerCopy,
  recall,
  forget,
  confirmCreated,
};
