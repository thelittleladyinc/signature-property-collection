"use strict";
// suite-kit: the ONE phone and email normaliser for every app (Duplication Audit, Oct 11: 14 phone
// normalisers with three output formats).
//
// Ported from Command Center lib/lead-intake/normalize.js (the most defensive copy) and made a little
// more forgiving on input, never on output:
//   - Phone: North American numbers only (a Colorado business). The ONE output format is E.164,
//     "+13037094262". Accepts any punctuation or words around the digits ("Cell: 303.709.4262"), a
//     leading 1 or +1, "tel:", and a trailing extension ("x12", "ext. 12", "#12") or label
//     ("(cell)"), which is dropped before the digits are counted. Refuses (null) anything that is
//     not a plausible NANP number: area code or exchange starting with 0 or 1, the wrong number of
//     digits, two numbers in one field, or another country code. The hub's SQL twin is
//     hub.phone_e164 (0046_lofty_doorway.sql); keep the two in step.
//   - Email: trimmed and lower-cased; "Name <a@b.com>" and "mailto:a@b.com" give the bare address.
//     Gmail-style dot/plus folding is NOT applied: two addresses that differ only by a dot may be two
//     people on a non-Gmail domain, and a wrong merge is worse than a missed one.
//
// Stores that keep 10 digits (Seller Intelligence's SQL matches on the last 10) convert with
// phoneDigits10(); never build a second normaliser for it.
//
// Web-standard JavaScript only (no Node- or Deno-only API), so the same file runs in Node, Deno
// (the hub's Edge Function) and the browser.
Object.defineProperty(exports, "__esModule", { value: true });
exports.normEmail = normEmail;
exports.normPhone = normPhone;
exports.phoneDigits10 = phoneDigits10;
exports.samePhone = samePhone;
exports.displayPhone = displayPhone;
exports.uniquePhones = uniquePhones;
exports.uniqueEmails = uniqueEmails;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
const MAX_EMAIL = 254;
/** The bare, lower-cased address, or null when there is no plausible one. */
function normEmail(v) {
    if (typeof v !== 'string')
        return null;
    let s = v.trim();
    const angle = s.match(/<([^<>]+)>\s*$/);
    if (angle)
        s = angle[1].trim();
    s = s.replace(/^mailto:/i, '').trim().toLowerCase();
    return s.length <= MAX_EMAIL && EMAIL_RE.test(s) ? s : null;
}
/** A trailing extension or label is dropped before the digits are read: "x12", "ext. 12", "#12", "(cell)". */
const EXTENSION_RE = /\s*(?:(?:ext\.?|extension|x|#)\s*\d{1,6}|\((?:[a-z][a-z ]*)\))\s*$/i;
/** E.164 for a North American number ("+13037094262"), or null. Numbers (3037094262) are read as their digits. */
function normPhone(v) {
    if (typeof v === 'number') {
        if (!Number.isSafeInteger(v) || v <= 0)
            return null;
        v = String(v);
    }
    if (typeof v !== 'string')
        return null;
    let s = v.trim().replace(/^tel:/i, '');
    for (let i = 0; i < 2; i++)
        s = s.replace(EXTENSION_RE, '');
    const plus = s.startsWith('+');
    let d = s.replace(/\D/g, '');
    if (plus && !d.startsWith('1'))
        return null; // another country code
    if (d.length === 11 && d.startsWith('1'))
        d = d.slice(1);
    if (d.length !== 10)
        return null;
    // NANP: neither the area code nor the exchange starts with 0 or 1.
    if (d[0] === '0' || d[0] === '1' || d[3] === '0' || d[3] === '1')
        return null;
    return `+1${d}`;
}
/** The last 10 digits of a normalised phone ("3037094262"), for stores that match on 10 digits; null when unusable. */
function phoneDigits10(v) {
    const e = normPhone(v);
    return e ? e.slice(2) : null;
}
/** True when both are the same usable phone number. */
function samePhone(a, b) {
    const x = normPhone(a);
    return x !== null && x === normPhone(b);
}
/** "(303) 709-4262" for people to read; null when unusable. Display only: never store or compare it. */
function displayPhone(v) {
    const d = phoneDigits10(v);
    return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null;
}
/** Every usable phone in a list, normalised, first spelling wins, duplicates dropped. */
function uniquePhones(list) {
    const out = [];
    for (const v of Array.isArray(list) ? list : [list]) {
        const p = normPhone(v);
        if (p && !out.includes(p))
            out.push(p);
    }
    return out;
}
/** Every usable email in a list, normalised, duplicates dropped. */
function uniqueEmails(list) {
    const out = [];
    for (const v of Array.isArray(list) ? list : [list]) {
        const e = normEmail(v);
        if (e && !out.includes(e))
            out.push(e);
    }
    return out;
}
