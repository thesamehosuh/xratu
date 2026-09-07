import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'path';

// Webview UI build. Output is a single self-contained index.html
// (JS + CSS inlined) so the extension host can load it directly and inject
// a CSP nonce.  All assets resolve relative to the bundle location.
export default defineConfig({
    root: resolve(__dirname, 'webview-ui'),
    plugins: [react(), viteSingleFile()],
    build: {
        outDir: resolve(__dirname, 'dist', 'webview-ui'),
        emptyOutDir: true,
        cssCodeSplit: false,
        assetsInlineLimit: 100_000_000,
        rollupOptions: {
            output: {
                inlineDynamicImports: true,
            },
        },
    },
    server: {
        // Not used for the packaged webview, but handy for `vite` dev.
        port: 5173,
        strictPort: false,
    },
});
