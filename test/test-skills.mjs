#!/usr/bin/env node
/**
 * Agent Skills tests - frontmatter parsing, discovery/priority, listing,
 * tool-description building, body reading, and name resolution.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-skills.mjs
 */
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const require = createRequire(import.meta.url);
const {
    parseSkillMd,
    discoverSkills,
    listableSkills,
    buildSkillToolDescription,
    buildSkillToolSchema,
    readSkillBody,
    resolveSkill,
    readSkillResource,
    ensureBundledSkill,
    skillDirectoryDisplayPath,
    MAX_BODY_CHARS,
    MAX_RESOURCE_CHARS,
} = require('../out/skills.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xratu-skills-'));
const makeSkill = (base, rel, name, description = 'Does things', body = 'Do the thing.', extraFrontmatter = '') => {
    const dir = path.join(base, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}${extraFrontmatter}\n---\n\n${body}\n`, 'utf-8');
    return dir;
};

// --- parseSkillMd ---
{
    const p = parseSkillMd('---\nname: pdf-tool\ndescription: Extract text\n---\n\n# Body\nLine\n');
    check('parse: name', p.name, 'pdf-tool');
    check('parse: description', p.description, 'Extract text');
    check('parse: body', p.body, '# Body\nLine');
}
{
    const p = parseSkillMd('\uFEFF---\r\nname: crlf-skill\r\ndescription: "Quoted desc"\r\nlicense: MIT\r\nunknown-field: whatever\r\n---\r\n\r\nBody line\r\n');
    check('parse: BOM+CRLF name', p.name, 'crlf-skill');
    check('parse: quoted description', p.description, 'Quoted desc');
    check('parse: body LF-normalized', p.body, 'Body line');
    check('parse: unknown fields ignored (no throw)', typeof p.body, 'string');
}
{
    const p = parseSkillMd('just markdown, no frontmatter');
    check('parse: no frontmatter → no name', p.name, undefined);
    check('parse: no frontmatter keeps body', p.body, 'just markdown, no frontmatter');
}
{
    const p = parseSkillMd('---\nname: unclosed\n');
    check('parse: unclosed frontmatter → no name', p.name, undefined);
}
{
    const p = parseSkillMd('---\nname: blocky\ndescription: >\n  folded text\n---\nBody\n');
    check('parse: block scalar description rejected', p.description, undefined);
    const p2 = parseSkillMd('---\nname: listed\ndescription:\n  - a\n  - b\n---\nBody\n');
    check('parse: YAML list description rejected', p2.description, undefined);
    const p3 = parseSkillMd('---\nname: |-\n  piped\n---\nBody\n');
    check('parse: block scalar name rejected', p3.name, undefined);
}

// --- discoverSkills: priority, shadowing, validation ---
{
    const ws = path.join(tmpRoot, 'ws1');
    const home = path.join(tmpRoot, 'home1');
    makeSkill(ws, path.join('.xratu', 'skills', 'alpha'), 'alpha', 'From xratu dir');
    makeSkill(ws, path.join('.agents', 'skills', 'beta'), 'beta', 'From agents dir');
    makeSkill(ws, path.join('.agents', 'skills', 'alpha'), 'alpha', 'Shadowed agents copy');
    makeSkill(home, path.join('.agents', 'skills', 'gamma'), 'gamma', 'Global skill');
    makeSkill(home, path.join('.agents', 'skills', 'beta'), 'beta', 'Shadowed global copy');
    const skills = discoverSkills({ workspaceRoot: ws, homedir: home });
    check('discover: winners + shadowed count', skills.length, 5);
    const alpha = skills.find((s) => s.name === 'alpha' && !s.shadowed);
    check('discover: .xratu wins over .agents', alpha.source, 'project-xratu');
    check('discover: .xratu wins (description)', alpha.description, 'From xratu dir');
    const beta = skills.find((s) => s.name === 'beta' && !s.shadowed);
    check('discover: project .agents wins over global', beta.source, 'project-agents');
    check('discover: global skill found', skills.find((s) => s.name === 'gamma')?.source, 'global-agents');
    const shadowed = skills.filter((s) => s.shadowed);
    check('discover: both duplicates flagged shadowed', shadowed.length, 2);
    check('discover: shadowed keeps its source', shadowed.map((s) => s.source).sort().join(','), 'global-agents,project-agents');
    check('discover: shadowed keeps its dirPath', shadowed.every((s) => s.dirPath.includes(path.join('.agents', 'skills')) || s.dirPath.includes(path.join('.xratu', 'skills'))), true);
    const listable = listableSkills(skills);
    check('discover: listable excludes shadowed', listable.map((s) => s.name).sort().join(','), 'alpha,beta,gamma');
}
{
    // Disabling is per-source: the same name in two locations toggles apart.
    const ws = path.join(tmpRoot, 'ws1b');
    const home = path.join(tmpRoot, 'home1b');
    makeSkill(ws, path.join('.xratu', 'skills', 'dup'), 'dup', 'Project copy');
    makeSkill(home, path.join('.agents', 'skills', 'dup'), 'dup', 'Global copy');
    const skills = discoverSkills({ workspaceRoot: ws, homedir: home });
    check('toggle: both copies discovered (one shadowed)', skills.length, 2);
    // Disabling the WINNER (project copy) removes the name entirely - the
    // shadowed global copy must NOT surface as a fallback.
    check('toggle: winner disabled by id', listableSkills(skills, new Set(['project-xratu:dup'])).length, 0);
    check('toggle: shadowed copy disabled by id', listableSkills(skills, new Set(['global-agents:dup'])).map((s) => s.name).join(','), 'dup');
    // Legacy bare-name entries still disable the winner.
    check('toggle: legacy bare-name still matches', listableSkills(skills, new Set(['dup'])).length, 0);
}
{
    // Claude Code directories participate in the same discovery: project
    // .claude sits below .agents, global ~/.claude below ~/.agents.
    const ws = path.join(tmpRoot, 'ws1c');
    const home = path.join(tmpRoot, 'home1c');
    makeSkill(ws, path.join('.agents', 'skills', 'alpha'), 'alpha', 'From agents dir');
    makeSkill(ws, path.join('.claude', 'skills', 'alpha'), 'alpha', 'Shadowed claude copy');
    makeSkill(ws, path.join('.claude', 'skills', 'beta'), 'beta', 'From claude dir');
    makeSkill(home, path.join('.agents', 'skills', 'beta'), 'beta', 'Shadowed global copy');
    makeSkill(home, path.join('.claude', 'skills', 'gamma'), 'gamma', 'Global claude skill');
    const skills = discoverSkills({ workspaceRoot: ws, homedir: home });
    check('claude: winners + shadowed count', skills.length, 5);
    check('claude: project .agents wins over .claude', skills.find((s) => s.name === 'alpha' && !s.shadowed)?.source, 'project-agents');
    check('claude: project .claude wins over global', skills.find((s) => s.name === 'beta' && !s.shadowed)?.source, 'project-claude');
    check('claude: global ~/.claude skill found', skills.find((s) => s.name === 'gamma')?.source, 'global-claude');
    const shadowed = skills.filter((s) => s.shadowed);
    check('claude: both duplicates flagged shadowed', shadowed.length, 2);
    check('claude: shadowed keeps its source', shadowed.map((s) => s.source).sort().join(','), 'global-agents,project-claude');
    check('claude: listable excludes shadowed', listableSkills(skills).map((s) => s.name).sort().join(','), 'alpha,beta,gamma');
    // Claude copies toggle apart by id like every other source.
    check('claude: winner disabled by id', listableSkills(skills, new Set(['project-claude:beta'])).map((s) => s.name).sort().join(','), 'alpha,gamma');
}
{
    const ws = path.join(tmpRoot, 'ws2');
    const home = path.join(tmpRoot, 'home2');
    fs.mkdirSync(path.join(ws, '.agents', 'skills', 'no-file'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.agents', 'skills', 'no-file', 'README.md'), 'not a skill');
    fs.mkdirSync(path.join(ws, '.agents', 'skills', 'no-name'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.agents', 'skills', 'no-name', 'SKILL.md'), '---\ndescription: has desc\n---\nBody\n');
    makeSkill(ws, path.join('.agents', 'skills', 'bad-regex'), 'Bad_Name', 'desc');
    makeSkill(ws, path.join('.agents', 'skills', 'name-mismatch'), 'other-name', 'desc');
    makeSkill(ws, path.join('.agents', 'skills', 'no-desc'), 'no-desc', '');
    // `bbb-collide` wants to rename to `aaa-target`, which already exists -
    // the rename is skipped and the mismatch error stays visible.
    makeSkill(ws, path.join('.agents', 'skills', 'aaa-target'), 'aaa-target', 'Keeps its name');
    makeSkill(ws, path.join('.agents', 'skills', 'bbb-collide'), 'aaa-target', 'Rename would collide');
    makeSkill(home, path.join('.agents', 'skills', 'ok-global'), 'ok-global', 'Fine');
    const skills = discoverSkills({ workspaceRoot: ws, homedir: home });
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    check('discover: dir without SKILL.md skipped', byName['no-file'], undefined);
    check('discover: missing name flagged (no dir fallback)', byName['no-name']?.error, 'name is missing');
    check('discover: bad name flagged', !!byName['bad-regex']?.error, true);
    // Well-formed mismatch: auto-heal renames the folder to match the
    // SKILL.md name instead of dead-ending in a permanent error.
    check('discover: mismatch auto-healed (renamedFrom)', byName['other-name']?.renamedFrom, 'name-mismatch');
    check('discover: healed copy has no error', byName['other-name']?.error, undefined);
    check('discover: healed dir renamed on disk', fs.existsSync(path.join(ws, '.agents', 'skills', 'other-name')), true);
    check('discover: old mismatched dir gone', fs.existsSync(path.join(ws, '.agents', 'skills', 'name-mismatch')), false);
    // Colliding rename is skipped - the mismatch error stays.
    check('discover: colliding rename keeps mismatch error', !!byName['bbb-collide']?.error, true);
    check('discover: missing description flagged', !!byName['no-desc']?.error, true);
    check('discover: valid sibling still listed', byName['ok-global']?.error, undefined);
    const listable = listableSkills(skills);
    check('discover: listable excludes invalid', listable.map((s) => s.name).sort().join(','), 'aaa-target,ok-global,other-name');
}
{
    const ws = path.join(tmpRoot, 'ws3');
    makeSkill(ws, path.join('.xratu', 'skills', 'disabled-one'), 'disabled-one', 'Temp disabled');
    const skills = discoverSkills({ workspaceRoot: ws, homedir: tmpRoot });
    check('discover: enabled by default', listableSkills(skills).length, 1);
    check('discover: disabled filtered', listableSkills(skills, new Set(['disabled-one'])).length, 0);
}
{
    // Symlinked skill directory counts (shared libraries).
    const ws = path.join(tmpRoot, 'ws4');
    const real = makeSkill(tmpRoot, 'shared-lib', 'linked-skill', 'Via symlink');
    fs.mkdirSync(path.join(ws, '.agents', 'skills'), { recursive: true });
    const link = path.join(ws, '.agents', 'skills', 'linked-skill');
    let linked = false;
    try {
        fs.symlinkSync(real, link, 'dir');
        linked = true;
    } catch {
        console.log('skip symlink test (not permitted on this platform)');
    }
    if (linked) {
        const skills = discoverSkills({ workspaceRoot: ws, homedir: tmpRoot });
        check('discover: symlinked skill found', skills.some((s) => s.name === 'linked-skill' && !s.error), true);
    }
}

{
    // Only a VALID winner shadows lower-priority copies: a broken
    // higher-priority entry must not block a valid global one, and a valid
    // lower-priority copy takes over while the broken one stays visible.
    // A mere name mismatch would auto-heal via folder rename, so an invalid
    // (regex-failing) name is used to keep the winner genuinely broken.
    const ws = path.join(tmpRoot, 'ws2b');
    const home = path.join(tmpRoot, 'home2b');
    makeSkill(ws, path.join('.xratu', 'skills', 'broken-winner'), 'Bad_Name', 'Invalid name → no auto-heal');
    makeSkill(home, path.join('.agents', 'skills', 'broken-winner'), 'broken-winner', 'Valid global copy');
    const skills = discoverSkills({ workspaceRoot: ws, homedir: home });
    const winner = skills.find((s) => s.name === 'broken-winner' && !s.shadowed);
    check('shadow: invalid winner does not block', winner?.source, 'global-agents');
    check('shadow: invalid winner still listed', skills.length, 2);
    check('shadow: invalid winner carries error', !!skills.find((s) => s.source === 'project-xratu' && s.error), true);
    check('shadow: winner is listable', listableSkills(skills).map((s) => s.name).join(','), 'broken-winner');
    check('shadow: winner dirPath is the valid global copy', winner.dirPath.endsWith(path.join('.agents', 'skills', 'broken-winner')), true);
}

// --- buildSkillToolDescription / schema ---
{
    check('desc: empty skills → empty string', buildSkillToolDescription([]), '');
}
{
    const skills = discoverSkills({
        workspaceRoot: path.join(tmpRoot, 'ws1'),
        homedir: path.join(tmpRoot, 'home1'),
    }).filter((s) => !s.error && !s.shadowed);
    const desc = buildSkillToolDescription(skills);
    check('desc: lists alpha', desc.includes('<name>alpha</name>'), true);
    check('desc: lists description', desc.includes('From xratu dir'), true);
    check('desc: has available_skills block', desc.includes('<available_skills>'), true);
    const schema = buildSkillToolSchema(skills);
    check('schema: enum pinned', JSON.stringify(schema.properties.name.enum), JSON.stringify(['alpha', 'beta', 'gamma']));
}

// --- readSkillBody / resolveSkill ---
{
    const ws = path.join(tmpRoot, 'ws5');
    const home5 = path.join(tmpRoot, 'home5');
    makeSkill(ws, path.join('.xratu', 'skills', 'trunc'), 'trunc', 'Truncation', 'x'.repeat(MAX_BODY_CHARS + 100));
    makeSkill(home5, path.join('.agents', 'skills', 'global-res'), 'global-res', 'Global resources');
    const resolved = resolveSkill(ws, 'trunc');
    check('resolve: found', !!resolved, true);
    check('resolve: dirPath points at skill dir', resolved.dirPath.endsWith(path.join('.xratu', 'skills', 'trunc')), true);
    check('resolve: body starts with markdown', resolved.body.startsWith('x'), true);
    check('resolve: truncation marker', resolved.body.includes('(skill body truncated)'), true);
    check('resolve: unknown skill → null', resolveSkill(ws, 'missing'), null);
    check('readSkillBody: unreadable dir → null', readSkillBody(path.join(ws, 'nope')), null);
    // Display path: workspace-relative inside the workspace, null outside -
    // absolute host paths must never reach the model.
    const display = skillDirectoryDisplayPath(resolved.dirPath, ws);
    check('display: workspace-relative', display === path.join('.xratu', 'skills', 'trunc').split(path.sep).join('/'), true);
    check('display: global skill → null (no absolute leak)', skillDirectoryDisplayPath(path.join(home5, '.agents', 'skills', 'global-res'), ws), null);
    check('display: no workspace root → null', skillDirectoryDisplayPath(resolved.dirPath, undefined), null);
    check('display: outside workspace → null', skillDirectoryDisplayPath(path.join(tmpRoot, 'elsewhere'), ws), null);
}

// --- readSkillResource: scoped bundled-file access ---
{
    const ws = path.join(tmpRoot, 'ws6');
    const dir = makeSkill(ws, path.join('.xratu', 'skills', 'with-res'), 'with-res', 'Bundled files', 'Body');
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'references', 'guide.md'), '# Guide\n' + 'y'.repeat(300), 'utf-8');
    const outside = path.join(tmpRoot, 'secret.txt');
    fs.writeFileSync(outside, 'secret', 'utf-8');
    fs.writeFileSync(path.join(dir, 'big.md'), 'z'.repeat(MAX_RESOURCE_CHARS * 2), 'utf-8');

    check('resource: bundled file readable', readSkillResource(dir, 'references/guide.md')?.startsWith('# Guide'), true);
    check('resource: traversal rejected', readSkillResource(dir, '../../secret.txt'), null);
    check('resource: absolute path rejected', readSkillResource(dir, outside), null);
    check('resource: missing file → null', readSkillResource(dir, 'references/nope.md'), null);
    check('resource: empty path rejected', readSkillResource(dir, ''), null);
    check('resource: directory rejected', readSkillResource(dir, 'references'), null);
    check('resource: truncation marker', readSkillResource(dir, 'big.md').includes('(resource truncated)'), true);
    // Oversized raw file (>1MB) rejected BEFORE being read into memory.
    const hugeDir = makeSkill(ws, path.join('.xratu', 'skills', 'huge-res'), 'huge-res', 'Huge', 'Body');
    fs.writeFileSync(path.join(hugeDir, 'huge.md'), 'q'.repeat(2_000_000), 'utf-8');
    check('resource: oversized raw file rejected', readSkillResource(hugeDir, 'huge.md'), null);
    // Symlink escape: a link inside the skill dir pointing outside the dir.
    let linked = false;
    try {
        fs.symlinkSync(outside, path.join(dir, 'leak.txt'), 'file');
        linked = true;
    } catch {
        console.log('skip symlink-escape test (not permitted on this platform)');
    }
    if (linked) {
        check('resource: symlink escape rejected', readSkillResource(dir, 'leak.txt'), null);
    }
    // Schema advertises the optional resource argument.
    const schema = buildSkillToolSchema([{ name: 'x', description: 'd', dirPath: dir, source: 'project-xratu', bodyChars: 1 }]);
    check('resource: schema has optional resource', schema.properties.resource?.type, 'string');
    check('resource: schema name still required', JSON.stringify(schema.required), '["name"]');
}

// --- ensureBundledSkill (first-run default seeding) ---
{
    const root = path.join(tmpRoot, '.agents', 'skills');
    const md = '---\nname: natural-farsi\ndescription: Natural Persian writing rules\n---\n\nBody.\n';
    check('seed: creates folder + file', await ensureBundledSkill(root, 'natural-farsi', md), 'created');
    check('seed: file content written', fs.readFileSync(path.join(root, 'natural-farsi', 'SKILL.md'), 'utf-8'), md);
    // The seeded folder is discovered like any other global skill.
    const found = discoverSkills({ homedir: tmpRoot }).find((s) => s.name === 'natural-farsi');
    check('seed: discovered as global skill', found?.source, 'global-agents');
    check('seed: discovered description', found?.description, 'Natural Persian writing rules');
    // Exclusive create: an existing SKILL.md is a user decision - a modified
    // copy must never be clobbered by a re-seed.
    fs.writeFileSync(path.join(root, 'natural-farsi', 'SKILL.md'), '---\nname: natural-farsi\ndescription: User edit\n---\n\nMine.\n', 'utf-8');
    check('seed: existing file -> exists', await ensureBundledSkill(root, 'natural-farsi', md), 'exists');
    check('seed: user edit preserved', fs.readFileSync(path.join(root, 'natural-farsi', 'SKILL.md'), 'utf-8').includes('User edit'), true);
    // Invalid dir names are rejected up front (scanner would never see them).
    let rejected = false;
    try {
        await ensureBundledSkill(root, '../escape', md);
    } catch {
        rejected = true;
    }
    check('seed: invalid dirName rejected', rejected, true);
    // Symlinked skill dir: user-managed path - never write through the link,
    // not even for a dangling link (exclusive non-recursive mkdir fails
    // EEXIST on the link). The catch covers ONLY symlink creation: a real
    // seeding failure must fail the test, not be skipped.
    const linkDir = path.join(root, 'linked-skill');
    const outsideDir = path.join(tmpRoot, 'outside-target');
    fs.mkdirSync(outsideDir, { recursive: true });
    let symlinksOk = true;
    try {
        fs.symlinkSync(outsideDir, linkDir, 'dir');
        fs.symlinkSync(path.join(tmpRoot, 'nowhere'), path.join(root, 'dangling-skill'), 'dir');
    } catch (err) {
        if (['EPERM', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL'].includes(err.code)) {
            console.log('skip symlink tests (not permitted on this platform)');
            symlinksOk = false;
        } else {
            throw err;
        }
    }
    if (symlinksOk) {
        check('seed: symlinked dir -> exists', await ensureBundledSkill(root, 'linked-skill', md), 'exists');
        check('seed: nothing written through link', fs.existsSync(path.join(linkDir, 'SKILL.md')), false);
        check('seed: dangling symlink -> exists', await ensureBundledSkill(root, 'dangling-skill', md), 'exists');
        check('seed: dangling target untouched', fs.existsSync(path.join(root, 'nowhere')), false);
    }
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(failed === 0 ? '\nskills tests: all passed' : `\nskills tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
