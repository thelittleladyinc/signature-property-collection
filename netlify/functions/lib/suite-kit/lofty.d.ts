export declare const LOFTY_API_ORIGIN = "https://api.lofty.com";
export declare const LOFTY_API_PREFIX = "/v1.0";
/** Lofty's SMS consent tag (EN DASH). */
export declare const SMS_CONSENT_TAG = "Consent \u2013 SMS Opt-In";
/**
 * Christine's two DNC tags (EN DASH; plain lower case). A full Do Not Contact write always sets BOTH.
 * `Consent – DNC` = no email, no call, no text. `#dnc` = phone only (no calls or texts; email still allowed).
 */
export declare const DNC_TAG = "Consent \u2013 DNC";
export declare const DNC_HASH_TAG = "#dnc";
export declare const DNC_WRITE_TAGS: readonly ["Consent – DNC", "#dnc"];
/** Her email opt-out tag (EN DASH): an opt-out is this tag AND cannotEmail:true. */
export declare const EMAIL_OPTOUT_TAG = "Consent \u2013 Unsubscribed";
/** The note a lead gets when a number without a yes to texts switched its texting off. */
export declare const NEW_NUMBER_NOTE = "New number added without a yes to texts; texting turned off.";
/** Why a yes to texts is held while texting is switched off suite-wide. */
export declare const TEXTING_OFF_REASON = "texting stays off until Lofty approves 10DLC campaign 12744: texting left off, SMS consent tag not added";
/**
 * Full Do Not Contact (no email, no call, no text): "Consent – DNC", "OPTED OUT" or "Expired Elite – OPTED OUT",
 * whole tag, however the dash or the case was typed. "Consent – DNC Email" is a different tag and is not
 * matched. NOT `#dnc`, which is phone only. Every "may we email?" question uses this test.
 */
export declare function isDoNotContactTag(name: unknown): boolean;
/** `#dnc` itself (any case, whole tag). */
export declare function isPhoneOnlyDncTag(name: unknown): boolean;
/**
 * No calls and no texts: `#dnc` (phone only) or any full Do Not Contact tag. Every "may we call or text?"
 * question uses this test.
 */
export declare function isPhoneDncTag(name: unknown): boolean;
/**
 * @deprecated Same as isPhoneDncTag (any DNC tag, `#dnc` included), so an older caller stays on the safe side.
 * Use isDoNotContactTag for an email decision and isPhoneDncTag for a call or text decision.
 */
export declare function isDncTag(name: unknown): boolean;
export declare function isEmailOptOutTag(name: unknown): boolean;
export declare function isSmsConsentTag(name: unknown): boolean;
/** A tag that only ever STOPS contact. These are the only tags a Do Not Contact lead may still be given. */
export declare function isStopContactTag(name: unknown): boolean;
/** How many results one exact email or phone search asks for. */
export declare const LOOKUP_LIMIT = 5;
export type LookupRefusalCode = 'several_leads' | 'no_exact_match' | 'lookup_failed';
export declare function isLookupRefusal(err: unknown): boolean;
export type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: 'error' | 'manual';
}) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    headers?: {
        get(name: string): string | null;
    };
}>;
/** One Lofty call, as the onCall hook sees it. No query string, no body, no key. */
export interface LoftyCallRecord {
    method: string;
    /** Path without its query string, e.g. "/leads/123" or "/leads". */
    path: string;
    status: number | null;
    ok: boolean;
    ms: number;
    /** "network", "timeout", "rate_limited" (refused by beforeCall), or null. */
    error: string | null;
}
export interface LoftyDeps {
    /** LOFTY_API_KEY's value. Required: an empty key refuses every call ("not configured"). */
    apiKey: string;
    /** Defaults to globalThis.fetch, looked up at call time. */
    fetch?: FetchLike;
    timeoutMs?: number;
    /** Prefix for log lines, e.g. 'hub:lofty'. */
    label?: string;
    /** Defaults to console. */
    log?: Pick<Console, 'info' | 'warn'>;
    /** Team alert for a Do Not Contact tag lost in a write (lead id only). Default: log only. */
    alert?: (title: string, lines: string[]) => Promise<unknown>;
    /** Runs before every Lofty call; throw (e.g. a LoftyError with code 'rate_limited') to refuse it. */
    beforeCall?: (method: string, path: string) => Promise<void>;
    /** Runs after every Lofty call, success or not. Must not throw. */
    onCall?: (record: LoftyCallRecord) => void;
    /**
     * Allow `cannotText: false` and the SMS consent tag on an explicit, matching yes. Default false: texting
     * stays off suite-wide until Lofty approves 10DLC campaign 12744, and a yes is held with TEXTING_OFF_REASON.
     */
    allowTextingOn?: boolean;
    /** Milliseconds now; injected in tests. */
    now?: () => number;
    /**
     * One writer per lead. Called before the read of every read-merge-write and released after the PUT (and
     * the Do Not Contact re-check). Return the release function; throw (a LoftyError with code 'busy') to
     * refuse, and nothing is read or written. Without it, two writers that read the same lead before either
     * writes can lose a tag (Lofty's PUT replaces the whole list).
     */
    lockLead?: (leadId: string) => Promise<() => unknown>;
    /**
     * Checks the lead as read (inside the lock, before any write) against a list kept outside Lofty (the hub's ONE
     * shared opt-out list), by every email and phone ON THE LEAD, not only the ones the caller asked with. Do Not
     * Contact makes the write a Do Not Contact write-back (both DNC tags, texting and email off, every other tag held);
     * an email opt-out adds `Consent – Unsubscribed` + cannotEmail and holds the requested tags. Throw to refuse:
     * nothing is written.
     */
    checkLead?: (who: {
        leadId: string;
        emails: string[];
        phones: string[];
    }) => Promise<{
        doNotContact?: boolean;
        emailOptOut?: boolean;
    } | null>;
}
export declare class LoftyError extends Error {
    status?: number;
    code?: string;
    /** Lofty lead ids to check by hand (a refused lookup). */
    leadIds?: string[];
    /** Which lookup refused. */
    lookup?: 'email' | 'phone';
    /** Seconds to wait (a 429 from Lofty or from beforeCall). */
    retryAfterSeconds?: number;
    constructor(message: string, status?: number, code?: string, leadIds?: string[]);
}
export interface LoftyLeadInput {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    source?: string;
    /**
     * Lofty's numeric lead types (1 seller, 2 buyer, …), sent on a CREATE only (an existing lead keeps its own):
     * a Smart Plan enrols only the lead types in its scope.
     */
    leadTypes?: number[];
    /** The Lofty user a NEW lead is assigned to (Christine's user id); sent on a create only. */
    assignedUserId?: number | string;
}
export declare function isLoftyConfigured(deps: Partial<LoftyDeps> | null | undefined): boolean;
/** Low-level request. Throws LoftyError; the message never contains a query string or the key. */
export declare function loftyRequest(method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, deps: LoftyDeps): Promise<any>;
/** Clean one tag: string, trimmed, no control chars, capped. '' when unusable. */
export declare function cleanTag(t: unknown): string;
/** Lenient tag reading for read-only checks: strings, {name}/{tagName}/{tag} objects, or a comma list. */
export declare function normalizeTags(raw: unknown): string[];
/**
 * The lead's existing tags for a WRITE, or null when they cannot be trusted: `tags` missing or null, not
 * a list (or comma string), or an item with no readable name. Never "no tags": the PUT replaces the whole
 * list, so writing from such a read could drop `Consent – DNC`. Names are kept exactly as Lofty sent them.
 */
export declare function existingTagsForWrite(raw: unknown): string[] | null;
/**
 * Existing + requested. Every existing tag is kept exactly as it is; a requested tag is added unless the
 * lead already has it (ignoring case).
 */
export declare function mergeTags(existing: string[], requested: string[]): {
    merged: string[];
    added: string[];
};
/** The last 10 digits of a usable phone (suite-kit normPhone); '' when unusable. */
export declare function phoneKey(p: unknown): string;
/**
 * Every phone on a lead that was confirmed to be the right lead: `phones` (strings or {phone|number|value}
 * objects) plus the single `phone`. null = a malformed field, which is unreadable.
 */
export declare function leadPhonesForWrite(lead: any): string[] | null;
/** Every readable email on a lead read, lower-cased. */
export declare function leadEmails(lead: any): string[];
/** An explicit yes to texts: true, 1, or 'true' / 'yes' / 'y' / 'on' / '1' / 'checked'. Anything else is no. */
export declare function isExplicitYes(v: unknown): boolean;
export declare const CONSENT_NO_PHONE = "said yes to texts but gave no usable phone number: texting left off, SMS consent tag not added";
/**
 * Does an explicit SMS yes, given with `consentPhone`, apply to this lead? Only when every phone on the
 * lead (after this merge, when `phonesAfter` is given) is that number and there is at least one.
 * cannotText is one flag for the whole lead.
 */
export declare function consentVerdict(lead: any, consentPhone: unknown, phonesAfter?: string[] | null): {
    applies: boolean;
    reason: string | null;
};
export declare function leadIdOf(obj: any): string | null;
/** Does this lead read carry exactly this email (ignoring case)? */
export declare function leadCarriesEmail(lead: any, email: unknown): boolean;
export declare function splitName(name: unknown): {
    firstName: string;
    lastName: string;
};
/**
 * Lead body for POST /v1.0/leads. ALWAYS `cannotText: true`. Email and phone are normalised (E.164);
 * tags are never put in a create body (they go on afterwards by read-merge-write, so a create Lofty folds
 * into an existing Do Not Contact lead cannot start a Smart Plan).
 */
export declare function buildLeadBody(input: LoftyLeadInput): Record<string, unknown>;
export interface CreatedLead {
    /** The lead to work on: the surviving lead when Lofty merged the create into an existing one. */
    leadId: string;
    merged: boolean;
    mergedFrom: string | null;
}
/** What a POST /leads response says about a merge (Lofty can fold a create into an existing lead). */
export declare function createResponseMerge(res: any): CreatedLead | null;
export interface ConsentStatus {
    leadId: string;
    /** False when the tag list was missing or unreadable: then nothing below can be relied on, so hold. */
    tagsReadable: boolean;
    /** A full Do Not Contact tag (`Consent – DNC`, `OPTED OUT`, `Expired Elite – OPTED OUT`): no email, call or text. */
    doNotContact: boolean;
    /** `#dnc` or a full Do Not Contact tag: no calls and no texts (`#dnc` alone still allows email). */
    phoneDnc: boolean;
    /** `Consent – Unsubscribed` and/or cannotEmail: true (either stops email). */
    emailOptOut: boolean;
    /** The `Consent – Unsubscribed` tag itself (her opt-out is the tag AND cannotEmail). */
    emailOptOutTag: boolean;
    cannotEmail: boolean;
    cannotText: boolean;
    cannotCall: boolean;
    smsConsentTag: boolean;
    /** May an app email this lead? Only with a readable tag list, no full Do Not Contact tag, no email opt-out. `#dnc` does not stop email. */
    mayEmail: boolean;
    /** May an app call this lead? Only with a readable tag list, no `#dnc` or Do Not Contact tag, and cannotCall not true. */
    mayCall: boolean;
    /** Texting is off suite-wide (10DLC campaign 12744): always false unless allowTextingOn. */
    mayText: boolean;
    /** Plain reasons for every "may not". */
    reasons: string[];
    phones: string[];
    emails: string[];
}
/** What a lead read says about contacting this person. An unreadable tag list holds every channel. */
export declare function consentStatus(lead: any, opts?: {
    allowTextingOn?: boolean;
}): ConsentStatus;
/** "May we email this lead?" (tags and cannotEmail; `#dnc` alone does not stop email). Unreadable tags = no. */
export declare function mayEmailLead(lead: any): boolean;
/** "May we call this lead?" (`#dnc` or a Do Not Contact tag, or cannotCall, stops it). Unreadable tags = no. */
export declare function mayCallLead(lead: any): boolean;
/** "May we text this lead?" Always no unless allowTextingOn (10DLC campaign 12744); `#dnc` stops it. */
export declare function mayTextLead(lead: any, opts?: {
    allowTextingOn?: boolean;
}): boolean;
/**
 * "May we email?" from a tag list alone (no Lofty flags): readable, no full Do Not Contact tag and no
 * `Consent – Unsubscribed`. `#dnc` does not stop email. A missing or unreadable list = no (hold).
 */
export declare function tagsAllowEmail(rawTags: unknown): boolean;
/** "May we call or text?" from a tag list alone: readable, no `#dnc` and no full Do Not Contact tag. Unreadable = no. */
export declare function tagsAllowPhone(rawTags: unknown): boolean;
/** POST /leads (always cannotText:true) and read the response for a merge. */
export declare function createLeadResult(input: LoftyLeadInput, deps: LoftyDeps): Promise<CreatedLead>;
export declare function getLead(leadId: string, deps: LoftyDeps): Promise<any>;
/** A lead found by one exact search: its id and the search result itself. */
export interface FoundLead {
    id: string;
    lead: any;
    by: 'email' | 'phone';
}
/** One exact email search: exactly one exact match is the lead, none is null, anything else refuses. */
export declare function findLeadByEmail(email: unknown, deps: LoftyDeps): Promise<FoundLead | null>;
/** One exact phone search on the last 10 digits: exactly one exact match is the lead, none is null, anything else refuses. */
export declare function findLeadByPhone(phone: unknown, deps: LoftyDeps): Promise<FoundLead | null>;
/** The lead a person belongs to: by email first, then (missing or no match) by phone. A refusal throws. */
export declare function findExistingLead(person: {
    email?: unknown;
    phone?: unknown;
}, deps: LoftyDeps): Promise<FoundLead | null>;
/** Something to look the person up by before a create: a usable email or a usable phone. */
export declare function hasLookupKey(person: {
    email?: unknown;
    phone?: unknown;
}): boolean;
export interface LeadChange {
    /** Tag names to add; every existing tag is kept. */
    addTags?: string[];
    /** An explicit yes to texts on this form, and the number it was given with. */
    smsConsent?: {
        phone: string;
    } | null;
    /** The phone submitted with this intake; added to the lead when new (existing phones kept). */
    submittedPhone?: string;
    /** The submitted phone went to Lofty in the create body that produced this lead id. */
    viaCreate?: boolean;
    /** Email opt-out: `Consent – Unsubscribed` + cannotEmail:true in the same PUT. */
    emailOptOut?: boolean;
    /** Do Not Contact: both DNC tags + cannotText:true + cannotEmail:true in the same PUT. */
    doNotContact?: boolean;
    /** Hold every requested tag but the opt-out/stop tags (set by checkLead for a person on a shared email opt-out list). */
    holdTags?: boolean;
}
export interface LeadChangeResult {
    tagsAdded: string[];
    emailTurnedOff: boolean;
    consentApplied: boolean;
    textingNotEnabled: string | null;
    wrote: boolean;
    textingTurnedOff: boolean;
    phoneAdded: boolean;
    noteError?: string;
    /** Set when the lead's tags were missing or null: nothing written to tags, any yes held. */
    tagsUnreadable?: string;
    /** The lead is Do Not Contact (before or by this write): only stop-contact tags, texting and email off. */
    dncHeld: boolean;
    /** The lead is `#dnc` or Do Not Contact: texting off and no calls (`#dnc` alone leaves email and tags alone). */
    phoneDnc: boolean;
    tagsHeld: string[];
    /** After a write to a Do Not Contact lead: was a DNC tag seen again? */
    dncCheck?: 'kept' | 'lost' | 'unverified';
    /** The lead as read before the write (for a caller that mirrors it). */
    before: any;
}
/**
 * Read-merge-write ONE existing lead, in a single PUT (see the header for every rule). Throws LoftyError
 * when the read is not this lead; an unreadable tag list is reported in `tagsUnreadable` (a texting-off,
 * email-off or DNC flag write still goes through, since it touches no list).
 */
export declare function mergeIntoLead(leadId: string, change: LeadChange, deps: LoftyDeps): Promise<LeadChangeResult>;
/**
 * One writer per lead inside one process: `lockLead` for LoftyDeps. Writers to the same lead wait their
 * turn (first come, first served); writers to different leads never wait. A writer that waits longer than
 * `waitMs` is refused with a LoftyError code 'busy' (nothing read or written; try again later).
 */
export declare function createMemoryLeadLock(opts?: {
    waitMs?: number;
}): (leadId: string) => Promise<() => void>;
export declare function addNote(leadId: string, content: string, deps: LoftyDeps): Promise<void>;
/** The lead the email now lives on when Lofty merged `leadId` away: ONE exact lookup, a different single match only. */
export declare function followMerge(leadId: string, email: unknown, deps: LoftyDeps): Promise<string | null>;
/** POST the note; on a 404 (merged away) follow the email ONCE and retry there. Returns where it landed. */
export declare function addNoteFollowingMerge(leadId: string, content: string, email: unknown, deps: LoftyDeps): Promise<string>;
export interface LoftyOutcome {
    /** True only when every requested step succeeded. */
    ok: boolean;
    /** Set once a lead exists (created or found), even if a later step failed. */
    leadId: string | null;
    /** 'created' | 'existing' | null (nothing found or made). */
    action: 'created' | 'existing' | null;
    tagsAdded: string[];
    noteAdded: boolean;
    reason?: string;
    status?: number;
    /** Why nothing was written: a refused lookup, no lookup key, not configured, or rate limited. */
    code?: LookupRefusalCode | 'no_lookup_key' | 'not_configured' | 'rate_limited' | 'busy';
    needsReview?: boolean;
    matchLeadIds?: string[];
    matchedBy?: 'email' | 'phone';
    consentApplied?: boolean;
    textingNotEnabled?: string;
    textingTurnedOff?: boolean;
    emailTurnedOff?: boolean;
    merged?: boolean;
    mergedFrom?: string;
    dncHeld?: boolean;
    /** The lead is `#dnc` or Do Not Contact: no calls, no texts (email may still be allowed: see dncHeld). */
    phoneDnc?: boolean;
    tagsHeld?: string[];
    dncLost?: boolean;
    retryAfterSeconds?: number;
    /** The lead as last read (for a mirror); null when it was never read. */
    lead?: any;
}
/** Why nothing was created when there is nothing to look the person up by. */
export declare const NO_LOOKUP_KEY = "no email and no phone number with 10 digits to look the person up by: not created in Lofty; add them by hand";
export interface PushLeadArgs {
    lead: LoftyLeadInput;
    /** Tags to add by read-merge-write (never in the create body). Held on a Do Not Contact lead. */
    tags?: string[];
    note?: string;
    /** An explicit yes to texts, given with lead.phone. Held unless deps.allowTextingOn (see the header). */
    smsConsent?: boolean;
    /** false = never create; an unknown person is reported, not added. Default true. */
    create?: boolean;
    /**
     * The person is on a shared email opt-out list (the hub's): write the email opt-out (`Consent – Unsubscribed` +
     * cannotEmail) in the same read-merge-write, so Lofty agrees with the list.
     */
    emailOptOut?: boolean;
}
/**
 * Look up (email, then phone), then add to the one existing lead, or create (cannotText:true) and tag the
 * new lead by read-merge-write; then the note. A refused lookup, no lookup key, or a missing key writes
 * nothing. Never throws.
 */
export declare function pushLead(args: PushLeadArgs, deps: LoftyDeps): Promise<LoftyOutcome>;
/** Add tags to one known lead by read-merge-write (held on a Do Not Contact lead). Never throws. */
export declare function tagLead(leadId: string, tags: string[], deps: LoftyDeps): Promise<LoftyOutcome>;
/** A note on one known lead. Never throws. */
export declare function noteLead(leadId: string, content: string, deps: LoftyDeps): Promise<LoftyOutcome>;
export type OptOutKind = 'email' | 'do_not_contact';
/**
 * Apply an opt-out to the person's ONE lead (by lead id, else email, then phone). `email` = the email
 * opt-out (`Consent – Unsubscribed` + cannotEmail); `do_not_contact` = both DNC tags + cannotText +
 * cannotEmail. Consent writes never wait on any Smart Plan switch. When the tags cannot be read only the
 * flags go on and the outcome is NOT ok (needsReview): half an opt-out is not an opt-out. Never throws.
 */
export declare function applyOptOut(args: {
    kind: OptOutKind;
    leadId?: string;
    email?: unknown;
    phone?: unknown;
}, deps: LoftyDeps): Promise<LoftyOutcome>;
/** Read one lead and say what may be done with it (consentStatus). Never throws. */
export declare function lookupConsent(args: {
    leadId?: string;
    email?: unknown;
    phone?: unknown;
}, deps: LoftyDeps): Promise<{
    ok: true;
    found: false;
    reason: string;
} | {
    ok: true;
    found: true;
    matchedBy: 'lead_id' | 'email' | 'phone';
    status: ConsentStatus;
    lead: any;
} | {
    ok: false;
    outcome: LoftyOutcome;
}>;
