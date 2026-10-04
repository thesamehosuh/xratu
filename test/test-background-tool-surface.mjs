#!/usr/bin/env node
/**
 * Tool-surface guards for managed background processes.
 *
 * These are the properties that make `background` safe to offer, and each one
 * is a place where a plausible-looking edit silently removes a boundary:
 *
 *  - `run_terminal_command` keeps an approval-gated spawn. `background` is a
 *    mode of the SAME tool, so it cannot become a way to start a process
 *    without the user seeing the command;
 *  - `process` takes NO pid parameter. That is the entire reason `kill` needs
 *    no approval: it can only name a job this session minted, so it cannot
 *    reach a process the user owns. Adding a pid argument would turn an
 *    ungated tool into arbitrary process termination;
 *  - plan mode drops BOTH tools. A plan must not stop processes, and there can
 *    be no job to inspect because the tool that starts one is gone too.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-background-tool-surface.mjs
 */
import { createRequire } from 'module';
import Module from 'module';

// out/mcp.js imports `vscode` at the top; stub it so the pure tool-shape
// logic is testable in plain node.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            workspace: {
                getConfiguration: () => ({ get: () => undefined, update: async () => undefined }),
            },
            Uri: { file: (p) => ({ fsPath: p, path: p }) },
            window: { withProgress: async (_o, t) => t() },
        };
    }
    return origLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const { getLocalToolDefinitions } = require('../out/mcp.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};

const tools = getLocalToolDefinitions({ plan: false });
const planTools = getLocalToolDefinitions({ plan: true });
const byName = new Map(tools.map((t) => [t.name, t]));
const planNames = new Set(planTools.map((t) => t.name));
const props = (t) => new Set(Object.keys(t.inputSchema?.properties ?? {}));

// ------------------------------------------------------------ the two tools

const terminal = byName.get('run_terminal_command');
ok('run_terminal_command is offered', !!terminal);
ok('process is offered', byName.has('process'));

const terminalProps = props(terminal);
ok('run_terminal_command takes background', terminalProps.has('background'), [...terminalProps].join(','));
ok('the old detach flag is gone', !terminalProps.has('detach'), [...terminalProps].join(','));
ok('command stays required', (terminal.inputSchema.required ?? []).includes('command'));
ok('background is not required', !(terminal.inputSchema.required ?? []).includes('background'));

// The spawn stays gated in BOTH modes - `background` must not be a bypass.
ok('a terminal spawn still requires approval', terminal.requiresApproval === true);
ok('yolo still waives it', getLocalToolDefinitions({ yolo: true }).find((t) => t.name === 'run_terminal_command')?.requiresApproval === false);

// ------------------------------------------------------- the `process` tool

const proc = byName.get('process');
const procProps = props(proc);

ok('process is not approval-gated', proc.requiresApproval === false);
ok('process takes an action', procProps.has('action'));
ok('process takes a job id', procProps.has('jobId'));

// The load-bearing one: no pid, ever.
for (const forbidden of ['pid', 'processId', 'process_id', 'targetPid', 'signal']) {
    ok(`process has no ${forbidden} parameter`, !procProps.has(forbidden), [...procProps].join(','));
}
const actionEnum = proc.inputSchema?.properties?.action?.enum ?? [];
ok('process actions are exactly the managed set',
    JSON.stringify(actionEnum) === JSON.stringify(['list', 'poll', 'log', 'wait', 'kill']),
    JSON.stringify(actionEnum));
ok('process only requires an action', JSON.stringify(proc.inputSchema.required) === JSON.stringify(['action']),
    JSON.stringify(proc.inputSchema.required));

// The description has to teach the lifecycle, or the model starts a background
// job and never looks at it again.
for (const topic of ['list', 'poll', 'log', 'wait', 'kill']) {
    ok(`the process description documents ${topic}`, proc.description.toLowerCase().includes(topic));
}
ok('the process description says job ids come from the terminal tool',
    /run_terminal_command/.test(proc.description));

// ----------------------------------------------------------- plan-mode drop

for (const name of ['run_terminal_command', 'process']) {
    ok(`plan: no ${name}`, !planNames.has(name), 'it is still offered while planning');
}
ok('plan mode still has the read tools', planNames.has('read_file') && planNames.has('grep_search'));

// --------------------------------------------------- prompt text stays honest

const desc = terminal.description;
ok('the tool description points at the background flag', /background=true/.test(desc), desc.slice(0, 120));
ok('the tool description no longer advises a shell-level &', !/start them detached with/.test(desc));
ok('the background flag description points at the process tool',
    /`process`/.test(terminal.inputSchema.properties.background.description),
    terminal.inputSchema.properties.background.description);
ok('the background flag description warns that nothing stops it',
    /not a cancel, not a turn ending/.test(terminal.inputSchema.properties.background.description),
    terminal.inputSchema.properties.background.description);
ok('the background flag description makes killing it the caller\'s job',
    /your job to/.test(terminal.inputSchema.properties.background.description));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);