/**
 * The webview -> host message router: every `onDidReceiveMessage` case for
 * the chat view, extracted from extension.ts's `resolveWebviewView`. The
 * provider implements WebviewMessageHost, so each case runs against the same
 * instance with `this.` written as `host.`; the two module-level singletons
 * (MCP config store, external MCP manager) arrive via RouterDeps so this file
 * never imports extension.ts (which imports it back).
 *
 * `data` is whatever vscode's own onDidReceiveMessage delivers - typed
 * through vscode's Event so the router's contract is identical to the
 * callback's (and neither side annotates an `any`).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { killForegroundJobs } from './tooling/backgroundJobs';
import type { ComposerAttachment, HistoryMessage } from './chatViewTypes';
import { setUiLocale } from './uiStrings';
import type { ExternalMcpManager } from './externalMcp';
import type { DiscoveredLocalModel } from './local/localModelClient';
import type { LocalSessionStore } from './local/localSessionStore';
import type { ThinkingLevel } from './local/localTypes';
import type { ExternalServerConfig, McpConfigStore, McpSaveTarget } from './mcpConfig';
import { isDir, isKnownSkillsPath, openSkillFile } from './skillsHost';
import type { TaskListItem } from './taskList';

/** Payload vscode hands to webview.onDidReceiveMessage: typed any
 *  upstream - derived here so no local any annotation exists. */
type WebviewMessage = Parameters<Parameters<vscode.Webview['onDidReceiveMessage']>[0]>[0];

/** Module-level singletons that live in extension.ts and are assigned by
 *  activate(); passed per message instead of imported (no cycle). */
export interface RouterDeps {
    mcpConfigStore: McpConfigStore | null;
    externalMcp: ExternalMcpManager | null;
}

/** The slice of XratuChatViewProvider the router switches over. */
export interface WebviewMessageHost {
    _backgroundTerminalCall(callId: string | undefined): void;
    _cancelActiveRequests(): void;
    _clearAllSessions(): Promise<void>;
    _confirmSteer(steerId: string | undefined, mode?: 'steer' | 'turn' | 'drop'): void;
    _createSkillScaffold(): Promise<string | null>;
    _deleteLlmCredential(id: string): Promise<void>;
    _deleteSession(id: string): Promise<void>;
    _deleteSkillFolder(dirPath: string): Promise<void>;
    _detectProxies(): Promise<void>;
    _fetchModels(): Promise<boolean>;
    _gitCheckout(branch: string): Promise<void>;
    _globalState: vscode.Memento;
    _handleChatRequest(prompt: string, attachments?: ComposerAttachment[], opts?: { baseSha?: string; steerCarry?: boolean }): Promise<void>;
    _handleSteer(value: string, attachments?: ComposerAttachment[], steerId?: string): Promise<void>;
    _handleToolApproval(approvalId: string, toolDecisions: Record<string, boolean>, sessionApprove?: boolean, _retryCount?: number): Promise<void>;
    _handleToolDecision(decisionId: string, answer: string | null | undefined, dismissed: boolean): void;
    _history: HistoryMessage[];
    _killBackgroundJob(jobId: string): Promise<void>;
    _listSessions(all: boolean): Promise<void>;
    _localRunActive: boolean;
    _localSessionStore: LocalSessionStore;
    _localWorkspaceKey(): string;
    _openEditDiff(
        edits: Array<{ tool?: string; args?: string; callId?: string; result?: string }>
    ): Promise<void>;
    _openSession(id: string): Promise<void>;
    _planMode: boolean;
    _pushEditorContext(): void;
    _pushFileList(): Promise<void>;
    _pushTaskListState(): void;
    _rememberModelForActiveCredential(model: string | null): Promise<void>;
    _removeModelPricing(id: string): Promise<void>;
    _renameSession(id: string, title: string): Promise<void>;
    _resetLiveSegments(): void;
    _resolveNotification(id: string, action: string | null): void;
    _resolveReplyLanguage(): 'fa' | 'en' | 'auto';
    _restoreCheckpointAt(userIndex: number, sha: string): Promise<void>;
    _rewindAndResend(userIndex: number, newText: string | null, attachments?: ComposerAttachment[]): Promise<void>;
    _saveLlmCredentials(base_url: string, api_key: string, returnToChat?: boolean): Promise<void>;
    _saveMcpConfig(target: McpSaveTarget, servers: ExternalServerConfig[]): Promise<void>;
    _saveModelPricing(
        id: string,
        input: number,
        output: number,
        cachedInput?: number | null,
        currency?: 'USD' | 'IRT',
    ): Promise<void>;
    _saveProxySettings(mode: 'auto' | 'custom' | 'off', proxyUrl: string, noProxy: string): Promise<void>;
    _saveTaskListEdits(): Promise<void>;
    _searchSessions(query: string, all: boolean, requestId?: number): Promise<void>;
    _secrets: vscode.SecretStorage;
    _selectLlmCredential(id: string): Promise<void>;
    _selectedModel: string | null;
    _sendGitBranches(): Promise<void>;
    _sendGitStatus(): Promise<void>;
    _sendMarketplaceDetection(id: string): Promise<void>;
    _sendMarketplaceState(options?: { query?: string; force?: boolean }): Promise<void>;
    _sendMcpState(): Promise<void>;
    _sendProxyState(): Promise<void>;
    _sendSkillsState(): Promise<void>;
    _sendTranscriptPrefs(): void;
    _sendUsageState(): Promise<void>;
    _serializeSessionTransition<T>(fn: () => Promise<T>): Promise<T>;
    _sessionId: string | null;
    _setContextWindowOverride(model: string, window: number | null): Promise<void>;
    _setLlmCredentials(reason?: string, openCard?: 'byok' | 'local'): Promise<void>;
    _startOAuthSignIn(providerId: string, method?: 'browser' | 'device'): Promise<void>;
    _cancelOAuthSignIn(): Promise<void>;
    _submitOAuthManualCode(code: string): Promise<void>;
    _oauthSignOut(credentialId: string): Promise<void>;
    _setSkillEnabled(id: string, enabled: boolean): Promise<void>;
    _setThinkingLevel(model: string, level: ThinkingLevel | null): Promise<void>;
    _setTranscriptPref(id: string, enabled: boolean): Promise<void>;
    _showStartScreen(): Promise<void>;
    _startConnectionPolling(): void;
    _taskListEdits: Record<string, TaskListItem[]>;
    _testProxyConnection(): Promise<void>;
    _updateLlmCredential(id: string, api_key: string): Promise<void>;
    _view?: vscode.WebviewView;
    _yoloMode: boolean;
    clearHistory(): Promise<void>;
    discoverLocalModels(signal?: AbortSignal): Promise<DiscoveredLocalModel[]>;
    notifyBanner(kind: 'info' | 'warning' | 'error', valueKey: string, params?: Record<string, string>): void;
    restoreCheckpointFlow(): Promise<void>;
    reviewChangesFlow(fromSha?: string): Promise<void>;
}

export function routeWebviewMessage(host: WebviewMessageHost, data: WebviewMessage, deps: RouterDeps): void {
    (async () => {
        try {
            switch (data.type) {
                case 'webviewReady':
                    // Locale FIRST, before any await: the boot chain
                    // below (_showStartScreen) must never outrun this
                    // echo, or the page renders in the wrong language.
                    // (The HTML also bakes the locale in; this is the
                    // idempotent echo.)
                    host._view?.webview.postMessage({
                        type: 'locale',
                        locale: host._globalState.get<string>('xratu.locale') === 'en' ? 'en' : 'fa'
                    });
                    // Effective reply language for the settings page
                    // (locale-derived default resolved host-side so the
                    // chips never lie about what the agent will do).
                    host._view?.webview.postMessage({
                        type: 'replyLanguage',
                        replyLanguage: host._resolveReplyLanguage(),
                    });
                    // Transcript display prefs (auto-expanded diffs / commands /
                    // reasoning). Pushed here so a reload never renders
                    // pills at the wrong default.
                    host._sendTranscriptPrefs();
                    host._startConnectionPolling();
                    // Re-echo the policy toggles: a webview reload
                    // (new session, logout loop, window reload)
                    // resets the UI to OFF while the host state
                    // persists - the toolbar must never lie about
                    // YOLO being armed.
                    host._view?.webview.postMessage({ type: 'yoloMode', enabled: host._yoloMode });
                    host._view?.webview.postMessage({ type: 'planMode', enabled: host._planMode });
                    host._pushTaskListState();
                    // The git line under the composer must be correct on
                    // the first paint after a webview reload too.
                    void host._sendGitStatus();
                    host._resetLiveSegments();
                    // Reconcile the local multi-session index with the
                    // on-disk directories (+ legacy one-shot import)
                    // and restore the CURRENT session - both inside
                    // ONE serialized transition: the restore reads
                    // the index (a fire-and-forget reconcile could
                    // race it and restore nothing, or a stale id, on
                    // the first run after the legacy migration), and
                    // the transition queue keeps a boot racing
                    // openSession/clearHistory from restoring a stale
                    // session id over the newer transition's state.
                    await host._serializeSessionTransition(async () => {
                        await host._localSessionStore.reconcile(host._localWorkspaceKey()).catch((e) =>
                            console.error('xratu: local session reconcile failed', e));
                        await host._showStartScreen();
                    });
                    host._pushEditorContext();
                    break;
                case 'setLocale':
                    await host._globalState.update('xratu.locale', data.locale);
                    setUiLocale(data.locale === 'en' ? 'en' : 'fa');
                    // Re-echo the effective reply language: the
                    // locale-derived default follows the UI locale,
                    // so the chips must never show a stale value.
                    // Explicit fa/en/auto choices survive through
                    // _resolveReplyLanguage.
                    host._view?.webview.postMessage({
                        type: 'replyLanguage',
                        replyLanguage: host._resolveReplyLanguage(),
                    });
                    break;
                case 'setReplyLanguage':
                    void host._globalState.update('xratu.replyLanguage', data.replyLanguage);
                    break;
                case 'transcriptSet': {
                    // The persisted blob is opaque to the host (the
                    // webview owns the row schema); only the SHAPE is
                    // validated here - see transcriptPrefs.ts.
                    await host._setTranscriptPref(String(data.id ?? ''), !!data.enabled);
                    host._sendTranscriptPrefs();
                    break;
                }
                case 'askQuestion':
                    await host._handleChatRequest(data.value, data.attachments);
                    break;
                case 'steerRun':
                    void host._handleSteer(data.value, data.attachments, data.steerId)
                        // An unexpected throw (e.g. a filesystem read
                        // before the try) must still release the held
                        // bubble, or its chip sticks forever.
                        .catch(() => host._confirmSteer(data.steerId, 'drop'));
                    break;
                case 'requestFileList':
                    void host._pushFileList();
                    break;
                case 'decisionResponse':
                    host._handleToolDecision(data.decisionId, data.answer, data.dismissed === true);
                    break;
                case 'approvalDecision':
                    await host._handleToolApproval(data.approvalId, data.decisions || {}, data.sessionApprove === true);
                    break;
                case 'notificationAction':
                    host._resolveNotification(data.id, data.action ?? null);
                    break;
                case 'backgroundTerminal':
                    host._backgroundTerminalCall(data.callId);
                    break;
                case 'killBackgroundJob':
                    void host._killBackgroundJob(data.jobId);
                    break;
                case 'cancelRequest':
                    // Stop a running terminal command NOW. The loop's
                    // abort only takes effect at a round boundary, so
                    // without this a long command keeps running (and
                    // keeps holding its ports/files) until the idle cap.
                    killForegroundJobs();
                    host._cancelActiveRequests();
                    break;
                case 'restoreCheckpoint':
                    if (typeof data.sha === 'string' && data.sha) {
                        void host._restoreCheckpointAt(
                            typeof data.userIndex === 'number' ? data.userIndex : -1,
                            data.sha,
                        );
                    } else {
                        void host.restoreCheckpointFlow();
                    }
                    break;
                case 'reviewChanges':
                    void host.reviewChangesFlow(
                        typeof data.sha === 'string' && data.sha ? data.sha : undefined,
                    );
                    break;
                case 'clearHistory':
                    // Legacy sender - same semantics as a new session
                    // (multi-session keeps old conversations intact).
                    await host.clearHistory();
                    break;
                case 'newSession':
                    await host.clearHistory();
                    break;
                case 'clearAllSessions':
                    // Settings "Clear history": wipe EVERY stored
                    // session on this machine, then start fresh.
                    await host._clearAllSessions();
                    break;
                case 'listSessions':
                    await host._listSessions(!!data.all);
                    break;
                case 'searchSessions':
                    await host._searchSessions(
                        String(data.query ?? ''),
                        !!data.all,
                        typeof data.requestId === 'number' ? data.requestId : undefined,
                    );
                    break;
                case 'openSession':
                    await host._openSession(data.id);
                    break;
                case 'renameSession':
                    await host._renameSession(data.id, String(data.title ?? ''));
                    break;
                case 'deleteSession':
                    await host._deleteSession(data.id);
                    break;
                case 'saveLlmCredentials':
                    void host._saveLlmCredentials(data.base_url, data.api_key, !!data.returnToChat);
                    break;
                case 'selectLlmCredential':
                    void host._selectLlmCredential(data.id);
                    break;
                case 'deleteLlmCredential':
                    void host._deleteLlmCredential(data.id);
                    break;
                case 'updateLlmCredential':
                    void host._updateLlmCredential(data.id, data.api_key);
                    break;
                case 'openCredentials':
                    void host._setLlmCredentials(undefined, data.target);
                    break;
                case 'oauthSignIn':
                    // Awaited (not `void`): these touch storage and can reject,
                    // and the router's catch is what surfaces that.
                    await host._startOAuthSignIn(data.providerId, data.method === 'device' ? 'device' : 'browser');
                    break;
                case 'oauthCancelSignIn':
                    // Awaited (not `void`): these touch storage and can reject,
                    // and the router's catch is what surfaces that.
                    await host._cancelOAuthSignIn();
                    break;
                case 'oauthManualCode':
                    // Awaited (not `void`): these touch storage and can reject,
                    // and the router's catch is what surfaces that.
                    await host._submitOAuthManualCode(String(data.code ?? ''));
                    break;
                case 'oauthSignOut':
                    // Awaited (not `void`): these touch storage and can reject,
                    // and the router's catch is what surfaces that.
                    await host._oauthSignOut(data.credentialId);
                    break;
                case 'toggleYolo':
                    host._yoloMode = !host._yoloMode;
                    host._view?.webview.postMessage({ type: 'yoloMode', enabled: host._yoloMode });
                    break;
                case 'togglePlanMode':
                    host._planMode = !host._planMode;
                    host._view?.webview.postMessage({ type: 'planMode', enabled: host._planMode });
                    // The in-flight run captured its toolset + mode at
                    // start (schemas snapshot per run) - a mid-run
                    // toggle must never read as retroactively active.
                    if (host._localRunActive) {
                        host.notifyBanner('info', 'planModeLiveNote');
                    }
                    break;
                case 'listModels':
                    await host._fetchModels();
                    break;
                case 'selectModel': {
                    host._selectedModel = data.value;
                    void host._secrets.store('xratu.selectedModel', data.value);
                    void host._rememberModelForActiveCredential(data.value);
                    break;
                }
                case 'setContextWindowOverride':
                    void host._setContextWindowOverride(data.model, data.window);
                    break;
                case 'setThinkingLevel':
                    void host._setThinkingLevel(data.model, data.level);
                    break;
                case 'copyToClipboard':
                    void vscode.env.clipboard.writeText(data.value);
                    break;
                case 'openDiff':
                    void host._openEditDiff(data.edits).catch((e) =>
                        console.error('xratu: open diff failed:', e));
                    break;
                case 'taskListEdit': {
                    // User edit of the checklist (webview is the single
                    // editing surface). Stored as the session override;
                    // the next /chat request echoes it so the model
                    // sees the edited list in its per-turn reminder.
                    if (host._sessionId && Array.isArray(data.tasks) && data.tasks.length > 0) {
                        host._taskListEdits[host._sessionId] = data.tasks as TaskListItem[];
                        void host._saveTaskListEdits().catch((e) =>
                            console.error('xratu: task list edit persist failed:', e));
                    }
                    host._pushTaskListState();
                    break;
                }
                case 'editMessage':
                    host._rewindAndResend(data.userIndex, data.value, data.attachments).catch((e) => {
                        host.notifyBanner('error', 'notifEditFailed', {
                            error: e instanceof Error ? e.message : String(e)
                        });
                    });
                    break;
                case 'openMcpSettings': {
                    // MCP config lives in dedicated JSON files, NOT
                    // VS Code settings - open the resolved file (the
                    // workspace file when it exists, else global) so
                    // raw edits land where the page saves.
                    const store = deps.mcpConfigStore;
                    const wsPath = store?.workspacePath ?? null;
                    let target = wsPath && fs.existsSync(wsPath) ? wsPath : store?.globalPath ?? null;
                    if (target && !fs.existsSync(target)) {
                        await fs.promises.mkdir(path.dirname(target), { recursive: true });
                        // Exclusive create - never clobber a config
                        // created concurrently (TOCTOU on exists).
                        try {
                            await fs.promises.writeFile(target, '{\n  "mcpServers": {}\n}\n', { encoding: 'utf-8', flag: 'wx' });
                        } catch (err: any) {
                            if (err?.code !== 'EEXIST') throw err;
                        }
                    }
                    if (target) {
                        await vscode.window.showTextDocument(vscode.Uri.file(target));
                    }
                    break;
                }
                case 'mcpGetState':
                    await host._sendMcpState();
                    // Fire-and-forget live probe: statuses fill in
                    // (and re-push) as servers connect. Errors here
                    // are already recorded per-server.
                    void deps.externalMcp?.listTools()
                        .catch(() => undefined)
                        .finally(() => { void host._sendMcpState(); });
                    break;
                case 'mcpSave':
                    await host._saveMcpConfig(data.target as McpSaveTarget, data.servers as ExternalServerConfig[]);
                    break;
                case 'mcpRestart':
                    await deps.externalMcp?.restart(String(data.name ?? ''));
                    await host._sendMcpState();
                    break;
                case 'mcpMarketplaceGetState':
                    await host._sendMarketplaceState({
                        query: typeof data.query === 'string' ? data.query : '',
                        force: data.force === true,
                    });
                    break;
                case 'mcpMarketplaceDetect':
                    await host._sendMarketplaceDetection(String(data.id ?? ''));
                    break;
                case 'gitStatusGetState':
                    await host._sendGitStatus();
                    break;
                case 'gitBranchesGetState':
                    await host._sendGitBranches();
                    break;
                case 'gitCheckout':
                    await host._gitCheckout(String(data.branch ?? ''));
                    break;
                case 'usageGetState':
                    await host._sendUsageState();
                    break;
                case 'usageSaveModel':
                    await host._saveModelPricing(
                        String(data.id ?? ''),
                        Number(data.input),
                        Number(data.output),
                        data.cachedInput == null ? null : Number(data.cachedInput),
                        data.currency === 'IRT' ? 'IRT' : 'USD',
                    );
                    break;
                case 'usageRemoveModel':
                    await host._removeModelPricing(String(data.id ?? ''));
                    break;
                case 'proxyGetState':
                    await host._sendProxyState();
                    break;
                case 'proxySave':
                    await host._saveProxySettings(
                        data.mode === 'off' || data.mode === 'custom' ? data.mode : 'auto',
                        String(data.proxyUrl ?? ''),
                        String(data.noProxy ?? ''),
                    );
                    break;
                case 'proxyDetect':
                    await host._detectProxies();
                    break;
                case 'proxyTest':
                    await host._testProxyConnection();
                    break;
                case 'skillsGetState':
                    await host._sendSkillsState();
                    break;
                case 'skillsToggle':
                    await host._setSkillEnabled(
                        String(data.id ?? ''),
                        !!data.enabled,
                    );
                    await host._sendSkillsState();
                    break;
                case 'skillsReveal': {
                    // Reveal a skill folder in the OS file explorer.
                    // Without a dirPath: ensure + reveal the global
                    // skills directory (empty-state CTA).
                    const requested = String(data.dirPath ?? '').trim();
                    let target = '';
                    if (requested && await isDir(requested)) {
                        target = requested;
                    } else {
                        const globalSkills = path.join(os.homedir(), '.agents', 'skills');
                        try { await fs.promises.mkdir(globalSkills, { recursive: true }); } catch { /* reveal best effort */ }
                        target = globalSkills;
                    }
                    // Guard against arbitrary path reveals leaking
                    // beyond skill locations - only reveal paths that
                    // are (or live under) a known skills root.
                    if (await isKnownSkillsPath(target)) {
                        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
                    }
                    break;
                }
                case 'skillsOpen': {
                    // Open a skill's SKILL.md in an editor tab - the
                    // skills page's "edit" affordance. Missing files
                    // are scaffolded from a minimal template.
                    const requested = String(data.dirPath ?? '').trim();
                    if (requested && await isDir(requested) && await isKnownSkillsPath(requested)) {
                        await openSkillFile(requested);
                    }
                    break;
                }
                case 'skillsCreate': {
                    // Scaffold a unique new-skill folder in the
                    // global skills directory and open it.
                    const dir = await host._createSkillScaffold();
                    if (dir) {
                        await openSkillFile(dir);
                        await host._sendSkillsState();
                    }
                    break;
                }
                case 'skillsDelete': {
                    // Permanently remove a skill folder (path-guarded
                    // to known skills locations).
                    const dirPath = String(data.dirPath ?? '').trim();
                    await host._deleteSkillFolder(dirPath);
                    await host._sendSkillsState();
                    break;
                }
                case 'discoverLocalModels': {
                    // Probes can throw (network glitches, aborted
                    // fetches) - report the failure instead of an
                    // indistinguishable empty result.
                    try {
                        const discovered = await host.discoverLocalModels();
                        host._view?.webview.postMessage({
                            type: 'localModelsDiscovered',
                            runtimes: discovered.map((d) => ({
                                id: d.connection.id,
                                runtime: d.connection.runtime,
                                name: d.connection.name,
                                baseUrl: d.connection.baseUrl,
                                modelCount: d.models.length,
                                models: d.models.map((m) => m.id),
                                supportsTools: d.supportsTools,
                                supportsVision: d.supportsVision,
                            })),
                        });
                    } catch (e) {
                        host._view?.webview.postMessage({
                            type: 'localModelsDiscovered',
                            runtimes: [],
                            error: e instanceof Error ? e.message : String(e),
                        });
                    }
                    break;
                }
                case 'regenerate': {
                    // Re-run the LAST exchange: rewind to its own
                    // pre-prompt checkpoint and resend unchanged.
                    let lastUser = -1;
                    for (let i = 0; i < host._history.length; i++) {
                        if (host._history[i].role === 'user') lastUser = i;
                    }
                    if (lastUser >= 0) {
                        host._rewindAndResend(lastUser, null).catch((e) => {
                            host.notifyBanner('error', 'notifRegenerateFailed', {
                                error: e instanceof Error ? e.message : String(e)
                            });
                        });
                    }
                    break;
                }
            }
        } catch (err) {
            console.error('xratu: unhandled error', err);
            host._view?.webview.postMessage({ type: 'error', valueKey: 'errInternal', params: { detail: err instanceof Error ? err.message : String(err) } });
        }
    })();
}
