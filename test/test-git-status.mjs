#!/usr/bin/env node
/**
 * Git status parser tests - the status line under the composer.
 *
 * The parser turns `git status --porcelain=v1 --branch` into the counts the UI
 * shows. A wrong count in a status line is worse than a missing one (it makes
 * the user distrust the line), so malformed input is ignored rather than
 * guessed at, and the branch shapes git actually emits are pinned here.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-git-status.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseGitStatus, emptyGitStatus, parseBranchList, isSafeBranchName } = require('../out/tooling/gitStatus.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

/** Just the fields a case cares about, so assertions stay readable. */
const pick = (s, keys) => Object.fromEntries(keys.map((k) => [k, s[k]]));

// --- branch line shapes ----------------------------------------------------

const tracked = pick(parseGitStatus('## main...origin/main [ahead 1, behind 2]\n'), ['isRepo', 'branch', 'upstream', 'ahead', 'behind', 'detached']);
check('upstream + ahead/behind', tracked, {
    isRepo: true, branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2, detached: false,
});

check('branch without upstream', pick(parseGitStatus('## feature/x\n'), ['branch', 'upstream', 'ahead', 'behind']), {
    branch: 'feature/x', upstream: null, ahead: 0, behind: 0,
});

check('ahead only', pick(parseGitStatus('## main...origin/main [ahead 3]\n'), ['ahead', 'behind']), { ahead: 3, behind: 0 });
check('behind only', pick(parseGitStatus('## main...origin/main [behind 4]\n'), ['ahead', 'behind']), { ahead: 0, behind: 4 });
check('gone upstream keeps the name', pick(parseGitStatus('## main...origin/main [gone]\n'), ['branch', 'upstream', 'ahead', 'behind']), {
    branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0,
});

check('detached HEAD', pick(parseGitStatus('## HEAD (no branch)\n'), ['branch', 'detached']), { branch: null, detached: true });
check('unborn branch', pick(parseGitStatus('## No commits yet on main\n'), ['branch', 'detached']), { branch: 'main', detached: false });
check('initial commit branch', pick(parseGitStatus('## Initial commit on trunk\n'), ['branch', 'detached']), { branch: 'trunk', detached: false });

// --- change counting -------------------------------------------------------

const counts = (stdout) => pick(parseGitStatus(stdout), ['staged', 'modified', 'untracked', 'conflicted']);

check('clean tree', counts('## main\n'), { staged: 0, modified: 0, untracked: 0, conflicted: 0 });
check('worktree modification', counts('## main\n M src/a.ts\n'), { staged: 0, modified: 1, untracked: 0, conflicted: 0 });
check('staged change', counts('## main\nM  src/a.ts\n'), { staged: 1, modified: 0, untracked: 0, conflicted: 0 });
check('staged AND modified', counts('## main\nMM src/a.ts\n'), { staged: 1, modified: 1, untracked: 0, conflicted: 0 });
check('added file', counts('## main\nA  src/new.ts\n'), { staged: 1, modified: 0, untracked: 0, conflicted: 0 });
check('deleted in worktree', counts('## main\n D gone.ts\n'), { staged: 0, modified: 1, untracked: 0, conflicted: 0 });
check('rename counts as staged', counts('## main\nR  old.ts -> new.ts\n'), { staged: 1, modified: 0, untracked: 0, conflicted: 0 });
check('untracked', counts('## main\n?? scratch.txt\n'), { staged: 0, modified: 0, untracked: 1, conflicted: 0 });
check('conflict is not a plain edit', counts('## main\nUU src/conflict.ts\n'), { staged: 0, modified: 0, untracked: 0, conflicted: 1 });
check('other conflict codes', counts('## main\nAA a\nDD b\nAU c\nDU d\n'), { staged: 0, modified: 0, untracked: 0, conflicted: 4 });

check('mixed tree', counts('## main...origin/main [ahead 2]\nM  a.ts\n M b.ts\n?? c.txt\nUU d.ts\n'), {
    staged: 1, modified: 1, untracked: 1, conflicted: 1,
});

check('paths with spaces survive', counts('## main\n M my file name.ts\n'), { staged: 0, modified: 1, untracked: 0, conflicted: 0 });
check('CRLF output', counts('## main\r\n M a.ts\r\n'), { staged: 0, modified: 1, untracked: 0, conflicted: 0 });

// --- defensive -------------------------------------------------------------

check('malformed lines are ignored, not counted', counts('## main\ngarbage\nZZ weird\nX\n'), { staged: 0, modified: 0, untracked: 0, conflicted: 0 });
check('empty output is an empty repo state', pick(parseGitStatus(''), ['isRepo', 'branch', 'staged']), { isRepo: true, branch: null, staged: 0 });
check('no branch name means detached', pick(parseGitStatus('## \n'), ['branch', 'detached']), { branch: null, detached: true });
check('not-a-repo sentinel', emptyGitStatus(), {
    isRepo: false, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0,
});

// --- branch list + name safety (the picker's data and checkout allowlist) ---
check('branches sorted', parseBranchList('main\nfeat/b\nchore/a\n'), ['chore/a', 'feat/b', 'main']);
check('branches deduped', parseBranchList('main\nmain\n'), ['main']);
check('blank lines ignored', parseBranchList('\n\nmain\n\n'), ['main']);
check('CRLF tolerated', parseBranchList('main\r\nfeat/x\r\n'), ['feat/x', 'main']);
check('empty output', parseBranchList(''), []);
check('nested names survive', parseBranchList('feat/mcp-live-marketplace\n'), ['feat/mcp-live-marketplace']);
// A name that could be read as an OPTION must never reach the picker (nor the
// checkout allowlist built from it).
check('option-looking names dropped', parseBranchList('main\n--upload-pack=x\n-D\n'), ['main']);
check('names with spaces dropped', parseBranchList('main\nmy branch\n'), ['main']);

check('safe: plain', isSafeBranchName('main'), true);
check('safe: nested', isSafeBranchName('feat/mcp-live-marketplace'), true);
check('safe: version-ish', isSafeBranchName('v1.2.3'), true);
check('unsafe: leading dash', isSafeBranchName('-D'), false);
check('unsafe: option', isSafeBranchName('--upload-pack=touch /tmp/x'), false);
check('unsafe: space', isSafeBranchName('my branch'), false);
check('unsafe: empty', isSafeBranchName(''), false);
check('unsafe: newline', isSafeBranchName('a\nb'), false);
check('unsafe: non-string', isSafeBranchName(null), false);

console.log(failed === 0 ? '\ngit-status tests: all passed' : `\ngit-status tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
