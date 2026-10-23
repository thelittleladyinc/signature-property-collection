"use strict";
// suite-kit: the side-by-side check (Christine, Oct 23, 2026: "it's very important that we don't lose anything at all
// since everything is completely integrated"). Before an app moves a feature onto the hub, it runs both for a while:
// its own answer (its own Lofty / RentCast / MLS Grid connection, what it does today) and the hub's answer to the same
// question, and compares them field by field with ONE set of rules, here. The result goes to the hub's parity ledger
// (POST /v1/parity/record, 0078): field NAMES only, never a value, and the record's own key only as a hash.
//
//   compareRecords(spec, own, hub)  → { outcome, different, own_only, hub_only }
//       own_only   the app has a value and the hub has none: the hub would LOSE it (the case the rule is about)
//       different  both have a value and they differ after the field's rule below
//       hub_only   the hub has a value the app does not: extra, still a difference for a write
//       outcome    'same' when all three lists are empty, else 'different'
//   parityKey(text)                → "k" + 16 hex characters of sha256: the same record twice gives the same key, the
//                                    key cannot be turned back into the lead, address or MLS number, and the leading
//                                    "k" means a raw 16-digit Lofty lead id can never pass for one
//   parityRow(...)                 → one ledger row, checked before it leaves the app
//
// Field rules (a spec maps a dotted path in both records to one of these):
//   text     trimmed, inner spaces collapsed; case kept          text_ci  the same, case ignored
//   email    one address, normalised (contact.ts)                 emails   a set of addresses
//   phone    one number as E.164 (contact.ts)                     phones   a set of numbers
//   tags     a set of tags, trimmed, CASE AND DASH KEPT: "Consent – DNC" (en dash) and "Consent - DNC" are different
//            tags in Lofty, and a Smart Plan starts on the exact one
//   number   numeric, equal within `tolerance` (default 0)        money    whole dollars
//   date     the calendar day: "YYYY-MM-DD" as is, a timestamp as its Denver day
//   bool     true / false ("true", "yes", "1", 1 / "false", "no", "0", 0)
//   list     ordered, each item as text                           set      unordered, each item as text
//   address  THE address key (address.ts): a one-line address with its ZIP, or {street, zip}
//   json     the whole value, keys sorted (for small nested values such as a Lofty `property` object)
// Empty is null, undefined, "", whitespace, [] or {}: two empties are the same; a value that a rule cannot read (an
// email that is not an email) is compared as text, never dropped.
//
// Web-standard JavaScript only (crypto.subtle for the hash), so the same file runs in Node, Deno and the browser.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PARITY_REASONS = exports.PARITY_KEY_RE = exports.PARITY_NAME_RE = exports.PARITY_AREAS = void 0;
exports.compareRecords = compareRecords;
exports.parityKey = parityKey;
exports.parityRow = parityRow;
const contact_ts_1 = require("./contact.js");
const address_ts_1 = require("./address.js");
const denver_time_ts_1 = require("./denver-time.js");
/** The four kinds of question the check compares. */
exports.PARITY_AREAS = ['lofty_write', 'lofty_read', 'mls_read', 'rentcast'];
/** Field and operation names: lower case, digits, `_` and `.` (a dotted path). Never a value. */
exports.PARITY_NAME_RE = /^[a-z][a-z0-9_.]{0,63}$/;
/** parityKey's output: "k" and 16 hex characters. */
exports.PARITY_KEY_RE = /^k[0-9a-f]{16}$/;
/** Why nothing was compared (the hub did not answer in time, was off, refused, …). */
exports.PARITY_REASONS = [
    'hub_off', 'hub_refused', 'hub_unreachable', 'hub_timeout', 'hub_bad_answer', 'hub_not_ready', 'own_failed', 'skipped',
];
const RULES = new Set([
    'text', 'text_ci', 'email', 'emails', 'phone', 'phones', 'tags', 'number', 'money', 'date', 'bool', 'list', 'set',
    'address', 'json',
]);
function pick(record, path) {
    let v = record;
    for (const part of path.split('.')) {
        if (v === null || typeof v !== 'object' || Array.isArray(v))
            return undefined;
        v = v[part];
    }
    return v;
}
function isEmpty(v) {
    if (v === null || v === undefined)
        return true;
    if (typeof v === 'string')
        return v.trim() === '';
    if (Array.isArray(v))
        return v.every(isEmpty);
    if (typeof v === 'object')
        return Object.keys(v).length === 0;
    return false;
}
const asText = (v) => {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string')
        return v.trim().replace(/\s+/g, ' ');
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint')
        return String(v);
    return stable(v);
};
function stable(v) {
    if (Array.isArray(v))
        return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') {
        return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v ?? null);
}
const items = (v) => (Array.isArray(v) ? v : [v]).filter(x => !isEmpty(x));
const setOf = (list) => [...new Set(list)].sort().join('\u0001');
function num(v) {
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
        const s = v.trim().replace(/[$,\s]/g, '');
        if (!/^-?\d+(\.\d+)?$/.test(s))
            return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
function bool(v) {
    if (typeof v === 'boolean')
        return v;
    if (v === 1 || v === 0)
        return v === 1;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (['true', 'yes', 'y', '1', 'on'].includes(s))
            return true;
        if (['false', 'no', 'n', '0', 'off'].includes(s))
            return false;
    }
    return null;
}
function day(v) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()))
        return v.trim();
    if (typeof v === 'string' || typeof v === 'number' || v instanceof Date) {
        const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
        return Number.isFinite(t) ? (0, denver_time_ts_1.denverDate)(t) : null;
    }
    return null;
}
function address(v) {
    if (typeof v === 'string')
        return (0, address_ts_1.addressKey)(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        const o = v;
        return (0, address_ts_1.addressKey)(o.street ?? o.address ?? o.line1, o.zip ?? o.zipCode ?? o.postalCode);
    }
    return null;
}
/** Two non-empty values: equal under the rule? */
function equal(rule, a, b, tolerance) {
    switch (rule) {
        case 'text': return asText(a) === asText(b);
        case 'text_ci': return asText(a).toLowerCase() === asText(b).toLowerCase();
        case 'email': return ((0, contact_ts_1.normEmail)(a) ?? asText(a).toLowerCase()) === ((0, contact_ts_1.normEmail)(b) ?? asText(b).toLowerCase());
        case 'emails': return setOf(items(a).map(x => (0, contact_ts_1.normEmail)(x) ?? asText(x).toLowerCase())) === setOf(items(b).map(x => (0, contact_ts_1.normEmail)(x) ?? asText(x).toLowerCase()));
        case 'phone': return ((0, contact_ts_1.normPhone)(a) ?? asText(a)) === ((0, contact_ts_1.normPhone)(b) ?? asText(b));
        case 'phones': return setOf(items(a).map(x => (0, contact_ts_1.normPhone)(x) ?? asText(x))) === setOf(items(b).map(x => (0, contact_ts_1.normPhone)(x) ?? asText(x)));
        case 'tags': return setOf(items(a).map(x => asText(x))) === setOf(items(b).map(x => asText(x)));
        case 'number': {
            const x = num(a), y = num(b);
            return x !== null && y !== null ? Math.abs(x - y) <= tolerance : asText(a) === asText(b);
        }
        case 'money': {
            const x = num(a), y = num(b);
            return x !== null && y !== null ? Math.abs(Math.round(x) - Math.round(y)) <= tolerance : asText(a) === asText(b);
        }
        case 'date': {
            const x = day(a), y = day(b);
            return x !== null && y !== null ? x === y : asText(a) === asText(b);
        }
        case 'bool': {
            const x = bool(a), y = bool(b);
            return x !== null && y !== null ? x === y : asText(a) === asText(b);
        }
        case 'list': return stable(items(a).map(asText)) === stable(items(b).map(asText));
        case 'set': return setOf(items(a).map(asText)) === setOf(items(b).map(asText));
        case 'address': {
            const x = address(a), y = address(b);
            return x !== null && y !== null ? x === y : asText(a).toLowerCase() === asText(b).toLowerCase();
        }
        case 'json': return stable(a) === stable(b);
    }
}
/** The app's own answer vs the hub's, field by field. Throws on a bad spec (a developer error, never a runtime one). */
function compareRecords(spec, own, hub) {
    const out = { outcome: 'same', different: [], own_only: [], hub_only: [] };
    for (const [field, s] of Object.entries(spec)) {
        const rule = typeof s === 'string' ? s : s?.rule;
        const tolerance = typeof s === 'object' && s && typeof s.tolerance === 'number' && s.tolerance >= 0 ? s.tolerance : 0;
        if (!exports.PARITY_NAME_RE.test(field))
            throw new Error(`parity spec: field name ${JSON.stringify(field)} is not a plain lower-case name`);
        if (!RULES.has(rule))
            throw new Error(`parity spec: ${field} has no known rule`);
        const a = pick(own, field), b = pick(hub, field);
        const ae = isEmpty(a), be = isEmpty(b);
        if (ae && be)
            continue;
        if (!ae && be)
            out.own_only.push(field);
        else if (ae && !be)
            out.hub_only.push(field);
        else if (!equal(rule, a, b, tolerance))
            out.different.push(field);
    }
    if (out.different.length || out.own_only.length || out.hub_only.length)
        out.outcome = 'different';
    return out;
}
/** "k" + 16 hex characters of sha256 of the key (a lead id, an address key, an MLS number…), so the ledger can count
 * one record once and nobody can read the record back from it. The "k" keeps a raw 16-digit Lofty lead id from ever
 * looking like a key. */
async function parityKey(text) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`parity:v1:${text}`)));
    return `k${Array.from(d.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('')}`;
}
/**
 * One ledger row. `result` is compareRecords' answer, or a reason when nothing could be compared (the hub did not
 * answer, was switched off, …). `key` is parityKey's output (or null). Every name is checked here, so a value can
 * never reach the hub by mistake: a bad area, op, field or reason throws.
 */
function parityRow(area, op, result, key) {
    if (!exports.PARITY_AREAS.includes(area))
        throw new Error(`parity: unknown area ${JSON.stringify(area)}`);
    if (!exports.PARITY_NAME_RE.test(op))
        throw new Error('parity: the operation name must be a plain lower-case name');
    if (key !== null && !exports.PARITY_KEY_RE.test(key))
        throw new Error('parity: the key must come from parityKey()');
    if (typeof result === 'string') {
        if (!exports.PARITY_REASONS.includes(result))
            throw new Error(`parity: unknown reason ${JSON.stringify(result)}`);
        return { area, op, outcome: 'not_compared', different: [], own_only: [], hub_only: [], reason: result, key };
    }
    for (const f of [...result.different, ...result.own_only, ...result.hub_only]) {
        if (!exports.PARITY_NAME_RE.test(f))
            throw new Error('parity: a field name is not a plain lower-case name');
    }
    return {
        area, op, outcome: result.outcome, different: [...result.different], own_only: [...result.own_only],
        hub_only: [...result.hub_only], reason: null, key,
    };
}
