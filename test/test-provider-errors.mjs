#!/usr/bin/env node
/**
 * Provider HTTP error classification tests (geo-block / auth / rate limit).
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-provider-errors.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    classifyProviderHttpError,
    providerHttpStatus,
    isGeoBlockedError,
    PROVIDER_HTTP_STATUS_CODE,
} = require('../out/providerErrors.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

// --- auth / rate limit -------------------------------------------------------
check('401 -> auth', classifyProviderHttpError(401, 'invalid api key'), 'auth');
check('429 -> rateLimited', classifyProviderHttpError(429, 'too many requests'), 'rateLimited');

// --- geo-block ---------------------------------------------------------------
check(
    '403 + country not supported',
    classifyProviderHttpError(403, 'This model is not available in your country.'),
    'geoBlocked',
);
check(
    '403 + unsupported region',
    classifyProviderHttpError(403, 'unsupported region'),
    'geoBlocked',
);
check(
    '403 + country not supported phrasing',
    classifyProviderHttpError(403, 'Country not supported'),
    'geoBlocked',
);
check(
    '403 + access denied ... region',
    classifyProviderHttpError(403, 'Access denied for users in your region'),
    'geoBlocked',
);
check(
    '403 + region not supported',
    classifyProviderHttpError(403, 'your region is not supported'),
    'geoBlocked',
);
check('451 always geoBlocked', classifyProviderHttpError(451, ''), 'geoBlocked');
check(
    '403 without wording -> other',
    classifyProviderHttpError(403, 'permission denied for this resource'),
    'other',
);
check('500 -> other', classifyProviderHttpError(500, 'internal error'), 'other');
check('404 -> other', classifyProviderHttpError(404, 'not found'), 'other');

// --- status extraction -------------------------------------------------------
const tagged = { code: PROVIDER_HTTP_STATUS_CODE, status: 403, body: 'nope' };
check('providerHttpStatus reads tagged error', providerHttpStatus(tagged)?.status, 403);
check('providerHttpStatus reads body', providerHttpStatus(tagged)?.body, 'nope');
check('providerHttpStatus rejects untagged', providerHttpStatus(new Error('x')), null);
check('providerHttpStatus rejects null', providerHttpStatus(null), null);
check('isGeoBlockedError tagged geo', isGeoBlockedError(tagged), false);
check(
    'isGeoBlockedError tagged geo body',
    isGeoBlockedError({ code: PROVIDER_HTTP_STATUS_CODE, status: 403, body: 'not available in your country' }),
    true,
);

console.log(failed === 0 ? '\nprovider-errors tests: all passed' : `\nprovider-errors tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
