#!/usr/bin/env node
/**
 * Dev-loop helper tests for `src/devWebview.ts`.
 *
 * These guard two opt-in developer features that ship in the extension host:
 *
 *  - XRATU_DEV_WEBVIEW_URL rewrites the webview to load the app from a Vite
 *    dev server. The URL is interpolated into a CSP and into script `src`
 *    attributes, so accepting a non-http protocol here would be an XSS
 *    vector in a developer's own editor - hence the rejection tests below.
 *
 *  - XRATU_WEBVIEW_LOG records host→webview envelopes to a JSONL tape. The
 *    recorder sits on the delivery path for EVERY message the UI renders, so
 *    an exception escaping it would take down the chat panel.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-dev-webview.mjs
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    parseDevWebviewUrl,
    webSocketUrl,
    buildDevWebviewHtml,
    createRecordedPostMessage,
    parseTape,
} = require('../out/devWebview.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const SOURCE_HTML = `<!DOCTYPE html>
<html lang="fa">
    <head>
        <meta charset="UTF-8" />
        <title>Xratu Chat</title>
    </head>
    <body dir="auto">
        <div id="root"></div>
        <script type="module" src="/src/main.tsx"></script>
    </body>
</html>`;

// --- URL validation -------------------------------------------------------
check('absent url is rejected', parseDevWebviewUrl(undefined), null);
check('empty url is rejected', parseDevWebviewUrl('   '), null);
check('unparseable url is rejected', parseDevWebviewUrl('not a url'), null);
check('javascript: url is rejected', parseDevWebviewUrl('javascript:alert(1)'), null);
check('data: url is rejected', parseDevWebviewUrl('data:text/html,<script>'), null);
check('file: url is rejected', parseDevWebviewUrl('file:///etc/passwd'), null);
check('http url is accepted', parseDevWebviewUrl('http://localhost:5173'), 'http://localhost:5173');
check('https url is accepted', parseDevWebviewUrl('https://127.0.0.1:5173'), 'https://127.0.0.1:5173');
check('trailing slash is normalised', parseDevWebviewUrl('http://localhost:5173/'), 'http://localhost:5173');
check('surrounding whitespace is trimmed', parseDevWebviewUrl('  http://localhost:5173\n'), 'http://localhost:5173');
check('a mount path is preserved', parseDevWebviewUrl('http://localhost:5173/app/'), 'http://localhost:5173/app');

// --- HMR socket -----------------------------------------------------------
check('http becomes ws', webSocketUrl('http://localhost:5173'), 'ws://localhost:5173');
check('https becomes wss', webSocketUrl('https://127.0.0.1:5173'), 'wss://127.0.0.1:5173');

// --- dev document ---------------------------------------------------------
const DEV = 'http://localhost:5173';
const built = buildDevWebviewHtml({ sourceHtml: SOURCE_HTML, devUrl: DEV, locale: 'en', nonce: 'TESTNONCE' });

check('a missing entry tag yields null instead of a blank page',
    buildDevWebviewHtml({ sourceHtml: '<html><head></head><body></body></html>', devUrl: DEV, locale: 'fa', nonce: 'N' }),
    null);
check('the source document is understood', built !== null, true);

check('entry is rewritten to the absolute dev URL',
    built.includes(`type="module" src="${DEV}/src/main.tsx"`), true);
check('the vite client is loaded for HMR',
    built.includes(`${DEV}/@vite/client`), true);
check('the vite client precedes the entry (or no change ever applies)',
    built.indexOf('/@vite/client') < built.indexOf('/src/main.tsx'), true);
check('the local /src/main.tsx path is gone (it would 404 in a webview)',
    built.includes('src="/src/main.tsx"'), false);
check('CSP allows the dev origin for scripts',
    built.includes(`script-src ${DEV} 'nonce-TESTNONCE'`), true);
check('CSP allows the HMR socket',
    built.includes('connect-src http://localhost:5173 ws://localhost:5173'), true);
check('CSP still forbids default-src', built.includes("default-src 'none'"), true);
check('the locale is baked before first paint',
    built.includes('window.XRATU_LOCALE="en"'), true);
check('CSP references the nonce for scripts', built.includes(`'nonce-TESTNONCE'`), true);
check('the locale bootstrap carries the nonce', built.includes('<script nonce="TESTNONCE">window.XRATU_LOCALE'), true);
check('the CSP nonce and the script nonce match',
    built.includes(`script-src ${DEV} 'nonce-TESTNONCE'`) && built.includes('<script nonce="TESTNONCE">'), true);

// --- recorder -------------------------------------------------------------
{
    const seen = [];
    const lines = [];
    const wrapped = createRecordedPostMessage((msg) => { seen.push(msg); return true; }, (l) => lines.push(l));
    const out = wrapped({ type: 'showChat' });
    check('the recorder forwards the message', seen, [{ type: 'showChat' }]);
    check('the recorder keeps the original return value', out, true);
    check('the recorder writes one JSONL line', lines.length, 1);

    const parsed = parseTape(lines.join(''));
    check('the tape round-trips', parsed.length, 1);
    check('the tape carries the message', parsed[0].message, { type: 'showChat' });
    check('the tape carries a timestamp', typeof parsed[0].at, 'number');
}

{
    // The recorder sits on the delivery path for every message the UI renders.
    let delivered = 0;
    const wrapped = createRecordedPostMessage(
        () => { delivered++; return false; },
        () => { throw new Error('ENOSPC: disk full'); },
    );
    let threw = false;
    try {
        wrapped({ type: 'chatChunk' });
    } catch {
        threw = true;
    }
    check('an fs failure does not reach the caller', threw, false);
    check('an fs failure does not stop delivery', delivered, 1);
}

{
    const clean = parseTape('{"at":1,"message":{"type":"a"}}\n{"at":2,"message":{"type":"b"}}\n');
    check('two lines parse to two entries', clean.length, 2);
    const truncated = parseTape('{"at":1,"message":{"type":"a"}}\n{"at":2,"mess');
    check('a truncated tail line is skipped, not fatal', truncated.length, 1);
    check('junk lines are skipped', parseTape('not json\n\n{"at":3,"message":{}}\n').length, 1);
    check('lines missing the tape shape are skipped', parseTape('{"message":{}}\n').length, 0);
}

console.log(failed === 0 ? '\nAll dev-webview tests passed.' : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
