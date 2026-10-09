import { defineConfig } from '@playwright/test';
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
    // Pixel baselines must use the lockfile-pinned headless shell locally too.
    if (process.env.CI || process.env.XRATU_VISUAL === '1') return undefined;
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
    // `approval-prototypes.spec.ts` and `approval-shots.spec.ts` are manual
    // review harnesses, not gates: they only write PNGs of the states a human
    // needs to look at. Running them in CI would produce screenshot artifacts
    // nobody reads while still reporting green. Opt in with
    // XRATU_SCREENSHOTS=1.
    //
    // `screenshots.spec.ts` is NOT ignored any more: it carries the theme
    // contract (the CI gate for webview-ui/src/styles/theme.css) - computed
    // styles rather than pixels, because committed PNG baselines turned out to
    // be machine-specific. Its own manual half skips itself unless
    // XRATU_SCREENSHOTS is set.
    testIgnore: process.env.XRATU_SCREENSHOTS
        ? []
        : ['**/approval-prototypes.spec.ts', '**/approval-shots.spec.ts'],
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
            // Host fontconfig defaults differ even on Linux. Keep snapshot
            // text grayscale and unhinted so the bundled font renders alike.
            const args = process.env.XRATU_VISUAL === '1'
                ? ['--disable-lcd-text', '--font-render-hinting=none'] : undefined;
            return executablePath || args ? { launchOptions: { executablePath, args } } : {};
        })(),
    },
    webServer: {
        command: `node ${join('serve.mjs')} "${WEBVIEW_DIST}" ${PORT}`,
        url: `http://127.0.0.1:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 15_000,
    },
});
