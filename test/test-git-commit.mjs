#!/usr/bin/env node
// Exercise the real tool against disposable repositories, including the index
// contents a user sees after selected-file commits and failed staging.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return {};
    return originalLoad.call(this, request, parent, isMain);
};
const { handleExpansionTool } = require('../out/xratu_mcp_tools.js');
const { sanitizePath } = require('../out/paths.js');
Module._load = originalLoad;

const directory = mkdtempSync(path.join(tmpdir(), 'xratu git commit '));
const environment = { ...process.env };
const globalConfig = path.join(directory, 'gitconfig');
writeFileSync(globalConfig, '');
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

function repository({ initial = true } = {}) {
    const root = mkdtempSync(path.join(directory, 'repo '));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }).trim();
    const write = (file, content) => writeFileSync(path.join(root, file), content);
    git('init', '-b', 'main');
    git('config', 'user.name', 'Git commit tests');
    git('config', 'user.email', 'git-commit@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    git('config', 'core.safecrlf', 'false');
    if (initial) {
        for (const file of ['selected.txt', 'unrelated.txt', 'deleted.txt', 'blocked.txt']) write(file, 'base\n');
        git('add', '-A');
        git('commit', '-m', 'Initial content');
    }
    let snapshots = 0;
    const commit = (args) => handleExpansionTool('git_commit', args, {
        workspaceRoot: root,
        sanitizePath,
        ensureTurnSnapshot: async () => { snapshots++; },
    });
    const changed = () => git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').filter(Boolean).sort();
    return { root, git, write, commit, changed, snapshots: () => snapshots };
}

const output = result => result.content.map(item => item.text ?? '').join('\n');
function succeeded(result) { assert.notEqual(result.isError, true, output(result)); }
function failed(result) { assert.equal(result.isError, true, output(result)); }
async function scenario(name, run) {
    await run();
    console.log(`ok ${name}`);
}

try {
    await scenario('selected-file commits preserve unrelated partial staging and working changes', async () => {
        const r = repository();
        r.write('selected.txt', 'selected staged\n');
        r.write('unrelated.txt', 'unrelated staged\n');
        r.git('add', 'selected.txt', 'unrelated.txt');
        r.write('selected.txt', 'selected working\n');
        r.write('unrelated.txt', 'unrelated working\n');
        const unrelatedIndex = r.git('ls-files', '--stage', '--', 'unrelated.txt');
        succeeded(await r.commit({ message: 'Selected only', files: ['selected.txt'] }));
        assert.deepEqual(r.changed(), ['selected.txt']);
        assert.equal(r.git('show', 'HEAD:selected.txt'), 'selected working');
        assert.equal(r.git('show', 'HEAD:unrelated.txt'), 'base');
        assert.equal(r.git('ls-files', '--stage', '--', 'unrelated.txt'), unrelatedIndex);
        assert.equal(r.git('show', ':unrelated.txt'), 'unrelated staged');
        assert.equal(readFileSync(path.join(r.root, 'unrelated.txt'), 'utf8'), 'unrelated working\n');
        assert.equal(r.git('diff', '--cached', '--name-only'), 'unrelated.txt');
        assert.equal(r.snapshots(), 1);
    });

    await scenario('an unknown selected path cannot commit unrelated staged changes', async () => {
        const r = repository();
        r.write('unrelated.txt', 'staged\n');
        r.git('add', 'unrelated.txt');
        const head = r.git('rev-parse', 'HEAD'), index = r.git('ls-files', '--stage');
        failed(await r.commit({ message: 'Missing selection', files: ['missing.txt'] }));
        assert.equal(r.git('rev-parse', 'HEAD'), head);
        assert.equal(r.git('ls-files', '--stage'), index);
    });

    await scenario('a mixed valid/missing selection fails without creating a commit', async () => {
        const r = repository();
        r.write('selected.txt', 'working\n');
        r.write('unrelated.txt', 'staged\n');
        r.git('add', 'unrelated.txt');
        const head = r.git('rev-parse', 'HEAD'), index = r.git('show', ':unrelated.txt');
        failed(await r.commit({ message: 'Incomplete selection', files: ['selected.txt', 'missing.txt'] }));
        assert.equal(r.git('rev-parse', 'HEAD'), head);
        assert.equal(r.git('show', ':unrelated.txt'), index);
    });

    await scenario('failed staging of an ignored file stops before committing', async () => {
        const r = repository();
        r.write('.gitignore', 'ignored.txt\n');
        r.write('ignored.txt', 'ignored\n');
        r.write('unrelated.txt', 'staged\n');
        r.git('add', 'unrelated.txt');
        const head = r.git('rev-parse', 'HEAD'), index = r.git('ls-files', '--stage');
        const result = await r.commit({ message: 'Ignored selection', files: ['ignored.txt'] });
        failed(result);
        assert.match(output(result), /ignored/i);
        assert.equal(r.git('rev-parse', 'HEAD'), head);
        assert.equal(r.git('ls-files', '--stage'), index);
    });

    await scenario('stage_all reports a failed clean filter without creating a commit', async () => {
        const r = repository();
        const filter = path.join(r.root, '.git', 'reject.cjs');
        writeFileSync(filter, 'process.stderr.write("staging rejected\\n"); process.exit(1);\n');
        // Git executes filter commands through its own sh, including Git for Windows.
        const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
        r.git('config', 'filter.reject.clean', `${quote(process.execPath)} ${quote(filter)}`);
        r.git('config', 'filter.reject.required', 'true');
        r.write('.gitattributes', 'blocked.txt filter=reject\n');
        r.write('blocked.txt', 'rejected content\n');
        r.write('unrelated.txt', 'staged\n');
        r.git('add', 'unrelated.txt');
        const head = r.git('rev-parse', 'HEAD'), index = r.git('ls-files', '--stage');
        const result = await r.commit({ message: 'All changes', stage_all: true });
        failed(result);
        assert.match(output(result), /staging rejected|clean filter.*failed/i);
        assert.equal(r.git('rev-parse', 'HEAD'), head);
        assert.equal(r.git('ls-files', '--stage'), index);
    });

    for (const staged of [false, true]) {
        await scenario(`selected ${staged ? 'already staged' : 'unstaged'} deletion is committed alone`, async () => {
            const r = repository();
            unlinkSync(path.join(r.root, 'deleted.txt'));
            r.write('unrelated.txt', 'staged\n');
            r.git('add', 'unrelated.txt');
            if (staged) r.git('add', '-A', '--', 'deleted.txt');
            succeeded(await r.commit({ message: 'Delete selected', files: ['deleted.txt'] }));
            assert.deepEqual(r.changed(), ['deleted.txt']);
            assert.equal(r.git('diff', '--cached', '--name-only'), 'unrelated.txt');
            assert.equal(r.git('ls-tree', '--name-only', 'HEAD', '--', 'deleted.txt'), '');
        });
    }

    await scenario('selected new files are committed without unrelated staged changes', async () => {
        const r = repository();
        r.write('new.txt', 'new\n');
        r.write('unrelated.txt', 'staged\n');
        r.git('add', 'unrelated.txt');
        succeeded(await r.commit({ message: 'New file', files: ['new.txt'] }));
        assert.deepEqual(r.changed(), ['new.txt']);
        assert.equal(r.git('diff', '--cached', '--name-only'), 'unrelated.txt');
    });

    await scenario('initial commits honor selection and preserve other staged files', async () => {
        const r = repository({ initial: false });
        r.write('selected.txt', 'selected\n');
        r.write('unrelated.txt', 'staged\n');
        r.git('add', 'unrelated.txt');
        succeeded(await r.commit({ message: 'Selected initial content', files: ['selected.txt'] }));
        assert.deepEqual(r.changed(), ['selected.txt']);
        assert.equal(r.git('diff', '--cached', '--name-only'), 'unrelated.txt');
    });

    await scenario('literal file names do not expand as git pathspecs', async () => {
        const r = repository();
        for (const file of ['selected[1].txt', 'selected1.txt', '-option.txt']) r.write(file, 'new\n');
        succeeded(await r.commit({ message: 'Literal names', files: ['selected[1].txt', '-option.txt'] }));
        assert.deepEqual(r.changed(), ['-option.txt', 'selected[1].txt']);
        assert.equal(r.git('ls-tree', '--name-only', 'HEAD', '--', 'selected1.txt'), '');
    });

    await scenario('directory selections remain bounded to that directory', async () => {
        const r = repository();
        mkdirSync(path.join(r.root, 'chosen folder'));
        r.write(path.join('chosen folder', 'new.txt'), 'new\n');
        r.write('unrelated.txt', 'staged\n');
        r.git('add', 'unrelated.txt');
        succeeded(await r.commit({ message: 'Selected directory', files: ['chosen folder'] }));
        assert.deepEqual(r.changed(), ['chosen folder/new.txt']);
        assert.equal(r.git('diff', '--cached', '--name-only'), 'unrelated.txt');
    });

    await scenario('no selection commits the existing staged index only', async () => {
        const r = repository();
        r.write('selected.txt', 'staged\n');
        r.git('add', 'selected.txt');
        r.write('selected.txt', 'working\n');
        r.write('unrelated.txt', 'working\n');
        succeeded(await r.commit({ message: 'Staged content' }));
        assert.deepEqual(r.changed(), ['selected.txt']);
        assert.equal(r.git('show', 'HEAD:selected.txt'), 'staged');
        assert.equal(r.git('diff', '--name-only'), 'selected.txt\nunrelated.txt');
    });

    await scenario('stage_all keeps its explicit all-changes behavior', async () => {
        const r = repository();
        r.write('selected.txt', 'changed\n');
        r.write('unrelated.txt', 'changed\n');
        r.write('new.txt', 'new\n');
        succeeded(await r.commit({ message: 'All changes', stage_all: true, files: ['selected.txt'] }));
        assert.deepEqual(r.changed(), ['new.txt', 'selected.txt', 'unrelated.txt']);
        assert.equal(r.git('status', '--porcelain'), '');
    });

    await scenario('outside-workspace paths and malformed selections are refused', async () => {
        const r = repository();
        r.write('unrelated.txt', 'staged\n');
        r.git('add', 'unrelated.txt');
        const head = r.git('rev-parse', 'HEAD'), index = r.git('ls-files', '--stage');
        for (const files of [['../outside.txt'], [42], [null], [{}], [true], [['selected.txt']], [''], ['   '], 'selected.txt']) {
            failed(await r.commit({ message: 'Invalid selection', files }));
            assert.equal(r.git('rev-parse', 'HEAD'), head);
            assert.equal(r.git('ls-files', '--stage'), index);
            assert.equal(r.snapshots(), 0);
        }
    });
    console.log('\ngit-commit: all tests passed');
} finally {
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
        if (environment[key] === undefined) delete process.env[key];
        else process.env[key] = environment[key];
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
