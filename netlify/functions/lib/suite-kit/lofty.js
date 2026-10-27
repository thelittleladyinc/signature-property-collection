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
//
// 0.5.0 (2026-10-23, Christine: "we don't lose anything at all"): the options the apps' own Lofty code has and the
// hub's doorway lacked, every one used only when the caller passes it (nothing changes for a caller that does not):
//   - `lead.property` (street, city, state, ZIP): Lofty's nested `property` object on a create; on an existing lead
//     only blanks are filled (no address yet, or the same street missing its city / state / ZIP), never overwritten.
//   - `lead.customAttributes`: Lofty custom fields in the create body (Expired Elite's shape).
//   - `createTags`: tags IN the create body, on a create only (a "tag added" Smart Plan does not start from them);
//     never a consent, Do Not Contact or opt-out tag. A create Lofty folds into an existing lead while carrying
//     tags, an address or custom fields is reported (`createBodyMerged`) and alerted: check that lead by hand.
//   - `removeTags`: taken off in the same read-merge-write, read back gone; never a protected tag (`isProtectedTag`:
//     every `Consent – …` tag, Do Not Contact, `#dnc`, `Newsletter Unsubscribed`, `System – Kill All Drips`).
//   - `leadId`: write to that one known lead (no lookup, never a create).
//   - `match: 'email_and_phone'` (findLeadNarrowed, Command Center's rule): the ONE email match that also holds the
//     phone; the phone only on other people's leads refuses (`already_in_lofty`), never merged by phone alone.
//   - `expectFirstName`: a found lead whose first name is another real name is refused (`name_differs`): nothing
//     written, no note.
//   - `loftyRequestText` and a string body (raw JSON), for 64-bit Lofty ids sent and read as digits; DELETE (Lofty's
//     webhook unsubscribe).
//   - A write that adds `#dnc` (a number on a Do Not Call list) switches texting off in the same PUT.
//
// 0.5.2 (2026-10-23, the side-by-side check): a DRY RUN. Pass `plan: createLoftyPlan()` in LoftyDeps and every
// function here runs exactly as it would, reads included (each through beforeCall / onCall as usual), but no write is
// sent: every POST, PUT and DELETE is recorded in the plan (method, Lofty's full path with the lead id in it, the body
// exactly as it would have gone) and answered the way Lofty answers it, without a network call, beforeCall or onCall.
// A read of a lead the plan wrote to (a read-back) or would have created is answered from the plan (`readBacks`
// counts them): the plan's lead is the lead as last read with the planned PUT bodies laid over it. A lead or task the
// plan would have created carries a stand-in id, shown as `{new_lead_id}` / `{new_task_id}` by plannedRequests() and
// withPlannedIds(). planningFetch() does the same for code that calls Lofty through a plain fetch.
//
// 0.5.4 (2026-10-24, Christine: "we don't lose anything at all"): an opt-out can carry the writing app's own source
// LABEL (`applyOptOut` `labelTags`; the newsletter's `Newsletter Unsubscribed`). The label goes in the SAME
// read-merge-write PUT as `Consent – Unsubscribed` + cannotEmail (or the Do Not Contact write), every other tag kept;
// it is added on a Do Not Contact lead too (a label only ever records a stop, never starts anything), it is never taken
// off, and after the write ONE re-read confirms it (a 200 is not proof). An unreadable tag list holds it with the rest
// (the opt-out behaves exactly as without a label). `isOptOutLabelTag` says which tags may be a label: never a consent,
// Do Not Contact, `#dnc`, SMS consent or other protected tag, except `Newsletter Unsubscribed` itself.
//
// 0.5.13 (2026-10-26, Christine: "we need it to be buyer and seller too not just one or the other"): lead types on an
// EXISTING lead. Until now `lead.leadTypes` went on a create only and an existing lead kept its own. With
// `pushLead({ mergeLeadTypes: true })` an existing lead (found, by lead id, or the lead Lofty folded a create into)
// gains any Seller (1) or Buyer (2) type in `lead.leadTypes` it lacks, in the SAME read-merge-write PUT as the tags
// (Lofty's PUT replaces the whole `leadTypes` list, so the list as read is kept and the missing types are appended);
// a type is never removed. Held, nothing written to the types, wherever the requested tags are held (an unreadable tag
// list, Do Not Contact, an email opt-out on the shared list), on an email opt-out on the lead itself (`Consent –
// Unsubscribed`, cannotEmail, unsubscription) and when the lead's `leadTypes` list cannot be read. After
// the write the types are read back (the PUT's answer, else one re-read, plus `readBackWaitsMs` more when the caller
// can wait: Lofty shows a type change a few seconds after it answers). A type not shown yet does not fail the push; the
// next push re-adds it. Which types a person wants comes from interest.ts `leadTypesForInterests`.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NO_LOOKUP_KEY = exports.REMOVAL_READ_BACK_WAITS_MS = exports.CONSENT_NO_PHONE = exports.MERGEABLE_LEAD_TYPES = exports.PLANNED_NEW_TASK_ID = exports.PLANNED_NEW_LEAD_ID = exports.LoftyError = exports.LOOKUP_LIMIT = exports.TEXTING_OFF_REASON = exports.NEW_NUMBER_NOTE = exports.EMAIL_OPTOUT_TAG = exports.DNC_WRITE_TAGS = exports.DNC_HASH_TAG = exports.DNC_TAG = exports.SMS_CONSENT_TAG = exports.LOFTY_API_PREFIX = exports.LOFTY_API_ORIGIN = void 0;
exports.isDoNotContactTag = isDoNotContactTag;
exports.isPhoneOnlyDncTag = isPhoneOnlyDncTag;
exports.isPhoneDncTag = isPhoneDncTag;
exports.isDncTag = isDncTag;
exports.isEmailOptOutTag = isEmailOptOutTag;
exports.isSmsConsentTag = isSmsConsentTag;
exports.isStopContactTag = isStopContactTag;
exports.isProtectedTag = isProtectedTag;
exports.isOptOutLabelTag = isOptOutLabelTag;
exports.firstNamesDiffer = firstNamesDiffer;
exports.loftyUnsubscribed = loftyUnsubscribed;
exports.isLookupRefusal = isLookupRefusal;
exports.leadProperty = leadProperty;
exports.cleanCustomAttributes = cleanCustomAttributes;
exports.createBodyTags = createBodyTags;
exports.isLoftyConfigured = isLoftyConfigured;
exports.loftyRequest = loftyRequest;
exports.loftyRequestText = loftyRequestText;
exports.createLoftyPlan = createLoftyPlan;
exports.loftyFullPath = loftyFullPath;
exports.planRequest = planRequest;
exports.planSawRead = planSawRead;
exports.isPlannedId = isPlannedId;
exports.withPlannedIds = withPlannedIds;
exports.plannedRequests = plannedRequests;
exports.planningFetch = planningFetch;
exports.cleanTag = cleanTag;
exports.normalizeTags = normalizeTags;
exports.existingTagsForWrite = existingTagsForWrite;
exports.cleanLeadTypes = cleanLeadTypes;
exports.leadTypesForWrite = leadTypesForWrite;
exports.mergeLeadTypes = mergeLeadTypes;
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
exports.findLeadNarrowed = findLeadNarrowed;
exports.findExistingLead = findExistingLead;
exports.hasLookupKey = hasLookupKey;
exports.mergeIntoLead = mergeIntoLead;
exports.planPropertyFill = planPropertyFill;
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
const address_ts_1 = require("./address.js");
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
const ANY_CONSENT_RE = new RegExp(`^consent\\s*${DASH}`, 'i');
const NEWSLETTER_UNSUBSCRIBED_RE = /^newsletter\s+unsubscribed$/i;
const OTHER_PROTECTED_RE = [
    NEWSLETTER_UNSUBSCRIBED_RE,
    new RegExp(`^system\\s*${DASH}\\s*kill\\s+all\\s+drips$`, 'i'),
];
/**
 * A tag no writer may ever take off a lead (0.5.0): every `Consent – …` tag (DNC, Unsubscribed, SMS Opt-In, Spam
 * Complaint, Bounced, …), the Do Not Contact tags (`OPTED OUT`, `Expired Elite – OPTED OUT`), `#dnc`,
 * `Newsletter Unsubscribed` and `System – Kill All Drips`; any dash, any case, whole tag.
 */
function isProtectedTag(name) {
    const t = tagText(name);
    return ANY_CONSENT_RE.test(t) || isStopContactTag(t) || isSmsConsentTag(t) || OTHER_PROTECTED_RE.some((re) => re.test(t));
}
/**
 * May this tag go on a lead as an opt-out's source label (0.5.4, `applyOptOut` `labelTags`)? A label is only ever added
 * with an opt-out and never taken off, so it is never a tag that decides consent: no `Consent – …` tag, no Do Not
 * Contact or `#dnc` tag, no SMS consent, no `System – Kill All Drips`. Of the never-removed tags (isProtectedTag) only
 * `Newsletter Unsubscribed` may be a label: it is the newsletter's own record of an unsubscribe. Any dash, any case.
 */
function isOptOutLabelTag(name) {
    const t = cleanTag(name);
    return !!t && (!isProtectedTag(t) || NEWSLETTER_UNSUBSCRIBED_RE.test(t));
}
/** A first name compared for identity: trimmed, inner spaces collapsed, lower case; the quiz placeholder ("Quiz") and a blank are no name. */
function realFirstName(v) {
    const t = (typeof v === 'string' ? v : '').trim().replace(/\s+/g, ' ').toLowerCase();
    return t === 'quiz' ? '' : t;
}
/**
 * Two real, different first names (Command Center's rule, 0.5.0): a missing or placeholder name on either side is
 * never a difference.
 */
function firstNamesDiffer(a, b) {
    const x = realFirstName(a);
    const y = realFirstName(b);
    return !!x && !!y && x !== y;
}
/** Lofty's own `unsubscription` flag on a lead read: true / false, or null when the read does not say (0.5.0). */
function loftyUnsubscribed(lead) {
    const v = lead?.unsubscription;
    if (v === true || v === 1 || v === 'true' || v === '1')
        return true;
    if (v === false || v === 0 || v === 'false' || v === '0')
        return false;
    return null;
}
/** How many results one exact email or phone search asks for. */
exports.LOOKUP_LIMIT = 5;
const LOOKUP_REFUSALS = new Set(['several_leads', 'no_exact_match', 'lookup_failed', 'already_in_lofty']);
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
    /** name_differs (0.5.0): the first name the lead carries. */
    nameOnLead;
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
const cut = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** A clean LeadProperty, or null without a street (0.5.0). */
function leadProperty(p) {
    if (!p || typeof p !== 'object')
        return null;
    const o = p;
    const street = cut(o.streetAddress ?? o.street, 200);
    if (!street)
        return null;
    const out = { streetAddress: street };
    const city = cut(o.city, 60), state = cut(o.state, 30), zip = cut(o.zipCode ?? o.zip, 10);
    if (city)
        out.city = city;
    if (state)
        out.state = state;
    if (zip)
        out.zipCode = zip;
    return out;
}
/** Custom fields for a create body: name 1-60 characters, value a string of at most 250; at most 20 (0.5.0). */
function cleanCustomAttributes(list) {
    if (!Array.isArray(list))
        return [];
    const out = [];
    for (const f of list) {
        const name = cut(f?.attributeName, 60);
        const raw = f?.value;
        if (!name || (typeof raw !== 'string' && typeof raw !== 'number') || out.some((x) => x.attributeName === name))
            continue;
        out.push({ attributeName: name, value: cut(raw, 250) });
        if (out.length >= 20)
            break;
    }
    return out;
}
/** Tags for a create body: clean, no consent / Do Not Contact / opt-out tag, no repeats, at most 20 (0.5.0). */
function createBodyTags(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const t = cleanTag(raw);
        if (!t || isProtectedTag(t) || out.some((x) => x.toLowerCase() === t.toLowerCase()))
            continue;
        out.push(t);
        if (out.length >= 20)
            break;
    }
    return out;
}
const logger = (deps) => deps.log ?? console;
const label = (deps) => `[lofty${deps.label ? `:${deps.label}` : ''}]`;
const clock = (deps) => (deps.now ? deps.now() : Date.now());
function isLoftyConfigured(deps) {
    return typeof deps?.apiKey === 'string' && deps.apiKey.trim() !== '';
}
/** Low-level request. Throws LoftyError; the message never contains a query string or the key. */
async function loftyRequest(method, path, body, deps) {
    const { text } = await loftyRequestText(method, path, body, deps);
    if (!text)
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        return {};
    }
}
/**
 * loftyRequest with Lofty's answer as text (0.5.0), for an id that may not fit a JavaScript number (Lofty ids are
 * 64-bit). A string `body` is sent exactly as given (raw JSON, e.g. an id written as digits). Throws like loftyRequest.
 * `opts.accept` (0.5.10) asks for XML: Lofty's getPublishedListings answers only XML and refuses a JSON Accept with
 * HTTP 406 (the hub's call log, Oct 26, 2026; Listing Engine's own key always sent `Accept: application/xml`).
 */
async function loftyRequestText(method, path, body, deps, opts = {}) {
    const key = String(deps.apiKey ?? '').trim();
    if (!key)
        throw new LoftyError('LOFTY_API_KEY not configured', undefined, 'not_configured');
    if (!path.startsWith('/') || path.includes('://') || path.startsWith('//'))
        throw new LoftyError('bad Lofty path');
    const safePath = path.split('?')[0];
    // 0.5.2, a dry run: a write is recorded and answered here, a read-back from the plan; nothing is sent or counted.
    if (deps.plan) {
        const planned = planRequest(deps.plan, method, path, body);
        if (planned)
            return planned;
    }
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
            headers: { Authorization: `token ${key}`, 'Content-Type': 'application/json', Accept: opts.accept === 'application/xml' ? 'application/xml' : 'application/json' },
            ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
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
    if (deps.plan && method === 'GET')
        planSawRead(deps.plan, path, text);
    return { status: res.status, text };
}
// ── dry run (0.5.2) ─────────────────────────────────────────────────────────
/** How a dry run's answer shows the lead it would have created (in paths, bodies and the outcome). */
exports.PLANNED_NEW_LEAD_ID = '{new_lead_id}';
/** How a dry run's answer shows the task it would have created. */
exports.PLANNED_NEW_TASK_ID = '{new_task_id}';
// Inside the run the would-be ids are digits, so every id rule on the way treats them as Lofty's own: the two largest
// safe integers (exact as JavaScript numbers too). withPlannedIds() turns them into the stand-ins above.
const SENTINEL_LEAD = '9007199254740991';
const SENTINEL_TASK = '9007199254740990';
const SENTINELS = [[SENTINEL_LEAD, exports.PLANNED_NEW_LEAD_ID], [SENTINEL_TASK, exports.PLANNED_NEW_TASK_ID]];
function createLoftyPlan() {
    return { writes: [], readBacks: 0, after: new Map(), seen: new Map() };
}
/** Lofty's own path for a request path: '/leads/1' -> '/v1.0/leads/1'; a versioned path ('/v2.0/tasks') as is. */
function loftyFullPath(path) {
    return /^\/v\d+\.\d+\//.test(path) ? path : `${exports.LOFTY_API_PREFIX}${path}`;
}
/** The lead id of '/v1.0/leads/{id}' (exactly that path, no query), else null. */
function leadOfPath(full) {
    const m = /^\/v1\.0\/leads\/([^/?#]+)$/.exec(full);
    if (!m)
        return null;
    try {
        return decodeURIComponent(m[1]);
    }
    catch {
        return null;
    }
}
function planBodyObject(body) {
    let v = body;
    if (typeof v === 'string') {
        try {
            v = JSON.parse(v);
        }
        catch {
            return null;
        }
    }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
const okText = (text) => ({ status: 200, text });
/**
 * A dry run's answer to one request, or null when the request must really be sent (a read the plan cannot answer).
 * A write is recorded and answered the way Lofty answers it: a create with the stand-in lead id (the plan then holds
 * the new lead as the create body describes it), a task with the stand-in task id, anything else with {}.
 */
function planRequest(plan, method, path, body) {
    const full = loftyFullPath(path);
    if (method === 'GET') {
        const id = leadOfPath(full);
        if (id !== null && plan.after.has(id)) {
            plan.readBacks++;
            return okText(JSON.stringify(plan.after.get(id)));
        }
        return null;
    }
    plan.writes.push({ method: method, path: full, body: typeof body === 'string' || body === undefined ? body : JSON.parse(JSON.stringify(body)) });
    const obj = planBodyObject(body);
    if (method === 'POST' && full === '/v1.0/leads') {
        const id = Number(SENTINEL_LEAD);
        // 0.5.6: a create with no tags in its body comes back from Lofty with NO tag list at all (measured Oct 25, 2026,
        // four Expired Elite creates), so the planned lead has none either; [] here hid that from every dry run.
        const planned = { ...(obj ?? {}), leadId: id, id };
        if (Array.isArray(obj?.tags))
            planned.tags = obj.tags;
        else
            delete planned.tags;
        plan.after.set(SENTINEL_LEAD, planned);
        return okText(JSON.stringify({ leadId: id }));
    }
    if (method === 'POST' && (full === '/v2.0/tasks' || full === '/v1.0/tasks'))
        return okText(JSON.stringify({ taskId: Number(SENTINEL_TASK) }));
    const id = method === 'PUT' ? leadOfPath(full) : null;
    if (id !== null) {
        const base = plan.after.get(id) ?? plan.seen.get(id) ?? { leadId: id };
        plan.after.set(id, { ...base, ...(obj ?? {}) });
    }
    return okText('{}');
}
/** A real read in a dry run: remember the lead as Lofty returned it, so a later planned PUT starts from it. */
function planSawRead(plan, path, text) {
    const id = leadOfPath(loftyFullPath(path));
    if (id === null)
        return;
    let res;
    try {
        res = text ? JSON.parse(text) : null;
    }
    catch {
        return;
    }
    const lead = res && typeof res === 'object' ? (res.lead && typeof res.lead === 'object' ? res.lead : res.data && typeof res.data === 'object' ? res.data : res) : null;
    if (lead && String(lead.leadId ?? lead.id ?? '') === id)
        plan.seen.set(id, lead);
}
/** Is this the stand-in id of a lead or task a dry run would have created (digits or the shown form)? */
function isPlannedId(v) {
    const s = String(v ?? '');
    return SENTINELS.some(([d, p]) => s === d || s === p);
}
/** Any value with the stand-in ids shown as `{new_lead_id}` / `{new_task_id}` (strings, numbers, nested). */
function withPlannedIds(v) {
    if (typeof v === 'string') {
        let out = v;
        for (const [d, p] of SENTINELS)
            out = out.replace(new RegExp(`(?<!\\d)${d}(?!\\d)`, 'g'), p);
        return out;
    }
    if (typeof v === 'number') {
        for (const [d, p] of SENTINELS)
            if (v === Number(d))
                return p;
        return v;
    }
    if (Array.isArray(v))
        return v.map((x) => withPlannedIds(x));
    if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withPlannedIds(x)]));
    return v;
}
/** A raw JSON text body with the stand-in ids as JSON strings ("{new_task_id}"), so it is still valid JSON. */
function rawWithPlannedIds(text) {
    let out = text;
    for (const [d, p] of SENTINELS)
        out = out.replace(new RegExp(`"${d}"|(?<![\\d"])${d}(?![\\d"])`, 'g'), JSON.stringify(p));
    return out;
}
/** The writes a dry run would have sent, in order, with the stand-in ids shown. */
function plannedRequests(plan) {
    return plan.writes.map((w) => ({ method: w.method, path: withPlannedIds(w.path),
        body: typeof w.body === 'string' ? rawWithPlannedIds(w.body) : withPlannedIds(w.body) }));
}
/**
 * The same dry run for code that calls Lofty through a plain fetch (the hub's _shared/lofty-lead.ts): a write is
 * recorded and answered without a network call; a read of a lead the plan wrote to is answered from the plan; any
 * other read goes to `fetchImpl` after `beforeRead` (throw to refuse it, e.g. the hub's read budget). Lofty's host only.
 */
function planningFetch(plan, fetchImpl, opts = {}) {
    return async (url, init) => {
        const u = new URL(url);
        if (u.origin !== exports.LOFTY_API_ORIGIN)
            throw new LoftyError('a dry run plans Lofty requests only');
        const method = String(init.method || 'GET').toUpperCase();
        const path = `${u.pathname}${u.search}`;
        let body = init.body;
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            }
            catch { /* kept as the text it is */ }
        }
        const planned = planRequest(plan, method, path, body);
        if (planned)
            return { ok: true, status: planned.status, text: async () => planned.text, headers: { get: () => null } };
        if (opts.beforeRead)
            await opts.beforeRead();
        const res = await fetchImpl(url, init);
        const text = (await Promise.resolve(res.text?.()).catch(() => '')) ?? '';
        if (res.ok)
            planSawRead(plan, path, text);
        return { ok: res.ok, status: res.status, text: async () => text, headers: res.headers };
    };
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
// ── lead types (0.5.13) ──────────────────────────────────────────────────────
/** The lead types pushLead may ADD to an existing lead (mergeLeadTypes): Seller (1) and Buyer (2) only. */
exports.MERGEABLE_LEAD_TYPES = Object.freeze([1, 2]);
/** Lead types as a caller sends them: whole numbers 1-99, each once, in the order given. Anything else is dropped. */
function cleanLeadTypes(list) {
    if (!Array.isArray(list))
        return [];
    return [...new Set(list.filter((n) => Number.isInteger(n) && n > 0 && n < 100))];
}
/**
 * The lead's existing types for a WRITE, or null when they cannot be trusted: `leadTypes` missing, null or not a list
 * of whole numbers. Lofty's "none" (-1, 0) reads as no type. The PUT replaces the whole list, so a write from a read
 * without it could drop a type the lead has: hold instead (Christine's rule: read, merge, then write).
 */
function leadTypesForWrite(lead) {
    const raw = lead && typeof lead === 'object' ? lead.leadTypes : undefined;
    if (!Array.isArray(raw))
        return null;
    const out = [];
    for (const v of raw) {
        const n = typeof v === 'string' && /^-?[0-9]{1,3}$/.test(v.trim()) ? Number(v) : v;
        if (!Number.isInteger(n))
            return null;
        if (n > 0 && !out.includes(n))
            out.push(n);
    }
    return out;
}
/** Existing + wanted (Seller / Buyer only): every existing type kept in its place, the missing ones appended. */
function mergeLeadTypes(existing, wanted) {
    const added = cleanLeadTypes(wanted).filter((n) => exports.MERGEABLE_LEAD_TYPES.includes(n) && !existing.includes(n));
    return { merged: [...existing, ...added], added };
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
 * tags are not put in a create body (they go on afterwards by read-merge-write, so a create Lofty folds
 * into an existing Do Not Contact lead cannot start a Smart Plan) unless the caller passes `createTags`
 * (0.5.0: Listing Engine's intake senders, whose tags must not start a "tag added" plan). The address
 * (`property`) and custom fields (`customAttributes`) go in only when given.
 */
function buildLeadBody(input, createTags = []) {
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
    const types = cleanLeadTypes(input.leadTypes);
    if (types.length)
        body.leadTypes = types;
    const assignee = String(input.assignedUserId ?? '').trim();
    if (/^[0-9]{1,20}$/.test(assignee))
        body.assignedUserId = Number.isSafeInteger(Number(assignee)) ? Number(assignee) : assignee;
    const property = leadProperty(input.property);
    if (property)
        body.property = property;
    const attrs = cleanCustomAttributes(input.customAttributes);
    if (attrs.length)
        body.customAttributes = attrs;
    const tags = createBodyTags(createTags);
    if (tags.length)
        body.tags = tags;
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
/** POST /leads (always cannotText:true) and read the response for a merge. `createTags`: see buildLeadBody. */
async function createLeadResult(input, deps, createTags = []) {
    const res = await loftyRequest('POST', '/leads', buildLeadBody(input, createTags), deps);
    const made = createResponseMerge(res);
    if (!made)
        throw new LoftyError('Lofty POST /leads succeeded but the response had no lead id', undefined, 'no_lead_id');
    return made;
}
async function getLead(leadId, deps) {
    const res = await loftyRequest('GET', `/leads/${encodeURIComponent(leadId)}`, undefined, deps);
    return res?.lead ?? res?.data ?? res;
}
function lookupRefusal(field, message, code, status, leadIds) {
    const err = new LoftyError(message, status, code, leadIds);
    err.lookup = field;
    return err;
}
/** One exact search (up to LOOKUP_LIMIT results): Lofty's list, or a refusal (lookup_failed) when it cannot be read. */
async function searchRaw(field, value, deps) {
    let res;
    try {
        res = await loftyRequest('GET', `/leads?${field}=${encodeURIComponent(value)}&preciseSearchFlag=true&limit=${exports.LOOKUP_LIMIT}`, undefined, deps);
    }
    catch (err) {
        if (err?.code === 'rate_limited' || err?.code === 'not_configured')
            throw err;
        throw lookupRefusal(field, `lookup_failed: ${err?.message || err}; nothing written (a retry may fix it)`, 'lookup_failed', err?.status);
    }
    const list = Array.isArray(res) ? res : (res?.leads ?? res?.data?.leads ?? res?.data);
    if (!Array.isArray(list))
        throw lookupRefusal(field, `lookup_failed: the ${field} search answered in an unexpected shape; nothing written`, 'lookup_failed');
    return list;
}
async function searchLead(field, value, carries, deps) {
    const what = field === 'email' ? 'this email' : 'this phone number';
    const refuse = (message, code, status, leadIds) => lookupRefusal(field, message, code, status, leadIds);
    const list = await searchRaw(field, value, deps);
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
async function searchList(field, value, carries, deps) {
    const list = await searchRaw(field, value, deps);
    const exact = list.filter((lead) => lead && typeof lead === 'object' && carries(lead));
    if (list.length && !exact.length) {
        const ids = list.map(leadIdOf).filter((x) => !!x).filter((x, i, all) => all.indexOf(x) === i);
        throw lookupRefusal(field, `no_exact_match: the ${field} search returned ${list.length} lead(s), none carrying this ${field}; nothing written, check in Lofty by hand`, 'no_exact_match', undefined, ids);
    }
    const ids = [];
    const leads = [];
    for (const lead of exact) {
        const id = leadIdOf(lead);
        if (!id)
            throw lookupRefusal(field, `lookup_failed: an exact ${field} match has no readable lead id; nothing written`, 'lookup_failed');
        if (!ids.includes(id)) {
            ids.push(id);
            leads.push(lead);
        }
    }
    return { exact: leads, ids, full: list.length >= exports.LOOKUP_LIMIT };
}
/**
 * Command Center's rule (0.5.0, pushLead `match: 'email_and_phone'`): both searches run, and the person's lead is the
 * ONE email match that also holds the phone (every exact phone match counts), or the only email match when nobody has
 * the phone. Refused, with nothing written and nothing created: a failed or loose search; several such leads; one
 * candidate among several email matches when either search came back full; a single email match from a full email
 * search; the phone only on other people's leads (`already_in_lofty`: never merged by phone alone). null = nobody has
 * the email or the phone.
 */
async function findLeadNarrowed(person, deps) {
    const email = (0, contact_ts_1.normEmail)(person.email);
    const phone = phoneKey(person.phone);
    const none = { exact: [], ids: [], full: false };
    const byEmail = email ? await searchList('email', email, (lead) => leadEmails(lead).includes(email), deps) : none;
    const byPhone = phone ? await searchList('phone', phone, (lead) => leadPhoneKeys(lead).includes(phone), deps) : none;
    const candidates = byPhone.ids.length ? byEmail.ids.filter((id) => byPhone.ids.includes(id)) : byEmail.ids;
    const list = (ids) => ids.join(', ');
    if (candidates.length > 1) {
        throw lookupRefusal('email', `several_leads: ${candidates.length} Lofty leads carry this email${byPhone.ids.length ? ' and this phone' : ''} (${list(candidates)}); nothing written, check in Lofty and update the right lead by hand`, 'several_leads', undefined, candidates);
    }
    if (candidates.length === 1 && byEmail.ids.length > 1 && (byEmail.full || byPhone.full)) {
        throw lookupRefusal('email', `several_leads: ${byEmail.ids.length} Lofty leads carry this email (${list(byEmail.ids)}) and a search came back full (${exports.LOOKUP_LIMIT}); nothing written`, 'several_leads', undefined, byEmail.ids);
    }
    if (candidates.length === 1 && byEmail.ids.length === 1 && byEmail.full) {
        throw lookupRefusal('email', `several_leads: the email search came back full (${exports.LOOKUP_LIMIT}); there may be more leads with this email, nothing written`, 'several_leads', undefined, byEmail.ids);
    }
    if (!candidates.length && byPhone.ids.length) {
        throw lookupRefusal('phone', `already_in_lofty: this phone is on Lofty lead(s) ${list(byPhone.ids)}${byEmail.ids.length ? `, and this email on ${list(byEmail.ids)}` : ' without this email'}; never merged by phone alone, nothing written, check in Lofty by hand`, 'already_in_lofty', undefined, byPhone.ids);
    }
    if (candidates.length === 1)
        return { id: candidates[0], lead: byEmail.exact[byEmail.ids.indexOf(candidates[0])], by: 'email' };
    return null;
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
 * 0.5.6: a second read of a lead whose own read had no tag list: ONE exact search by the lead's own email (else its
 * phone), and only this same lead id with a readable list counts. Anything else (no email or phone, a failed search,
 * the lead not in the answer, no list there either) is null, and the caller holds as before.
 */
async function tagsFromSearch(leadId, lead, deps) {
    const email = leadEmails(lead)[0];
    const phone = email ? '' : (leadPhoneKeys(lead)[0] ?? '');
    if (!email && !phone)
        return null;
    let list;
    try {
        list = await searchRaw(email ? 'email' : 'phone', email || phone, deps);
    }
    catch {
        return null;
    }
    const same = list.filter((l) => l && typeof l === 'object' && leadIdOf(l) === leadId);
    if (same.length !== 1)
        return null;
    return existingTagsForWrite(same[0].tags);
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
        throw new LoftyError(msg, undefined, 'read_mismatch');
    }
    if (change.expectFirstName !== undefined && firstNamesDiffer(lead.firstName, change.expectFirstName)) {
        const err = new LoftyError(`name_differs: lead ${leadId}'s first name is another real name; nothing written until identity is reviewed`, undefined, 'name_differs', [String(leadId)]);
        err.nameOnLead = cut(lead.firstName, 60);
        throw err;
    }
    if (deps.checkLead) {
        const phonesOnLead = (leadPhonesForWrite(lead) ?? []).map((p) => (0, contact_ts_1.normPhone)(p)).filter((p) => !!p);
        const listed = await deps.checkLead({ leadId: String(leadId), emails: leadEmails(lead), phones: [...new Set(phonesOnLead)] });
        if (listed?.doNotContact)
            change = { ...change, doNotContact: true };
        else if (listed?.emailOptOut)
            change = { ...change, emailOptOut: true, holdTags: true };
    }
    let existingRead = existingTagsForWrite(lead.tags);
    let tagsFrom;
    if (existingRead === null && (lead.tags === undefined || lead.tags === null)) {
        // A list that is THERE but unreadable (a tag with no name, another shape) always holds. A missing one is either a
        // lead with no tags at all (Lofty answers a create without tags this way) or a read that dropped the field.
        if (change.createdBlank === true) {
            existingRead = [];
            tagsFrom = 'new_lead';
        }
        else {
            const listed = await tagsFromSearch(String(leadId), lead, deps);
            if (listed) {
                existingRead = listed;
                tagsFrom = 'search';
            }
        }
    }
    const out = { tagsAdded: [], emailTurnedOff: false, consentApplied: false, textingNotEnabled: null, wrote: false,
        textingTurnedOff: false, phoneAdded: false, dncHeld: false, phoneDnc: false, tagsHeld: [], before: lead };
    if (tagsFrom)
        out.tagsFrom = tagsFrom;
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
    // 0.5.0: a write that ADDS `#dnc` (a number on a Do Not Call list) switches texting off in the same PUT.
    const phoneDnc = dnc || phoneDncBefore || (change.addTags ?? []).some((t) => isPhoneDncTag(cleanTag(t)));
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
    // 0.5.4: an opt-out's source labels go on below, after the holds (a label only ever records a stop).
    const labels = (change.labelTags ?? []).map(cleanTag).filter(isOptOutLabelTag);
    // A tag the caller asks to add is never also taken off (even when a hold keeps it from going on).
    const addWanted = new Set([...requested, ...labels].map((t) => cleanTag(t).toLowerCase()));
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
    if (labels.length)
        requested = [...requested, ...labels];
    // 0.5.0: tags taken off in the same write (never a protected one, never one this write also adds).
    const removeWanted = new Set((change.removeTags ?? []).map(cleanTag).filter((t) => t && !isProtectedTag(t)).map((t) => t.toLowerCase()));
    const removed = out.tagsUnreadable || !removeWanted.size ? [] : existing.filter((t) => {
        const k = cleanTag(t).toLowerCase();
        return removeWanted.has(k) && !addWanted.has(k) && !isProtectedTag(t);
    });
    const kept = removed.length ? existing.filter((t) => !removed.includes(t)) : existing;
    const first = out.tagsUnreadable ? { merged: [], added: [] } : mergeTags(kept, requested);
    const merged = first.merged;
    let added = first.added;
    // 0.5.8 (Oct 26, 2026): Lofty did not take tags off in a PUT that also added one. 11 of 11 relisted Expired Elite
    // sellers kept "Expired Elite" (their plans kept running) when "Expired Elite - OPTED OUT" went on in the same PUT;
    // the ones that only lost tags were fine. So a write that does both takes the tags off first (with every other
    // field), reads them back gone, and only then adds, from that read (read-merge-write again).
    const removeFirst = removed.length > 0 && added.length > 0;
    if (added.length || removed.length)
        body.tags = removeFirst ? kept : merged;
    // 0.5.13: the missing lead types go in this same PUT (the first one when tags come off first); none is ever removed.
    let typesWanted = [];
    if (change.addLeadTypes) {
        const want = cleanLeadTypes(change.addLeadTypes).filter((n) => exports.MERGEABLE_LEAD_TYPES.includes(n));
        if (want.length) {
            const have = leadTypesForWrite(lead);
            // An email opt-out holds them as it holds plan tags: the shared list's (holdTags), or the lead's own in Lofty
            // (`Consent – Unsubscribed`, cannotEmail, Lofty's unsubscription), since a type can bring a lead into a plan's scope.
            const emailOut = change.holdTags === true || change.emailOptOut === true || existing.some(isEmailOptOutTag)
                || lead.cannotEmail === true || loftyUnsubscribed(lead) === true;
            const held = out.tagsUnreadable ? 'tags_unreadable' : dnc ? 'do_not_contact'
                : emailOut ? 'email_opt_out' : have === null ? 'types_unreadable' : null;
            if (held || !have) {
                out.leadTypes = { result: 'held', added: [], reason: held ?? 'types_unreadable' };
                logger(deps).warn(`${label(deps)} lead ${leadId}: lead types held (${out.leadTypes.reason}); nothing written to them`);
            }
            else {
                const m = mergeLeadTypes(have, want);
                if (!m.added.length)
                    out.leadTypes = { result: 'already', added: [] };
                else {
                    body.leadTypes = m.merged;
                    typesWanted = want;
                    out.leadTypes = { result: 'added', added: m.added };
                }
            }
        }
    }
    if (change.fillProperty) {
        const want = leadProperty(change.fillProperty);
        if (want && out.tagsUnreadable)
            out.property = 'held';
        else if (want) {
            const plan = planPropertyFill(lead, want);
            out.property = plan.result;
            if (plan.body)
                body.property = plan.body;
        }
    }
    let typesAnswer = null;
    if (Object.keys(body).length && removeFirst) {
        const path = `/leads/${encodeURIComponent(leadId)}`;
        let written = await loftyRequest('PUT', path, body, deps);
        typesAnswer = written;
        out.wrote = true;
        const back = await readBackRemoved(leadId, removed, deps);
        out.removeCheck = back.check;
        if (back.check === 'removed' && back.tags) {
            const second = mergeTags(back.tags, requested);
            added = second.added;
            if (added.length)
                written = await loftyRequest('PUT', path, { tags: second.merged }, deps);
        }
        else {
            added = []; // nothing added: the caller fails on removeCheck and tries the whole change again later
        }
        if (dncBefore || (change.doNotContact && added.some(isDoNotContactTag)))
            out.dncCheck = await confirmDncKept(leadId, written, deps, 'full');
        else if (phoneDncBefore)
            out.dncCheck = await confirmDncKept(leadId, written, deps, 'phone');
    }
    else if (Object.keys(body).length) {
        const written = await loftyRequest('PUT', `/leads/${encodeURIComponent(leadId)}`, body, deps);
        typesAnswer = written;
        out.wrote = true;
        if (dncBefore || (change.doNotContact && added.some(isDoNotContactTag)))
            out.dncCheck = await confirmDncKept(leadId, written, deps, 'full');
        else if (phoneDncBefore)
            out.dncCheck = await confirmDncKept(leadId, written, deps, 'phone');
        if (removed.length)
            out.removeCheck = await confirmRemoved(leadId, removed, deps);
    }
    if (removed.length)
        out.tagsRemoved = removed;
    if (typesWanted.length && out.wrote && out.leadTypes)
        out.leadTypes.check = await confirmLeadTypes(leadId, typesAnswer, typesWanted, deps);
    if (change.labelTags) {
        const wanted = new Set(labels.map((t) => t.toLowerCase()));
        out.labelsAdded = added.filter((t) => wanted.has(t.toLowerCase()));
        if (out.labelsAdded.length)
            out.labelCheck = await confirmAdded(leadId, out.labelsAdded, deps);
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
/** After a write that took tags off: re-read it (a 200 is not proof; see readBackRemoved). Never throws. */
async function confirmRemoved(leadId, removed, deps) {
    return (await readBackRemoved(leadId, removed, deps)).check;
}
/**
 * 0.5.12 (Oct 27, 2026): Lofty shows a change a few seconds late, so a removal that does not read back gone is read
 * again 2 s and then 5 s after the first read (waits of 2 s, then 3 s more) before it counts as "not removed".
 * Only a read that SAW the tag still on the lead is read again; an unreadable list is `unverified`, never retried
 * here. Every read is a plain GET, on the caller's read budget (`beforeCall`).
 */
exports.REMOVAL_READ_BACK_WAITS_MS = [2000, 3000];
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** confirmRemoved, plus the tags that read saw (null when it could not read this lead's list). Never throws. */
async function readBackRemoved(leadId, removed, deps) {
    let seen = await readRemovedOnce(leadId, removed, deps);
    let waited = 0;
    for (const wait of exports.REMOVAL_READ_BACK_WAITS_MS) {
        if (seen.check !== 'not_removed')
            break;
        try {
            await (deps.sleep ?? realSleep)(wait);
        }
        catch { /* read again anyway */ }
        waited += wait;
        seen = await readRemovedOnce(leadId, removed, deps);
        if (seen.check === 'removed')
            logger(deps).info(`${label(deps)} lead ${leadId}: the tag removal showed ${waited / 1000} s after the write`);
    }
    return seen;
}
/** ONE re-read of the lead's tags against the tags just taken off. Never throws. */
async function readRemovedOnce(leadId, removed, deps) {
    let tags = null;
    try {
        const again = await getLead(leadId, deps);
        const id = again && typeof again === 'object' ? (again.leadId ?? again.id) : undefined;
        if (id !== undefined && id !== null && String(id) === String(leadId))
            tags = existingTagsForWrite(again.tags);
    }
    catch { /* unverified below */ }
    if (tags === null)
        return { check: 'unverified', tags: null };
    const gone = new Set(removed.map((t) => cleanTag(t).toLowerCase()));
    return { check: tags.some((t) => gone.has(cleanTag(t).toLowerCase())) ? 'not_removed' : 'removed', tags };
}
/** 0.5.4: after a write that added opt-out labels: ONE re-read (a 200 is not proof). Never throws. */
async function confirmAdded(leadId, added, deps) {
    let tags = null;
    try {
        const again = await getLead(leadId, deps);
        const id = again && typeof again === 'object' ? (again.leadId ?? again.id) : undefined;
        if (id !== undefined && id !== null && String(id) === String(leadId))
            tags = existingTagsForWrite(again.tags);
    }
    catch { /* unverified below */ }
    if (tags === null)
        return 'unverified';
    const have = new Set(tags.map((t) => cleanTag(t).toLowerCase()));
    return added.every((t) => have.has(cleanTag(t).toLowerCase())) ? 'added' : 'not_added';
}
/**
 * 0.5.13: after a lead-type write: are the wanted types on the lead? The PUT's answer when it carries the list, else one
 * re-read, then one more after each of deps.readBackWaitsMs. Never throws. `not_shown` = read, and not there yet.
 */
async function confirmLeadTypes(leadId, answer, want, deps) {
    const shows = (o) => { const t = leadTypesForWrite(o); return t === null ? null : want.every((n) => t.includes(n)); };
    const inAnswer = [answer?.lead, answer?.data, answer].find((o) => o && typeof o === 'object' && Array.isArray(o.leadTypes));
    if (inAnswer && shows(inAnswer) === true)
        return 'shown';
    const waits = [0, ...(deps.readBackWaitsMs ?? []).filter((ms) => Number.isFinite(ms) && ms > 0)];
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let read = false;
    for (const ms of waits) {
        if (ms > 0)
            await sleep(ms);
        try {
            const again = await getLead(leadId, deps);
            const id = again && typeof again === 'object' ? (again.leadId ?? again.id) : undefined;
            if (id === undefined || id === null || String(id) !== String(leadId))
                continue;
            const s = shows(again);
            if (s === true)
                return 'shown';
            if (s === false)
                read = true;
        }
        catch { /* unverified below, unless another read answers */ }
    }
    if (read)
        logger(deps).warn(`${label(deps)} lead ${leadId}: lead types written but not shown on the read-back yet (Lofty shows a type change a few seconds later)`);
    return read ? 'not_shown' : 'unverified';
}
/** The address a lead read carries, nested (`property`) or flat. */
function leadAddressOf(lead) {
    const nested = lead?.property && typeof lead.property === 'object' ? lead.property : {};
    const pick = (k) => cut(nested[k], 200) || cut(lead?.[k], 200);
    return { streetAddress: pick('streetAddress'), city: pick('city'), state: pick('state'), zipCode: pick('zipCode') };
}
/**
 * Fill a lead's address without ever overwriting it (0.5.0): no street on the lead = the whole address goes on
 * (`filled`); the same street (suite-kit street key) with a blank city, state or ZIP = those blanks are filled, the
 * rest re-stated as read (`completed`); the same street with nothing blank = `same`; another street = `kept`.
 */
function planPropertyFill(lead, want) {
    const cur = leadAddressOf(lead);
    if (!cur.streetAddress)
        return { result: 'filled', body: want };
    const a = (0, address_ts_1.streetKey)(cur.streetAddress);
    if (!a || a !== (0, address_ts_1.streetKey)(want.streetAddress))
        return { result: 'kept', body: null };
    const next = { streetAddress: cur.streetAddress };
    let changed = false;
    for (const k of ['city', 'state', 'zipCode']) {
        if (cur[k])
            next[k] = cur[k];
        else if (want[k]) {
            next[k] = want[k];
            changed = true;
        }
    }
    return changed ? { result: 'completed', body: next } : { result: 'same', body: null };
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
// 0.5.9 (Oct 26, 2026): the toolkit's own read-back checks carry a code too. Expired Elite's 11 un-enrolments held on
// Oct 26 (a tag taken off was still on the lead) showed "held" with no code in the hub's log.
const CHECK_CODES = new Set(['dnc_lost', 'not_removed', 'removal_unread', 'label_not_added', 'label_unread', 'no_lead_id']);
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
    // 0.5.7: every other failed Lofty call gets a code too, so a hold is never "held, no reason" in the hub's log
    // (Oct 25, 2026: a new lead held after its create showed only that). Letters and underscores only: the hub's
    // log column takes nothing else; the HTTP status is in out.status.
    if (!out.code) {
        if (err?.code === 'timeout' || err?.code === 'network' || CHECK_CODES.has(err?.code))
            out.code = err.code;
        else if (typeof err?.status === 'number' && err.status >= 500)
            out.code = 'lofty_error';
        else if (typeof err?.status === 'number' && err.status >= 400)
            out.code = 'lofty_refused';
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
            m = await mergeIntoLead(survivor, { ...change, viaCreate: false, createdBlank: false }, deps);
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
        if (m.tagsRemoved?.length)
            out.tagsRemoved = m.tagsRemoved;
        if (m.property)
            out.property = m.property;
        if (m.leadTypes)
            out.leadTypes = m.leadTypes;
        if (m.dncCheck === 'lost') {
            out.dncLost = true;
            fail(out, step, new LoftyError(dncLostReason(out.leadId, m.dncHeld ? 'full' : 'phone'), undefined, 'dnc_lost'), deps);
            return m;
        }
        if (m.removeCheck && m.removeCheck !== 'removed') {
            fail(out, step, new LoftyError(`lead ${out.leadId}: ${m.removeCheck === 'not_removed' ? 'a tag that was taken off is still on the lead when read back' : 'the tag removal could not be read back'}; treated as not removed`, undefined, m.removeCheck === 'not_removed' ? 'not_removed' : 'removal_unread'), deps);
            out.needsReview = true;
            return m;
        }
        if (m.labelCheck && m.labelCheck !== 'added') {
            fail(out, step, new LoftyError(`lead ${out.leadId}: ${m.labelCheck === 'not_added' ? 'an opt-out label is not on the lead when read back' : 'the opt-out label could not be read back'}; treated as not added`, undefined, m.labelCheck === 'not_added' ? 'label_not_added' : 'label_unread'), deps);
            out.needsReview = true;
            return m;
        }
        if (m.tagsUnreadable) {
            fail(out, step, new LoftyError(m.tagsUnreadable), deps);
            out.code = 'tags_unreadable';
            out.needsReview = true;
            if (m.textingNotEnabled)
                out.textingNotEnabled = m.textingNotEnabled;
            return m;
        }
        out.tagsAdded = m.tagsAdded;
        if (m.labelsAdded)
            out.labelsAdded = m.labelsAdded;
        out.consentApplied = m.consentApplied;
        if (m.textingNotEnabled)
            out.textingNotEnabled = m.textingNotEnabled;
    }
    catch (err) {
        fail(out, step, err, deps);
        if (err?.code === 'read_mismatch')
            out.code = 'read_mismatch';
        if (err?.code === 'name_differs') {
            out.code = 'name_differs';
            out.needsReview = true;
            out.matchLeadIds = [String(out.leadId)];
            if (err.nameOnLead)
                out.nameOnLead = err.nameOnLead;
        }
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
    const byId = args.leadId !== undefined && /^[0-9]{1,20}$/.test(String(args.leadId)) ? String(args.leadId) : null;
    if (!byId && !hasLookupKey(args.lead)) {
        out.reason = exports.NO_LOOKUP_KEY;
        out.code = 'no_lookup_key';
        out.needsReview = true;
        logger(deps).warn(`${label(deps)} ${out.reason}`);
        return out;
    }
    let found;
    if (byId)
        found = { id: byId, lead: null, by: 'email' };
    else {
        try {
            found = args.match === 'email_and_phone' ? await findLeadNarrowed(args.lead, deps) : await findExistingLead(args.lead, deps);
        }
        catch (err) {
            if (err?.code === 'rate_limited')
                return fail(out, 'find lead', err, deps);
            return refuseLookup(out, err, deps);
        }
    }
    const tags = (args.tags ?? []).map(cleanTag).filter(Boolean);
    const consent = args.smsConsent === true ? (phoneKey(args.lead.phone) ? { phone: String(args.lead.phone) } : null) : null;
    if (args.smsConsent === true && !consent)
        out.textingNotEnabled = exports.CONSENT_NO_PHONE;
    if (found) {
        out.leadId = found.id;
        out.action = 'existing';
        out.matchedBy = byId ? 'lead_id' : found.by;
        const extra = {};
        if (args.removeTags?.length)
            extra.removeTags = args.removeTags;
        if (args.lead.property)
            extra.fillProperty = args.lead.property;
        if (args.expectFirstName !== undefined)
            extra.expectFirstName = args.expectFirstName;
        if (args.mergeLeadTypes === true && cleanLeadTypes(args.lead.leadTypes).length)
            extra.addLeadTypes = cleanLeadTypes(args.lead.leadTypes);
        await applyChange(out, { addTags: tags, smsConsent: consent, submittedPhone: args.lead.phone, emailOptOut: args.emailOptOut === true, ...extra }, args.lead.email, tags.length ? 'add tags' : 'update lead', deps);
    }
    else {
        if (args.create === false) {
            out.reason = 'no Lofty lead with this email or phone; not created (create: false)';
            return out;
        }
        let made;
        const createTags = args.createTags ?? [];
        try {
            made = await createLeadResult(args.lead, deps, createTags);
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
        const sent = buildLeadBody(args.lead, createTags);
        if (made.merged && (sent.tags !== undefined || sent.property !== undefined || sent.customAttributes !== undefined)) {
            // Lofty's create REPLACES list fields on the lead it folds into: that lead's own tags may be gone.
            out.createBodyMerged = true;
            out.needsReview = true;
            logger(deps).warn(`${label(deps)} create folded into existing lead ${made.leadId} while carrying tags, an address or custom fields`);
            try {
                await deps.alert?.('Lofty: a create carrying tags or fields was folded into an existing lead', [
                    `Lofty lead: ${made.leadId}`, `Writer: ${deps.label ?? 'suite-kit'}`,
                    'Lofty may have replaced that lead\'s tags, address or custom fields with the ones the create carried.',
                    'Check its Do Not Contact, opt-out and plan tags in Lofty by hand.',
                ]);
            }
            catch { /* logged above */ }
        }
        // Always re-read after a create: the tags go on by read-merge-write, and a create Lofty folded into an
        // existing lead must have that lead's Do Not Contact and numbers decide. 0.5.6: a lead this create made, for a
        // person the exact searches proved new, with no tags in the create body, has no tag list in Lofty's answer
        // (createdBlank: that means none, so its tags go on instead of holding every new lead).
        const createdBlank = !made.merged && sent.tags === undefined;
        // 0.5.13: a create Lofty folded into an existing lead may have replaced that lead's types with the create's (as it
        // does tags); with mergeLeadTypes the types asked for go back on in the read-merge-write that follows.
        const sentTypes = Array.isArray(sent.leadTypes) ? sent.leadTypes : [];
        const foldTypes = made.merged && args.mergeLeadTypes === true && sentTypes.length ? { addLeadTypes: sentTypes } : {};
        await applyChange(out, { addTags: tags, smsConsent: consent, submittedPhone: args.lead.phone, viaCreate: !made.merged,
            ...(createdBlank ? { createdBlank: true } : {}), emailOptOut: args.emailOptOut === true, ...foldTypes }, args.lead.email, tags.length ? 'add tags' : 'read back new lead', deps);
        if (!made.merged && sentTypes.length)
            out.leadTypes = { result: 'in_create', added: sentTypes };
    }
    const note = noteWithConsent(args.note, out.textingNotEnabled);
    if (out.leadId && note && note.trim() && !out.dncLost && out.code !== 'name_differs') {
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
 * 0.5.4: `labelTags` = the writing app's own source label (isOptOutLabelTag), in the same PUT, also on a Do Not
 * Contact lead, read back once after the write (`labelsAdded`; a label not read back is not ok, needsReview).
 */
async function applyOptOut(args, deps) {
    const out = blank();
    const labelTags = args.labelTags?.length ? args.labelTags : undefined;
    if (labelTags)
        out.labelsAdded = [];
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
    const m = await applyChange(out, { ...(args.kind === 'email' ? { emailOptOut: true } : { doNotContact: true }), ...(labelTags ? { labelTags } : {}) }, args.email, `${args.kind} opt-out`, deps);
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
