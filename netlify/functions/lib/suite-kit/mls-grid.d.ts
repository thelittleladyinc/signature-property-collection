import { MlsFilterError } from './mls-filter.ts';
export interface Clock {
    now(): number;
    sleep(ms: number): Promise<void>;
}
export declare const systemClock: Clock;
export declare const DEFAULT_RPS = 1;
/** The hard ceiling in code: no setting, flag or env value can go above it. */
export declare const RPS_CEILING = 1;
/** A requested rate, made safe: unreadable -> 1; below 0.1 -> 0.1; above 1 -> 1 (the setting can only slow the job down). */
export declare function clampRps(requested: unknown): number;
export declare class Bucket {
    readonly rps: number;
    private readonly clock;
    private nextFree;
    constructor(clock: Clock, requestedRps?: unknown);
    /** Wait for the next slot. Slots are 1000/rps ms apart. */
    take(): Promise<void>;
}
export declare const BREAKER_FLAG = "mls_breaker_until";
export declare const BREAKER_THRESHOLD = 5;
export declare const BREAKER_OPEN_MS: number;
export declare const BREAKER_MAX_MS: number;
export declare class BreakerOpenError extends Error {
    readonly until: string;
    constructor(untilMs: number);
}
/** The flag's value as epoch ms; empty or unreadable means closed (0). */
export declare function parseBreakerUntil(flag: string | null | undefined): number;
export interface BreakerStore {
    setFlag(name: string, value: string): Promise<void>;
}
export declare class Breaker {
    private failures;
    private untilMs;
    private readonly store;
    constructor(store: BreakerStore, flagValue: string | null | undefined);
    get until(): number;
    get consecutiveFailures(): number;
    isOpen(nowMs: number): boolean;
    assertClosed(nowMs: number): void;
    success(): void;
    /** Count one failure; opens (and persists) at the fifth in a row. Returns true when it opened. */
    failure(nowMs: number): Promise<boolean>;
    /** Open for at least `ms` (never more than 24 h) and write it to the hub flag. */
    openFor(ms: number, nowMs: number): Promise<void>;
}
export declare const LIMITS: {
    readonly requestsPerHour: 7200;
    readonly requestsPerDay: 40000;
    /** 3,072 MB an hour. */
    readonly bytesPerHour: number;
    /** 40 GB a day (decimal, the smaller reading). */
    readonly bytesPerDay: 40000000000;
};
export declare const HARD_FRACTION = 0.5;
export declare const DEFAULT_CAP_FRACTION = 0.2;
export interface Meter {
    requests1h: number;
    requests24h: number;
    bytes1h: number;
    bytes24h: number;
}
export interface Caps {
    fraction: number;
    requestsPerHour: number;
    requestsPerDay: number;
    bytesPerHour: number;
    bytesPerDay: number;
}
/** The flag value as a fraction in [0.01, 0.5]; missing or unreadable means 0.2. */
export declare function capFraction(flag: string | null | undefined): number;
export declare function capsFor(fraction: number): Caps;
/** The plan's table: the most the hub may ever use. */
export declare const HARD_CAPS: Caps;
export type MeterVerdict = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** Refuse once any of the four meters has reached its cap. */
export declare function checkMeter(m: Meter, caps: Caps): MeterVerdict;
export interface RequestLogEntry {
    resource: string;
    purpose: string;
    status: number | null;
    bytes: number;
    ms: number;
}
/** Where the meter is read and every request is logged (the hub: mls.request_log). */
export interface MlsMeterStore {
    meter(): Promise<Meter>;
    logRequest(entry: RequestLogEntry): Promise<void>;
}
export declare class MeterRefusedError extends Error {
    readonly reason: string;
    constructor(reason: string);
}
export declare class DeadlineError extends Error {
    constructor();
}
export declare class MlsHttpError extends Error {
    readonly status: number;
    constructor(status: number, detail: string);
}
export interface ClientDeps {
    token: string;
    db: MlsMeterStore;
    breaker: Breaker;
    bucket: Bucket;
    caps: Caps;
    clock: Clock;
    fetch: typeof fetch;
    /** Epoch ms: no request starts after this. */
    deadline: number;
    /** false = one attempt per call (the probe). */
    retry?: boolean;
    timeoutMs?: number;
}
export interface JsonPage {
    body: Record<string, unknown>;
    bytes: number;
    status: number;
    ms: number;
}
export type Download = {
    ok: true;
    data: Uint8Array;
    contentType: string;
    ms: number;
} | {
    ok: false;
    status: number;
};
/** Retry-After as milliseconds: whole seconds or an HTTP date; null when absent or unreadable. */
export declare function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null;
export declare class MlsClient {
    private readonly d;
    requests: number;
    bytes: number;
    constructor(deps: ClientDeps);
    /** GET one API page as JSON. Throws on anything but a 2xx JSON object. */
    getJson(url: string, purpose: string): Promise<JsonPage>;
    /** Download one photo from its MediaURL. No token; not from the API host; one metered request. */
    download(url: string, purpose: string): Promise<Download>;
    private scrub;
    private send;
}
export { MlsFilterError };
