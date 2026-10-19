"use strict";
// suite-kit: the ONE Lofty client and its consent rules (Duplication Audit, Oct 11: the client was
// re-implemented in twelve places, so the #dnc fix had to be made four times).
//
// Ported from Listing Engine staging apps/api/src/lib/lofty/client.ts (the canonical copy), with three
// changes for a shared package: the key, fetch and logger are passed in (no process.env, no app imports,
// so the same file runs in Node, Deno and the hub's Edge Function); every Lofty call can be logged and
// rate-limited through two hooks (onCall, beforeCall); and texting can never be switched on unless the
// caller says so (allowTextingOn), because Lofty texting stays off until Lofty approves 10DLC campaign
// 12744 (Christine, 2026-10-17).
//
// Christine's rules, all enforced here:
//   - Base is always https://api.lofty.com/v1.0 with `Authorization: token <key>`; the key only ever goes
//     to Lofty's host and never appears in an error or log line.
//   - Look the person up before any create: email first, then phone (last 10 digits). One exact search,
//     up to 5 results. Several exact matches (several_leads), only loose matches (no_exact_match) or a
//     failed search (lookup_failed) REFUSE: nothing is written and nothing is created. With no email and
//     no 10-digit phone there is nothing to look up, so nothing is created either (no_lookup_key).
//   - Every create sends `cannotText: true`.
//   - PUT /leads/{id} REPLACES the whole tags (and phones) list, so every write reads the lead first and
//     PUTs existing + new (read-merge-write). A read that is not this lead, or whose `tags` is missing or
//     null, is unreadable: nothing is written to tags and any yes to texts is held.
//   - Do Not Contact wins. A lead is Do Not Contact when it carries `Consent – DNC` or `OPTED OUT` /
//     `Expired Elite – OPTED OUT` (any dash, any case): no email, no call, no text. On such a lead only
//     stop-contact tags are added, texting and email are switched off, every other requested tag is held,
//     and after the write the DNC tag is checked again (a lost one alerts).
//   - `#dnc` is PHONE ONLY (Christine, 2026-10-18): no calls and no texts on that lead, email still allowed
//     unless an email opt-out applies. On a `#dnc` lead texting is switched off and any yes to texts is
//     held; email and the requested tags are left alone; after the write `#dnc` is checked again.
//     `isDoNotContactTag` answers "may we email?"; `isPhoneDncTag` (`#dnc` plus the full ones) answers
//     "may we call or text?".
//   - Email opt-out is the tag `Consent – Unsubscribed` AND `cannotEmail: true`, written together.
//   - Texting: `cannotText: false` and `Consent – SMS Opt-In` only on an explicit yes, only when every
//     phone on the lead is the consented number, never on a Do Not Contact lead, and only when the caller
//     passes allowTextingOn: true. A new number without a yes switches texting off and leaves a note.
//   - One writer per lead: every read-merge-write runs inside `lockLead(leadId)` when the caller passes it.
//     PUT /leads/{id} replaces the whole tag list, so two writers that both read before either writes lose
//     the first one's tag. The hub passes a per-lead lease (migration 0055_lofty_lead_lease.sql), so two apps
//     writing the same lead through the doorway never lose a tag; createMemoryLeadLock() does the same inside
//     one process (tests, or one app's own workers).
Object.defineProperty(exports, "__esModule", { value: true });
exports.NO_LOOKUP_KEY = exports.CONSENT_NO_PHONE = exports.LoftyError = exports.LOOKUP_LIMIT = exports.TEXTING_OFF_REASON = exports.NEW_NUMBER_NOTE = exports.EMAIL_OPTOUT_TAG = exports.DNC_WRITE_TAGS = exports.DNC_HASH_TAG = exports.DNC_TAG = exports.SMS_CONSENT_TAG = exports.LOFTY_API_PREFIX = exports.LOFTY_API_ORIGIN = void 0;
exports.isDoNotContactTag = isDoNotContactTag;
exports.isPhoneOnlyDncTag = isPhoneOnlyDncTag;
exports.isPhoneDncTag = isPhoneDncTag;
exports.isDncTag = isDncTag;
exports.isEmailOptOutTag = isEmailOptOutTag;
exports.isSmsConsentTag = isSmsConsentTag;
exports.isStopContactTag = isStopContactTag;
exports.isLookupRefusal = isLookupRefusal;
exports.isLoftyConfigured = isLoftyConfigured;
exports.loftyRequest = loftyRequest;
exports.cleanTag = cleanTag;
exports.normalizeTags = normalizeTags;
exports.existingTagsForWrite = existingTagsForWrite;
exports.mergeTags = mergeTags;
exports.phoneKey = phoneKey;
exports.leadPhonesForWrite = leadPhonesForWrite;
exports.leadEmails = leadEmails;
exports.isExplicitYes = isExplicitYes;
exports.consentVerdict = consentVerdict;
exports.leadIdOf = leadIdOf;
exports.leadCarriesEmail = leadCarriesEmail;
exports.splitName = splitName;
exports.buildLeadBody = buildLeadBody;
exports.createResponseMerge = createResponseMerge;
exports.consentStatus = consentStatus;
exports.mayEmailLead = mayEmailLead;
exports.mayCallLead = mayCallLead;
exports.mayTextLead = mayTextLead;
exports.tagsAllowEmail = tagsAllowEmail;
exports.tagsAllowPhone = tagsAllowPhone;
exports.createLeadResult = createLeadResult;
exports.getLead = getLead;
exports.findLeadByEmail = findLeadByEmail;
exports.findLeadByPhone = findLeadByPhone;
exports.findExistingLead = findExistingLead;
exports.hasLookupKey = hasLookupKey;
exports.mergeIntoLead = mergeIntoLead;
exports.createMemoryLeadLock = createMemoryLeadLock;
exports.addNote = addNote;
exports.followMerge = followMerge;
exports.addNoteFollowingMerge = addNoteFollowingMerge;
exports.pushLead = pushLead;
exports.tagLead = tagLead;
exports.noteLead = noteLead;
exports.applyOptOut = applyOptOut;
exports.lookupConsent = lookupConsent;
const contact_ts_1 = require("./contact.js");
exports.LOFTY_API_ORIGIN = 'https://api.lofty.com';
exports.LOFTY_API_PREFIX = '/v1.0';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TAG_LENGTH = 60;
const MAX_NOTE_LENGTH = 5000;
/** Lofty's SMS consent tag (EN DASH). */
exports.SMS_CONSENT_TAG = 'Consent – SMS Opt-In';
/**
 * Christine's two DNC tags (EN DASH; plain lower case). A full Do Not Contact write always sets BOTH.
 * `Consent – DNC` = no email, no call, no text. `#dnc` = phone only (no calls or texts; email still allowed).
 */
exports.DNC_TAG = 'Consent – DNC';
exports.DNC_HASH_TAG = '#dnc';
exports.DNC_WRITE_TAGS = [exports.DNC_TAG, exports.DNC_HASH_TAG];
/** Her email opt-out tag (EN DASH): an opt-out is this tag AND cannotEmail:true. */
exports.EMAIL_OPTOUT_TAG = 'Consent – Unsubscribed';
/** The note a lead gets when a number without a yes to texts switched its texting off. */
exports.NEW_NUMBER_NOTE = 'New number added without a yes to texts; texting turned off.';
/** Why a yes to texts is held while texting is switched off suite-wide. */
exports.TEXTING_OFF_REASON = 'texting stays off until Lofty approves 10DLC campaign 12744: texting left off, SMS consent tag not added';
const DASH = '[-\\u2010-\\u2015\\u2212]';
const DO_NOT_CONTACT_RE = new RegExp(`^(?:consent\\s*${DASH}\\s*dnc|opted\\s+out|expired\\s+elite\\s*${DASH}\\s*opted\\s+out)$`, 'i');
// #dnc = phone only (calls/texts); email still allowed — Christine 2026-10-18
const PHONE_ONLY_DNC_RE = /^#dnc$/i;
const EMAIL_OPTOUT_RE = new RegExp(`^consent\\s*${DASH}\\s*unsubscribed$`, 'i');
const SMS_CONSENT_RE = new RegExp(`^consent\\s*${DASH}\\s*sms\\s+opt${DASH}?in$`, 'i');
const tagText = (name) => String(name ?? '').trim().replace(/\s+/g, ' ');
/**
 * Full Do Not Contact (no email, no call, no text): "Consent – DNC", "OPTED OUT" or "Expired Elite – OPTED OUT",
 * whole tag, however the dash or the case was typed. "Consent – DNC Email" is a different tag and is not
 * matched. NOT `#dnc`, which is phone only. Every "may we email?" question uses this test.
 */
function isDoNotContactTag(name) {
    return DO_NOT_CONTACT_RE.test(tagText(name));
}
/** `#dnc` itself (any case, whole tag). */
function isPhoneOnlyDncTag(name) {
    // #dnc = phone only (calls/texts); email still allowed — Christine 2026-10-18
    return PHONE_ONLY_DNC_RE.test(tagText(name));
}
/**
 * No calls and no texts: `#dnc` (phone only) or any full Do Not Contact tag. Every "may we call or text?"
 * question uses this test.
 */
function isPhoneDncTag(name) {
    // #dnc = phone only (calls/texts); email still allowed — Christine 2026-10-18
    return isPhoneOnlyDncTag(name) || isDoNotContactTag(name);
}
/**
 * @deprecated Same as isPhoneDncTag (any DNC tag, `#dnc` included), so an older caller stays on the safe side.
 * Use isDoNotContactTag for an email decision and isPhoneDncTag for a call or text decision.
 */
function isDncTag(name) {
    return isPhoneDncTag(name);
}
function isEmailOptOutTag(name) {
    return EMAIL_OPTOUT_RE.test(tagText(name));
}
function isSmsConsentTag(name) {
    return SMS_CONSENT_RE.test(tagText(name));
}
/** A tag that only ever STOPS contact. These are the only tags a Do Not Contact lead may still be given. */
function isStopContactTag(name) {
    return isPhoneDncTag(name) || isEmailOptOutTag(name);
}
/** How many results one exact email or phone search asks for. */
exports.LOOKUP_LIMIT = 5;
const LOOKUP_REFUSALS = new Set(['several_leads', 'no_exact_match', 'lookup_failed']);
function isLookupRefusal(err) {
    return LOOKUP_REFUSALS.has(String(err?.code ?? ''));
}
class LoftyError extends Error {
    status;
    code;
    /** Lofty lead ids to check by hand (a refused lookup). */
    leadIds;
    /** Which lookup refused. */
    lookup;
    /** Seconds to wait (a 429 from Lofty or from beforeCall). */
    retryAfterSeconds;
    constructor(message, status, code, leadIds) {
        super(message);
        this.name = 'LoftyError';
        this.status = status;
        this.code = code;
        if (leadIds && leadIds.length)
            this.leadIds = leadIds;
    }
}
exports.LoftyError = LoftyError;
const logger = (deps) => deps.log ?? console;
const label = (deps) => `[lofty${deps.label ? `:${deps.label}` : ''}]`;
const clock = (deps) => (deps.now ? deps.now() : Date.now());
function isLoftyConfigured(deps) {
    return typeof deps?.apiKey === 'string' && deps.apiKey.trim() !== '';
}
/** Low-level request. Throws LoftyError; the message never contains a query string or the key. */
async function loftyRequest(method, path, body, deps) {
    const key = String(deps.apiKey ?? '').trim();
    if (!key)
        throw new LoftyError('LOFTY_API_KEY not configured', undefined, 'not_configured');
    if (!path.startsWith('/') || path.includes('://') || path.startsWith('//'))
        throw new LoftyError('bad Lofty path');
    const safePath = path.split('?')[0];
    // A path that names its own version (e.g. '/v2.0/tasks') is used as is; everything else is under /v1.0.
    const url = `${exports.LOFTY_API_ORIGIN}${/^\/v\d+\.\d+\//.test(path) ? '' : exports.LOFTY_API_PREFIX}${path}`;
    const record = (status, ok, started, error) => {
        try {
            deps.onCall?.({ method, path: safePath, status, ok, ms: Math.max(0, clock(deps) - started), error });
        }
        catch { /* never let logging break a write */ }
    };
    if (deps.beforeCall) {
        try {
            await deps.beforeCall(method, safePath);
        }
        catch (err) {
            record(null, false, clock(deps), 'rate_limited');
            if (err instanceof LoftyError)
                throw err;
            throw new LoftyError(`Lofty ${method} ${safePath} refused before sending: ${String(err?.message ?? err).slice(0, 120)}`, undefined, 'rate_limited');
        }
    }
    const fetchImpl = deps.fetch ?? ((u, i) => globalThis.fetch(u, i));
    const started = clock(deps);
    let res;
    try {
        res = await fetchImpl(url, {
            method,
            headers: { Authorization: `token ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            redirect: 'error',
            signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
    }
    catch (err) {
        const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        record(null, false, started, timeout ? 'timeout' : 'network');
        throw new LoftyError(`Lofty ${method} ${safePath} ${timeout ? 'timed out' : 'network error'}`, undefined, timeout ? 'timeout' : 'network');
    }
    const text = (await Promise.resolve(res.text?.()).catch(() => '')) ?? '';
    record(res.status, res.ok, started, null);
    if (!res.ok) {
        const snippet = String(text || '').split(key).join('[key]').replace(/\s+/g, ' ').slice(0, 200);
        const err = new LoftyError(`Lofty ${method} ${safePath} -> HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, res.status, res.status === 429 ? 'rate_limited' : undefined);
        if (res.status === 429) {
            const ra = Number(res.headers?.get?.('retry-after'));
            err.retryAfterSeconds = Number.isFinite(ra) && ra > 0 ? Math.min(Math.ceil(ra), 3600) : 60;
        }
        throw err;
    }
    if (!text)
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        return {};
    }
}
// ── pure helpers ────────────────────────────────────────────────────────────
/** Clean one tag: string, trimmed, no control chars, capped. '' when unusable. */
function cleanTag(t) {
    if (typeof t !== 'string')
        return '';
    return t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
}
/** Lenient tag reading for read-only checks: strings, {name}/{tagName}/{tag} objects, or a comma list. */
function normalizeTags(raw) {
    let list = [];
    if (Array.isArray(raw))
        list = raw;
    else if (typeof raw === 'string')
        list = raw.split(',');
    const out = [];
    for (const item of list) {
        const v = typeof item === 'string' ? item : (item && typeof item === 'object' ? (item.name ?? item.tagName ?? item.tag) : '');
        const c = cleanTag(v);
        if (c)
            out.push(c);
    }
    return out;
}
/**
 * The lead's existing tags for a WRITE, or null when they cannot be trusted: `tags` missing or null, not
 * a list (or comma string), or an item with no readable name. Never "no tags": the PUT replaces the whole
 * list, so writing from such a read could drop `Consent – DNC`. Names are kept exactly as Lofty sent them.
 */
function existingTagsForWrite(raw) {
    if (raw === undefined || raw === null)
        return null;
    let list;
    if (Array.isArray(raw))
        list = raw;
    else if (typeof raw === 'string')
        list = raw.split(',').filter((x) => x.trim() !== '');
    else
        return null;
    const out = [];
    for (const item of list) {
        const v = typeof item === 'string' ? item : (item && typeof item === 'object' ? (item.name ?? item.tagName ?? item.tag) : undefined);
        if (typeof v !== 'string' || !v.trim())
            return null;
        out.push(v.trim());
    }
    return out;
}
/**
 * Existing + requested. Every existing tag is kept exactly as it is; a requested tag is added unless the
 * lead already has it (ignoring case).
 */
function mergeTags(existing, requested) {
    const seen = new Set(existing.map((t) => t.toLowerCase()));
    const merged = [...existing];
    const added = [];
    for (const raw of requested) {
        const t = cleanTag(raw);
        if (!t)
            continue;
        const k = t.toLowerCase();
        if (!seen.has(k)) {
            seen.add(k);
            merged.push(t);
            added.push(t);
        }
    }
    return { merged, added };
}
/** The last 10 digits of a usable phone (suite-kit normPhone); '' when unusable. */
function phoneKey(p) {
    return (0, contact_ts_1.phoneDigits10)(p) ?? '';
}
/**
 * Every phone on a lead that was confirmed to be the right lead: `phones` (strings or {phone|number|value}
 * objects) plus the single `phone`. null = a malformed field, which is unreadable.
 */
function leadPhonesForWrite(lead) {
    const raw = lead?.phones;
    let list = [];
    if (raw !== undefined && raw !== null) {
        if (!Array.isArray(raw))
            return null;
        for (const item of raw) {
            const v = typeof item === 'string' || typeof item === 'number'
                ? item
                : (item && typeof item === 'object' ? (item.phone ?? item.number ?? item.value) : undefined);
            if ((typeof v !== 'string' && typeof v !== 'number') || !String(v).trim())
                return null;
            list.push(String(v).trim());
        }
    }
    const one = lead?.phone;
    if (one !== undefined && one !== null) {
        if (typeof one !== 'string' && typeof one !== 'number')
            return null;
        const s = String(one).trim();
        if (s && !list.some((p) => p.replace(/\D/g, '') === s.replace(/\D/g, '')))
            list = [...list, s];
    }
    return list;
}
/** Every readable email on a lead read, lower-cased. */
function leadEmails(lead) {
    const out = [];
    const push = (v) => {
        const x = v && typeof v === 'object' ? (v.value ?? v.email) : v;
        if (typeof x === 'string' && x.trim())
            out.push(x.trim().toLowerCase());
    };
    push(lead?.email);
    if (Array.isArray(lead?.emails))
        lead.emails.forEach(push);
    return out;
}
function leadPhoneKeys(lead) {
    const out = [];
    const push = (v) => {
        const x = v && typeof v === 'object' ? (v.phone ?? v.number ?? v.value) : v;
        const k = phoneKey(x);
        if (k)
            out.push(k);
    };
    push(lead?.phone);
    if (Array.isArray(lead?.phones))
        lead.phones.forEach(push);
    return out;
}
/** An explicit yes to texts: true, 1, or 'true' / 'yes' / 'y' / 'on' / '1' / 'checked'. Anything else is no. */
function isExplicitYes(v) {
    if (v === true || v === 1)
        return true;
    return typeof v === 'string' && /^(true|yes|y|on|1|checked)$/i.test(v.trim());
}
const HELD = 'SMS consent tag not added';
exports.CONSENT_NO_PHONE = `said yes to texts but gave no usable phone number: texting left off, ${HELD}`;
/**
 * Does an explicit SMS yes, given with `consentPhone`, apply to this lead? Only when every phone on the
 * lead (after this merge, when `phonesAfter` is given) is that number and there is at least one.
 * cannotText is one flag for the whole lead.
 */
function consentVerdict(lead, consentPhone, phonesAfter) {
    const want = phoneKey(consentPhone);
    if (!want)
        return { applies: false, reason: exports.CONSENT_NO_PHONE };
    const phones = phonesAfter === undefined ? leadPhonesForWrite(lead) : phonesAfter;
    if (phones === null)
        return { applies: false, reason: `the lead's phone numbers could not be read: texting left off, ${HELD}` };
    if (!phones.length)
        return { applies: false, reason: `the consented number is not on the lead: texting left off, ${HELD}` };
    if (!phones.every((p) => phoneKey(p) === want)) {
        return { applies: false, reason: `the lead has another number: ${lead?.cannotText === false ? 'texting was already on' : 'texting left off'}, ${HELD} until you confirm which number consented` };
    }
    return { applies: true, reason: null };
}
function leadIdOf(obj) {
    if (!obj || typeof obj !== 'object')
        return null;
    const v = obj.leadId ?? obj.id ?? obj.data?.leadId ?? obj.data?.id ?? obj.lead?.leadId ?? obj.lead?.id;
    return v === undefined || v === null || v === '' ? null : String(v);
}
/** Does this lead read carry exactly this email (ignoring case)? */
function leadCarriesEmail(lead, email) {
    const want = (0, contact_ts_1.normEmail)(email);
    return !!want && leadEmails(lead).includes(want);
}
function splitName(name) {
    const parts = String(typeof name === 'string' ? name : '').trim().split(/\s+/).filter(Boolean);
    return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}
/**
 * Lead body for POST /v1.0/leads. ALWAYS `cannotText: true`. Email and phone are normalised (E.164);
 * tags are never put in a create body (they go on afterwards by read-merge-write, so a create Lofty folds
 * into an existing Do Not Contact lead cannot start a Smart Plan).
 */
function buildLeadBody(input) {
    const body = { firstName: input.firstName || '', lastName: input.lastName || '', cannotText: true };
    const email = (0, contact_ts_1.normEmail)(input.email);
    const phone = (0, contact_ts_1.normPhone)(input.phone);
    if (email) {
        body.email = email;
        body.emails = [email];
    }
    if (phone) {
        body.phone = phone;
        body.phones = [phone];
    }
    if (input.source)
        body.source = String(input.source).slice(0, 100);
    const types = Array.isArray(input.leadTypes) ? [...new Set(input.leadTypes.filter((n) => Number.isInteger(n) && n > 0 && n < 100))] : [];
    if (types.length)
        body.leadTypes = types;
    const assignee = String(input.assignedUserId ?? '').trim();
    if (/^[0-9]{1,20}$/.test(assignee))
        body.assignedUserId = Number.isSafeInteger(Number(assignee)) ? Number(assignee) : assignee;
    return body;
}
const idStr = (v) => (v === undefined || v === null || v === '' ? null : String(v));
/** What a POST /leads response says about a merge (Lofty can fold a create into an existing lead). */
function createResponseMerge(res) {
    const id = leadIdOf(res);
    if (!id)
        return null;
    const layers = [res, res?.data, res?.lead].filter((x) => x && typeof x === 'object');
    let survivor = null;
    let absorbed = null;
    let flagged = false;
    for (const o of layers) {
        for (const k of ['mergedInto', 'mergedIntoId', 'mergeInto', 'mergedToLeadId', 'survivingLeadId', 'existingLeadId', 'targetLeadId']) {
            if (!survivor)
                survivor = idStr(o[k]);
        }
        for (const k of ['mergedFrom', 'mergedFromId', 'mergeFrom', 'mergedLeadId', 'absorbedLeadId', 'sourceLeadId']) {
            if (!absorbed)
                absorbed = idStr(o[k]);
        }
        if (o.merged === true || o.isMerged === true || o.duplicate === true || o.isDuplicate === true || o.existing === true
            || o.isNew === false || o.isNewLead === false || o.newLead === false || o.created === false)
            flagged = true;
        const a = idStr(o.leadId);
        const b = idStr(o.id);
        if (a && b && a !== b) {
            survivor = survivor ?? a;
            absorbed = absorbed ?? b;
        }
    }
    if (survivor && survivor !== id)
        return { leadId: survivor, merged: true, mergedFrom: absorbed && absorbed !== survivor ? absorbed : id };
    if (absorbed && absorbed !== id)
        return { leadId: id, merged: true, mergedFrom: absorbed };
    if (flagged)
        return { leadId: id, merged: true, mergedFrom: null };
    return { leadId: id, merged: false, mergedFrom: null };
}
/** What a lead read says about contacting this person. An unreadable tag list holds every channel. */
function consentStatus(lead, opts = {}) {
    const tags = existingTagsForWrite(lead?.tags);
    const reasons = [];
    const tagsReadable = tags !== null;
    if (!tagsReadable)
        reasons.push('tag list missing or unreadable: hold');
    const t = tags ?? [];
    const doNotContact = t.some(isDoNotContactTag);
    if (doNotContact)
        reasons.push('Do Not Contact tag');
    // #dnc = phone only (calls/texts); email still allowed — Christine 2026-10-18
    const phoneDnc = t.some(isPhoneDncTag);
    if (phoneDnc && !doNotContact)
        reasons.push('#dnc tag (phone only: no calls or texts)');
    const optTag = t.some(isEmailOptOutTag);
    const cannotEmail = lead?.cannotEmail === true;
    const cannotText = lead?.cannotText !== false;
    const cannotCall = lead?.cannotCall === true;
    if (optTag)
        reasons.push(`${exports.EMAIL_OPTOUT_TAG} tag`);
    if (cannotEmail)
        reasons.push('cannotEmail is true');
    if (cannotCall)
        reasons.push('cannotCall is true');
    const smsConsentTag = t.some(isSmsConsentTag);
    const mayEmail = tagsReadable && !doNotContact && !optTag && !cannotEmail;
    const mayCall = tagsReadable && !phoneDnc && !cannotCall;
    const mayText = opts.allowTextingOn === true && tagsReadable && !phoneDnc && !cannotText && smsConsentTag;
    if (!mayText)
        reasons.push(opts.allowTextingOn === true ? 'texting not allowed on this lead' : 'texting is off until 10DLC campaign 12744 is approved');
    const phones = (leadPhonesForWrite(lead) ?? []).map((p) => (0, contact_ts_1.normPhone)(p)).filter((p) => !!p);
    return {
        leadId: String(lead?.leadId ?? lead?.id ?? ''), tagsReadable, doNotContact, phoneDnc, emailOptOut: optTag || cannotEmail, emailOptOutTag: optTag, cannotEmail, cannotText,
        cannotCall, smsConsentTag, mayEmail, mayCall, mayText, reasons, phones: [...new Set(phones)], emails: [...new Set(leadEmails(lead))],
    };
}
/** "May we email this lead?" (tags and cannotEmail; `#dnc` alone does not stop email). Unreadable tags = no. */
function mayEmailLead(lead) {
    return consentStatus(lead).mayEmail;
}
/** "May we call this lead?" (`#dnc` or a Do Not Contact tag, or cannotCall, stops it). Unreadable tags = no. */
function mayCallLead(lead) {
    return consentStatus(lead).mayCall;
}
/** "May we text this lead?" Always no unless allowTextingOn (10DLC campaign 12744); `#dnc` stops it. */
function mayTextLead(lead, opts = {}) {
    return consentStatus(lead, opts).mayText;
}
/**
 * "May we email?" from a tag list alone (no Lofty flags): readable, no full Do Not Contact tag and no
 * `Consent – Unsubscribed`. `#dnc` does not stop email. A missing or unreadable list = no (hold).
 */
function tagsAllowEmail(rawTags) {
    const tags = existingTagsForWrite(rawTags);
    return tags !== null && !tags.some(isDoNotContactTag) && !tags.some(isEmailOptOutTag);
}
/** "May we call or text?" from a tag list alone: readable, no `#dnc` and no full Do Not Contact tag. Unreadable = no. */
function tagsAllowPhone(rawTags) {
    const tags = existingTagsForWrite(rawTags);
    // #dnc = phone only (calls/texts); email still allowed — Christine 2026-10-18
    return tags !== null && !tags.some(isPhoneDncTag);
}
// ── lead operations (throw LoftyError) ──────────────────────────────────────
/** POST /leads (always cannotText:true) and read the response for a merge. */
async function createLeadResult(input, deps) {
    const res = await loftyRequest('POST', '/leads', buildLeadBody(input), deps);
    const made = createResponseMerge(res);
    if (!made)
        throw new LoftyError('Lofty POST /leads succeeded but the response had no lead id');
    return made;
}
async function getLead(leadId, deps) {
    const res = await loftyRequest('GET', `/leads/${encodeURIComponent(leadId)}`, undefined, deps);
    return res?.lead ?? res?.data ?? res;
}
async function searchLead(field, value, carries, deps) {
    const what = field === 'email' ? 'this email' : 'this phone number';
    const refuse = (message, code, status, leadIds) => {
        const err = new LoftyError(message, status, code, leadIds);
        err.lookup = field;
        return err;
    };
    let res;
    try {
        res = await loftyRequest('GET', `/leads?${field}=${encodeURIComponent(value)}&preciseSearchFlag=true&limit=${exports.LOOKUP_LIMIT}`, undefined, deps);
    }
    catch (err) {
        if (err?.code === 'rate_limited' || err?.code === 'not_configured')
            throw err;
        throw refuse(`lookup_failed: ${err?.message || err}; nothing written (a retry may fix it)`, 'lookup_failed', err?.status);
    }
    const list = Array.isArray(res) ? res : (res?.leads ?? res?.data?.leads ?? res?.data);
    if (!Array.isArray(list))
        throw refuse(`lookup_failed: the ${field} search answered in an unexpected shape; nothing written`, 'lookup_failed');
    const exact = list.filter((lead) => lead && typeof lead === 'object' && carries(lead));
    const ids = (leads) => leads.map(leadIdOf).filter((x) => !!x).filter((x, i, all) => all.indexOf(x) === i);
    if (list.length && !exact.length) {
        throw refuse(`no_exact_match: the ${field} search returned ${list.length} lead(s), none carrying ${what}; nothing written, check in Lofty by hand`, 'no_exact_match', undefined, ids(list));
    }
    if (exact.length > 1) {
        const found = ids(exact);
        throw refuse(`several_leads: ${exact.length} Lofty leads carry ${what}${found.length ? ` (${found.join(', ')})` : ''}; nothing written, check in Lofty and update the right lead by hand`, 'several_leads', undefined, found);
    }
    // A full page could hide another exact match beyond it (Command Center's rule): refuse rather than guess.
    if (exact.length === 1 && list.length >= exports.LOOKUP_LIMIT) {
        throw refuse(`several_leads: the ${field} search came back full (${exports.LOOKUP_LIMIT}); there may be more leads with ${what}, nothing written`, 'several_leads', undefined, ids(list));
    }
    if (!exact.length)
        return null;
    const id = leadIdOf(exact[0]);
    if (!id)
        throw refuse('lookup_failed: the exact match has no readable lead id; nothing written', 'lookup_failed');
    return { id, lead: exact[0], by: field };
}
/** One exact email search: exactly one exact match is the lead, none is null, anything else refuses. */
async function findLeadByEmail(email, deps) {
    const want = (0, contact_ts_1.normEmail)(email);
    if (!want)
        return null;
    return searchLead('email', want, (lead) => leadEmails(lead).includes(want), deps);
}
/** One exact phone search on the last 10 digits: exactly one exact match is the lead, none is null, anything else refuses. */
async function findLeadByPhone(phone, deps) {
    const want = phoneKey(phone);
    if (!want)
        return null;
    return searchLead('phone', want, (lead) => leadPhoneKeys(lead).includes(want), deps);
}
/** The lead a person belongs to: by email first, then (missing or no match) by phone. A refusal throws. */
async function findExistingLead(person, deps) {
    const byEmail = (0, contact_ts_1.normEmail)(person.email) ? await findLeadByEmail(person.email, deps) : null;
    if (byEmail)
        return byEmail;
    return phoneKey(person.phone) ? findLeadByPhone(person.phone, deps) : null;
}
/** Something to look the person up by before a create: a usable email or a usable phone. */
function hasLookupKey(person) {
    return (0, contact_ts_1.normEmail)(person.email) !== null || phoneKey(person.phone) !== '';
}
/**
 * Read-merge-write ONE existing lead, in a single PUT (see the header for every rule). Throws LoftyError
 * when the read is not this lead; an unreadable tag list is reported in `tagsUnreadable` (a texting-off,
 * email-off or DNC flag write still goes through, since it touches no list).
 */
async function mergeIntoLead(leadId, change, deps) {
    const release = deps.lockLead ? await deps.lockLead(String(leadId)) : null;
    try {
        return await mergeIntoLeadNow(leadId, change, deps);
    }
    finally {
        if (release) {
            try {
                await release();
            }
            catch { /* a lease that is not released expires on its own */ }
        }
    }
}
async function mergeIntoLeadNow(leadId, change, deps) {
    const lead = await getLead(leadId, deps);
    const readId = lead && typeof lead === 'object' ? (lead.leadId ?? lead.id) : undefined;
    if (readId === undefined || readId === null || String(readId) !== String(leadId)) {
        const msg = `lead ${leadId}: the read returned another lead or none; nothing written`;
        logger(deps).warn(`${label(deps)} ${msg}`);
        throw new LoftyError(msg);
    }
    if (deps.checkLead) {
        const phonesOnLead = (leadPhonesForWrite(lead) ?? []).map((p) => (0, contact_ts_1.normPhone)(p)).filter((p) => !!p);
        const listed = await deps.checkLead({ leadId: String(leadId), emails: leadEmails(lead), phones: [...new Set(phonesOnLead)] });
        if (listed?.doNotContact)
            change = { ...change, doNotContact: true };
        else if (listed?.emailOptOut)
            change = { ...change, emailOptOut: true, holdTags: true };
    }
    const existingRead = existingTagsForWrite(lead.tags);
    const out = { tagsAdded: [], emailTurnedOff: false, consentApplied: false, textingNotEnabled: null, wrote: false,
        textingTurnedOff: false, phoneAdded: false, dncHeld: false, phoneDnc: false, tagsHeld: [], before: lead };
    if (existingRead === null) {
        out.tagsUnreadable = `lead ${leadId}: existing tags unreadable (missing or null); nothing written to tags and any yes held`;
        logger(deps).warn(`${label(deps)} ${out.tagsUnreadable}`);
    }
    const existing = existingRead ?? [];
    const body = {};
    const extra = [];
    const dncBefore = existing.some(isDoNotContactTag);
    const dnc = dncBefore || change.doNotContact === true;
    // #dnc = phone only (calls/texts); email still allowed — Christine 2026-10-18
    const phoneDncBefore = existing.some(isPhoneDncTag);
    const phoneDnc = dnc || phoneDncBefore;
    const phones = leadPhonesForWrite(lead);
    const submitted = change.submittedPhone ?? change.smsConsent?.phone;
    const submittedNorm = (0, contact_ts_1.normPhone)(submitted);
    const submittedKey = phoneKey(submitted);
    const isSubmitted = (p) => phoneKey(p) === submittedKey;
    const onLead = !!submittedKey && phones !== null && phones.some(isSubmitted);
    const addPhone = !!submittedNorm && phones !== null && !onLead && !change.viaCreate;
    const phonesAfter = phones === null ? null : (addPhone ? [...phones, submittedNorm] : phones);
    if (addPhone) {
        body.phones = phonesAfter;
        out.phoneAdded = true;
    }
    const newNumber = !!submittedKey && (phonesAfter === null || (change.viaCreate ? phonesAfter.some((p) => !isSubmitted(p)) : !onLead));
    const v = change.smsConsent
        ? (dnc
            ? { applies: false, reason: `the lead is Do Not Contact; Do Not Contact wins over a yes, ${HELD}` }
            : phoneDnc
                ? { applies: false, reason: `the lead is #dnc (no calls or texts); #dnc wins over a yes, ${HELD}` }
                : out.tagsUnreadable
                    ? { applies: false, reason: `the lead's tags could not be read, so Do Not Contact cannot be ruled out: texting left off, ${HELD}` }
                    : deps.allowTextingOn !== true
                        ? { applies: false, reason: exports.TEXTING_OFF_REASON }
                        : consentVerdict(lead, change.smsConsent.phone, phonesAfter))
        : null;
    let off = phoneDnc;
    if (!off && submittedKey) {
        if (v && !v.applies)
            off = phonesAfter === null || !phonesAfter.length || !phonesAfter.every(isSubmitted);
        else if (!v)
            off = newNumber;
    }
    if (off && lead.cannotText !== true) {
        body.cannotText = true;
        out.textingTurnedOff = true;
    }
    if (v) {
        if (v.applies) {
            out.consentApplied = true;
            if (lead.cannotText !== false)
                body.cannotText = false;
            extra.push(exports.SMS_CONSENT_TAG);
        }
        else {
            out.textingNotEnabled = body.cannotText === true ? v.reason?.replace('texting was already on', 'texting switched off') ?? null : v.reason;
        }
    }
    if (change.emailOptOut) {
        extra.push(exports.EMAIL_OPTOUT_TAG);
        if (lead.cannotEmail !== true) {
            body.cannotEmail = true;
            out.emailTurnedOff = true;
        }
    }
    if (change.doNotContact)
        extra.push(...exports.DNC_WRITE_TAGS);
    let requested = [...(change.addTags || []), ...extra];
    if (change.holdTags && !dnc) {
        out.tagsHeld = mergeTags(existing, requested.filter((t) => !isStopContactTag(cleanTag(t)))).added;
        requested = requested.filter((t) => isStopContactTag(cleanTag(t)));
    }
    if (phoneDnc) {
        out.phoneDnc = true;
        if (phoneDncBefore && !dnc)
            logger(deps).warn(`${label(deps)} lead ${leadId} is #dnc (phone only): texting off, email and tags left alone`);
    }
    if (dnc) {
        out.dncHeld = true;
        if (lead.cannotEmail !== true) {
            body.cannotEmail = true;
            out.emailTurnedOff = true;
        }
        out.tagsHeld = mergeTags(existing, requested.filter((t) => !isStopContactTag(cleanTag(t)))).added;
        requested = requested.filter((t) => isStopContactTag(cleanTag(t)));
        if (dncBefore)
            logger(deps).warn(`${label(deps)} lead ${leadId} is Do Not Contact: texting and email off${out.tagsHeld.length ? `; tags held: ${out.tagsHeld.length}` : ''}`);
    }
    const { merged, added } = out.tagsUnreadable ? { merged: [], added: [] } : mergeTags(existing, requested);
    if (added.length)
        body.tags = merged;
    if (Object.keys(body).length) {
        const written = await loftyRequest('PUT', `/leads/${encodeURIComponent(leadId)}`, body, deps);
        out.wrote = true;
        if (dncBefore || (change.doNotContact && added.some(isDoNotContactTag)))
            out.dncCheck = await confirmDncKept(leadId, written, deps, 'full');
        else if (phoneDncBefore)
            out.dncCheck = await confirmDncKept(leadId, written, deps, 'phone');
    }
    out.tagsAdded = added;
    if (out.textingTurnedOff && newNumber) {
        try {
            await addNote(leadId, exports.NEW_NUMBER_NOTE, deps);
        }
        catch (err) {
            out.noteError = `texting-off note failed: ${err?.message || err}`;
            logger(deps).warn(`${label(deps)} lead ${leadId}: ${out.noteError}`);
        }
    }
    return out;
}
function dncLostReason(leadId, kind = 'full') {
    return kind === 'phone'
        ? `lead ${leadId}: the ${exports.DNC_HASH_TAG} tag was gone after this write; put ${exports.DNC_HASH_TAG} back on the lead in Lofty by hand`
        : `lead ${leadId}: the Do Not Contact tag was gone after this write; put ${exports.DNC_TAG} and ${exports.DNC_HASH_TAG} back on the lead in Lofty by hand`;
}
/**
 * After a write to a Do Not Contact (`full`) or `#dnc` (`phone`) lead: is that tag still on it? The PUT's answer,
 * else ONE re-read. Never throws.
 */
async function confirmDncKept(leadId, written, deps, kind) {
    const answer = [written?.lead, written?.data, written].find((o) => o && typeof o === 'object' && o.tags !== undefined && o.tags !== null);
    let tags = answer ? existingTagsForWrite(answer.tags) : null;
    if (tags === null) {
        try {
            const again = await getLead(leadId, deps);
            const id = again && typeof again === 'object' ? (again.leadId ?? again.id) : undefined;
            if (id !== undefined && id !== null && String(id) === String(leadId))
                tags = existingTagsForWrite(again.tags);
        }
        catch { /* unverified below */ }
    }
    if (tags === null)
        return 'unverified';
    if (tags.some(kind === 'full' ? isDoNotContactTag : isPhoneDncTag))
        return 'kept';
    logger(deps).warn(`${label(deps)} ${dncLostReason(leadId, kind)}`);
    try {
        await deps.alert?.(kind === 'full' ? 'Lofty: Do Not Contact tag missing after a write' : 'Lofty: #dnc tag missing after a write', [
            `Lofty lead: ${leadId}`, `Writer: ${deps.label ?? 'suite-kit'}`,
            kind === 'full'
                ? `The lead had ${exports.DNC_TAG} (or OPTED OUT) before this write and the tag is gone now; another app may have written the lead at the same moment.`
                : `The lead had ${exports.DNC_HASH_TAG} (no calls or texts) before this write and the tag is gone now; another app may have written the lead at the same moment.`,
            kind === 'full' ? `Put ${exports.DNC_TAG} and ${exports.DNC_HASH_TAG} back on the lead in Lofty by hand.` : `Put ${exports.DNC_HASH_TAG} back on the lead in Lofty by hand.`,
        ]);
    }
    catch { /* logged above */ }
    return 'lost';
}
/**
 * One writer per lead inside one process: `lockLead` for LoftyDeps. Writers to the same lead wait their
 * turn (first come, first served); writers to different leads never wait. A writer that waits longer than
 * `waitMs` is refused with a LoftyError code 'busy' (nothing read or written; try again later).
 */
function createMemoryLeadLock(opts = {}) {
    const tails = new Map();
    const waitMs = opts.waitMs ?? 30_000;
    return async (leadId) => {
        const id = String(leadId);
        const before = tails.get(id) ?? Promise.resolve();
        let release;
        const mine = new Promise((r) => { release = r; });
        const tail = before.then(() => mine);
        tails.set(id, tail);
        void tail.then(() => { if (tails.get(id) === tail)
            tails.delete(id); });
        let timer;
        const turn = await Promise.race([
            before.then(() => true),
            new Promise((r) => { timer = setTimeout(() => r(false), waitMs); }),
        ]);
        if (timer)
            clearTimeout(timer);
        if (!turn) {
            // Step out of the queue at once: writers behind this one still wait for the writer ahead, not for us.
            release();
            throw Object.assign(new LoftyError(`lead ${id}: another write to this lead is still running; nothing written, try again`, 503, 'busy'), { retryAfterSeconds: 5 });
        }
        return () => release();
    };
}
async function addNote(leadId, content, deps) {
    const id = /^\d+$/.test(leadId) ? Number(leadId) : leadId;
    await loftyRequest('POST', '/notes', { leadId: id, content: String(content).slice(0, MAX_NOTE_LENGTH) }, deps);
}
/** The lead the email now lives on when Lofty merged `leadId` away: ONE exact lookup, a different single match only. */
async function followMerge(leadId, email, deps) {
    if (!(0, contact_ts_1.normEmail)(email))
        return null;
    try {
        const other = await findLeadByEmail(email, deps);
        return other && other.id !== String(leadId) ? other.id : null;
    }
    catch {
        return null;
    }
}
/** POST the note; on a 404 (merged away) follow the email ONCE and retry there. Returns where it landed. */
async function addNoteFollowingMerge(leadId, content, email, deps) {
    try {
        await addNote(leadId, content, deps);
        return leadId;
    }
    catch (err) {
        if (err?.status !== 404)
            throw err;
        const other = await followMerge(leadId, email, deps);
        if (!other)
            throw err;
        await addNote(other, content, deps);
        return other;
    }
}
/** Why nothing was created when there is nothing to look the person up by. */
exports.NO_LOOKUP_KEY = 'no email and no phone number with 10 digits to look the person up by: not created in Lofty; add them by hand';
const blank = () => ({ ok: false, leadId: null, action: null, tagsAdded: [], noteAdded: false });
function fail(out, step, err, deps) {
    out.ok = false;
    out.reason = `${step} failed: ${err?.message || err}`;
    if (err?.status)
        out.status = err.status;
    if (err?.code === 'rate_limited') {
        out.code = 'rate_limited';
        out.retryAfterSeconds = err.retryAfterSeconds ?? 60;
    }
    if (err?.code === 'not_configured')
        out.code = 'not_configured';
    if (err?.code === 'busy') {
        out.code = 'busy';
        out.retryAfterSeconds = err.retryAfterSeconds ?? 5;
    }
    logger(deps).warn(`${label(deps)} ${out.reason}${out.leadId ? ` (lead ${out.leadId})` : ''}`);
    return out;
}
function refuseLookup(out, err, deps) {
    fail(out, `find lead by ${err?.lookup === 'phone' ? 'phone' : 'email'}`, err, deps);
    if (isLookupRefusal(err)) {
        out.code = err.code;
        out.needsReview = true;
        if (Array.isArray(err.leadIds) && err.leadIds.length)
            out.matchLeadIds = err.leadIds;
    }
    return out;
}
/** Apply one read-merge-write to out.leadId (following a 404 merge ONCE by email). Never throws. */
async function applyChange(out, change, email, step, deps) {
    const id = out.leadId;
    let m = null;
    try {
        try {
            m = await mergeIntoLead(id, change, deps);
        }
        catch (err) {
            const survivor = err?.status === 404 ? await followMerge(id, email, deps) : null;
            if (!survivor)
                throw err;
            out.mergedFrom = id;
            out.leadId = survivor;
            out.merged = true;
            m = await mergeIntoLead(survivor, { ...change, viaCreate: false }, deps);
        }
        out.lead = m.before;
        if (m.textingTurnedOff)
            out.textingTurnedOff = true;
        if (m.emailTurnedOff)
            out.emailTurnedOff = true;
        if (m.dncHeld)
            out.dncHeld = true;
        if (m.phoneDnc)
            out.phoneDnc = true;
        if (m.tagsHeld.length)
            out.tagsHeld = m.tagsHeld;
        if (m.dncCheck === 'lost') {
            out.dncLost = true;
            fail(out, step, new LoftyError(dncLostReason(out.leadId, m.dncHeld ? 'full' : 'phone')), deps);
            return m;
        }
        if (m.tagsUnreadable) {
            fail(out, step, new LoftyError(m.tagsUnreadable), deps);
            out.needsReview = true;
            if (m.textingNotEnabled)
                out.textingNotEnabled = m.textingNotEnabled;
            return m;
        }
        out.tagsAdded = m.tagsAdded;
        out.consentApplied = m.consentApplied;
        if (m.textingNotEnabled)
            out.textingNotEnabled = m.textingNotEnabled;
    }
    catch (err) {
        fail(out, step, err, deps);
        if (change.smsConsent)
            out.textingNotEnabled = 'the lead could not be read or updated: texting left off, SMS consent tag not added';
    }
    return m;
}
function noteWithConsent(note, held) {
    if (!held)
        return note;
    const line = `SMS consent: yes on this form, but ${held}.`;
    return note && note.trim() ? `${note}\n${line}` : line;
}
/**
 * Look up (email, then phone), then add to the one existing lead, or create (cannotText:true) and tag the
 * new lead by read-merge-write; then the note. A refused lookup, no lookup key, or a missing key writes
 * nothing. Never throws.
 */
async function pushLead(args, deps) {
    const out = blank();
    if (!isLoftyConfigured(deps)) {
        out.reason = 'LOFTY_API_KEY not configured; nothing sent to Lofty';
        out.code = 'not_configured';
        return out;
    }
    if (!hasLookupKey(args.lead)) {
        out.reason = exports.NO_LOOKUP_KEY;
        out.code = 'no_lookup_key';
        out.needsReview = true;
        logger(deps).warn(`${label(deps)} ${out.reason}`);
        return out;
    }
    let found;
    try {
        found = await findExistingLead(args.lead, deps);
    }
    catch (err) {
        if (err?.code === 'rate_limited')
            return fail(out, 'find lead', err, deps);
        return refuseLookup(out, err, deps);
    }
    const tags = (args.tags ?? []).map(cleanTag).filter(Boolean);
    const consent = args.smsConsent === true ? (phoneKey(args.lead.phone) ? { phone: String(args.lead.phone) } : null) : null;
    if (args.smsConsent === true && !consent)
        out.textingNotEnabled = exports.CONSENT_NO_PHONE;
    if (found) {
        out.leadId = found.id;
        out.action = 'existing';
        out.matchedBy = found.by;
        await applyChange(out, { addTags: tags, smsConsent: consent, submittedPhone: args.lead.phone, emailOptOut: args.emailOptOut === true }, args.lead.email, tags.length ? 'add tags' : 'update lead', deps);
    }
    else {
        if (args.create === false) {
            out.reason = 'no Lofty lead with this email or phone; not created (create: false)';
            return out;
        }
        let made;
        try {
            made = await createLeadResult(args.lead, deps);
        }
        catch (err) {
            return fail(out, 'create lead', err, deps);
        }
        out.leadId = made.leadId;
        out.action = 'created';
        if (made.merged) {
            out.merged = true;
            if (made.mergedFrom)
                out.mergedFrom = made.mergedFrom;
        }
        // Always re-read after a create: the tags go on by read-merge-write, and a create Lofty folded into an
        // existing lead must have that lead's Do Not Contact and numbers decide.
        await applyChange(out, { addTags: tags, smsConsent: consent, submittedPhone: args.lead.phone, viaCreate: !made.merged,
            emailOptOut: args.emailOptOut === true }, args.lead.email, tags.length ? 'add tags' : 'read back new lead', deps);
    }
    const note = noteWithConsent(args.note, out.textingNotEnabled);
    if (out.leadId && note && note.trim() && !out.dncLost) {
        try {
            const landed = await addNoteFollowingMerge(out.leadId, note, args.lead.email, deps);
            if (landed !== out.leadId) {
                out.mergedFrom = out.leadId;
                out.leadId = landed;
                out.merged = true;
            }
            out.noteAdded = true;
        }
        catch (err) {
            fail(out, 'add note', err, deps);
        }
    }
    if (!out.reason)
        out.ok = true;
    return out;
}
/** Add tags to one known lead by read-merge-write (held on a Do Not Contact lead). Never throws. */
async function tagLead(leadId, tags, deps) {
    const out = { ...blank(), leadId: String(leadId), action: 'existing' };
    if (!isLoftyConfigured(deps)) {
        out.reason = 'LOFTY_API_KEY not configured; nothing sent to Lofty';
        out.code = 'not_configured';
        return out;
    }
    await applyChange(out, { addTags: tags }, undefined, 'add tags', deps);
    if (!out.reason)
        out.ok = true;
    return out;
}
/** A note on one known lead. Never throws. */
async function noteLead(leadId, content, deps) {
    const out = { ...blank(), leadId: String(leadId), action: 'existing' };
    if (!isLoftyConfigured(deps)) {
        out.reason = 'LOFTY_API_KEY not configured; nothing sent to Lofty';
        out.code = 'not_configured';
        return out;
    }
    if (!String(content ?? '').trim()) {
        out.reason = 'empty note';
        return out;
    }
    try {
        await addNote(String(leadId), content, deps);
        out.noteAdded = true;
        out.ok = true;
    }
    catch (err) {
        fail(out, 'add note', err, deps);
    }
    return out;
}
/**
 * Apply an opt-out to the person's ONE lead (by lead id, else email, then phone). `email` = the email
 * opt-out (`Consent – Unsubscribed` + cannotEmail); `do_not_contact` = both DNC tags + cannotText +
 * cannotEmail. Consent writes never wait on any Smart Plan switch. When the tags cannot be read only the
 * flags go on and the outcome is NOT ok (needsReview): half an opt-out is not an opt-out. Never throws.
 */
async function applyOptOut(args, deps) {
    const out = blank();
    if (!isLoftyConfigured(deps)) {
        out.reason = 'LOFTY_API_KEY not configured; opt-out not written to Lofty';
        out.code = 'not_configured';
        return out;
    }
    if (args.leadId) {
        out.leadId = String(args.leadId);
        out.action = 'existing';
    }
    else {
        if (!hasLookupKey(args)) {
            out.reason = exports.NO_LOOKUP_KEY;
            out.code = 'no_lookup_key';
            out.needsReview = true;
            return out;
        }
        try {
            const found = await findExistingLead(args, deps);
            if (!found) {
                out.reason = 'no Lofty lead with this email or phone; opt-out kept in the hub list only';
                return out;
            }
            out.leadId = found.id;
            out.action = 'existing';
            out.matchedBy = found.by;
        }
        catch (err) {
            if (err?.code === 'rate_limited')
                return fail(out, 'find lead', err, deps);
            return refuseLookup(out, err, deps);
        }
    }
    const m = await applyChange(out, args.kind === 'email' ? { emailOptOut: true } : { doNotContact: true }, args.email, `${args.kind} opt-out`, deps);
    if (m?.tagsUnreadable)
        out.reason = 'opt-out tag held: tags unreadable; the flags were written, add the tag in Lofty by hand';
    if (!out.reason)
        out.ok = true;
    return out;
}
/** Read one lead and say what may be done with it (consentStatus). Never throws. */
async function lookupConsent(args, deps) {
    const out = blank();
    if (!isLoftyConfigured(deps)) {
        out.reason = 'LOFTY_API_KEY not configured';
        out.code = 'not_configured';
        return { ok: false, outcome: out };
    }
    let leadId = args.leadId ? String(args.leadId) : null;
    let matchedBy = 'lead_id';
    if (!leadId) {
        if (!hasLookupKey(args)) {
            out.reason = exports.NO_LOOKUP_KEY;
            out.code = 'no_lookup_key';
            return { ok: false, outcome: out };
        }
        try {
            const found = await findExistingLead(args, deps);
            if (!found)
                return { ok: true, found: false, reason: 'no Lofty lead with this email or phone' };
            leadId = found.id;
            matchedBy = found.by;
        }
        catch (err) {
            return { ok: false, outcome: err?.code === 'rate_limited' ? fail(out, 'find lead', err, deps) : refuseLookup(out, err, deps) };
        }
    }
    try {
        const lead = await getLead(leadId, deps);
        const id = lead && typeof lead === 'object' ? (lead.leadId ?? lead.id) : undefined;
        if (id === undefined || id === null || String(id) !== leadId) {
            out.leadId = leadId;
            out.reason = 'the read returned another lead or none: hold';
            return { ok: false, outcome: out };
        }
        return { ok: true, found: true, matchedBy, status: consentStatus(lead, { allowTextingOn: deps.allowTextingOn }), lead };
    }
    catch (err) {
        out.leadId = leadId;
        return { ok: false, outcome: fail(out, 'read lead', err, deps) };
    }
}
