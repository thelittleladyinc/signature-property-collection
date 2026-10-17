"use strict";
// The ONLY builder of MLS Grid URLs and $filter strings (backbone plan P3).
// Nothing else in the repo may write an MLS Grid URL or filter by hand.
//
// Pure logic, no Node-only or Deno-only APIs (the URL class only), so the Edge
// Functions and the Node sync job share it. Byte-identical copies live in
// src/mls/mls-filter.ts (src/ cannot import from supabase/), in
// supabase/functions/_shared/mls-filter.ts and in the shared toolkit
// (packages/suite-kit/src/mls-filter.ts); tests keep all three identical and
// check they answer identically.
//
// What this file makes impossible (each is an MLS Grid rule; a breach of the
// first three helped get the token suspended on 2026-08-01):
//   * A $filter that does not start with  OriginatingSystemName eq 'ires'  and
//     names that field exactly once. A second system name throws.
//   * More than 5 " or " in a $filter. ID lists use  in (...)  with at most 20
//     values, never a chain of "or".
//   * Any resource except Property, OpenHouse, Member, Office and Lookup. There
//     is no function for /Media or /Property('key')/Media. Photos come only
//     from  $expand=Media  on Property.
//   * An unfiltered request (every URL carries a $filter) or a filter field
//     outside the proven list: OriginatingSystemName, ModificationTimestamp,
//     MlgCanView, StandardStatus, ListingKey.
//   * A page size above 5,000 (1,000 when Media is expanded).
//   * Following a link to another host: followNextLink() returns the
//     @odata.nextLink UNCHANGED (verbatim), after checking it is an https
//     api.mlsgrid.com /v2 URL for an allowed resource whose $filter passes the
//     same rules.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Clause = exports.MlsFilterError = exports.MLS_STATUSES = exports.MAX_TOP_WITH_MEDIA = exports.MAX_TOP = exports.MAX_IN_VALUES = exports.MAX_OR = exports.MLS_RESOURCES = exports.MLS_SYSTEM_NAME = exports.MLS_API_BASE = void 0;
exports.assertSafeFilter = assertSafeFilter;
exports.modifiedClause = modifiedClause;
exports.canViewClause = canViewClause;
exports.statusInClause = statusInClause;
exports.listingKeysClause = listingKeysClause;
exports.buildFilter = buildFilter;
exports.propertyIncrementalUrl = propertyIncrementalUrl;
exports.propertyWindowUrl = propertyWindowUrl;
exports.propertyByKeysUrl = propertyByKeysUrl;
exports.propertyKeysUrl = propertyKeysUrl;
exports.resourceIncrementalUrl = resourceIncrementalUrl;
exports.lookupUrl = lookupUrl;
exports.assertMlsUrl = assertMlsUrl;
exports.followNextLink = followNextLink;
exports.MLS_API_BASE = 'https://api.mlsgrid.com/v2';
exports.MLS_SYSTEM_NAME = 'ires';
exports.MLS_RESOURCES = ['Property', 'OpenHouse', 'Member', 'Office', 'Lookup'];
exports.MAX_OR = 5;
exports.MAX_IN_VALUES = 20;
exports.MAX_TOP = 5000;
exports.MAX_TOP_WITH_MEDIA = 1000;
/** StandardStatus words on this IRES feed (with spaces). */
exports.MLS_STATUSES = [
    'Active', 'Active Under Contract', 'Canceled', 'Closed', 'Coming Soon', 'Expired', 'Hold', 'Pending', 'Withdrawn',
];
const ORIGIN_CLAUSE = `OriginatingSystemName eq '${exports.MLS_SYSTEM_NAME}'`;
const FILTER_CHARS = /^[A-Za-z0-9 _.:\-',()]+$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ALLOWED_QUERY_KEYS = new Set(['$filter', '$select', '$expand', '$orderby', '$top', '$skip', '$skiptoken']);
class MlsFilterError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MlsFilterError';
    }
}
exports.MlsFilterError = MlsFilterError;
/** Throws unless `filter` obeys every filter rule. Returns it unchanged. */
function assertSafeFilter(filter) {
    if (typeof filter !== 'string' || !filter)
        throw new MlsFilterError('a $filter is required: an unfiltered request is never allowed');
    if (filter.length > 2000)
        throw new MlsFilterError('$filter is too long');
    if (!FILTER_CHARS.test(filter))
        throw new MlsFilterError('$filter has a character that is not allowed');
    if (filter !== ORIGIN_CLAUSE && !filter.startsWith(`${ORIGIN_CLAUSE} and `)) {
        throw new MlsFilterError(`$filter must start with ${ORIGIN_CLAUSE}`);
    }
    const names = filter.match(/OriginatingSystemName/gi) ?? [];
    if (names.length !== 1)
        throw new MlsFilterError('exactly one OriginatingSystemName per request');
    const ors = filter.match(/(?<=\s)or(?=\s)/gi) ?? [];
    if (ors.length > exports.MAX_OR)
        throw new MlsFilterError(`at most ${exports.MAX_OR} "or" per $filter (found ${ors.length}); use in (...) for ID lists`);
    for (const m of filter.matchAll(/\bin\s*\(([^)]*)\)/gi)) {
        const n = m[1].split(',').filter(v => v.trim() !== '').length;
        if (n > exports.MAX_IN_VALUES)
            throw new MlsFilterError(`at most ${exports.MAX_IN_VALUES} values in an in (...) list (found ${n})`);
    }
    return filter;
}
// ---- clauses: the only pieces a filter is made of -----------------------------------
const PRIVATE = Symbol('mls-clause');
/** One validated $filter clause. Only the functions below create one. */
class Clause {
    text;
    constructor(text, key) {
        if (key !== PRIVATE)
            throw new MlsFilterError('build clauses with the functions of mls-filter');
        this.text = text;
    }
}
exports.Clause = Clause;
function field(name, allowed) {
    if (!FIELD_RE.test(name) || !allowed.includes(name))
        throw new MlsFilterError(`filter field not allowed: ${name}`);
    return name;
}
function isoTimestamp(value, what) {
    if (typeof value !== 'string' || !ISO_RE.test(value) || !Number.isFinite(Date.parse(value))) {
        throw new MlsFilterError(`${what} must be an ISO timestamp like 2026-10-01T00:00:00.000Z`);
    }
    return new Date(value).toISOString();
}
function modifiedClause(op, iso) {
    if (!['gt', 'ge', 'lt', 'le'].includes(op))
        throw new MlsFilterError('bad operator');
    return new Clause(`${field('ModificationTimestamp', ['ModificationTimestamp'])} ${op} ${isoTimestamp(iso, 'ModificationTimestamp')}`, PRIVATE);
}
function canViewClause(value) {
    return new Clause(`${field('MlgCanView', ['MlgCanView'])} eq ${value ? 'true' : 'false'}`, PRIVATE);
}
function statusInClause(statuses) {
    if (!Array.isArray(statuses) || statuses.length < 1 || statuses.length > exports.MAX_IN_VALUES) {
        throw new MlsFilterError(`status list needs 1-${exports.MAX_IN_VALUES} values`);
    }
    for (const s of statuses)
        if (!exports.MLS_STATUSES.includes(s))
            throw new MlsFilterError(`unknown status: ${String(s)}`);
    return new Clause(`${field('StandardStatus', ['StandardStatus'])} in (${[...new Set(statuses)].map(s => `'${s}'`).join(',')})`, PRIVATE);
}
function listingKeysClause(keys) {
    if (!Array.isArray(keys) || keys.length < 1)
        throw new MlsFilterError('at least one ListingKey is required');
    if (keys.length > exports.MAX_IN_VALUES)
        throw new MlsFilterError(`at most ${exports.MAX_IN_VALUES} ListingKeys per request (got ${keys.length})`);
    for (const k of keys)
        if (typeof k !== 'string' || !KEY_RE.test(k))
            throw new MlsFilterError('a ListingKey has a character that is not allowed');
    return new Clause(`${field('ListingKey', ['ListingKey'])} in (${[...new Set(keys)].map(k => `'${k}'`).join(',')})`, PRIVATE);
}
/** OriginatingSystemName eq 'ires' first, then the clauses, joined with "and". */
function buildFilter(...clauses) {
    for (const c of clauses)
        if (!(c instanceof Clause))
            throw new MlsFilterError('build every clause with the functions of mls-filter');
    return assertSafeFilter([ORIGIN_CLAUSE, ...clauses.map(c => c.text)].join(' and '));
}
function buildUrl(p) {
    if (!exports.MLS_RESOURCES.includes(p.resource))
        throw new MlsFilterError(`resource not allowed: ${String(p.resource)}`);
    assertSafeFilter(p.filter);
    if (p.expandMedia && p.resource !== 'Property')
        throw new MlsFilterError('$expand=Media is only for Property');
    const maxTop = p.expandMedia ? exports.MAX_TOP_WITH_MEDIA : exports.MAX_TOP;
    if (!Number.isInteger(p.top) || p.top < 1 || p.top > maxTop)
        throw new MlsFilterError(`$top must be 1-${maxTop}`);
    const q = [`$filter=${encodeURIComponent(p.filter)}`];
    if (p.select && p.select.length > 0) {
        for (const f of p.select)
            if (!FIELD_RE.test(f))
                throw new MlsFilterError(`bad $select field: ${String(f)}`);
        q.push(`$select=${p.select.join(',')}`);
    }
    if (p.expandMedia)
        q.push('$expand=Media');
    if (p.ascending)
        q.push('$orderby=ModificationTimestamp%20asc');
    q.push(`$top=${p.top}`);
    return `${exports.MLS_API_BASE}/${p.resource}?${q.join('&')}`;
}
/** Property changed since a checkpoint: gt normally, ge when resuming after a crash. Not filtered on MlgCanView, so removals come back. */
function propertyIncrementalUrl(o) {
    return buildUrl({
        resource: 'Property',
        filter: buildFilter(modifiedClause(o.inclusive ? 'ge' : 'gt', o.since)),
        select: o.select, expandMedia: o.media === true, top: o.top ?? (o.media ? exports.MAX_TOP_WITH_MEDIA : exports.MAX_TOP), ascending: true,
    });
}
/** Bootstrap window: viewable records of the given statuses modified in [from, until). */
function propertyWindowUrl(o) {
    return buildUrl({
        resource: 'Property',
        filter: buildFilter(canViewClause(true), statusInClause(o.statuses), modifiedClause('ge', o.from), modifiedClause('lt', o.until)),
        select: o.select, expandMedia: o.media === true, top: o.top ?? (o.media ? exports.MAX_TOP_WITH_MEDIA : exports.MAX_TOP), ascending: true,
    });
}
/** At most 20 listings by key, optionally with their photos ($expand=Media). */
function propertyByKeysUrl(o) {
    const clause = listingKeysClause(o.keys);
    return buildUrl({
        resource: 'Property', filter: buildFilter(clause), select: o.select, expandMedia: o.media === true,
        top: Math.max(new Set(o.keys).size, 1),
    });
}
/** Keys of every viewable listing (reconciliation): $select=ListingKey, 5,000 a page. */
function propertyKeysUrl(o = {}) {
    const clauses = [canViewClause(true)];
    if (o.since)
        clauses.push(modifiedClause('ge', o.since));
    return buildUrl({ resource: 'Property', filter: buildFilter(...clauses), select: ['ListingKey'], top: o.top ?? exports.MAX_TOP });
}
/** OpenHouse, Member or Office changed since a checkpoint. */
function resourceIncrementalUrl(resource, o) {
    if (resource !== 'OpenHouse' && resource !== 'Member' && resource !== 'Office')
        throw new MlsFilterError(`resource not allowed here: ${String(resource)}`);
    return buildUrl({
        resource, filter: buildFilter(modifiedClause(o.inclusive ? 'ge' : 'gt', o.since)), top: o.top ?? 1000, ascending: true,
    });
}
/** The pick-lists (daily at most). */
function lookupUrl(o = {}) {
    return buildUrl({ resource: 'Lookup', filter: buildFilter(), top: o.top ?? 1000 });
}
/**
 * Check a URL is one this module could have built and return it UNCHANGED.
 * Throws for another host, scheme, port, credentials, a path other than
 * /v2/<allowed resource> (so no /Media, no /Property('key')/Media), an unknown
 * query option, or a $filter that breaks a rule.
 */
function assertMlsUrl(url) {
    if (typeof url !== 'string' || !url)
        throw new MlsFilterError('an MLS Grid URL is required');
    let u;
    try {
        u = new URL(url);
    }
    catch {
        throw new MlsFilterError('not a valid URL');
    }
    if (u.protocol !== 'https:' || u.hostname !== 'api.mlsgrid.com' || u.port !== '' || u.username !== '' || u.password !== '' || u.hash !== '') {
        throw new MlsFilterError('only https://api.mlsgrid.com is allowed');
    }
    const m = /^\/v2\/([A-Za-z]+)$/.exec(u.pathname);
    if (!m || !exports.MLS_RESOURCES.includes(m[1])) {
        throw new MlsFilterError(`path not allowed: ${u.pathname.slice(0, 60)} (only ${exports.MLS_RESOURCES.join(', ')}; photos come from $expand=Media)`);
    }
    for (const key of new Set(u.searchParams.keys())) {
        if (!ALLOWED_QUERY_KEYS.has(key))
            throw new MlsFilterError(`query option not allowed: ${key.slice(0, 40)}`);
    }
    assertSafeFilter(u.searchParams.get('$filter'));
    const expand = u.searchParams.get('$expand');
    if (expand !== null && (expand !== 'Media' || m[1] !== 'Property'))
        throw new MlsFilterError('$expand=Media is only for Property');
    return url;
}
/** The @odata.nextLink of a page, verbatim. */
function followNextLink(link) {
    if (typeof link !== 'string' || !link)
        throw new MlsFilterError('no next link');
    return assertMlsUrl(link);
}
