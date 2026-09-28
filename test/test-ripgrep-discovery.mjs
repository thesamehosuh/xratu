#!/usr/bin/env node
/**
 * Ripgrep discovery (Windows-first): a typical Windows machine has NO `rg`
 * on PATH and no VSCODE_RIPGREP_PATH hint - without the app-root fallback
 * every search hard-errors ("rg is not installed") and the tool is useless.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-ripgrep-discovery.mjs
 */
import { createRequire } from 'module';
import Module from 'module';

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            workspace: {
                getConfiguration: () => ({ get: () => undefined, update: async () => undefined }),
            },
            Uri: { file: (p) => ({ fsPath: p, path: p }) },
            env: { appRoot: '' },
        };
    }
    return origLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const { ripgrepCandidates } = require('../out/mcp.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const win = ripgrepCandidates({ env: {}, appRoot: 'C:\\VSCode\\resources\\app', platform: 'win32' });
// Separator is the HOST's (path.join) - the win32 flag only picks the name.
check('windows: app-root bundled rg.exe', win[0].endsWith('/@vscode/ripgrep/bin/rg.exe') || win[0].endsWith('\\@vscode\\ripgrep\\bin\\rg.exe'), true);
check('windows: candidate lives under the app root', win[0].startsWith('C:\\VSCode\\resources\\app'), true);

const linux = ripgrepCandidates({ env: {}, appRoot: '/usr/share/code/resources/app', platform: 'linux' });
check('posix: app-root bundled rg', linux[0], '/usr/share/code/resources/app/node_modules/@vscode/ripgrep/bin/rg');

const hinted = ripgrepCandidates({ env: { VSCODE_RIPGREP_PATH: 'D:/tools/rg.exe' }, appRoot: 'C:\\VSCode', platform: 'win32' });
check('env hint wins over app root', hinted[0], 'D:/tools/rg.exe');
check('env hint still lists app root as fallback', hinted.length, 2);

check('no app root, no hint -> nothing to try', ripgrepCandidates({ env: {}, appRoot: null, platform: 'win32' }).length, 0);
check('empty hint is ignored', ripgrepCandidates({ env: { VSCODE_RIPGREP_PATH: '' }, appRoot: null, platform: 'win32' }).length, 0);

console.log(failed === 0 ? '\nripgrep-discovery: all tests passed' : `\nripgrep-discovery: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
