import { type HubClient } from './hub.ts';
export declare const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export declare const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export declare const STATE_MAX_AGE_S: number;
export declare const DEFAULT_SESSION_DAYS = 30;
export declare const MIN_SESSION_SECRET_LENGTH = 32;
export declare const ALLOW_LIST_TTL_MS: number;
export type SigninEnv = Record<string, string | undefined>;
/** The one email form every comparison uses: contact.ts's normEmail (trimmed, lower case, checked), '' when not an email. */
export declare function signinEmail(v: unknown): string;
/** A list typed by hand ("a@x.com, b@y.com"), de-duplicated, as normalised emails. */
export declare function parseEmailList(v: unknown): string[];
/** GOOGLE_SIGNIN_ONLY=on (trimmed, any case): the app's old sign-in no longer opens the team area. */
export declare function googleSigninOnly(env: SigninEnv): boolean;
/**
 * GOOGLE_SIGNIN=on (trimmed, any case): the switch for apps whose sign-in is Supabase Auth, where the Google client
 * lives in the Supabase project's settings, not in the app. Apps with their own flow are on when their settings are
 * all present (googleSigninSettings), like Command Center.
 */
export declare function googleSigninOn(env: SigninEnv): boolean;
/** name -> value from a Cookie header; the first of a repeated name wins. */
export declare function parseCookies(header: unknown): Record<string, string>;
/** A Set-Cookie value: always HttpOnly; Secure; SameSite=Lax. maxAge 0 clears it. */
export declare function cookieString(name: string, value: string, o?: {
    maxAge?: number;
    path?: string;
}): string;
/** Only a path on this site ("/x"), never "//host", "/\host", a full URL or one of the sign-in routes. */
export declare function safeNext(v: unknown, authPaths?: readonly string[]): string;
export type AllowCheck = 'allowed' | 'not_allowed' | 'unavailable';
export interface AllowList {
    /** 'unavailable' = the hub could not answer (or the list is off or empty): nobody gets in. */
    check(email: unknown): Promise<AllowCheck>;
    isAllowed(email: unknown): Promise<boolean>;
}
/**
 * The hub's sign-in list, kept 60 s after a good answer. Not configured, unreachable, refused (503 while
 * signin_list_enabled is off, 401/403 without scope auth:read), unreadable, enabled !== true or an empty list =
 * 'unavailable' (nobody). Failures are never cached, so a fixed hub works on the next request.
 */
export declare function createHubAllowList(hub: Pick<HubClient, 'configured' | 'signinAllowed'>, o?: {
    ttlMs?: number;
    now?: () => number;
}): AllowList;
export interface GoogleSigninOptions {
    /** The app's https address when PUBLIC_BASE_URL is unset, e.g. https://expired-elite-finder.onrender.com */
    defaultBaseUrl: string;
    /** Where Google sends people back, e.g. /api/auth/google/callback. Registered on the OAuth client. */
    callbackPath: string;
    /** Cookie names: <prefix>_session and <prefix>_oauth_state. */
    cookiePrefix: string;
    /** Path the state cookie is limited to (must cover the start and callback routes). Default '/'. */
    statePath?: string;
    /** Session length in days (default 30). */
    sessionDays?: number;
}
export interface GoogleSigninSettings {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    sessionCookie: string;
    stateCookie: string;
    statePath: string;
    sessionMaxAgeS: number;
    sessionKey: CryptoKey;
    stateKey: CryptoKey;
}
/** PUBLIC_BASE_URL (else the default) as an origin: https only (http only for localhost). Never the Host header. */
export declare function publicBaseUrl(env: SigninEnv, fallback: string): string | null;
/** Why Google sign-in is off, as words (setting NAMES, never values). Empty = on. */
export declare function googleSigninProblems(env: SigninEnv, o: Pick<GoogleSigninOptions, 'defaultBaseUrl'>): string[];
/** The settings, or null while any is missing (then the app behaves exactly as before). Read per request. */
export declare function googleSigninSettings(env: SigninEnv, o: GoogleSigninOptions): Promise<GoogleSigninSettings | null>;
export declare function makeSessionCookie(s: GoogleSigninSettings, email: string, nowMs?: number): Promise<string>;
/** The signed-in email, or null: bad or expired cookie, or the email is no longer on the list (or it is unreadable). */
export declare function readSession(s: GoogleSigninSettings | null, cookieHeader: unknown, list: AllowList, nowMs?: number): Promise<string | null>;
export declare function signoutCookie(s: GoogleSigninSettings): string;
/**
 * How a Supabase session was signed in: the "amr" methods in its access token ("oauth" for Google, "password",
 * "otp", "magiclink", …). Reads the token WITHOUT checking its signature, so call it only on a token the app has
 * already verified (supabase.auth.getUser() succeeded with it, or the JWT secret checked it). [] when unreadable.
 */
export declare function supabaseAuthMethods(accessToken: unknown): string[];
/** True when that (verified) Supabase session was signed in with Google (the only OAuth provider the apps enable). */
export declare function supabaseSignedInWithGoogle(accessToken: unknown): boolean;
/**
 * The team-area decision for an app whose sign-in is Supabase Auth, for one verified session:
 *   - Google sign-in off (GOOGLE_SIGNIN not "on"): 'fallback' (the app's own rules decide, exactly as before).
 *   - A Google session: the hub's list decides ('allowed' / 'not_allowed' / 'unavailable').
 *   - Any other session: 'fallback' until GOOGLE_SIGNIN_ONLY=on, then 'google_only' (refused).
 */
export type SupabaseTeamDecision = 'fallback' | 'allowed' | 'not_allowed' | 'unavailable' | 'google_only';
export declare function supabaseTeamDecision(env: SigninEnv, session: {
    accessToken: unknown;
    email: unknown;
}, list: AllowList): Promise<SupabaseTeamDecision>;
/** Where to send the browser, and the state cookie to set with that redirect. */
export declare function beginSignin(s: GoogleSigninSettings, next: string, nowMs?: number): Promise<{
    location: string;
    setCookie: string;
}>;
export type SigninRefusal = 'cancelled' | 'bad_state' | 'google_error' | 'bad_token' | 'unverified' | 'not_allowed' | 'list_unavailable';
export type SigninOutcome = {
    ok: true;
    email: string;
    next: string;
    setCookies: string[];
} | {
    ok: false;
    reason: SigninRefusal;
    status: number;
    email?: string;
    next: string;
    setCookies: string[];
};
/** One state works once per process (the cookie is also cleared on the first callback). */
export declare function createUsedStates(now?: () => number): {
    has: (id: string) => boolean;
    add(id: string): void;
};
type TokenFetch = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    redirect: 'error';
    signal?: AbortSignal;
}) => Promise<{
    ok: boolean;
    json(): Promise<unknown>;
}>;
/**
 * Google's callback. `params` is the callback's query string; `cookieHeader` the request's Cookie header.
 * Always clears the state cookie. On success the caller sets setCookies and redirects to next.
 */
export declare function finishSignin(s: GoogleSigninSettings, input: {
    params: URLSearchParams;
    cookieHeader: unknown;
}, deps: {
    list: AllowList;
    fetch?: TokenFetch;
    now?: () => number;
    usedStates?: ReturnType<typeof createUsedStates>;
    authPaths?: readonly string[];
}): Promise<SigninOutcome>;
export type SigninMessage = SigninRefusal | 'signed_out' | 'fallback_off';
export declare function signinMessageText(message: SigninMessage, appName: string, email?: string): string;
export declare function escapeHtml(v: unknown): string;
export interface SigninPageOptions {
    appName: string;
    /** The route that calls beginSignin(), e.g. /api/auth/google */
    startPath: string;
    /** The route that clears the session, e.g. /api/auth/google/signout */
    signoutPath: string;
    next?: string;
    email?: string | null;
    message?: SigninMessage;
    messageEmail?: string;
    /** The app's old sign-in, shown while GOOGLE_SIGNIN_ONLY is off. */
    fallback?: {
        href: string;
        label: string;
    } | null;
}
/** A whole HTML page: one "Sign in with Google" button, the refusal message, and the fallback link. */
export declare function renderSigninPage(o: SigninPageOptions): string;
export {};
