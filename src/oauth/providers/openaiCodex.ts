/**
 * ChatGPT (Codex subscription) OAuth provider.
 *
 * Protocol facts, ported from the two implementations that actually ship it
 * (Codex CLI `codex-rs/login/` and Cline `auth/codex.ts`):
 *
 *  - Authorize: https://auth.openai.com/oauth/authorize, client id
 *    `app_EMoamEEZ73f0CkXaXp7hrann` (the PUBLIC Codex client id - the same
 *    literal Codex, Cline and Roo embed; there is no per-app registration),
 *    redirect `http://localhost:1455/auth/callback`, `codex_cli_simplified_flow`
 *    and `id_token_add_organizations` both true, plus an `originator` that
 *    identifies the client (ours is `xratu`).
 *
 *  - The registered redirect URI names `localhost`, but the server binds
 *    127.0.0.1 - so the redirect_uri in the authorize request keeps the
 *    registered `localhost` spelling even when the flow actually lands on the
 *    fallback port.
 *
 *  - ChatGPT APPENDS `.onboarding_entrypoint=life_sciences` to the returned
 *    state (observed in the wild; Codex strips it before comparing, Cline
 *    accepts a hash variant). Our callback server compares the state exactly,
 *    so the matcher below normalizes that suffix - without it a perfectly
 *    good sign-in fails with "state mismatch".
 *
 *  - Token exchange is form-encoded and MUST NOT include `state` (OpenAI
 *    rejects the request when it is present - noted verbatim in Cline).
 *
 *  - API traffic goes to https://chatgpt.com/backend-api/codex over the
 *    RESPONSES API, with the account id routed as a header. `originator` is
 *    sent on API requests too.
 *
 *  - The refresh token ROTATES and OpenAI reports permanent rejection with its
 *    own codes (`refresh_token_expired` / `_reused` / `_invalidated`) - all
 *    re-auth-required, all distinct from `invalid_grant`.
 *
 *  - Sign-out is RFC 7009 revocation, best-effort: local credentials are
 *    cleared even when the revoke call fails.
 */
import { OAuthFlowError } from '../types';
import type { OAuthLoginContext, OAuthProviderHandler, OAuthRefreshResult, OAuthTokenSet } from '../types';
import { refreshWithTokenEndpoint } from '../tokenEndpoint';
import { pollUntilAuthorized, positiveSeconds } from '../deviceFlow';
import { computeChallenge, generateState, generateVerifier } from '../pkce';
import { parseOAuthErrorBody, resolveAuthorizationCodeInput } from '../utils';

export const OPENAI_CODEX_PROVIDER_ID = 'chatgpt-codex';
export const OPENAI_CODEX_STORAGE_KEY = 'openai-codex';
export const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

const ISSUER = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const REVOKE_URL = `${ISSUER}/oauth/revoke`;
const DEVICE_USERCODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
/** Constructed locally, NOT taken from the response - the ChatGPT device
 *  endpoints do not return a verification URL (Codex CLI does the same). */
const DEVICE_VERIFICATION_URL = `${ISSUER}/codex/device`;
/** The device flow's final code exchange uses this redirect, not a loopback
 *  one - there is no local server in the device flow. */
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;

const SCOPE = 'openid profile email offline_access';
const ORIGINATOR = 'xratu';
const DEFAULT_PORT = 1455;
const FALLBACK_PORT = 1457;
const CALLBACK_PATH = '/auth/callback';
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 30_000;
const DEVICE_MAX_WAIT_S = 15 * 60;
const DEVICE_DEFAULT_INTERVAL_S = 5;
/** Proactive-refresh window: Codex refreshes 5 minutes early so a long turn
 *  never carries a token that expires mid-flight. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** ChatGPT appends this to the state it returns (Codex CLI strips it). */
const STATE_SUFFIX = '.onboarding_entrypoint=life_sciences';
const AUTH_CLAIMS = 'https://api.openai.com/auth';

/** ChatGPT returns `error_description` for an org without the Codex
 *  entitlement; it is the one rejection worth explaining in plain language. */
function isMissingEntitlement(code: string, description: string): boolean {
    return code === 'access_denied' && /missing_codex_entitlement/i.test(description);
}

export function openAiCodexStateMatches(received: string, expected: string): boolean {
    return received === expected || received === expected + STATE_SUFFIX;
}

/** Claims read from the id/access token JWT. Signature is deliberately NOT
 *  verified (see utils.expiryFromJwt): these are routing hints for a bearer we
 *  already hold, not trust decisions. */
function authClaims(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
        if (!payload || typeof payload !== 'object') return null;
        return payload as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** Plan + email for display, read off the id token. Falls back to nothing
 *  rather than guessing: an account we cannot name is shown by its id. */
export function chatGptAccountLabel(idToken?: string): string | undefined {
    if (!idToken) return undefined;
    const claims = authClaims(idToken);
    if (!claims) return undefined;
    const auth = claims[AUTH_CLAIMS];
    const plan = auth && typeof auth === 'object'
        ? (auth as Record<string, unknown>).chatgpt_plan_type
        : undefined;
    const profile = claims['https://api.openai.com/profile'];
    const email = (typeof claims.email === 'string' && claims.email)
        || (profile && typeof profile === 'object' && typeof (profile as Record<string, unknown>).email === 'string'
            ? (profile as Record<string, unknown>).email as string
            : undefined);
    const parts = [typeof plan === 'string' && plan ? plan : '', email ?? ''].filter(Boolean);
    return parts.length ? parts.join(' - ') : undefined;
}

/** Account id resolution order, following the two references: the namespaced
 *  auth claim first (codex-rs), then `organizations[0].id`, then a root-level
 *  claim (Cline). id_token is preferred over access_token because it carries
 *  the organizations block. */
export function extractChatGptAccountId(idToken?: string, accessToken?: string): string | undefined {
    for (const token of [idToken, accessToken]) {
        if (!token) continue;
        const claims = authClaims(token);
        if (!claims) continue;
        const namespaced = claims[AUTH_CLAIMS];
        if (namespaced && typeof namespaced === 'object') {
            const id = (namespaced as Record<string, unknown>).chatgpt_account_id;
            if (typeof id === 'string' && id) return id;
        }
        const orgs = claims.organizations;
        if (Array.isArray(orgs) && orgs.length) {
            const first = orgs[0] as Record<string, unknown> | undefined;
            if (first && typeof first.id === 'string' && first.id) return first.id;
        }
        const root = claims.chatgpt_account_id;
        if (typeof root === 'string' && root) return root;
    }
    return undefined;
}

export interface AuthorizeUrlInput {
    verifier: string;
    state: string;
    redirectUri: string;
}

/** The authorize URL. Parameter set matches Codex CLI / Cline; the `resource`
 *  parameter stays absent (that slot belongs to the gateway flow). */
export function buildChatGptAuthorizeUrl(input: AuthorizeUrlInput): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('code_challenge', computeChallenge(input.verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('originator', ORIGINATOR);
    return url.toString();
}

async function postForm(
    ctx: OAuthLoginContext,
    url: string,
    params: Record<string, string>,
): Promise<{ status: number; body: string }> {
    const res = await ctx.fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
        },
        body: new URLSearchParams(params).toString(),
        signal: ctx.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return { status: res.status, body: await res.text() };
}

async function postJson(
    ctx: OAuthLoginContext,
    url: string,
    payload: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
    const res = await ctx.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: ctx.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return { status: res.status, body: await res.text() };
}

/** Map a token-endpoint 200 onto a token set. Expiry comes from `expires_in`
 *  when present; ChatGPT's access token is also a JWT, so an omitted
 *  expires_in still yields a usable expiry through the shared derivation. The
 *  id_token is NOT stored (it is an identity document, not a credential) - it
 *  is read here for the account id only. */
function tokenSetFromResponse(json: Record<string, unknown>, previous?: OAuthTokenSet): OAuthTokenSet {
    const accessToken = json.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
        throw new OAuthFlowError('bad_response', 'ChatGPT token response missing access_token');
    }
    const idToken = typeof json.id_token === 'string' ? json.id_token : undefined;
    const expiresIn = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0
        ? json.expires_in
        : null;
    const scope = typeof json.scope === 'string' ? json.scope : undefined;
    return {
        accessToken,
        refreshToken: typeof json.refresh_token === 'string' && json.refresh_token
            ? json.refresh_token
            : previous?.refreshToken,
        expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : 0,
        accountId: extractChatGptAccountId(idToken, accessToken) ?? previous?.accountId,
        accountLabel: chatGptAccountLabel(idToken) ?? previous?.accountLabel,
        scopes: scope ? scope.split(' ') : previous?.scopes,
        tokenType: typeof json.token_type === 'string' ? json.token_type : previous?.tokenType,
    };
}

/** Exchange an authorization code. `state` is deliberately NOT sent - OpenAI
 *  rejects a token request that carries it. */
export async function exchangeChatGptCode(
    ctx: OAuthLoginContext,
    input: { code: string; verifier: string; redirectUri: string },
): Promise<OAuthTokenSet> {
    const { status, body } = await postForm(ctx, TOKEN_URL, {
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
    });
    if (status !== 200) {
        const parsed = parseOAuthErrorBody(body);
        const code = parsed?.error ?? `http_${status}`;
        const description = parsed?.description ?? `ChatGPT token exchange failed (HTTP ${status})`;
        if (isMissingEntitlement(code, description)) {
            throw new OAuthFlowError('missing_entitlement', description);
        }
        throw new OAuthFlowError(code, description);
    }
    let json: unknown;
    try {
        json = JSON.parse(body);
    } catch {
        throw new OAuthFlowError('bad_response', 'ChatGPT token response was not JSON');
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new OAuthFlowError('bad_response', 'ChatGPT token response was not a JSON object');
    }
    return tokenSetFromResponse(json as Record<string, unknown>);
}

export interface ChatGptDeviceSession {
    deviceAuthId: string;
    userCode: string;
    intervalS: number;
}

/** Step 1 of the ChatGPT device flow: request a user code. JSON body, and the
 *  response is JSON even on failure. A 404 means device login is not enabled
 *  for this deployment - surfaced with its own message so the user can fall
 *  back to the browser flow instead of seeing a bare HTTP code. */
export async function requestChatGptDeviceCode(ctx: OAuthLoginContext): Promise<ChatGptDeviceSession> {
    const { status, body } = await postJson(ctx, DEVICE_USERCODE_URL, { client_id: CLIENT_ID });
    if (status === 404) {
        throw new OAuthFlowError('device_unavailable', 'Device-code sign-in is not enabled for this account; use the browser sign-in.');
    }
    if (status !== 200) {
        const parsed = parseOAuthErrorBody(body);
        throw new OAuthFlowError(
            parsed?.error ?? `http_${status}`,
            parsed?.description ?? `Device sign-in request failed (HTTP ${status})`,
        );
    }
    let json: unknown;
    try {
        json = JSON.parse(body);
    } catch {
        throw new OAuthFlowError('bad_response', 'Device sign-in response was not JSON');
    }
    if (!json || typeof json !== 'object') {
        throw new OAuthFlowError('bad_response', 'Device sign-in response was not a JSON object');
    }
    const rec = json as Record<string, unknown>;
    const deviceAuthId = rec.device_auth_id;
    const userCode = rec.user_code ?? rec.usercode;
    if (typeof deviceAuthId !== 'string' || !deviceAuthId || typeof userCode !== 'string' || !userCode) {
        throw new OAuthFlowError('bad_response', 'Device sign-in response missing device_auth_id/user_code');
    }
    return {
        deviceAuthId,
        userCode,
        intervalS: positiveSeconds(rec.interval, DEVICE_DEFAULT_INTERVAL_S),
    };
}

export interface ChatGptDeviceGrant {
    authorizationCode: string;
    codeVerifier: string;
}

/** Step 2: poll until the user finishes in the browser. The ChatGPT variant
 *  of "keep waiting" is an HTTP 403/404 with an empty body - there is no
 *  `authorization_pending` - and a 2xx hands back an authorization code plus
 *  the PKCE verifier the SERVER generated for it. */
export async function pollChatGptDeviceGrant(
    ctx: OAuthLoginContext,
    session: ChatGptDeviceSession,
): Promise<ChatGptDeviceGrant> {
    return pollUntilAuthorized<ChatGptDeviceGrant>({
        intervalS: session.intervalS,
        expiresIn: DEVICE_MAX_WAIT_S,
        signal: ctx.signal,
        attempt: async () => {
            const { status, body } = await postJson(ctx, DEVICE_TOKEN_URL, {
                device_auth_id: session.deviceAuthId,
                user_code: session.userCode,
            });
            if (status === 403 || status === 404) return { done: false };
            if (status < 200 || status >= 300) {
                const parsed = parseOAuthErrorBody(body);
                throw new OAuthFlowError(
                    parsed?.error ?? `http_${status}`,
                    parsed?.description ?? `Device sign-in failed (HTTP ${status})`,
                );
            }
            let json: unknown;
            try {
                json = JSON.parse(body);
            } catch {
                throw new OAuthFlowError('bad_response', 'Device sign-in response was not JSON');
            }
            if (!json || typeof json !== 'object') {
                throw new OAuthFlowError('bad_response', 'Device sign-in response was not a JSON object');
            }
            const rec = json as Record<string, unknown>;
            const authorizationCode = rec.authorization_code;
            const codeVerifier = rec.code_verifier;
            if (typeof authorizationCode !== 'string' || !authorizationCode
                || typeof codeVerifier !== 'string' || !codeVerifier) {
                throw new OAuthFlowError('bad_response', 'Device sign-in response missing authorization_code/code_verifier');
            }
            return { done: true, value: { authorizationCode, codeVerifier } };
        },
    });
}

/** Step 3: the device grant's final exchange, with the SERVER-returned
 *  verifier and the device redirect URI (there is no loopback server here). */
export async function exchangeChatGptDeviceGrant(
    ctx: OAuthLoginContext,
    grant: ChatGptDeviceGrant,
): Promise<OAuthTokenSet> {
    return exchangeChatGptCode(ctx, {
        code: grant.authorizationCode,
        verifier: grant.codeVerifier,
        redirectUri: DEVICE_REDIRECT_URI,
    });
}

/** RFC 7009 revocation, best-effort. Callers clear local credentials even when
 *  this fails - a revoke endpoint outage must not strand the user's session. */
export async function revokeChatGptTokens(ctx: OAuthLoginContext, tokens: OAuthTokenSet): Promise<void> {
    const token = tokens.refreshToken || tokens.accessToken;
    if (!token) return;
    try {
        await postJson(ctx, REVOKE_URL, {
            token,
            token_type_hint: tokens.refreshToken ? 'refresh_token' : 'access_token',
            client_id: CLIENT_ID,
        });
    } catch {
        // Best effort by design - see the note above.
    }
}

/** The browser flow needs these handed to the callback server. Exported so the
 *  wiring layer (which owns the server lifecycle) does not re-derive them. */
export function chatGptLoopbackConfig(): { candidatePorts: number[]; callbackPath: string; timeoutMs: number } {
    return { candidatePorts: [DEFAULT_PORT, FALLBACK_PORT], callbackPath: CALLBACK_PATH, timeoutMs: FLOW_TIMEOUT_MS };
}

export function buildChatGptPkce(): { verifier: string; state: string; authorizeUrl: string } {
    const verifier = generateVerifier();
    const state = generateState();
    return {
        verifier,
        state,
        authorizeUrl: buildChatGptAuthorizeUrl({
            verifier,
            state,
            redirectUri: `http://localhost:${DEFAULT_PORT}${CALLBACK_PATH}`,
        }),
    };
}

export function normalizeChatGptManualCode(input: string): string {
    return resolveAuthorizationCodeInput(input) ?? '';
}

export const openAiCodexHandler: OAuthProviderHandler = {
    providerId: OPENAI_CODEX_PROVIDER_ID,
    storageKey: OPENAI_CODEX_STORAGE_KEY,
    canonicalBaseUrl: OPENAI_CODEX_BASE_URL,
    apiStyle: 'responses',

    headers(tokens) {
        // ChatGPT routes by account; the originator tells the backend which
        // client family is calling. Codex sends the exact casing below.
        const headers: Record<string, string> = { originator: ORIGINATOR };
        if (tokens.accountId) headers['ChatGPT-Account-Id'] = tokens.accountId;
        return headers;
    },

    async login(_ctx: OAuthLoginContext): Promise<OAuthTokenSet> {
        // The wiring layer drives the transport (loopback server, browser
        // launch, device code UI, manual paste) and hands tokens in; login()
        // exists for the contract and for providers whose flow is
        // self-contained.
        throw new OAuthFlowError('not_implemented', 'ChatGPT sign-in is driven by the host wiring layer');
    },

    async revoke(tokens: OAuthTokenSet, ctx: OAuthLoginContext): Promise<void> {
        await revokeChatGptTokens(ctx, tokens);
    },

    async refresh(tokens: OAuthTokenSet, ctx: OAuthLoginContext): Promise<OAuthRefreshResult> {
        if (!tokens.refreshToken) return { kind: 'reauth' };
        // ChatGPT names its permanent failures (`refresh_token_expired`,
        // `_reused`, `_invalidated`) instead of the RFC's `invalid_grant`, so
        // the shared classifier alone would read a dead token as transient -
        // the user would be stuck retrying it instead of being asked to sign
        // in again.
        return refreshWithTokenEndpoint({
            tokenUrl: TOKEN_URL,
            clientId: CLIENT_ID,
            tokens,
            fetch: ctx.fetch,
            skewMs: REFRESH_SKEW_MS,
            signal: ctx.signal,
            parseTokens: (json, previous) => tokenSetFromResponse(json, previous),
            isPermanentFailure: isPermanentChatGptRefreshFailure,
        });
    },
};

/** Permanent-refresh matcher: the three ChatGPT spellings, matched on the
 *  PARSED error code (never a raw substring - an injected proxy page must not
 *  be able to forge a logout). */
export function isPermanentChatGptRefreshFailure(status: number, body: string): boolean {
    if (status !== 400 && status !== 401 && status !== 403) return false;
    const code = parseOAuthErrorBody(body)?.error;
    if (!code) return false;
    return /^refresh_token_(expired|reused|invalidated)$/i.test(code);
}

export { DEVICE_VERIFICATION_URL as OPENAI_CODEX_DEVICE_VERIFICATION_URL };
export { DEFAULT_PORT as OPENAI_CODEX_PORT, FALLBACK_PORT as OPENAI_CODEX_FALLBACK_PORT, CALLBACK_PATH as OPENAI_CODEX_CALLBACK_PATH, ORIGINATOR as OPENAI_CODEX_ORIGINATOR, SCOPE as OPENAI_CODEX_SCOPE };