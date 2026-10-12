/** Build a repeatable README walkthrough from the shipped webview, without keys. */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const output = join(root, 'out', 'readme-demo');
await mkdir(output, { recursive: true });
const bootstrap = await build({
    entryPoints: [join(root, 'test', 'e2e', 'readmeDemo.ts')],
    bundle: true, write: false, format: 'iife', platform: 'browser',
});
const app = await readFile(process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist', 'webview-ui', 'index.html'), 'utf8');
const logo = (await readFile(join(root, 'assets', 'brand', 'logo-128.png'))).toString('base64');
const html = app
    .replace('<head>', `<head><script>${bootstrap.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`)
    .replace('<div id="root"></div>', `
        <header class="demo-header"><div class="demo-meta"><span class="demo-brand"><img src="data:image/png;base64,${logo}" alt=""/> Xratu</span><div class="demo-scene"><h1 id="demo-title"></h1><span id="demo-counter">01 / 06</span></div></div></header>
        <div class="demo-window"><div id="root"></div></div>
        <footer class="demo-footer"><div id="demo-chapters"></div><span id="demo-disclosure"></span></footer>
        <nav class="demo-controls"><button id="demo-replay">Play walkthrough</button><button id="demo-next">Next scene</button><span id="demo-status">Ready</span></nav>`);
await writeFile(join(output, 'index.html'), html);
await writeFile(join(output, 'board.html'), await readFile(join(root, 'test', 'e2e', 'readmeDemoBoard.html')));
console.log(`Walkthrough built in ${output}`);
console.log('Serve with: node test/e2e/serve.mjs out/readme-demo 4174');
