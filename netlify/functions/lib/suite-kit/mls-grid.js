"use strict";
// suite-kit: the MLS Grid client (Duplication Audit, Oct 11: MLS Grid was pulled by seven apps on one token, each
// with its own rate limiter; the token was suspended once already for exactly this).
//
// Ported unchanged in behaviour from the hub's replication job: src/mls/client.ts, bucket.ts, breaker.ts,
// limits.ts and clock.ts in Seller Intelligence. Every URL passes assertMlsUrl() from ./mls-filter.ts (a
// byte-identical copy of the hub's URL builder; a test keeps them identical).
//
// !! Christine's decision (Oct 12, "HUB"): ONE MLS copy in the hub, everyone else reads it. Only the hub's
// !! replication job may call MLS Grid with this client. An app that needs listings reads the hub
// !! (createHubClient in ./hub.ts, routes /v1/mls/*), never MLS Grid. The client is here so the hub job and
// !! any app still waiting for its move share the same limits instead of a fourteenth copy.
//
// Before EACH request: the deadline, the persisted circuit breaker, the meter (caps below), then one slot
// from the token bucket (1 request a second, never more). After each request a row goes to the meter store.
// 429/5xx/network errors are retried with Retry-After or 2, 4, 8 ... s; five failures in a row open the
// breaker; a 401/403 opens it at once. API calls refuse redirects and send the token to api.mlsgrid.com only.
// Photo downloads (0.4.2, Oct 20, 2026) follow MLS Grid's June 1, 2026 rule: the token as User-Agent (and Bearer),
// only to an MLS Grid media host (*.mlsgrid.com, never the API host); redirects followed by hand to allowed hosts
// or (0.4.3) any public https host, where MLS Grid stores the file, without the token, the token decided again at
// every hop; a photo is never retried and never counts toward the breaker: a
// refusal (401/403/429, a redirect not followed) or a failed host (5xx, no answer) tells the caller to stop photos.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MlsFilterError = exports.MlsClient = exports.MAX_PHOTO_REDIRECTS = exports.MlsHttpError = exports.DeadlineError = exports.MeterRefusedError = exports.HARD_CAPS = exports.DEFAULT_CAP_FRACTION = exports.HARD_FRACTION = exports.LIMITS = exports.Breaker = exports.BreakerOpenError = exports.BREAKER_MAX_MS = exports.BREAKER_OPEN_MS = exports.BREAKER_THRESHOLD = exports.BREAKER_FLAG = exports.Bucket = exports.RPS_CEILING = exports.DEFAULT_RPS = exports.systemClock = void 0;
exports.clampRps = clampRps;
exports.parseBreakerUntil = parseBreakerUntil;
exports.capFraction = capFraction;
exports.capsFor = capsFor;
exports.checkMeter = checkMeter;
exports.hostAllowed = hostAllowed;
exports.isMlsGridMediaHost = isMlsGridMediaHost;
exports.parseRetryAfter = parseRetryAfter;
const mls_filter_ts_1 = require("./mls-filter.js");
Object.defineProperty(exports, "MlsFilterError", { enumerable: true, get: function () { return mls_filter_ts_1.MlsFilterError; } });
exports.systemClock = {
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms))),
};
// ── token bucket ────────────────────────────────────────────────────────────
// Token bucket: one request per second, never more (MLS Grid's limit is 2 requests
// a second, and the 2026-08-01 suspension was for exceeding it; the hub stays at half).
// One process (the job lease) and strictly spaced requests: every call to
// take() gets the next free slot, even when several callers wait at once.
// Photo downloads use the same bucket as API calls.
exports.DEFAULT_RPS = 1;
/** The hard ceiling in code: no setting, flag or env value can go above it. */
exports.RPS_CEILING = 1;
const MIN_RPS = 0.1;
/** A requested rate, made safe: unreadable -> 1; below 0.1 -> 0.1; above 1 -> 1 (the setting can only slow the job down). */
function clampRps(requested) {
    const n = typeof requested === 'string' ? Number(requested) : typeof requested === 'number' ? requested : NaN;
    if (!Number.isFinite(n) || n <= 0)
        return exports.DEFAULT_RPS;
    return Math.min(Math.max(n, MIN_RPS), exports.RPS_CEILING);
}
class Bucket {
    rps;
    clock;
    nextFree = 0;
    constructor(clock, requestedRps = exports.DEFAULT_RPS) {
        this.clock = clock;
        this.rps = clampRps(requestedRps);
    }
    /** Wait for the next slot. Slots are 1000/rps ms apart. */
    async take() {
        const now = this.clock.now();
        const at = Math.max(now, this.nextFree);
        this.nextFree = at + 1000 / this.rps;
        if (at > now)
            await this.clock.sleep(at - now);
    }
}
exports.Bucket = Bucket;
// ── circuit breaker ─────────────────────────────────────────────────────────
// Circuit breaker for MLS Grid calls, persisted in hub.flags.mls_breaker_until.
//
// Five consecutive failures (429, 5xx, a network error, or any 4xx) open it for
// 15 minutes; the open-until time is written to the hub flag, so the next
// cron run (a new process) still sees it and exits without calling MLS Grid.
// A success resets the count. A 401 or 403 (a suspended or wrong token) opens it
// at once. A Retry-After longer than the run can wait also opens it, for at
// least the time MLS Grid asked for.
exports.BREAKER_FLAG = 'mls_breaker_until';
exports.BREAKER_THRESHOLD = 5;
exports.BREAKER_OPEN_MS = 15 * 60_000;
exports.BREAKER_MAX_MS = 24 * 3600_000;
class BreakerOpenError extends Error {
    until;
    constructor(untilMs) {
        const until = new Date(untilMs).toISOString();
        super(`MLS circuit breaker is open until ${until}`);
        this.name = 'BreakerOpenError';
        this.until = until;
    }
}
exports.BreakerOpenError = BreakerOpenError;
/** The flag's value as epoch ms; empty or unreadable means closed (0). */
function parseBreakerUntil(flag) {
    const t = typeof flag === 'string' && flag.trim() !== '' ? Date.parse(flag.trim()) : NaN;
    return Number.isFinite(t) ? t : 0;
}
class Breaker {
    failures = 0;
    untilMs;
    store;
    constructor(store, flagValue) {
        this.store = store;
        this.untilMs = parseBreakerUntil(flagValue);
    }
    get until() {
        return this.untilMs;
    }
    get consecutiveFailures() {
        return this.failures;
    }
    isOpen(nowMs) {
        return this.untilMs > nowMs;
    }
    assertClosed(nowMs) {
        if (this.isOpen(nowMs))
            throw new BreakerOpenError(this.untilMs);
    }
    success() {
        this.failures = 0;
    }
    /** Count one failure; opens (and persists) at the fifth in a row. Returns true when it opened. */
    async failure(nowMs) {
        this.failures += 1;
        if (this.failures < exports.BREAKER_THRESHOLD)
            return false;
        await this.openFor(exports.BREAKER_OPEN_MS, nowMs);
        return true;
    }
    /** Open for at least `ms` (never more than 24 h) and write it to the hub flag. */
    async openFor(ms, nowMs) {
        const span = Math.min(Math.max(ms, exports.BREAKER_OPEN_MS), exports.BREAKER_MAX_MS);
        this.untilMs = Math.max(this.untilMs, nowMs + span);
        this.failures = 0;
        await this.store.setFlag(exports.BREAKER_FLAG, new Date(this.untilMs).toISOString());
    }
}
exports.Breaker = Breaker;
// ── limits and meter ────────────────────────────────────────────────────────
// MLS Grid's published limits (from the 2026-08-01 suspension notice) and the
// hub's meter. Every number the hub may use is a fraction of these.
//
// Enforced by client.ts before EVERY request, from mls.request_log:
//   in the last hour  requests >= cap or bytes >= cap  -> the call is refused
//   in the last 24 h  requests >= cap or bytes >= cap  -> the call is refused
// The hard ceiling is 50% of each limit (3,600 requests/h, 20,000/day,
// 1.5 GB/h, 20 GB/day). The flag mls_cap_fraction (default 0.2: "capped at 20%
// while other apps still hold the token", plan section 3) can only lower it.
exports.LIMITS = {
    requestsPerHour: 7200,
    requestsPerDay: 40000,
    /** 3,072 MB an hour. */
    bytesPerHour: 3 * 1024 ** 3,
    /** 40 GB a day (decimal, the smaller reading). */
    bytesPerDay: 40e9,
};
exports.HARD_FRACTION = 0.5;
exports.DEFAULT_CAP_FRACTION = 0.2;
const MIN_CAP_FRACTION = 0.01;
/** The flag value as a fraction in [0.01, 0.5]; missing or unreadable means 0.2. */
function capFraction(flag) {
    const n = typeof flag === 'string' && flag.trim() !== '' ? Number(flag) : NaN;
    if (!Number.isFinite(n) || n <= 0)
        return exports.DEFAULT_CAP_FRACTION;
    return Math.min(Math.max(n, MIN_CAP_FRACTION), exports.HARD_FRACTION);
}
const share = (limit, fraction) => Math.floor(Math.round(limit * fraction * 1000) / 1000);
function capsFor(fraction) {
    const f = Math.min(Math.max(fraction, MIN_CAP_FRACTION), exports.HARD_FRACTION);
    return {
        fraction: f,
        requestsPerHour: share(exports.LIMITS.requestsPerHour, f),
        requestsPerDay: share(exports.LIMITS.requestsPerDay, f),
        bytesPerHour: share(exports.LIMITS.bytesPerHour, f),
        bytesPerDay: share(exports.LIMITS.bytesPerDay, f),
    };
}
/** The plan's table: the most the hub may ever use. */
exports.HARD_CAPS = capsFor(exports.HARD_FRACTION);
/** Refuse once any of the four meters has reached its cap. */
function checkMeter(m, caps) {
    if (m.requests1h >= caps.requestsPerHour)
        return { ok: false, reason: `${m.requests1h} requests in the last hour (cap ${caps.requestsPerHour})` };
    if (m.requests24h >= caps.requestsPerDay)
        return { ok: false, reason: `${m.requests24h} requests in the last 24 hours (cap ${caps.requestsPerDay})` };
    if (m.bytes1h >= caps.bytesPerHour)
        return { ok: false, reason: `${m.bytes1h} bytes in the last hour (cap ${caps.bytesPerHour})` };
    if (m.bytes24h >= caps.bytesPerDay)
        return { ok: false, reason: `${m.bytes24h} bytes in the last 24 hours (cap ${caps.bytesPerDay})` };
    return { ok: true };
}
// The one HTTP client for MLS Grid: every API call and every photo download in
// the hub goes through here, and nothing else holds MLSGRID_API_TOKEN.
//
// Before EACH request, in this order:
//   1. the run's deadline has not passed;
//   2. the circuit breaker is closed (it is persisted, see breaker.ts);
//   3. the meter, read from mls.request_log, is under the caps (limits.ts):
//      the call is REFUSED once the last hour reaches the request or byte cap
//      or the last 24 hours reach theirs;
//   4. the token bucket hands out a slot: 1 request a second, 2 at most.
// After EACH request (also a failed one) a row goes to mls.request_log, so the
// meter sees it. API calls: 429, 5xx and network errors are retried: Retry-After
// is honoured, otherwise 2, 4, 8 ... seconds; five failures in a row open the
// breaker. A 401 or 403 opens it at once. The URL must pass assertMlsUrl()
// (only https://api.mlsgrid.com/v2/<five resources>, one system name, at most
// five "or"); redirects are refused.
// Photo downloads (download()) never go to the API host and follow MLS Grid's rule
// from June 1, 2026: a media download MUST send User-Agent = the OAuth token. Like
// Listing Engine, the token goes as User-Agent AND Authorization: Bearer, and only
// to an MLS Grid media host (*.mlsgrid.com, never api.mlsgrid.com); any other photo
// host (MLS_MEDIA_HOST_SUFFIXES) gets no token. Redirects are followed by hand, at
// most three, to an allowed host or any other public https host (MLS Grid redirects a
// photo to where it is stored), and the token is decided again at every hop. A photo
// is never retried and never counts toward the breaker: a refusal (401,
// 403, 429, a redirect not followed) or a failed host (5xx, no answer) tells the
// caller to stop photos for the run, because a photo refusal is not an API outage.
class MeterRefusedError extends Error {
    reason;
    constructor(reason) {
        super(`MLS meter refused the call: ${reason}`);
        this.name = 'MeterRefusedError';
        this.reason = reason;
    }
}
exports.MeterRefusedError = MeterRefusedError;
class DeadlineError extends Error {
    constructor() {
        super('run time limit reached');
        this.name = 'DeadlineError';
    }
}
exports.DeadlineError = DeadlineError;
class MlsHttpError extends Error {
    status;
    constructor(status, detail) {
        super(`MLS Grid answered HTTP ${status}${detail ? `: ${detail}` : ''}`);
        this.name = 'MlsHttpError';
        this.status = status;
    }
}
exports.MlsHttpError = MlsHttpError;
const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000];
const MAX_RETRY_AFTER_MS = 24 * 3600_000;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
/** Redirects followed on one photo download (Listing Engine's limit too). */
exports.MAX_PHOTO_REDIRECTS = 3;
const PHOTO_ACCEPT = 'image/*,*/*;q=0.8';
/** The User-Agent for a photo host that is not MLS Grid's (it never gets the token). */
const PLAIN_USER_AGENT = 'Mozilla/5.0 (compatible; LittleLadyHub/1.0)';
/** A photo host the job may download from: https, MLS Grid (not its API host) or a suffix in MLS_MEDIA_HOST_SUFFIXES. */
function hostAllowed(url, extraSuffixes = []) {
    let host;
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:')
            return false;
        host = u.hostname.toLowerCase();
    }
    catch {
        return false;
    }
    if (host === 'api.mlsgrid.com')
        return false;
    return ['mlsgrid.com', ...extraSuffixes].some(s => host === s || host.endsWith(`.${s}`));
}
/** The only hosts that get the token on a photo download: MLS Grid's media hosts (media.mlsgrid.com, any *.mlsgrid.com), never the API host. */
function isMlsGridMediaHost(hostname) {
    const h = hostname.toLowerCase();
    return h !== 'api.mlsgrid.com' && h.endsWith('.mlsgrid.com');
}
/** One hop of a photo download: an allowed https host on the default port, no user:password. */
function photoHopAllowed(url, extraSuffixes) {
    let u;
    try {
        u = new URL(url);
    }
    catch {
        return false;
    }
    return !u.username && !u.password && u.port === '' && hostAllowed(u.href, extraSuffixes);
}
/**
 * A redirect hop off MLS Grid's own hosts. MLS Grid answers a photo with a redirect (HTTP 307, Oct 20, 2026) to the
 * place the file is stored, and Listing Engine follows that to any public host without the token. Allowed: https,
 * the default port, no user:password, a host name with a dot (never an IP address, localhost or an internal name)
 * and never the API host. Such a host gets no token (photoHeaders).
 */
function publicPhotoHop(url) {
    let u;
    try {
        u = new URL(url);
    }
    catch {
        return false;
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.port !== '')
        return false;
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!h.includes('.') || h === 'api.mlsgrid.com')
        return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[') || h.includes(':'))
        return false;
    return !/(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa|in-addr\.arpa|ip6\.arpa)$/.test(h);
}
/** MLS Grid (June 1, 2026): User-Agent = the OAuth token, Authorization: Bearer with it. No token to any other host. */
function photoHeaders(hostname, token) {
    return isMlsGridMediaHost(hostname)
        ? { Accept: PHOTO_ACCEPT, 'User-Agent': token, Authorization: `Bearer ${token}` }
        : { Accept: PHOTO_ACCEPT, 'User-Agent': PLAIN_USER_AGENT };
}
/** Retry-After as milliseconds: whole seconds or an HTTP date; null when absent or unreadable. */
function parseRetryAfter(header, nowMs) {
    if (!header)
        return null;
    const v = header.trim();
    if (/^\d{1,9}$/.test(v))
        return Math.min(Number(v) * 1000, MAX_RETRY_AFTER_MS);
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.min(Math.max(t - nowMs, 0), MAX_RETRY_AFTER_MS) : null;
}
class MlsClient {
    d;
    requests = 0;
    bytes = 0;
    constructor(deps) {
        this.d = deps;
    }
    /** GET one API page as JSON. Throws on anything but a 2xx JSON object. */
    async getJson(url, purpose) {
        (0, mls_filter_ts_1.assertMlsUrl)(url);
        const resource = new URL(url).pathname.split('/').pop() ?? 'unknown';
        const r = await this.send({ url, resource, purpose });
        if (!r.ok)
            throw new MlsHttpError(r.status, r.detail);
        let body;
        try {
            body = JSON.parse(new TextDecoder().decode(r.data));
        }
        catch {
            await this.d.breaker.failure(this.d.clock.now());
            throw new MlsHttpError(r.status, 'the answer was not JSON');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            await this.d.breaker.failure(this.d.clock.now());
            throw new MlsHttpError(r.status, 'the answer was not a JSON object');
        }
        return { body: body, bytes: r.data.byteLength, status: r.status, ms: r.ms };
    }
    /**
     * Download one photo from its MediaURL: one metered request per hop, never retried, never counted by the breaker.
     * The token goes only to an MLS Grid media host (User-Agent and Authorization: Bearer, MLS Grid's June 1, 2026
     * rule); redirects are followed by hand, at most MAX_PHOTO_REDIRECTS: to a host that passes hostAllowed(), or to
     * any other public https host (publicPhotoHop: where MLS Grid stores the file), which gets no token.
     */
    async download(url, purpose, o = {}) {
        const extra = o.extraHosts ?? [];
        if (!photoHopAllowed(url, extra))
            return { ok: false, status: 0 };
        let at = new URL(url).href;
        let ms = 0;
        for (let hop = 0;; hop++) {
            const host = new URL(at).hostname.toLowerCase();
            const r = await this.once(at, 'Media', purpose, { headers: photoHeaders(host, this.d.token), redirect: 'manual' });
            ms += r.ms;
            const status = r.status;
            if (status !== null && status >= 300 && status < 400) {
                let next = null;
                try {
                    const loc = r.headers?.get('location');
                    next = loc ? new URL(loc, at).href : null;
                }
                catch {
                    next = null;
                }
                if (next === null || hop >= exports.MAX_PHOTO_REDIRECTS || !(photoHopAllowed(next, extra) || publicPhotoHop(next))) {
                    const to = next === null ? '' : ` to ${new URL(next).hostname}`;
                    return { ok: false, status, stop: 'refused', why: `HTTP ${status} from ${host}: redirect${to} not followed` };
                }
                at = next;
                continue;
            }
            if (status === null || status >= 500) {
                return { ok: false, status: status ?? 0, stop: 'unavailable', why: status === null ? `no answer from ${host}` : `HTTP ${status} from ${host}` };
            }
            if (status === 401 || status === 403 || status === 429)
                return { ok: false, status, stop: 'refused', why: `HTTP ${status} from ${host}` };
            if (status < 200 || status >= 300)
                return { ok: false, status };
            if (r.data.byteLength === 0 || r.data.byteLength > MAX_PHOTO_BYTES)
                return { ok: false, status };
            const contentType = r.headers?.get('content-type') ?? '';
            if (!/^image\//i.test(contentType))
                return { ok: false, status };
            return { ok: true, data: r.data, contentType: contentType.split(';')[0].trim().toLowerCase(), ms };
        }
    }
    scrub(text) {
        return text.split(this.d.token).join('[token]').replace(/\s+/g, ' ').slice(0, 200);
    }
    /** One request: deadline, breaker, meter and a bucket slot first; a request-log row after it, also when it failed. */
    async once(url, resource, purpose, init) {
        const d = this.d;
        if (d.clock.now() >= d.deadline)
            throw new DeadlineError();
        d.breaker.assertClosed(d.clock.now());
        const verdict = checkMeter(await d.db.meter(), d.caps);
        if (!verdict.ok)
            throw new MeterRefusedError(verdict.reason);
        await d.bucket.take();
        if (d.clock.now() >= d.deadline)
            throw new DeadlineError();
        const started = d.clock.now();
        let status = null;
        let data = new Uint8Array(0);
        let headers = null;
        try {
            const res = await d.fetch(url, {
                method: 'GET',
                headers: init.headers,
                redirect: init.redirect,
                signal: AbortSignal.timeout(d.timeoutMs ?? 60_000),
            });
            status = res.status;
            headers = res.headers;
            data = new Uint8Array(await res.arrayBuffer());
        }
        catch {
            status = null;
        }
        const ms = Math.max(d.clock.now() - started, 0);
        this.requests += 1;
        this.bytes += data.byteLength;
        await d.db.logRequest({ resource, purpose, status, bytes: data.byteLength, ms });
        return { status, data, headers, ms };
    }
    /** One API call (getJson): the token as Bearer, redirects refused, retried and counted by the breaker. */
    async send(o) {
        const d = this.d;
        const retry = d.retry !== false;
        for (let attempt = 1;; attempt++) {
            const { status, data, headers, ms } = await this.once(o.url, o.resource, o.purpose, {
                headers: { Authorization: `Bearer ${d.token}`, Accept: 'application/json' },
                redirect: 'error',
            });
            if (status !== null && status >= 200 && status < 300) {
                d.breaker.success();
                return { ok: true, data, status, contentType: headers?.get('content-type') ?? '', ms };
            }
            const detail = status === null ? 'no answer (network error or timeout)' : this.scrub(new TextDecoder().decode(data));
            const now = d.clock.now();
            if (status === 401 || status === 403) {
                await d.breaker.openFor(exports.BREAKER_OPEN_MS, now);
                throw new BreakerOpenError(d.breaker.until);
            }
            const transient = status === null || status === 429 || status >= 500;
            if (!transient) {
                await d.breaker.failure(now);
                return { ok: false, status: status ?? 0, detail };
            }
            const opened = await d.breaker.failure(now);
            if (opened)
                throw new BreakerOpenError(d.breaker.until);
            if (!retry)
                return { ok: false, status: status ?? 0, detail };
            const asked = parseRetryAfter(headers?.get('retry-after'), now);
            const wait = asked ?? BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
            if (now + wait >= d.deadline) {
                if (asked !== null) {
                    await d.breaker.openFor(asked, now);
                    throw new BreakerOpenError(d.breaker.until);
                }
                throw new DeadlineError();
            }
            await d.clock.sleep(wait);
        }
    }
}
exports.MlsClient = MlsClient;
