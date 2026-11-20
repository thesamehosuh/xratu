#!/usr/bin/env node
/**
 * Release-workflow security guard.
 *
 * `release.yml` gained a `publish` job that creates the GitHub Release and
 * uploads the VSIX. Two properties of that job are security-relevant, and
 * both are the kind of thing a future "just add one more step" edit quietly
 * breaks:
 *
 *   1. LEAST PRIVILEGE. Only the job that talks to the release API may hold
 *      `contents: write`. The `package` job runs `npm ci` and the build
 *      toolchain, so a compromised dependency script must not be able to
 *      reach the release API - it can write only into its own run's artifact
 *      store. If the top-level permission is widened, or `publish` is dropped,
 *      this fails.
 *
 *   2. THE TAG IS VALIDATED BEFORE IT REACHES A SHELL. `on.push.tags: ['v*']`
 *      matches anything starting with `v`, including shell metacharacters, so
 *      the strict semver regex in the `package` job is the only thing standing
 *      between a tag name and `run:`. It must stay, and the `publish` job must
 *      consume the validated value as a job OUTPUT rather than re-reading
 *      `github.ref_name` (which would re-trust the raw ref in a second shell).
 *
 * It also pins the pinning rule itself: every `uses:` must be a full commit
 * SHA with a version comment, since the runtime deps are bundled into the
 * shipped extension.
 *
 * Run: node test/test-release-workflow.mjs
 */
import { readFileSync } from 'fs';
import { spawnSync } from 'node:child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';

// fileURLToPath: `.pathname` yields `/D:/...` on Windows and double-drives.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Windows checkouts arrive CRLF (there is no .gitattributes in this repo), and
// the assertions below are line-anchored regexes - `^...$` with a literal \n
// cannot match a \r\n pair. Normalise once, here, so the guards behave
// identically on all three CI OS legs.
const yaml = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n');

let failed = 0;
const check = (name, ok, detail = '') => {
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`);
};

// ---------------------------------------------------------------------------
// Job extraction, indented off the `jobs:` key. Deliberately not a YAML parse:
// the repo has no YAML dependency, and these assertions are about the literal
// text anyway (comments and shell bodies carry the meaning).
// ---------------------------------------------------------------------------
const jobBlock = (name) => {
    const start = yaml.search(new RegExp(`^ {2}${name}:$`, 'm'));
    if (start < 0) return '';
    const rest = yaml.slice(start + 1);
    const end = rest.search(/^ {2}\S/m);
    return end < 0 ? yaml.slice(start) : yaml.slice(start, start + 1 + end);
};

const packageJob = jobBlock('package');
const publishJob = jobBlock('publish');

check('release.yml defines a package job', packageJob.length > 0);
check('release.yml defines a publish job', publishJob.length > 0);

// --- 1. least privilege ----------------------------------------------------

check(
    'top-level permission is contents: read',
    /^permissions:\n {2}contents: read$/m.test(yaml),
    'the default grant must stay read-only',
);
check(
    'publish job holds contents: write',
    /^ {6}contents: write$/m.test(publishJob),
    'the release API job needs write, nested under its own `permissions:`',
);
check(
    'package job never holds contents: write',
    !/contents: write/.test(packageJob),
    'npm ci + build toolchain must not be able to reach the release API',
);
check(
    'no other job holds contents: write',
    [...yaml.matchAll(/^ {2}([a-z][\w-]*):$/gm)]
        .filter(([, name]) => name !== 'package' && name !== 'publish')
        .every(([, name]) => !/contents: write/.test(jobBlock(name))),
    'only the publish job may be granted write',
);
check(
    'publish job runs no npm/build step',
    !/\bnpm (ci|install|run)\b|node esbuild|tsc|vsce/.test(publishJob),
    'a release-API job should only download an artifact and call gh',
);
check('publish job depends on package', /^ {4}needs: package$/m.test(publishJob));

// --- 2. tag validation -----------------------------------------------------

const manifestVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const commit = 'a'.repeat(40);
const validateTag = (tag, sha = commit) => spawnSync(process.execPath, [
    join(ROOT, '.github/scripts/validate-release-tag.cjs'), tag, sha,
], { cwd: ROOT, encoding: 'utf8' });
const matchingTag = validateTag(`v${manifestVersion}`);
check('a matching release tag emits exactly the tag and build commit', matchingTag.status === 0
    && matchingTag.stdout === `tag=v${manifestVersion}\ncommit=${commit}\n`);
const mismatchedTag = validateTag(manifestVersion === '99.0.0' ? 'v100.0.0' : 'v99.0.0');
check('a manifest-version mismatch aborts before emitting release outputs',
    mismatchedTag.status === 1 && mismatchedTag.stdout === '' && mismatchedTag.stderr.includes('disagrees'));
const malformedTag = validateTag('v1.2.3-..');
check('a malformed release tag aborts before emitting release outputs',
    malformedTag.status === 1 && malformedTag.stdout === '' && malformedTag.stderr.includes('Unexpected'));
const invalidCommit = validateTag(`v${manifestVersion}`, 'HEAD');
check('an unpinned build cannot emit release outputs', invalidCommit.status === 1 && invalidCommit.stdout === '');
check(
    'package uses the validated tag',
    /RELEASE_TAG: \$\{\{ steps\.tag\.outputs\.tag \}\}/.test(packageJob),
);
check(
    'the package job validates its checked-out commit and publishes both outputs',
    packageJob.includes('ref: ${{ github.sha }}')
        && packageJob.includes('commit=$(git rev-parse HEAD)')
        && packageJob.includes('node .github/scripts/validate-release-tag.cjs "$RELEASE_TAG" "$commit" >> "$GITHUB_OUTPUT"')
        && packageJob.includes('tag: ${{ steps.tag.outputs.tag }}')
        && packageJob.includes('commit: ${{ steps.tag.outputs.commit }}'),
);
check(
    'the publish job pins its checkout and tag comparison to the build commit',
    publishJob.includes('ref: ${{ needs.package.outputs.commit }}')
        && publishJob.includes('RELEASE_COMMIT: ${{ needs.package.outputs.commit }}'),
);
check(
    'the tag-consuming step is identified (id: tag)',
    /- name: Validate tag\n {8}id: tag\n/.test(yaml),
    'a step output needs an id to be referenced',
);
check(
    'publish consumes needs.package.outputs.tag',
    /RELEASE_TAG: \$\{\{ needs\.package\.outputs\.tag \}\}/.test(publishJob),
    're-reading github.ref_name would re-trust the raw ref in a second shell',
);
check(
    'publish never reads github.ref_name directly',
    !/github\.ref_name/.test(publishJob),
);
check(
    'publish shell fails fast',
    /set -euo pipefail/.test(publishJob),
    'a missing VSIX must abort the job rather than publish an empty release',
);

// The publish job uses Bash on Linux. Exercise its actual guard before the
// artifact handling, with a simulated git remote and no release credentials.
if (process.platform === 'linux') {
    const guard = publishJob.match(/^ {10}set -euo pipefail\n([\s\S]*?)(?=^ {10}vsix=)/m)?.[0];
    check('the remote tag check runs before touching the release', Boolean(guard));
    if (guard) {
        const verify = (refs, remoteStatus = 0) => spawnSync('bash', ['-c', `
git() {
    [ "$*" = "ls-remote --exit-code origin refs/tags/v3.1.0 refs/tags/v3.1.0^{}" ] || return 2
    printf '%s' "$REMOTE_REFS"
    return "$REMOTE_STATUS"
}
${guard}`], {
            encoding: 'utf8',
            env: { ...process.env, RELEASE_TAG: 'v3.1.0', RELEASE_COMMIT: commit, REMOTE_REFS: refs, REMOTE_STATUS: String(remoteStatus) },
        });
        const tagRef = 'refs/tags/v3.1.0';
        const annotated = `${'b'.repeat(40)}\t${tagRef}\n`;
        check('the publish check accepts a matching lightweight tag', verify(`${commit}\t${tagRef}\n`).status === 0);
        check('the publish check accepts a matching annotated tag', verify(annotated + `${commit}\t${tagRef}^{}\n`).status === 0);
        check('the publish check refuses a moved tag', verify(annotated + `${'c'.repeat(40)}\t${tagRef}^{}\n`).status === 1);
        check('the publish check refuses a missing tag', verify('', 2).status === 2);
    }
}

// --- 3. action pinning -----------------------------------------------------

const uses = [...yaml.matchAll(/uses:\s*([^\s#]+)(?:\s*#\s*(.*))?/g)];
check('the workflow pins its actions', uses.length > 0);

for (const [, ref, comment] of uses) {
    const pinned = /@[0-9a-f]{40}$/.test(ref);
    check(
        `pinned to a full SHA: ${ref.split('@')[0]}`,
        pinned,
        'a tag or branch ref can be moved after review',
    );
    check(
        `carries a version comment: ${ref.split('@')[0]}`,
        Boolean(comment && /v\d+\.\d+\.\d+/.test(comment)),
        'the comment is how a reviewer sees which release this is',
    );
}

// --- 4. release assets are actually published ------------------------------

check(
    'the built VSIX is what gets published',
    /gh release create "\$RELEASE_TAG" "\$vsix"/.test(publishJob),
    'publishing a locally rebuilt VSIX would ship bytes CI never verified',
);
check(
    'the artifact is downloaded from this run',
    /actions\/download-artifact@[0-9a-f]{40}/.test(publishJob),
);
check(
    'the tag is verified to exist before publishing',
    /--verify-tag/.test(publishJob),
);
check(
    'a re-run replaces the asset instead of failing',
    /gh release upload "\$RELEASE_TAG" "\$vsix" --clobber/.test(publishJob),
    're-running a release workflow is routine; it must be idempotent',
);

console.log(failed === 0
    ? 'release-workflow: all checks passed'
    : `release-workflow: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);