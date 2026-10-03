#!/usr/bin/env node
/**
 * Ripgrep discovery (Windows-first): a typical Windows machine has NO `rg`
 * on PATH and no VSCODE_RIPGREP_PATH hint - without the app-root fallback
 * every search hard-errors ("rg is not installed") and the tool is useless.
 *
 * The app-root layout is the part that actually rots: current VS Code unpacks
 * native modules out of the asar and ships `@vscode/ripgrep-universal` under a
 * platform-ARCH directory. Asserting only the old `node_modules/@vscode/ripgrep`
 * path made this suite agree with the bug and stay green while Windows search
 * was broken, so the real layout is pinned here.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-ripgrep-discovery.mjs
 */
import { createRequire } from 'module';
import Module from 'module';
import path from 'path';

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

// Expectations are built with the HOST's path.join - the platform/arch flags
// only pick NAMES, so both sides join the same way the implementation does.
const app = 'C:\\VSCode\\resources\\app';
const universal = (...parts) => path.join(app, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', ...parts);

const win = ripgrepCandidates({ env: {}, appRoot: app, platform: 'win32', arch: 'x64' });
check('windows: app-root bundled rg.exe', win[0], universal('win32-x64', 'rg.exe'));

const winArm = ripgrepCandidates({ env: {}, appRoot: app, platform: 'win32', arch: 'arm64' });
check('windows: arm64 target triple', winArm[0], universal('win32-arm64', 'rg.exe'));

// Older VS Code shipped the pre-universal layout - still probed, but only as a
// LAST resort so a stale copy can never shadow the current one.
check('legacy layout is probed last', win[win.length - 1], path.join(app, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'));

const macApp = '/Applications/Code.app/Contents/Resources/app';
const mac = ripgrepCandidates({ env: {}, appRoot: macApp, platform: 'darwin', arch: 'arm64' });
check('macos: darwin-arm64 triple', mac[0], path.join(macApp, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', 'darwin-arm64', 'rg'));

const linuxApp = '/usr/share/code/resources/app';
const linux = ripgrepCandidates({ env: {}, appRoot: linuxApp, platform: 'linux', arch: 'x64' });
check('posix: app-root bundled rg', linux[0], path.join(linuxApp, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', 'linux-x64', 'rg'));
// Linux ships a glibc AND a musl build; existsSync picks whichever is present.
check('posix: alpine triple offered too', linux[1], path.join(linuxApp, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', 'alpine-x64', 'rg'));
check('posix: no .exe suffix', linux[0].endsWith('rg'), true);

// Node calls armv7l 'arm'; the npm triple spells it 'armhf'.
const linuxArm = ripgrepCandidates({ env: {}, appRoot: linuxApp, platform: 'linux', arch: 'arm' });
check('posix: node arm maps to armhf triple', linuxArm[0], path.join(linuxApp, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', 'linux-armhf', 'rg'));

// arch is optional; an omitted arch must still produce a probeable path.
const noArch = ripgrepCandidates({ env: {}, appRoot: app, platform: 'win32' });
check('omitted arch still yields candidates', noArch.length, win.length);
check('omitted arch defaults to x64', noArch[0], universal('win32-x64', 'rg.exe'));

const hinted = ripgrepCandidates({ env: { VSCODE_RIPGREP_PATH: 'D:/tools/rg.exe' }, appRoot: app, platform: 'win32' });
check('env hint wins over app root', hinted[0], 'D:/tools/rg.exe');
check('env hint still lists app root as fallback', hinted.length, 1 + win.length);

check('no app root, no hint -> nothing to try', ripgrepCandidates({ env: {}, appRoot: null, platform: 'win32' }).length, 0);
check('empty hint is ignored', ripgrepCandidates({ env: { VSCODE_RIPGREP_PATH: '' }, appRoot: null, platform: 'win32' }).length, 0);

console.log(failed === 0 ? '\nripgrep-discovery: all tests passed' : `\nripgrep-discovery: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
