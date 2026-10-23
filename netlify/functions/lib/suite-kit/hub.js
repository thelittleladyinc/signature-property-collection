"use strict";
// suite-kit: the client every app uses to ask the shared hub (Seller Intelligence's hub-api Edge Function)
// instead of calling a vendor itself: Lofty through the doorway, the lead router, the hub's MLS copy, the
// RentCast cache, the sign-in list, and the existing email / skip-trace / intake routes.
//
// Rules (the same ones Command Center's hub-email.js already follows):
//   - HUB_API_URL must be https; the key (HUB_API_KEY, "hub_" + 64 hex) goes in header x-hub-key only, never
//     a URL, a log line or an error.
//   - Redirects are refused; 20 s timeout; one attempt (the hub's own routes are idempotent where it
//     matters, so a caller may retry with the same idempotency key).
//   - Not configured (no URL or key) answers { ok: false, reason: 'not_configured' } without a network call.
//   - Every answer is { ok, status, body }. ok is true only for a 2xx JSON answer.
//
// 0.5.2 (the side-by-side check, sellerintelligence docs/hub-parity-compare.md): `{ dryRun: true }` on the Lofty write
// methods sends `dry_run: true` (the hub reads Lofty as for real, writes nothing, and answers the outcome plus
// `planned`, the Lofty requests it would have sent), and `{ cacheOnly: true }` on rentcast sends `cache_only: true`
// (a saved answer or `miss` / `stale`; never a RentCast call, never the daily cap).
//
// Web-standard fetch only; runs in Node 18+, Deno and the browser (never ship the key to a browser).
Object.defineProperty(exports, "__esModule", { value: true });
exports.hubConfigured = hubConfigured;
exports.createHubClient = createHubClient;
const KEY_RE = /^hub_[0-9a-f]{64}$/;
function hubConfigured(o) {
    try {
        return !!o.baseUrl && new URL(o.baseUrl).protocol === 'https:' && typeof o.key === 'string' && KEY_RE.test(o.key.trim());
    }
    catch {
        return false;
    }
}
function createHubClient(o) {
    const configured = hubConfigured(o);
    const base = configured ? String(o.baseUrl).replace(/\/+$/, '') : '';
    const key = configured ? String(o.key).trim() : '';
    const fetchImpl = o.fetch ?? ((u, i) => globalThis.fetch(u, i));
    async function call(method, path, body, query) {
        if (!configured)
            return { ok: false, status: null, reason: 'not_configured', body: null };
        if (!/^\/v1\/[a-z0-9/_-]+$/.test(path))
            return { ok: false, status: null, reason: 'refused', body: { error: 'bad hub path' } };
        const qs = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
        let res;
        try {
            res = await fetchImpl(`${base}${path}${qs ? `?${qs}` : ''}`, {
                method,
                headers: { 'x-hub-key': key, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                redirect: 'error',
                signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
            });
        }
        catch {
            return { ok: false, status: null, reason: 'unreachable', body: null };
        }
        let parsed = null;
        try {
            parsed = JSON.parse(await res.text());
        }
        catch {
            parsed = null;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return { ok: false, status: res.status, reason: 'bad_answer', body: null };
        if (res.status < 200 || res.status >= 300)
            return { ok: false, status: res.status, reason: 'refused', body: parsed };
        return { ok: true, status: res.status, body: parsed };
    }
    /** dry_run: true only when asked (an answer from the dry run is never mistaken for a write: the hub says dry_run: true). */
    const dry = (b, opts) => (opts?.dryRun === true ? { ...b, dry_run: true } : b);
    return {
        configured,
        call,
        loftyConsent: (p) => call('POST', '/v1/lofty/consent', p),
        loftyMirror: (p) => call('POST', '/v1/lofty/mirror', p),
        loftyLead: (l, opts) => call('POST', '/v1/lofty/lead', dry(l, opts)),
        loftyNote: (n, opts) => call('POST', '/v1/lofty/note', dry(n, opts)),
        loftyOptOut: (x, opts) => call('POST', '/v1/lofty/opt-out', dry(x, opts)),
        loftyTask: (t, opts) => call('POST', '/v1/lofty/task', dry(t, opts)),
        loftyFlags: (f, opts) => call('POST', '/v1/lofty/flags', dry(f, opts)),
        loftyStage: (x, opts) => call('POST', '/v1/lofty/stage', dry(x, opts)),
        loftyEmailAdd: (e, opts) => call('POST', '/v1/lofty/email-add', dry(e, opts)),
        loftyFillName: (n, opts) => call('POST', '/v1/lofty/fill-name', dry(n, opts)),
        loftyRead: (r) => call('POST', '/v1/lofty/read', r),
        loftyWebhooks: (w) => call('POST', '/v1/lofty/webhooks', w),
        routerLead: (l) => call('POST', '/v1/router/lead', l),
        callList: (limit) => call('GET', '/v1/router/call-list', undefined, { limit }),
        mlsListing: (mls) => call('GET', '/v1/mls/listing', undefined, { mls }),
        mlsByAddress: (a) => call('POST', '/v1/mls/by-address', a),
        mlsMine: () => call('GET', '/v1/mls/mine'),
        mlsExpired: (q = {}) => call('GET', '/v1/mls/expired', undefined, q),
        mlsClosed: (q) => call('GET', '/v1/mls/closed', undefined, q),
        rentcast: (a, opts) => call('POST', '/v1/lookup/rentcast', opts?.cacheOnly === true ? { ...a, cache_only: true } : a),
        signinAllowed: () => call('GET', '/v1/signin/allowed'),
    };
}
