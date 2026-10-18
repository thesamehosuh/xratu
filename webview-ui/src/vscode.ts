// The VS Code webview API is exposed as a global `acquireVsCodeApi`, not an
// importable module.  We declare a minimal shape here so the bundle has no
// runtime dependency on a `vscode` package.
import type { FromExtensionMessage, SavedCredential, ToExtensionMessage } from './types';

interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;
try {
    api = acquireVsCodeApi();
} catch {
    api = undefined;
}

const STANDALONE_VSCODE_DARK_CSS = [
    ':root{',
    '--vscode-button-secondaryBackground:#313131;',
    '--vscode-button-secondaryForeground:#cccccc;',
    '--vscode-descriptionForeground:#9d9d9d;',
    '--vscode-editor-background:#1f1f1f;',
    '--vscode-editor-font-family:Consolas,"Courier New",monospace;',
    '--vscode-editor-foreground:#cccccc;',
    '--vscode-editorWarning-foreground:#cca700;',
    '--vscode-editorWidget-background:#202020;',
    '--vscode-errorForeground:#f85149;',
    '--vscode-font-family:system-ui,-apple-system,"Segoe UI",sans-serif;',
    '--vscode-foreground:#cccccc;',
    '--vscode-gitDecoration-addedResourceForeground:#4bf3c8;',
    '--vscode-gitDecoration-deletedResourceForeground:#f4587e;',
    '--vscode-input-background:#313131;',
    '--vscode-input-border:#3c3c3c;',
    '--vscode-input-foreground:#cccccc;',
    '--vscode-input-placeholderForeground:#989898;',
    '--vscode-inputValidation-errorBackground:#5a1d1d;',
    '--vscode-list-hoverBackground:#2a2d2e;',
    '--vscode-scrollbarSlider-background:rgba(121,121,121,0.4);',
    '--vscode-scrollbarSlider-hoverBackground:rgba(100,100,100,0.7);',
    '--vscode-sideBar-background:#181818;',
    '--vscode-textBlockQuote-background:#2b2b2b;',
    '--vscode-textLink-foreground:#4daafc;',
    '--vscode-textPreformat-foreground:#d0d0d0;',
    '--vscode-widget-border:#454545;',
    '}',
].join('');

function ensureStandaloneTheme(): void {
    if (api || typeof document === 'undefined') return;
    const apply = () => {
        const target = document.head || document.documentElement;
        if (target && !document.getElementById('xratu-vscode-theme')) {
            const style = document.createElement('style');
            style.id = 'xratu-vscode-theme';
            style.textContent = STANDALONE_VSCODE_DARK_CSS;
            target.appendChild(style);
        }
        document.body?.classList.add('vscode-dark');
    };
    apply();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply, { once: true });
    }
}

ensureStandaloneTheme();

let standaloneState: Record<string, unknown> = {};
let standaloneYolo = false;
let standalonePlan = false;
let standaloneEngine: 'xratu' | 'opencode' = 'xratu';
let standaloneCredentials: SavedCredential[] = [
    {
        id: 'cred-local-ollama',
        providerId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        maskedKey: 'local',
        label: 'Ollama (Local)',
        active: true,
    },
];

const STANDALONE_WATCH: import('../../src/pullRequests/types').PullRequestWatch = {
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    headSha: '8c4a2f1',
    failedChecks: ['lint / eslint (R1-R4)'],
    passed: false,
    passedChecks: ['typecheck (host + webview)', 'build & bundle'],
    remarksThrough: new Date(Date.now() - 300_000).toISOString(),
    remarkIds: ['c-1', 'c-2'],
    conflicting: false,
    wakes: 1,
    initialChecksReported: true,
};

const STANDALONE_EXECUTION: import('../../src/pullRequests/types').PullRequestExecution = {
    workspace: '~/xratu',
    branch: 'feat/surface-tabs-ux',
    engine: 'xratu',
    model: 'qwen2.5-coder:14b',
    credential: 'cred-local-ollama',
    nativeSessionId: null,
    binaryPath: null,
};

let standalonePrState: import('../../src/pullRequests/types').PullRequestView = {
    offline: false,
    links: [
        {
            host: 'github.com',
            url: 'https://github.com/xratu-ai/xratu/pull/142',
            repository: 'xratu-ai/xratu',
            number: 142,
            source: 'user',
            generation: 'gen-142',
            linkedAt: new Date(Date.now() - 3600_000).toISOString(),
            failures: 0,
            watch: STANDALONE_WATCH,
            resume: STANDALONE_EXECUTION,
            snapshot: {
                title: 'Polish work surface tabs, PR checks meter, and Activity timeline cards',
                state: 'open',
                isDraft: false,
                headBranch: 'feat/surface-tabs-ux',
                baseBranch: 'main',
                headSha: '8c4a2f1',
                mergeability: 'clean',
                reviewDecision: 'CHANGES_REQUESTED',
                commentCount: 2,
                viewer: 'mina-dev',
                author: { login: 'mina-dev' },
                syncedAt: new Date(Date.now() - 120_000).toISOString(),
                checks: [
                    { name: 'typecheck (host + webview)', status: 'success', required: true, url: 'https://github.com/xratu-ai/xratu/actions/runs/1' },
                    { name: 'build & bundle', status: 'success', required: true, url: 'https://github.com/xratu-ai/xratu/actions/runs/2' },
                    { name: 'e2e / playwright (ubuntu-latest)', status: 'pending', required: true, url: 'https://github.com/xratu-ai/xratu/actions/runs/3' },
                    { name: 'lint / eslint (R1-R4)', status: 'failure', required: true, url: 'https://github.com/xratu-ai/xratu/actions/runs/4' },
                ],
                comments: [
                    {
                        id: 'c-1',
                        author: { login: 'mina-dev' },
                        body: 'The segmented checks bar and state pills make scanning PR status much faster in sidebar mode.',
                        createdAt: new Date(Date.now() - 1800_000).toISOString(),
                        editedAt: null,
                        path: null,
                        url: 'https://github.com/xratu-ai/xratu/pull/142#issuecomment-1',
                        reviewState: 'COMMENTED',
                    },
                    {
                        id: 'c-2',
                        author: { login: 'reza-review' },
                        body: 'Please verify that the Activity filter dropdown and empty-state reset button work in both RTL and LTR.',
                        createdAt: new Date(Date.now() - 300_000).toISOString(),
                        editedAt: null,
                        path: 'webview-ui/src/components/ActivityPanel.tsx',
                        url: 'https://github.com/xratu-ai/xratu/pull/142#issuecomment-2',
                        reviewState: 'CHANGES_REQUESTED',
                    },
                ],
            },
        },
        {
            host: 'github.com',
            url: 'https://github.com/xratu-ai/xratu/pull/138',
            repository: 'xratu-ai/xratu',
            number: 138,
            source: 'agent',
            generation: 'gen-138',
            linkedAt: new Date(Date.now() - 86400_000).toISOString(),
            failures: 0,
            snapshot: {
                title: 'Add shadow-git checkpoint diff viewer and turn history',
                state: 'merged',
                isDraft: false,
                headBranch: 'feat/shadow-checkpoints',
                baseBranch: 'main',
                headSha: '4e91b0c',
                mergeability: 'unknown',
                reviewDecision: 'APPROVED',
                commentCount: 1,
                viewer: 'mina-dev',
                author: { login: 'mina-dev' },
                syncedAt: new Date(Date.now() - 7200_000).toISOString(),
                checks: [
                    { name: 'typecheck (host + webview)', status: 'success', required: true, url: null },
                    { name: 'unit & host suites', status: 'success', required: true, url: null },
                    { name: 'e2e / playwright', status: 'success', required: true, url: null },
                ],
                comments: [
                    {
                        id: 'c-138-1',
                        author: { login: 'core-maintainer' },
                        body: 'Clean isolation between shadow git and workspace git. LGTM!',
                        createdAt: new Date(Date.now() - 7500_000).toISOString(),
                        editedAt: null,
                        path: null,
                        url: null,
                        reviewState: 'APPROVED',
                    },
                ],
            },
        },
    ],
    events: [
        {
            id: 'ev-142-1',
            key: 'github.com/xratu-ai/xratu#142',
            url: 'https://github.com/xratu-ai/xratu/pull/142',
            number: 142,
            createdAt: new Date(Date.now() - 180_000).toISOString(),
            headSha: '8c4a2f1',
            changes: [
                {
                    kind: 'checks-failed',
                    failed: [{ name: 'lint / eslint (R1-R4)', status: 'failure', required: true, url: 'https://github.com/xratu-ai/xratu/actions/runs/4' }],
                },
                {
                    kind: 'remarks',
                    remarks: [
                        {
                            id: 'c-2',
                            author: { login: 'reza-review' },
                            body: 'Please verify that the Activity filter dropdown and empty-state reset button work in both RTL and LTR.',
                            createdAt: new Date(Date.now() - 300_000).toISOString(),
                            editedAt: null,
                            path: 'webview-ui/src/components/ActivityPanel.tsx',
                            url: 'https://github.com/xratu-ai/xratu/pull/142#issuecomment-2',
                            reviewState: 'CHANGES_REQUESTED',
                        },
                    ],
                },
            ],
            resume: STANDALONE_EXECUTION,
        },
    ],
};

let standaloneJobs: import('./types').BackgroundJobView[] = [
    {
        jobId: 'bg-vite-watch',
        command: 'npm run watch:webview -- --port 5173',
        pid: 4821,
        cwd: '~/xratu/webview-ui',
        running: true,
        status: 'running',
        exitCode: null,
        uptimeSeconds: 142,
        startedAt: Date.now() - 142_000,
        output: [
            '> xratu@2.3.3 watch:webview',
            '> vite build --watch',
            '',
            'vite v6.2.0 building for production...',
            'watching for file changes...',
            '✓ 148 modules transformed.',
            '../dist/webview-ui/index.html                  0.48 kB │ gzip:  0.31 kB',
            '../dist/webview-ui/assets/index-B7f9k2L.css   78.42 kB │ gzip: 14.90 kB',
            '../dist/webview-ui/assets/index-D9a2m1P.js   312.18 kB │ gzip: 94.12 kB',
            '✓ built in 1.42s',
        ].join('\n'),
    },
    {
        jobId: 'bg-host-tests',
        command: 'node test/run-webview-tests.mjs',
        pid: 4790,
        cwd: '~/xratu',
        running: false,
        status: 'exited',
        exitCode: 0,
        uptimeSeconds: 4,
        startedAt: Date.now() - 320_000,
        output: [
            'TAP version 13',
            '# Subtest: work surface render & docking layout',
            'ok 1 - work surface render & docking layout',
            '# Subtest: conversation and activity timeline filtering',
            'ok 2 - conversation and activity timeline filtering',
            '1..2',
            '# pass 2',
            '# fail 0',
        ].join('\n'),
    },
];

const STANDALONE_CHANGES: import('./types').ReviewChange[] = [
    { path: 'webview-ui/src/components/PullRequestsPanel.tsx', added: 58, removed: 12, untracked: false, binary: false, modifiedAt: Date.now() - 90_000 },
    { path: 'webview-ui/src/components/ActivityPanel.tsx', added: 26, removed: 4, untracked: false, binary: false, modifiedAt: Date.now() - 120_000 },
    { path: 'webview-ui/src/styles/workSurface.css', added: 49, removed: 19, untracked: false, binary: false, modifiedAt: Date.now() - 60_000 },
];

const STANDALONE_DIFFS: Record<string, import('./types').ReviewFile> = {
    'webview-ui/src/components/PullRequestsPanel.tsx': {
        path: 'webview-ui/src/components/PullRequestsPanel.tsx',
        kind: 'text',
        before: [
            'export function PullRequestsPanel({ visible, panelClass, state }: Props) {',
            '    return <section ref={root} className={`pr-panel ${panelClass}`}>',
            '        <div className="pr-scroll">',
            '            {state.offline && <p className="pr-notice">{t("prOffline")}</p>}',
            '        </div>',
            '    </section>;',
            '}',
        ].join('\n'),
        after: [
            'export function PullRequestsPanel({ visible, panelClass, state }: Props) {',
            '    return <section ref={root} className={`pr-panel ${panelClass}`}>',
            '        <div className="pr-scroll">',
            '            {state.offline && <p className="pr-notice">{t("prOffline")}</p>}',
            '            {state.links.length === 0 && !error && <div className="pr-empty-state">{t("prEmptyTitle")}</div>}',
            '        </div>',
            '    </section>;',
            '}',
        ].join('\n'),
        hunks: [
            {
                oldStart: 4,
                oldCount: 1,
                newStart: 4,
                newCount: 2,
                removedLines: ['            {state.offline && <p className="pr-notice">{t("prOffline")}</p>}'],
                addedLines: [
                    '            {state.offline && <p className="pr-notice">{t("prOffline")}</p>}',
                    '            {state.links.length === 0 && !error && <div className="pr-empty-state">{t("prEmptyTitle")}</div>}',
                ],
            },
        ],
    },
    'webview-ui/src/components/ActivityPanel.tsx': {
        path: 'webview-ui/src/components/ActivityPanel.tsx',
        kind: 'text',
        before: [
            '    return <div className={`activity-pane ${panelClass}`}>',
            '        <div className="activity-filters">',
            '            <input type="search" value={search} onChange={event => setSearch(event.target.value)} />',
            '        </div>',
            '    </div>;',
        ].join('\n'),
        after: [
            '    return <div className={`activity-pane ${panelClass}`}>',
            '        <div className="activity-filters">',
            '            <div className="activity-search-box">',
            '                <Search size={13} className="activity-search-icon" />',
            '                <input type="search" value={search} onChange={event => setSearch(event.target.value)} />',
            '            </div>',
            '        </div>',
            '    </div>;',
        ].join('\n'),
        hunks: [
            {
                oldStart: 3,
                oldCount: 1,
                newStart: 3,
                newCount: 4,
                removedLines: ['            <input type="search" value={search} onChange={event => setSearch(event.target.value)} />'],
                addedLines: [
                    '            <div className="activity-search-box">',
                    '                <Search size={13} className="activity-search-icon" />',
                    '                <input type="search" value={search} onChange={event => setSearch(event.target.value)} />',
                    '            </div>',
                ],
            },
        ],
    },
    'webview-ui/src/styles/workSurface.css': {
        path: 'webview-ui/src/styles/workSurface.css',
        kind: 'text',
        before: [
            '.pr-panel { display:flex; flex-direction:column; }',
            '.pr-row { padding-block:20px; border-block-start:1px solid var(--page-line); }',
            '.pr-head { display:flex; align-items:center; gap:8px; }',
        ].join('\n'),
        after: [
            '.pr-panel { display:flex; flex-direction:column; }',
            '.pr-row { padding:16px; margin-block-end:12px; background:var(--page-surface); border:1px solid var(--page-line); border-radius:10px; }',
            '.pr-head { display:flex; align-items:center; gap:8px; }',
        ].join('\n'),
        hunks: [
            {
                oldStart: 2,
                oldCount: 1,
                newStart: 2,
                newCount: 1,
                removedLines: ['.pr-row { padding-block:20px; border-block-start:1px solid var(--page-line); }'],
                addedLines: [
                    '.pr-row { padding:16px; margin-block-end:12px; background:var(--page-surface); border:1px solid var(--page-line); border-radius:10px; }',
                ],
            },
        ],
    },
};

function emitToWebview(msg: FromExtensionMessage, delayMs = 0): void {
    if (typeof window === 'undefined') return;
    setTimeout(() => {
        window.postMessage(msg, '*');
    }, delayMs);
}

function handleStandaloneMessage(message: ToExtensionMessage): void {
    switch (message.type) {
        case 'webviewReady':
            emitToWebview({ type: 'connectionStatus', status: 'connected', details: { version: '2.3.3' } });
            emitToWebview({
                type: 'enginesState',
                state: {
                    active: standaloneEngine,
                    phase: 'ready',
                    version: '2.0.30',
                    customPath: '',
                    installedByXratu: true,
                    busy: false,
                },
            });
            emitToWebview({
                type: 'modelInfo',
                defaultModel: 'qwen2.5-coder:14b',
                selectedModel: 'qwen2.5-coder:14b',
                models: ['qwen2.5-coder:14b', 'deepseek-r1:14b', 'claude-3-7-sonnet', 'gpt-4.1'],
                displayNames: {
                    'qwen2.5-coder:14b': 'Qwen 2.5 Coder 14B',
                    'deepseek-r1:14b': 'DeepSeek R1 14B',
                    'claude-3-7-sonnet': 'Claude 3.7 Sonnet',
                    'gpt-4.1': 'GPT-4.1',
                },
                contextWindows: {
                    'qwen2.5-coder:14b': 32768,
                    'deepseek-r1:14b': 65536,
                    'claude-3-7-sonnet': 200000,
                    'gpt-4.1': 128000,
                },
                capabilities: {
                    'qwen2.5-coder:14b': { provider: 'Ollama', free: true },
                    'deepseek-r1:14b': { provider: 'Ollama', free: true, reasoning: true },
                    'claude-3-7-sonnet': { provider: 'Anthropic', vision: true, reasoning: true },
                    'gpt-4.1': { provider: 'OpenAI', vision: true },
                },
                visionCapable: true,
            });
            emitToWebview({ type: 'savedCredentials', credentials: standaloneCredentials });
            emitToWebview({ type: 'sessionState', id: 'session-standalone-1', title: 'Xratu Workspace' });
            emitToWebview({
                type: 'gitStatusState',
                root: '~/xratu',
                status: {
                    isRepo: true,
                    branch: 'feat/surface-tabs-ux',
                    detached: false,
                    upstream: 'origin/feat/surface-tabs-ux',
                    ahead: 1,
                    behind: 0,
                    staged: 0,
                    modified: 3,
                    untracked: 0,
                    conflicted: 0,
                },
            });
            emitToWebview({ type: 'showChat', workspaceKind: 'project' });
            // Seed a rich multi-tool turn so Activity, Changes, PRs, Agents, and Background tabs are live in standalone preview.
            emitToWebview({
                type: 'restoreUser',
                value: 'Improve the UI/UX of the Pull Requests, Activity, Changes, Agents, and Background tabs.',
                cp: 'cp-standalone-1',
            }, 30);
            emitToWebview({ type: 'startResponse' }, 40);
            emitToWebview({
                type: 'thinking',
                value: 'Inspecting PullRequestsPanel.tsx, ActivityPanel.tsx, ChangesPanel.tsx, and workSurface.css to upgrade card hierarchy, empty states, and status meters.',
                timestamp: Date.now() - 85_000,
            }, 45);
            emitToWebview({
                type: 'toolCall',
                callId: 'call-subagent-1',
                tool: 'task',
                args: JSON.stringify({
                    agent: 'explore',
                    description: 'Audit work surface panels and CSS tokens',
                    prompt: 'Inspect all work surface panel components and report UI/UX gaps in PRs, Activity, Changes, Agents, and Background.',
                }),
                timestamp: Date.now() - 80_000,
                subagent: {
                    taskId: 'task-audit-1',
                    profile: 'explore',
                    description: 'Audit work surface panels and CSS tokens',
                    prompt: 'Inspect all work surface panel components and report UI/UX gaps in PRs, Activity, Changes, Agents, and Background.',
                    model: 'qwen2.5-coder:14b',
                    effort: 'medium',
                    tools: ['read_file', 'grep_search', 'glob_search'],
                    resumed: false,
                    status: 'done',
                    startedAt: Date.now() - 80_000,
                    updatedAt: Date.now() - 68_000,
                    endedAt: Date.now() - 68_000,
                    toolCalls: 2,
                    inputTokens: 4120,
                    outputTokens: 680,
                    entries: [
                        { kind: 'thinking', id: 'sub-th-1', text: 'Scanning panel components in webview-ui/src/components.', startedAt: Date.now() - 79_000 },
                        { kind: 'tool', id: 'sub-tc-1', tool: 'read_file', text: JSON.stringify({ path: 'webview-ui/src/components/PullRequestsPanel.tsx' }), output: 'Read 84 lines', startedAt: Date.now() - 76_000, endedAt: Date.now() - 75_000 },
                        { kind: 'tool', id: 'sub-tc-2', tool: 'read_file', text: JSON.stringify({ path: 'webview-ui/src/components/ActivityPanel.tsx' }), output: 'Read 47 lines', startedAt: Date.now() - 74_000, endedAt: Date.now() - 72_000 },
                        { kind: 'text', id: 'sub-txt-1', text: 'Identified key UX improvements: add PR link bar & checks progress meter, upgrade Activity search box & turn cards, and add structured empty states.', startedAt: Date.now() - 70_000 },
                    ],
                },
            }, 50);
            emitToWebview({
                type: 'toolResult',
                callId: 'call-subagent-1',
                tool: 'task',
                output: 'Completed work surface audit across PullRequestsPanel, ActivityPanel, ChangesPanel, SubagentsPanel, and BackgroundTasksPanel.',
                timestamp: Date.now() - 68_000,
            }, 55);
            emitToWebview({
                type: 'toolCall',
                callId: 'call-read-pr',
                tool: 'read_file',
                args: JSON.stringify({ path: 'webview-ui/src/components/PullRequestsPanel.tsx', start_line: 1, end_line: 84 }),
                timestamp: Date.now() - 65_000,
            }, 60);
            emitToWebview({
                type: 'toolResult',
                callId: 'call-read-pr',
                tool: 'read_file',
                output: '1: import { ChevronDown, ExternalLink, Eye, EyeOff, GitBranch } from "lucide-react";\n2: export function PullRequestsPanel({ visible, panelClass, state }) { ... }',
                timestamp: Date.now() - 63_000,
            }, 65);
            emitToWebview({
                type: 'toolCall',
                callId: 'call-edit-pr',
                tool: 'replace_in_file',
                args: JSON.stringify({
                    path: 'webview-ui/src/components/PullRequestsPanel.tsx',
                    old_text: '<div className="pr-scroll">',
                    new_text: '<div className="pr-scroll">\n  <form className="pr-link-bar" onSubmit={submitLink}>...</form>',
                }),
                timestamp: Date.now() - 55_000,
            }, 70);
            emitToWebview({
                type: 'toolResult',
                callId: 'call-edit-pr',
                tool: 'replace_in_file',
                output: 'Updated webview-ui/src/components/PullRequestsPanel.tsx (+58 -12)',
                timestamp: Date.now() - 52_000,
            }, 75);
            emitToWebview({
                type: 'toolCall',
                callId: 'call-edit-act',
                tool: 'replace_in_file',
                args: JSON.stringify({
                    path: 'webview-ui/src/components/ActivityPanel.tsx',
                    old_text: '<input type="search" value={search} />',
                    new_text: '<div className="activity-search-box"><Search size={13} /><input type="search" value={search} /></div>',
                }),
                timestamp: Date.now() - 48_000,
            }, 80);
            emitToWebview({
                type: 'toolResult',
                callId: 'call-edit-act',
                tool: 'replace_in_file',
                output: 'Updated webview-ui/src/components/ActivityPanel.tsx (+26 -4)',
                timestamp: Date.now() - 45_000,
            }, 85);
            emitToWebview({
                type: 'toolCall',
                callId: 'call-test-surface',
                tool: 'run_terminal_command',
                args: JSON.stringify({ command: 'npm run test:webview' }),
                timestamp: Date.now() - 35_000,
            }, 90);
            emitToWebview({
                type: 'toolResult',
                callId: 'call-test-surface',
                tool: 'run_terminal_command',
                output: 'STDOUT:\n✔ work-surface-render.test.tsx (142ms)\n✔ conversation-activity.test.tsx (98ms)\nExit code: 0',
                timestamp: Date.now() - 30_000,
            }, 95);
            emitToWebview({
                type: 'fullResponse',
                renderedHtml: '<p>Upgraded the UI/UX across <strong>Pull requests</strong>, <strong>Activity</strong>, <strong>Changes</strong>, <strong>Agents</strong>, and <strong>Background</strong> tabs with structured cards, checks progress meters, enhanced search/filter controls, and rich empty states.</p>',
                usage: { input_tokens: 6840, output_tokens: 920 },
            }, 100);
            emitToWebview({
                type: 'pullRequestsState',
                sessionId: 'session-standalone-1',
                state: standalonePrState,
            }, 110);
            emitToWebview({
                type: 'backgroundJobs',
                jobs: standaloneJobs,
            }, 115);
            break;
        case 'pullRequestsGetState':
            emitToWebview({
                type: 'pullRequestsState',
                sessionId: 'session-standalone-1',
                requestId: message.requestId,
                state: standalonePrState,
            });
            break;
        case 'pullRequestAction': {
            if (message.action === 'link' && message.url) {
                const match = message.url.match(/(?:github\.com\/([^/]+\/[^/]+)\/pull\/|^#?)(\d+)/i);
                const num = match ? Number(match[2]) : Math.floor(150 + Math.random() * 50);
                const repo = match?.[1] || 'xratu-ai/xratu';
                const fullUrl = `https://github.com/${repo}/pull/${num}`;
                if (!standalonePrState.links.some((l) => l.url === fullUrl)) {
                    standalonePrState = {
                        ...standalonePrState,
                        links: [
                            {
                                host: 'github.com',
                                url: fullUrl,
                                repository: repo,
                                number: num,
                                source: 'user',
                                generation: `gen-${num}`,
                                linkedAt: new Date().toISOString(),
                                failures: 0,
                                watch: STANDALONE_WATCH,
                                resume: STANDALONE_EXECUTION,
                                snapshot: {
                                    title: `PR #${num} — Linked from work surface`,
                                    state: 'open',
                                    isDraft: false,
                                    headBranch: `feat/pr-${num}`,
                                    baseBranch: 'main',
                                    headSha: '9a1c3e7',
                                    mergeability: 'clean',
                                    reviewDecision: 'REVIEW_REQUIRED',
                                    commentCount: 0,
                                    viewer: 'mina-dev',
                                    author: { login: 'mina-dev' },
                                    syncedAt: new Date().toISOString(),
                                    checks: [
                                        { name: 'build & typecheck', status: 'success', required: true, url: null },
                                        { name: 'e2e suite', status: 'pending', required: true, url: null },
                                    ],
                                    comments: [],
                                },
                            },
                            ...standalonePrState.links,
                        ],
                    };
                }
            } else if (message.action === 'unlink' && message.url) {
                standalonePrState = {
                    ...standalonePrState,
                    links: standalonePrState.links.filter((l) => l.url !== message.url),
                    events: standalonePrState.events.filter((e) => e.url !== message.url),
                };
            } else if ((message.action === 'watch' || message.action === 'unwatch') && message.url) {
                standalonePrState = {
                    ...standalonePrState,
                    links: standalonePrState.links.map((l) =>
                        l.url === message.url
                            ? { ...l, watch: message.action === 'watch' ? STANDALONE_WATCH : undefined }
                            : l
                    ),
                };
            } else if (message.action === 'dismiss' || message.action === 'resume') {
                standalonePrState = {
                    ...standalonePrState,
                    events: [],
                };
            }
            emitToWebview({
                type: 'pullRequestsState',
                sessionId: message.sessionId ?? 'session-standalone-1',
                requestId: message.requestId,
                state: standalonePrState,
            });
            break;
        }
        case 'changesGetState':
            emitToWebview({
                type: 'changesState',
                sha: message.sha,
                requestId: message.requestId,
                files: STANDALONE_CHANGES,
            });
            break;
        case 'changeFileGet':
            emitToWebview({
                type: 'changeFileState',
                sha: message.sha,
                requestId: message.requestId,
                file: STANDALONE_DIFFS[message.path] ?? {
                    path: message.path,
                    kind: 'text',
                    before: '',
                    after: '',
                    hunks: [],
                },
            });
            break;
        case 'killBackgroundJob':
            standaloneJobs = standaloneJobs.map((job) =>
                job.jobId === message.jobId ? { ...job, running: false, status: 'killed', exitCode: 130 } : job
            );
            emitToWebview({ type: 'backgroundJobStopped', jobId: message.jobId });
            emitToWebview({ type: 'backgroundJobs', jobs: standaloneJobs });
            break;
        case 'toggleYolo':
            standaloneYolo = !standaloneYolo;
            emitToWebview({ type: 'yoloMode', enabled: standaloneYolo });
            break;
        case 'togglePlanMode':
            standalonePlan = !standalonePlan;
            emitToWebview({ type: 'planMode', enabled: standalonePlan });
            break;
        case 'enginesGetState':
            emitToWebview({
                type: 'enginesState',
                state: {
                    active: standaloneEngine,
                    phase: 'ready',
                    version: '2.0.30',
                    customPath: '',
                    installedByXratu: true,
                    busy: false,
                },
            });
            break;
        case 'engineSelect':
            standaloneEngine = message.engine;
            emitToWebview({
                type: 'enginesState',
                state: {
                    active: standaloneEngine,
                    phase: 'ready',
                    version: '2.0.30',
                    customPath: '',
                    installedByXratu: true,
                    busy: false,
                },
            });
            break;
        case 'openCredentials':
            emitToWebview({
                type: 'openCredentials',
                activeCredentialId: standaloneCredentials.find((c) => c.active)?.id ?? null,
                openCard: message.target,
            });
            emitToWebview({ type: 'savedCredentials', credentials: standaloneCredentials });
            break;
        case 'discoverLocalModels':
            emitToWebview(
                {
                    type: 'localModelsDiscovered',
                    runtimes: [
                        {
                            id: 'ollama',
                            runtime: 'ollama',
                            name: 'Ollama',
                            baseUrl: 'http://127.0.0.1:11434/v1',
                            modelCount: 2,
                            models: ['qwen2.5-coder:14b', 'deepseek-r1:14b'],
                            supportsTools: true,
                            supportsVision: false,
                        },
                    ],
                },
                150
            );
            break;
        case 'saveLlmCredentials': {
            const id = `cred-${Date.now()}`;
            standaloneCredentials = standaloneCredentials.map((c) => ({ ...c, active: false })).concat({
                id,
                providerId: 'custom',
                baseUrl: message.base_url,
                maskedKey: message.api_key ? '••••' + message.api_key.slice(-4) : 'local',
                label: message.base_url,
                active: true,
            });
            emitToWebview({ type: 'savedCredentials', credentials: standaloneCredentials });
            emitToWebview({ type: 'credentialsSaved', returnToChat: message.returnToChat, credentialId: id });
            break;
        }
        case 'mcpGetState':
            emitToWebview({ type: 'mcpState', servers: [], hasWorkspace: true, legacyInUse: false });
            break;
        case 'skillsGetState':
            emitToWebview({
                type: 'skillsState',
                skills: [
                    {
                        id: 'project-xratu:natural-farsi',
                        name: 'natural-farsi',
                        description: 'Natural Persian register and orthography guidelines.',
                        dirPath: 'assets/skills/natural-farsi',
                        source: 'project-xratu',
                        bodyChars: 2400,
                        error: null,
                        enabled: true,
                    },
                    {
                        id: 'project-xratu:local-llm-low-ram',
                        name: 'local-llm-low-ram',
                        description: 'Quantization and context-window tuning for low-RAM local LLMs.',
                        dirPath: 'assets/skills/local-llm-low-ram',
                        source: 'project-xratu',
                        bodyChars: 1950,
                        error: null,
                        enabled: true,
                    },
                ],
            });
            break;
        case 'agentsGetState':
            emitToWebview({ type: 'agentsState', profiles: [] });
            break;
        case 'usageGetState':
            emitToWebview({
                type: 'usageState',
                providers: [],
                rates: [],
                history: [],
                allTime: { input: 0, output: 0, cached: 0, USD: 0, IRT: 0 },
            });
            break;
        case 'proxyGetState':
            emitToWebview({
                type: 'proxyState',
                mode: 'auto',
                proxyUrl: '',
                noProxy: 'localhost,127.0.0.1',
                resolvedUrl: null,
                resolvedSource: 'none',
                systemProxy: null,
                noProxyList: 'localhost,127.0.0.1',
            });
            break;
        case 'gitStatusGetState':
            emitToWebview({
                type: 'gitStatusState',
                root: '~/xratu',
                status: {
                    isRepo: true,
                    branch: 'feat/surface-tabs-ux',
                    detached: false,
                    upstream: 'origin/feat/surface-tabs-ux',
                    ahead: 1,
                    behind: 0,
                    staged: 0,
                    modified: 3,
                    untracked: 0,
                    conflicted: 0,
                },
            });
            break;
        case 'gitBranchesGetState':
            emitToWebview({ type: 'gitBranchesState', branches: ['feat/surface-tabs-ux', 'main'], current: 'feat/surface-tabs-ux' });
            break;
        case 'listSessions':
            emitToWebview({
                type: 'sessionList',
                currentId: 'session-standalone-1',
                items: [
                    {
                        id: 'session-standalone-1',
                        title: 'Xratu Workspace',
                        workspace: '~/xratu',
                        updatedAt: Date.now(),
                        prWatching: 1,
                        prPending: 1,
                    },
                ],
            });
            break;
        case 'requestFileList':
            emitToWebview({
                type: 'fileList',
                files: ['package.json', 'README.md', 'src/extension.ts', 'webview-ui/src/App.tsx'],
            });
            break;
        case 'askQuestion':
            emitToWebview({ type: 'startResponse' }, 40);
            emitToWebview(
                {
                    type: 'chunk',
                    value: `Xratu Webview UI is running in standalone browser preview mode. In VS Code, the extension host connects this interface to your configured LLM runtime or OpenCode 2 engine.\n\nPrompt received: "${message.value}"`,
                },
                120
            );
            emitToWebview(
                {
                    type: 'fullResponse',
                    usage: { input_tokens: 48, output_tokens: 36 },
                },
                200
            );
            break;
        default:
            break;
    }
}

/** Post a typed host message - the protocol union is the single source of
 *  truth, so a typo or missing field is a compile error, not a silent no-op. */
export function postMessage(message: ToExtensionMessage): void {
    if (api) {
        api.postMessage(message);
        return;
    }
    handleStandaloneMessage(message);
}

/** UI preferences survive a webview reload without replacing other saved state. */
export function getWebviewState(): Record<string, unknown> {
    if (api) {
        const state = api.getState();
        return state && typeof state === 'object' && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
    }
    return standaloneState;
}

export function patchWebviewState(patch: Record<string, unknown>): void {
    if (api) {
        api.setState({ ...getWebviewState(), ...patch });
        return;
    }
    standaloneState = { ...standaloneState, ...patch };
}
