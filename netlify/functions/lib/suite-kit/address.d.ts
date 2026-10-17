/** The first five digits of a ZIP field ("80538-1234" → "80538"); null when there are none. */
export declare function zip5(v: unknown): string | null;
export interface AddressParts {
    /** House number, e.g. "1861" or "1861a". */
    number: string;
    /** Street words after the number, contracted, e.g. ["raven", "ave"]. */
    street: string[];
    /** Unit, e.g. "4b", or null. */
    unit: string | null;
}
/** The street line split into house number, contracted street words and unit; null when it is not a home address. */
export declare function addressParts(street: unknown): AddressParts | null;
/** The street part of the key without the ZIP: "1861 raven ave #4"; null when it is not a home address. */
export declare function streetKey(street: unknown): string | null;
/**
 * THE address key: "<street key>|<zip5>". `zip` may be omitted when `street` is a one-line address ending
 * in a ZIP. null when there is no house number, no street word, no ZIP, or it is a PO box.
 */
export declare function addressKey(street: unknown, zip?: unknown): string | null;
/** The house number of a street line ("1861 Raven Ave #4" → "1861"), for a cheap pre-filter. */
export declare function houseNumber(street: unknown): string | null;
/** The key from split address fields (an MLS record: number, direction, name, suffix, direction, unit). */
export declare function addressKeyFromParts(f: {
    streetNumber?: unknown;
    dirPrefix?: unknown;
    streetName?: unknown;
    streetSuffix?: unknown;
    dirSuffix?: unknown;
    unit?: unknown;
    zip?: unknown;
    unparsed?: unknown;
}): string | null;
/** True when both name the same home (same key). Two homes with no key are never the same. */
export declare function sameHome(a: {
    street: unknown;
    zip?: unknown;
}, b: {
    street: unknown;
    zip?: unknown;
}): boolean;
