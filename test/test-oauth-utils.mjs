#!/usr/bin/env node
/**
 * OAuth unit tests - pkce, utils, registry, provider-error classification.
 *
 *  - PKCE challenge is verified against the RFC 7636 appendix B test vector
 *    (hand-recomputable, so a regression is caught without a live IdP).
 *  - parseOAuthErrorBody covers the observed-in-the-wild shapes: JSON string
 *    error, nested object error, form-encoded, percent-encoded, malformed,
 *    oversized (DROPPED, not truncated).
 *  - Expiry derivation order: explicit expiresAt -> JWT exp -> 0 (unknown =
 *    force refresh, never guess).
 *  - isInvalidGrantError: structured-code-first, substring only on small 400
 *    bodies (an injected proxy error page must not forge a logout).
 *  - resolveAuthorizationCodeInput: the manual-paste escape hatch accepts
 *    everything from a bare code to a full redirect URL.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-oauth-utils.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { generateVerifier, computeChallenge, generateState } = require('../out/oauth/pkce.js');
const {
    parseOAuthErrorBody,
    expiryFromJwt,
    tokenExpiryMs,
    isTokenExpired,
    resolveAuthorizationCodeInput,
    OAUTH_ERROR_BODY_MAX,
} = require('../out/oauth/utils.js');
const { isInvalidGrantError } = require('../out/providerErrors.js');
const {
    registerOAuthProvider,
    getOAuthProvider,
    listOAuthProviders,
    _resetOAuthRegistryForTests,
} = require('../out/oauth/providerAuthRegistry.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const checkTrue = (name, actual) => check(name, !!actual, true);

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (payload) => `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;

// --- PKCE --------------------------------------------------------------------

// RFC 7636 appendix B vector.
check(
    'challenge matches RFC 7636 appendix B',
    computeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
);
const verifier = generateVerifier();
check('verifier is 43 base64url chars', /^[A-Za-z0-9_-]{43}$/.test(verifier), true);
check('challenge is 43 base64url chars', /^[A-Za-z0-9_-]{43}$/.test(computeChallenge(verifier)), true);
checkTrue('verifiers are unique', generateVerifier() !== generateVerifier());
check('state is 32 base64url chars', /^[A-Za-z0-9_-]{32}$/.test(generateState()), true);
checkTrue('states are unique', generateState() !== generateState());

// --- parseOAuthErrorBody ------------------------------------------------------

check(
    'JSON string error',
    JSON.stringify(parseOAuthErrorBody('{"error":"invalid_grant","error_description":"expired"}')),
    JSON.stringify({ error: 'invalid_grant', description: 'expired' }),
);
check(
    'nested object error',
    JSON.stringify(parseOAuthErrorBody('{"error":{"code":"invalid_token","message":"reused"}}')),
    JSON.stringify({ error: 'invalid_token', description: 'reused' }),
);
check(
    'form-encoded',
    JSON.stringify(parseOAuthErrorBody('error=slow_down&error_description=wait+longer')),
    JSON.stringify({ error: 'slow_down', description: 'wait longer' }),
);
check(
    'percent-encoded description',
    parseOAuthErrorBody('error=access_denied&error_description=user%20said%20no')?.description,
    'user said no',
);
check('malformed JSON -> null', parseOAuthErrorBody('{"error":'), null);
check('empty body -> null', parseOAuthErrorBody(''), null);
check('whitespace body -> null', parseOAuthErrorBody('   '), null);
check('JSON without error -> null', parseOAuthErrorBody('{"foo":1}'), null);
check('plain text -> null', parseOAuthErrorBody('Internal Server Error'), null);
// Oversized: a valid marker hidden in a huge body must be DROPPED, not
// truncated-read (Codex's rule - a prefix can evade redaction/classification).
const huge = `{"error":"invalid_grant","pad":"${'x'.repeat(OAUTH_ERROR_BODY_MAX)}` + '"}';
check('oversized body dropped whole', parseOAuthErrorBody(huge), null);

// --- expiry derivation --------------------------------------------------------

const EXP = 2000000000; // 2033
check('JWT exp derived', expiryFromJwt(jwt({ exp: EXP })), EXP * 1000);
check('non-JWT -> null', expiryFromJwt('opaque-token'), null);
check('JWT without exp -> null', expiryFromJwt(jwt({ sub: 'x' })), null);
check('JWT with garbage exp -> null', expiryFromJwt(jwt({ exp: 'soon' })), null);

check('explicit expiresAt wins over JWT', tokenExpiryMs({ accessToken: jwt({ exp: EXP }), expiresAt: 123 }), 123);
check('JWT used when expiresAt absent', tokenExpiryMs({ accessToken: jwt({ exp: EXP }) }), EXP * 1000);
check('JWT used when expiresAt is 0', tokenExpiryMs({ accessToken: jwt({ exp: EXP }), expiresAt: 0 }), EXP * 1000);
check('unknown -> 0', tokenExpiryMs({ accessToken: 'opaque', expiresAt: 0 }), 0);

const NOW = 1_700_000_000_000;
check('far-future token not expired', isTokenExpired({ accessToken: 'x', expiresAt: NOW + 3_600_000 }, 60_000, NOW), false);
check('within skew counts as expired', isTokenExpired({ accessToken: 'x', expiresAt: NOW + 30_000 }, 60_000, NOW), true);
check('past token expired', isTokenExpired({ accessToken: 'x', expiresAt: NOW - 1 }, 60_000, NOW), true);
check('unknown expiry counts as expired', isTokenExpired({ accessToken: 'opaque', expiresAt: 0 }, 60_000, NOW), true);

// --- isInvalidGrantError ------------------------------------------------------

check('400 invalid_grant JSON', isInvalidGrantError(400, '{"error":"invalid_grant"}'), true);
check('401 invalid_token JSON', isInvalidGrantError(401, '{"error":"invalid_token"}'), true);
check('403 form error=expired_token', isInvalidGrantError(403, 'error=expired_token&x=1'), true);
check('400 revoked code', isInvalidGrantError(400, '{"error":"revoked"}'), true);
check('500 with invalid_grant is NOT permanent', isInvalidGrantError(500, '{"error":"invalid_grant"}'), false);
check('400 temporarily_unavailable', isInvalidGrantError(400, '{"error":"temporarily_unavailable"}'), false);
check('400 empty body', isInvalidGrantError(400, ''), false);
check('401 empty body', isInvalidGrantError(401, ''), false);
check('small 400 substring fallback', isInvalidGrantError(400, 'The grant is invalid_grant now'), true);
check('401 substring NOT trusted', isInvalidGrantError(401, 'invalid_grant'), false);
// An injected proxy HTML page mentioning "revoked" must not forge a logout.
const injectedPage = `<html>${'<!-- pad -->'.repeat(400)}<p>token revoked</p></html>`;
checkTrue('injected page exceeds substring cap', injectedPage.length > 4096);
check('big injected 400 page not permanent', isInvalidGrantError(400, injectedPage), false);
check('big injected 401 page not permanent', isInvalidGrantError(401, injectedPage), false);

// --- resolveAuthorizationCodeInput ---------------------------------------------

check('bare code', resolveAuthorizationCodeInput('abc123'), 'abc123');
check('full URL', resolveAuthorizationCodeInput('http://127.0.0.1:1455/callback?code=XYZ&state=s'), 'XYZ');
check('fragment code', resolveAuthorizationCodeInput('http://127.0.0.1:1455/callback#code=FRAG&state=s'), 'FRAG');
check('bare code= paste', resolveAuthorizationCodeInput('code=PASTE&state=s'), 'PASTE');
check('code#state fragment', resolveAuthorizationCodeInput('CODEVAL#state123'), 'CODEVAL');
check('URL without code -> null', resolveAuthorizationCodeInput('http://127.0.0.1:1455/callback?state=s'), null);
check('empty -> null', resolveAuthorizationCodeInput('   '), null);
check('whitespace trimmed', resolveAuthorizationCodeInput('  padded  '), 'padded');

// --- registry ------------------------------------------------------------------

_resetOAuthRegistryForTests();
const handler = {
    providerId: 'test-provider',
    storageKey: 'test-key',
    canonicalBaseUrl: 'https://example.com/v1',
    login: async () => { throw new Error('unused'); },
    refresh: async () => ({ kind: 'reauth' }),
};
registerOAuthProvider(handler);
check('registry get', getOAuthProvider('test-provider'), handler);
check('registry list length', listOAuthProviders().length, 1);
check('unknown id -> undefined', getOAuthProvider('nope'), undefined);
let threw = false;
try { registerOAuthProvider(handler); } catch { threw = true; }
check('duplicate registration throws', threw, true);
threw = false;
try { registerOAuthProvider({ ...handler, providerId: 'other', storageKey: '' }); } catch { threw = true; }
check('missing storageKey throws', threw, true);
_resetOAuthRegistryForTests();
check('reset clears', listOAuthProviders().length, 0);

console.log(failed === 0 ? '\noauth-utils tests: all passed' : `\noauth-utils tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
