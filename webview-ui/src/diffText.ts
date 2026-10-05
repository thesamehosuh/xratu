/**
 * Unified-diff parsing and code-language mapping, shared by the transcript's
 * diff pills and the approval card. Pure text in, pure data out — no React and
 * no VS Code APIs, so it is directly unit-testable.
 */

export interface DiffLine {
    kind: 'add' | 'del' | 'ctx';
    text: string;
    oldNo?: number;
    newNo?: number;
}

export function parseDiffLines(lines: string[]): DiffLine[] {
    let oldNo = 0;
    let newNo = 0;
    const out: DiffLine[] = [];

    for (const line of lines) {
        const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            oldNo = Number(hunk[1]);
            newNo = Number(hunk[2]);
            continue;
        }

        if (line.startsWith('+') && !line.startsWith('+++')) {
            out.push({ kind: 'add', text: line.slice(1), newNo });
            newNo += 1;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            out.push({ kind: 'del', text: line.slice(1), oldNo });
            oldNo += 1;
        } else {
            out.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo, newNo });
            oldNo += 1;
            newNo += 1;
        }
    }

    return out;
}

/** Escape text for `dangerouslySetInnerHTML`. Every string that reaches it is
 *  model-controlled (a diff body, a file's contents), so an unescaped one
 *  would inject markup verbatim. */
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const LANG_BY_EXT: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    rb: 'ruby', php: 'php', swift: 'swift', scala: 'scala',
    html: 'html', css: 'css', scss: 'scss', json: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
    md: 'markdown', sh: 'bash', bash: 'bash', sql: 'sql',
    vue: 'vue', svelte: 'svelte',
};

export function extToLang(file: string): string {
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    return LANG_BY_EXT[ext] ?? 'text';
}

/** Split a path into a directory prefix and a basename, normalising Windows
 *  separators first: this repo is Windows-first and the agent may hand back
 *  either slash style, so splitting on `/` alone would leave a whole
 *  `src\lib` path sitting in the dim half and an empty-looking basename. */
export function splitPath(path: string): { dir: string; base: string } {
    const normalized = path.replace(/\\/g, '/');
    const i = normalized.lastIndexOf('/');
    if (i < 0) return { dir: '', base: normalized };
    return { dir: normalized.slice(0, i + 1), base: normalized.slice(i + 1) };
}