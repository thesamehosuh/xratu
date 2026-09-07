/**
 * Agent Skills (https://agentskills.io) - discovery and loading.
 *
 * A skill is a folder containing SKILL.md: YAML frontmatter (name +
 * description required) followed by a markdown body. Skills are discovered
 * from five locations (highest priority first):
 *   - <workspaceRoot>/.xratu/skills/<name>/SKILL.md   (project, Xratu-specific)
 *   - <workspaceRoot>/.agents/skills/<name>/SKILL.md  (project, cross-agent)
 *   - <workspaceRoot>/.claude/skills/<name>/SKILL.md  (project, Claude Code)
 *   - <homedir>/.agents/skills/<name>/SKILL.md        (global, cross-agent)
 *   - <homedir>/.claude/skills/<name>/SKILL.md        (global, Claude Code)
 *
 * Progressive disclosure: only name + description ride the skill tool's
 * description; the full body loads on demand via the `skill` tool. Invalid
 * skills are skipped from the tool listing but surfaced to the Skills page.
 *
 * This module is host-side PURE LOGIC (node fs/path only, no vscode import)
 * so it stays node-testable like endpointGuard.ts. Windows-first: BOM- and
 * CRLF-tolerant parsing, path.join everywhere, os.homedir() (never `~`).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const SKILL_FILE = 'SKILL.md';
export const MAX_SKILLS = 50;
export const MAX_BODY_CHARS = 32_000;
export const MAX_NAME_CHARS = 64;
export const MAX_DESCRIPTION_CHARS = 1024;
/** Per-resource read cap for skill bundled files (mirrors read_file's 80KB). */
export const MAX_RESOURCE_CHARS = 80_000;
/** Raw on-disk size cap checked BEFORE readFileSync - unbounded reads of a
 *  multi-gigabyte file would balloon extension-host memory for no benefit. */
export const MAX_RAW_FILE_BYTES = 1_000_000;

function readTextFileCapped(filePath: string): string | null {
    // Open ONCE and fstat the descriptor: a stat-then-read split lets a
    // concurrently modified file grow past the cap between the two calls
    // (TOCTOU). Reading at most cap+1 bytes bounds memory regardless.
    let fd: number | undefined;
    try {
        fd = fs.openSync(filePath, 'r');
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > MAX_RAW_FILE_BYTES) return null;
        // Uninitialized allocation is safe here: only subarray(0, read) is
        // ever exposed, and read covers exactly the bytes copied from the fd.
        const buffer = Buffer.allocUnsafe(MAX_RAW_FILE_BYTES + 1);
        let read = 0;
        while (read < buffer.length) {
            const n = fs.readSync(fd, buffer, read, buffer.length - read, read);
            if (n <= 0) break;
            read += n;
        }
        if (read > MAX_RAW_FILE_BYTES) return null;
        return buffer.subarray(0, read).toString('utf-8');
    } catch {
        return null;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* best effort */ }
        }
    }
}

export type SkillSource = 'project-xratu' | 'project-agents' | 'project-claude' | 'global-agents' | 'global-claude';

/** Stable per-source identity: the same skill name can exist in several
 *  locations, and toggles must not cross-talk between copies. */
export function skillId(source: SkillSource, name: string): string {
    return `${source}:${name}`;
}

export interface DiscoveredSkill {
    name: string;
    description: string;
    /** Absolute directory containing the SKILL.md. */
    dirPath: string;
    source: SkillSource;
    /** Length of the markdown body (context-cost hint for the Skills page). */
    bodyChars: number;
    /** Validation failure - the skill is excluded from the tool listing. */
    error?: string;
    /** Set when this scan auto-renamed the folder to match the SKILL.md
     *  name - the host closes editor tabs still pointing at the old path
     *  so a stale save cannot resurrect the old folder as a duplicate. */
    renamedFrom?: string;
    /** A higher-priority location has a valid skill with the same name -
     *  this copy is never loaded, but the Skills page surfaces it so the
     *  shadowing is not invisible. */
    shadowed?: boolean;
}

export interface ParsedSkillMd {
    name?: string;
    description?: string;
    body: string;
}

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Parse a SKILL.md: `---`-delimited YAML frontmatter (first line, BOM
 *  tolerated) + markdown body. Only the spec fields are read; unknown
 *  frontmatter fields are ignored. A file whose first line is not `---` has
 *  no frontmatter and is therefore invalid (name/description missing). */
export function parseSkillMd(raw: string): ParsedSkillMd {
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    if ((lines[0] ?? '').trim() !== '---') {
        return { body: text.trim() };
    }
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
            end = i;
            break;
        }
    }
    if (end === -1) {
        return { body: text.trim() };
    }
    const parsed: ParsedSkillMd = { body: lines.slice(end + 1).join('\n').trim() };
    for (const line of lines.slice(1, end)) {
        const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1];
        // Strip a single matching pair of quotes; inline comments are not
        // part of the spec's two required fields, so keep the value verbatim.
        let value = m[2].trim();
        if (value.length >= 2
            && ((value.startsWith('"') && value.endsWith('"'))
                || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        // Scalar values only: this deliberately tiny parser (no YAML
        // dependency for two flat fields) must not mistake block scalars
        // (`>`, `|`), anchors/aliases, flow collections, or list items for
        // the value - treating them as absent surfaces a validation error
        // on the Skills page instead of garbage like ">" as a description.
        if (/^[>|&*!%@`]/.test(value) || /^-\s/.test(value)) {
            continue;
        }
        // An empty value means the field's real content is a nested YAML
        // structure we don't parse - treat the field as absent.
        if (value === '') {
            continue;
        }
        if (key === 'name' || key === 'description') {
            parsed[key] = value;
        }
        // license / compatibility / metadata / unknown → accepted, ignored.
    }
    return parsed;
}

function validateSkillName(name: string | undefined, dirName: string): string | null {
    // The agentskills.io spec requires an explicit `name` matching the
    // directory - a missing field is an error, not a directory fallback.
    if (name === undefined || name === '') return 'name is missing';
    if (name.length > MAX_NAME_CHARS) return `name exceeds ${MAX_NAME_CHARS} characters`;
    if (!NAME_RE.test(name)) return `name "${name}" is invalid (lowercase alphanumeric with single hyphens)`;
    if (name !== dirName) return `name "${name}" does not match the directory name "${dirName}"`;
    return null;
}

function readSkillFile(skillDir: string): ParsedSkillMd | null {
    const raw = readTextFileCapped(path.join(skillDir, SKILL_FILE));
    return raw === null ? null : parseSkillMd(raw);
}

/** Scan one skills/<name>/SKILL.md parent directory. Symlinked entries that
 *  resolve to directories count (shared skill libraries), mirroring the
 *  Claude Code / Roo Code behavior. Duplicates of an already-discovered name
 *  are recorded in `shadowed` (in scan order) instead of being dropped, so
 *  the Skills page can show why they never load. ONLY a valid winner
 *  shadows lower-priority copies: an invalid/unreadable higher-priority
 *  entry must not block a valid lower-priority one - it is demoted to the
 *  `shadowed` list (still displayed with its error) so the valid copy loads. */
function scanSkillDir(
    baseDir: string,
    source: SkillSource,
    out: Map<string, DiscoveredSkill>,
    validNames: Set<string>,
    shadowed: DiscoveredSkill[],
): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        let dirName = entry.name;
        let skillDir = path.join(baseDir, dirName);
        let isDir = entry.isDirectory();
        if (!isDir && entry.isSymbolicLink()) {
            try {
                isDir = fs.statSync(skillDir).isDirectory();
            } catch {
                isDir = false;
            }
        }
        if (!isDir) continue;
        if (!fs.existsSync(path.join(skillDir, SKILL_FILE))) continue;
        const parsed = readSkillFile(skillDir);

        // Auto-heal: the spec ties the folder name to the SKILL.md `name`,
        // and editing the frontmatter is the normal authoring flow - so a
        // well-formed name that differs from its folder is renamed to match
        // right here, instead of dead-ending in a permanent mismatch error.
        // Renames that would collide with an existing folder are skipped
        // (the mismatch error stays visible). `renamedFrom` lets the host
        // close editor tabs still pointing at the old path.
        let renamedFrom: string | undefined;
        if (parsed && parsed.name && parsed.name !== dirName && NAME_RE.test(parsed.name) && parsed.name.length <= MAX_NAME_CHARS) {
            const target = path.join(baseDir, parsed.name);
            if (!fs.existsSync(target)) {
                try {
                    fs.renameSync(skillDir, target);
                    renamedFrom = dirName;
                    dirName = parsed.name;
                    skillDir = target;
                } catch {
                    /* keep the mismatch state */
                }
            }
        }

        const previous = out.get(dirName);
        // A higher-priority VALID copy wins; this copy is still parsed and
        // flagged as shadowed. An invalid previous copy is demoted so a
        // valid entry can take over below.
        const isShadowed = validNames.has(dirName);
        if (!parsed) {
            const entryOut: DiscoveredSkill = {
                name: dirName,
                description: '',
                dirPath: skillDir,
                source,
                bodyChars: 0,
                error: `${SKILL_FILE} is not readable`,
                ...(renamedFrom ? { renamedFrom } : {}),
                ...(isShadowed ? { shadowed: true } : {}),
            };
            if (isShadowed) shadowed.push(entryOut);
            else out.set(dirName, entryOut);
            continue;
        }
        const nameError = validateSkillName(parsed.name, dirName);
        const description = (parsed.description ?? '').trim();
        const error = nameError
            ?? (description ? undefined : 'description is missing')
            ?? (description.length > MAX_DESCRIPTION_CHARS
                ? `description exceeds ${MAX_DESCRIPTION_CHARS} characters`
                : undefined);
        const entryOut: DiscoveredSkill = {
            name: dirName,
            description: description.slice(0, MAX_DESCRIPTION_CHARS),
            dirPath: skillDir,
            source,
            bodyChars: parsed.body.length,
            ...(error ? { error } : {}),
            ...(renamedFrom ? { renamedFrom } : {}),
            ...(isShadowed ? { shadowed: true } : {}),
        };
        if (error) {
            // Invalid entries never shadow anything, valid or not.
            if (isShadowed) shadowed.push(entryOut);
            else {
                if (previous) shadowed.push(previous);
                out.set(dirName, entryOut);
            }
            continue;
        }
        if (isShadowed) {
            shadowed.push(entryOut);
        } else {
            if (previous) shadowed.push(previous);
            out.set(dirName, entryOut);
            validNames.add(dirName);
        }
    }
}

/** Discover skills across all locations. Lower-priority duplicates of the
 *  same name are kept with `shadowed: true` (excluded from listing but
 *  visible on the Skills page); invalid entries are kept so the Skills page
 *  can show why a skill is not loading. Winners sort first, then by name. */
export function discoverSkills(opts?: {
    workspaceRoot?: string;
    homedir?: string;
}): DiscoveredSkill[] {
    const workspaceRoot = opts?.workspaceRoot;
    const home = opts?.homedir ?? os.homedir();
    const found = new Map<string, DiscoveredSkill>();
    const validNames = new Set<string>();
    const shadowed: DiscoveredSkill[] = [];
    if (workspaceRoot) {
        scanSkillDir(path.join(workspaceRoot, '.xratu', 'skills'), 'project-xratu', found, validNames, shadowed);
        scanSkillDir(path.join(workspaceRoot, '.agents', 'skills'), 'project-agents', found, validNames, shadowed);
        scanSkillDir(path.join(workspaceRoot, '.claude', 'skills'), 'project-claude', found, validNames, shadowed);
    }
    scanSkillDir(path.join(home, '.agents', 'skills'), 'global-agents', found, validNames, shadowed);
    scanSkillDir(path.join(home, '.claude', 'skills'), 'global-claude', found, validNames, shadowed);
    const skills = [
        ...Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name)),
        ...shadowed,
    ];
    return skills.slice(0, MAX_SKILLS);
}

/** Filter to the skills the agent may invoke: valid, not shadowed, and not
 *  user-disabled. Disabled entries may be stored as `source:name` ids (the
 *  current scheme) or bare names (pre-id scheme) - both still match. */
export function listableSkills(
    skills: DiscoveredSkill[],
    disabledIds?: ReadonlySet<string>,
): DiscoveredSkill[] {
    return skills.filter((s) => !s.error && !s.shadowed
        && !(disabledIds?.has(skillId(s.source, s.name)) || disabledIds?.has(s.name)));
}

/** Build the `skill` tool's description: usage + the <available_skills> list
 *  (name + description per skill, OpenCode-format). Empty when no skills are
 *  listable - the host omits the tool entirely in that case. */
export function buildSkillToolDescription(skills: DiscoveredSkill[]): string {
    if (skills.length === 0) return '';
    const escapeXmlText = (s: string): string =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const entries = skills.map((s) =>
        `  <skill>\n    <name>${escapeXmlText(s.name)}</name>\n    <description>${escapeXmlText(s.description.replace(/[\u0000-\u001f]/g, ' '))}</description>\n  </skill>`
    ).join('\n');
    return [
        'Load the full instructions of an Agent Skill when the current task matches one.',
        'The instructions arrive as tool output; follow them for the task at hand.',
        `A skill may bundle extra files (scripts, references, templates) next to its SKILL.md. Read one with skill({ name, resource: "relative/path/from/SKILL.md" }) - resource paths stay inside the skill's directory; traversal outside it is rejected.`,
        'Available skills:',
        `<available_skills>`,
        entries,
        `</available_skills>`,
    ].join('\n');
}

/** Build the `skill` tool's JSON schema (enum-pinned to listable names). */
export function buildSkillToolSchema(skills: DiscoveredSkill[]): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Skill name from <available_skills>',
                enum: skills.map((s) => s.name),
            },
            resource: {
                type: 'string',
                description: 'Optional: read a bundled file instead of the skill instructions, path relative to the skill directory (e.g. "references/guide.md")',
            },
        },
        required: ['name'],
    };
}

/** Read a skill's body (markdown after the frontmatter), truncated at
 *  MAX_BODY_CHARS. Returns null when the file is missing/unreadable. */
export function readSkillBody(dirPath: string): string | null {
    const parsed = readSkillFile(dirPath);
    if (!parsed) return null;
    const body = parsed.body;
    if (body.length > MAX_BODY_CHARS) {
        return body.slice(0, MAX_BODY_CHARS) + '\n… (skill body truncated)';
    }
    return body;
}

/** Workspace-relative display path for a skill directory (forward slashes,
 *  so the model can use it with read_file on any OS), or null when the skill
 *  lives outside the workspace (global skills) - absolute host paths are
 *  never surfaced to the model. */
export function skillDirectoryDisplayPath(dirPath: string, workspaceRoot: string | undefined): string | null {
    if (!workspaceRoot) return null;
    let rel: string;
    try {
        rel = path.relative(workspaceRoot, dirPath);
    } catch {
        return null;
    }
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
}

/** Resolve one skill by name: rescan the locations (fresh disk state,
 *  priority order). Returns the validated skill entry or null. */
export function findSkillDir(
    workspaceRoot: string | undefined,
    name: string,
): string | null {
    const match = discoverSkills({ workspaceRoot })
        .find((s) => s.name === name && !s.error && !s.shadowed);
    return match ? match.dirPath : null;
}

/** Resolve one skill by name at dispatch time, then read the body. Keeps
 *  dispatchTool self-contained - no skill state has to travel through the
 *  executor. */
export function resolveSkill(
    workspaceRoot: string | undefined,
    name: string,
): { dirPath: string; body: string } | null {
    const dirPath = findSkillDir(workspaceRoot, name);
    if (!dirPath) return null;
    const body = readSkillBody(dirPath);
    if (body === null) return null;
    return { dirPath, body };
}

/** Result of the dispatch-time skill resolution. */
export type SkillResolution =
    | { status: 'ok'; skill: DiscoveredSkill }
    | { status: 'disabled' }
    | { status: 'missing' };

/** Single dispatch-time resolver: discovers fresh, resolves the winning
 *  copy of `name` (valid, not shadowed), and checks it against the disabled
 *  set (ids or legacy bare names). One scan serves both the authorization
 *  gate and the body load - no second discovery in dispatchTool. */
export function resolveSkillForRun(
    workspaceRoot: string | undefined,
    name: string,
    disabledIds?: ReadonlySet<string>,
): SkillResolution {
    try {
        const match = discoverSkills({ workspaceRoot })
            .find((s) => s.name === name && !s.error && !s.shadowed);
        if (!match) return { status: 'missing' };
        if (disabledIds
            && (disabledIds.has(skillId(match.source, match.name)) || disabledIds.has(match.name))) {
            return { status: 'disabled' };
        }
        return { status: 'ok', skill: match };
    } catch {
        return { status: 'missing' };
    }
}

/** Materialize one bundled skill into a skills root (first-run default
 *  seeding, McpConfigStore.seedDefaults-style). Exclusive-create semantics:
 *  an existing SKILL.md is a user decision (edited, replaced, or deleted on
 *  purpose after the once-flag) and is never clobbered - concurrent creates
 *  and existing folders resolve to 'exists'. Returns 'created' or 'exists';
 *  anything else throws. */
export async function ensureBundledSkill(
    skillsRoot: string,
    dirName: string,
    skillMd: string,
): Promise<'created' | 'exists'> {
    if (!NAME_RE.test(dirName)) {
        throw new Error(`bundled skill dirName "${dirName}" is invalid`);
    }
    const skillDir = path.join(skillsRoot, dirName);
    // Create the skill DIRECTORY exclusively before writing: non-recursive
    // mkdir does not follow a symlink on the final component, so a symlinked
    // path (or a race that swaps one in) fails EEXIST instead of letting the
    // SKILL.md write escape skillsRoot (CWE-59). The root itself is ours to
    // manage; the skill dir is the user-managed boundary.
    await fs.promises.mkdir(skillsRoot, { recursive: true });
    try {
        await fs.promises.mkdir(skillDir);
    } catch (err: unknown) {
        // EEXIST: real dir, symlink, dangling link, or a lost race - all are
        // user-managed paths ('exists', never clobbered).
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return 'exists';
        throw err;
    }
    const target = path.join(skillDir, SKILL_FILE);
    try {
        await fs.promises.writeFile(target, skillMd, { encoding: 'utf-8', flag: 'wx' });
        return 'created';
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return 'exists';
        throw err;
    }
}

/** Read one bundled resource of a skill, scoped to the skill's directory:
 *  rejects absolute paths, lexical traversal (`..`), and symlink escapes
 *  (realpath containment). Truncated at MAX_RESOURCE_CHARS. Returns null
 *  for anything missing, unreadable, or out of scope - never an error that
 *  could leak host paths. */
export function readSkillResource(dirPath: string, resourceRel: string): string | null {
    if (!resourceRel || path.isAbsolute(resourceRel)) return null;
    const base = path.resolve(dirPath);
    let full: string;
    try {
        full = path.resolve(base, resourceRel);
    } catch {
        return null;
    }
    const rel = path.relative(base, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    try {
        const realDir = fs.realpathSync(base);
        const real = fs.realpathSync(full);
        const realRel = path.relative(realDir, real);
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
        if (!fs.statSync(real).isFile()) return null;
        let text = readTextFileCapped(real);
        if (text === null) return null;
        if (text.length > MAX_RESOURCE_CHARS) {
            text = text.slice(0, MAX_RESOURCE_CHARS) + '\n… (resource truncated)';
        }
        return text;
    } catch {
        return null;
    }
}
