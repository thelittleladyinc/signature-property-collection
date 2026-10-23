export type FieldRule = 'text' | 'text_ci' | 'email' | 'emails' | 'phone' | 'phones' | 'tags' | 'number' | 'money' | 'date' | 'bool' | 'list' | 'set' | 'address' | 'json';
export interface FieldSpec {
    rule: FieldRule;
    tolerance?: number;
}
export type CompareSpec = Record<string, FieldRule | FieldSpec>;
export interface CompareResult {
    outcome: 'same' | 'different';
    different: string[];
    own_only: string[];
    hub_only: string[];
}
/** The four kinds of question the check compares. */
export declare const PARITY_AREAS: readonly ["lofty_write", "lofty_read", "mls_read", "rentcast"];
export type ParityArea = typeof PARITY_AREAS[number];
/** Field and operation names: lower case, digits, `_` and `.` (a dotted path). Never a value. */
export declare const PARITY_NAME_RE: RegExp;
/** parityKey's output: "k" and 16 hex characters. */
export declare const PARITY_KEY_RE: RegExp;
/** Why nothing was compared (the hub did not answer in time, was off, refused, …). */
export declare const PARITY_REASONS: readonly ["hub_off", "hub_refused", "hub_unreachable", "hub_timeout", "hub_bad_answer", "hub_not_ready", "own_failed", "skipped"];
export type ParityReason = typeof PARITY_REASONS[number];
/** The app's own answer vs the hub's, field by field. Throws on a bad spec (a developer error, never a runtime one). */
export declare function compareRecords(spec: CompareSpec, own: unknown, hub: unknown): CompareResult;
/** "k" + 16 hex characters of sha256 of the key (a lead id, an address key, an MLS number…), so the ledger can count
 * one record once and nobody can read the record back from it. The "k" keeps a raw 16-digit Lofty lead id from ever
 * looking like a key. */
export declare function parityKey(text: string): Promise<string>;
export interface ParityRow {
    area: ParityArea;
    op: string;
    outcome: 'same' | 'different' | 'not_compared';
    different: string[];
    own_only: string[];
    hub_only: string[];
    reason: ParityReason | null;
    key: string | null;
}
/**
 * One ledger row. `result` is compareRecords' answer, or a reason when nothing could be compared (the hub did not
 * answer, was switched off, …). `key` is parityKey's output (or null). Every name is checked here, so a value can
 * never reach the hub by mistake: a bad area, op, field or reason throws.
 */
export declare function parityRow(area: ParityArea, op: string, result: CompareResult | ParityReason, key: string | null): ParityRow;
