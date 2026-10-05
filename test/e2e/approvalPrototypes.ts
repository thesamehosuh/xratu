/**
 * Approval-card redesign - PROTOTYPE markup and CSS.
 *
 * This is a DESIGN REVIEW ARTEFACT, not product code. Nothing here ships: the
 * approved direction is re-implemented in `webview-ui/src/components/
 * MessageItem.tsx` + `theme.css` (PR 2 of the plan). The prototypes are static
 * markup on purpose - the point is to compare STRUCTURE at real widths in both
 * locales, and a static block screenshots identically on every run so two
 * directions can be compared without rebuilding the bundle between shots.
 *
 * Rules the prototypes hold themselves to (they pre-commit the token discipline
 * the real implementation must satisfy):
 *  - tokens only: `--xratu-*` / `--vscode-*`, no raw hex, no raw `rgba()`,
 *    no raw radii, no raw font sizes;
 *  - RTL-safe: logical properties only (`margin-inline`, `padding-block`,
 *    `border-block`, `inset-inline`). `dir="ltr"` on paths, commands, diffs and
 *    line numbers;
 *  - the diff colours come from the user's theme via `--vscode-
 *    gitDecoration-*`, so no `#3fb950` anywhere.
 */

export type Direction = 'a' | 'b' | 'c';

export interface Copy {
    approveN: (n: number) => string;
    files: string;
    deny: string;
    approve: string;
    session: string;
    applying: string;
    approved: string;
    rejected: string;
    mixed: string;
    preDenied: string;
    modify: string;
    create: string;
    delete: string;
    runCommand: string;
    turn: string;
}

export const COPY: Record<'fa' | 'en', Copy> = {
    fa: {
        approveN: (n) => `تایید ${n} تغییر`,
        files: 'فایل',
        deny: 'رد همه',
        approve: 'تایید و اجرا',
        session: 'برای این نشست',
        applying: 'در حال اعمال…',
        approved: 'تغییرات تایید شد',
        rejected: 'تغییرات رد شد',
        mixed: 'برخی تغییرات تایید شد',
        preDenied: 'خودکار رد شد',
        modify: 'ویرایش فایل',
        create: 'ساخت فایل',
        delete: 'حذف فایل',
        runCommand: 'اجرای دستور',
        turn: 'دارم مسیر احراز هویت رو اضافه می کنم و تست هاش رو می نویسم.',
    },
    en: {
        approveN: (n) => `Approve ${n} edits`,
        files: 'files',
        deny: 'Deny all',
        approve: 'Approve & run',
        session: 'Allow this session',
        applying: 'Applying…',
        approved: 'Changes approved',
        rejected: 'Changes rejected',
        mixed: 'Some changes approved',
        preDenied: 'Auto-denied',
        modify: 'Modify file',
        create: 'Create file',
        delete: 'Delete file',
        runCommand: 'Run command',
        turn: 'Adding the auth path now, then writing the tests for it.',
    },
};

/* ------------------------------------------------------------------ icons */

const svg = (paths: string, size = 12) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICON = {
    shield: svg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    clock: svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
    chevron: svg('<path d="m9 18 6-6-6-6"/>', 11),
    caret: svg('<path d="m6 9 6 6 6-6"/>', 11),
};

/* ---------------------------------------------------------------- fixtures */

export interface DiffLine {
    kind: 'add' | 'del' | 'ctx';
    old?: number;
    cur?: number;
    text: string;
}

export interface Row {
    id: string;
    /** `null` for a non-diff tool: the command / JSON preview takes its place. */
    diff: { file: string; added: number; removed: number; lines: DiffLine[] } | null;
    label: string;
    command?: string;
    json?: string;
    preDenied?: boolean;
    /** Long-path fixture: forces the dir segment to ellipsize at 420px. */
    longPath?: boolean;
}

const TS_DIFF: DiffLine[] = [
    { kind: 'ctx', old: 12, cur: 12, text: 'export function signIn(user: User) {' },
    { kind: 'del', old: 13, text: '  const token = localStorage.getItem("token");' },
    { kind: 'add', cur: 13, text: '  const token = await session.readRefreshToken();' },
    { kind: 'add', cur: 14, text: '  if (!token) throw new AuthError("session expired");' },
    { kind: 'ctx', old: 14, cur: 15, text: '' },
    { kind: 'del', old: 15, text: '  if (!token) return null;' },
    { kind: 'add', cur: 16, text: '  return verify(token, process.env.JWT_SECRET);' },
    { kind: 'ctx', old: 16, cur: 17, text: '}' },
];

const CSS_DIFF: DiffLine[] = [
    { kind: 'ctx', old: 40, cur: 40, text: '.token {' },
    { kind: 'del', old: 41, text: '  color: #f85149;' },
    { kind: 'add', cur: 41, text: '  color: var(--token-ink);' },
    { kind: 'add', cur: 42, text: '  font-variant-numeric: tabular-nums;' },
    { kind: 'ctx', old: 42, cur: 43, text: '}' },
];

export const STATE_FIXTURES: Record<string, { rows: Row[]; resolution?: 'approved' | 'rejected' | 'mixed'; submitting?: boolean; open?: string[] }> = {
    /** 1 - the hero state: pending, multi-file, with diffs. */
    hero: {
        rows: [
            { id: 'r1', label: 'src/auth/session.ts', diff: { file: 'src/auth/session.ts', added: 3, removed: 2, lines: TS_DIFF } },
            { id: 'r2', label: 'webview-ui/src/styles/token.css', diff: { file: 'webview-ui/src/styles/token.css', added: 2, removed: 1, lines: CSS_DIFF } },
        ],
    },
    /** 2 - single terminal command, no diff. */
    command: {
        rows: [{
            id: 'c1',
            label: 'npm run build:webview',
            diff: null,
            command: 'npm run build:webview && npx tsc --noEmit -p webview-ui/tsconfig.json',
        }],
    },
    /** 3 - non-diff tool with JSON args (the JSON.stringify fallback). */
    args: {
        rows: [{
            id: 'a1',
            label: 'mcp__github__create_issue',
            diff: null,
            json: '{\n  "owner": "xratu",\n  "repo": "vscode-xratu",\n  "title": "Approval card: flat ledger",\n  "labels": ["enhancement", "ui"]\n}',
        }],
    },
    /** 4 - a preDenied item mixed in. */
    preDenied: {
        rows: [
            { id: 'p1', label: 'src/auth/session.ts', diff: { file: 'src/auth/session.ts', added: 3, removed: 2, lines: TS_DIFF } },
            { id: 'p2', label: 'rm -rf build', diff: null, command: 'rm -rf build', preDenied: true },
        ],
    },
    /** 5 - nothing approvable: both approve buttons disabled. */
    noneApprovable: {
        rows: [
            { id: 'n1', label: 'rm -rf build', diff: null, command: 'rm -rf build', preDenied: true },
            { id: 'n2', label: 'git push --force origin main', diff: null, command: 'git push --force origin main', preDenied: true },
        ],
    },
    /** 6 - mid-flight. */
    submitting: { rows: STATE_HERO_ROWS(), submitting: true },
    /** 7 - settled, three ways. */
    resolvedApproved: { rows: STATE_HERO_ROWS(), resolution: 'approved' },
    resolvedRejected: { rows: STATE_HERO_ROWS(), resolution: 'rejected' },
    resolvedMixed: { rows: STATE_HERO_ROWS(), resolution: 'mixed' },
    /** 8 - one row expanded (diff / command). */
    expandedDiff: { rows: STATE_HERO_ROWS(), open: ['r1'] },
    expandedCommand: { rows: STATE_HERO_ROWS(), open: ['c1'] },
    /** 9 - truncation. */
    long: {
        rows: [
            {
                id: 'l1',
                label: 'webview-ui/src/components/settings/credentials/ProvidersSection.tsx',
                diff: null,
                command: 'node scripts/release.mjs --tag v1.5.0 --notes "approval card: flat review ledger, tokens first" --publish vsix dist',
                longPath: true,
            },
            {
                id: 'l2',
                label: 'webview-ui/src/components/settings/credentials/ProvidersSection.test.tsx',
                diff: { file: 'webview-ui/src/components/settings/credentials/ProvidersSection.test.tsx', added: 128, removed: 44, lines: CSS_DIFF },
                longPath: true,
            },
        ],
        open: ['l1'],
    },
};

function STATE_HERO_ROWS(): Row[] {
    return [
        { id: 'r1', label: 'src/auth/session.ts', diff: { file: 'src/auth/session.ts', added: 3, removed: 2, lines: TS_DIFF } },
        { id: 'r2', label: 'webview-ui/src/styles/token.css', diff: { file: 'webview-ui/src/styles/token.css', added: 2, removed: 1, lines: CSS_DIFF } },
        { id: 'c1', label: 'npm run build:webview', diff: null, command: 'npm run build:webview && npx tsc --noEmit -p webview-ui/tsconfig.json' },
    ];
}

export const STATE_ORDER: { key: string; note: string }[] = [
    { key: 'hero', note: '1 pending, multi-file, diffs' },
    { key: 'command', note: '2 pending, one terminal command' },
    { key: 'args', note: '3 pending, JSON args fallback' },
    { key: 'preDenied', note: '4 preDenied item mixed in' },
    { key: 'noneApprovable', note: '5 nothing approvable' },
    { key: 'submitting', note: '6 submitting' },
    { key: 'resolvedApproved', note: '7a approved' },
    { key: 'resolvedRejected', note: '7b rejected' },
    { key: 'resolvedMixed', note: '7c mixed' },
    { key: 'expandedDiff', note: '8a row expanded: diff' },
    { key: 'expandedCommand', note: '8b row expanded: command' },
    { key: 'long', note: '9 long path + command' },
];

/* -------------------------------------------------------------------- CSS */

/**
 * Prototype CSS. Every rule is scoped under `.proto` and uses tokens only.
 * Scoping matters: the built bundle already defines `.approval-*`, `.diff-*`
 * and `.msg` for the REAL card, and an unscoped prototype rule would silently
 * restyle the product surface it is being compared against.
 */
export const PROTO_CSS = `
.proto {
    /* Diff colours come from the USER'S theme, not from a hardcoded GitHub
       palette: --vscode-gitDecoration-* is the one token family every VS Code
       theme already defines for exactly this. This is what PR 1 should
       formalise as --xratu-diff-add / --xratu-diff-del.
       The fallback is deliberately NOT currentColor: it must be a readable
       green/red so a theme that omits the token still shows a legible diff
       instead of add/del collapsing into one undifferentiated colour. */
    --proto-add: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
    --proto-del: var(--vscode-gitDecoration-removedResourceForeground, #f85149);
    --proto-add-bg: color-mix(in srgb, var(--proto-add) 12%, transparent);
    --proto-del-bg: color-mix(in srgb, var(--proto-del) 12%, transparent);
    --proto-hair: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    --proto-hair-soft: color-mix(in srgb, var(--vscode-foreground) 7%, transparent);
    width: 100%;
    font-family: inherit;
}

/* ---- shared atoms -------------------------------------------------- */

.proto-ledger {
    display: flex;
    align-items: baseline;
    gap: 7px;
    margin-inline-start: auto;
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
    font-size: var(--xratu-fs-xs);
}
.proto-ledger .n {
    font-family: var(--vscode-editor-font-family);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
}
.proto-ledger .add { color: var(--proto-add); }
.proto-ledger .del { color: var(--proto-del); }

.proto-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 24px;
    padding-inline: 10px;
    border-radius: var(--xratu-radius-xs);
    border: 1px solid transparent;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-family: inherit;
    font-size: var(--xratu-fs-sm);
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
}
.proto-btn.ghost:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
.proto-btn.deny:hover { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent); }
.proto-btn.go {
    color: var(--vscode-button-foreground, var(--xratu-accent-strong));
    background: var(--vscode-button-background, var(--xratu-accent-faint));
    border-color: var(--vscode-button-border, var(--xratu-accent-dim));
}
.proto-btn.go:hover { background: var(--vscode-button-hoverBackground, var(--xratu-accent-dim)); }
.proto-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.proto-btn.icon { width: 24px; padding-inline: 0; }
/* The bundled spinner class paints only when the real .step markup wraps it;
   here it needs its own box or the "Applying…" button collapses. */
.proto-btn .step-status.spinner {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, var(--vscode-button-foreground, var(--xratu-accent-strong)) 35%, transparent);
    border-block-start-color: var(--vscode-button-foreground, var(--xratu-accent-strong));
    animation: proto-spin 720ms linear infinite;
}
@keyframes proto-spin { to { transform: rotate(360deg); } }

/* A standing permission is not a verdict: it never gets a filled button, and
   its label stays in the UI face (not mono) so it does not read as data. */
.proto-link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 0;
    border: 0;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-family: inherit;
    font-size: var(--xratu-fs-xs);
    cursor: pointer;
}
.proto-link:hover { color: var(--xratu-accent-strong); }
.proto-link:disabled { opacity: 0.45; cursor: not-allowed; }

.proto-verdict {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-inline-start: auto;
    white-space: nowrap;
}
.proto-verdict .proto-btn.go { min-width: 92px; }
.proto-btn.spin svg { display: none; }

.proto-rows { display: flex; flex-direction: column; }

.proto-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding-block: 5px;
    border-top: 1px solid var(--proto-hair-soft);
}
.proto-row .caret {
    flex: 0 0 auto;
    color: var(--vscode-descriptionForeground);
    transition: transform var(--xratu-dur-2) var(--xratu-ease-settle);
}
[dir='rtl'] .proto-row .caret { transform: scaleX(-1); }
.proto-row.open .caret { transform: rotate(180deg); }
[dir='rtl'] .proto-row.open .caret { transform: scaleX(-1) rotate(180deg); }
.proto-row:hover { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 45%, transparent); }

/* The file identity is ONE mono run: a dim directory and a bright basename in
   the same line. The old card stacked name over path, which cost 14px per row
   and repeated the basename twice.
   A long path must truncate the DIRECTORY and never the basename: the file
   being approved is identified by its name, and a single text-overflow on
   the whole run clips the tail - which is the basename. So the dir is the
   shrinkable flex child that ellipsizes and the basename is fixed. */
.proto-path {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    direction: ltr;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--xratu-fs-sm);
}
.proto-path .dir {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--vscode-descriptionForeground);
}
.proto-path .base {
    flex: 0 0 auto;
    white-space: nowrap;
    color: var(--vscode-foreground);
    font-weight: 600;
}
/* A non-diff row has no directory to absorb the shrink, so its label (a
   command) has to ellipsize itself - and it needs overflow:hidden on the
   parent too, or the nowrap child paints straight past the row edge. */
.proto-path .base.trunc {
    min-width: 0;
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
}

.proto-stats {
    flex: 0 0 auto;
    display: inline-flex;
    gap: 6px;
    direction: ltr;
    font-family: var(--vscode-editor-font-family);
    font-variant-numeric: tabular-nums;
    font-size: var(--xratu-fs-xs);
    font-weight: 600;
}
.proto-stats .add { color: var(--proto-add); }
.proto-stats .del { color: var(--proto-del); }

.proto-tag {
    flex: 0 0 auto;
    padding: 1px 5px;
    border-radius: var(--xratu-radius-xs);
    color: var(--vscode-errorForeground);
    background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
    font-size: var(--xratu-fs-xs);
}
.proto-body { padding-block: 2px 8px; padding-inline-start: 17px; }

.proto-diff {
    border: 1px solid var(--proto-hair);
    border-radius: var(--xratu-radius-xs);
    overflow: auto;
    max-height: 190px;
    direction: ltr;
}
.proto-diff table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--xratu-fs-xs);
    line-height: 1.55;
}
.proto-diff td { padding-block: 0; white-space: pre; }
.proto-diff .no {
    width: 30px;
    padding-inline: 5px;
    text-align: right;
    user-select: none;
    color: var(--vscode-descriptionForeground);
    border-inline-end: 1px solid var(--proto-hair-soft);
}
.proto-diff .mk { width: 14px; text-align: center; user-select: none; }
.proto-diff .code { padding-inline: 7px; }
.proto-diff tr.add { background: var(--proto-add-bg); }
.proto-diff tr.add .mk, .proto-diff tr.add .code { color: var(--proto-add); }
.proto-diff tr.del { background: var(--proto-del-bg); }
.proto-diff tr.del .mk, .proto-diff tr.del .code { color: var(--proto-del); }
.proto-diff tr.ctx .code { color: var(--vscode-descriptionForeground); }

.proto-cmd {
    margin: 0;
    padding: 7px 8px;
    border: 1px solid var(--proto-hair);
    border-radius: var(--xratu-radius-xs);
    background: var(--xratu-code-bg);
    color: var(--vscode-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--xratu-fs-xs);
    line-height: 1.5;
    direction: ltr;
    text-align: start;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.proto-cmd-label {
    margin-block-end: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: var(--xratu-fs-xs);
}



.proto-title {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--vscode-foreground);
    font-size: var(--xratu-fs-md);
    font-weight: 650;
    line-height: 1.25;
}
.proto-mark {
    flex: 0 0 auto;
    display: inline-flex;
    color: var(--xratu-accent-strong);
}
.proto-mark.approved { color: var(--proto-add); }
.proto-mark.rejected { color: var(--vscode-errorForeground); }

/* ---- A: flat review ledger ------------------------------------------
   No card. Hairline rules do the grouping, the verdict row carries the actions,
   and the dense table below is the actual content. */

.a {
    margin-block: 8px 2px;
    border-block: 1px solid var(--proto-hair);
}
.a-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    padding-block: 5px;
}
.a-table { display: flex; flex-direction: column; }
.a-row {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    min-height: 26px;
    padding-block: 4px;
    border-top: 1px solid var(--proto-hair-soft);
}
.a-row .proto-path { font-size: var(--xratu-fs-xs); }
.a-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-block: 6px;
    border-top: 1px solid var(--proto-hair-soft);
}
/* ---- B: verdict bar + action footer ---------------------------------
   Same ledger as A, but the actions sit in a footer pinned to the bottom of
   the scrolling transcript, so the verdict stays reachable while a long diff
   is open. */

.b {
    margin-block: 8px 2px;
    border-block: 1px solid var(--proto-hair);
}
.b-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    padding-block: 5px;
}
.b-list { display: flex; flex-direction: column; }
.b-foot {
    position: sticky;
    inset-block-end: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding-block: 7px;
    border-top: 1px solid var(--proto-hair);
    background: var(--xratu-shell);
}
.b-foot .proto-btn.go { margin-inline-start: auto; }

/* ---- C: summary-first disclosure -------------------------------------
   One line when idle: the verdict, the ledger and the actions share a single
   30px row. Everything else is one click away. */

.c {
    margin-block: 8px 2px;
    border-block: 1px solid var(--proto-hair);
}
.c-sum {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    padding-block: 4px;
    cursor: pointer;
}
.c-sum .proto-title { font-size: var(--xratu-fs-sm); font-weight: 650; }
.c-toggle {
    flex: 0 0 auto;
    display: inline-flex;
    color: var(--vscode-descriptionForeground);
    transition: transform var(--xratu-dur-2) var(--xratu-ease-settle);
}
.c.open .c-toggle { transform: rotate(180deg); }
[dir='rtl'] .c-toggle { transform: scaleX(-1); }
[dir='rtl'] .c.open .c-toggle { transform: scaleX(-1) rotate(180deg); }
.c-body { display: none; padding-block-end: 6px; }
.c.open .c-body { display: block; }


/* At 420px the three labels of A's verdict row no longer fit beside the
   ledger. Dropping the deny/session labels to icons is worse than losing the
   session affordance entirely, so the row keeps TWO buttons and the standing
   permission stays on the footer line - it was never a verdict anyway. */
@media (max-width: 460px) {
    .proto-ledger .files { display: none; }
}
`;

/* ----------------------------------------------------------------- markup */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function splitPath(file: string): string {
    const i = file.lastIndexOf('/');
    return i < 0 ? { dir: '', base: file } : { dir: file.slice(0, i + 1), base: file.slice(i + 1) };
}

/** Dir dimmed + basename bright, in one mono run. Long paths ellipsize the
 *  directory, never the basename - the file identity is what is being read. */
function pathCell(file: string): string {
    const { dir, base } = splitPath(file);
    return `<span class="proto-path"><span class="dir">${esc(dir)}</span><span class="base">${esc(base)}</span></span>`;
}

function statsCell(row: Row): string {
    if (!row.diff) return '';
    return `<span class="proto-stats" dir="ltr"><span class="add">+${row.diff.added}</span>`
        + `<span class="del">−${row.diff.removed}</span></span>`;
}

function diffTable(row: Row): string {
    if (!row.diff) return '';
    const body = row.diff.lines.map((l) => {
        const kind = l.kind;
        const mk = kind === 'add' ? '+' : kind === 'del' ? '−' : '';
        return `<tr class="${kind}"><td class="no">${l.old ?? ''}</td><td class="no">${l.cur ?? ''}</td>`
            + `<td class="mk">${mk}</td><td class="code">${esc(l.text) || '&nbsp;'}</td></tr>`;
    }).join('');
    return `<div class="proto-diff"><table><tbody>${body}</tbody></table></div>`;
}

function bodyCell(row: Row, c: Copy): string {
    if (row.diff) return diffTable(row);
    if (row.command) return `<div class="proto-cmd-label">${esc(c.runCommand)}</div><pre class="proto-cmd">${esc(row.command)}</pre>`;
    if (row.json) return `<pre class="proto-cmd">${esc(row.json)}</pre>`;
    return '';
}

function rowHtml(row: Row, c: Copy, open: boolean, dir: Direction): string {
    const file = row.diff?.file ?? '';
    const label = file || row.label;
    const caret = ICON.caret;
    const stats = statsCell(row);
    const body = bodyCell(row, c);
    const tag = row.preDenied
        ? `<span class="proto-tag">${esc(c.preDenied)}</span>`
        : '';
    return `<div class="proto-row${open ? ' open' : ''}" data-row="${row.id}">
        <span class="caret" aria-hidden="true">${caret}</span>
        ${file ? pathCell(file) : `<span class="proto-path"><span class="base trunc">${esc(label)}</span></span>`}
        ${tag}
        ${stats}
    </div>${body && open ? `<div class="proto-body">${body}</div>` : ''}`;
}

function totals(rows: Row[]): { files: number; add: number; del: number } {
    let files = 0, add = 0, del = 0;
    for (const r of rows) {
        if (r.diff) { files++; add += r.diff.added; del += r.diff.removed; }
    }
    return { files, add, del };
}

/** The numeric pair gets its own dir="ltr" isolate. Without it, an RTL
 *  paragraph reorders "+128 −44" into "+128+ 44−" - the signs detach from
 *  their numbers and the ledger stops being readable at all. The file count
 *  stays in the container's direction because it is prose ("2 فایل"). */
function ledgerHtml(t: { files: number; add: number; del: number }, c: Copy): string {
    return `<span class="proto-ledger" dir="auto">`
        + `<span class="files">${t.files} ${esc(c.files)}</span>`
        + `<span class="n" dir="ltr"><span class="add">+${t.add}</span> <span class="del">−${t.del}</span></span>`
        + `</span>`;
}

function titleFor(state: { resolution?: string; rows: Row[] }, c: Copy): { text: string; mark: string; cls: string } {
    const editCount = state.rows.filter((r) => r.diff || r.command || r.json).length;
    if (state.resolution === 'approved') return { text: c.approved, mark: ICON.check, cls: 'approved' };
    if (state.resolution === 'rejected') return { text: c.rejected, mark: ICON.x, cls: 'rejected' };
    if (state.resolution === 'mixed') return { text: c.mixed, mark: ICON.check, cls: 'mixed' };
    return { text: c.approveN(editCount), mark: ICON.shield, cls: '' };
}

function approveBtn(state: { submitting?: boolean; rows: Row[]; preDeniedAll?: boolean }, c: Copy): string {
    const approvable = state.rows.some((r) => !r.preDenied);
    const cls = `proto-btn go${state.submitting ? ' spin' : ''}`;
    return `<button type="button" class="${cls}"${state.submitting || !approvable ? ' disabled' : ''}>`
        + (state.submitting ? '<span class="step-status spinner"></span>' : ICON.check)
        + `<span>${esc(state.submitting ? c.applying : c.approve)}</span></button>`;
}

function denyBtn(state: { submitting?: boolean }, c: Copy): string {
    return `<button type="button" class="proto-btn deny"${state.submitting ? ' disabled' : ''}>`
        + ICON.x + `<span>${esc(c.deny)}</span></button>`;
}

function sessionLink(approvable: boolean, c: Copy): string {
    return `<button type="button" class="proto-link"${approvable ? '' : ' disabled'}>`
        + ICON.clock + `<span>${esc(c.session)}</span></button>`;
}

/** Render one direction in one state. */
export function renderDirection(dir: Direction, stateKey: string, c: Copy): string {
    const state = STATE_FIXTURES[stateKey]!;
    const open = new Set(state.open ?? []);
    const t = totals(state.rows);
    const title = titleFor(state, c);
    const approvable = state.rows.some((r) => !r.preDenied);
    const settled = !!state.resolution;
    const mark = `<span class="proto-mark ${title.cls}">${title.mark}</span>`;

    /* No second verdict line: the header already states the outcome. Repeating
       it ("Some changes approved" over "Some changes applied") adds a row to
       every settled card and says nothing the header does not. */

    if (dir === 'a') {
        return `<div class="proto a${settled ? ' settled' : ''}">
            <div class="a-head">
                ${mark}
                <span class="proto-title">${esc(title.text)}</span>
                ${ledgerHtml(t, c)}
                ${settled ? '' : `<div class="proto-verdict">${denyBtn(state, c)}${approveBtn(state, c)}</div>`}
            </div>
            <div class="a-table">${state.rows.map((r) => rowHtml(r, c, open.has(r.id), dir)).join('')}</div>
            ${settled ? '' : `<div class="a-foot">${sessionLink(approvable, c)}</div>`}
        </div>`;
    }

    if (dir === 'b') {
        return `<div class="proto b${settled ? ' settled' : ''}">
            <div class="b-head">
                ${mark}
                <span class="proto-title">${esc(title.text)}</span>
                ${ledgerHtml(t, c)}
            </div>
            <div class="b-list">${state.rows.map((r) => rowHtml(r, c, open.has(r.id), dir)).join('')}</div>
            ${settled
                ? ''
                : `<div class="b-foot">${denyBtn(state, c)}${sessionLink(approvable, c)}${approveBtn(state, c)}</div>`}
        </div>`;
    }

    const expanded = open.size > 0;
    return `<div class="proto c${expanded ? ' open' : ''}">
        <div class="c-sum">
            <span class="c-toggle" aria-hidden="true">${ICON.caret}</span>
            ${mark}
            <span class="proto-title">${esc(title.text)}</span>
            ${ledgerHtml(t, c)}
            ${settled ? '' : `<div class="proto-verdict">${denyBtn(state, c)}${approveBtn(state, c)}</div>`}
        </div>
        <div class="c-body">
            <div class="proto-rows">${state.rows.map((r) => rowHtml(r, c, open.has(r.id), dir)).join('')}</div>
            ${settled ? '' : `<div class="a-foot">${sessionLink(approvable, c)}</div>`}
        </div>
    </div>`;
}

/** One labelled state block, wrapped in real transcript chrome so the
 *  prototype is judged where it will live: inside an assistant turn, after
 *  prose, at the panel's real width. */
export function renderState(dir: Direction, stateKey: string, locale: 'fa' | 'en', note: string): string {
    const c = COPY[locale];
    return `<article class="proto-state" data-state="${stateKey}" data-dir="${dir}">
        <div class="msg assistant">
            <div class="msg-content"><p>${esc(c.turn)}</p></div>
            ${renderDirection(dir, stateKey, c)}
        </div>
        <p class="proto-caption" dir="ltr">${dir.toUpperCase()} · ${esc(note)}</p>
    </article>`;
}