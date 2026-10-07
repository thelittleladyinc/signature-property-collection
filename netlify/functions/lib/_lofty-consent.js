// Texting consent for website leads in Lofty: off unless they said yes.
//
// 2026-09-30 (urgent consent fix). Every website lead gets the "Hot Lead -
// Website" tag, and that tag starts her Smart Plan -- on a repeat enquiry too
// (lib/_notify.js refireLoftyTag). The form's consent tick only ever reached the
// lead's NOTE, and the create call never set Lofty's own texting switch
// (cannotText), so a lead who never agreed to texts was as textable as one who
// did. A text sent without consent can cost $500-1,500.
//
// This is Christine's consent rule, as the Command Center already runs it for
// quiz leads (bold-collective-command-center lib/lofty-lead-update.js and
// lib/quiz-lead.js):
//
//   1. EVERY create sends cannotText:true (lib/_lofty.js postLead enforces it,
//      for the minimal-shape retry and the queue replay too).
//   2. Texting goes ON (cannotText:false) and the consent tag goes on only when
//      BOTH hold: the form carried an explicit yes, and EVERY phone on the lead
//      is the number the yes came with (last 10 digits). cannotText is one
//      switch for the whole lead, so a yes given with one number must not turn
//      texting on for another number on the same lead that never agreed.
//   3. The lead is read first and the write merges into it, because
//      PUT /leads/{id} REPLACES the lead's whole tags (and phones) list. The
//      read may wrap the lead as { data } or { lead }. A missing or null `tags`
//      is unreadable, never "none" -- a create can fold into an existing lead
//      by email or phone, so the id it returns may be a client's -- and then
//      nothing is written at all.
//   4. A new number without a yes turns texting off. DNC always wins. Safe-off
//      writes change only cannotText; existing tags and phone lists stay intact.
//
// Only the explicit, optional sms_consent box counts. Legacy `consent` fields
// and Signature's required unnamed boxes do not count. A box
// nobody can leave unticked is not a free yes (The Little Lady build.py header;
// her A2P filing says the boxes are not required), so neither is read as
// texting consent: those leads stay cannotText:true.
//
// Nothing here throws; every entry point returns a small result (kept in the
// Blobs push record, and the reason logged when texting is held), without
// names, emails or phone numbers. /status does not show it yet.
"use strict";

const LOFTY_API = "https://api.lofty.com";
const CALL_TIMEOUT_MS = 5000;
// EN DASH, exactly as the Command Center writes it.
const CONSENT_TAG = "Consent – SMS Opt-In";
// Do Not Contact, in either spelling Christine's Lofty uses: "Consent – DNC" (any dash or
// case) or the plain "#dnc" tag. "Consent - DNC Email" is a different tag and is not matched.
// 2026-10-06 (safety review): "#dnc" was missing here, so a lead tagged only #dnc who ticked the
// texting box could have had texting switched on. Seller Intelligence, Expired Elite and My Lead
// Pages already read "#dnc" as Do Not Contact.
const isDncTag = (name) => /^(?:consent\s*[-\u2010-\u2015]\s*dnc|#dnc)$/i.test(String(name == null ? "" : name).trim());
const SMS_CONSENT_FIELD = "sms_consent";

const YES_VALUE = /^(yes|y|true|on|1|checked|agree|agreed|accept|accepted|opt[-_ ]?in|opted[-_ ]?in|i agree|i consent|i accept)\b/i;
const NO_VALUE = /^(no|n|false|off|0|decline|declined|do not|don't|dont|i do not|i don't|opt[-_ ]?out|unchecked|none)\b/i;

// "yes" / "on" / true -> true. Empty, "no", anything unrecognised -> false. An
// array is a yes only when every non-empty entry is a yes.
function affirmative(v) {
  if (v === true || v === 1) return true;
  if (Array.isArray(v)) {
    const vals = v.filter((x) => x !== null && x !== undefined && String(x).trim() !== "");
    return vals.length > 0 && vals.every(affirmative);
  }
  if (typeof v !== "string") return false;
  const s = v.trim();
  return !!s && !NO_VALUE.test(s) && YES_VALUE.test(s);
}

// The form's texting consent: { given, answered }. An unticked box posts
// nothing, so `answered` is false then; a value that is not a yes is a no.
function smsConsentFromForm(data) {
  const v = data && typeof data === "object" ? data[SMS_CONSENT_FIELD] : undefined;
  const answered = v != null && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && !v.length);
  return { given: answered && affirmative(v), answered, field: SMS_CONSENT_FIELD };
}

const last10 = (s) => String(s == null ? "" : s).replace(/\D/g, "").slice(-10);
const short = (v, n) => (v == null ? undefined : String(v).slice(0, n || 200));

// Tag / phone names from Lofty's list fields (strings or objects). A missing
// list is none; anything unreadable is null.
function names(list, pick) {
  if (list == null) return [];
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const t of list) {
    const n = typeof t === "string" ? t.trim()
      : (t && typeof t === "object" ? String(pick(t) ?? "").trim() : "");
    if (!n) return null;
    out.push(n);
  }
  return out;
}
const tagNames = (l) => names(l, (t) => t.tagName ?? t.name);
const phoneValues = (l) => names(l, (t) => t.phone ?? t.number ?? t.value);

// Every phone on the lead: the `phones` list plus a single `phone`. null = unreadable.
function leadPhones(l) {
  const list = phoneValues(l.phones);
  const one = l.phone;
  if (list === null || (one != null && typeof one !== "string")) return null;
  const out = [...list];
  const v = typeof one === "string" ? one.trim() : "";
  if (v && !out.some((p) => last10(p) === last10(v))) out.push(v);
  return out;
}

// GET /v1.0/leads/{id} answers the lead bare, as { data: lead } or as { lead }.
function unwrapLead(j) {
  let l = j && typeof j === "object" && !Array.isArray(j) ? j : null;
  if (l && l.data && typeof l.data === "object" && !Array.isArray(l.data)) l = l.data;
  if (l && l.lead && typeof l.lead === "object" && !Array.isArray(l.lead)) l = l.lead;
  return l;
}

// The body is this lead. An id JavaScript can't hold exactly is refused, not rounded.
function isThisLead(l, id) {
  const v = l && (l.leadId ?? l.id);
  if (v == null) return false;
  if (typeof v === "number" && !Number.isSafeInteger(v)) return false;
  return String(v).trim() === id;
}

async function call(method, path, apiKey, rawBody, o) {
  const f = o.fetchImpl || fetch;
  const left = (o.deadline || Infinity) - Date.now();
  if (left <= 0) return { ok: false, error: "out of time" };
  try {
    const res = await f(`${LOFTY_API}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `token ${apiKey}` },
      ...(rawBody != null ? { body: rawBody } : {}),
      signal: AbortSignal.timeout(Math.max(1, Math.min(CALL_TIMEOUT_MS, left))),
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, httpStatus: res.status, text };
  } catch (err) {
    return { ok: false, error: short((err && err.message) || err, 120) };
  }
}

const HELD = "texting left off and SMS consent tag held";

// Read back every submission: Lofty's create can merge into a textable contact.
// Enable only with a verified yes; turn off for DNC or an unconsented new number.
async function applyTextingPreference(leadId, consentPhone, consentGiven, apiKey, opts) {
  try {
    const o = opts || {};
    const id = String(leadId == null ? "" : leadId).trim();
    if (!apiKey || !/^\d+$/.test(id) || (typeof leadId === "number" && !Number.isSafeInteger(leadId))) {
      return { attempted: false, textingEnabled: false, reason: "no safe lead id" };
    }
    const consented = last10(consentPhone);
    const got = await call("GET", `/v1.0/leads/${id}`, apiKey, null, o);
    if (!got.ok) {
      return {
        attempted: true, ok: false, changed: false, textingEnabled: false, step: "read",
        httpStatus: got.httpStatus, error: got.error, textingNotEnabled: `could not read the lead; ${HELD}`,
      };
    }
    let j = null;
    try { j = JSON.parse(got.text); } catch (err) { j = null; }
    const l = unwrapLead(j);
    if (!l || !isThisLead(l, id)) {
      return { attempted: true, ok: false, changed: false, textingEnabled: false, step: "read",
        textingNotEnabled: `the lead read back as a different or empty record; nothing written, ${HELD}` };
    }
    // On a lead that may already exist, a missing tags list is unreadable: a
    // write would replace the client's tags with ours.
    const tags = l.tags == null ? null : tagNames(l.tags);
    const phones = leadPhones(l);
    async function disableTexting(step, reason) {
      if (l.cannotText === true) {
        return { attempted: true, ok: true, changed: false, textingEnabled: false, textingDisabled: true, step,
          textingNotEnabled: reason };
      }
      const put = await call("PUT", `/v1.0/leads/${id}`, apiKey, JSON.stringify({ cannotText: true }), o);
      return {
        attempted: true, ok: put.ok, changed: put.ok, textingEnabled: !put.ok && l.cannotText === false,
        textingDisabled: put.ok, step: put.ok ? step : "write", fields: ["cannotText"],
        httpStatus: put.httpStatus, error: put.error,
        textingNotEnabled: put.ok ? reason : `${reason}; could not turn texting off, manual review required`,
      };
    }
    if (tags && tags.some(isDncTag)) {
      return disableTexting("dnc", "the lead is tagged Consent - DNC or #dnc; Do Not Contact wins, SMS consent tag held");
    }
    if (consentGiven === true && consented.length !== 10) {
      return { attempted: true, ok: true, changed: false, textingEnabled: l.cannotText === false, step: "held",
        textingNotEnabled: "consent given but no phone number on the form; SMS consent tag held" };
    }
    if (consentGiven !== true) {
      if (phones === null) {
        return { attempted: true, ok: false, changed: false, textingEnabled: l.cannotText === false, step: "unreadable",
          textingNotEnabled: "the lead's phones could not be read; no consent change made, manual review required" };
      }
      // A create may already have appended the submitted number. Any other
      // number still makes whole-lead texting unsafe without a new yes.
      const newNumber = consented.length === 10 && (!phones.length || !phones.every((p) => last10(p) === consented));
      if (newNumber) return disableTexting("new-number", "a new number was submitted without a yes; texting turned off, existing tags and phones kept");
      return { attempted: true, ok: true, changed: false, textingEnabled: l.cannotText === false, step: "no-consent",
        reason: "no SMS yes or new number; existing texting preference unchanged" };
    }
    if (tags === null || phones === null) {
      return { attempted: true, ok: false, changed: false, textingEnabled: l.cannotText === false, step: "unreadable",
        textingNotEnabled: `the lead's ${tags === null ? "tags" : "phones"} could not be read; nothing written, SMS consent tag held` };
    }
    const applies = phones.length > 0 && phones.every((p) => last10(p) === consented);
    if (!applies) {
      return disableTexting("held", !phones.length
        ? `the lead has no phone number on it; ${HELD}`
        : `the lead has another phone number; ${HELD} until you confirm which number agreed`);
    }
    const body = {};
    if (l.cannotText !== false) body.cannotText = false;
    if (!tags.includes(CONSENT_TAG)) body.tags = [...tags, CONSENT_TAG];
    if (!Object.keys(body).length) return { attempted: true, ok: true, changed: false, textingEnabled: true, step: "already" };
    const put = await call("PUT", `/v1.0/leads/${id}`, apiKey, JSON.stringify(body), o);
    return {
      attempted: true, ok: put.ok, changed: put.ok, textingEnabled: put.ok, step: put.ok ? "enabled" : "write",
      fields: Object.keys(body), httpStatus: put.httpStatus, error: put.error,
      ...(put.ok ? {} : { response: short(put.text), textingNotEnabled: `the write was refused; ${HELD}` }),
    };
  } catch (err) {
    return { attempted: true, ok: false, changed: false, textingEnabled: false, error: short((err && err.message) || err, 120),
      textingNotEnabled: `unexpected error; ${HELD}` };
  }
}

async function applyTextingConsent(leadId, consentPhone, apiKey, opts) {
  return applyTextingPreference(leadId, consentPhone, true, apiKey, opts);
}

module.exports = {
  CONSENT_TAG,
  SMS_CONSENT_FIELD,
  affirmative,
  smsConsentFromForm,
  applyTextingConsent,
  applyTextingPreference,
  unwrapLead,
  leadPhones,
  last10,
};
