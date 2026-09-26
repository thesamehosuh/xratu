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
    ok('explore allow-list is read-only', !explore.tools.includes('edit_file') && !explore.tools.includes('run_terminal_command'));
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
}
{
    const defs = discoverSubagents({ workspaceRoot: path.join(tmpRoot, 'nows'), homedir: tmpHome });
    const reviewer = resolveSubagent(defs, 'reviewer');
    check('without workspace, global copy loads', reviewer.description, 'Global reviewer');
    check('global source recorded', reviewer.source, 'global-agents');
}

// --- filterToolsForSubagent (recursion deny + allow-list) ---
{
    const all = [
        { name: 'read_file' }, { name: 'edit_file' }, { name: 'grep_search' },
        { name: 'run_terminal_command' }, { name: 'task' }, { name: 'skill' },
    ];
    const general = filterToolsForSubagent(all, { tools: undefined });
    ok('task NEVER passes the filter', !general.some((t) => t.name === SUBAGENT_TOOL_NAME));
    check('no allow-list keeps everything else', general.length, 5);
    const explore = filterToolsForSubagent(all, { tools: ['read_file', 'grep_search', 'skill'] });
    check('allow-list enforced', JSON.stringify(explore.map((t) => t.name)),
        JSON.stringify(['read_file', 'grep_search', 'skill']));
    const withTask = filterToolsForSubagent(all, { tools: ['read_file', 'task'] });
    ok('allow-list cannot re-enable task', !withTask.some((t) => t.name === 'task'));
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
}

// --- description/schema builders ---
{
    const defs = discoverSubagents({ workspaceRoot: tmpWs, homedir: tmpHome });
    const description = buildTaskToolDescription(defs);
    ok('description lists explore', description.includes('- explore:'));
    ok('description lists custom reviewer', description.includes('- reviewer: Project reviewer'));
    ok('description excludes invalid defs', !description.includes('mismatch'));
    ok('description states the fresh-context contract', description.includes('FRESH context'));
    const schema = buildTaskToolSchema(defs);
    check('schema requires prompt + type', JSON.stringify(schema.required), JSON.stringify(['prompt', 'subagent_type']));
    ok('schema enum line lists types', String(schema.properties.subagent_type.description).includes('explore'));
    ok('schema enum line lists custom type', String(schema.properties.subagent_type.description).includes('reviewer'));
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
