export type HubFetch = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect: 'error';
    signal?: AbortSignal;
}) => Promise<{
    status: number;
    text(): Promise<string>;
}>;
export interface HubClientOptions {
    /** HUB_API_URL, e.g. https://<project>.supabase.co/functions/v1/hub-api */
    baseUrl: string | undefined | null;
    /** HUB_API_KEY's value. */
    key: string | undefined | null;
    fetch?: HubFetch;
    timeoutMs?: number;
}
export type HubAnswer<T = Record<string, unknown>> = {
    ok: true;
    status: number;
    body: T;
} | {
    ok: false;
    status: number | null;
    reason: 'not_configured' | 'unreachable' | 'bad_answer' | 'refused';
    body: Record<string, unknown> | null;
};
export declare function hubConfigured(o: Pick<HubClientOptions, 'baseUrl' | 'key'>): boolean;
export interface HubClient {
    configured: boolean;
    call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<HubAnswer<T>>;
    loftyConsent(person: {
        lead_id?: string;
        email?: string;
        phone?: string;
    }): Promise<HubAnswer>;
    loftyMirror(person: {
        lead_id?: string;
        email?: string;
        phone?: string;
    }): Promise<HubAnswer>;
    loftyLead(lead: Record<string, unknown>): Promise<HubAnswer>;
    loftyNote(note: {
        lead_id: string;
        content: string;
        idempotency_key?: string;
    }): Promise<HubAnswer>;
    loftyOptOut(o: {
        kind: 'email' | 'do_not_contact';
        lead_id?: string;
        email?: string;
        phone?: string;
        reason?: string;
        note?: string;
    }): Promise<HubAnswer>;
    routerLead(lead: Record<string, unknown>): Promise<HubAnswer>;
    callList(limit?: number): Promise<HubAnswer>;
    mlsListing(mlsNumber: string): Promise<HubAnswer>;
    mlsByAddress(a: {
        street: string;
        zip?: string;
        city?: string;
    }): Promise<HubAnswer>;
    mlsMine(): Promise<HubAnswer>;
    mlsExpired(q?: {
        days?: number;
        town?: string;
        min_price?: number;
        limit?: number;
    }): Promise<HubAnswer>;
    mlsClosed(q: {
        town: string;
        months?: number;
        limit?: number;
    }): Promise<HubAnswer>;
    rentcast(a: {
        product?: 'value' | 'property';
        street: string;
        city?: string;
        state?: string;
        zip: string;
    }): Promise<HubAnswer>;
    signinAllowed(): Promise<HubAnswer<{
        enabled: boolean;
        emails: string[];
    }>>;
}
export declare function createHubClient(o: HubClientOptions): HubClient;
