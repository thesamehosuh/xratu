/** Generate an inspection page for the collaborative browser using the shared
 * real theme fixture and a mock VS Code API before the built app initializes.
 * Run after build:webview; no browser runtime is required by this helper. */
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const fixture = join(process.cwd(), 'out', 'research-theme.cjs');
buildSync({ entryPoints: [join('test', 'e2e', 'vscodeTheme.ts')], outfile: fixture, bundle: true, platform: 'node', format: 'cjs' });
const { installVscodeTheme } = require(fixture);
const scripts = [];
await installVscodeTheme({ emulateMedia: async () => {}, addInitScript: async (fn, arg) => scripts.push(`(${fn.toString()})(${JSON.stringify(arg)});`) });
scripts.push(`window.__xratuHostMessages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__xratuHostMessages.push(m),getState:()=>undefined,setState:s=>s});`);
const file = join('dist', 'webview-ui', 'index.html');
writeFileSync(join('dist', 'webview-ui', 'research-inspection.html'), readFileSync(file, 'utf8').replace('<head>', '<head><script>' + scripts.join('\n') + '</script>'));
