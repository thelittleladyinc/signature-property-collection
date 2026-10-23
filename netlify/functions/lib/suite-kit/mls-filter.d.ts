export declare const MLS_API_BASE = "https://api.mlsgrid.com/v2";
export declare const MLS_SYSTEM_NAME = "ires";
export declare const MLS_RESOURCES: readonly ["Property", "OpenHouse", "Member", "Office", "Lookup"];
export type MlsResource = (typeof MLS_RESOURCES)[number];
export declare const MAX_OR = 5;
export declare const MAX_IN_VALUES = 20;
export declare const MAX_TOP = 5000;
export declare const MAX_TOP_WITH_MEDIA = 1000;
/** The only fields a $filter built here may name (MLS Grid's Property replication list; ListingKey is not on it). */
export declare const FILTER_FIELDS: readonly ["OriginatingSystemName", "ModificationTimestamp", "MlgCanView", "StandardStatus", "ListingId"];
/** StandardStatus words on this IRES feed (with spaces). */
export declare const MLS_STATUSES: readonly ["Active", "Active Under Contract", "Canceled", "Closed", "Coming Soon", "Expired", "Hold", "Pending", "Withdrawn"];
export declare class MlsFilterError extends Error {
    constructor(message: string);
}
/** Throws unless `filter` obeys every filter rule. Returns it unchanged. */
export declare function assertSafeFilter(filter: unknown): string;
/** One validated $filter clause. Only the functions below create one. */
export declare class Clause {
    readonly text: string;
    constructor(text: string, key: symbol);
}
export type TimestampOp = 'gt' | 'ge' | 'lt' | 'le';
export declare function modifiedClause(op: TimestampOp, iso: string): Clause;
export declare function canViewClause(value: boolean): Clause;
export declare function statusInClause(statuses: readonly string[]): Clause;
/** ListingId in ('IRE1059808', ...): at most 20 MLS numbers, exactly as MLS Grid (and mls.property.listing_id) spell them. */
export declare function listingIdsClause(ids: readonly string[]): Clause;
/** The field names a $filter compares (quoted values left out), in order. */
export declare function filterFields(filter: string): string[];
/** OriginatingSystemName eq 'ires' first, then the clauses, joined with "and". */
export declare function buildFilter(...clauses: Clause[]): string;
export interface PropertyUrlOptions {
    top?: number;
    select?: readonly string[];
    /** Ask for $expand=Media (page size is then at most 1,000). */
    media?: boolean;
}
/** Property changed since a checkpoint: gt normally, ge when resuming after a crash. Not filtered on MlgCanView, so removals come back. */
export declare function propertyIncrementalUrl(o: PropertyUrlOptions & {
    since: string;
    inclusive: boolean;
}): string;
/** Bootstrap window: viewable records of the given statuses modified in [from, until). */
export declare function propertyWindowUrl(o: PropertyUrlOptions & {
    statuses: readonly string[];
    from: string;
    until: string;
}): string;
/** At most 20 listings by MLS number (ListingId), optionally with their photos ($expand=Media). */
export declare function propertyByListingIdsUrl(o: {
    ids: readonly string[];
    select?: readonly string[];
    media?: boolean;
}): string;
/** Keys of every viewable listing (reconciliation): $select=ListingKey, 5,000 a page. */
export declare function propertyKeysUrl(o?: {
    since?: string;
    top?: number;
}): string;
/** OpenHouse, Member or Office changed since a checkpoint. */
export declare function resourceIncrementalUrl(resource: 'OpenHouse' | 'Member' | 'Office', o: {
    since: string;
    inclusive: boolean;
    top?: number;
}): string;
/** The pick-lists (daily at most). */
export declare function lookupUrl(o?: {
    top?: number;
}): string;
/**
 * Check a URL is one this module could have built and return it UNCHANGED.
 * Throws for another host, scheme, port, credentials, a path other than
 * /v2/<allowed resource> (so no /Media, no /Property('key')/Media), an unknown
 * query option, or a $filter that breaks a rule.
 */
export declare function assertMlsUrl(url: unknown): string;
/** The @odata.nextLink of a page, verbatim. */
export declare function followNextLink(link: unknown): string;
