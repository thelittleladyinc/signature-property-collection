/** The bare, lower-cased address, or null when there is no plausible one. */
export declare function normEmail(v: unknown): string | null;
/** E.164 for a North American number ("+13037094262"), or null. Numbers (3037094262) are read as their digits. */
export declare function normPhone(v: unknown): string | null;
/** The last 10 digits of a normalised phone ("3037094262"), for stores that match on 10 digits; null when unusable. */
export declare function phoneDigits10(v: unknown): string | null;
/** True when both are the same usable phone number. */
export declare function samePhone(a: unknown, b: unknown): boolean;
/** "(303) 709-4262" for people to read; null when unusable. Display only: never store or compare it. */
export declare function displayPhone(v: unknown): string | null;
/** Every usable phone in a list, normalised, first spelling wins, duplicates dropped. */
export declare function uniquePhones(list: unknown): string[];
/** Every usable email in a list, normalised, duplicates dropped. */
export declare function uniqueEmails(list: unknown): string[];
