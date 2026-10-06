#!/usr/bin/env node
/**
 * Replay a recorded host→webview session into a real browser.
 *
 * Why this exists: "the UI got stuck after the 12th tool call" is otherwise
 * unreproducible, because the sequence lives only in the reporter's running
 * extension. With `XRATU_WEBVIEW_LOG=/tmp/tape.jsonl` the host writes every
 * envelope it delivers, and this script plays that tape back into the same
 * bundle the extension ships - no VS Code, no credentials, no burning tokens.
 *
 *   node test/e2e/replay.mjs /tmp/tape.jsonl
 *   node test/e2e/replay.mjs /tmp/tape.jsonl --shot after.png --locale en
 *   node test/e2e/replay.mjs /tmp/tape.jsonl --dump-out responses.jsonl
 *
 * It is deliberately NOT a spec: it is an investigation tool, so it never
 * asserts and can never make CI red.
 *
 * It also records what the WEBVIEW sent back, so two runs (a passing one and
 * a broken one) can be diffed to find the first divergent message.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

function usage(code) {
    console.log(`usage: node test/e2e/replay.mjs <tape.jsonl> [options]

  --shot <path>     write a screenshot of the final state
  --dump-out <path> write the webview's outbound messages as JSONL
  --locale <fa|en>  initial UI locale (default fa, matching the host)
  --delay <ms>      wait between envelopes (default 0)
  --port <n>        static server port (default 4180, avoids the e2e 4173)
  --timeout <ms>    overall cap (default 30000)`);
    process.exit(code);
}

const argv = process.argv.slice(2);
const tapePath = argv.find((a) => !a.startsWith('--'));
if (!tapePath || argv.includes('--help') || argv.includes('-h')) usage(tapePath ? 0 : 1);

const opt = { shot: null, dumpOut: null, locale: 'fa', delay: 0, port: 4180, timeout: 30000 };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shot') opt.shot = argv[++i];
    else if (a === '--dump-out') opt.dumpOut = argv[++i];
    else if (a === '--locale') opt.locale = argv[++i];
    else if (a === '--delay') opt.delay = Number(argv[++i]);
    else if (a === '--port') opt.port = Number(argv[++i]);
    else if (a === '--timeout') opt.timeout = Number(argv[++i]);
    else if (a === tapePath) continue;
    else { console.error(`unknown option: ${a}`); usage(2); }
}

if (!existsSync(tapePath)) {
    console.error(`replay: ${tapePath} not found`);
    process.exit(1);
}
if (!existsSync(join(repoRoot, 'dist', 'webview-ui', 'index.html'))) {
    console.error('replay: dist/webview-ui/index.html missing - run: npm run build:webview');
    process.exit(1);
}

const raw = readFileSync(tapePath, 'utf-8');
const entries = [];
for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
        const parsed = JSON.parse(t);
        if (parsed && parsed.message) entries.push(parsed);
    } catch {
        // truncated tail of a live log
    }
}
if (entries.length === 0) {
    console.error('replay: no usable entries in the tape');
    process.exit(1);
}

// --- static server --------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [join(here, 'serve.mjs'), join(repoRoot, 'dist', 'webview-ui'), String(opt.port)], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
});
let serverReady = false;
let serverError = null;
server.stdout.on('data', (c) => { if (String(c).includes('serving')) serverReady = true; });
server.on('error', (err) => { serverError = err; });

for (let i = 0; i < 100 && !serverReady && !serverError; i++) await sleep(100);
if (serverError || !serverReady) {
    console.error(`replay: static server did not become ready${serverError ? `: ${serverError.message}` : ''}`);
    server.kill();
    process.exit(1);
}

// --- drive the page -------------------------------------------------------
let browser;
const outbound = [];
const started = Date.now();
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
    page.on('console', (m) => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });

    await page.addInitScript(({ locale }) => {
        const sent = [];
        window.__xratuHostMessages = sent;
        window.XRATU_LOCALE = locale;
        window.acquireVsCodeApi = () => ({
            postMessage: (message) => { sent.push(message); },
            getState: () => undefined,
            setState: (state) => state,
        });
    }, { locale: opt.locale });

    await page.goto(`http://127.0.0.1:${opt.port}/`, { waitUntil: 'domcontentloaded' });

    for (const entry of entries) {
        await page.evaluate((msg) => window.postMessage(msg, '*'), entry.message);
        if (opt.delay > 0) await page.waitForTimeout(opt.delay);
    }

    // Let the app settle: chunk streams, timers and layout are all async.
    await page.waitForTimeout(300);

    const collected = await page.evaluate(() => window.__xratuHostMessages ?? []);
    outbound.push(...collected);

    if (opt.shot) {
        await page.screenshot({ path: opt.shot, fullPage: true });
        console.log(`replay: wrote ${opt.shot}`);
    }
    const appPresent = await page.evaluate(() => Boolean(document.querySelector('.app')));
    console.log(`replay: ${entries.length} envelopes, ${outbound.length} returned, .app=${appPresent ? 'present' : 'MISSING'}`);
    if (!appPresent) {
        console.log('replay: the app shell never mounted - the tape is unlikely to be at fault; check the page errors above');
    }
} catch (err) {
    console.error('replay: failed:', err.message);
    process.exitCode = 1;
} finally {
    if (opt.dumpOut) {
        writeFileSync(opt.dumpOut, `${outbound.map((m) => JSON.stringify({ at: 0, message: m })).join('\n')}\n`);
        console.log(`replay: wrote ${outbound.length} outbound messages to ${opt.dumpOut}`);
    }
    await browser?.close();
    server.kill();
    console.log(`replay: done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
