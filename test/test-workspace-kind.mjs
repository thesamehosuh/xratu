#!/usr/bin/env node
/**
 * Workspace classification for the chat empty state.
 *
 * Regression: the empty-state suggestion chips were all maintenance ON an
 * established codebase ("tour this codebase", "hunt for bugs", "write tests",
 * "optimize it"). In a folder with nothing in it every one of them is dead on
 * arrival, so the host now reports what kind of workspace this is and the
 * webview swaps in starting-from-scratch prompts.
 *
 * The misclassification that matters most is calling a brand-new folder a
 * project: that silently restores the useless chips. The other direction
 * (calling a real project "empty") is worse still: it would offer to
 * scaffold something that already exists.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-workspace-kind.mjs
 */
import { createRequire } from 'module';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
const { classifyWorkspace } = require('../out/workspaceKind.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};
const eq = (name, actual, expected) => ok(
    name, actual === expected, `(got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);

// Each case gets its own throwaway tree so `path.join` never needs a fixture
// layout and Windows path separators cannot leak into a name.
function classify(build) {
    const root = mkdtempSync(join(tmpdir(), 'xratu-wsk-'));
    try {
        build(root);
        return classifyWorkspace(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

const write = (root, rel, body = '') => {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
};

/** Does this host let us create a symlink? Windows needs Developer Mode or
 *  elevation; without it `symlinkSync` throws EPERM. Probed once, by actually
 *  trying, because there is no reliable capability check. */
let symlinkAllowed = true;
try {
    const probeDir = mkdtempSync(join(tmpdir(), 'xratu-wsk-probe-'));
    try {
        symlinkSync(join(probeDir, 'a'), join(probeDir, 'b'));
    } finally {
        rmSync(probeDir, { recursive: true, force: true });
    }
} catch {
    symlinkAllowed = false;
}
const canSymlink = () => symlinkAllowed;

try {
    // --- empty -------------------------------------------------------------
    eq('literally empty folder is empty', classify(() => {}), 'empty');
    // A folder where the user already ran `git init` is still an empty
    // project: the .git dir says nothing about a codebase being here.
    eq('.git only is still empty', classify((r) => mkdirSync(join(r, '.git'))), 'empty');
    eq('node_modules only is still empty',
        classify((r) => mkdirSync(join(r, 'node_modules'))), 'empty');

    // --- bare: content, but no project -------------------------------------
    eq('README only is bare', classify((r) => write(r, 'README.md', '# hi')), 'bare');
    eq('.gitignore only is bare', classify((r) => write(r, '.gitignore', 'node_modules')), 'bare');
    eq('notes.txt only is bare', classify((r) => write(r, 'notes.txt', 'x')), 'bare');
    // A dependency dir plus docs still has no manifest or source of its own.
    eq('docs + venv is bare',
        classify((r) => { write(r, 'notes.md'); mkdirSync(join(r, '.venv')); }), 'bare');

    // --- project: a manifest or a source file ------------------------------
    for (const manifest of [
        'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod',
        'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'CMakeLists.txt', 'Makefile',
        'tsconfig.json', 'Dockerfile',
    ]) {
        eq(`manifest ${manifest} is a project`, classify((r) => write(r, manifest, '{}')), 'project');
    }
    for (const src of [
        'main.ts', 'app.tsx', 'index.js', 'script.py', 'server.go', 'lib.rs',
        'Main.java', 'Program.cs', 'view.rb', 'main.swift', 'index.php',
    ]) {
        eq(`source ${src} is a project`, classify((r) => write(r, src, '')), 'project');
    }
    eq('per-project manifest suffix is a project',
        classify((r) => write(r, 'App.csproj', '<Project/>')), 'project');
    eq('manifest is found regardless of case',
        classify((r) => write(r, 'PACKAGE.JSON', '{}')), 'project');

    // --- monorepo: root holds only directories -----------------------------
    eq('monorepo manifest one level down',
        classify((r) => write(r, join('packages', 'app', 'package.json'), '{}')), 'project');
    eq('monorepo source two levels down',
        classify((r) => write(r, join('apps', 'web', 'src', 'index.ts'), '')), 'project');
    // Beyond the depth cap there is nothing to find - and that must NOT be
    // reported as a project, just as 'empty' is safer than a false 'project'.
    eq('source beyond the depth cap is not claimed as a project',
        classify((r) => write(r, join('a', 'b', 'c', 'd', 'deep.ts'), '')), 'bare');

    // --- robustness --------------------------------------------------------
    eq('a missing folder does not throw', classifyWorkspace(join(tmpdir(), 'xratu-does-not-exist-xyz')), 'empty');
    // An unreadable subdirectory must not abort the walk before a manifest is
    // found; skip it and keep going.
    const perms = mkdtempSync(join(tmpdir(), 'xratu-wsk-perm-'));
    try {
        write(perms, join('locked', 'package.json'), '{}');
        mkdirSync(join(perms, 'aaa-locked'), { recursive: true });
        try {
            // Windows ignores POSIX modes, so this branch is POSIX-only.
            const { chmodSync } = require('fs');
            chmodSync(join(perms, 'aaa-locked'), 0o000);
        } catch { /* could not lock it down - the assertion below still runs */ }
        eq('an unreadable directory does not hide a real project',
            classifyWorkspace(perms), 'project');
    } finally {
        try {
            const { chmodSync } = require('fs');
            chmodSync(join(perms, 'aaa-locked'), 0o755);
        } catch { /* best effort */
        }
        rmSync(perms, { recursive: true, force: true });
    }

    // A symlinked directory is followed only if the OS lists it as a link; a
    // broken link must not throw.
    const links = mkdtempSync(join(tmpdir(), 'xratu-wsk-link-'));
    try {
        write(links, 'package.json', '{}');
        // Creating a symlink needs Developer Mode or elevation on Windows and
        // throws EPERM without them, so the assertion is skipped rather than
        // failing the whole suite on a dev machine that lacks the privilege.
        if (canSymlink()) {
            symlinkSync(join(links, 'gone'), join(links, 'dangling'));
            eq('a dangling symlink does not throw', classifyWorkspace(links), 'project');
        }
    } finally {
        rmSync(links, { recursive: true, force: true });
    }
} finally {
    // no shared fixtures to clean
}

console.log(failed === 0 ? '\nAll workspace-kind tests passed.' : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);