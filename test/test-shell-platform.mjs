#!/usr/bin/env node
/**
 * Shell-dialect guidance tests for `src/tooling/shellPlatform.ts`.
 *
 * The bug these pin: on Windows the terminal tool runs `cmd.exe /d /s /c`,
 * but the tool description only said "(bash, or cmd on Windows)" and showed a
 * POSIX example, so the model opened with `grep`/`ls`/`find`, collected
 * "is not recognized as an internal or external command" several times, and
 * only then adapted. Two contracts are checked here:
 *
 *   - the description names the REAL shell for the host platform and never
 *     shows the other platform's dialect as if it worked
 *   - a missing-binary failure is answered with the replacement to reach for
 *     (built-in tool or shell equivalent), while an ORDINARY failure (red
 *     tests, a compile error) stays clean - no shell hints attached
 *
 * Platform is passed explicitly, so these assertions run identically on the
 * ubuntu and windows CI legs.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-shell-platform.mjs
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    terminalToolDescription,
    terminalCommandParamDescription,
    terminalFailureHint,
    appendHintToResult,
} = require('../out/tooling/shellPlatform.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};

// --- tool description: states the shell this host really uses --------------

{
    const win = terminalToolDescription('win32');
    ok('windows description names cmd.exe', win.includes('cmd.exe'));
    ok('windows description rules bash out', /NOT bash/.test(win));
    ok('windows description names cmd.exe replacements', win.includes('findstr') && win.includes('dir'));
    ok('windows description points at the built-in search tools', win.includes('grep_search') && win.includes('read_file'));
    // The POSIX sample command must go; `</dev/null` may only appear as an
    // explicit "this does not exist here" warning.
    ok('windows description drops the POSIX sample command', !win.includes('wc -l') && !win.includes('cat data.csv'));
    ok('windows description warns off </dev/null', /there is no `<\/dev\/null` here/.test(win));

    // `find.exe` EXISTS on Windows as a line filter. Listing it as "not
    // recognized" contradicted the find-misuse branch in terminalFailureHint
    // and taught the model something false about the host shell.
    ok('windows description drops find from the missing list', !win.includes('grep, find, head'));
    ok('windows description explains find.exe semantics', win.includes('`find` is different') && win.includes('line filter'));
    ok('windows description sends file search to glob_search', win.includes('use glob_search to find files'));
    ok('windows description keeps the plan-mode note', win.includes('PLAN MODE'));
    ok('windows description keeps the kill windows', win.includes('30-minute hard cap') && win.includes('10 minutes'));

    const posix = terminalToolDescription('linux');
    ok('posix description names bash', posix.includes('/bin/bash'));
    // cmd.exe may be named only to rule its commands out, never as this
    // host's shell.
    ok('posix description rules cmd.exe out', /cmd\.exe\/PowerShell commands[\s\S]*do not exist here/.test(posix));
    ok('posix description does not present cmd.exe as the shell', !posix.includes('via Windows cmd.exe'));
    ok('posix description keeps the plan-mode example', posix.includes('ls/cat/grep/rg/find/jq'));
    ok('posix description keeps stdin-EOF guidance', posix.includes('</dev/null'));

    // The description is part of the cached prompt prefix: same platform must
    // produce the same bytes on every rebuild.
    check('description is byte-stable per platform', terminalToolDescription('win32'), win);
    ok('description is a single line', !win.includes('\n') && !posix.includes('\n'));

    // macOS is bash too - only win32 may select the Windows wording.
    check('darwin uses the posix description', terminalToolDescription('darwin'), posix);
}

// --- command parameter example: must match the same dialect ----------------

{
    const win = terminalCommandParamDescription('win32');
    ok('windows param example is a cmd.exe command', win.includes('findstr') || win.includes('dir /b'));
    ok('windows param example has no POSIX pipe example', !win.includes('wc -l'));
    // cmd.exe does not use backslash escaping, so a `\"` here is a bug: a model
    // copying the example verbatim would pass a literal backslash to findstr.
    ok('windows param example has no backslash-escaped quotes', !win.includes('\\"'));

    const posix = terminalCommandParamDescription('linux');
    ok('posix param example keeps the cat example', posix.includes('cat data.csv'));
    ok('posix param example has no findstr', !posix.includes('findstr'));
}

// --- failure hint: teach the replacement on the first failure -------------

{
    const cmdMissing = "'grep' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";
    const hint = terminalFailureHint('win32', cmdMissing);
    ok('missing binary on windows yields a hint', typeof hint === 'string');
    ok('hint names the missing binary', hint.includes("'grep'"));
    ok('hint states the real shell', hint.includes('cmd.exe'));
    ok('hint routes grep to grep_search', hint.includes('grep_search'));
    ok('hint offers the cmd.exe equivalent', hint.includes('findstr'));
    ok('hint forbids retrying POSIX commands', /Do not retry POSIX commands/.test(hint));

    // PowerShell cmdlets reported through cmd.exe: name the confusion.
    const cmdlet = terminalFailureHint('win32', "'Get-ChildItem' is not recognized as an internal or external command,");
    ok('powershell cmdlet is called out as such', cmdlet.includes('PowerShell cmdlet'));

    // Windows find.exe EXISTS but is a line filter - argument error, not a
    // missing-command error, so it needs its own branch.
    const findMisuse = terminalFailureHint('win32', 'FIND: Parameter format not correct\r\n');
    ok('windows find misuse is explained', findMisuse.includes('glob_search') && findMisuse.includes('not a file finder'));

    // A path-qualified binary keys by its basename.
    const full = terminalFailureHint('win32', "'C:\\tools\\rg.exe' is not recognized as an internal or external command,");
    ok('path-qualified binary still maps', full.includes('grep_search'));

    // Unmapped name: no guessing, but still point somewhere useful.
    const unmapped = terminalFailureHint('win32', "'frobnicate' is not recognized as an internal or external command,");
    ok('unmapped binary still yields the cmd.exe cheat sheet', unmapped.includes('dir') && unmapped.includes('grep_search'));

    // Common Windows trip-ups.
    ok('python3 routes to python', terminalFailureHint('win32', "'python3' is not recognized as an internal or external command,").includes('`python`'));
    ok('ls routes to dir', terminalFailureHint('win32', "'ls' is not recognized as an internal or external command,").includes('`dir`'));
    ok('rm routes to del', terminalFailureHint('win32', "'rm' is not recognized as an internal or external command,").includes('del'));
}

// --- the OTHER direction: cmd.exe-isms on a bash host ----------------------

{
    const missing = "bash: line 1: dir: command not found";
    const hint = terminalFailureHint('linux', missing);
    ok('missing binary on bash yields a hint', typeof hint === 'string');
    ok('bash hint maps dir to ls', hint.includes('`ls`'));
    ok('bash hint forbids retrying cmd.exe commands', /Do not retry cmd\.exe/.test(hint));

    const dash = terminalFailureHint('darwin', 'sh: 1: findstr: not found');
    ok('dash "not found" form is matched', typeof dash === 'string' && dash.includes('grep -rn'));
}

// --- advice must be a command the model can actually run -------------------

{
    const missing = (name) => terminalFailureHint('win32', `'${name}' is not recognized as an internal or external command,`);

    const rm = missing('rm');
    ok('rm advice splits the file and directory cases', rm.includes('`del <file>`') && rm.includes('`rmdir /s /q <dir>`'));
    ok('rm advice is not one mashed command', !rm.includes('`del <file> / rmdir'));

    const cp = missing('cp');
    ok('cp advice splits copy and xcopy', cp.includes('`copy <src> <dst>`') && cp.includes('`xcopy /e /i <src> <dst>`'));

    const sed = missing('sed');
    ok('sed advice separates node from python', sed.includes('`node -e "<script>"`') && sed.includes('`python -c "<script>"`'));
    ok('sed advice joins the alternatives with "or"', /`node -e "<script>"` or `python -c "<script>"`/.test(sed));

    const diff = missing('diff');
    ok('diff advice separates fc from git diff', diff.includes('`fc /n <file1> <file2>`') && diff.includes('`git diff -- <path>`'));

    // Prose advice must NOT be rendered inside a code span: the model copies
    // whatever is backticked straight into the next command.
    const vim = missing('vim');
    ok('vim advice is prose, not a fake command', vim.includes('edit_file') && !vim.includes('`edit the file'));

    const source = missing('source');
    ok('source advice is prose about the venv script', source.includes('activates on Windows') && !source.includes('`A virtualenv'));
}

// --- the hint must survive truncation of a chatty failure ------------------

{
    const big = appendHintToResult('x'.repeat(500_000), 'HINT');
    ok('a full-size result still ends with the hint', big.endsWith('\nHint: HINT'));
    ok('truncation still bounds the payload', big.length === 200000 + '\nHint: HINT'.length);
    check('no hint means plain truncation', appendHintToResult('abcdef', null, 3), 'abc');
    check('a short result is untouched', appendHintToResult('abc', 'HINT'), 'abc\nHint: HINT');
}

// --- ordinary failures must NOT be blamed on the shell --------------------

{
    const red = 'STDOUT:\n\nSTDERR:\n2 tests failed\nExit code: 1';
    check('failing test run gets no shell hint', terminalFailureHint('win32', red), null);
    check('failing test run gets no shell hint on posix', terminalFailureHint('linux', red), null);
    check('empty stderr gets no hint', terminalFailureHint('win32', ''), null);
    check('unmatched stderr gets no hint', terminalFailureHint('win32', 'error TS2304: Cannot find name'), null);
    // "0 tests failed" style noise must not trip the "not found" matcher.
    check('benign "nothing found" text gets no hint', terminalFailureHint('linux', 'grep: no matches found'), null);
    // A loose `<word>: not found` matcher would read these as a missing binary
    // and tell the model an installed tool is absent. Only the shell's own
    // `bash: ... not found` diagnostic may produce a hint.
    check('gh HTTP 404 gets no hint', terminalFailureHint('linux', 'gh: Not Found (HTTP 404)'), null);
    check('HTTP status line gets no hint', terminalFailureHint('linux', 'HTTP 404: Not Found'), null);
    check('lowercase error prefix gets no hint', terminalFailureHint('linux', 'error: not found'), null);
    // ...while the real bash/dash forms still do.
    ok('bash "line N" form still yields a hint', terminalFailureHint('linux', 'bash: line 1: nosuchcmd: command not found') !== null);
    ok('macOS bash 3.2 form still yields a hint', terminalFailureHint('darwin', 'bash: nosuchcmd: command not found') !== null);
}

console.log(failed === 0 ? '\nshell-platform tests: all passed' : `\nshell-platform tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
