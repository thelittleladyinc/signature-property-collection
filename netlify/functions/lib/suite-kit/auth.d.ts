export declare const MIN_KEY_LENGTH = 16;
export type KeyDecision = {
    ok: true;
} | {
    ok: false;
    status: 401 | 503;
    error: string;
};
/** The configured key, trimmed; null when unset or too short to be a real key. */
export declare function configuredKey(value: unknown): string | null;
/** Constant-time equality of two byte arrays of the same length (false for different lengths). */
export declare function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean;
/** True when the two strings are equal, compared in constant time over their SHA-256 digests. */
export declare function keysMatch(presented: unknown, expected: unknown): Promise<boolean>;
/**
 * The decision for one request. `envName` is only used in the 503 message (a NAME, never a value).
 * A key shorter than MIN_KEY_LENGTH counts as unset: a one-letter "key" is a misconfiguration.
 */
export declare function checkKey(presented: unknown, expected: unknown, envName: string): Promise<KeyDecision>;
export interface GuardOptions {
    /** The header the key comes in, e.g. "x-bcc-key". */
    header: string;
    /** The env var NAME, for the 503 message. */
    envName: string;
    /** Read the expected key at request time (so a rotated key is picked up); returns the value. */
    expected: () => string | undefined | null;
    /** Also accept ?<name>= (only for a sender that cannot set headers, like Lofty's webhooks). Default: none. */
    queryParam?: string;
}
type ExpressReq = {
    get?(name: string): string | undefined;
    headers?: Record<string, unknown>;
    query?: Record<string, unknown>;
};
type ExpressRes = {
    status(code: number): {
        json(body: unknown): unknown;
    };
};
/** Express middleware: next() only on a matching key. */
export declare function expressGuard(o: GuardOptions): (req: ExpressReq, res: ExpressRes, next: () => void) => Promise<void>;
/** Fetch-style guard: null when the request may go on, else the Response to send. */
export declare function requestGuard(o: GuardOptions): (req: Request) => Promise<Response | null>;
/**
 * A bearer token ("Authorization: Bearer <token>"), e.g. a worker or cron token. Same rules: unset → 503,
 * missing or wrong → 401, constant-time.
 */
export declare function checkBearer(authorization: unknown, expected: unknown, envName: string): Promise<KeyDecision>;
export {};
