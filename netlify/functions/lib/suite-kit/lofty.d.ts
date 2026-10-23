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
/**
 * A tag no writer may ever take off a lead (0.5.0): every `Consent – …` tag (DNC, Unsubscribed, SMS Opt-In, Spam
 * Complaint, Bounced, …), the Do Not Contact tags (`OPTED OUT`, `Expired Elite – OPTED OUT`), `#dnc`,
 * `Newsletter Unsubscribed` and `System – Kill All Drips`; any dash, any case, whole tag.
 */
export declare function isProtectedTag(name: unknown): boolean;
/**
 * Two real, different first names (Command Center's rule, 0.5.0): a missing or placeholder name on either side is
 * never a difference.
 */
export declare function firstNamesDiffer(a: unknown, b: unknown): boolean;
/** Lofty's own `unsubscription` flag on a lead read: true / false, or null when the read does not say (0.5.0). */
export declare function loftyUnsubscribed(lead: any): boolean | null;
/** How many results one exact email or phone search asks for. */
export declare const LOOKUP_LIMIT = 5;
export type LookupRefusalCode = 'several_leads' | 'no_exact_match' | 'lookup_failed' | 'already_in_lofty';
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
    /**
     * 0.5.2, a dry run (createLoftyPlan): no POST, PUT or DELETE is sent; each is recorded in the plan and answered as
     * Lofty would. Reads still go to Lofty, except a read of a lead the plan wrote to or would have created.
     */
    plan?: LoftyPlan;
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
    /** name_differs (0.5.0): the first name the lead carries. */
    nameOnLead?: string;
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
    /**
     * The person's own home (0.5.0): Lofty's nested `property` object on a create; on an existing lead only blanks
     * are filled (see LeadChange.fillProperty). Lofty discards flat address fields.
     */
    property?: LeadProperty;
    /** Lofty custom fields sent in the create body (0.5.0; Expired Elite's shape). Never sent to an existing lead. */
    customAttributes?: Array<{
        attributeName: string;
        value: string;
    }>;
}
/** A lead's address the way Lofty takes it (0.5.0). */
export interface LeadProperty {
    streetAddress: string;
    city?: string;
    state?: string;
    zipCode?: string;
}
/** A clean LeadProperty, or null without a street (0.5.0). */
export declare function leadProperty(p: unknown): LeadProperty | null;
/** Custom fields for a create body: name 1-60 characters, value a string of at most 250; at most 20 (0.5.0). */
export declare function cleanCustomAttributes(list: unknown): Array<{
    attributeName: string;
    value: string;
}>;
/** Tags for a create body: clean, no consent / Do Not Contact / opt-out tag, no repeats, at most 20 (0.5.0). */
export declare function createBodyTags(list: unknown): string[];
export declare function isLoftyConfigured(deps: Partial<LoftyDeps> | null | undefined): boolean;
/** The HTTP methods the client sends (DELETE since 0.5.0: Lofty's webhook unsubscribe). */
export type LoftyMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
/** Low-level request. Throws LoftyError; the message never contains a query string or the key. */
export declare function loftyRequest(method: LoftyMethod, path: string, body: unknown, deps: LoftyDeps): Promise<any>;
/**
 * loftyRequest with Lofty's answer as text (0.5.0), for an id that may not fit a JavaScript number (Lofty ids are
 * 64-bit). A string `body` is sent exactly as given (raw JSON, e.g. an id written as digits). Throws like loftyRequest.
 */
export declare function loftyRequestText(method: LoftyMethod, path: string, body: unknown, deps: LoftyDeps): Promise<{
    status: number;
    text: string;
}>;
/** How a dry run's answer shows the lead it would have created (in paths, bodies and the outcome). */
export declare const PLANNED_NEW_LEAD_ID = "{new_lead_id}";
/** How a dry run's answer shows the task it would have created. */
export declare const PLANNED_NEW_TASK_ID = "{new_task_id}";
/** One write a dry run would have sent: Lofty's full path ('/v1.0/leads/123', '/v2.0/tasks') and the body as sent. */
export interface LoftyPlannedRequest {
    method: 'POST' | 'PUT' | 'DELETE';
    path: string;
    /** The JSON body as it would have gone; a raw JSON text body (64-bit ids written as digits) stays that exact text. */
    body: unknown;
}
export interface LoftyPlan {
    /** Every write, in the order it would have been sent. Use plannedRequests() for an answer. */
    writes: LoftyPlannedRequest[];
    /** Reads answered from the plan instead of Lofty (a read-back after a planned write, a read of the planned new lead). */
    readBacks: number;
    /** Leads as they would be after the planned writes (lead id -> lead). */
    after: Map<string, Record<string, unknown>>;
    /** Leads as last read from Lofty in this run (lead id -> lead). */
    seen: Map<string, Record<string, unknown>>;
}
export declare function createLoftyPlan(): LoftyPlan;
/** Lofty's own path for a request path: '/leads/1' -> '/v1.0/leads/1'; a versioned path ('/v2.0/tasks') as is. */
export declare function loftyFullPath(path: string): string;
/**
 * A dry run's answer to one request, or null when the request must really be sent (a read the plan cannot answer).
 * A write is recorded and answered the way Lofty answers it: a create with the stand-in lead id (the plan then holds
 * the new lead as the create body describes it), a task with the stand-in task id, anything else with {}.
 */
export declare function planRequest(plan: LoftyPlan, method: LoftyMethod, path: string, body: unknown): {
    status: number;
    text: string;
} | null;
/** A real read in a dry run: remember the lead as Lofty returned it, so a later planned PUT starts from it. */
export declare function planSawRead(plan: LoftyPlan, path: string, text: string): void;
/** Is this the stand-in id of a lead or task a dry run would have created (digits or the shown form)? */
export declare function isPlannedId(v: unknown): boolean;
/** Any value with the stand-in ids shown as `{new_lead_id}` / `{new_task_id}` (strings, numbers, nested). */
export declare function withPlannedIds<T>(v: T): T;
/** The writes a dry run would have sent, in order, with the stand-in ids shown. */
export declare function plannedRequests(plan: LoftyPlan): LoftyPlannedRequest[];
/**
 * The same dry run for code that calls Lofty through a plain fetch (the hub's _shared/lofty-lead.ts): a write is
 * recorded and answered without a network call; a read of a lead the plan wrote to is answered from the plan; any
 * other read goes to `fetchImpl` after `beforeRead` (throw to refuse it, e.g. the hub's read budget). Lofty's host only.
 */
export declare function planningFetch(plan: LoftyPlan, fetchImpl: FetchLike, opts?: {
    beforeRead?: () => Promise<void>;
}): FetchLike;
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
 * tags are not put in a create body (they go on afterwards by read-merge-write, so a create Lofty folds
 * into an existing Do Not Contact lead cannot start a Smart Plan) unless the caller passes `createTags`
 * (0.5.0: Listing Engine's intake senders, whose tags must not start a "tag added" plan). The address
 * (`property`) and custom fields (`customAttributes`) go in only when given.
 */
export declare function buildLeadBody(input: LoftyLeadInput, createTags?: string[]): Record<string, unknown>;
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
/** POST /leads (always cannotText:true) and read the response for a merge. `createTags`: see buildLeadBody. */
export declare function createLeadResult(input: LoftyLeadInput, deps: LoftyDeps, createTags?: string[]): Promise<CreatedLead>;
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
/**
 * Command Center's rule (0.5.0, pushLead `match: 'email_and_phone'`): both searches run, and the person's lead is the
 * ONE email match that also holds the phone (every exact phone match counts), or the only email match when nobody has
 * the phone. Refused, with nothing written and nothing created: a failed or loose search; several such leads; one
 * candidate among several email matches when either search came back full; a single email match from a full email
 * search; the phone only on other people's leads (`already_in_lofty`: never merged by phone alone). null = nobody has
 * the email or the phone.
 */
export declare function findLeadNarrowed(person: {
    email?: unknown;
    phone?: unknown;
}, deps: LoftyDeps): Promise<FoundLead | null>;
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
    /** 0.5.0: tag names to take off (case-blind, whole tag); a protected tag (isProtectedTag) is never taken off. */
    removeTags?: string[];
    /** 0.5.0: fill the lead's address where it is blank (see planPropertyFill); never overwritten. */
    fillProperty?: LeadProperty;
    /** 0.5.0: the first name the person gave; another real first name on the lead refuses (name_differs), nothing written. */
    expectFirstName?: string;
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
    /** 0.5.0: tags taken off by this write (the lead's own spelling). */
    tagsRemoved?: string[];
    /** 0.5.0: after a write that took tags off, one re-read: gone, still there, or not readable. */
    removeCheck?: 'removed' | 'not_removed' | 'unverified';
    /** 0.5.0: the address (fillProperty): filled (none before), completed (same street, blanks filled), same, kept (another street), held (tags unreadable). */
    property?: 'filled' | 'completed' | 'same' | 'kept' | 'held';
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
 * Fill a lead's address without ever overwriting it (0.5.0): no street on the lead = the whole address goes on
 * (`filled`); the same street (suite-kit street key) with a blank city, state or ZIP = those blanks are filled, the
 * rest re-stated as read (`completed`); the same street with nothing blank = `same`; another street = `kept`.
 */
export declare function planPropertyFill(lead: any, want: LeadProperty): {
    result: 'filled' | 'completed' | 'same' | 'kept';
    body: LeadProperty | null;
};
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
    code?: LookupRefusalCode | 'no_lookup_key' | 'not_configured' | 'rate_limited' | 'busy' | 'name_differs';
    needsReview?: boolean;
    matchLeadIds?: string[];
    matchedBy?: 'email' | 'phone' | 'lead_id';
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
    /** 0.5.0: tags taken off the lead (removeTags), read back gone. */
    tagsRemoved?: string[];
    /** 0.5.0: the address on an existing lead (see LeadChangeResult.property). */
    property?: LeadChangeResult['property'];
    /** 0.5.0, code name_differs: the first name the found lead carries (nothing was written). */
    nameOnLead?: string;
    /** 0.5.0: a create carrying tags, an address or custom fields was folded into an existing lead: check that lead. */
    createBodyMerged?: boolean;
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
    /** 0.5.0: write to this one known lead: no lookup, never a create. */
    leadId?: string;
    /** 0.5.0: 'email_and_phone' = findLeadNarrowed (Command Center's rule). Default: email, then phone. */
    match?: 'email_then_phone' | 'email_and_phone';
    /** 0.5.0: see LeadChange.expectFirstName (a found lead only). */
    expectFirstName?: string;
    /** 0.5.0: tags to take off in the same read-merge-write (see LeadChange.removeTags). */
    removeTags?: string[];
    /** 0.5.0: tags sent IN the create body (a create only, never an existing lead; see buildLeadBody). */
    createTags?: string[];
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
