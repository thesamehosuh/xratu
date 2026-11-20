import { defineConfig } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.XRATU_E2E_PORT ?? 4173);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid XRATU_E2E_PORT');
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
    // Each test gets its own browser context, so parallel workers are safe.
    fullyParallel: true,
    // Keep one worker on Windows to avoid loopback socket-buffer exhaustion
    // when repeatedly fetching the single-file (~6 MB) webview bundle.
    workers: process.platform === 'win32'
        ? 1
        : (process.env.CI ? 4 : Math.max(2, Math.min(4, availableParallelism() - 1))),
    use: {
        // Preserve the action timeline for CI failures, including test timeouts.
        trace: process.env.CI ? 'retain-on-failure' : 'off',
        baseURL: `http://127.0.0.1:${PORT}`,
        viewport: { width: 900, height: 900 },
        ...(() => {
            const executablePath = localChromiumExecutable();
            // Host fontconfig defaults differ even on Linux. Keep snapshot
            // text grayscale and unhinted so the bundled font renders alike.
            // Exercise Windows middle-click autoscroll on every OS so Linux
            // catches tab-closing regressions too.
            const args = ['--enable-blink-features=MiddleClickAutoscroll', ...(process.env.XRATU_VISUAL === '1'
                ? ['--disable-lcd-text', '--font-render-hinting=none'] : [])];
            return { launchOptions: { executablePath, args } };
        })(),
    },
    webServer: {
        command: `node ${join('serve.mjs')} "${WEBVIEW_DIST}" ${PORT}`,
        url: `http://127.0.0.1:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 15_000,
    },
});
