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
/** 0.5.2: ask the hub's dry run instead (hub flag lofty_dry_run_enabled): nothing is written to Lofty or the hub. */
export interface HubDryRun {
    dryRun?: boolean;
}
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
    loftyLead(lead: Record<string, unknown>, opts?: HubDryRun): Promise<HubAnswer>;
    loftyNote(note: {
        lead_id: string;
        content: string;
        idempotency_key?: string;
    }, opts?: HubDryRun): Promise<HubAnswer>;
    loftyOptOut(o: {
        kind: 'email' | 'do_not_contact';
        lead_id?: string;
        email?: string;
        phone?: string;
        reason?: string;
        note?: string;
    }, opts?: HubDryRun): Promise<HubAnswer>;
    loftyTask(t: {
        lead_id: string;
        content: string;
        shape?: 'v2' | 'v1';
        due_at?: string;
        due_in_minutes?: number;
        due_date?: string;
        push_reminder?: boolean;
    }, opts?: HubDryRun): Promise<HubAnswer>;
    loftyFlags(f: {
        lead_id: string;
        cannot_text?: true;
        cannot_call?: true;
    }, opts?: HubDryRun): Promise<HubAnswer>;
    loftyStage(s: {
        lead_id?: string;
        email?: string;
        phone?: string;
        stage: string;
        idempotency_key?: string;
    }, opts?: HubDryRun): Promise<HubAnswer>;
    loftyEmailAdd(e: {
        lead_id: string;
        email: string;
    }, opts?: HubDryRun): Promise<HubAnswer>;
    loftyFillName(n: {
        lead_id: string;
        first_name: string;
        last_name?: string;
        fill_last_name?: boolean;
    }, opts?: HubDryRun): Promise<HubAnswer>;
    loftyRead(r: Record<string, unknown> & {
        resource: 'leads' | 'lead' | 'lead_activities' | 'communication' | 'transactions' | 'listings' | 'listing_search' | 'me';
    }): Promise<HubAnswer>;
    loftyWebhooks(w: {
        action: 'list' | 'register' | 'delete';
        list_id?: number;
        callback_url?: string;
        limit?: number;
        subscribe_id?: string | number;
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
        product?: 'value' | 'property' | 'rent' | 'market';
        street?: string;
        city?: string;
        state?: string;
        zip?: string;
        details?: {
            property_type?: string;
            bedrooms?: number;
            bathrooms?: number;
            square_footage?: number;
            comp_count?: number;
        };
    }, opts?: {
        cacheOnly?: boolean;
    }): Promise<HubAnswer>;
    signinAllowed(): Promise<HubAnswer<{
        enabled: boolean;
        emails: string[];
    }>>;
}
export declare function createHubClient(o: HubClientOptions): HubClient;
