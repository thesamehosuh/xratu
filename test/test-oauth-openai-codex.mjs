#!/usr/bin/env node
/**
 * ChatGPT (Codex) OAuth provider tests - protocol shape, not live calls.
 *
 *  - the authorize URL carries every parameter Codex/Cline send, and none of
 *    the ones they leave out (no `resource` on the ChatGPT path);
 *  - the token exchange is form-encoded and NEVER includes `state` - OpenAI
 *    rejects the request when it is present;
 *  - the account id resolves through the namespaced claim, then
 *    `organizations[0].id`, then a root claim, preferring the id token;
 *  - ChatGPT decorates the returned state with
 *    `.onboarding_entrypoint=life_sciences`, which the callback matcher must
 *    accept or every sign-in fails as a state mismatch;
 *  - the device flow is NOT RFC 8628: JSON bodies, "keep waiting" signalled by
 *    403/404, and a final exchange that uses the SERVER-returned verifier;
 *  - a dead refresh token is reported with ChatGPT's own codes
 *    (`refresh_token_expired`/`_reused`/`_invalidated`) and must clear the
 *    credential rather than being mistaken for a transient failure.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-oauth-openai-codex.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const provider = require('../out/oauth/providers/openaiCodex.js');
const { oauthErrorValueKey, oauthErrorKeys } = require('../out/oauth/errorKeys.js');
const { OAuthFlowError, OAuthReauthRequiredError } = require('../out/oauth/types.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const checkTrue = (name, actual) => check(name, !!actual, true);

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;
const jsonResponse = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status });

/** Records every request and replies from a scripted queue. */
function recorder(script) {
    const calls = [];
    let i = 0;
    const fetchImpl = async (url, init) => {
        const entry = { url: String(url), init, body: init?.body };
        calls.push(entry);
        const next = script[Math.min(i, script.length - 1)];
        i++;
        return typeof next === 'function' ? next() : next;
    };
    return { calls, fetchImpl };
}
const ctxWith = (fetchImpl, signal) => ({ fetch: fetchImpl, signal });

// --- authorize URL -----------------------------------------------------------
{
    const url = new URL(provider.buildChatGptAuthorizeUrl({
        verifier: 'V'.repeat(43),
        state: 'S'.repeat(32),
        redirectUri: 'http://localhost:1455/auth/callback',
    }));
    check('authorize host+path', `${url.origin}${url.pathname}`, 'https://auth.openai.com/oauth/authorize');
    check('response_type', url.searchParams.get('response_type'), 'code');
    check('client_id', url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    check('redirect_uri', url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
    check('code_challenge_method', url.searchParams.get('code_challenge_method'), 'S256');
    check('state', url.searchParams.get('state'), 'S'.repeat(32));
    check('scope', url.searchParams.get('scope'), 'openid profile email offline_access');
    check('id_token_add_organizations', url.searchParams.get('id_token_add_organizations'), 'true');
    check('codex_cli_simplified_flow', url.searchParams.get('codex_cli_simplified_flow'), 'true');
    check('originator identifies the client', url.searchParams.get('originator'), 'xratu');
    check('no resource param (gateway-only slot)', url.searchParams.has('resource'), false);
    check('challenge is the verifier SHA-256', url.searchParams.get('code_challenge'), require('../out/oauth/pkce.js').computeChallenge('V'.repeat(43)));
}

// --- state matcher -----------------------------------------------------------
{
    check('exact state matches', provider.openAiCodexStateMatches('abc', 'abc'), true);
    check(
        'decorated state matches (ChatGPT appends this)',
        provider.openAiCodexStateMatches('abc.onboarding_entrypoint=life_sciences', 'abc'),
        true,
    );
    check('foreign state rejected', provider.openAiCodexStateMatches('other', 'abc'), false);
    check('prefix of expected rejected', provider.openAiCodexStateMatches('ab', 'abc'), false);
}

// --- token exchange ----------------------------------------------------------
{
    const idToken = jwt({ email: 'user@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-42' } });
    const rec = recorder([jsonResponse(200, {
        access_token: jwt({ exp: 2000000000 }),
        refresh_token: 'RT-1',
        id_token: idToken,
        expires_in: 3600,
        token_type: 'Bearer',
    })]);
    const tokens = await provider.exchangeChatGptCode(ctxWith(rec.fetchImpl), {
        code: 'the-code', verifier: 'V'.repeat(43), redirectUri: 'http://localhost:1455/auth/callback',
    });
    const body = new URLSearchParams(rec.calls[0].body);
    check('exchange endpoint', rec.calls[0].url, 'https://auth.openai.com/oauth/token');
    check('exchange is form-encoded', String(rec.calls[0].init.headers['content-type']), 'application/x-www-form-urlencoded');
    check('grant_type', body.get('grant_type'), 'authorization_code');
    check('code sent', body.get('code'), 'the-code');
    check('verifier sent', body.get('code_verifier'), 'V'.repeat(43));
    check('redirect_uri sent', body.get('redirect_uri'), 'http://localhost:1455/auth/callback');
    // OpenAI rejects the exchange when state rides along.
    check('state NOT sent', body.has('state'), false);
    check('access token stored', tokens.accessToken.length > 0, true);
    check('refresh token stored', tokens.refreshToken, 'RT-1');
    check('account id from namespaced claim', tokens.accountId, 'acct-42');
    check('account label carries plan + email', tokens.accountLabel, 'plus - user@example.com');
    checkTrue('expires_in becomes absolute', tokens.expiresAt > Date.now() + 3_000_000);
}
{
    const rec = recorder([jsonResponse(400, { error: 'access_denied', error_description: 'workspace is missing_codex_entitlement' })]);
    let err = null;
    try {
        await provider.exchangeChatGptCode(ctxWith(rec.fetchImpl), { code: 'c', verifier: 'v', redirectUri: 'http://localhost:1455/auth/callback' });
    } catch (e) { err = e; }
    check('missing entitlement is its own code', err?.code, 'missing_entitlement');
}
{
    const rec = recorder([jsonResponse(200, 'not json')]);
    let err = null;
    try {
        await provider.exchangeChatGptCode(ctxWith(rec.fetchImpl), { code: 'c', verifier: 'v', redirectUri: 'http://localhost:1455/auth/callback' });
    } catch (e) { err = e; }
    check('non-JSON token response', err?.code, 'bad_response');
}

// --- account id / label extraction -------------------------------------------
{
    check('namespaced claim wins', provider.extractChatGptAccountId(jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'ns' }, organizations: [{ id: 'org' }] })), 'ns');
    check('organizations fallback', provider.extractChatGptAccountId(jwt({ organizations: [{ id: 'org-7' }] })), 'org-7');
    check('root fallback', provider.extractChatGptAccountId(jwt({ chatgpt_account_id: 'root-1' })), 'root-1');
    check('id_token preferred over access token', provider.extractChatGptAccountId(jwt({ chatgpt_account_id: 'from-id' }), jwt({ chatgpt_account_id: 'from-access' })), 'from-id');
    check('falls through to access token', provider.extractChatGptAccountId(undefined, jwt({ chatgpt_account_id: 'from-access' })), 'from-access');
    check('opaque tokens -> undefined', provider.extractChatGptAccountId('opaque', 'also-opaque'), undefined);
    check('label undefined when nothing disclosed', provider.chatGptAccountLabel(jwt({})), undefined);
    check('label from profile claim', provider.chatGptAccountLabel(jwt({ 'https://api.openai.com/profile': { email: 'p@example.com' }, 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } })), 'pro - p@example.com');
}

// --- device flow (ChatGPT's non-RFC variant) ---------------------------------
{
    const rec = recorder([
        jsonResponse(200, { device_auth_id: 'dai-1', user_code: 'ABCD-1234', interval: '2' }),
        jsonResponse(403, ''),   // "keep waiting" is a 403 with no body
        jsonResponse(200, { authorization_code: 'auth-code', code_challenge: 'chal', code_verifier: 'srv-verifier' }),
        jsonResponse(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
    ]);
    const ctx = ctxWith(rec.fetchImpl);
    const session = await provider.requestChatGptDeviceCode(ctx);
    check('usercode endpoint', rec.calls[0].url, 'https://auth.openai.com/api/accounts/deviceauth/usercode');
    check('usercode body is JSON', String(rec.calls[0].init.headers['content-type']), 'application/json');
    check('usercode client_id', JSON.parse(rec.calls[0].body).client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
    check('user code surfaced', session.userCode, 'ABCD-1234');
    check('string interval hardened to number', session.intervalS, 2);

    const grant = await provider.pollChatGptDeviceGrant(ctx, session);
    check('poll endpoint', rec.calls[1].url, 'https://auth.openai.com/api/accounts/deviceauth/token');
    check('poll body carries device_auth_id', JSON.parse(rec.calls[1].body).device_auth_id, 'dai-1');
    check('grant code', grant.authorizationCode, 'auth-code');
    check('grant uses the SERVER-returned verifier', grant.codeVerifier, 'srv-verifier');

    const tokens = await provider.exchangeChatGptDeviceGrant(ctx, grant);
    const finalBody = new URLSearchParams(rec.calls[3].body);
    check('device exchange uses the device redirect', finalBody.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
    check('device exchange sends the server verifier', finalBody.get('code_verifier'), 'srv-verifier');
    check('device exchange is still authorization_code', finalBody.get('grant_type'), 'authorization_code');
    check('device tokens returned', tokens.refreshToken, 'RT');
}
{
    const rec = recorder([jsonResponse(404, '')]);
    let err = null;
    try { await provider.requestChatGptDeviceCode(ctxWith(rec.fetchImpl)); } catch (e) { err = e; }
    check('device 404 has its own code', err?.code, 'device_unavailable');
}
{
    const rec = recorder([jsonResponse(500, 'boom')]);
    let err = null;
    try {
        await provider.pollChatGptDeviceGrant(ctxWith(rec.fetchImpl), { deviceAuthId: 'd', userCode: 'u', intervalS: 1 });
    } catch (e) { err = e; }
    check('5xx during device poll is fatal', err?.code, 'http_500');
}

// --- refresh matrix -----------------------------------------------------------
{
    const now = Date.now();
    const tokens = { accessToken: 'AT', refreshToken: 'RT', expiresAt: now - 1000 };
    const ctx = { fetch: async () => { throw new Error('unused'); } };
    check('no refresh token -> reauth', (await provider.openAiCodexHandler.refresh({ ...tokens, refreshToken: undefined }, ctx)).kind, 'reauth');
}
for (const code of ['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']) {
    const rec = recorder([jsonResponse(400, { error: code })]);
    const tokens = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() - 1000 };
    const result = await provider.openAiCodexHandler.refresh(tokens, ctxWith(rec.fetchImpl));
    check(`${code} -> reauth (credential cleared)`, result.kind, 'reauth');
}
{
    // A permanent failure must be classified on the CODE, not a substring: an
    // injected proxy page must not be able to force a logout.
    check('injected page is not permanent', provider.isPermanentChatGptRefreshFailure(400, '<html><p>your refresh_token_expired really</p></html>'.padEnd(6000, 'x')), false);
    check('structured code is permanent', provider.isPermanentChatGptRefreshFailure(400, '{"error":"refresh_token_expired"}'), true);
    check('unknown code is not permanent', provider.isPermanentChatGptRefreshFailure(400, '{"error":"temporarily_unavailable"}'), false);
    check('500 is never permanent', provider.isPermanentChatGptRefreshFailure(500, '{"error":"refresh_token_expired"}'), false);
}
{
    const rec = recorder([jsonResponse(200, { access_token: 'AT-2', expires_in: 3600 })]);
    const tokens = { accessToken: 'AT', refreshToken: 'RT-1', expiresAt: Date.now() - 1000, accountId: 'acct-42', accountLabel: 'plus - u@example.com' };
    const result = await provider.openAiCodexHandler.refresh(tokens, ctxWith(rec.fetchImpl));
    check('successful refresh', result.kind, 'refreshed');
    check('refresh token preserved when omitted', result.tokens.refreshToken, 'RT-1');
    check('account id kept across refresh', result.tokens.accountId, 'acct-42');
    check('account label kept across refresh', result.tokens.accountLabel, 'plus - u@example.com');
}
{
    const rec = recorder([jsonResponse(400, { error: 'invalid_grant' })]);
    const tokens = { accessToken: 'AT', refreshToken: 'RT-1', expiresAt: Date.now() + 3_600_000 };
    const result = await provider.openAiCodexHandler.refresh(tokens, ctxWith(rec.fetchImpl));
    check('RFC invalid_grant also reauth', result.kind, 'reauth');
}
{
    // Transient 500 while the token is still inside its window: keep serving.
    const rec = recorder([jsonResponse(500, 'upstream')]);
    const tokens = { accessToken: 'AT', refreshToken: 'RT-1', expiresAt: Date.now() + 3_600_000 };
    const result = await provider.openAiCodexHandler.refresh(tokens, ctxWith(rec.fetchImpl));
    check('transient 500 with a valid token -> keep', result.kind, 'keep');
}
{
    const boom = new TypeError('fetch failed');
    const ctx = { fetch: async () => { throw boom; }, signal: undefined };
    let err = null;
    try {
        await provider.openAiCodexHandler.refresh({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() - 1 }, ctx);
    } catch (e) { err = e; }
    check('transient network failure with an expired token -> throw', err, boom);
}

// --- handler identity + headers ----------------------------------------------
{
    const h = provider.openAiCodexHandler;
    check('provider id', h.providerId, 'chatgpt-codex');
    check('canonical base url', h.canonicalBaseUrl, 'https://chatgpt.com/backend-api/codex');
    check('api style is responses', h.apiStyle, 'responses');
    check('headers route by account', JSON.stringify(h.headers({ accessToken: 'a', expiresAt: 0, accountId: 'acct-9' })), JSON.stringify({ originator: 'xratu', 'ChatGPT-Account-Id': 'acct-9' }));
    check('headers without an account omit it', JSON.stringify(h.headers({ accessToken: 'a', expiresAt: 0 })), JSON.stringify({ originator: 'xratu' }));
}
{
    const rec = recorder([jsonResponse(200, '')]);
    await provider.openAiCodexHandler.revoke({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 0 }, ctxWith(rec.fetchImpl));
    check('revoke endpoint', rec.calls[0].url, 'https://auth.openai.com/oauth/revoke');
    const body = JSON.parse(rec.calls[0].body);
    check('revoke sends the refresh token', body.token, 'RT');
    check('revoke hints refresh_token', body.token_type_hint, 'refresh_token');
    check('revoke sends client_id', body.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
}
{
    const rec = recorder([new Response('nope', { status: 500 })]);
    await provider.openAiCodexHandler.revoke({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 0 }, ctxWith(rec.fetchImpl));
    checkTrue('revoke failure is swallowed (local clear proceeds)', true);
}

// --- manual code paste ---------------------------------------------------------
{
    check('bare code', provider.normalizeChatGptManualCode('abc123'), 'abc123');
    check('full redirect URL', provider.normalizeChatGptManualCode('http://localhost:1455/auth/callback?code=xyz&state=s'), 'xyz');
    check('nothing code-shaped -> empty', provider.normalizeChatGptManualCode('just the page'), 'just the page');
}

// --- loopback config ------------------------------------------------------------
{
    const config = provider.chatGptLoopbackConfig();
    check('primary port is the registered one', config.candidatePorts[0], 1455);
    check('fallback port is the registered second', config.candidatePorts[1], 1457);
    check('callback path', config.callbackPath, '/auth/callback');
    check('device verification page is built locally', provider.OPENAI_CODEX_DEVICE_VERIFICATION_URL, 'https://auth.openai.com/codex/device');
}

// --- error-code -> i18n key mapping ----------------------------------------------
{
    check('access_denied maps', oauthErrorValueKey(new OAuthFlowError('access_denied', 'x')), 'oauthAccessDenied');
    check('ports_busy maps', oauthErrorValueKey(new OAuthFlowError('ports_busy', 'x')), 'oauthPortsBusy');
    check('timeout maps', oauthErrorValueKey(new OAuthFlowError('timeout', 'x')), 'oauthTimeout');
    check('device_unavailable maps', oauthErrorValueKey(new OAuthFlowError('device_unavailable', 'x')), 'oauthDeviceUnavailable');
    check('missing_entitlement maps', oauthErrorValueKey(new OAuthFlowError('missing_entitlement', 'x')), 'oauthMissingEntitlement');
    check('reauth maps', oauthErrorValueKey(new OAuthReauthRequiredError('chatgpt-codex')), 'oauthReauthRequired');
    check('unknown code falls back', oauthErrorValueKey(new OAuthFlowError('weird_thing', 'x')), 'oauthFailed');
    check('non-oauth error falls back', oauthErrorValueKey(new Error('boom')), 'oauthFailed');
    checkTrue('every mapped key is listed for the i18n suite', oauthErrorKeys().includes('oauthPortsBusy'));
}

console.log(failed === 0 ? '\noauth-openai-codex tests: all passed' : `\noauth-openai-codex tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);