// Message protocol shared between the VS Code extension host (extension.ts)
// and the React webview.  Keep these in sync with extension.ts.

export type ToExtensionMessage =
    | { type: 'webviewReady' }
    | { type: 'askQuestion'; value: string; attachments?: ComposerAttachment[] }
    | { type: 'steerRun'; value: string; attachments?: ComposerAttachment[] }
    | { type: 'toggleYolo' }
    | { type: 'togglePlanMode' }
    | { type: 'clearHistory' }
    /** Settings "Clear history": delete EVERY stored session on this machine. */
    | { type: 'clearAllSessions' }
    /** Start a brand-new session (old conversations are kept). */
    | { type: 'newSession' }
    /** Session picker: list / open / rename / hard-delete (delete is
     *  confirm-gated webview-side). `all` widens the list beyond the
     *  current workspace. */
    | { type: 'listSessions'; all?: boolean }
    | { type: 'openSession'; id: string }
    | { type: 'renameSession'; id: string; title: string }
    | { type: 'deleteSession'; id: string }
    | { type: 'cancelRequest' }
    | { type: 'restoreCheckpoint' }
    | { type: 'saveLlmCredentials'; base_url: string; api_key: string; returnToChat?: boolean }
    /** Replace the stored API key of a saved connection (webview never sees
     *  the real key - it only ever SENDS a replacement). */
    | { type: 'updateLlmCredential'; id: string; api_key: string }
    | { type: 'selectLlmCredential'; id: string }
    | { type: 'deleteLlmCredential'; id: string }
    /** Open the credentials page; `target` preselects the matching provider
     *  (remote-provider chip vs local-runtime chip in the empty state). */
    | { type: 'openCredentials'; target?: 'byok' | 'local' }
    | { type: 'approvalDecision'; approvalId: string; decisions: Record<string, boolean>; sessionApprove?: boolean }
    | { type: 'listModels' }
    | { type: 'selectModel'; value: string }
    /** Persist a per-model context window override (null clears it). */
    | { type: 'setContextWindowOverride'; model: string; window: number | null }
    /** Persist a per-model reasoning-effort level (null = Default - omit the parameter). */
    | { type: 'setThinkingLevel'; model: string; level: ThinkingLevel | null }
    /** Edit the userIndex-th user message and resend (workspace rewinds).
     *  Attachments ride along when the composer edit added files. */
    | { type: 'editMessage'; userIndex: number; value: string; attachments?: ComposerAttachment[] }
    /** Regenerate the last exchange (same prompt, fresh response). */
    | { type: 'regenerate' }
    /** Open the raw MCP config file (workspace mcp.json when present, else global) in the editor. */
    | { type: 'openMcpSettings' }
    /** MCP page: request the current server list + statuses. */
    | { type: 'mcpGetState' }
    /** MCP page: persist the full server list to the target config file. */
    | { type: 'mcpSave'; target: McpSaveTarget; servers: McpServerPayload[] }
    /** MCP page: drop one server's cached connection and reconnect. */
    | { type: 'mcpRestart'; name: string }
    /** Skills page: request the discovered skill list + enabled flags. */
    | { type: 'skillsGetState' }
    /** Skills page: enable/disable one skill (persisted host-side). */
    | { type: 'skillsToggle'; id: string; enabled: boolean }
    /** Reveal a skill folder in the OS file explorer; without dirPath,
     *  ensure + reveal the global skills directory (empty-state CTA). */
    | { type: 'skillsReveal'; dirPath?: string }
    /** Open a skill's SKILL.md in an editor tab (host scaffolds if missing). */
    | { type: 'skillsOpen'; dirPath: string }
    /** Scaffold a new skill folder in the global skills dir + open it. */
    | { type: 'skillsCreate' }
    /** Permanently delete a skill folder (webview confirms first). */
    | { type: 'skillsDelete'; dirPath: string }
    | { type: 'discoverLocalModels' }
    /** An in-app banner answer: the picked action label, or null on dismiss. */
    | { type: 'notificationAction'; id: string; action: string | null }
    /** Persist the UI language choice (Settings page flip). */
    | { type: 'setLocale'; locale: 'fa' | 'en' }
    /** @-mention support: ask the host for the workspace file list (git
     *  keep-set with a findFiles fallback) to power the composer popup. */
    | { type: 'requestFileList' }
    /** User edit of the session task list (interactive checklist). The host
     *  stores it as the session override and echoes taskListState. */
    | { type: 'taskListEdit'; tasks: TaskListItem[] };;;

export type DiscoveredLocalRuntime = {
    id: string;
    runtime: string;
    name: string;
    baseUrl: string;
    modelCount: number;
    models: string[];
    supportsTools: boolean;
    supportsVision: boolean;
};

export type ConnectionStatus = 'connected' | 'error' | 'disconnected';

/** Severity of an in-app notification banner (replaces VS Code toasts). */
export type NotificationKind = 'info' | 'warning' | 'error';

/** A host notification banner. The host posts an i18n KEY (+ optional
 *  interpolation params), not a literal - the webview resolves it via
 *  i18n tf(). With `actions` the host waits for the picked ACTION KEY
 *  (or null on dismiss) via a notificationAction message. */
export interface NotificationItem {
    id: string;
    kind: NotificationKind;
    valueKey: string;
    params?: Record<string, string>;
    actions?: string[];
}

/** Reasoning-effort levels (Default is encoded as null/absent, never a string). */
export type ThinkingLevel = 'low' | 'medium' | 'high';

/** A file attached to a chat message.  `id` is UI-local only (never sent to
 *  the backend); `dataBase64` travels with the request but is NOT persisted
 *  into history - only metadata survives for rendering past turns.
 *  WORKSPACE REFERENCES (`path` set): a pointer to a file in the workspace -
 *  `dataBase64` is empty and `size` is 0 until the HOST reads the file at
 *  send time (Cursor/Claude Code/Cline-style @path mention).  `name` carries
 *  the workspace-relative path for these. */
export interface ComposerAttachment {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    dataBase64: string;
    /** Workspace-relative path of a reference attachment (host resolves it). */
    path?: string;
}

/** A message queued while a run streams - flushed FIFO to `askQuestion`
 *  when the run settles. Attachments keep their full payload (base64 or
 *  reference pointer) exactly as the composer held them. */
export interface QueuedComposerMessage {
    id: number;
    text: string;
    attachments: ComposerAttachment[];
}

/** Attachment metadata persisted in history (no base64). */
export interface AttachmentMeta {
    name: string;
    mime_type: string;
    size: number;
    /** Workspace-relative path of a reference attachment (metadata only). */
    path?: string;
    /** UI-only preview for the just-sent message; never persisted/restored from host history. */
    previewDataUrl?: string;
}

export type ApprovalResolution = 'approved' | 'rejected' | 'mixed';

export interface SavedCredential {
    id: string;
    providerId: string;
    baseUrl: string;
    maskedKey: string;
    label: string;
    active: boolean;
}

/** Slim session list entry (metadata only - never transcripts). */
export interface SessionMeta {
    id: string;
    title: string;
    workspace: string;
    /** Epoch ms of the last activity - drives time grouping + ordering. */
    updatedAt: number;
}

export type FromExtensionMessage =
    | { type: 'connectionStatus'; status: ConnectionStatus; details?: { version?: string } }
    | { type: 'showWelcome' }
    | { type: 'showChat' }
    | { type: 'restoreUser'; value: string; attachments?: AttachmentMeta[] }
    /** Webview-internal (never sent by the host): a message steered into a
     *  LIVE run. Closes the in-flight assistant bubble at the steer point;
     *  subsequent chunks open a fresh bubble AFTER the steer. */
    | { type: 'steerUser'; value: string; attachments?: AttachmentMeta[] }
    | { type: 'startResponse' }
    | { type: 'chunk'; value: string }
    // Throttled LIVE markdown render of the CURRENT text segment (host-side,
    // same sanitize pipeline as fullResponse - shiki runs only on the final
    // render, streaming uses escaped plain code blocks). Patches the LAST
    // text step so formatting appears between pills while streaming.
    | { type: 'streamHtml'; value: string }
    | { type: 'thinking'; value: string }
    // Throttled LIVE markdown render of the CUMULATIVE thinking block (host
    // pipeline identical to streamHtml). Patches the latest thinking step's
    // html so the thinking pill renders formatted reasoning while streaming.
    | { type: 'thinkingHtml'; value: string }
    | { type: 'toolCall'; tool: string; args: string; callId?: string }
    | { type: 'toolResult'; tool: string; output: string; callId?: string }
    // Mid-run cumulative usage (backend emits after each model round; local
    // agent per round too) - lets the context meter track tool/thinking
    // growth WHILE the response streams instead of only at fullResponse.
    | { type: 'usage'; usage: TokenUsage | null }
    | {
          type: 'fullResponse';
          renderedHtml?: string;
          persian?: string;
          usage?: TokenUsage | null;
          contextWindow?: number | null;
          usableContextTokens?: number | null;
          /** Host-rendered markdown HTML per streamed TEXT segment, in
           *  timeline order. When it matches the message's text steps, the
           *  steps carry the final formatted content between the pills and
           *  the single bottom block is skipped. */
          segmentsHtml?: string[];
      }
    | { type: 'error'; value?: string; valueKey?: string; params?: Record<string, string> }
    | { type: 'needsApproval'; approval_id: string; approvals: ApprovalItem[]; preDenied?: Record<string, boolean> }
    | { type: 'approvalResolved'; approval_id: string; resolution: ApprovalResolution }
    | { type: 'yoloMode'; enabled: boolean }
    | { type: 'planMode'; enabled: boolean }
    | { type: 'modelInfo'; defaultModel: string; models: string[]; contextWindows?: Record<string, number>; overrides?: Record<string, number>; thinkingLevels?: Record<string, ThinkingLevel>; selectedModel?: string; visionCapable?: boolean }
    | { type: 'modelsRefreshing'; active: boolean }
    /** History was rewound to before the userIndex-th user message. */
    | { type: 'truncateFromUser'; userIndex: number }
    | { type: 'byokSetupHint' }
    /** Current session identity for the toolbar's title button. */
    | { type: 'sessionState'; id: string | null; title: string | null }
    /** Response to listSessions - the session-picker panel's contents. */
    | { type: 'sessionList'; items: SessionMeta[]; currentId: string | null }
    | { type: 'byokCredentialError'; value?: string; valueKey?: string; params?: Record<string, string> }
    /** Open the credentials page. `openCard` preselects the matching
     *  provider (echoed from openCredentials.target). */
    | { type: 'openCredentials'; reason?: string; currentUrl?: string; activeCredentialId?: string | null; openCard?: 'byok' | 'local' }
    | { type: 'savedCredentials'; credentials: SavedCredential[] }
    | { type: 'credentialsSaved'; returnToChat?: boolean }
    | { type: 'byokReset' }
    | { type: 'openSettings' }
    | { type: 'retrying'; attempt: number; maxAttempts: number; nextRetryInMs: number }
    | { type: 'attempting' }
    /** The backend rejected the request after the composer was cleared -
     *  value/prompt/attachments are echoed back so the user can fix and
     *  retry without re-attaching everything. Host-side rejections arrive
     *  as valueKey, not raw text. */
    | { type: 'sendFailed'; value: string; valueKey?: string; params?: Record<string, string>; prompt: string; attachments?: ComposerAttachment[]; silent?: boolean }
    /** Host-read files dragged from the VS Code explorer into the panel. */
    | { type: 'attachmentsFromHost'; attachments: ComposerAttachment[] }
    /** Attachment-rejection error - renders INLINE in the composer (not as a
     *  chat bubble), auto-dismisses. */
    | { type: 'composerError'; value?: string; valueKey?: string; params?: Record<string, string> }
    | { type: 'discoverLocalModels' }
    | { type: 'localModelsDiscovered'; runtimes: DiscoveredLocalRuntime[]; error?: string }
    /** Host-side notification banner (info/warning/error), optionally with
     *  confirm actions the host awaits. valueKey is an i18n key resolved
     *  webview-side with tf(); actions are keys echoed back on pick. */
    | { type: 'notification'; id: string; kind: NotificationKind; valueKey: string; params?: Record<string, string>; actions?: string[] }
    /** Persisted UI language, echoed on webviewReady. */
    | { type: 'locale'; locale: 'fa' | 'en' }
    /** The file open in the active editor (workspace-relative, null when
     *  none) - lets suggestion workflows name the user's actual file. */
    | { type: 'editorContext'; activeFile: string | null }
    /** Response to requestFileList - workspace-relative paths for the
     *  @-mention popup (capped; secret files never listed). */
    | { type: 'fileList'; files: string[] }
    /** Response to mcpGetState / mcpSave / mcpRestart - the MCP page's
     *  complete view: merged config + live statuses + curated registry. */
    | { type: 'mcpState'; servers: McpServerView[]; hasWorkspace: boolean; legacyInUse: boolean; registry: McpRegistryEntry[] }
    /** Response to skillsGetState / skillsToggle - the Skills page's view. */
    | { type: 'skillsState'; skills: SkillView[] }
    /** Host-echoed current task list (user override merged; null when the
     *  session has none). Drives the interactive checklist + progress chip. */
    | { type: 'taskListState'; tasks: TaskListItem[] | null };

// ---------------------------------------------------------------------------
// MCP page model
// ---------------------------------------------------------------------------

export type McpTransportType = 'stdio' | 'websocket' | 'streamableHttp' | 'sse';
export type McpSaveTarget = 'global' | 'workspace';

/** One MCP server entry as written to the config file. */
export interface McpServerPayload {
    name: string;
    type?: McpTransportType;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    disabled?: boolean;
    autoApprove?: string[];
    timeoutMs?: number;
}

/** Config + live status for the MCP page's server list. */
export interface McpServerView extends McpServerPayload {
    state: 'disabled' | 'connected' | 'error' | 'unconfigured';
    toolCount: number | null;
    lastError: string | null;
    source: 'global' | 'workspace' | 'legacy';
}

/** One curated registry entry (offline "mini marketplace"). */
export interface McpRegistryEntry {
    id: string;
    nameKey: string;
    descKey: string;
    docsUrl?: string;
    server: McpServerPayload;
}

// ---------------------------------------------------------------------------
// Skills page model
// ---------------------------------------------------------------------------

export type SkillSource = 'project-xratu' | 'project-agents' | 'project-claude' | 'global-agents' | 'global-claude';

/** One discovered Agent Skill (agentskills.io SKILL.md folder). Invalid
 *  skills carry `error`; shadowed ones are visible but never load. */
export interface SkillView {
    /** Stable per-source identity (`source:name`) used for toggles. */
    id: string;
    name: string;
    description: string;
    dirPath: string;
    source: SkillSource;
    /** Context-cost hint: markdown body length in characters. */
    bodyChars?: number;
    error: string | null;
    /** A higher-priority copy with the same name wins - shown but inert. */
    shadowed?: boolean;
    enabled: boolean;
}

// ---------------------------------------------------------------------------
// UI model
// ---------------------------------------------------------------------------

export type StepKind = 'thinking' | 'toolCall' | 'toolResult' | 'text';

/** One item of the session task list ("the list IS the plan"). Mirrors the
 *  host-side TaskListItem (extension/src/taskList.ts) and the backend schema. */
export type TaskListStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskListItem {
    label: string;
    status: TaskListStatus;
}

export interface ApprovalDiff {
    file: string;
    added: number;
    removed: number;
    lines: string[];
}

export interface ApprovalItem {
    tool_call_id: string;
    tool_name: string;
    args?: any;
    diff?: ApprovalDiff | null;
}

export interface ApprovalPayload {
    approval_id: string;
    approvals: ApprovalItem[];
    preDenied?: Record<string, boolean>;
    resolution?: ApprovalResolution;
}

export interface Step {
    id: string;
    kind: StepKind;
    tool?: string;
    text: string;
    open?: boolean;
    /** Server-side tool_call_id; results pair onto the call with the same id. */
    callId?: string;
    /** Filled when the matching tool_result arrives (Cline-style paired row). */
    result?: string;
    /** Wall-clock span of a thinking segment (webview-side timing). */
    startedAt?: number;
    endedAt?: number;
    /** Final host-rendered markdown for a 'text' segment (applied by
     *  fullResponse when segmentsHtml lines up with the streamed steps). */
    html?: string;
}

export type MessageStatus = 'streaming' | 'done' | 'error';

export interface TokenUsage {
    input_tokens: number | null;
    output_tokens: number | null;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    // Raw text used while streaming and as a fallback.
    text: string;
    // Server-rendered, sanitized HTML (markdown / shiki) when available.
    renderedHtml?: string;
    steps: Step[];
    status: MessageStatus;
    tone?: 'info' | 'error' | 'pending';
    createdAt: number;
    approval?: ApprovalPayload;
    usage?: TokenUsage | null;
    /** Attachment metadata for user bubbles (no base64 - never persisted). */
    attachments?: AttachmentMeta[];
    /** Webview-internal: this user turn was steered into a LIVE run
     *  (queued at the agent loop's next round) - renders with a badge. */
    steered?: boolean;
    /** Retry state for the in-flight request - shown as a countdown. */
    retryStatus?: { attempt: number; maxAttempts: number; nextRetryInMs: number } | null;
    /** Why the turn failed, when the bubble already carries streamed
     *  content (the reason must still be visible - red styling alone
     *  reads as a silent death). */
    errorText?: string;
}
