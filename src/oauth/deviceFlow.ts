/**
 * RFC 8628 device authorization grant - the shared engine.
 *
 * Device code is the DEFAULT transport recommendation for Xratu: it is the
 * only option that is structurally correct in remote/headless VS Code (SSH,
 * WSL, devcontainer, Codespaces) and the only one likely to work where the
 * IdP's callback reachability is unreliable. goose's lesson is that the
 * engine is easy to share and the per-provider copies are the mistake - so
 * this is written once, here.
 *
 * Rules encoded (each one is a real observed bug):
 *
 *  - The poll interval is HARDENED against a misbehaving endpoint:
 *    NaN/"NaN"/null/-5 all pass a naive `?? default` (typeof NaN ===
 *    'number'), reach setTimeout(_, NaN) as 0, and busy-loop until the
 *    deadline (opencode's xai.ts hardening, ported).
 *
 *  - `slow_down` extends the interval by 5s per RFC 8628 section 3.5 - it is
 *    not an error and must not terminate the flow.
 *
 *  - There is a hard deadline from expires_in. A server that keeps answering
 *    authorization_pending forever must not pin a flow open.
 *
 *  - `error` responses use the RFC's own codes, surfaced via OAuthFlowError
 *    so the UI maps them to i18n keys rather than matching English prose.
 */
import { OAuthFlowError } from './types';
import { parseOAuthErrorBody } from './utils';

export interface DeviceAuthorization {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    interval: number; // seconds, already hardened
    expiresIn: number; // seconds
}

const DEFAULT_INTERVAL_S = 5;
const DEFAULT_EXPIRES_S = 15 * 60;
const SLOW_DOWN_INCREMENT_S = 5;
/** Sanity ceiling for a server-supplied interval - anything past this is a
 *  misbehaving endpoint, clamp rather than honor. */
const MAX_INTERVAL_S = 60;

/** Coerce a server-supplied seconds value to a sane positive number.
 *  Exported for tests - this is the exact function that kills the NaN
 *  busy-loop. `cap` differs per field: a poll interval past a minute is a
 *  misbehaving endpoint, but expires_in legitimately runs to 15 minutes. */
export function positiveSeconds(value: unknown, fallback: number, cap: number = MAX_INTERVAL_S): number {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, cap);
}

function formBody(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
}

async function postForm(
    fetchImpl: typeof fetch,
    url: string,
    params: Record<string, string>,
    signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
    const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
        },
        body: formBody(params),
        signal: signal ?? AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.text() };
}

/** Step 1: ask the device authorization endpoint for a user code. */
export async function requestDeviceAuthorization(opts: {
    url: string;
    clientId: string;
    scope?: string;
    extraParams?: Record<string, string>;
    fetch: typeof fetch;
    signal?: AbortSignal;
}): Promise<DeviceAuthorization> {
    const params: Record<string, string> = { client_id: opts.clientId, ...opts.extraParams };
    if (opts.scope) params.scope = opts.scope;

    const { status, body } = await postForm(opts.fetch, opts.url, params, opts.signal);
    if (status !== 200) {
        const parsed = parseOAuthErrorBody(body);
        throw new OAuthFlowError(
            parsed?.error ?? `http_${status}`,
            parsed?.description ?? `Device authorization request failed (HTTP ${status})`,
        );
    }

    let json: Record<string, unknown>;
    try {
        json = JSON.parse(body) as Record<string, unknown>;
    } catch {
        throw new OAuthFlowError('bad_response', 'Device authorization response was not JSON');
    }

    const deviceCode = json.device_code;
    const userCode = json.user_code;
    const verificationUri = json.verification_uri ?? json.verification_url;
    if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
        throw new OAuthFlowError('bad_response', 'Device authorization response missing required fields');
    }
    const verificationUriComplete = json.verification_uri_complete;
    return {
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete: typeof verificationUriComplete === 'string' ? verificationUriComplete : undefined,
        interval: positiveSeconds(json.interval, DEFAULT_INTERVAL_S),
        expiresIn: positiveSeconds(json.expires_in, DEFAULT_EXPIRES_S, DEFAULT_EXPIRES_S),
    };
}

/** Step 2: poll the token endpoint until the user completes authorization,
 *  the code expires, or the caller cancels. Resolves with the raw token
 *  response JSON - mapping it onto an OAuthTokenSet is the provider's job
 *  (expiry derivation differs per IdP). */
export async function pollDeviceToken(opts: {
    url: string;
    clientId: string;
    deviceCode: string;
    interval: number; // seconds
    expiresIn: number; // seconds
    fetch: typeof fetch;
    signal?: AbortSignal;
    extraParams?: Record<string, string>;
    /** Injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    nowMs?: () => number;
}): Promise<Record<string, unknown>> {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = opts.nowMs ?? (() => Date.now());
    let intervalS = positiveSeconds(opts.interval, DEFAULT_INTERVAL_S);
    const deadline = now() + positiveSeconds(opts.expiresIn, DEFAULT_EXPIRES_S, DEFAULT_EXPIRES_S) * 1000;

    for (;;) {
        if (opts.signal?.aborted) {
            throw new OAuthFlowError('cancelled', 'Device authorization polling cancelled');
        }
        await sleep(intervalS * 1000);
        if (now() >= deadline) {
            throw new OAuthFlowError('expired_token', 'Device code expired before authorization completed');
        }

        const { status, body } = await postForm(opts.fetch, opts.url, {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: opts.deviceCode,
            client_id: opts.clientId,
            ...opts.extraParams,
        }, opts.signal);

        if (status === 200) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(body);
            } catch {
                throw new OAuthFlowError('bad_response', 'Device token response was not JSON');
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new OAuthFlowError('bad_response', 'Device token response was not a JSON object');
            }
            return parsed as Record<string, unknown>;
        }

        const parsed = parseOAuthErrorBody(body);
        const code = parsed?.error ?? '';
        if (code === 'authorization_pending') continue;
        if (code === 'slow_down') {
            intervalS += SLOW_DOWN_INCREMENT_S;
            continue;
        }
        throw new OAuthFlowError(
            code || `http_${status}`,
            parsed?.description ?? `Device token poll failed (HTTP ${status})`,
        );
    }
}
