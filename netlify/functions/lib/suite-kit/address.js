"use strict";
// suite-kit: the ONE address key (Duplication Audit, Oct 11: address keys were built twelve ways; some apps
// expanded suffixes, some contracted them, some deleted them, and units were kept, half-kept or dropped, so
// relist and suppression matches between apps missed real homes).
//
// One rule set, taken from the copies that matched best in practice (Seller Intelligence contact-rules
// addressKey and mls-expired normalizeStreet, christine-hq address-match, Listing Engine postcards):
//   - Accents are removed and everything is lower case ("Cañon" = "Canon").
//   - A one-line address ("123 Main St, Loveland, CO 80538") is cut at the first comma; its trailing ZIP
//     is used when no ZIP is given separately. The city never goes in the key (cities are spelled many
//     ways; the ZIP decides).
//   - Suffixes and directions are CONTRACTED to the USPS abbreviation, wherever they appear: Street → st,
//     Avenue → ave, Parkway → pkwy, Trail → trl, North → n, Northeast → ne, and so on.
//   - County roads in every spelling ("CR 98", "WCR 98", "Co. Rd. 98", "County Road 98") become "cr 98".
//   - A unit is KEPT, in one form: "#4", "# 4", "Unit 4", "Apt 4", "Suite 4", "Ste. 4", "Lot 4" → "#4"
//     (a condo's #4 is a different home from #5 and from the building).
//   - ZIP: the first five digits of the ZIP field ("80538-1234" → "80538").
//   - A key needs a house number (a leading digit) and a street word; PO boxes have no key.
// Key format: "<number> <street words> [#unit]|<zip5>", e.g. "16225 cr 98|80538", "1861 raven ave #4|80538".
//
// Keys already stored before this toolkit (the hub's mls.property.address_key, Seller Intelligence's
// contact keys) were built by the older copies; compare against those by house number + ZIP and this key
// (sameHome), never by the stored string, until they are re-keyed.
Object.defineProperty(exports, "__esModule", { value: true });
exports.zip5 = zip5;
exports.addressParts = addressParts;
exports.streetKey = streetKey;
exports.addressKey = addressKey;
exports.houseNumber = houseNumber;
exports.addressKeyFromParts = addressKeyFromParts;
exports.sameHome = sameHome;
const SUFFIX = {
    street: 'st', str: 'st', st: 'st',
    avenue: 'ave', av: 'ave', ave: 'ave', aven: 'ave', avn: 'ave',
    drive: 'dr', drv: 'dr', dr: 'dr',
    road: 'rd', rd: 'rd',
    lane: 'ln', ln: 'ln',
    court: 'ct', crt: 'ct', ct: 'ct',
    circle: 'cir', circ: 'cir', cir: 'cir',
    place: 'pl', pl: 'pl',
    boulevard: 'blvd', boul: 'blvd', blvd: 'blvd',
    parkway: 'pkwy', parkwy: 'pkwy', pkway: 'pkwy', pky: 'pkwy', pkwy: 'pkwy',
    trail: 'trl', trl: 'trl', tr: 'trl',
    terrace: 'ter', terr: 'ter', ter: 'ter',
    highway: 'hwy', hiway: 'hwy', hwy: 'hwy',
    point: 'pt', pt: 'pt',
    cove: 'cv', cv: 'cv',
    square: 'sq', sq: 'sq',
    crossing: 'xing', xing: 'xing',
    heights: 'hts', hts: 'hts',
    expressway: 'expy', expy: 'expy',
    freeway: 'fwy', fwy: 'fwy',
    north: 'n', n: 'n', south: 's', s: 's', east: 'e', e: 'e', west: 'w', w: 'w',
    northeast: 'ne', ne: 'ne', northwest: 'nw', nw: 'nw', southeast: 'se', se: 'se', southwest: 'sw', sw: 'sw',
};
// Unit words that are never a street name in her market. "Lot" stays: mobile-home lots are real units.
const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const STREET_TYPES = new Set(Object.values(SUFFIX).filter((v) => !DIRECTIONS.has(v)).concat(['way', 'loop', 'run', 'row', 'walk', 'path', 'aly']));
const UNIT_WORDS = 'unit|apt|apartment|suite|ste|lot|bldg';
const UNIT_RE = new RegExp(`(?:^|\\s)(?:${UNIT_WORDS})\\b\\s*#?\\s*([a-z0-9][a-z0-9-]*)(?=\\s|$)`, 'g');
const HASH_UNIT_RE = /#\s*([a-z0-9][a-z0-9-]*)/g;
const COUNTY_ROAD_RE = /\b(?:[lw]?cr|co\.?\s*rd\.?|cnty\.?\s*rd\.?|county\s+rd\.?|county\s+road)\s*#?\s*(\d+[a-z]?)\b/g;
const PO_BOX_RE = /\b(?:p\s*\.?\s*o\s*\.?\s*box|pobox|post\s+office\s+box)\b/;
/** The first five digits of a ZIP field ("80538-1234" → "80538"); null when there are none. */
function zip5(v) {
    const m = typeof v === 'string' || typeof v === 'number' ? String(v).match(/^\s*(\d{5})(?:[\s-]?\d{4})?\b/) : null;
    return m ? m[1] : null;
}
function fold(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
/** The street line split into house number, contracted street words and unit; null when it is not a home address. */
function addressParts(street) {
    if (typeof street !== 'string' && typeof street !== 'number')
        return null;
    const segments = fold(String(street)).split(',');
    let s = segments[0].trim();
    // "1861 Raven Ave, #4, Loveland": a unit right after the first comma belongs to the street.
    if (segments.length > 1 && new RegExp(`^\\s*(?:#|(?:${UNIT_WORDS})\\b)`).test(segments[1]))
        s = `${s} ${segments[1].trim()}`;
    if (PO_BOX_RE.test(s))
        return null;
    // "945 Maplebrook Dr Loveland CO 80537" (no commas): drop the state and ZIP, and below, the city after the
    // last street-type word. "123 Main St 80538": a ZIP typed on the street line is not a street word.
    const oneLine = /^\S+\s+.+\s[a-z]{2}\s+\d{5}(?:-\d{4})?$/.test(s);
    s = oneLine ? s.replace(/\s+[a-z]{2}\s+\d{5}(?:-\d{4})?$/, '') : s.replace(/^(\S+\s+.+?)\s+\d{5}(?:-\d{4})?$/, '$1');
    s = s.replace(/['’`]/g, '').replace(/\./g, ' ');
    s = s.replace(COUNTY_ROAD_RE, ' cr $1 ');
    let unit = null;
    const takeUnit = (_m, u) => { if (!unit)
        unit = u.replace(/-+$/, ''); return ' '; };
    s = s.replace(HASH_UNIT_RE, takeUnit);
    s = s.replace(UNIT_RE, takeUnit);
    const words = s.replace(/[^a-z0-9/]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (words.length < 2 || !/^\d/.test(words[0]))
        return null;
    const number = words[0];
    let rest = words.slice(1).map((w) => SUFFIX[w] ?? w);
    if (oneLine) {
        // Keep up to the last street-type word (or a county road / highway number) and any direction after it.
        let end = -1;
        rest.forEach((w, i) => { if (i > 0 && (STREET_TYPES.has(w) || (/^\d/.test(w) && (rest[i - 1] === 'cr' || rest[i - 1] === 'hwy'))))
            end = i; });
        if (end > 0) {
            while (end + 1 < rest.length && DIRECTIONS.has(rest[end + 1]))
                end++;
            rest = rest.slice(0, end + 1);
        }
    }
    if (!rest.length)
        return null;
    return { number, street: rest, unit };
}
/** The street part of the key without the ZIP: "1861 raven ave #4"; null when it is not a home address. */
function streetKey(street) {
    const p = addressParts(street);
    return p ? `${p.number} ${p.street.join(' ')}${p.unit ? ` #${p.unit}` : ''}` : null;
}
/**
 * THE address key: "<street key>|<zip5>". `zip` may be omitted when `street` is a one-line address ending
 * in a ZIP. null when there is no house number, no street word, no ZIP, or it is a PO box.
 */
function addressKey(street, zip) {
    const line = typeof street === 'string' ? street : typeof street === 'number' ? String(street) : '';
    const z = zip5(zip) ?? (line.match(/\b(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:usa|us|united states))?\s*$/i)?.[1] ?? null);
    const s = streetKey(line);
    return s && z ? `${s}|${z}` : null;
}
/** The house number of a street line ("1861 Raven Ave #4" → "1861"), for a cheap pre-filter. */
function houseNumber(street) {
    return addressParts(street)?.number ?? null;
}
/** The key from split address fields (an MLS record: number, direction, name, suffix, direction, unit). */
function addressKeyFromParts(f) {
    const t = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
    const unit = t(f.unit);
    const joined = [t(f.streetNumber), t(f.dirPrefix), t(f.streetName), t(f.streetSuffix), t(f.dirSuffix)].filter(Boolean).join(' ');
    const line = joined && t(f.streetName) ? `${joined}${unit ? ` #${unit.replace(/^#\s*/, '')}` : ''}` : t(f.unparsed);
    return addressKey(line, f.zip);
}
/** True when both name the same home (same key). Two homes with no key are never the same. */
function sameHome(a, b) {
    const x = addressKey(a.street, a.zip);
    return x !== null && x === addressKey(b.street, b.zip);
}
