/**
 * Generic RFC 6749 section 6 refresh against a token endpoint - the
 * four-way refresh outcome matrix, written once:
 *
 *   HTTP 200                      -> refreshed (new token set; the old refresh
 *                                    token is PRESERVED when the response
 *                                    omits one - RFC 6749 section 6 makes the
 *                                    replacement optional and some IdPs don't
 *                                    send it)
 *   invalid_grant & friends       -> reauth. PERMANENT: the credential is
 *                                    dead, the caller clears it and asks the
 *                                    user to sign in again. Never retried.
 *   transient (network throw,
 *   timeout, 5xx, malformed)
 *     + access token still valid  -> keep: serve the existing token, change
 *                                    nothing, try again next turn
 *     + access token expired      -> THROW. Credentials stay in storage, but
 *                                    this turn cannot proceed.
 *
 * The keep-vs-reauth distinction is the single most important behavior in the
 * whole module: returning `reauth` on a transient failure was observed wiping
 * stored credentials and "logging out every Cline process" on a network blip
 * (cline.ts:854-859). Throw keeps credentials; reauth kills them. When in
 * doubt, throw.
 */
import { isInvalidGrantError } from '../providerErrors';
import type { OAuthRefreshResult, OAuthTokenSet } from './types';
import { OAuthFlowError } from './types';
import { oauthRequest } from './http';
import { isTokenExpired, parseOAuthErrorBody } from './utils';

export interface TokenEndpointRefreshOptions {
    tokenUrl: string;
    clientId: string;
    tokens: OAuthTokenSet;
    fetch: typeof fetch;
    /** Extra form params (e.g. resource, audience) for IdPs that need them. */
    extraParams?: Record<string, string>;
    /** Request safety margin, independent of proactive refresh. Default 0. */
    skewMs?: number;
    /** Provider-specific PERMANENT-failure matcher, consulted alongside the
     *  shared invalid-grant classifier. Needed because ChatGPT reports a dead
     *  refresh token as `refresh_token_expired` / `_reused` / `_invalidated`
     *  rather than `invalid_grant` - without this hook those would be read as
     *  transient and the user would be stuck retrying a dead credential
     *  forever instead of being asked to sign in again. */
    isPermanentFailure?: (status: number, body: string) => boolean;
    /** Map the raw 200 JSON onto a token set. Default handles the RFC shape
     *  (access_token, refresh_token?, expires_in?, scope?). */
    parseTokens?: (json: Record<string, unknown>, previous: OAuthTokenSet) => OAuthTokenSet;
    signal?: AbortSignal;
}

/** Default RFC-shaped response mapping. expires_in -> absolute expiresAt;
 *  missing expiry -> 0 ("unknown - refresh on next use"); missing
 *  refresh_token -> the previous one is kept. */
export function defaultParseTokenResponse(
    json: Record<string, unknown>,
    previous: OAuthTokenSet,
): OAuthTokenSet {
    const accessToken = json.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
        throw new OAuthFlowError('bad_response', 'Token endpoint response missing access_token');
    }
    const expiresIn = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0
        ? json.expires_in
        : null;
    const scope = json.scope;
    return {
        accessToken,
        refreshToken: typeof json.refresh_token === 'string' && json.refresh_token
            ? json.refresh_token
            : previous.refreshToken,
        expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : 0,
        accountId: previous.accountId,
        scopes: typeof scope === 'string' && scope ? scope.split(' ') : previous.scopes,
        tokenType: typeof json.token_type === 'string' ? json.token_type : previous.tokenType,
    };
}

export async function refreshWithTokenEndpoint(opts: TokenEndpointRefreshOptions): Promise<OAuthRefreshResult> {
    const { tokens } = opts;
    if (!tokens.refreshToken) {
        // Single-shot credential: no refresh token was ever issued. A 401 must
        // go straight to re-auth - attempting a refresh is nonsense.
        return { kind: 'reauth' };
    }

    const parse = opts.parseTokens ?? defaultParseTokenResponse;
    const skewMs = opts.skewMs ?? 0;

    let status: number;
    let body: string;
    try {
        const res = await oauthRequest({ fetch: opts.fetch, signal: opts.signal }, opts.tokenUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'application/json',
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: tokens.refreshToken,
                client_id: opts.clientId,
                ...opts.extraParams,
            }).toString(),
        });
        status = res.status;
        body = res.body;
    } catch (networkError) {
        opts.signal?.throwIfAborted();
        // Transport failure. Still-valid token: keep serving it silently.
        // Expired token: this turn is dead, but the CREDENTIALS are not -
        // throwing (not `reauth`) is what keeps the user logged in across a
        // network blip.
        if (!isTokenExpired(tokens, skewMs)) return { kind: 'keep', tokens };
        throw networkError;
    }

    if (status === 200) {
        let json: Record<string, unknown>;
        try {
            json = JSON.parse(body) as Record<string, unknown>;
        } catch {
            if (!isTokenExpired(tokens, skewMs)) return { kind: 'keep', tokens };
            throw new OAuthFlowError('bad_response', 'Token endpoint 200 response was not JSON');
        }
        try {
            return { kind: 'refreshed', tokens: parse(json, tokens) };
        } catch (error) {
            if (!isTokenExpired(tokens, skewMs)) return { kind: 'keep', tokens };
            throw error;
        }
    }

    if (isInvalidGrantError(status, body) || opts.isPermanentFailure?.(status, body)) {
        return { kind: 'reauth' };
    }

    // Non-fatal server-side failure (5xx, unknown 4xx): same keep/throw
    // split as the transport path.
    if (!isTokenExpired(tokens, skewMs)) return { kind: 'keep', tokens };
    const parsed = parseOAuthErrorBody(body);
    throw new OAuthFlowError(
        parsed?.error ?? `http_${status}`,
        parsed?.description ?? `Token refresh failed (HTTP ${status})`,
    );
}
