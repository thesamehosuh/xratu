#!/usr/bin/env node
/**
 * Worker for the two-process refresh test in test-oauth-token-manager.mjs.
 * NOT a suite of its own (its name deliberately does not match test-*.mjs so
 * the host runner never picks it up).
 *
 *   node oauth-refresh-worker.mjs <lockDir> <storeFile> <logFile>
 *
 * Resolves a token through OAuthTokenManager against a JSON FILE store shared
 * with the other worker process. Every refresh invocation appends one line to
 * the log file - the parent asserts exactly one line across BOTH processes.
 */
import { createRequire } from 'module';
import * as fs from 'fs';
const require = createRequire(import.meta.url);
const { OAuthTokenManager } = require('../out/oauth/tokenManager.js');

const [lockDir, storeFile, logFile] = process.argv.slice(2);

const store = {
    async read(key) {
        try {
            const data = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
            return data[key] ?? null;
        } catch {
            return null;
        }
    },
    async write(key, tokens) {
        let data = {};
        try { data = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { /* empty */ }
        if (tokens === null) delete data[key]; else data[key] = tokens;
        fs.writeFileSync(storeFile, JSON.stringify(data));
    },
};

const NOW = Date.now();
const handler = {
    providerId: 'test',
    storageKey: 'k',
    canonicalBaseUrl: 'https://x/v1',
    login: async () => { throw new Error('unused'); },
    refresh: async () => {
        fs.appendFileSync(logFile, `refresh ${process.pid}\n`);
        // Slow enough that the other process is guaranteed to be waiting on
        // the lock (or to have read the stale record) before we write.
        await new Promise((r) => setTimeout(r, 500));
        return { kind: 'refreshed', tokens: { accessToken: 'AT-NEW', refreshToken: 'RT-2', expiresAt: NOW + 3_600_000 } };
    },
};

const manager = new OAuthTokenManager({ store, lockDir });

// BARRIER: announce that this process has read the (stale) record, then wait
// until BOTH processes have. Without it the test is a scheduling race - the
// loser may read the store after the winner already wrote its tokens, see a
// valid token, and skip the lock entirely, so "exactly one refresh" would be
// testing process startup order rather than the lock. With the barrier both
// processes provably hold the stale record, and the lock is the only thing
// standing between them and a second rotation.
const barrierFile = `${logFile}.readers`;
const expectedReaders = Number(process.argv[5] ?? 2);
fs.appendFileSync(barrierFile, `${process.pid}\n`);
const waitForBoth = setInterval(() => {
    let count = 0;
    try { count = fs.readFileSync(barrierFile, 'utf8').split('\n').filter(Boolean).length; } catch { count = 0; }
    if (count >= expectedReaders) {
        clearInterval(waitForBoth);
        resolveNow();
    }
}, 10);
setTimeout(() => {
    // Never hang the suite on a crashed sibling: proceed after a bounded wait.
    clearInterval(waitForBoth);
    resolveNow();
}, 10_000).unref();

let started = false;
function resolveNow() {
    if (started) return;
    started = true;
    manager.resolve(handler, { fetch: async () => { throw new Error('unused'); } })
        .then((token) => { console.log(token); })
        .catch((err) => { console.error(err); process.exit(1); });
}
