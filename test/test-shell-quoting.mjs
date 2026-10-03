#!/usr/bin/env node
/**
 * Windows command-quoting regression for `run_terminal_command`.
 *
 * The bug: the tool spawned `cp.spawn('cmd.exe', ['/d','/s','/c', command])`
 * with no `windowsVerbatimArguments`. Node then applies MSVCRT quoting to
 * each argv element - an element containing spaces gets wrapped in quotes,
 * and quotes INSIDE it are escaped with backslashes. cmd.exe has no
 * backslash escaping, so the command was torn apart at the inner quotes:
 *
 *   gh pr create --title "fix(windows): discover ripgrep" --body-file pr.md
 *
 * reached `gh` as `--title`, `"fix(windows):`, `discover`, `ripgrep`, ... -
 * which it rejected with `unknown arguments ["discover" "ripgrep" ...]`.
 * The user approved one command and a different one ran.
 *
 * Two layers are pinned:
 *
 *   - the pure invocation (`terminalSpawn`) must ask for verbatim arguments on
 *     win32 and must NOT on posix. These run on the ubuntu leg too.
 *   - a real spawn on Windows, checked against a `.bat` file - the literal
 *     ground truth for what cmd.exe does with a line of text.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-shell-quoting.mjs
 */
import { createRequire } from 'module';
import cp from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { terminalSpawn } = require('../out/tooling/shellPlatform.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

// ---- the invocation itself (platform-independent)

const win = terminalSpawn('win32', 'echo hi');
check('win32 runs cmd.exe', win.file, 'cmd.exe');
check('win32 keeps the /d /s /c flags', win.args.slice(0, 3), ['/d', '/s', '/c']);
check('win32 passes the command through untouched', win.args[3], 'echo hi');
// THE regression: without this flag cmd.exe splits quoted arguments.
check('win32 asks for verbatim arguments', win.windowsVerbatimArguments, true);

const linux = terminalSpawn('linux', 'echo hi');
check('linux runs bash', linux.file, '/bin/bash');
check('linux passes -c', linux.args, ['-c', 'echo hi']);
check('linux does not ask for verbatim arguments', linux.windowsVerbatimArguments, false);

const mac = terminalSpawn('darwin', 'echo hi');
check('darwin runs bash', mac.file, '/bin/bash');
check('darwin does not ask for verbatim arguments', mac.windowsVerbatimArguments, false);

// ---- real spawn: only meaningful on a Windows host

if (process.platform !== 'win32') {
    console.log('\nskipping spawn checks (not Windows)');
    process.exit(failed === 0 ? 0 : 1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xratu-quoting-'));
const echo = path.join(tmp, 'argv-echo.mjs');
fs.writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
const batch = path.join(tmp, 'ref.bat');

const viaSpawn = (command) => new Promise((resolve) => {
    const { file, args, windowsVerbatimArguments } = terminalSpawn('win32', command);
    const child = cp.spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('close', () => resolve(out.trim()));
});

const viaBatch = (command) => new Promise((resolve) => {
    fs.writeFileSync(batch, `@echo off\r\n${command}\r\n`);
    const child = cp.spawn('cmd.exe', ['/d', '/s', '/c', batch], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('close', () => resolve(out.trim()));
});

// `echo` is deliberately quoted so a regression shows up as a split title
// with a stray `"` on the end, exactly as gh reported it.
const node = `node "${echo}"`;
const cases = [
    `${node} --title "fix(windows): discover ripgrep" --body-file pr.md`,
    `${node} "C:\\Program Files\\VS Code\\resources" rg`,
    `${node} plain args`,
    `${node} "quoted" "also quoted" tail`,
    `${node} "it's got an apostrophe"`,
    `${node} "percent %PATH% literal"`,
    `${node} --pattern "*.ts" path`,
    // cmd.exe separators. The tail command proves both sides still agree: a
    // quoting regression would let the separator split the command and the
    // spawned output would diverge from the .bat reference.
    `${node} "quoted arg" & echo after-amp`,
    `${node} "quoted arg" && echo after-andamp`,
    // A separator INSIDE quotes must not act as a separator.
    `${node} "a & b"`,
];

for (const command of cases) {
    const [spawned, batched] = await Promise.all([viaSpawn(command), viaBatch(command)]);
    check(`argv survives cmd.exe: ${command.slice(node.length).trim() || '(no args)'}`, spawned, batched);
}

// The headline case, spelled out rather than only compared.
const [split] = await Promise.all([
    viaSpawn(`${node} --title "fix(windows): discover ripgrep" --body-file pr.md`),
]);
check('quoted title arrives as ONE argument', JSON.parse(split), [
    '--title',
    'fix(windows): discover ripgrep',
    '--body-file',
    'pr.md',
]);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failed === 0 ? '\nshell-quoting: all tests passed' : `\nshell-quoting: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);