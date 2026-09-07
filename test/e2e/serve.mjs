/**
 * Minimal static file server for the Playwright E2E suite.
 *
 * Serves the built single-file webview (dist/webview-ui) over HTTP so the
 * bundle can be loaded in a plain browser without VS Code.  A tiny
 * dependency-free server is used instead of `vite preview` so the E2E step
 * never depends on dev-server semantics or port negotiation quirks across
 * CI runners (Windows included).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join('dist', 'webview-ui'));
const PORT = Number(process.argv[3] ?? 4173);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.map': 'application/json',
};

try {
    await stat(join(ROOT, 'index.html'));
} catch {
    console.error(`[e2e-server] ${join(ROOT, 'index.html')} not found - run "npm run build:webview" first.`);
    process.exit(1);
}

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        // Guard against path traversal - `startsWith` alone would accept
        // sibling dirs (e.g. ROOT + "-private"), so require `relative` to
        // resolve inside ROOT.
        const abs = resolve(join(ROOT, rel));
        const relToRoot = relative(ROOT, abs);
        if (relToRoot === '' || relToRoot === '..' || relToRoot.startsWith(`..${sep}`) || resolve(relToRoot) === relToRoot) {
            res.writeHead(403).end();
            return;
        }
        const body = await readFile(abs);
        res.writeHead(200, { 'Content-Type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream' });
        res.end(body);
    } catch {
        res.writeHead(404).end('Not found');
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[e2e-server] serving ${ROOT} at http://127.0.0.1:${PORT}`);
});
