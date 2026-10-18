"use strict";
// suite-kit: "Sign in with Google" for the team areas of Christine's apps (wave 3b), ONE copy, on the design of
// the Command Center's own Google sign-in (lib/google-signin.js, its pull request #88).
//
// Who may sign in is the hub's ONE list: hub flag signin_allowed_emails, read through GET /v1/signin/allowed
// (scope auth:read, wave 1a; thelittleladyinc@gmail.com and savannarbennett@gmail.com). An empty list, an error, a 503
// (signin_list_enabled off), an unconfigured hub or an unreadable answer all mean "nobody signs in with Google",
// never "everybody". A good answer is kept for 60 seconds, so taking an address off the list locks that person out
// within a minute: every request re-checks.
//
// Two ways an app uses it:
//   - Its own server-side flow (Expired Elite, the Seller Intelligence dashboard): beginSignin() sends the browser
//     to Google (authorization code + PKCE S256, scope "openid email", state + nonce + verifier in a short-lived
//     signed cookie); finishSignin() checks the state once, exchanges the code server-side (redirects refused,
//     10 s timeout), checks the id_token's iss / aud / exp / nonce and email_verified === true, lower-cases and
//     trims the email and matches it against the list, then hands back a signed session cookie (HMAC-SHA256 with
//     SESSION_SECRET, HttpOnly, Secure, SameSite=Lax). readSession() re-checks the list on every request.
//     The id_token is read without checking its signature because it comes straight from Google's token endpoint
//     over TLS in exchange for our client secret (OpenID Connect Core 3.1.3.7).
//   - Apps whose sign-in is Supabase Auth (christine-hq, Listing Engine's dashboard, the team app): Supabase runs
//     the Google flow; the app asks createHubAllowList(...).check(email) for every request.
//
// The switch: an app's Google sign-in is OFF until all of its settings are present (googleSigninSettings() answers
// null and the app behaves exactly as before). Once on, the app's current sign-in stays as the fallback until
// GOOGLE_SIGNIN_ONLY=on (exactly "on", trimmed, any case). Machine routes keep their own keys; none of this applies
// to them, and it never redirects an API call.
//
// Nothing here logs, or puts in an answer, a token, code, cookie, secret or key. Refusals carry a reason word; the
// email appears only on the refusal page shown to the person who just signed in with it.
//
// Web Crypto + fetch only (Node 18+, Deno, Edge runtimes, the browser for the page markup).
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALLOW_LIST_TTL_MS = exports.MIN_SESSION_SECRET_LENGTH = exports.DEFAULT_SESSION_DAYS = exports.STATE_MAX_AGE_S = exports.GOOGLE_TOKEN_URL = exports.GOOGLE_AUTH_URL = void 0;
exports.signinEmail = signinEmail;
exports.parseEmailList = parseEmailList;
exports.googleSigninOnly = googleSigninOnly;
exports.googleSigninOn = googleSigninOn;
exports.parseCookies = parseCookies;
exports.cookieString = cookieString;
exports.safeNext = safeNext;
exports.createHubAllowList = createHubAllowList;
exports.publicBaseUrl = publicBaseUrl;
exports.googleSigninProblems = googleSigninProblems;
exports.googleSigninSettings = googleSigninSettings;
exports.makeSessionCookie = makeSessionCookie;
exports.readSession = readSession;
exports.signoutCookie = signoutCookie;
exports.supabaseAuthMethods = supabaseAuthMethods;
exports.supabaseSignedInWithGoogle = supabaseSignedInWithGoogle;
exports.supabaseTeamDecision = supabaseTeamDecision;
exports.beginSignin = beginSignin;
exports.createUsedStates = createUsedStates;
exports.finishSignin = finishSignin;
exports.signinMessageText = signinMessageText;
exports.escapeHtml = escapeHtml;
exports.renderSigninPage = renderSigninPage;
const contact_ts_1 = require("./contact.js");
const hub_ts_1 = require("./hub.js");
exports.GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
exports.GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
exports.STATE_MAX_AGE_S = 10 * 60;
exports.DEFAULT_SESSION_DAYS = 30;
exports.MIN_SESSION_SECRET_LENGTH = 32;
exports.ALLOW_LIST_TTL_MS = 60 * 1000;
const TOKEN_TIMEOUT_MS = 10 * 1000;
// ── Small helpers ────────────────────────────────────────────────────────────
function clean(v) { return String(v == null ? '' : v).normalize('NFC').trim(); }
/** The one email form every comparison uses: contact.ts's normEmail (trimmed, lower case, checked), '' when not an email. */
function signinEmail(v) { return (0, contact_ts_1.normEmail)(typeof v === 'string' ? v.normalize('NFC') : v) ?? ''; }
/** A list typed by hand ("a@x.com, b@y.com"), de-duplicated, as normalised emails. */
function parseEmailList(v) {
    return [...new Set(clean(v).split(/[\s,;]+/).map(signinEmail).filter(Boolean))];
}
/** GOOGLE_SIGNIN_ONLY=on (trimmed, any case): the app's old sign-in no longer opens the team area. */
function googleSigninOnly(env) {
    return clean(env.GOOGLE_SIGNIN_ONLY).toLowerCase() === 'on';
}
/**
 * GOOGLE_SIGNIN=on (trimmed, any case): the switch for apps whose sign-in is Supabase Auth, where the Google client
 * lives in the Supabase project's settings, not in the app. Apps with their own flow are on when their settings are
 * all present (googleSigninSettings), like Command Center.
 */
function googleSigninOn(env) {
    return clean(env.GOOGLE_SIGNIN).toLowerCase() === 'on';
}
function b64url(bytes) {
    let s = '';
    for (const b of bytes)
        s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
    if (!/^[A-Za-z0-9_-]*$/.test(s))
        return null;
    try {
        const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++)
            out[i] = bin.charCodeAt(i);
        return out;
    }
    catch {
        return null;
    }
}
const enc = new TextEncoder();
const dec = new TextDecoder();
function randomToken(bytes) {
    return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
async function sha256(text) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
async function hmacKey(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
/** A purpose-bound key: HMAC-SHA256(SESSION_SECRET, label). A session cookie can never pass as a state cookie. */
async function deriveKey(secret, label) {
    const base = await hmacKey(enc.encode(secret));
    return hmacKey(new Uint8Array(await crypto.subtle.sign('HMAC', base, enc.encode(label))));
}
async function sign(key, payload) {
    const body = b64url(enc.encode(JSON.stringify(payload)));
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
    return `${body}.${b64url(mac)}`;
}
/** The payload of a value signed with this key, or null (wrong key, edited, malformed). Constant-time check. */
async function unsign(key, token) {
    if (typeof token !== 'string' || token.length > 4096)
        return null;
    const i = token.indexOf('.');
    if (i <= 0 || i !== token.lastIndexOf('.'))
        return null;
    const body = token.slice(0, i);
    const macText = token.slice(i + 1);
    const mac = fromB64url(macText);
    // Only the one canonical spelling: the last character's spare bits could otherwise be changed without
    // changing the bytes (a cookie that differs from the one we issued must not pass).
    if (!mac || mac.length !== 32 || b64url(mac) !== macText)
        return null;
    if (!await crypto.subtle.verify('HMAC', key, mac, enc.encode(body)))
        return null;
    const raw = fromB64url(body);
    if (!raw)
        return null;
    try {
        const p = JSON.parse(dec.decode(raw));
        return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
    }
    catch {
        return null;
    }
}
/** Constant-time string equality (both sides hashed first, so lengths do not leak). */
async function sameString(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b)
        return false;
    const [x, y] = await Promise.all([sha256(a), sha256(b)]);
    let diff = 0;
    for (let i = 0; i < x.length; i++)
        diff |= x[i] ^ y[i];
    return diff === 0;
}
// ── Cookies ──────────────────────────────────────────────────────────────────
/** name -> value from a Cookie header; the first of a repeated name wins. */
function parseCookies(header) {
    const out = {};
    for (const part of String(header ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i <= 0)
            continue;
        const name = part.slice(0, i).trim();
        if (!name || name in out)
            continue;
        let value = part.slice(i + 1).trim();
        if (value.startsWith('"') && value.endsWith('"'))
            value = value.slice(1, -1);
        try {
            out[name] = decodeURIComponent(value);
        }
        catch {
            out[name] = value;
        }
    }
    return out;
}
/** A Set-Cookie value: always HttpOnly; Secure; SameSite=Lax. maxAge 0 clears it. */
function cookieString(name, value, o = {}) {
    const parts = [`${name}=${value}`, `Path=${o.path ?? '/'}`, 'HttpOnly', 'Secure', 'SameSite=Lax'];
    if (o.maxAge != null)
        parts.push(`Max-Age=${o.maxAge}`);
    if (o.maxAge === 0)
        parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    return parts.join('; ');
}
/** Only a path on this site ("/x"), never "//host", "/\host", a full URL or one of the sign-in routes. */
function safeNext(v, authPaths = []) {
    const s = typeof v === 'string' ? v : '';
    if (!s || s.length > 512 || !s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\'))
        return '/';
    if (/[\u0000-\u001f\u007f\s\\]/.test(s))
        return '/';
    if (authPaths.includes(s.split('?')[0]))
        return '/';
    return s;
}
/**
 * The hub's sign-in list, kept 60 s after a good answer. Not configured, unreachable, refused (503 while
 * signin_list_enabled is off, 401/403 without scope auth:read), unreadable, enabled !== true or an empty list =
 * 'unavailable' (nobody). Failures are never cached, so a fixed hub works on the next request.
 */
function createHubAllowList(hub, o = {}) {
    const ttl = o.ttlMs ?? exports.ALLOW_LIST_TTL_MS;
    const now = o.now ?? (() => Date.now());
    let cached = null;
    let inflight = null;
    async function load() {
        if (cached && cached.until > now())
            return cached.emails;
        if (!hub.configured)
            return null;
        if (!inflight) {
            inflight = (async () => {
                try {
                    const r = await hub.signinAllowed();
                    if (!r.ok || r.body?.enabled !== true || !Array.isArray(r.body.emails))
                        return null;
                    const emails = new Set(r.body.emails.filter((e) => typeof e === 'string').map(signinEmail).filter(Boolean));
                    if (!emails.size)
                        return null;
                    cached = { emails, until: now() + ttl };
                    return emails;
                }
                catch {
                    return null;
                }
                finally {
                    inflight = null;
                }
            })();
        }
        return inflight;
    }
    async function check(email) {
        const e = signinEmail(email);
        const list = await load();
        if (!list)
            return 'unavailable';
        return e && list.has(e) ? 'allowed' : 'not_allowed';
    }
    return { check, isAllowed: async (email) => (await check(email)) === 'allowed' };
}
/** PUBLIC_BASE_URL (else the default) as an origin: https only (http only for localhost). Never the Host header. */
function publicBaseUrl(env, fallback) {
    const raw = clean(env.PUBLIC_BASE_URL) || fallback;
    try {
        const u = new URL(raw);
        const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))
            return null;
        return u.origin;
    }
    catch {
        return null;
    }
}
/** Why Google sign-in is off, as words (setting NAMES, never values). Empty = on. */
function googleSigninProblems(env, o) {
    const out = [];
    for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET'])
        if (!clean(env[name]))
            out.push(`${name} is not set`);
    const secret = clean(env.SESSION_SECRET);
    if (secret && secret.length < exports.MIN_SESSION_SECRET_LENGTH)
        out.push(`SESSION_SECRET is shorter than ${exports.MIN_SESSION_SECRET_LENGTH} characters`);
    if (!publicBaseUrl(env, o.defaultBaseUrl))
        out.push('PUBLIC_BASE_URL is not an https address');
    if (!(0, hub_ts_1.hubConfigured)({ baseUrl: env.HUB_API_URL, key: env.HUB_API_KEY }))
        out.push('HUB_API_URL / HUB_API_KEY are not set (the sign-in list lives in the hub)');
    return out;
}
const keyCache = new Map();
/** The settings, or null while any is missing (then the app behaves exactly as before). Read per request. */
async function googleSigninSettings(env, o) {
    if (googleSigninProblems(env, o).length)
        return null;
    const secret = clean(env.SESSION_SECRET);
    const cacheKey = `${o.cookiePrefix}\u0000${secret}`;
    let keys = keyCache.get(cacheKey);
    if (!keys) {
        keys = (async () => ({
            sessionKey: await deriveKey(secret, `${o.cookiePrefix}-session-v1`),
            stateKey: await deriveKey(secret, `${o.cookiePrefix}-oauth-state-v1`),
        }))();
        keyCache.clear(); // one secret at a time: a rotated secret replaces the old keys
        keyCache.set(cacheKey, keys);
    }
    const { sessionKey, stateKey } = await keys;
    return {
        clientId: clean(env.GOOGLE_CLIENT_ID),
        clientSecret: clean(env.GOOGLE_CLIENT_SECRET),
        redirectUri: publicBaseUrl(env, o.defaultBaseUrl) + o.callbackPath,
        sessionCookie: `${o.cookiePrefix}_session`,
        stateCookie: `${o.cookiePrefix}_oauth_state`,
        statePath: o.statePath ?? '/',
        sessionMaxAgeS: Math.round((o.sessionDays ?? exports.DEFAULT_SESSION_DAYS) * 24 * 60 * 60),
        sessionKey,
        stateKey,
    };
}
// ── Sessions ─────────────────────────────────────────────────────────────────
async function makeSessionCookie(s, email, nowMs = Date.now()) {
    const iat = Math.floor(nowMs / 1000);
    const value = await sign(s.sessionKey, { v: 1, e: signinEmail(email), iat, exp: iat + s.sessionMaxAgeS });
    return cookieString(s.sessionCookie, value, { maxAge: s.sessionMaxAgeS });
}
/** The signed-in email, or null: bad or expired cookie, or the email is no longer on the list (or it is unreadable). */
async function readSession(s, cookieHeader, list, nowMs = Date.now()) {
    if (!s)
        return null;
    const raw = parseCookies(cookieHeader)[s.sessionCookie];
    if (!raw)
        return null;
    const p = await unsign(s.sessionKey, raw);
    if (!p || p.v !== 1 || typeof p.e !== 'string' || typeof p.iat !== 'number' || typeof p.exp !== 'number')
        return null;
    const now = Math.floor(nowMs / 1000);
    if (p.exp <= now || p.iat > now + 300 || p.exp - p.iat > s.sessionMaxAgeS)
        return null;
    const email = signinEmail(p.e);
    return (await list.check(email)) === 'allowed' ? email : null;
}
function signoutCookie(s) {
    return cookieString(s.sessionCookie, '', { maxAge: 0 });
}
// ── Supabase sessions ────────────────────────────────────────────────────────
/**
 * How a Supabase session was signed in: the "amr" methods in its access token ("oauth" for Google, "password",
 * "otp", "magiclink", …). Reads the token WITHOUT checking its signature, so call it only on a token the app has
 * already verified (supabase.auth.getUser() succeeded with it, or the JWT secret checked it). [] when unreadable.
 */
function supabaseAuthMethods(accessToken) {
    const c = claimsOf(accessToken);
    if (!c || !Array.isArray(c.amr))
        return [];
    return c.amr.map((a) => (a && typeof a === 'object' ? a.method : a)).filter((m) => typeof m === 'string');
}
/** True when that (verified) Supabase session was signed in with Google (the only OAuth provider the apps enable). */
function supabaseSignedInWithGoogle(accessToken) {
    return supabaseAuthMethods(accessToken).includes('oauth');
}
async function supabaseTeamDecision(env, session, list) {
    if (!googleSigninOn(env))
        return 'fallback';
    if (supabaseSignedInWithGoogle(session.accessToken))
        return list.check(session.email);
    return googleSigninOnly(env) ? 'google_only' : 'fallback';
}
// ── The flow ─────────────────────────────────────────────────────────────────
/** Where to send the browser, and the state cookie to set with that redirect. */
async function beginSignin(s, next, nowMs = Date.now()) {
    const state = randomToken(18);
    const nonce = randomToken(18);
    const verifier = randomToken(32);
    const challenge = b64url(await sha256(verifier));
    const exp = Math.floor(nowMs / 1000) + exports.STATE_MAX_AGE_S;
    const value = await sign(s.stateKey, { s: state, n: nonce, cv: verifier, nx: next, exp });
    const u = new URL(exports.GOOGLE_AUTH_URL);
    u.search = new URLSearchParams({
        client_id: s.clientId,
        redirect_uri: s.redirectUri,
        response_type: 'code',
        scope: 'openid email',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
    }).toString();
    return { location: u.toString(), setCookie: cookieString(s.stateCookie, value, { maxAge: exports.STATE_MAX_AGE_S, path: s.statePath }) };
}
/** One state works once per process (the cookie is also cleared on the first callback). */
function createUsedStates(now = () => Date.now()) {
    const used = new Map();
    return {
        has: (id) => used.has(id),
        add(id) {
            const t = now();
            for (const [k, exp] of used)
                if (exp <= t)
                    used.delete(k);
            used.set(id, t + exports.STATE_MAX_AGE_S * 1000);
        },
    };
}
const defaultUsedStates = createUsedStates();
function claimsOf(idToken) {
    if (typeof idToken !== 'string')
        return null;
    const parts = idToken.split('.');
    if (parts.length !== 3)
        return null;
    const raw = fromB64url(parts[1]);
    if (!raw)
        return null;
    try {
        const p = JSON.parse(dec.decode(raw));
        return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
    }
    catch {
        return null;
    }
}
/**
 * Google's callback. `params` is the callback's query string; `cookieHeader` the request's Cookie header.
 * Always clears the state cookie. On success the caller sets setCookies and redirects to next.
 */
async function finishSignin(s, input, deps) {
    const now = deps.now ?? (() => Date.now());
    const used = deps.usedStates ?? defaultUsedStates;
    const clear = [cookieString(s.stateCookie, '', { maxAge: 0, path: s.statePath })];
    const st = await unsign(s.stateKey, parseCookies(input.cookieHeader)[s.stateCookie]);
    const next = safeNext(st?.nx, deps.authPaths);
    const refuse = (status, reason, email) => ({ ok: false, reason, status, ...(email !== undefined ? { email } : {}), next, setCookies: clear });
    if (input.params.get('error'))
        return refuse(400, 'cancelled');
    const qState = input.params.get('state') ?? '';
    const code = input.params.get('code') ?? '';
    if (!st || typeof st.s !== 'string' || typeof st.n !== 'string' || typeof st.cv !== 'string' || typeof st.exp !== 'number')
        return refuse(400, 'bad_state');
    if (st.exp <= Math.floor(now() / 1000) || !qState || !await sameString(qState, st.s) || used.has(st.s))
        return refuse(400, 'bad_state');
    used.add(st.s);
    if (!code || code.length > 2048)
        return refuse(400, 'bad_state');
    let idToken = null;
    try {
        const f = deps.fetch ?? ((u, i) => globalThis.fetch(u, i));
        const r = await f(exports.GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
                code,
                client_id: s.clientId,
                client_secret: s.clientSecret,
                redirect_uri: s.redirectUri,
                grant_type: 'authorization_code',
                code_verifier: st.cv,
            }).toString(),
            redirect: 'error',
            signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        });
        if (!r || !r.ok)
            return refuse(502, 'google_error');
        let body;
        try {
            body = await r.json();
        }
        catch {
            return refuse(502, 'bad_token');
        }
        idToken = body?.id_token;
    }
    catch {
        return refuse(502, 'google_error');
    }
    const c = claimsOf(idToken);
    const nowS = Math.floor(now() / 1000);
    const audOk = !!c && (Array.isArray(c.aud) ? c.aud.includes(s.clientId) : c.aud === s.clientId);
    if (!c || !GOOGLE_ISSUERS.has(String(c.iss)) || !audOk || typeof c.exp !== 'number' || c.exp <= nowS
        || !await sameString(c.nonce, st.n)) {
        return refuse(502, 'bad_token');
    }
    const email = signinEmail(c.email);
    if (c.email_verified !== true || !email)
        return refuse(403, 'unverified', email);
    const allowed = await deps.list.check(email);
    if (allowed === 'unavailable')
        return refuse(503, 'list_unavailable', email);
    if (allowed !== 'allowed')
        return refuse(403, 'not_allowed', email);
    // The caller starts its own session: makeSessionCookie() (the toolkit's cookie), or the app's existing one.
    return { ok: true, email, next, setCookies: clear };
}
const MESSAGES = {
    signed_out: { bad: false, text: () => "You're signed out." },
    not_allowed: { bad: true, text: (app, e) => `This Google account${e ? ` (${e})` : ''} isn't allowed into ${app}.` },
    unverified: { bad: true, text: (_a, e) => `This Google account${e ? ` (${e})` : ''} doesn't have a verified email address, so it can't sign in. Verify the address with Google, or try another account.` },
    cancelled: { bad: false, text: () => 'Sign-in was cancelled. Nothing was changed.' },
    bad_state: { bad: true, text: () => 'That sign-in link expired or was already used. Please start again.' },
    google_error: { bad: true, text: () => "Google didn't answer the sign-in. Please try again in a minute." },
    bad_token: { bad: true, text: () => "Google's answer could not be checked, so you were not signed in. Please try again." },
    list_unavailable: { bad: true, text: () => "The list of who may sign in couldn't be read, so nobody can sign in with Google right now. Please try again in a minute." },
    fallback_off: { bad: false, text: (app) => `The old sign-in no longer opens ${app}. Sign in with Google.` },
};
function signinMessageText(message, appName, email) {
    return MESSAGES[message].text(appName, email);
}
function escapeHtml(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/** A whole HTML page: one "Sign in with Google" button, the refusal message, and the fallback link. */
function renderSigninPage(o) {
    const next = o.next && o.next !== '/' ? o.next : '/';
    const nextQ = next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
    const msg = o.message ? MESSAGES[o.message] : null;
    const msgText = msg ? msg.text(o.appName, o.messageEmail) : '';
    const tryAnother = o.message === 'not_allowed' || o.message === 'unverified';
    const body = o.email
        ? `<p class="who">Signed in as <strong>${escapeHtml(o.email)}</strong></p>
    <a class="btn primary" href="${escapeHtml(next)}">Open ${escapeHtml(o.appName)}</a>
    <p class="small"><a href="${escapeHtml(o.signoutPath)}">Sign out</a></p>`
        : `${msgText ? `<p class="notice${msg?.bad ? ' bad' : ''}" role="status">${escapeHtml(msgText)}</p>` : ''}
    <a class="btn primary" href="${escapeHtml(o.startPath + nextQ)}">${tryAnother ? 'Try another Google account' : 'Sign in with Google'}</a>
    ${o.fallback ? `<p class="small muted">Or <a href="${escapeHtml(o.fallback.href)}">${escapeHtml(o.fallback.label)}</a>.</p>` : ''}`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Sign in | ${escapeHtml(o.appName)}</title>
<meta name="robots" content="noindex">
<style>
:root{color-scheme:dark;--bg:#141210;--panel:#201d1a;--ink:#f5f0e8;--muted:#beb5aa;--border:#433b34;--accent:#deb3a5;--accent-ink:#141210;--warn:#efc27b;--bad:#f0a39a;--mauve:#b86f7a}
@media (prefers-color-scheme: light){:root{color-scheme:light;--bg:#f5f0e8;--panel:#fffdf9;--ink:#0a0a0a;--muted:#665d55;--border:#d9cec2;--accent:#864d5b;--accent-ink:#fffdf9;--warn:#805000;--bad:#a1261c}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:16px}
main{width:100%;max-width:420px;background:var(--panel);border:1px solid var(--border);border-top:4px solid var(--mauve);border-radius:14px;padding:28px 24px}
.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
h1{font-size:28px;line-height:1.2;margin:4px 0 18px}
a{color:var(--accent)}
.btn{font-weight:600;font-size:16px;border-radius:10px;border:1px solid transparent;padding:12px 16px;min-height:48px;width:100%;cursor:pointer;text-decoration:none;display:flex;align-items:center;justify-content:center}
.primary{background:var(--accent);color:var(--accent-ink)}
.btn:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.notice{border-left:3px solid var(--warn);background:var(--bg);padding:10px 12px;border-radius:6px;margin:0 0 16px;font-size:15px;overflow-wrap:anywhere}
.notice.bad{border-left-color:var(--bad)}
.who{margin:0 0 16px;overflow-wrap:anywhere}
.small{font-size:14px;margin:16px 0 0}.muted{color:var(--muted)}
</style></head>
<body><main>
  <div class="eyebrow">${escapeHtml(o.appName)}</div>
  <h1>Sign in</h1>
  ${body}
</main></body></html>`;
}
