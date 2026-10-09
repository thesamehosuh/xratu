#!/usr/bin/env node
/**
 * Device flow (RFC 8628) tests - injected fetch, virtual clock.
 *
 *  - positiveSeconds is the NaN busy-loop killer: NaN/"NaN"/null/-5/0 all
 *    fall back instead of reaching setTimeout as 0 (opencode xai.ts bug).
 *  - authorization_pending keeps polling; slow_down adds exactly 5s to the
 *    interval; terminal codes (access_denied, expired_token) throw with the
 *    RFC code preserved for i18n mapping.
 *  - The deadline from expires_in is hard: a server that answers pending
 *    forever cannot pin the flow open.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-oauth-device-flow.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { requestDeviceAuthorization, pollDeviceToken, positiveSeconds } = require('../out/oauth/deviceFlow.js');
const { OAuthFlowError } = require('../out/oauth/types.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const checkTrue = (name, actual) => check(name, !!actual, true);

const jsonResponse = (status, obj) => new Response(JSON.stringify(obj), { status });

// --- positiveSeconds: the NaN busy-loop killer ---------------------------------
check('normal number', positiveSeconds(7, 5), 7);
check('numeric string', positiveSeconds('9', 5), 9);
check('NaN falls back', positiveSeconds(NaN, 5), 5);
check('"NaN" string falls back', positiveSeconds('NaN', 5), 5);
check('null falls back', positiveSeconds(null, 5), 5);
check('undefined falls back', positiveSeconds(undefined, 5), 5);
check('negative falls back', positiveSeconds(-5, 5), 5);
check('zero falls back', positiveSeconds(0, 5), 5);
check('Infinity falls back', positiveSeconds(Infinity, 5), 5);
check('capped at 60', positiveSeconds(300, 5), 60);
check('custom cap', positiveSeconds(9999, 5, 900), 900);

// The default sleep releases its abort listener on ordinary timer completion.
{
    const controller = new AbortController();
    const signal = controller.signal;
    let added = 0;
    let removed = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => { if (args[0] === 'abort') added++; return add(...args); };
    signal.removeEventListener = (...args) => { if (args[0] === 'abort') removed++; return remove(...args); };
    let polls = 0;
    const result = await require('../out/oauth/deviceFlow.js').pollUntilAuthorized({
        intervalS: 0.001,
        expiresIn: 2,
        signal,
        attempt: async () => ({ done: ++polls === 12, value: 'authorized' }),
    });
    check('default poll sleep reaches authorization', result, 'authorized');
    check('default poll sleep adds one abort listener per wait', added, 12);
    check('default poll sleep removes each completed timer listener', removed, 12);
}

// --- requestDeviceAuthorization ---------------------------------------------------
{
    const fetch = async () => jsonResponse(200, {
        device_code: 'dc', user_code: 'ABCD-1234',
        verification_uri: 'https://idp.example/device',
        verification_uri_complete: 'https://idp.example/device?code=ABCD-1234',
        interval: '5', expires_in: 900,
    });
    const auth = await requestDeviceAuthorization({ url: 'https://idp.example/device', clientId: 'cid', fetch });
    check('device_code', auth.deviceCode, 'dc');
    check('user_code', auth.userCode, 'ABCD-1234');
    check('verification_uri', auth.verificationUri, 'https://idp.example/device');
    check('verification_uri_complete', auth.verificationUriComplete, 'https://idp.example/device?code=ABCD-1234');
    check('string interval hardened to number', auth.interval, 5);
    check('expires_in honored', auth.expiresIn, 900);
}
{
    // verification_url alias (some IdPs) + missing optionals.
    const fetch = async () => jsonResponse(200, {
        device_code: 'dc', user_code: 'UC', verification_url: 'https://idp.example/activate',
    });
    const auth = await requestDeviceAuthorization({ url: 'x', clientId: 'cid', fetch });
    check('verification_url alias', auth.verificationUri, 'https://idp.example/activate');
    check('defaults: interval', auth.interval, 5);
    check('defaults: expiresIn', auth.expiresIn, 900);
}
{
    const fetch = async () => jsonResponse(200, { user_code: 'UC' }); // no device_code
    let err = null;
    try { await requestDeviceAuthorization({ url: 'x', clientId: 'c', fetch }); } catch (e) { err = e; }
    check('missing fields -> bad_response', err?.code, 'bad_response');
}
{
    const fetch = async () => jsonResponse(403, { error: 'access_denied', error_description: 'nope' });
    let err = null;
    try { await requestDeviceAuthorization({ url: 'x', clientId: 'c', fetch }); } catch (e) { err = e; }
    check('non-200 carries RFC code', err?.code, 'access_denied');
}

// --- pollDeviceToken ---------------------------------------------------------------
/** Scripted fetch + virtual clock; records sleep durations. Script entries
 *  are RESPONSE FACTORIES: a Response is single-use, so returning the same
 *  instance twice would fail the second poll with "body already consumed". */
function rig(script) {
    const sleeps = [];
    let now = 0;
    let i = 0;
    const fetch = async () => script[Math.min(i++, script.length - 1)]();
    const sleep = async (ms) => { sleeps.push(ms); now += ms; };
    return { sleeps, fetch, sleep, nowMs: () => now };
}
const respond = (status, obj) => () => new Response(
    typeof obj === 'string' ? obj : JSON.stringify(obj),
    { status },
);
const baseOpts = { url: 'x', clientId: 'c', deviceCode: 'dc', interval: 5, expiresIn: 900 };

{
    const r = rig([
        respond(400, { error: 'authorization_pending' }),
        respond(400, { error: 'authorization_pending' }),
        respond(200, { access_token: 'AT', expires_in: 3600 }),
    ]);
    const out = await pollDeviceToken({ ...baseOpts, fetch: r.fetch, sleep: r.sleep, nowMs: r.nowMs });
    check('pending then success', out.access_token, 'AT');
    check('polled at the stated interval', JSON.stringify(r.sleeps), JSON.stringify([5000, 5000, 5000]));
}
{
    const r = rig([
        respond(400, { error: 'slow_down' }),
        respond(200, { access_token: 'AT' }),
    ]);
    const out = await pollDeviceToken({ ...baseOpts, fetch: r.fetch, sleep: r.sleep, nowMs: r.nowMs });
    check('slow_down then success', out.access_token, 'AT');
    check('slow_down adds exactly 5s', JSON.stringify(r.sleeps), JSON.stringify([5000, 10000]));
}
{
    const r = rig([respond(400, { error: 'access_denied', error_description: 'refused' })]);
    let err = null;
    try { await pollDeviceToken({ ...baseOpts, fetch: r.fetch, sleep: r.sleep, nowMs: r.nowMs }); } catch (e) { err = e; }
    check('access_denied throws with code', err?.code, 'access_denied');
    checkTrue('description carried', String(err?.message).includes('refused'));
}
{
    const r = rig([respond(400, { error: 'expired_token' })]);
    let err = null;
    try { await pollDeviceToken({ ...baseOpts, fetch: r.fetch, sleep: r.sleep, nowMs: r.nowMs }); } catch (e) { err = e; }
    check('expired_token throws with code', err?.code, 'expired_token');
}
{
    // Pending forever: the expires_in deadline must end it. Virtual clock
    // advances 5s per sleep, expiresIn is 12s -> dies on the third check.
    const r = rig([respond(400, { error: 'authorization_pending' })]);
    let err = null;
    try {
        await pollDeviceToken({ ...baseOpts, expiresIn: 12, fetch: r.fetch, sleep: r.sleep, nowMs: r.nowMs });
    } catch (e) { err = e; }
    check('deadline ends an endless pending', err?.code, 'expired_token');
}
{
    const r = rig([respond(200, 'not json')]);
    let err = null;
    try { await pollDeviceToken({ ...baseOpts, fetch: r.fetch, sleep: r.sleep, nowMs: r.nowMs }); } catch (e) { err = e; }
    check('200 with non-JSON -> bad_response', err?.code, 'bad_response');
}
{
    // Unknown error codes throw (no silent retry on e.g. invalid_client).
    const r = rig([respond(400, { error: 'invalid_client' })]);
    let err = null;
    try { await pollDeviceToken({ ...baseOpts, fetch: r.fetch, sleep: r.sleep, nowMs: r.nowMs }); } catch (e) { err = e; }
    check('unknown code throws', err?.code, 'invalid_client');
    checkTrue('is OAuthFlowError', err instanceof OAuthFlowError);
}
{
    // Cancel: an already-aborted signal stops the loop before the first poll.
    const r = rig([respond(200, { access_token: 'AT' })]);
    const ctrl = new AbortController();
    ctrl.abort();
    let err = null;
    try {
        await pollDeviceToken({ ...baseOpts, fetch: r.fetch, sleep: r.sleep, nowMs: r.nowMs, signal: ctrl.signal });
    } catch (e) { err = e; }
    check('aborted signal cancels', err?.code, 'cancelled');
}
{
    // Interval from a misbehaving server: NaN must not busy-loop.
    const r = rig([respond(200, { access_token: 'AT' })]);
    const out = await pollDeviceToken({ ...baseOpts, interval: NaN, fetch: r.fetch, sleep: r.sleep, nowMs: r.nowMs });
    check('NaN interval still succeeds', out.access_token, 'AT');
    check('NaN interval fell back to 5s', JSON.stringify(r.sleeps), JSON.stringify([5000]));
}

console.log(failed === 0 ? '\noauth-device-flow tests: all passed' : `\noauth-device-flow tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
