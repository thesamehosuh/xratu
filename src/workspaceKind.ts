/**
 * Workspace classification for the chat empty state.
 *
 * The empty-state suggestion chips are the first thing a user sees, and the
 * default set assumes an ESTABLISHED project: "Tour this codebase", "Hunt for
 * bugs", "Write tests", "Optimize it". In a folder with nothing in it every one
 * of those is dead on arrival - there is no codebase to tour and no central
 * source file to hunt through. So the host reports what kind of workspace this
 * is and the webview picks a starting set that can actually fire.
 *
 *   empty   - nothing but (optionally) a .git dir. The folder was just created.
 *   bare    - files exist, but no project manifest and no source: a README, a
 *             .gitignore, some notes. Reads as "not started yet".
 *   project - a manifest or a source file is present. The default chips apply.
 *
 * Deliberately NOT recursive to the last drop: a bounded breadth-first walk
 * (depth + entry caps) keeps this cheap enough to run on every chat open and
 * still finds the manifest in a monorepo (one `package.json` per workspace
 * package, several directories down) or a project whose root holds only
 * directories.
 *
 * Kept free of the `vscode` import so it is unit-testable in plain node (see
 * test/test-workspace-kind.mjs) - the same precedent as testFramework.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

export type WorkspaceKind = 'empty' | 'bare' | 'project';

/** Dependency/build/VCS dirs that say nothing about whether a project exists.
 *  `.git` in particular: a folder where the user has already run `git init` is
 *  still an empty project, not a developed one. */
const IGNORED_DIRS = new Set([
    '.git', '.hg', '.svn', '.idea', '.vscode', '.vs',
    'node_modules', 'bower_components', 'vendor',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
    '.venv', 'venv', 'env', '.tox',
    'dist', 'build', 'out', 'target', 'bin', 'obj',
    '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
    'coverage', 'htmlcov', '.gradle', '.terraform',
    '.playwright-mcp', '.xratu',
]);

/** Files that mean "this IS a project" regardless of extension. */
const MANIFEST_NAMES = new Set([
    'package.json', 'deno.json', 'deno.jsonc', 'bun.lockb', 'tsconfig.json',
    'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pipfile',
    'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
    'settings.gradle', 'composer.json', 'gemfile', 'mix.exs',
    'package.swift', 'cmakelists.txt', 'makefile', 'dockerfile',
    'docker-compose.yml', 'docker-compose.yaml', 'pubspec.yaml',
]);

/** Manifest suffixes that are per-project files, not exact names. */
const MANIFEST_SUFFIXES = ['.csproj', '.sln', '.fsproj', '.vbproj', '.xcodeproj'];

/** Source extensions - the other way a folder is identified as a project. */
const SOURCE_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
    '.py', '.go', '.rs', '.java', '.kt', '.kts', '.scala',
    '.rb', '.php', '.cs', '.fs', '.swift', '.m', '.mm',
    '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx',
    '.vue', '.svelte', '.astro', '.dart', '.lua', '.ex', '.exs',
    '.erl', '.hrl', '.clj', '.cljs', '.hs', '.ml', '.elm',
]);

const DEPTH_CAP = 4;
const ENTRY_CAP = 400;

export function classifyWorkspace(root: string): WorkspaceKind {
    let sawAnything = false;

    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    let examined = 0;

    while (queue.length > 0 && examined < ENTRY_CAP) {
        const { dir, depth } = queue.shift()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue; // unreadable dir (permissions, race) - skip, not fatal
        }
        for (const entry of entries) {
            if (++examined > ENTRY_CAP) break;
            const name = entry.name;
            if (entry.isDirectory()) {
                // Checked BEFORE the hidden-name test below: `.git`, `.venv`
                // and friends are hidden AND ignored, and testing "starts with
                // a dot" first made a folder whose only entry was `.git` count
                // as bare rather than empty.
                if (IGNORED_DIRS.has(name)) continue;
                sawAnything = true;
                if (depth + 1 < DEPTH_CAP) queue.push({ dir: path.join(dir, name), depth: depth + 1 });
                continue;
            }
            if (name.startsWith('.') && name !== '.gitignore') {
                // Hidden files are config, never evidence of a project, but
                // they DO mean the folder is not literally empty.
                sawAnything = true;
                continue;
            }
            sawAnything = true;
            const lower = name.toLowerCase();
            if (MANIFEST_NAMES.has(lower) || MANIFEST_SUFFIXES.some((s) => lower.endsWith(s))) {
                return 'project';
            }
            if (SOURCE_EXTS.has(path.extname(lower))) return 'project';
        }
    }

    return sawAnything ? 'bare' : 'empty';
}