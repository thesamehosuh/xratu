#!/usr/bin/env node
/**
 * Subagent definition tests - frontmatter parsing, discovery/priority,
 * tool filtering (recursion deny), task-argument validation, and the
 * task tool description/schema builders.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-subagents.mjs
 */
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const require = createRequire(import.meta.url);
const {
    parseSubagentDefinition,
    discoverSubagents,
    builtinSubagents,
    listableSubagents,
    resolveSubagent,
    filterToolsForSubagent,
    parseTaskToolArgs,
    buildTaskToolDescription,
    buildTaskToolSchema,
    subagentIssues,
    agentFileTemplate,
    SUBAGENT_TOOL_NAME,
    DEFAULT_SUBAGENT_ROUNDS,
} = require('../out/subagents.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
};

// --- parseSubagentDefinition ---
{
    const p = parseSubagentDefinition('---\nname: code-reviewer\ndescription: Reviews code\ntools: read_file, grep_search\nmax_rounds: 30\n---\n\n# Body\nLine\n');
    check('frontmatter name', p.name, 'code-reviewer');
    check('frontmatter description', p.description, 'Reviews code');
    check('tools parsed as comma list', JSON.stringify(p.tools), JSON.stringify(['read_file', 'grep_search']));
    check('max_rounds parsed', p.maxRounds, 30);
    check('body after frontmatter', p.prompt, '# Body\nLine');
}
{
    const p = parseSubagentDefinition('\uFEFF---\r\nname: crlf-agent\r\ndescription: "Quoted desc"\r\ntools: read_file , grep_search ,\r\nmax_rounds: 0\r\n---\r\n\r\nBody line\r\n');
    check('BOM tolerated', p.name, 'crlf-agent');
    check('CRLF tolerated', p.description, 'Quoted desc');
    check('empty tool entries dropped', JSON.stringify(p.tools), JSON.stringify(['read_file', 'grep_search']));
    check('non-positive max_rounds ignored', p.maxRounds, undefined);
}
{
    const p = parseSubagentDefinition('just markdown, no frontmatter');
    check('no frontmatter -> whole text is prompt', p.prompt, 'just markdown, no frontmatter');
    check('no frontmatter -> no name', p.name, undefined);
}
{
    const p = parseSubagentDefinition('---\nname: unclosed\n');
    check('unclosed frontmatter -> whole text is prompt', p.prompt, '---\nname: unclosed');
}
{
    const p = parseSubagentDefinition('---\nname: blocky\ndescription: >\n  folded text\ntools:\n  - read_file\n---\nBody\n');
    check('block scalar description treated as absent', p.description, undefined);
    check('nested tools list treated as absent', p.tools, undefined);
}

// --- builtinSubagents ---
{
    const builtins = builtinSubagents();
    ok('builtins include explore', builtins.some((d) => d.name === 'explore'));
    ok('builtins include general', builtins.some((d) => d.name === 'general'));
    const explore = builtins.find((d) => d.name === 'explore');
    ok('explore allow-list cannot edit', !explore.tools.includes('edit_file') && !explore.tools.includes('apply_patch'));
    ok('explore can run commands to verify claims', explore.tools.includes('run_terminal_command'));
    const general = builtins.find((d) => d.name === 'general');
    check('general has no allow-list (all minus task)', general.tools, undefined);
    check('round budget default exported', DEFAULT_SUBAGENT_ROUNDS, 50);
}

// --- discoverSubagents ---
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xratu-subagents-'));
const tmpHome = path.join(tmpRoot, 'home');
const tmpWs = path.join(tmpRoot, 'ws');
fs.mkdirSync(path.join(tmpHome, '.agents', 'agents'), { recursive: true });
fs.mkdirSync(path.join(tmpWs, '.xratu', 'agents'), { recursive: true });
fs.writeFileSync(
    path.join(tmpHome, '.agents', 'agents', 'reviewer.md'),
    '---\ndescription: Global reviewer\ntools: read_file\n---\nGlobal body',
    'utf-8');
fs.writeFileSync(
    path.join(tmpWs, '.xratu', 'agents', 'reviewer.md'),
    '---\ndescription: Project reviewer\ntools: read_file, grep_search\n---\nProject body',
    'utf-8');
fs.writeFileSync(
    path.join(tmpWs, '.xratu', 'agents', 'broken.md'),
    '---\ndescription: Missing name field is fine but body missing\n---\n',
    'utf-8');
fs.writeFileSync(
    path.join(tmpWs, '.xratu', 'agents', 'mismatch.md'),
    '---\nname: other\ndescription: Name mismatch\n---\nBody',
    'utf-8');
fs.writeFileSync(
    path.join(tmpWs, '.xratu', 'agents', 'general.md'),
    '---\ndescription: Custom general\ntools: read_file\n---\nCustom general body',
    'utf-8');
fs.writeFileSync(
    path.join(tmpWs, '.xratu', 'agents', 'ghost.md'),
    '---\nbody without description\n---\nBody',
    'utf-8');
fs.writeFileSync(
    path.join(tmpHome, '.agents', 'agents', 'ghost.md'),
    '---\ndescription: Ghost global\ntools: read_file\n---\nGhost global body',
    'utf-8');
fs.writeFileSync(
    path.join(tmpWs, '.xratu', 'agents', 'explore.md'),
    '---\nname: wrong\ndescription: Broken explore override\n---\nBody',
    'utf-8');
{
    const defs = discoverSubagents({ workspaceRoot: tmpWs, homedir: tmpHome });
    const names = listableSubagents(defs).map((d) => d.name);
    ok('custom reviewer discovered', names.includes('reviewer'));
    ok('builtins still present', names.includes('explore'));
    const reviewer = resolveSubagent(defs, 'reviewer');
    check('project copy wins over global', reviewer.description, 'Project reviewer');
    check('project body wins', reviewer.prompt, 'Project body');
    check('project source recorded', reviewer.source, 'project-xratu');
    const general = resolveSubagent(defs, 'general');
    check('custom file overrides builtin general', general.description, 'Custom general');
    check('override body wins', general.prompt, 'Custom general body');
    ok('invalid entries not listable', !names.includes('mismatch'));
    const mismatch = defs.find((d) => d.name === 'mismatch');
    ok('name mismatch kept with error', !!mismatch?.error, String(mismatch?.error));
    const broken = defs.find((d) => d.name === 'broken');
    ok('empty body kept with error', broken?.error === 'prompt body is missing', String(broken?.error));
    check('subagent_type resolution is case-exact', resolveSubagent(defs, 'Reviewer'), null);
    // Invalid files never shadow valid lower-priority copies (skills rule).
    const ghost = resolveSubagent(defs, 'ghost');
    check('invalid project file does not shadow valid global', ghost?.description, 'Ghost global');
    check('shadow winner keeps its source', ghost?.source, 'global-agents');
    const explore = resolveSubagent(defs, 'explore');
    check('invalid override does not shadow the builtin explore', explore?.source, 'builtin');
    const badExplore = defs.find((d) => d.name === 'explore' && d.error);
    ok('invalid builtin-override kept with error', !!badExplore?.error, String(badExplore?.error));
}
{
    const defs = discoverSubagents({ workspaceRoot: path.join(tmpRoot, 'nows'), homedir: tmpHome });
    const reviewer = resolveSubagent(defs, 'reviewer');
    check('without workspace, global copy loads', reviewer.description, 'Global reviewer');
    check('global source recorded', reviewer.source, 'global-agents');
}

// --- `tools:` / `model:` validation against the real toolset --------------
// The regression this exists for: an agent file that names tools this host
// does not have (Claude Code's `Read`/`Bash` vocabulary in a `.claude/agents/`
// folder, or a typo) used to yield a child with NO tools that still looked
// perfectly launchable to the model.
{
    const TOOLS = ['read_file', 'grep_search', 'glob_search', 'run_terminal_command', SUBAGENT_TOOL_NAME, 'skill'];
    const validation = { toolNames: new Set(TOOLS) };
    const ws = path.join(tmpRoot, 'ws-validate');
    const dir = path.join(ws, '.xratu', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const write = (name, body) => fs.writeFileSync(path.join(dir, `${name}.md`), body, 'utf-8');
    write('claude-style', '---\ndescription: Copied from another tool\ntools: Read, Grep, Glob, Bash\n---\nBody');
    write('typo', '---\ndescription: One typo\ntools: read_file, read-files\n---\nBody');
    write('partial', '---\ndescription: One bad name among good ones\ntools: read_file, grep_search, WebSearch\n---\nBody');
    write('selfnest', '---\ndescription: Delegates to itself\ntools: read_file, task\n---\nBody');
    write('priced', '---\ndescription: Runs on another model\nmodel: some-cheap-model\nreasoning_effort: low\n---\nBody');

    const defs = discoverSubagents({ workspaceRoot: ws, homedir: tmpRoot, validation });
    const names = listableSubagents(defs).map((d) => d.name);
    ok('a tools: list that resolves to nothing is a definition ERROR', !names.includes('claude-style'));
    const claudeStyle = defs.find((d) => d.name === 'claude-style');
    ok('the error names the offending tools', /Read/.test(claudeStyle?.error ?? ''), String(claudeStyle?.error));
    ok('the error lists the valid names', /read_file/.test(claudeStyle?.error ?? ''), String(claudeStyle?.error));
    // One bad name next to good ones is a warning, not a dead profile: an
    // external-MCP tool can be disconnected right now and come back later.
    ok('a single typo next to valid names still loads', names.includes('typo'));
    check('the typo is dropped from the toolset', JSON.stringify(resolveSubagent(defs, 'typo')?.tools),
        JSON.stringify(['read_file']));
    ok('the typo is reported as a warning', /read-files/.test(resolveSubagent(defs, 'typo')?.warning ?? ''));
    ok('a partially valid list still loads', names.includes('partial'));
    const partial = resolveSubagent(defs, 'partial');
    check('the resolvable names are kept', JSON.stringify(partial.tools), JSON.stringify(['read_file', 'grep_search']));
    ok('the dropped name is reported', /WebSearch/.test(partial?.warning ?? ''), String(partial?.warning));
    check('task in a tools: list is stripped, not fatal', JSON.stringify(resolveSubagent(defs, 'selfnest')?.tools),
        JSON.stringify(['read_file']));
    ok('the always-stripped task is explained', /task/.test(resolveSubagent(defs, 'selfnest')?.warning ?? ''));
    check('model + reasoning_effort parsed', resolveSubagent(defs, 'priced')?.model, 'some-cheap-model');
    check('reasoning_effort parsed', resolveSubagent(defs, 'priced')?.reasoningEffort, 'low');

    // Model validation only judges when the catalog actually knows something.
    const withCatalog = discoverSubagents({
        workspaceRoot: ws,
        homedir: tmpRoot,
        validation: { toolNames: new Set(TOOLS), knownModels: new Set(['gpt-5']) },
    });
    ok('a model this provider does not list warns', /not in this provider/.test(
        resolveSubagent(withCatalog, 'priced')?.warning ?? ''));
    const unknownCatalog = discoverSubagents({
        workspaceRoot: ws,
        homedir: tmpRoot,
        validation: { toolNames: new Set(TOOLS), knownModels: new Set() },
    });
    ok('an undiscovered catalog never warns about models',
        resolveSubagent(unknownCatalog, 'priced')?.warning === undefined);

    // Diagnostics surface: everything a user should hear about, in one list.
    const issues = subagentIssues(defs);
    ok('broken files appear in diagnostics', issues.some((i) => i.def.name === 'claude-style' && i.fatal));
    ok('warnings appear in diagnostics', issues.some((i) => i.def.name === 'partial' && !i.fatal));
    ok('clean builtins raise nothing', subagentIssues(builtinSubagents()).length === 0);

    // The scaffolded starter must load clean and keep its tool names.
    const scaffoldWs = path.join(tmpRoot, 'ws-scaffold');
    const scaffoldDir = path.join(scaffoldWs, '.xratu', 'agents');
    fs.mkdirSync(scaffoldDir, { recursive: true });
    fs.writeFileSync(path.join(scaffoldDir, 'my-agent.md'), agentFileTemplate('my-agent', TOOLS), 'utf-8');
    const scaffolded = resolveSubagent(
        discoverSubagents({ workspaceRoot: scaffoldWs, homedir: tmpRoot, validation }),
        'my-agent');
    ok('the scaffolded template loads', !!scaffolded, JSON.stringify(scaffolded));
    ok('the scaffolded template has no error', !scaffolded?.error, String(scaffolded?.error));
    ok('the scaffolded template has no warning', !scaffolded?.warning, String(scaffolded?.warning));
    ok('the scaffolded template keeps resolvable tool names',
        (scaffolded?.tools ?? []).every((t) => TOOLS.includes(t)), JSON.stringify(scaffolded?.tools));
    ok('the template never nests task into a child', !(scaffolded?.tools ?? []).includes(SUBAGENT_TOOL_NAME));
}

// --- filterToolsForSubagent (recursion + session-control deny, allow-list) ---
{
    const all = [
        { name: 'read_file' }, { name: 'edit_file' }, { name: 'grep_search' },
        { name: 'run_terminal_command' }, { name: SUBAGENT_TOOL_NAME }, { name: 'skill' },
        { name: 'update_task_list' }, { name: 'exit_plan_mode' },
    ];
    const general = filterToolsForSubagent(all, { tools: undefined });
    ok('task NEVER passes the filter', !general.some((t) => t.name === SUBAGENT_TOOL_NAME));
    ok('update_task_list NEVER passes the filter', !general.some((t) => t.name === 'update_task_list'));
    ok('exit_plan_mode NEVER passes the filter', !general.some((t) => t.name === 'exit_plan_mode'));
    check('no allow-list keeps everything else', general.length, 5);
    const explore = filterToolsForSubagent(all, { tools: ['read_file', 'grep_search', 'skill'] });
    check('allow-list enforced', JSON.stringify(explore.map((t) => t.name)),
        JSON.stringify(['read_file', 'grep_search', 'skill']));
    const withTask = filterToolsForSubagent(all, { tools: ['read_file', 'task', 'update_task_list', 'exit_plan_mode'] });
    ok('allow-list cannot re-enable task', !withTask.some((t) => t.name === 'task'));
    ok('allow-list cannot re-enable session-control tools',
        !withTask.some((t) => t.name === 'update_task_list' || t.name === 'exit_plan_mode'));
}

// --- parseTaskToolArgs ---
{
    const good = parseTaskToolArgs({ subagent_type: 'explore', prompt: 'Find X', description: 'find x' });
    check('valid args parse', good.ok, true);
    check('type kept', good.value?.subagentType, 'explore');
    check('prompt kept', good.value?.prompt, 'Find X');
    const noType = parseTaskToolArgs({ prompt: 'Find X' });
    check('missing subagent_type rejected', noType.ok, false);
    ok('missing type error names the field', !noType.ok && noType.error.includes('subagent_type'));
    const noPrompt = parseTaskToolArgs({ subagent_type: 'explore' });
    check('missing prompt rejected', noPrompt.ok, false);
    const blank = parseTaskToolArgs({ subagent_type: '  ', prompt: 'x' });
    check('blank type rejected', blank.ok, false);
    const noDesc = parseTaskToolArgs({ subagent_type: 'explore', prompt: 'x' });
    check('description optional', noDesc.ok, true);
    check('description defaults to empty', noDesc.value?.description, '');
    const viaTaskId = parseTaskToolArgs({ prompt: 'continue', task_id: 'abc123def0' });
    check('task_id alone is enough (resume without subagent_type)', viaTaskId.ok, true);
    check('task_id captured', viaTaskId.value?.taskId, 'abc123def0');
    const both = parseTaskToolArgs({ subagent_type: 'explore', prompt: 'x', task_id: 'abc123def0' });
    check('task_id + subagent_type accepted', both.ok, true);
    const neither = parseTaskToolArgs({ prompt: 'x' });
    check('neither subagent_type nor task_id rejected', neither.ok, false);
}

// --- description/schema builders ---
{
    const defs = discoverSubagents({ workspaceRoot: tmpWs, homedir: tmpHome });
    const description = buildTaskToolDescription(defs);
    ok('description lists explore', description.includes('- explore:'));
    ok('description lists custom reviewer', description.includes('- reviewer: Project reviewer'));
    ok('description excludes invalid defs', !description.includes('mismatch'));
    ok('description states the fresh-context contract', description.includes('FRESH context'));
    ok('description guides when to delegate', description.includes('When to delegate'));
    ok('description guides when NOT to delegate', description.includes('When NOT to delegate'));
    ok('description names tours/research as the delegation case', description.includes('tours'));
    const schema = buildTaskToolSchema(defs);
    check('schema requires prompt (type comes from subagent_type or task_id)', JSON.stringify(schema.required), JSON.stringify(['prompt']));
    ok('schema enum line lists types', String(schema.properties.subagent_type.description).includes('explore'));
    ok('schema enum line lists custom type', String(schema.properties.subagent_type.description).includes('reviewer'));
    ok('schema documents task_id continuation', String(schema.properties.task_id.description).includes('task_id'));
    ok('description documents the task_id resume path', description.includes('task_id'));
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
