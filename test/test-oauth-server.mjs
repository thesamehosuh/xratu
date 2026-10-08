#!/usr/bin/env node
/**
 * OAuth loopback callback server tests - real sockets, real ports.
 *
 * The cases here are the competitor bug catalogue:
 *  - port iteration skips EADDRINUSE (Roo/opencode: a stuck flow bricks
 *    sign-in for the whole machine)
 *  - 400-without-fail on junk probes; error= and state mismatch FAIL loudly
 *    (Continue: access_denied collapses into "no query params", state
 *    mismatch spins forever)
 *  - timeout and cancel release the port; a late callback after cancel gets
 *    410 and cannot resolve the flow
 *  - THE keep-alive regression: a pooled socket must not deliver a later
 *    flow's callback to an already-settled server (Cline's fix; Roo and
 *    opencode still ship the bug)
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-oauth-server.mjs
 */
import { createRequire } from 'module';
import http from 'http';
const require = createRequire(import.meta.url);
const { startLoopbackServer } = require('../out/oauth/server.js');
const { OAuthCancelledError, OAuthFlowError } = require('../out/oauth/types.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const checkTrue = (name, actual) => check(name, !!actual, true);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url, agent) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { agent }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
    });
}

/** Occupy a port on 127.0.0.1 so the candidate iterator must skip it. */
async function occupy(port) {
    const srv = http.createServer((_req, res) => res.end('occupied'));
    await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', resolve);
    });
    return srv;
}
const release = (srv) => new Promise((r) => srv.close(r));

/** Wait for the port to become bindable again. `server.close()` stops
 *  accepting synchronously but releases the listening socket asynchronously,
 *  so a single fixed sleep is a flake waiting for a loaded CI worker. */
async function waitForPortFree(port, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await canBind(port)) return true;
        if (Date.now() > deadline) return false;
        await sleep(25);
    }
}

/** Bind a throwaway server to learn whether a port is free again. */
async function canBind(port) {
    const srv = http.createServer();
    try {
        await new Promise((resolve, reject) => {
            srv.once('error', reject);
            srv.listen(port, '127.0.0.1', resolve);
        });
        return true;
    } catch {
        return false;
    } finally {
        await release(srv).catch(() => {});
    }
}

/** Three consecutive ports that are all currently free (best-effort: the
 *  test then occupies them itself). */
async function freePortTriple() {
    for (let base = 48100; base < 48900; base += 3) {
        if (await canBind(base) && await canBind(base + 1) && await canBind(base + 2)) {
            return [base, base + 1, base + 2];
        }
    }
    throw new Error('no free port triple found');
}

// --- port iteration -----------------------------------------------------------
{
    const [p1, p2] = await freePortTriple();
    const blocker = await occupy(p1);
    try {
        const server = await startLoopbackServer({ candidatePorts: [p1, p2], timeoutMs: 10_000 });
        check('EADDRINUSE skipped to next candidate', server.port, p2);
        server.cancel();
        try { await server.waitForCallback(); } catch { /* cancel rejection */ }
    } finally {
        await release(blocker);
    }
}
{
    const [p1, p2, p3] = await freePortTriple();
    const b1 = await occupy(p1);
    const b2 = await occupy(p2);
    const b3 = await occupy(p3);
    try {
        let err = null;
        try {
            await startLoopbackServer({ candidatePorts: [p1, p2, p3], timeoutMs: 5_000 });
        } catch (e) { err = e; }
        check('all-busy throws OAuthFlowError', err instanceof OAuthFlowError, true);
        check('all-busy code is ports_busy', err?.code, 'ports_busy');
        checkTrue('error names the range', String(err?.message).includes(String(p1)) && String(err?.message).includes(String(p3)));
    } finally {
        await release(b1); await release(b2); await release(b3);
    }
}

// --- success + state + iss ------------------------------------------------------
{
    const [port] = await freePortTriple();
    const server = await startLoopbackServer({ candidatePorts: [port], expectedState: 's1', timeoutMs: 10_000 });
    check('redirectUri shape', server.redirectUri, `http://127.0.0.1:${port}/callback`);
    const waiting = server.waitForCallback();
    const res = await httpGet(`http://127.0.0.1:${port}/callback?code=abc&state=s1&iss=https://issuer.example`);
    check('success page is 200', res.status, 200);
    const result = await waiting;
    check('code delivered', result.code, 'abc');
    check('state delivered', result.state, 's1');
    check('RFC 9207 iss forwarded', result.iss, 'https://issuer.example');
    check('port released after success', await waitForPortFree(port), true);
}

// --- junk probes do not kill the flow ------------------------------------------
{
    const [port] = await freePortTriple();
    const server = await startLoopbackServer({ candidatePorts: [port], expectedState: 's', timeoutMs: 10_000 });
    const waiting = server.waitForCallback();
    check('wrong path is 404', (await httpGet(`http://127.0.0.1:${port}/nope`)).status, 404);
    check('missing code is 400', (await httpGet(`http://127.0.0.1:${port}/callback`)).status, 400);
    check('favicon is 404', (await httpGet(`http://127.0.0.1:${port}/favicon.ico`)).status, 404);
    // Flow still alive: a real callback now succeeds.
    check('real callback still accepted', (await httpGet(`http://127.0.0.1:${port}/callback?code=late&state=s`)).status, 200);
    check('flow resolved after probes', (await waiting).code, 'late');
}

// --- error= fails the flow -------------------------------------------------------
{
    const [port] = await freePortTriple();
    const server = await startLoopbackServer({ candidatePorts: [port], timeoutMs: 10_000 });
    const waiting = server.waitForCallback();
    const res = await httpGet(`http://127.0.0.1:${port}/callback?error=access_denied&error_description=user%20refused`);
    check('error= gets 400', res.status, 400);
    let err = null;
    try { await waiting; } catch (e) { err = e; }
    check('error= rejects with OAuthFlowError', err instanceof OAuthFlowError, true);
    check('error code preserved', err?.code, 'access_denied');
    checkTrue('description in message', String(err?.message).includes('user refused'));
}

// --- state mismatch fails loudly -------------------------------------------------
{
    const [port] = await freePortTriple();
    const server = await startLoopbackServer({ candidatePorts: [port], expectedState: 'right', timeoutMs: 10_000 });
    const waiting = server.waitForCallback();
    const res = await httpGet(`http://127.0.0.1:${port}/callback?code=x&state=wrong`);
    check('state mismatch gets 400', res.status, 400);
    let err = null;
    try { await waiting; } catch (e) { err = e; }
    check('state mismatch code', err?.code, 'state_mismatch');
}

// --- timeout settles and releases --------------------------------------------------
{
    const [port] = await freePortTriple();
    const server = await startLoopbackServer({ candidatePorts: [port], timeoutMs: 300 });
    let err = null;
    try { await server.waitForCallback(); } catch (e) { err = e; }
    check('timeout code', err?.code, 'timeout');
    check('port released after timeout', await waitForPortFree(port), true);
}

// --- cancel: rejects, releases, late callback is 410 --------------------------------
{
    const [port] = await freePortTriple();
    const server = await startLoopbackServer({ candidatePorts: [port], timeoutMs: 10_000 });
    const waiting = server.waitForCallback();
    server.cancel();
    let err = null;
    try { await waiting; } catch (e) { err = e; }
    check('cancel rejects with OAuthCancelledError', err instanceof OAuthCancelledError, true);
    check('port released after cancel', await waitForPortFree(port), true);
    // A late callback must not resolve anything. The listener is gone, so the
    // request fails at the TCP level - that is the correct outcome.
    let lateOk = null;
    try { lateOk = (await httpGet(`http://127.0.0.1:${port}/callback?code=late`)).status; } catch { lateOk = 'conn refused'; }
    checkTrue('late callback cannot complete', lateOk === 'conn refused' || lateOk === 410);
}

// --- dispose: release without settling ----------------------------------------------
{
    const [port] = await freePortTriple();
    const server = await startLoopbackServer({ candidatePorts: [port], timeoutMs: 10_000 });
    server.waitForCallback(); // intentionally never awaited
    server.dispose();
    check('port released after dispose', await waitForPortFree(port), true);
}

// --- keep-alive pooled-socket regression ---------------------------------------------
// THE bug: a keep-alive agent pools its socket to the callback port. If the
// settled server does not destroy it, the SECOND flow's callback travels over
// the pooled socket to the FIRST server's (settled) handler and gets a 410.
{
    const [port] = await freePortTriple();
    const agent = new http.Agent({ keepAlive: true });

    const first = await startLoopbackServer({ candidatePorts: [port], expectedState: 'one', timeoutMs: 10_000 });
    // Establish a pooled keep-alive socket with a junk request.
    await httpGet(`http://127.0.0.1:${port}/probe`, agent);
    const firstWaiting = first.waitForCallback();
    check('first flow 200', (await httpGet(`http://127.0.0.1:${port}/callback?code=c1&state=one`, agent)).status, 200);
    check('first flow resolves', (await firstWaiting).code, 'c1');

    const second = await startLoopbackServer({ candidatePorts: [port], expectedState: 'two', timeoutMs: 10_000 });
    const secondWaiting = second.waitForCallback();
    // Same agent: reuses the pooled socket IF it survived. Correct behavior is
    // that settle() destroyed it, so this opens a fresh connection to `second`.
    const res = await httpGet(`http://127.0.0.1:${port}/callback?code=c2&state=two`, agent);
    check('pooled socket did not hijack second flow', res.status, 200);
    check('second flow resolves with its own code', (await secondWaiting).code, 'c2');
    agent.destroy();
}

console.log(failed === 0 ? '\noauth-server tests: all passed' : `\noauth-server tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
