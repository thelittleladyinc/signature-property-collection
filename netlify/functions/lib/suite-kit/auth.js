"use strict";
// suite-kit: shared-secret guards that REFUSE when the key is unset (Duplication Audit, Oct 11: four
// open-when-unset API-key guards and 26 inline worker-token checks).
//
// The rule, everywhere:
//   - The expected key not set (missing, empty, whitespace, or shorter than MIN_KEY_LENGTH) → 503
//     "<NAME> is not set on this server, so this route is off". Never "let it through".
//   - A presented key that does not match → 401. One message for missing and wrong.
//   - The comparison is constant-time: both sides are hashed with SHA-256 and the 32-byte digests are
//     compared without an early exit, so neither the content nor the length of the expected key leaks
//     through timing.
//   - Keys come from a header only (never a query string, which ends up in logs), unless the caller
//     explicitly allows a query parameter for a sender that cannot set headers.
//   - The key's VALUE never appears in an answer, a log line or an error; only its env var NAME does.
//
// Framework-free: checkKey() is the decision; expressGuard() and requestGuard() wrap it for Express
// (Command Center, Listing Engine API) and for Fetch-style handlers (Next.js route handlers, Deno).
// Web Crypto only (crypto.subtle), present in Node 18+, Deno and browsers.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_KEY_LENGTH = void 0;
exports.configuredKey = configuredKey;
exports.constantTimeEqualBytes = constantTimeEqualBytes;
exports.keysMatch = keysMatch;
exports.checkKey = checkKey;
exports.expressGuard = expressGuard;
exports.requestGuard = requestGuard;
exports.checkBearer = checkBearer;
exports.MIN_KEY_LENGTH = 16;
/** The configured key, trimmed; null when unset or too short to be a real key. */
function configuredKey(value) {
    if (typeof value !== 'string')
        return null;
    const t = value.trim();
    return t.length >= exports.MIN_KEY_LENGTH ? t : null;
}
async function digest(text) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
/** Constant-time equality of two byte arrays of the same length (false for different lengths). */
function constantTimeEqualBytes(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a[i] ^ b[i];
    return diff === 0;
}
/** True when the two strings are equal, compared in constant time over their SHA-256 digests. */
async function keysMatch(presented, expected) {
    if (typeof presented !== 'string' || typeof expected !== 'string' || !presented || !expected)
        return false;
    const [a, b] = await Promise.all([digest(presented), digest(expected)]);
    return constantTimeEqualBytes(a, b);
}
/**
 * The decision for one request. `envName` is only used in the 503 message (a NAME, never a value).
 * A key shorter than MIN_KEY_LENGTH counts as unset: a one-letter "key" is a misconfiguration.
 */
async function checkKey(presented, expected, envName) {
    const want = configuredKey(expected);
    if (!want)
        return { ok: false, status: 503, error: `${envName} is not set on this server, so this route is off` };
    const got = typeof presented === 'string' ? presented.trim() : '';
    if (got && await keysMatch(got, want))
        return { ok: true };
    return { ok: false, status: 401, error: 'unauthorized' };
}
function presentedFrom(headerValue, query) {
    const h = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (typeof h === 'string' && h.trim())
        return h;
    const q = Array.isArray(query) ? query[0] : query;
    return typeof q === 'string' && q.trim() ? q : null;
}
/** Express middleware: next() only on a matching key. */
function expressGuard(o) {
    const header = o.header.toLowerCase();
    return async (req, res, next) => {
        const raw = req.get ? req.get(header) : req.headers?.[header];
        const query = o.queryParam ? req.query?.[o.queryParam] : undefined;
        const d = await checkKey(presentedFrom(raw, query), o.expected(), o.envName);
        if (d.ok) {
            next();
            return;
        }
        res.status(d.status).json({ ok: false, error: d.error });
    };
}
/** Fetch-style guard: null when the request may go on, else the Response to send. */
function requestGuard(o) {
    return async (req) => {
        const query = o.queryParam ? new URL(req.url).searchParams.get(o.queryParam) : null;
        const d = await checkKey(presentedFrom(req.headers.get(o.header), query), o.expected(), o.envName);
        if (d.ok)
            return null;
        return new Response(JSON.stringify({ ok: false, error: d.error }), {
            status: d.status,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
    };
}
/**
 * A bearer token ("Authorization: Bearer <token>"), e.g. a worker or cron token. Same rules: unset → 503,
 * missing or wrong → 401, constant-time.
 */
async function checkBearer(authorization, expected, envName) {
    const m = typeof authorization === 'string' ? authorization.match(/^\s*Bearer\s+(\S+)\s*$/i) : null;
    return checkKey(m ? m[1] : null, expected, envName);
}
