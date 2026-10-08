#!/usr/bin/env node
/**
 * OAuth token manager + token-endpoint refresh matrix tests.
 *
 * The matrix (the single most important behavior in the module):
 *   invalid_grant          -> store CLEARED + OAuthReauthRequiredError
 *   transient + valid      -> keep serving, store untouched
 *   transient + expired    -> THROW, store untouched (NOT cleared - clearing
 *                             is the bug that logs users out on a blip)
 *   refreshed              -> store updated; refresh token preserved when the
 *                             response omits one (RFC 6749 section 6)
 *
 * Concurrency (rotating refresh tokens make these load-bearing):
 *   - two concurrent resolve() -> exactly one refresh (single-flight)
 *   - two managers on one store -> the loser re-reads under the lock and
 *     makes NO network call (reload-before-network)
 *   - sign-out during an in-flight refresh -> the refresh result is
 *     DISCARDED, the store stays null (stale-write guard: no resurrection)
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-oauth-token-manager.mjs
 */
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const require = createRequire(import.meta.url);
const { OAuthTokenManager } = require('../out/oauth/tokenManager.js');
const { refreshWithTokenEndpoint } = require('../out/oauth/tokenEndpoint.js');
const { OAuthReauthRequiredError } = require('../out/oauth/types.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const checkTrue = (name, actual) => check(name, !!actual, true);

const NOW = Date.now();
const VALID = { accessToken: 'AT-VALID', refreshToken: 'RT-1', expiresAt: NOW + 3_600_000 };
const EXPIRED = { accessToken: 'AT-OLD', refreshToken: 'RT-1', expiresAt: NOW - 60_000 };
const RENEWED = { accessToken: 'AT-NEW', refreshToken: 'RT-2', expiresAt: NOW + 3_600_000 };

/** Map-backed store; `writes` records every mutation for assertions. */
function memoryStore(seed) {
    const data = new Map(Object.entries(seed ?? {}));
    const writes = [];
    return {
        data, writes,
        async read(key) { return data.has(key) ? data.get(key) : null; },
        async write(key, tokens) { writes.push([key, tokens]); if (tokens === null) data.delete(key); else data.set(key, tokens); },
    };
}

function handler(refresh, overrides = {}) {
    return {
        providerId: 'test', storageKey: 'k', canonicalBaseUrl: 'https://x/v1',
        login: async () => { throw new Error('unused'); },
        refresh,
        ...overrides,
    };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xratu-oauth-test-'));
const managerFor = (store, extra = {}) => new OAuthTokenManager({ store, lockDir: tmp, ...extra });
const ctx = { fetch: async () => { throw new Error('handler.fetch unused in these tests'); } };
const noStore = memoryStore();

// --- happy paths -----------------------------------------------------------------
{
    const store = memoryStore({ k: VALID });
    let calls = 0;
    const m = managerFor(store);
    const at = await m.resolve(handler(async () => { calls++; return { kind: 'refreshed', tokens: RENEWED }; }), ctx);
    check('valid token served without refresh', at, 'AT-VALID');
    check('no refresh call', calls, 0);
    check('no store writes', store.writes.length, 0);
}
{
    const store = memoryStore({ k: EXPIRED });
    const m = managerFor(store);
    const at = await m.resolve(handler(async () => ({ kind: 'refreshed', tokens: RENEWED })), ctx);
    check('expired token refreshed', at, 'AT-NEW');
    check('renewed tokens persisted', store.data.get('k')?.refreshToken, 'RT-2');
}
{
    // Unknown expiry (expiresAt 0, opaque token) forces a refresh.
    const store = memoryStore({ k: { accessToken: 'opaque', refreshToken: 'RT', expiresAt: 0 } });
    const m = managerFor(store);
    const at = await m.resolve(handler(async () => ({ kind: 'refreshed', tokens: RENEWED })), ctx);
    check('unknown expiry refreshes on next use', at, 'AT-NEW');
}
{
    const store = memoryStore({ k: VALID });
    let calls = 0;
    const m = managerFor(store);
    const at = await m.forceRefresh(handler(async () => { calls++; return { kind: 'refreshed', tokens: RENEWED }; }), ctx);
    check('forceRefresh bypasses validity', at, 'AT-NEW');
    check('forceRefresh refreshed', calls, 1);
}
{
    const store = memoryStore({});
    const m = managerFor(store);
    let err = null;
    try { await m.resolve(handler(async () => ({ kind: 'refreshed', tokens: RENEWED })), ctx); } catch (e) { err = e; }
    check('no stored credential -> reauth', err instanceof OAuthReauthRequiredError, true);
}

// --- the matrix --------------------------------------------------------------------
{
    const store = memoryStore({ k: EXPIRED });
    const m = managerFor(store);
    let err = null;
    try { await m.resolve(handler(async () => ({ kind: 'reauth' })), ctx); } catch (e) { err = e; }
    check('reauth -> OAuthReauthRequiredError', err instanceof OAuthReauthRequiredError, true);
    check('reauth -> store CLEARED', store.data.has('k'), false);
}
{
    const store = memoryStore({ k: VALID });
    const m = managerFor(store);
    const at = await m.forceRefresh(handler(async () => ({ kind: 'keep', tokens: VALID })), ctx);
    check('keep -> old token served', at, 'AT-VALID');
    check('keep -> store untouched', store.writes.length, 0);
}
{
    // THE critical cell: a transient throw must NOT clear the credential.
    const store = memoryStore({ k: EXPIRED });
    const m = managerFor(store);
    let err = null;
    try {
        await m.resolve(handler(async () => { throw new Error('ECONNRESET'); }), ctx);
    } catch (e) { err = e; }
    check('transient throw propagates', String(err?.message), 'ECONNRESET');
    check('transient throw keeps credentials', store.data.get('k')?.refreshToken, 'RT-1');
}

// --- single-flight ------------------------------------------------------------------
{
    const store = memoryStore({ k: EXPIRED });
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const m = managerFor(store);
    const h = handler(async () => { calls++; await gate; return { kind: 'refreshed', tokens: RENEWED }; });
    const p1 = m.resolve(h, ctx);
    const p2 = m.resolve(h, ctx);
    release();
    const [a, b] = await Promise.all([p1, p2]);
    check('concurrent resolve: both get the token', a === 'AT-NEW' && b === 'AT-NEW', true);
    check('concurrent resolve: exactly one refresh', calls, 1);
}

// --- cross-process (two managers, one store, shared lock dir) -------------------------
{
    const store = memoryStore({ k: EXPIRED });
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const a = managerFor(store);
    const b = managerFor(store);
    const hA = handler(async () => { calls++; await gate; return { kind: 'refreshed', tokens: RENEWED }; });
    const hB = handler(async () => { calls++; return { kind: 'refreshed', tokens: RENEWED }; });
    // A enters the lock and blocks in refresh; B reads the stale record, then
    // waits on the directory lock. When A finishes, B re-reads under the lock,
    // sees the rotated token, and makes NO network call.
    const pA = a.resolve(hA, ctx);
    await new Promise((r) => setTimeout(r, 100)); // let A acquire + block
    const pB = b.resolve(hB, ctx);
    release();
    const [ra, rb] = await Promise.all([pA, pB]);
    check('manager A refreshed', ra, 'AT-NEW');
    check('manager B used the rotated token', rb, 'AT-NEW');
    check('exactly one network refresh across managers', calls, 1);
}

// --- stale-write guard: sign-out during in-flight refresh -----------------------------
{
    const store = memoryStore({ k: EXPIRED });
    let release;
    const gate = new Promise((r) => { release = r; });
    const m = managerFor(store);
    const h = handler(async () => { await gate; return { kind: 'refreshed', tokens: RENEWED }; });
    const p = m.resolve(h, ctx);
    await new Promise((r) => setTimeout(r, 100)); // A is inside the lock, refresh in flight
    await store.write('k', null); // another window signs out (sign-out does not lock)
    release();
    let err = null;
    try { await p; } catch (e) { err = e; }
    check('sign-out during refresh -> reauth error', err instanceof OAuthReauthRequiredError, true);
    check('refresh result NOT resurrected', store.data.has('k'), false);
}

// --- refreshWithTokenEndpoint (the generic RFC 6749 section 6 path) ---------------------
const jsonResponse = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status });
const endpointOpts = (fetchImpl, tokens = EXPIRED) => ({
    tokenUrl: 'https://idp.example/token', clientId: 'cid', tokens, fetch: fetchImpl,
});
{
    let body = '';
    const r = await refreshWithTokenEndpoint(endpointOpts(async (_url, init) => {
        body = init.body;
        return jsonResponse(200, { access_token: 'AT-2', expires_in: 3600 });
    }));
    check('refresh -> refreshed', r.kind, 'refreshed');
    checkTrue('grant_type sent', body.includes('grant_type=refresh_token'));
    check('refresh token preserved when omitted', r.tokens.refreshToken, 'RT-1');
    checkTrue('expires_in -> absolute expiresAt', r.tokens.expiresAt > Date.now() + 3_500_000);
}
{
    const r = await refreshWithTokenEndpoint(endpointOpts(async () =>
        jsonResponse(200, { access_token: 'AT-2', refresh_token: 'RT-9', expires_in: 3600 })));
    check('rotation honored', r.tokens.refreshToken, 'RT-9');
}
{
    const r = await refreshWithTokenEndpoint(endpointOpts(async () =>
        jsonResponse(400, { error: 'invalid_grant', error_description: 'reused' })));
    check('invalid_grant -> reauth', r.kind, 'reauth');
}
{
    const r = await refreshWithTokenEndpoint(endpointOpts(async () =>
        jsonResponse(401, { error: 'invalid_token' })));
    check('401 invalid_token -> reauth', r.kind, 'reauth');
}
{
    const r = await refreshWithTokenEndpoint(endpointOpts(async () =>
        jsonResponse(500, '<html>proxy error</html>'), VALID));
    check('500 + valid token -> keep', r.kind, 'keep');
}
{
    let err = null;
    try {
        await refreshWithTokenEndpoint(endpointOpts(async () => jsonResponse(500, 'oops'), EXPIRED));
    } catch (e) { err = e; }
    check('500 + expired -> throw', err?.code, 'http_500');
}
{
    const boom = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) });
    const r = await refreshWithTokenEndpoint(endpointOpts(async () => { throw boom; }, VALID));
    check('network throw + valid -> keep', r.kind, 'keep');
}
{
    const boom = new TypeError('fetch failed');
    let err = null;
    try { await refreshWithTokenEndpoint(endpointOpts(async () => { throw boom; }, EXPIRED)); } catch (e) { err = e; }
    check('network throw + expired -> rethrow', err, boom);
}
{
    let err = null;
    try {
        await refreshWithTokenEndpoint(endpointOpts(async () => jsonResponse(200, '<not json')));
    } catch (e) { err = e; }
    check('200 non-JSON -> throw', err?.code, 'bad_response');
}
{
    let err = null;
    try {
        await refreshWithTokenEndpoint(endpointOpts(async () => jsonResponse(200, { token_type: 'bearer' })));
    } catch (e) { err = e; }
    check('200 missing access_token -> throw', err?.code, 'bad_response');
}
{
    // Single-shot credential: no refresh token -> straight to reauth, no network.
    let fetchCalled = false;
    const r = await refreshWithTokenEndpoint(endpointOpts(async () => { fetchCalled = true; return jsonResponse(200, {}); },
        { accessToken: 'AT', expiresAt: NOW - 1 }));
    check('no refresh token -> reauth', r.kind, 'reauth');
    check('no refresh token -> no network', fetchCalled, false);
}

// --- two REAL processes against one store (Cline's process.test.ts bar) -------
{
    const { spawn } = await import('child_process');
    const storeFile = path.join(tmp, 'proc-store.json');
    const logFile = path.join(tmp, 'proc-log.txt');
    fs.writeFileSync(storeFile, JSON.stringify({ k: EXPIRED }));
    fs.writeFileSync(logFile, '');

    const worker = path.join(process.cwd(), 'test', 'oauth-refresh-worker.mjs');
    const run = () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, tmp, storeFile, logFile], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', errOut = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { errOut += c; });
        child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`worker exited ${code}: ${errOut}`))));
    });
    const [ra, rb] = await Promise.all([run(), run()]);
    check('process A got the token', ra, 'AT-NEW');
    check('process B got the token', rb, 'AT-NEW');
    const refreshes = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    check('exactly one refresh across two real processes', refreshes.length, 1);
    check('rotated token persisted to disk', JSON.parse(fs.readFileSync(storeFile, 'utf8')).k.refreshToken, 'RT-2');
}

// silence unused warning for the shared fixture
check('fixture store readable', typeof noStore.read, 'function');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\noauth-token-manager tests: all passed' : `\noauth-token-manager tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
