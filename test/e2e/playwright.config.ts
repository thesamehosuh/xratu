import { defineConfig, chromium } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = 4173;
const WEBVIEW_DIST = join(__dirname, '..', '..', 'dist', 'webview-ui');

/**
 * Newest chromium build in the Playwright cache, used when the registry
 * build pinned to this Playwright release is absent - e.g. a machine that
 * only has the chrome-for-testing build @playwright/mcp installs. CI
 * installs the pinned build, so the default launch stays untouched there.
 */
function localChromiumExecutable(): string | undefined {
    if (process.env.CI) return undefined;
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
        || (process.platform === 'win32'
            ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
            : process.platform === 'darwin'
                ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
                : join(homedir(), '.cache', 'ms-playwright'));
    if (!existsSync(cache)) return undefined;
    const layouts = process.platform === 'win32'
        ? [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']]
        : process.platform === 'darwin'
            ? [['chrome-mac', 'Chromium.app/Contents/MacOS/Chromium']]
            : [['chrome-linux64', 'chrome']];
    // Build ids are numbers, not strings: a string sort would rank
    // `chromium-999` above `chromium-1246` and pick the older build.
    const builds = readdirSync(cache)
        .map((dir) => ({ dir, build: Number(dir.replace(/^chromium-/, '')) }))
        .filter((c) => Number.isInteger(c.build))
        .sort((a, b) => b.build - a.build);
    for (const { dir } of builds) {
        for (const [sub, exe] of layouts) {
            const candidate = join(cache, dir, sub, exe);
            if (existsSync(candidate)) return candidate;
        }
    }
    return undefined;
}

export default defineConfig({
    testDir: __dirname,
    // `screenshots.spec.ts`, `approval-prototypes.spec.ts` and
    // `approval-shots.spec.ts` are manual review harnesses, not gates: they
    // only write PNGs of the states a human needs to look at. Running them in
    // CI would produce screenshot artifacts nobody reads while still reporting
    // green. Opt in with XRATU_SCREENSHOTS=1.
    testIgnore: process.env.XRATU_SCREENSHOTS
        ? []
        : ['**/screenshots.spec.ts', '**/approval-prototypes.spec.ts', '**/approval-shots.spec.ts'],
    // The webview mounts once per page load; parallel workers each get their
    // own browser context, so workers are safe - but keep the run small.
    fullyParallel: true,
    // ONE worker on Windows. The built bundle is a single ~12MB HTML file, so
    // every `page.goto` pulls 12MB over loopback; two concurrent workers
    // exhausted the runner's socket buffers and the run died on
    // `net::ERR_NO_BUFFER_SPACE` - a transport failure, not an assertion.
    // Serializing fixes the cause instead of retrying over it, because a
    // blanket `retries` would also re-run real assertion failures and hide them.
    workers: process.platform === 'win32' ? 1 : 2,
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        viewport: { width: 900, height: 900 },
        ...(() => {
            const executablePath = localChromiumExecutable();
            return executablePath ? { launchOptions: { executablePath } } : {};
        })(),
    },
    webServer: {
        command: `node ${join('serve.mjs')} "${WEBVIEW_DIST}" ${PORT}`,
        url: `http://127.0.0.1:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 15_000,
    },
});
