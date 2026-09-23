/**
 * Shell-dialect handling for the `run_terminal_command` tool.
 *
 * The tool executes `cmd.exe /d /s /c` on Windows and `/bin/bash -c`
 * elsewhere (see mcp.ts). The model used to learn that from one parenthetical
 * - "bash, or cmd on Windows" - next to a POSIX-only example
 * (`cat data.csv | wc -l`), with no statement of which shell THIS host runs.
 * On Windows it therefore opened with `grep`/`ls`/`find`/`cat`, cmd.exe
 * rejected each with "is not recognized as an internal or external command",
 * and the model burned several rounds rediscovering the platform before it
 * settled on `findstr`/`dir`. Two fixes live here:
 *
 *   1. `terminalToolDescription()` states the ACTUAL shell for the host
 *      platform, names the equivalents, and points at the built-in read/
 *      search tools, which never depend on shell dialect at all.
 *   2. `terminalFailureHint()` turns the shell's "no such command" error into
 *      an actionable correction appended to the failed tool result, so the
 *      FIRST failure teaches instead of the fifth.
 *
 * Deliberately NOT done here: translating or rewriting the command the model
 * sent. The user approves a command string; silently running a different one
 * would break that contract.
 *
 * Kept free of the `vscode` import so it runs in plain node
 * (see out/tooling/shellPlatform.js after `npm run compile-tests`).
 */

/** What to do instead of a binary this shell does not have. */
interface ShellAdvice {
    /**
     * Individually runnable replacements. A LIST, never one string with "or"
     * or "/" inside it: a hint reads as a command to submit, and
     * `del <file> / rmdir /s /q <dir>` only produced another invalid command.
     */
    equivalent?: string[];
    /** Built-in tool that replaces the whole shell detour. */
    tool?: string;
    /** Prose, for replacements that are not a command at all. */
    note?: string;
}

/**
 * POSIX commands missing from cmd.exe. Keyed by bare binary name. `find`,
 * `sort`, `more` and `where` DO resolve on Windows but with different
 * semantics - `find` in particular is not a file finder - so a few of those
 * are mapped too, and the runtime message check below catches `find`'s
 * argument error separately.
 */
const WINDOWS_MISSING: Record<string, ShellAdvice> = {
    ls: { equivalent: ['dir'] },
    cat: { equivalent: ['type <file>'], tool: 'read_file' },
    grep: { equivalent: ['findstr /s /n /i "pattern" .'], tool: 'grep_search' },
    egrep: { equivalent: ['findstr /s /n /i "pattern" .'], tool: 'grep_search' },
    fgrep: { equivalent: ['findstr /s /n /i "pattern" .'], tool: 'grep_search' },
    rg: { tool: 'grep_search' },
    // `find.exe` is normally PRESENT (the misuse branch in terminalFailureHint
    // handles it); this entry is the safety net for a machine where it is not
    // on PATH, which is the only way it reaches the missing-binary path.
    find: { equivalent: ['dir /s /b'], tool: 'glob_search' },
    head: { tool: 'read_file' },
    tail: { tool: 'read_file' },
    sed: { equivalent: ['node -e "<script>"', 'python -c "<script>"'] },
    awk: { equivalent: ['node -e "<script>"', 'python -c "<script>"'] },
    wc: { equivalent: ['find /c /v "" <file>'], tool: 'read_file' },
    rm: { equivalent: ['del <file>', 'rmdir /s /q <dir>'] },
    cp: { equivalent: ['copy <src> <dst>', 'xcopy /e /i <src> <dst>'] },
    mv: { equivalent: ['move <src> <dst>'] },
    touch: { equivalent: ['type nul > <file>'] },
    which: { equivalent: ['where <name>'] },
    pwd: { equivalent: ['cd'] },
    python3: { equivalent: ['python'] },
    pip3: { equivalent: ['pip'] },
    diff: { equivalent: ['fc /n <file1> <file2>', 'git diff -- <path>'] },
    sleep: { equivalent: ['timeout /t <seconds> /nobreak'] },
    clear: { equivalent: ['cls'] },
    source: { note: 'A virtualenv activates on Windows by running its own script, e.g. `.venv\\Scripts\\activate`.' },
    chmod: {},
    chown: {},
    sudo: {},
    apt: {},
    'apt-get': {},
    brew: {},
    export: {},
    uname: {},
    ps: {},
    kill: {},
    ln: {},
    bash: {},
    sh: {},
    zsh: {},
    jq: {},
    nano: {},
    vim: { note: 'Edit the file with the edit_file / apply_patch tools rather than a terminal editor.' },
};

/** cmd.exe / PowerShell commands missing from bash. */
const POSIX_MISSING: Record<string, ShellAdvice> = {
    dir: { equivalent: ['ls'] },
    findstr: { equivalent: ['grep -rn'] },
    where: { equivalent: ['which'] },
    del: { equivalent: ['rm'] },
    copy: { equivalent: ['cp'] },
    move: { equivalent: ['mv'] },
    xcopy: { equivalent: ['cp -r'] },
    robocopy: { equivalent: ['cp -r'] },
    tasklist: { equivalent: ['ps aux'] },
    taskkill: { equivalent: ['kill'] },
    cls: { equivalent: ['clear'] },
    set: { equivalent: ['export VAR=value'] },
    type: { equivalent: ['cat'] },
    more: { equivalent: ['less', 'cat'] },
    fc: { equivalent: ['diff'] },
};

/** Strip a directory or extension so `C:\\tools\\rg.exe` keys as `rg`. */
function binaryName(raw: string): string {
    const tail = raw.trim().replace(/^.*[\\/]/, '');
    return tail.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** One-line "do this instead" sentence for a missing binary. */
function adviceSentence(win: boolean, advice: ShellAdvice | undefined): string {
    if (advice?.note) return advice.note;
    // Each alternative gets its OWN code span: the model copies what is inside
    // backticks, so alternatives must never share one.
    const equivalents = advice?.equivalent?.length
        ? advice.equivalent.map((cmd) => `\`${cmd}\``).join(' or ')
        : '';
    if (equivalents && advice?.tool) {
        return `Use the ${advice.tool} tool instead (${equivalents} in ${win ? 'cmd.exe' : 'bash'}).`;
    }
    if (equivalents) {
        return `Use ${equivalents} instead.`;
    }
    if (advice?.tool) {
        return `Use the ${advice.tool} tool instead.`;
    }
    // Unmapped name (or one with no equivalent): name the whole class of
    // replacements rather than guessing at a single command.
    return win
        ? 'Use the cmd.exe equivalent (dir, type, findstr, where, del, copy, move), or the built-in tools '
            + '(read_file, grep_search, glob_search, list_files) which work the same on every platform.'
        : 'Use the POSIX equivalent (ls, cat, grep, which, rm, cp, mv), or the built-in tools '
            + '(read_file, grep_search, glob_search, list_files) which work the same on every platform.';
}

// cmd.exe:  'grep' is not recognized as an internal or external command,
// PowerShell cmdlets reported from cmd.exe use the same message.
const WINDOWS_NOT_FOUND = /'?([^'\r\n]+?)'? is not recognized as an internal or external command/i;
// bash 5.x:  bash: line 1: grep: command not found
// bash 3.2 (macOS):  bash: grep: command not found
// dash:  sh: 1: grep: not found
// Anchored to the SHELL's own prefix and case-sensitive on purpose: a loose
// `<word>: not found` matcher fires on ordinary failures like
// `gh: Not Found (HTTP 404)` or `error: not found`, telling the model that an
// installed tool is missing. Only the shell diagnosing its own missing
// binary may produce a dialect hint.
const POSIX_NOT_FOUND = /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|dash|sh|zsh): (?:(?:line )?\d+: )?([^\s:]+): (?:command )?not found\s*$/m;
// Windows find.exe exists but is a line filter, so POSIX-style file search
// arrives as an argument error instead of a missing-command error.
const WINDOWS_FIND_MISUSE = /\bFIND: Parameter format not correct\b/i;

/**
 * Actionable correction for a failed command, or null when the failure is not
 * a dialect problem (ordinary test failures must stay clean - the model
 * should not be told to swap shells because `npm test` went red).
 */
export function terminalFailureHint(platform: NodeJS.Platform, stderr: string): string | null {
    if (!stderr) return null;
    const win = platform === 'win32';

    if (win && WINDOWS_FIND_MISUSE.test(stderr)) {
        return "Windows `find` filters lines of a file - it is not a file finder. Use the glob_search tool to locate "
            + 'files by name, grep_search for contents, or `findstr /s /n /i "pattern" .`.';
    }

    const match = win ? stderr.match(WINDOWS_NOT_FOUND) : stderr.match(POSIX_NOT_FOUND);
    if (!match) return null;

    const raw = match[1].trim();
    const name = binaryName(raw);
    if (!name) return null;

    // A PowerShell verb-noun cmdlet run inside cmd.exe: the equivalent is
    // almost never obvious to the model, so name the problem explicitly.
    if (win && /^(get|set|select|write|out|remove|copy|new|test|invoke|start|stop|add|move|rename)-[a-z]+$/i.test(name)) {
        return `'${raw}' is a PowerShell cmdlet, and this tool runs cmd.exe (PowerShell is not launched for you). `
            + 'Use the built-in tools (read_file, grep_search, glob_search, list_files) or a cmd.exe command instead - '
            + 'pipe through `powershell -Command "..."` only if it is really needed.';
    }

    const advice = (win ? WINDOWS_MISSING : POSIX_MISSING)[name];
    // ".exe"/".cmd"/".bat" stripped above; keep the raw spelling in the message
    // so the model recognises the command it actually sent.
    return `'${raw}' is not a ${win ? 'cmd.exe' : 'bash'} command (or is not on PATH). `
        + `${adviceSentence(win, advice)} `
        + `Do not retry ${win ? 'POSIX commands' : 'cmd.exe/PowerShell commands'} in this shell.`;
}

/**
 * Attach the dialect hint to a finished result, truncating FIRST. Appending
 * the hint to the untruncated result and slicing afterwards put it past the
 * cut on any chatty failure, so exactly the runs that needed the correction
 * most arrived with no hint at all. The hint is a fixed short line, so it does
 * not need to count against the output budget.
 *
 * The truncation keeps BOTH ends. A head-only cut dropped the tail, and for a
 * terminal result the tail is where the diagnosis lives: `STDERR`, the
 * `Exit code:` line and the kill reason all sit AFTER a large `STDOUT` block,
 * so a chatty failed command arrived with its error and exit code sliced
 * away - the model saw only the head of stdout. The body still measures
 * exactly `limit` chars (marker included).
 */
export function appendHintToResult(result: string, hint: string | null, limit = 200000): string {
    const head = clipResult(result, limit);
    return hint ? `${head}\nHint: ${hint}` : head;
}

/** Bound `text` to `limit` chars, keeping the head and the tail. */
function clipResult(text: string, limit: number): string {
    if (text.length <= limit) return text;
    const marker = '\n… [output truncated] …\n';
    const budget = limit - marker.length;
    // Too small to split: a plain head cut is the only bounded answer.
    if (budget <= 0) return text.slice(0, limit);
    const head = Math.floor(budget * 0.6);
    const tail = budget - head;
    return text.slice(0, head) + marker + text.slice(-tail);
}

/**
 * Description for the `run_terminal_command` tool, stated for the shell the
 * host will actually use.
 */
export function terminalToolDescription(platform: NodeJS.Platform): string {
    const win = platform === 'win32';
    const shell = win ? 'Windows cmd.exe - this is NOT bash, PowerShell or WSL' : '/bin/bash';

    const dialect = win
        // `find` is deliberately NOT in the missing list: find.exe is a
        // built-in line filter, so claiming it "is not recognized" would
        // contradict the misuse branch in terminalFailureHint below.
        ? 'POSIX commands do not exist here: ls, cat, grep, head, tail, sed, awk, rm, cp, mv, touch and which all '
            + 'fail with "is not recognized". `find` is different: it EXISTS as a line filter, not a file finder, so '
            + 'a POSIX-style `find . -name "*.ts"` reports an argument error instead - use glob_search to find files. '
            + 'Write cmd.exe commands (dir, type, findstr, where, del, copy, move) or, better, use the built-in '
            + 'read_file / grep_search / glob_search / list_files tools, which behave the same on every platform and '
            + 'need no approval round for shell dialect guessing.'
        : 'Write bash commands; cmd.exe/PowerShell commands such as dir, findstr, where, del, copy and move do not '
            + 'exist here. For reading and searching files the built-in read_file / grep_search / glob_search / '
            + 'list_files tools are available too.';

    const stdinEof = win
        ? 'stdin is closed (immediate EOF) - the command must not wait for interactive input; pass flags like `-y` instead (there is no `</dev/null` here; NUL is the null device).'
        : 'stdin is closed (immediate EOF) - the command must not wait for interactive input; use flags like `yes`/`-y` or `</dev/null` semantics instead.';

    const watch = win
        ? 'Killed after 10 minutes without output or at a 30-minute hard cap - quiet-but-working builds survive the idle window; for watchers, start them detached with `start /b` and return.'
        : 'Killed after 10 minutes without output or at a 30-minute hard cap - quiet-but-working builds survive the idle window; for watchers, start them detached with `&` and return.';

    const probes = win
        ? 'dir/type/findstr/where'
        : 'ls/cat/grep/rg/find/jq';

    return [
        `Runs one shell command in the workspace root via ${shell}.`,
        dialect,
        'Pipes, redirection and chaining work; each call starts fresh at the workspace root.',
        stdinEof,
        watch,
        `In PLAN MODE only read-only enumeration commands are allowed (version probes like \`python --version && pip --version\`, git status/log/diff/show/blame, ${probes}) - everything that can mutate the workspace is blocked server-side; inspect files with read_file/grep_search/glob_search/list_files instead, and use run_tests for test runs.`,
    ].join(' ');
}

/**
 * `command` parameter description. The example is the model's strongest hint
 * about dialect - it used to be POSIX-only on every platform.
 */
export function terminalCommandParamDescription(platform: NodeJS.Platform): string {
    return platform === 'win32'
        ? 'Shell command for cmd.exe, e.g. "python test.py" or "findstr /s /n /i pattern *.ts" or "dir /b *.json"'
        : 'Shell command, e.g. "python test.py" or "cat data.csv | wc -l"';
}
