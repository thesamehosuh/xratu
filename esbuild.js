const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',

  });

  if (watch) {
    await ctx.watch();
    console.log('[watch] build finished');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }

  // pdfjs-dist resolves its fake worker relative to the bundle location -
  // ship the worker next to dist/extension.js (pdfExtract.ts points
  // GlobalWorkerOptions.workerSrc here).
  const workerSrc = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.min.mjs');
  const workerOut = path.join(__dirname, 'dist', 'pdf.worker.min.mjs');
  if (fs.existsSync(workerSrc)) {
    fs.copyFileSync(workerSrc, workerOut);
  } else {
    console.warn('pdf.worker.min.mjs not found - PDF text extraction will fail at runtime');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
