/** OpenAI's public Sign in with ChatGPT contract, including dynamic clients. */
import { createHash, createPublicKey, verify, type JsonWebKey } from 'crypto';
import { generateState, generateVerifier, computeChallenge } from '../pkce';
import { oauthRequest } from '../http';
import { abortable } from '../refreshLock';
import { refreshWithTokenEndpoint } from '../tokenEndpoint';
import { OAuthFlowError, type OAuthLoginContext, type OAuthProviderHandler, type OAuthTokenSet } from '../types';
import { parseOAuthErrorBody, expiryFromJwt } from '../utils';
import type { LocalModelInfo, ThinkingLevel } from '../../local/localTypes';
import { THINKING_LEVELS } from '../../local/localTypes';

export const OPENAI_CHATGPT_PROVIDER_ID = 'chatgpt-codex';
export const OPENAI_CHATGPT_STORAGE_KEY = 'openai-chatgpt';
export const OPENAI_CHATGPT_BASE_URL = 'https://api.openai.com/v1';
const ISSUER = 'https://auth.openai.com';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

export function chatGptStorageKey(tokens: OAuthTokenSet): string {
    if (!tokens.clientId || !tokens.subject) throw new OAuthFlowError('bad_response', 'Missing validated registration');
    return `${OPENAI_CHATGPT_STORAGE_KEY}.${createHash('sha256').update(JSON.stringify([tokens.clientId, tokens.subject])).digest('hex')}`;
}

type JsonObject = Record<string, unknown>;
interface ValidatedIdentity extends JsonObject { sub: string }
function asObject(value: unknown): JsonObject | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function jsonObject(body: string): JsonObject {
    try {
        const parsed = asObject(JSON.parse(body));
        if (parsed) return parsed;
    } catch { /* classified below */ }
    throw new OAuthFlowError('bad_response', 'Invalid OAuth JSON response');
}

function requireSuccess(status: number, body: string): void {
    if (status >= 200 && status < 300) return;
    const error = parseOAuthErrorBody(body);
    throw new OAuthFlowError(error?.error ?? `http_${status}`, error?.description ?? `OAuth HTTP ${status}`);
}

async function getJson(ctx: OAuthLoginContext, url: string): Promise<JsonObject> {
    const response = await oauthRequest(ctx, url, { headers: { accept: 'application/json' } });
    requireSuccess(response.status, response.body);
    return jsonObject(response.body);
}

async function metadata(ctx: OAuthLoginContext): Promise<JsonObject> {
    const doc = await getJson(ctx, `${ISSUER}/.well-known/openid-configuration`);
    if (doc.issuer !== ISSUER) throw new OAuthFlowError('bad_response', 'Unexpected OAuth issuer');
    return doc;
}

function issuerEndpoint(value: unknown): string {
    if (typeof value !== 'string') throw new OAuthFlowError('bad_response', 'Missing OpenID endpoint');
    const url = new URL(value);
    if (url.origin !== ISSUER || url.username || url.password) throw new OAuthFlowError('bad_response', 'Unexpected OpenID endpoint');
    return url.toString();
}

/** Validate identity before any claims are used to replace a saved account. */
export async function validateChatGptIdToken(ctx: OAuthLoginContext, token: string, clientId: string, nonce?: string): Promise<ValidatedIdentity> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new OAuthFlowError('invalid_id_token', 'Malformed ID token');
    const header = jsonObject(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const claims = jsonObject(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new OAuthFlowError('invalid_id_token', 'Unsupported ID token signature');
    const doc = await metadata(ctx);
    const jwks = await getJson(ctx, issuerEndpoint(doc.jwks_uri));
    const key = Array.isArray(jwks.keys) ? jwks.keys.map((candidate: unknown) => asObject(candidate))
        .find((k) => k && k.kid === header.kid && k.kty === 'RSA'
            && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256')) : undefined;
    if (!key) throw new OAuthFlowError('invalid_id_token', 'Invalid ID token signature');
    let validSignature = false;
    try {
        validSignature = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
            createPublicKey({ key: key as JsonWebKey, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    } catch {
        throw new OAuthFlowError('invalid_id_token', 'Invalid ID token signature');
    }
    if (!validSignature) {
        throw new OAuthFlowError('invalid_id_token', 'Invalid ID token signature');
    }
    const now = Date.now() / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== ISSUER || !audience.includes(clientId)
        || (audience.length > 1 && claims.azp !== clientId)
        || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now
        || (typeof claims.nbf === 'number' && claims.nbf > now)
        || typeof claims.sub !== 'string' || !claims.sub
        || (nonce !== undefined && claims.nonce !== nonce)) {
        throw new OAuthFlowError('invalid_id_token', 'Invalid ID token claims');
    }
    return { ...claims, sub: claims.sub };
}

export function buildChatGptAuthorizeUrl(input: { verifier: string; state: string; nonce: string; redirectUri: string; hostId: string; registration?: OAuthLoginContext['registration'] }): string {
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    const registration = input.registration;
    const params = {
        client_id: registration?.clientId ?? DYNAMIC_CLIENT,
        ext_agent_host_id: input.hostId,
        response_type: 'code', redirect_uri: input.redirectUri,
        scope: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`,
        resource: OPENAI_CHATGPT_BASE_URL,
        state: input.state, nonce: input.nonce,
        code_challenge_method: 'S256', code_challenge: computeChallenge(input.verifier),
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (!registration) url.searchParams.set('agent_name_hint', 'Xratu');
    if (registration?.idToken) url.searchParams.set('id_token_hint', registration.idToken);
    if (registration?.email) url.searchParams.set('login_hint', registration.email);
    return url.toString();
}

function tokenSet(json: JsonObject, clientId: string, claims?: ValidatedIdentity, previous?: OAuthTokenSet): OAuthTokenSet {
    if (typeof json.access_token !== 'string' || !json.access_token) throw new OAuthFlowError('bad_response', 'Missing access token');
    const seconds = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : 0;
    const subject = claims?.sub ?? previous?.subject;
    const email = typeof claims?.email === 'string' ? claims.email : previous?.email;
    return {
        accessToken: json.access_token,
        refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : previous?.refreshToken,
        expiresAt: seconds ? Date.now() + seconds * 1000 : expiryFromJwt(json.access_token) ?? 0,
        clientId, subject, email, accountId: subject,
        accountLabel: email,
        idToken: typeof json.id_token === 'string' ? json.id_token : previous?.idToken,
        scopes: typeof json.scope === 'string' ? json.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [],
        tokenType: typeof json.token_type === 'string' ? json.token_type : previous?.tokenType,
    };
}

async function login(ctx: OAuthLoginContext): Promise<OAuthTokenSet> {
    if (!ctx.authorize || !ctx.hostId) throw new OAuthFlowError('not_implemented', 'Browser authorization unavailable');
    const verifier = generateVerifier(), state = generateState(), nonce = generateState();
    const callback = await ctx.authorize({ expectedState: state, buildUrl: (redirectUri) => buildChatGptAuthorizeUrl({
        verifier, state, nonce, redirectUri, hostId: ctx.hostId!, registration: ctx.registration,
    }) });
    if (callback.state !== state) throw new OAuthFlowError('state_mismatch', 'OAuth state mismatch');
    const clientId = callback.clientId ?? ctx.registration?.clientId;
    if (!clientId || clientId === DYNAMIC_CLIENT || (ctx.registration && clientId !== ctx.registration.clientId)) {
        throw new OAuthFlowError('invalid_registration', 'Missing or mismatched issued client ID');
    }
    const response = await oauthRequest(ctx, TOKEN_URL, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
            code: callback.code, code_verifier: verifier, redirect_uri: callback.redirectUri, resource: OPENAI_CHATGPT_BASE_URL }).toString(),
    });
    requireSuccess(response.status, response.body);
    const json = jsonObject(response.body);
    if (typeof json.id_token !== 'string') throw new OAuthFlowError('invalid_id_token', 'Missing ID token');
    const claims = await validateChatGptIdToken(ctx, json.id_token, clientId, nonce);
    if (ctx.registration && claims.sub !== ctx.registration.subject) throw new OAuthFlowError('account_mismatch', 'Returning account identity changed');
    return tokenSet(json, clientId, claims);
}

export function parseChatGptModels(data: unknown): LocalModelInfo[] {
    const list = data && typeof data === 'object' ? (data as Record<string, unknown>).models : null;
    if (!Array.isArray(list)) throw new OAuthFlowError('bad_response', 'Missing ChatGPT model catalog');
    return list.map((m: unknown) => asObject(m)).filter((m): m is JsonObject & { slug: string } => !!m && m.visibility === 'list' && typeof m.slug === 'string' && !!m.slug).map((m) => {
        const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels
            .map((v: unknown) => asObject(v)?.effort).filter((v: unknown): v is ThinkingLevel => typeof v === 'string' && THINKING_LEVELS.includes(v as ThinkingLevel)) : [];
        const window = typeof m.context_window === 'number' && Number.isFinite(m.context_window) && m.context_window > 0 ? m.context_window : undefined;
        return {
            id: m.slug, displayName: typeof m.display_name === 'string' ? m.display_name : m.slug,
            ...(window ? { contextWindow: window, contextWindowReported: true } : {}),
            supportsTools: true,
            ...(Array.isArray(m.input_modalities) ? { supportsVision: m.input_modalities.includes('image') } : {}),
            ...(levels.length ? { supportsReasoning: true, reasoningLevels: levels } : {}),
        };
    });
}

export const openAiChatGptHandler: OAuthProviderHandler = {
    providerId: OPENAI_CHATGPT_PROVIDER_ID, storageKey: OPENAI_CHATGPT_STORAGE_KEY,
    canonicalBaseUrl: OPENAI_CHATGPT_BASE_URL, apiStyle: 'responses', subscription: true,
    label: 'ChatGPT', methods: ['browser'], login,
    async refresh(tokens, ctx) {
        if (!tokens.clientId || !tokens.subject) return { kind: 'reauth' };
        const result = await refreshWithTokenEndpoint({ tokenUrl: TOKEN_URL, clientId: tokens.clientId,
            tokens, fetch: ctx.fetch, signal: ctx.signal, extraParams: { resource: OPENAI_CHATGPT_BASE_URL },
            isPermanentFailure: (_status, body) => /refresh_token_(expired|reused|invalidated)/i.test(body),
            parseTokens: (json) => tokenSet(json, tokens.clientId!, undefined, tokens),
        });
        if (result.kind === 'refreshed' && result.tokens.idToken !== tokens.idToken && result.tokens.idToken) {
            const claims = await validateChatGptIdToken(ctx, result.tokens.idToken, tokens.clientId);
            if (claims.sub !== tokens.subject) throw new OAuthFlowError('account_mismatch', 'Refreshed identity changed');
        }
        return result;
    },
    async discoverModels(ctx, tokens) {
        if (!chatGptPlanEnabled(tokens)) throw new OAuthFlowError('plan_permission_missing', 'ChatGPT plan permission was not granted');
        const response = await oauthRequest(ctx, `${OPENAI_CHATGPT_BASE_URL}/models`, {
            headers: { accept: 'application/json', authorization: `Bearer ${tokens.accessToken}` },
        });
        requireSuccess(response.status, response.body);
        return { models: parseChatGptModels(jsonObject(response.body)) };
    },
    async revoke(tokens, ctx) {
        if (!tokens.refreshToken || !tokens.clientId) return;
        for (let attempt = 0; ; attempt++) {
            let transient = true;
            try {
                const doc = await metadata(ctx);
                const response = await oauthRequest(ctx, issuerEndpoint(doc.revocation_endpoint), {
                    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: 'refresh_token', client_id: tokens.clientId }).toString(),
                });
                transient = response.status >= 500;
                requireSuccess(response.status, response.body);
                return;
            } catch (error) {
                ctx.signal?.throwIfAborted();
                if (!transient || attempt >= 1) throw error;
                await abortable(new Promise<void>((resolve) => setTimeout(resolve, 250)), ctx.signal);
            }
        }
    },
};

export function chatGptPlanEnabled(tokens: OAuthTokenSet): boolean { return tokens.scopes?.includes(PLAN_SCOPE) === true; }
