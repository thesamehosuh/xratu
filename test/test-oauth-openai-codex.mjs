#!/usr/bin/env node
// Public ChatGPT integration. Catalog fixture fields are copied from
// https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { openAiChatGptHandler: handler, buildChatGptAuthorizeUrl, validateChatGptIdToken, parseChatGptModels, chatGptPlanEnabled, chatGptStorageKey } = require('../out/oauth/providers/openaiChatGpt.js');
const { oauthRequest } = require('../out/oauth/http.js');
const { oauthErrorKeys } = require('../out/oauth/errorKeys.js');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const issuer = 'https://auth.openai.com';
const clientId = 'oaiapp_test';
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const claimsFor = (nonce, extra = {}) => ({ iss: issuer, aud: clientId, sub: 'account-one', email: 'user@example.test', exp: Date.now() / 1000 + 3600, nonce, ...extra });
function jwt(claims, signingKey = privateKey) {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), signingKey).toString('base64url')}`;
}
const response = (data, status = 200) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status });
const discovery = { issuer, jwks_uri: `${issuer}/.well-known/jwks.json`, revocation_endpoint: `${issuer}/api/accounts/oauth/revoke` };
let nonce, redirectUri, overrideClaims = {}, callbackExtra = {}, tokenExtra = {};
const calls = [];
const ctx = {
    hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    async authorize(options) {
        redirectUri = 'http://127.0.0.1:43210/auth/callback';
        const url = new URL(options.buildUrl(redirectUri));
        assert.equal(url.pathname, '/api/accounts/authorize');
        assert.equal(url.searchParams.get('resource'), 'https://api.openai.com/v1');
        assert.ok(url.searchParams.get('code_challenge'));
        nonce = url.searchParams.get('nonce');
        return { code: 'code', state: options.expectedState, clientId, redirectUri, ...callbackExtra };
    },
    async fetch(url, init) {
        calls.push({ url, init });
        if (url.endsWith('openid-configuration')) return response(discovery);
        if (url.endsWith('jwks.json')) return response({ keys: [jwk] });
        if (url.endsWith('/oauth/token')) return response({ access_token: 'access', refresh_token: 'refresh', id_token: jwt(claimsFor(nonce, overrideClaims)), expires_in: 3600, scope, ...tokenExtra });
        if (url.endsWith('/models')) return response(JSON.parse(readFileSync(new URL('./fixtures/chatgpt-models.json', import.meta.url), 'utf8')));
        if (url.endsWith('/oauth/revoke')) return response('');
        throw new Error(`Unexpected URL: ${url}`);
    },
};
const authorize = new URL(buildChatGptAuthorizeUrl({ verifier: 'v'.repeat(43), state: 'state', nonce: 'nonce', redirectUri: 'http://127.0.0.1:1455/auth/callback', hostId: ctx.hostId }));
assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
assert.equal(authorize.searchParams.get('agent_name_hint'), 'Xratu');
assert.equal(authorize.searchParams.get('scope'), scope);
let tokens = await handler.login(ctx);
assert.equal(tokens.subject, 'account-one');
assert.equal(tokens.clientId, clientId);
assert.equal(tokens.accountLabel, 'user@example.test');
assert.ok(tokens.idToken);
assert.ok(chatGptPlanEnabled(tokens));
const exchange = calls.find((c) => c.url.endsWith('/oauth/token'));
const form = new URLSearchParams(exchange.init.body);
assert.equal(form.get('client_id'), clientId);
assert.equal(form.get('redirect_uri'), redirectUri);
assert.equal(form.get('resource'), 'https://api.openai.com/v1');
assert.equal(form.has('state'), false);
assert.notEqual(chatGptStorageKey(tokens), chatGptStorageKey({ ...tokens, clientId: 'another-client' }));
assert.notEqual(chatGptStorageKey(tokens), chatGptStorageKey({ ...tokens, subject: 'another-user' }));
for (const change of [{ nonce: 'wrong' }, { aud: 'wrong' }, { iss: 'https://evil.test' }, { exp: 1 }, { sub: '' }, { nbf: Date.now() / 1000 + 3600 }]) {
    overrideClaims = change;
    await assert.rejects(handler.login(ctx), (e) => e.code === 'invalid_id_token');
}
overrideClaims = {};
const { privateKey: wrongKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
await assert.rejects(validateChatGptIdToken(ctx, jwt(claimsFor('n'), wrongKey), clientId, 'n'), /signature/);
const malformedJwks = { ...ctx, async fetch(url, init) {
    if (url.endsWith('jwks.json')) return response({ keys: [{ ...jwk, n: '!', e: '!' }] });
    return ctx.fetch(url, init);
} };
await assert.rejects(validateChatGptIdToken(malformedJwks, jwt(claimsFor('n')), clientId, 'n'), (e) => e.code === 'invalid_id_token');
callbackExtra = { clientId: undefined };
await assert.rejects(handler.login(ctx), (e) => e.code === 'invalid_registration');
callbackExtra = { state: 'wrong' };
await assert.rejects(handler.login(ctx), (e) => e.code === 'state_mismatch');
callbackExtra = {};
const returning = { ...ctx, registration: { clientId, subject: 'account-one', email: tokens.email, idToken: tokens.idToken } };
const returningUrl = new URL(buildChatGptAuthorizeUrl({ verifier: 'v'.repeat(43), state: 's', nonce: 'n', redirectUri, hostId: ctx.hostId, registration: returning.registration }));
assert.equal(returningUrl.searchParams.has('agent_name_hint'), false);
assert.equal(returningUrl.searchParams.get('id_token_hint'), tokens.idToken);
assert.equal(returningUrl.searchParams.get('client_id'), clientId);
callbackExtra = { clientId: 'wrong-client' };
await assert.rejects(handler.login(returning), (e) => e.code === 'invalid_registration');
callbackExtra = { clientId: undefined };
assert.equal((await handler.login(returning)).subject, 'account-one');
callbackExtra = {};
overrideClaims = { sub: 'another-account' };
await assert.rejects(handler.login(returning), (e) => e.code === 'account_mismatch');
overrideClaims = {};
tokenExtra = { scope: 'openid profile email' };
const identityOnly = await handler.login(ctx);
assert.equal(chatGptPlanEnabled(identityOnly), false);
await assert.rejects(handler.discoverModels(ctx, identityOnly), (e) => e.code === 'plan_permission_missing');
tokenExtra = {};
const result = await handler.refresh(tokens, ctx);
assert.equal(result.kind, 'refreshed');
const refresh = calls.filter((c) => c.url.endsWith('/oauth/token')).at(-1);
const refreshForm = new URLSearchParams(refresh.init.body);
assert.equal(refreshForm.get('grant_type'), 'refresh_token');
assert.equal(refreshForm.get('client_id'), clientId);
assert.equal(refreshForm.get('resource'), 'https://api.openai.com/v1');
assert.equal(refreshForm.has('scope'), false);
assert.equal((await handler.refresh({ ...tokens, clientId: undefined }, ctx)).kind, 'reauth');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/chatgpt-models.json', import.meta.url), 'utf8'));
const listed = fixture.models.filter((m) => m.visibility === 'list');
const catalog = (await handler.discoverModels(ctx, tokens)).models;
assert.deepEqual(catalog.map((m) => m.id), listed.map((m) => m.slug));
assert.deepEqual(catalog.map((m) => m.displayName), listed.map((m) => m.display_name));
assert.deepEqual(catalog[0].reasoningLevels, listed[0].supported_reasoning_levels.map((l) => l.effort));
assert.equal(catalog[0].contextWindow, listed[0].context_window);
assert.equal(catalog[0].supportsVision, true);
assert.equal(new Headers(calls.find((c) => c.url.endsWith('/models')).init.headers).get('authorization'), 'Bearer access');
assert.deepEqual(parseChatGptModels({ models: [{ slug: 'hidden', visibility: 'hide' }] }), []);
await handler.revoke(tokens, ctx);
const revoke = calls.at(-1);
assert.equal(revoke.url, discovery.revocation_endpoint);
assert.equal(new URLSearchParams(revoke.init.body).get('token_type_hint'), 'refresh_token');
assert.equal(new URLSearchParams(revoke.init.body).get('client_id'), clientId);
assert.equal(new Headers(revoke.init.headers).get('content-type'), 'application/x-www-form-urlencoded');
const controller = new AbortController();
let sentSignal;
await oauthRequest({ signal: controller.signal, fetch: async (_url, init) => { sentSignal = init.signal; return response('ok'); } }, 'https://test.invalid');
assert.notEqual(sentSignal, controller.signal);
controller.abort();
assert.equal(sentSignal.aborted, true);
// Keep the event loop live while Node's unref'ed timeout signal is tested.
const ticker = setInterval(() => {}, 50);
try {
    await assert.rejects(oauthRequest({ signal: new AbortController().signal, fetch: async () => new Promise(() => {}) }, 'https://test.invalid', {}, 20), (e) => e.name === 'TimeoutError');
    await assert.rejects(oauthRequest({ fetch: async () => ({ status: 200, text: () => new Promise(() => {}) }) }, 'https://test.invalid', {}, 20), (e) => e.name === 'TimeoutError');
} finally { clearInterval(ticker); }
assert.ok(oauthErrorKeys().includes('oauthPlanPermissionMissing'));
console.log('oauth-openai-codex: public integration, identity, permission, refresh, catalog, revoke, deadlines passed');
