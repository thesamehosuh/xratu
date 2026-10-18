#!/usr/bin/env node
/**
 * Project-rule refresh and prompt-cache prefix regressions.
 * Unchanged rules keep the cacheable prefix stable; actual rule edits and
 * scope changes replace system context at the next turn boundary.
 * Run after `npx tsc -p . --outDir out`.
 */
import Module, { createRequire } from 'module';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { buildNativeSystemContext, REPLY_CONCISE_FINAL, buildLocalSystemPrompt, REPLY_LANGUAGE_FA, REPLY_LANGUAGE_EN, REPLY_LANGUAGE_AUTO, REPLY_VISIBLE_NARRATION, REPLY_COMMIT_MESSAGES } = require('../out/systemPrompt.js');
const { RulesSnapshot } = require('../out/local/rulesSnapshot.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
};

const json = (value) => JSON.stringify(value ?? null);
// A stable tool block, exactly as the request serializes it.
const TOOLS = [
    { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'grep_search', description: 'Search.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } } },
];

/**
 * The cacheable prefix a provider sees: tools first, then the system prompt,
 * then the replayed conversation. The system prompt sits at the FRONT, so a
 * change there invalidates the whole history that follows - exactly what the
 * host did every turn.
 */
const HISTORY = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'x'.repeat(120)}` }));
function cacheablePrefix(systemPrompt) {
    return json(TOOLS) + '\u0000' + systemPrompt + '\u0000' + HISTORY.map(json).join('\u0000');
}

// Exercise the real collector against disk with only the VS Code API stubbed.
const vscode = { workspace: { workspaceFolders: [], getWorkspaceFolder: () => undefined }, window: {} };
const load = Module._load;
let collectProjectRules;
try {
    Module._load = function (request, ...args) {
        return request === 'vscode' ? vscode : load.call(this, request, ...args);
    };
    ({ collectProjectRules } = require('../out/projectRules.js'));
} finally { Module._load = load; }
const workspace = await mkdtemp(path.join(tmpdir(), 'xratu-project-rules-'));
try {
    const folder = { uri: { fsPath: workspace } };
    vscode.workspace.workspaceFolders = [folder];
    vscode.workspace.getWorkspaceFolder = () => folder;
    const rootFile = path.join(workspace, 'AGENTS.md');
    const nested = path.join(workspace, 'src', 'feature');
    const sibling = path.join(workspace, 'other');
    await mkdir(nested, { recursive: true });
    await mkdir(sibling);
    const rootRules = 'ROOT RULES\r\n' + 'root line\r\n'.repeat(900) + 'ROOT LAST RULE';
    const nestedRules = 'NESTED RULES\r\n' + 'nested line\r\n'.repeat(900) + 'NESTED LAST RULE';
    await writeFile(rootFile, '\uFEFF' + rootRules);
    await writeFile(path.join(nested, 'AGENTS.md'), nestedRules);
    vscode.window.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: path.join(nested, 'file.ts') } } };
    const snapshot = new RulesSnapshot();
    const read = () => snapshot.resolve(workspace, collectProjectRules);
    const original = await read();
    ok('full root rules survive the former per-file and total caps', original.includes(rootRules));
    ok('full nested rules survive the former total cap', original.includes(nestedRules));
    ok('root rules precede nested overrides', original.indexOf('ROOT LAST RULE') < original.indexOf('NESTED RULES'));
    ok('Windows BOM is removed and CRLF content is retained', !original.includes('\uFEFF') && original.includes('ROOT RULES\r\n'));
    const prompt = rulesContext => buildLocalSystemPrompt({ rulesContext, sessionSummary: null, planMode: false, evictedUserTurns: 0 });
    ok('unchanged rules retain the exact cacheable prefix', cacheablePrefix(prompt(original)) === cacheablePrefix(prompt(await read())));

    await writeFile(rootFile, rootRules + '\r\nNEW ROOT RULE');
    const edited = await read();
    ok('editing rules in the same session refreshes the next turn', edited.includes('NEW ROOT RULE'));
    ok('rule edits replace the system context', prompt(edited).split('Project Rules (from AGENTS.md):').length === 2);
    ok('actual rule edits invalidate the old cached prefix', cacheablePrefix(prompt(original)) !== cacheablePrefix(prompt(edited)));

    await rm(path.join(nested, 'AGENTS.md'));
    ok('deleted nested rules disappear without a new chat', !(await read()).includes('NESTED RULES'));
    await writeFile(path.join(nested, 'AGENTS.md'), 'NEW NESTED RULE');
    ok('new nested rules appear without a new chat', (await read()).includes('NEW NESTED RULE'));
    vscode.window.activeTextEditor.document.uri.fsPath = path.join(sibling, 'file.ts');
    const siblingRules = await read();
    ok('switching editor scope drops inapplicable nested rules', !siblingRules.includes('NEW NESTED RULE') && siblingRules.includes('NEW ROOT RULE'));
    const otherWorkspace = path.join(workspace, '..', path.basename(workspace) + '-other');
    try {
        await mkdir(otherWorkspace);
        await writeFile(path.join(otherWorkspace, 'AGENTS.md'), 'FOREIGN WORKSPACE RULES');
        const otherFolder = { uri: { fsPath: otherWorkspace } };
        vscode.workspace.workspaceFolders = [folder, otherFolder];
        vscode.workspace.getWorkspaceFolder = () => otherFolder;
        vscode.window.activeTextEditor.document.uri.fsPath = path.join(otherWorkspace, 'file.ts');
        ok('another workspace cannot replace the execution workspace rules', await read() === siblingRules);
    } finally { await rm(otherWorkspace, { recursive: true, force: true }); }
    vscode.window.activeTextEditor = undefined;
    ok('no active editor collects the complete workspace rules', await read() === siblingRules);
    await rm(rootFile);
    ok('deleting all applicable rules clears the context', await read() === '');
    await mkdir(rootFile);
    await assert.rejects(read, { code: 'EISDIR' });
    ok('unreadable rule files fail visibly instead of disappearing', true);
    await rm(rootFile, { recursive: true });
    await writeFile(rootFile, 'RECOVERED RULE');
    ok('a failed read does not poison later turns', (await read()).includes('RECOVERED RULE'));
    vscode.workspace.workspaceFolders = [];
    ok('no workspace has no project rules', await collectProjectRules() === '');
} finally { await rm(workspace, { recursive: true, force: true }); }

// Refresh between turns; coalesce only reads that are still in progress.
{
    const snapshot = new RulesSnapshot();
    let reads = 0;
    const compute = async () => `RULES ${++reads}`;
    ok('each new turn reads fresh rules', await snapshot.resolve('ws', compute) === 'RULES 1' && await snapshot.resolve('ws', compute) === 'RULES 2');
    const deferred = () => {
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        return { promise, resolve };
    };
    const pending = deferred();
    const first = snapshot.resolve('ws', () => pending.promise);
    let duplicateReads = 0;
    const second = snapshot.resolve('ws', async () => { duplicateReads++; return 'DUPLICATE'; });
    pending.resolve('SHARED');
    ok('concurrent same-scope reads coalesce', (await first) === 'SHARED' && (await second) === 'SHARED' && duplicateReads === 0);

    const old = deferred(), fresh = deferred();
    const oldRead = snapshot.resolve('old-workspace', () => old.promise);
    const newRead = snapshot.resolve('new-workspace', () => fresh.promise);
    old.resolve('OLD');
    await oldRead;
    const joined = snapshot.resolve('new-workspace', async () => 'WRONG');
    fresh.resolve('NEW');
    ok('an old completion cannot clear a newer scope read', await newRead === 'NEW' && await joined === 'NEW');

    const beforeReset = deferred(), afterReset = deferred();
    const stale = snapshot.resolve('ws', () => beforeReset.promise);
    snapshot.reset();
    const current = snapshot.resolve('ws', () => afterReset.promise);
    beforeReset.resolve('STALE');
    await stale;
    const currentJoined = snapshot.resolve('ws', async () => 'WRONG');
    afterReset.resolve('CURRENT');
    ok('session reset isolates pending reads', await current === 'CURRENT' && await currentJoined === 'CURRENT');
}

// ---------------------------------------------------------------------------
// The assembly itself: deterministic, and every section lands where expected.
// ---------------------------------------------------------------------------
{
    const inputs = { rulesContext: 'RULES', sessionSummary: 'SUMMARY', planMode: false, evictedUserTurns: 0 };
    ok('assembly is deterministic', buildLocalSystemPrompt(inputs) === buildLocalSystemPrompt({ ...inputs }));
    const s = buildLocalSystemPrompt(inputs);
    ok('rules ride the system prompt', s.includes('Project Rules (from AGENTS.md):\nRULES'));
    ok('summary rides the system prompt', s.includes('Conversation summary:\nSUMMARY'));
    ok('plan guidance is omitted when not in plan mode', !s.includes('PLAN MODE'));
    ok('fresh build turns explicitly permit edits and commands', s.includes('BUILD MODE: this turn permits workspace edits and command execution'));
    ok('build permissions still defer to the host approval gate', s.includes('request the tool call and wait for approval when required'));
    ok('build permissions respect current project rules', s.includes('unless the current project rules or a tool'));
    ok('eviction note is omitted when nothing was evicted', !s.includes('older turn(s) were dropped'));

    const plan = buildLocalSystemPrompt({ ...inputs, planMode: true, evictedUserTurns: 2 });
    ok('plan guidance appears in plan mode', plan.includes('PLAN MODE (READ-ONLY)'));
    ok('plan turns never receive build permission', !plan.includes('BUILD MODE:'));
    ok('eviction note appears when turns were evicted', plan.includes('2 older turn(s) were dropped'));
    ok('rules still come before the summary', plan.indexOf('RULES') < plan.indexOf('SUMMARY'));
}

// ---------------------------------------------------------------------------
// Reply language: every mode states the language AND the narration guarantee.
// `auto` used to add no language block at all, which is how a real `auto`
// session ended up with English one-liners between tool calls while every long
// message was Persian.
// ---------------------------------------------------------------------------
{
    const inputs = { rulesContext: 'RULES', sessionSummary: null, planMode: false, evictedUserTurns: 0 };
    const autoPrompt = buildLocalSystemPrompt({ ...inputs, replyLanguage: 'auto' });
    const legacyPrompt = buildLocalSystemPrompt(inputs);
    ok('omitted replyLanguage == auto', autoPrompt === legacyPrompt);
    ok('auto still enforces English commit messages', autoPrompt.includes(REPLY_COMMIT_MESSAGES));
    ok('auto now states the language rule', autoPrompt.includes(REPLY_LANGUAGE_AUTO));
    ok('auto follows latest user language through tools', autoPrompt.includes("user's latest request") && autoPrompt.includes('notes between tool calls'));
    ok('loaded language skills cannot switch Auto replies', autoPrompt.includes('loading natural-farsi does not switch an') && autoPrompt.includes('English conversation to Persian'));
    ok('auto pins no specific language',
        !autoPrompt.includes(REPLY_LANGUAGE_FA) && !autoPrompt.includes(REPLY_LANGUAGE_EN));

    const fa = buildLocalSystemPrompt({ ...inputs, replyLanguage: 'fa' });
    ok('fa adds the Persian directive', fa.includes(REPLY_LANGUAGE_FA));
    ok('fa enforces English commit messages', fa.includes(REPLY_COMMIT_MESSAGES));
    ok('fa prompt is deterministic', fa === buildLocalSystemPrompt({ ...inputs, replyLanguage: 'fa' }));

    const en = buildLocalSystemPrompt({ ...inputs, replyLanguage: 'en' });
    ok('en adds the English directive', en.includes(REPLY_LANGUAGE_EN));
    ok('en and fa blocks differ', !en.includes(REPLY_LANGUAGE_FA));
}

// ---------------------------------------------------------------------------
// Narration between tool calls is user-visible in EVERY mode. This is the
// regression: a short note emitted next to a tool call is rendered in the
// transcript, so it must follow the reply language like any other message.
// ---------------------------------------------------------------------------
{
    const inputs = { rulesContext: 'RULES', sessionSummary: null, planMode: false, evictedUserTurns: 0 };
    for (const mode of ['fa', 'en', 'auto', undefined]) {
        const prompt = buildLocalSystemPrompt({ ...inputs, replyLanguage: mode });
        ok(`narration directive present (${mode ?? 'omitted'})`,
            prompt.includes(REPLY_VISIBLE_NARRATION));
        // The directive has to say the reasoning channel is the ONLY English
        // part, otherwise it reads as "also keep prose English somewhere".
        ok(`names the reasoning channel as the only English part (${mode ?? 'omitted'})`,
            /reasoning channel is the only private space/.test(prompt)
            && /only part that may stay in English/.test(prompt));
        // A vague commit rule bled into the narration around a commit. This
        // must be checked on the PROMPT, not on the constant: asserting the
        // constant contains a phrase is loop-invariant and passes whether or
        // not the rule ever reaches the model.
        ok(`commit rule is scoped to the message argument (${mode ?? 'omitted'})`,
            prompt.includes('the message argument itself'));
    }
    // The fa directive names the concrete failure (a one-liner next to a tool
    // call) rather than only saying "every message".
    ok('fa directive covers the notes between tool calls',
        REPLY_LANGUAGE_FA.includes('notes between tool calls'));
}

// ---------------------------------------------------------------------------
// natural-farsi preload: fa injects the skill body under the language
// directive; en/auto never do (even when a body is passed); the injection is
// byte-stable so the cacheable prefix holds.
// ---------------------------------------------------------------------------
{
    const inputs = { rulesContext: 'RULES', sessionSummary: null, planMode: false, evictedUserTurns: 0 };
    const SKILL = 'FARSI_SKILL_BODY';

    const fa = buildLocalSystemPrompt({ ...inputs, replyLanguage: 'fa', farsiSkill: SKILL });
    ok('fa preloads the farsi skill body', fa.includes(SKILL));
    ok('skill body lands after the language directive', fa.indexOf(REPLY_LANGUAGE_FA) < fa.indexOf(SKILL));
    ok('fa+skill is deterministic', fa === buildLocalSystemPrompt({ ...inputs, replyLanguage: 'fa', farsiSkill: SKILL }));

    const en = buildLocalSystemPrompt({ ...inputs, replyLanguage: 'en', farsiSkill: SKILL });
    ok('en never preloads the farsi skill', !en.includes(SKILL));

    const auto = buildLocalSystemPrompt({ ...inputs, replyLanguage: 'auto', farsiSkill: SKILL });
    ok('auto never preloads the farsi skill', !auto.includes(SKILL));

    const bare = buildLocalSystemPrompt({ ...inputs, replyLanguage: 'fa' });
    ok('fa without a skill body stays shape-stable', bare.includes(REPLY_LANGUAGE_FA) && !bare.includes('natural-farsi skill, preloaded'));
}


ok('built-in engine receives concise final-response guidance', buildLocalSystemPrompt({ rulesContext: '', sessionSummary: null, planMode: false, evictedUserTurns: 0 }).includes(REPLY_CONCISE_FINAL));
ok('native engine receives concise final-response guidance', buildNativeSystemContext(false).includes(REPLY_CONCISE_FINAL));
ok('native PR work watches pending checks and reviews', buildNativeSystemContext(false).includes('pending checks or reviews'));
ok('native plan context does not advertise PR mutation tools', !buildNativeSystemContext(true).includes('watch_pull_request'));

ok('native context leaves project-rule discovery to OpenCode', !buildNativeSystemContext(false).includes('AGENTS.md'));
// The bridge registers `skill` only when at least one skill is listable
// (getLocalToolDefinitions); the prompt must not name a tool the catalog lacks.
const withSkill = buildNativeSystemContext(false, 'auto', { toolCatalog: ['update_task_list', 'skill', 'browser_snapshot'] });
const withoutSkill = buildNativeSystemContext(false, 'auto', { toolCatalog: ['update_task_list', 'browser_snapshot'] });
ok('native context advertises the bridged skill tool when the catalog has it', withSkill.includes('bridged skill tool'));
ok('native context omits the bridged skill tool when the catalog lacks it', !withoutSkill.includes('bridged skill tool'));
ok('native context keeps task-list and browser guidance without the skill tool', withoutSkill.includes('update_task_list') && withoutSkill.includes('browser_*'));
for (const [mode, directive] of [['en', REPLY_LANGUAGE_EN], ['fa', REPLY_LANGUAGE_FA], ['auto', REPLY_LANGUAGE_AUTO]]) {
    ok(`native context respects ${mode} reply language`, buildNativeSystemContext(false, mode).includes(directive));
}

console.log(failed === 0 ? '\nall prompt-cache-prefix checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
