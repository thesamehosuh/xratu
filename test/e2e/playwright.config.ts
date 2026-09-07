import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const PORT = 4173;
const WEBVIEW_DIST = join(__dirname, '..', '..', 'dist', 'webview-ui');

export default defineConfig({
    testDir: __dirname,
    // The webview mounts once per page load; parallel workers each get their
    // own browser context, so workers are safe - but keep the run small.
    fullyParallel: true,
    workers: 2,
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        viewport: { width: 900, height: 900 },
    },
    webServer: {
        command: `node ${join('serve.mjs')} "${WEBVIEW_DIST}" ${PORT}`,
        url: `http://127.0.0.1:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 15_000,
    },
});
