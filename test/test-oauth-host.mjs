#!/usr/bin/env node
// Drive the real host methods without starting VS Code or an account session.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { MockAgent } = require('undici');
const { proxyFetch } = require('../out/proxyFetch.js');
const { OAuthTokenManager } = require('../out/oauth/tokenManager.js');
const { abortable } = require('../out/oauth/refreshLock.js');
const { OAuthFlowError, OAuthCancelledError } = require('../out/oauth/types.js');
const { createManualCodeSlot } = require('../out/oauth/manualCode.js');
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const cls = file.statements.find((n) => ts.isClassDeclaration(n) && n.name.text === 'XratuChatViewProvider');
function hostMethods(names, globals = {}) {
    const members = cls.members.filter((n) => n.name && names.includes(n.name.getText(file)));
    assert.equal(members.length, names.length);
    const js = ts.transpileModule(`class TestHost { ${members.map((n) => n.getText(file)).join('\n')} }; globalThis.TestHost = TestHost;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const sandbox = { AbortController, AbortSignal, URL, OAuthFlowError, OAuthCancelledError, abortable, ...globals };
    vm.runInNewContext(js, sandbox);
    return new sandbox.TestHost();
}
const proxy = new MockAgent();
proxy.disableNetConnect();
for (const grant of ['authorization_code', 'refresh_token']) {
    proxy.get('https://auth.openai.com').intercept({ path: '/api/accounts/oauth/token', method: 'POST', body: `grant_type=${grant}` }).reply(200, { access_token: grant });
}
const chosen = [];
const networkHost = hostMethods(['_oauthContext'], { proxyFetch, getProxyDispatcher: (url) => { chosen.push(url); return proxy; } });
for (const grant of ['authorization_code', 'refresh_token']) {
    const response = await networkHost._oauthContext().fetch(new URL('https://auth.openai.com/api/accounts/oauth/token'), { method: 'POST', body: `grant_type=${grant}` });
    assert.equal((await response.json()).access_token, grant);
}
assert.equal(chosen.length, 2);
await proxy.close();
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const browserHost = (startLoopbackServer, launcher) => {
    const h = hostMethods(['_runBrowserSignIn', '_assertOAuthFlow'], {
        startLoopbackServer, ui: (x) => x,
        vscode: { Uri: { parse: (x) => x }, env: { openExternal: launcher } },
    });
    h.posts = [];
    h._postOAuthState = (state) => h.posts.push(state);
    return h;
};
const options = { expectedState: 'state', buildUrl: (redirectUri) => `https://auth.openai.com/api/accounts/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&id_token_hint=SECRET_ID_TOKEN` };
function flowFor(h) {
    const flow = { providerId: 'test', method: 'browser', controller: new AbortController(), manualCode: createManualCodeSlot() };
    h._oauthFlow = flow;
    return flow;
}
let disposed = 0;
const server = () => ({ port: 1455, redirectUri: 'http://127.0.0.1:1455/auth/callback', waitForCallback: async () => ({ code: 'code', state: 'state', clientId: 'issued' }), dispose: () => { disposed++; } });
for (const launcher of [async () => { throw new Error('Launch failed'); }, async () => false]) {
    const h = browserHost(async () => server(), launcher);
    const result = await h._runBrowserSignIn(flowFor(h), options);
    assert.equal(result.code, 'code');
    assert.ok(h.posts.at(-1).authorizeUrl);
    assert.equal(h.posts.at(-1).authorizeUrl.includes('SECRET_ID_TOKEN'), false);
}
assert.equal(disposed, 2);
{
    const ready = deferred();
    let opened = 0;
    const h = browserHost(async () => { await ready.promise; return server(); }, async () => { opened++; });
    const flow = flowFor(h);
    const pending = h._runBrowserSignIn(flow, options);
    flow.controller.abort(); h._oauthFlow = null; ready.resolve();
    await assert.rejects(pending, (e) => e instanceof OAuthCancelledError);
    assert.equal(opened, 0);
    assert.equal(h.posts.length, 0);
    assert.equal(disposed, 3);
}
{
    const h = browserHost(async () => { throw new OAuthFlowError('ports_busy', 'occupied'); }, async () => false);
    const flow = flowFor(h);
    const pending = h._runBrowserSignIn(flow, options);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.posts[0].error.valueKey, 'oauthPortsBusy');
    flow.manualCode.submit('http://127.0.0.1:1455/auth/callback?code=pasted&state=state&client_id=issued');
    assert.equal((await pending).clientId, 'issued');
}
{
    const h = browserHost(async () => server(), async () => false);
    const flow = flowFor(h);
    // A bad manual callback wins before the network callback settles.
    const waitServer = { ...server(), waitForCallback: () => new Promise(() => {}) };
    h._oauthFlow = flow;
    const h2 = browserHost(async () => waitServer, async () => false);
    h2._oauthFlow = flow;
    const pending = h2._runBrowserSignIn(flow, options);
    flow.manualCode.submit('http://127.0.0.1:1455/auth/callback?code=forged&state=wrong&client_id=issued');
    await assert.rejects(pending, (e) => e.code === 'state_mismatch');
}
const tmp = mkdtempSync(join(tmpdir(), 'xratu-oauth-host-'));
try {
    const handler = { providerId: 'test', storageKey: 'test', revoke: async () => { throw new Error('offline'); } };
    const h = hostMethods(['_deleteLlmCredential', '_oauthSignOut'], { getOAuthProvider: () => handler });
    let credentials = [{ id: 'oauth', oauthProviderId: 'test', oauthStorageKey: 'test', baseUrl: 'https://test.invalid', apiKey: '' }];
    let tokens = { accessToken: 'access', expiresAt: Date.now() + 3600000 };
    const store = { read: async () => tokens, write: async (_key, next) => { tokens = next; } };
    const state = new Map([['xratu.activeLlmCredentialId', 'oauth']]);
    h._getSavedCredentials = async () => credentials;
    h._persistSavedCredentials = async (next) => { credentials = next; };
    h._oauthTokenStore = () => store;
    const manager = new OAuthTokenManager({ store, lockDir: join(tmp, 'locks') });
    h._oauthTokenManager = () => manager;
    h._oauthContext = () => ({});
    h._globalState = { get: (key) => state.get(key), update: async (key, value) => state.set(key, value) };
    h._secrets = { delete: async () => {} };
    h._forgetCredentialModel = async () => {};
    h._abortControllers = new Map();
    h._fetchModels = async () => {};
    h._sendSavedCredentials = async () => {};
    let statePosts = 0;
    h._sendOAuthState = async () => { statePosts++; };
    const posts = [];
    h._postOAuthState = (p) => posts.push(p);
    await h._deleteLlmCredential('oauth');
    assert.equal(tokens, null);
    assert.equal(credentials.length, 0);
    assert.equal(state.get('xratu.activeLlmCredentialId'), '');
    assert.equal(statePosts, 1);
    assert.equal(posts.at(-1).error.valueKey, 'oauthRevocationUnconfirmed');
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log('oauth-host: configured proxy, browser launch, cancellation, manual fallback, cleanup and deletion passed');
{
    const handler = { providerId: 'chatgpt-codex', storageKey: 'chatgpt', label: 'ChatGPT', methods: ['browser'], subscription: true };
    const h = hostMethods(['_sendOAuthState'], {
        getOAuthProvider: () => handler, listOAuthProviders: () => [handler], chatGptPlanEnabled: () => true,
    });
    h._getSavedCredentials = async () => [{ id: 'connected', oauthProviderId: handler.providerId }];
    h._oauthTokenStore = () => ({ read: async () => ({ email: 'user@example.test', accountLabel: 'user@example.test · oaiapp_legacy' }) });
    h._globalState = { get: (key) => key === 'xratu.activeLlmCredentialId' ? 'connected' : {
        connected: { email: 'user@example.test', clientId: 'oaiapp_legacy', subject: 'opaque-subject' },
        remembered: { clientId: 'oaiapp_other', subject: 'opaque-subject' },
    } };
    let state;
    h._postOAuthState = (value) => { state = value; };
    await h._sendOAuthState();
    assert.equal(state.accounts[0].accountLabel, 'user@example.test');
    assert.equal(state.registrations[0].label, 'user@example.test');
    assert.equal(state.registrations[1].label, '');
    assert.equal(JSON.stringify(state).includes('oaiapp_'), false);
}
console.log('oauth-host: connected and remembered account labels omit OAuth identifiers');

{
    const ledger = require('../out/local/usageLedger.js');
    const h = hostMethods(['_sendUsageState', '_costFor'], {
        ...ledger,
        baseUrlHost: () => 'api.openai.com',
        getOAuthProvider: () => ({ subscription: true }),
        isIranianProvider: () => false,
        priceForModel: () => { throw new Error('Plan usage must not resolve API prices'); },
    });
    const posts = [];
    h._view = { webview: { postMessage: (value) => posts.push(value) } };
    h._getSavedCredentials = async () => [{ oauthProviderId: 'chatgpt-codex', label: 'account@example.test', baseUrl: 'https://api.openai.com/v1' }];
    const round = { ts: Date.now(), sessionId: 's', host: 'api.openai.com', model: 'gpt-6-luna', input: 100, output: 20, cached: 30, cacheWrite: 0, amount: null, currency: null };
    h._usageLedger = { read: async () => [
        { ...round, billing: 'chatgpt-plan' },
        { ...round, billing: 'chatgpt-plan', ts: Date.now() - 31 * 86_400_000 },
        { ...round, amount: 2, currency: 'USD' },
    ] };
    h._modelRates = (entries) => {
        assert.equal(entries.length, 1);
        assert.equal(entries[0].billing, undefined);
        return [];
    };
    let accountStateSent = false;
    h._sendOAuthState = async () => { accountStateSent = true; };
    await h._sendUsageState();
    const state = posts[0];
    assert.equal(state.chatgpt.totals.input, 100);
    assert.equal(state.chatgpt.totals.USD, 0);
    assert.equal(state.chatgpt.models[0].tokens, 120);
    assert.equal(state.chatgpt.hasHistory, true);
    assert.equal(state.history[0].cells[0].input, 100);
    assert.equal(state.allTime.USD, 2);
    assert.equal(state.providers[0].label, 'api.openai.com');
    assert.equal(accountStateSent, true);
    h._runSubscription = true;
    assert.equal(h._costFor({ promptTokens: 100, completionTokens: 20 }), null);
}
console.log('oauth-host: Usage separates plan tokens from API spend on the same host');
