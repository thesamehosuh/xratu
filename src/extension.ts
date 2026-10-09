import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getLocalToolDefinitions, createLocalToolExecutor } from './mcp';
import {
    adoptDetachedJob,
    adoptableJobRecords,
    formatJobCompletion,
    getJobByCallId,
    getTerminalJob,
    listTerminalJobs,
    onJobEvent,
    setJobChangeListener,
    type JobEvent,
} from './tooling/backgroundJobs';
import { BackgroundJobStore } from './tooling/backgroundJobStore';
import {
    buildDevWebviewHtml,
    createRecordedPostMessage,
    parseDevWebviewUrl,
} from './devWebview';

/**
 * A tool image in the shape the WEBVIEW wants: a `data:` URL, so the row can
 * render it with a plain `<img src>`. Built host-side so the base64 payload
 * never crosses the message boundary as a separate field the webview has to
 * re-assemble, and so the preview cannot be cached with a mismatched mime.
 */
function toToolImageView(image: LocalToolImage): { mimeType: string; dataUrl: string; caption?: string } {
    return {
        mimeType: image.mimeType,
        dataUrl: `data:${image.mimeType};base64,${image.dataBase64}`,
        ...(image.caption ? { caption: image.caption } : {}),
    };
}
import {
    type UserQuestion,
    type UserQuestionGate,
    type UserQuestionOutcome,
} from './tooling/userQuestion';
import {
    planProxyTest,
    summarizeProxyTest,
    type ProxyTestOutcome,
    type ProxyTestResult,
} from './proxyTest';
import { sanitizePath } from './paths';
import { ATTACH_MAX_BYTES, ATTACH_MAX_COUNT, ATTACH_MAX_TOTAL_BYTES, buildLocalUserText, isImageAttachment, isPdfAttachment, isTextAttachment, mimeFromFilename, resolveReferenceAttachments, validateHostAttachments } from './attachments';
import type { AttachmentMeta, ComposerAttachment, HistoryMessage } from './chatViewTypes';
import { closeOpenFence, ensureShiki, md, mdLive } from './markdownRender';
import { _sanitizeHtml } from './sanitizeHtml';
import { collectProjectRules } from './projectRules';
import { closeStaleSkillEditors, isDir, isKnownSkillsPath } from './skillsHost';
import { classifyWorkspace } from './workspaceKind';
import { applyMarkerPatch, computeDiffHunks, editDiffFromArgs, hunkSummaries } from './editDiff';
import { routeWebviewMessage, type WebviewMessageHost } from './webviewRouter';
import { getOAuthProvider, listOAuthProviders } from './oauth/providerAuthRegistry';
import './oauth/providers/register';
import { OAuthTokenManager, type OAuthTokenStore } from './oauth/tokenManager';
import { startLoopbackServer, type LoopbackServer } from './oauth/server';
import { chatGptPlanEnabled, chatGptStorageKey } from './oauth/providers/openaiChatGpt';
import {
    OAuthFlowError,
    OAuthCancelledError,
    type OAuthAuthorization,
    type OAuthCallback,
    type OAuthLoginContext,
    type OAuthProviderHandler,
    type OAuthTokenSet,
} from './oauth/types';
import { oauthErrorValueKey } from './oauth/errorKeys';
import { createManualCodeSlot, type ManualCodeSlot } from './oauth/manualCode';
import { abortable } from './oauth/refreshLock';

/** One in-flight sign-in. The host owns the transport (browser launch,
 *  loopback socket, abort controller) so a cancel can actually stop it; the
 *  `manualCode` promise is the escape hatch race for a user who cannot reach
 *  the loopback callback. */
interface OAuthFlowState {
    providerId: string;
    method: 'browser' | 'device';
    controller: AbortController;
    server?: LoopbackServer;
    /** The manual-paste side of the callback race. Created PENDING when the
     *  flow starts - see manualCode.ts for why reading a possibly-undefined
     *  promise into Promise.race would end the flow instantly. */
    manualCode: ManualCodeSlot;
}

/**
 * A saved connection in the `xratu.llmCredentials` vault.
 *
 * `apiKey` stays a plain string on EVERY record - it is the filter the reader
 * applies (`typeof c.apiKey === 'string'`) and the shape every existing
 * consumer expects, so an OAuth connection stores `''` here and keeps its
 * token set in its own `xratu.oauthTokens.*` secret. That keeps the vault
 * format readable by every pre-existing version: an older Xratu sees an
 * empty-key remote credential and simply fails to use it, instead of
 * crashing on an unknown field or a missing key.
 */
interface StoredCredential {
    id: string;
    providerId: string;
    baseUrl: string;
    apiKey: string;
    label: string;
    /** Present => the real credential is an OAuth token set, not this key. */
    oauthProviderId?: string;
    oauthStorageKey?: string;
}
import { openEditDiff } from './editDiffView';
import { insecureRemoteHttpError, isLikelyLocalUrl } from './endpointGuard';
import { sessionApprovalKind, isSessionApproved } from './sessionApproval';
import { parseTranscriptPrefs, withTranscriptPref } from './transcriptPrefs';
import { ShadowCheckpointStore, EmptySeedError, setCheckpointDiagnostics, type ChangedFile } from './shadowGit';
import { ExternalMcpManager, type AggregatedTool } from './externalMcp';
import { McpConfigStore, type ExternalServerConfig, type McpSaveTarget } from './mcpConfig';
import { runLocalAgent, type LocalAgentEvent, type LocalApprovalGate, type LocalImageAttachment, type LocalUsage } from './local/localAgent';
import type { LocalToolImage } from './local/localAgent';
import { createSubagentRunner, type SubagentRunRegistry } from './local/subagentRunner';
import { SUBAGENT_TOOL_NAME, agentFileTemplate, discoverSubagents, filterToolsForSubagent, subagentIssues, type SubagentDefinition, type SubagentSource } from './subagents';
import { extractPdfAttachments } from './pdfExtract';
import { LocalSessionStore, resolveSessionTitle, renameWithRetry, type LocalSessionHistoryMessage } from './local/localSessionStore';
import {
    UsageLedgerStore,
    aggregateByDayAndModel,
    entriesForSession,
    modelHosts,
    modelTotals,
    recomputeCosts,
    sumUsage,
    totalsByHost,
    USAGE_CHART_DAYS,
    type UsageEntry,
    type UsageTotals,
} from './local/usageLedger';
import { discoverLocalRuntimes, probeCustomEndpoint, probeLocalEndpoint, fetchModelsDevCatalog, MODELS_DEV_URL, MODELS_DEV_TTL_MS, MODELS_DEV_RETRY_MS, modelIsLikelyVision, modelLikelySupportsTools } from './local/localModelClient';
import type { DiscoveredLocalModel } from './local/localModelClient';
import type { LocalModelInfo } from './local/localTypes';
import { THINKING_LEVELS, type ThinkingLevel } from './local/localTypes';
import {
    cachedModelInfo,
    catalogEntryFor,
    modelsDevModelInfo,
    modelsDevProviderKey,
    readModelCatalog,
    readModelsDevCache,
    serializeModelCatalog,
    serializeModelsDevCache,
    setCatalogEntry,
    type ModelCatalog,
    type ModelsDevCatalog,
} from './local/modelMetadata';
import { knownContextWindow, knownMaxOutputTokens } from './modelKnowledge';
import { ui, setUiLocale } from './uiStrings';
import { buildLocalSystemPrompt, buildSubagentSystemPrompt } from './systemPrompt';
import { IN_MEMORY_CONTENT_CAP, MAX_CONTENT_CAP, MAX_IN_MEMORY_TURNS, boundCarriers, clipHistoryContent, clipToolCallArguments, contentCapForWindow, countUserRows, evictOldestTurns, serializedWithinCap, skipLeadingUserTurns } from './local/historyBounds';
import { boundOutcomeEvents, trimDisplayEvent } from './local/eventBounds';
import { buildReplayHistory, historyRowFromEvent, persistedEventFromAgentEvent } from './local/historyRows';
import { RulesSnapshot } from './local/rulesSnapshot';
import { gitWorkspaceFiles, setPlanModeExitListener, setTaskListWriteListener } from './xratu_mcp_tools';
import { TASK_LIST_TOOL_NAME, parseTaskListArgs, type TaskListItem } from './taskList';
import { resolveEditMode } from './tooling/editFileArgs';
import { resolveAgentRounds } from './tooling/agentRounds';
import { resolveParallelSubagents } from './tooling/parallelSubagents';
import { resolveCompactRatio } from './tooling/compactionPolicy';
import { emptyGitStatus, isSafeBranchName, parseBranchList, parseGitStatus, type GitStatusSummary } from './tooling/gitStatus';
import { McpMarketplaceStore, type MarketplaceState } from './mcpMarketplaceClient';
import { getProxyDispatcher, getProxyResolution } from './proxyDispatcher';
import { proxyFetch } from './proxyFetch';
import { detectLocalProxies, probeProxyReachable } from './proxyDetect';
import { providerIdForUrl, providerLabelForUrl, isIranianProvider, baseUrlHost } from './providerIdentity';
import { isGeoBlockedError, providerHttpStatus } from './providerErrors';
import { explainError } from './local/errorExplain';
import { priceForModel, resolvePrice, costForUsage, type PriceOverride, type GatewayRate, type PriceLookup } from './pricing';
import { resolveApiStyle, isOpenCodeHost, isNonChatModel } from './local/apiStyle';
import { discoverSkills, ensureBundledSkill, listableSkills, readSkillBody, resolveSkillForRun, sha256Hex, skillId, updateBundledSkillIfUntouched, SKILL_FILE, type DiscoveredSkill } from './skills';

/** Shared promisified runner for the git status line. */
const execFileAsync = promisify(execFile);

/** External MCP manager + config store - module-level so deactivate() can
 *  shut the stdio children down and the provider can serve the MCP page. */
let externalMcpInstance: ExternalMcpManager | null = null;
let mcpConfigStoreInstance: McpConfigStore | null = null;
let mcpMarketplaceInstance: McpMarketplaceStore | null = null;
/** "Xratu" output channel: diagnostics for state that has no UI of its own.
 *  Created in activate (the provider only writes to it). */
let diagnosticsChannel: vscode.OutputChannel | null = null;

/** Human label for where a subagent profile was loaded from. Resolved at
 *  RENDER time (ui() reads the live locale) - never at module scope. */
function agentSourceLabel(source: SubagentSource): string {
    return ui(`agentSource.${source}`);
}

interface ApprovalDiff {
    file: string;
    added: number;
    removed: number;
    lines: string[];
}


/** Reasoning-effort variants the host accepts from the webview. */
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);


/** Cap for the @-mention file list (same order as the project tree cap). */
const FILE_LIST_MAX_ENTRIES = 2000;



/**
 * Which webviews are already wrapped for `XRATU_WEBVIEW_LOG` recording.
 * `resolveWebviewView` runs again on every webview re-init and can hand back
 * the SAME Webview object - wrapping twice would double every line in the
 * tape and make a replay drift out of step with the real session.
 */
const recordedWebviews = new WeakSet<object>();

function getNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    while (text.length < 32) {
        const value = crypto.getRandomValues(new Uint32Array(1))[0];
        // Rejection sampling avoids the modulo bias of naive char picking.
        const idx = value % 64;
        if (idx < possible.length) {
            text += possible.charAt(idx);
        }
    }
    return text;
}


/** Result of consuming one streamed agent run. */
interface StreamOutcome {
    /** Final 'result' event, when the run completed normally. */
    resultEvent: any | null;
    /** A pending approval was surfaced (stream ended with [DONE]). */
    needsApprovalId: string | null;
    /** Server reported an error event. */
    errorEvent: any | null;
    /** Every non-chunk event, mirroring what the server persists. */
    events: any[];
    /** The run was cancelled mid-stream - `events` holds the partial turn. */
    aborted?: boolean;
    /** A pre-run guard rejected the turn (no credential, insecure URL, no
     *  model): NOTHING ran, the guard already posted its error, and the
     *  prompt must NOT join the replayed context - no provider ever saw it. */
    noRun?: boolean;
}

/** Fallback context window for LOCAL runs when neither a probe nor a user
 *  override knows the model's real window. Conservative on purpose: local
 *  runtimes (Ollama/LM Studio) default to 4-8k, and claiming a LARGER window
 *  than reality overflows the prompt and makes small models degenerate. */
const LOCAL_DEFAULT_CONTEXT_WINDOW = 8192;

/** Case-tolerant path equality for watcher-vs-store path comparisons
 *  (Windows returns watcher URIs with arbitrary drive-letter casing). */
function sameMcpPath(a: string, b: string): boolean {
    return process.platform === 'win32'
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
}

/** One row of the Usage page's rate sheet: a model's effective rate plus where
 *  it came from (mirrors the webview's ModelRateView). */
interface UsageRateRow {
    id: string;
    /** Provider host the rate applies to; '' for an override (host-independent). */
    host: string;
    input: number;
    output: number;
    cachedInput: number | null;
    currency: 'USD' | 'IRT';
    source: 'override' | 'provider' | 'gateway' | 'builtin' | 'unknown';
    /** All-time cost for this row's scope, per currency (never converted). */
    USD: number;
    IRT: number;
}

/** Edit-family tools whose file target the "open diff" button serves. */
const EDIT_DIFF_TOOLS = new Set(['edit_file', 'apply_patch', 'replace_in_file', 'write_file', 'create_file']);
/** Per-side cap for captured edit snapshots. Larger files would hold two
 *  giant strings per edit in memory; they fall back to the args-derived diff. */
const EDIT_SNAPSHOT_MAX_CHARS = 200_000;
/** Bounded FIFO of captured snapshots (one entry per edit call). */
const EDIT_SNAPSHOT_MAX_ENTRIES = 60;
/** Per-side cap for the checkpoint review surface's virtual documents. The
 *  edit-snapshot cap above is much smaller because snapshots are captured
 *  per call; review opens whatever the user picked, so a 1MB text file is
 *  the practical ceiling before the diff editor itself stops being useful. */
const REVIEW_MAX_CHARS = 1_000_000;

class XratuChatViewProvider implements vscode.WebviewViewProvider, WebviewMessageHost {
    public static readonly viewType = 'xratu-chat-view';
    _view?: vscode.WebviewView;
    _sessionId: string | null = null;
    /** Stable OpenCode session id for a not-yet-persisted conversation, so
     *  every round of a run sends the same `x-opencode-session`. */
    private _ephemeralSessionId: string | null = null;
    /** Cost display for the CURRENT run: USD normally, Toman for Iranian or
     *  gateway-rated providers. Set by _setCostCurrencyFor. */
    private _runCostCurrency: 'USD' | 'IRT' = 'USD';
    /** Base URL of the current run/provider, used to resolve its pricing. */
    private _runBaseUrl: string | null = null;
    private _runSubscription = false;
    _history: HistoryMessage[] = [];
    private _sessionSummary: string | null = null;
    /** Display title of the CURRENT session (toolbar button + picker).
     *  Mirrors the server rule: first user message, truncated; a rename
     *  always wins. Null = untitled/new session. */
    private _sessionTitle: string | null = null;
    /** Turn-scoped checkpoint store (owned by activate, shared with the bridge). */
    private readonly _checkpoints: ShadowCheckpointStore;
    private readonly _storagePath: string;
    private _oauthManager: OAuthTokenManager | null = null;
    private _oauthFlow: OAuthFlowState | null = null;
    private _oauthState: Record<string, unknown> = {};
    /**
     * Timeline rows that must be closed when an approval round resolves,
     * keyed by approval_id: approval-required calls, pre-denied calls, and
     * non-approval deferred calls ("auto") that execute server-side inside
     * /chat/approve and therefore never produce a streamed tool_result.
     */
    private _approvalCloseItems: Record<string, Array<{ tool_call_id: string; tool_name: string; kind?: string }>> = {};
    /** Session-scoped "allow for this session" kinds, chosen from the
     *  approval card's third action. A kind is a tool name, or for
     *  run_terminal_command the command's leading binary (`cmd:npm`) -
     *  approving one command trusts that KIND of command, not every
     *  mutating tool. Classification is deliberately narrow (pure helpers
     *  in sessionApproval.ts): shell-composed or unclassifiable commands
     *  always prompt again. Cleared with the session ledgers (new session
     *  / logout). */
    private _sessionApprovedKinds = new Set<string>();
    /** One controller per in-flight request kind: cancel can never hit the wrong stream. */
    private _abortControllers = new Map<'chat' | 'approve', AbortController>();
    /** Bumped whenever the visible session is wiped (new session, logout,
     *  account inactive). In-flight run handlers compare their captured
     *  value before writing history or posting follow-ups, so a cancelled
     *  zombie stream can never leak into a freshly cleared session. */
    private _sessionEpoch = 0;
    private _connectionStatusInterval: NodeJS.Timeout | null = null;
    private _chatRetryCount: number = 0;
    _yoloMode: boolean = false;
    _planMode: boolean = false;
    _selectedModel: string | null = null;
    /** Provider-reported context windows, scoped by provider HOST then model
     *  id (so the same id on two providers never shares a window). Only
     *  windows the provider actually reported live here; the curated fallback
     *  is applied at lookup time. */
    private _contextWindows: Record<string, Record<string, number>> = {};
    /** Cached, normalized model metadata per host (see modelMetadata.ts). */
    private _modelCatalog: ModelCatalog = {};
    /** models.dev fallback catalog (per-provider windows/capabilities), loaded
     *  from disk at startup so an offline start still has accurate metadata. */
    private _modelsDevCatalog: ModelsDevCatalog | null = null;
    private _modelsDevFetchedAt = 0;
    private _modelsDevNextAttemptAt = 0;
    private _modelsDevLoading: Promise<ModelsDevCatalog | null> | null = null;
    private _modelsDevLoaded: Promise<void> | null = null;
    private readonly _modelsDevFile: string;
    /** Pending local approvals - resolver keyed by approvalId. */
    private _localApprovalResolvers: Record<string, {
        resolve: (decisions: Record<string, boolean>) => void;
        reject: (err: unknown) => void;
    }> = {};
    /** Serializes approval-card presentation: the webview shows ONE card at a
     *  time, so concurrent requests (parallel subagents) queue behind the
     *  card in flight. */
    private _approvalCardChain: Promise<void> = Promise.resolve();
    /** Card-slot release hooks keyed by approvalId (see _releaseApprovalCard). */
    private _approvalCardRelease: Map<string, () => void> = new Map();
    /** Pending `ask_user_question` decisions - resolver keyed by decisionId.
     *  Same correlation pattern as the approval card (promise parked until
     *  the webview answers), tracked so a cancel can reject it instead of
     *  leaving the tool call suspended forever. The question rides along so
     *  a picked label can be mapped back onto its option (description and
     *  all) before the outcome reaches the model. */
    private _localDecisionResolvers: Map<string, {
        resolve: (outcome: UserQuestionOutcome) => void;
        reject: (err: unknown) => void;
        question: UserQuestion;
    }> = new Map();
    /** Serializes decision-card presentation (one interactive card at a time). */
    private _decisionCardChain: Promise<void> = Promise.resolve();
    /** Card-slot release hooks keyed by decisionId. */
    private _decisionCardRelease: Map<string, () => void> = new Map();
    /** Local-mode conversation history (OpenAI-format messages). Carries the
     *  provider-native replay carriers (`providerBlocks`, `reasoningContent`,
     *  `isError`) so the next request rebuilds the EXACT bytes the provider
     *  saw - a lossy reconstruction breaks prefix prompt caching and drops
     *  thinking state. */
    private _localHistory: LocalSessionHistoryMessage[] = [];
    /** User turns evicted from the FRONT of `_localHistory` to bound memory.
     *  The display ledger (`_history`) keeps every turn, so a displayed
     *  userIndex maps to a model-ledger row by subtracting this offset. */
    private _localEvictedUserTurns = 0;
    /** Number of leading user turns of `_localHistory` the model should still
     *  REPLAY, or null for all. Compaction folds older turns into the rolling
     *  summary, so they must not be re-sent (and re-summarized) every turn.
     *  Their rows stay in `_localHistory` - only replay skips them - so rewind
     *  and the eviction offset above stay aligned. Stored as a SUFFIX count so
     *  it survives the snapshot's front-trim (`MAX_STORED_TURNS`). */
    private _localReplayUserTurns: number | null = null;
    /** `_localReplayUserTurns` captured when the current run started; the run
     *  reports its CUMULATIVE dropped count against this baseline. */
    private _compactionRunReplayBase: number | null = null;
    /** Session-frozen project rules for the local system prompt. Recomputed
     *  per turn it rewrote the cacheable prefix on every active-file change
     *  (see `RulesSnapshot`). */
    private _localRulesSnapshot = new RulesSnapshot();
    /** Steered user messages waiting to join the LIVE local run. Entries
     *  carry the PROCESSED payload (refs resolved, PDFs extracted, text
     *  attachments fenced into `text`); `carryAttachments` holds image-only
     *  attachments for a potential follow-up turn. */
    private _localSteerQueue: Array<{
        text: string;
        images?: LocalImageAttachment[];
        meta?: AttachmentMeta[];
        carryAttachments?: ComposerAttachment[];
        /** Webview id of the pending bubble to confirm on injection. Absent
         *  for steers routed from a plain askQuestion race (the webview
         *  already rendered that user row). */
        steerId?: string;
        /** A background-job completion rather than something the user typed.
         *  Rendered as a system notice so the transcript never implies the
         *  user said it, but delivered on the same rail. */
        system?: boolean;
    }> = [];
    /** Completion reports for background jobs that ended while no run was
     *  live. Held rather than auto-woken: a job exiting is not a user request,
     *  and starting a turn to announce it would spend tokens unprompted. They
     *  join the next turn's context at its first round boundary. */
    private _pendingJobNotices: string[] = [];
    /** Dropped by `deactivate` so a reload leaves no listener posting into a
     *  disposed webview. */
    private _unsubscribeJobEvents: (() => void) | null = null;
    /** Checkpoint for background jobs, so a window reload does not orphan the
     *  processes the user asked to keep running. */
    private _backgroundJobs: BackgroundJobStore | null = null;
    /** Identity of the current chat turn. `_handleSteer` captures it BEFORE
     *  its async attachment work and re-checks before queueing: a steer
     *  whose targeted run settled meanwhile (success, cancel or a noRun
     *  guard rejection) must not join the shared queue - the next run
     *  would drain and answer text the user aimed at a dead prompt. */
    private _localTurnToken = 0;
    /** True while a local agent loop is live - steers queue for its next
     *  round boundary instead of starting a new turn. */
    _localRunActive = false;
    /** Settles when the owning local run fully unwinds (either cleanup
     *  finally in _handleChatRequest). _clearAllSessions awaits it so the
     *  fresh session is only exposed after the canceled run has stopped
     *  writing. Null when no run owns _localRunActive. */
    private _localRunSettled: Promise<void> | null = null;
    private _resolveRunSettled: (() => void) | null = null;

    /** Settle the owning run's deferred (idempotent; both cleanup finallys
     *  in _handleChatRequest call this). */
    private _settleLocalRun(): void {
        this._resolveRunSettled?.();
        this._resolveRunSettled = null;
        this._localRunSettled = null;
    }
    /** Accumulated local text for the current assistant turn - mirrors the cloud "result" event. */
    private _localAccumulatedText: string = '';
    private _localAccumulatedThinking: string = '';
    /** Timeline event for the CURRENT reasoning block: the first delta pushes
     *  it into outcome.events (so reasoning survives reload in the right place
     *  relative to tool/text steps), later cumulative deltas extend it in
     *  place. Null between blocks. `content` carries the BOUNDED copy (clipped
     *  to MAX_CONTENT_CAP as it streams); `_localThinkingBlockRaw` keeps the
     *  full cumulative value the extends are matched against - a clipped
     *  string is never a prefix of the next delta. */
    private _localThinkingBlockEvent: { type: 'thinking'; content: string } | null = null;
    private _localThinkingBlockRaw: string | null = null;
    private _localCurrentUsage: LocalUsage | null = null;
    /** Sum of every non-estimated round's usage across the CURRENT turn (a
     *  tool-calling turn makes several requests) - the basis for turn cost. */
    private _localTurnUsage: LocalUsage | null = null;
    /** Cumulative spend for the session, PER CURRENCY (persisted). Monotonic:
     *  a rewind or checkpoint restore does not refund already-spent tokens,
     *  and currencies are never converted into one another. */
    private _sessionCost: { USD: number; IRT: number } = { USD: 0, IRT: 0 };
    /** Session TOKEN totals (input/output/cached), persisted and monotonic
     *  like the cost ledger - the Usage page's usage readout. */
    private _sessionUsage: { input: number; output: number; cached: number } = { input: 0, output: 0, cached: 0 };
    /** Token totals per provider host for this session (persisted), so usage
     *  can be attributed without re-reading the transcript. */
    private _sessionUsageByHost: Record<string, { input: number; output: number; cached: number }> = {};
    /** Machine-global timestamped usage ledger (daily chart + retroactive
     *  repricing). See src/local/usageLedger.ts. */
    private readonly _usageLedger: UsageLedgerStore;
    /** Delegated subagent transcripts by task_id, PER CHAT: a later `task`
     *  call can CONTINUE a run with its context restored. Keyed by chat rather
     *  than held in one map so switching chats and coming back does not orphan
     *  a run the model can still legitimately resume; only a window reload or a
     *  cleared history ends a run for good (the task_id note says so). */
    private readonly _subagentRunsByChat = new Map<string, SubagentRunRegistry>();
    /** Fingerprint of the last agent-file diagnostics logged, so a per-turn
     *  rediscovery does not repeat an unchanged complaint. */
    private _subagentIssueSignature = '';
    /** How many chats keep resumable subagent runs in memory. Older chats are
     *  dropped (their runs become non-resumable, as a reload would). */
    private static readonly MAX_SUBAGENT_CHATS = 4;

    /** Registry backing the live chat's delegated runs, created on first use
     *  and re-touched (LRU) on every access.
     *
     *  The EPHEMERAL id is preferred over the stored one: a chat's first send
     *  creates the ephemeral id, and persisting that same chat then assigns a
     *  stored id WITHOUT clearing the ephemeral one. Keying on the stored id
     *  first would move the registry out from under the run that is still live,
     *  so a task_id reported in the first turn would be unresolvable in the
     *  second. The ephemeral id is assigned once per live chat and every path
     *  that adopts a different chat clears it (see _restoreLocalSession), so
     *  preferring it can never point one chat's key at another's runs. */
    private _subagentRuns(): SubagentRunRegistry {
        const key = this._ephemeralSessionId ?? this._sessionId ?? '';
        const existing = this._subagentRunsByChat.get(key);
        if (existing) {
            this._subagentRunsByChat.delete(key);
            this._subagentRunsByChat.set(key, existing);
            return existing;
        }
        const created: SubagentRunRegistry = new Map();
        this._subagentRunsByChat.set(key, created);
        for (const [chat, registry] of this._subagentRunsByChat) {
            if (this._subagentRunsByChat.size <= XratuChatViewProvider.MAX_SUBAGENT_CHATS) break;
            if (chat === key) continue;
            registry.clear();
            this._subagentRunsByChat.delete(chat);
        }
        return created;
    }

    /** Drop the live chat's resumable runs (history cleared / chat deleted). */
    private _forgetSubagentRuns(): void {
        this._subagentRunsByChat.delete(this._ephemeralSessionId ?? this._sessionId ?? '');
    }

    /** Every tool name a subagent could be offered in this workspace: the
     *  plan:false toolset (so a plan-mode run never makes a valid name look
     *  unknown), plus skills and external MCP tools. Used both to VALIDATE
     *  agent files and to scaffold a correct starter file. */
    private _agentToolNames(workspaceRoot: string | undefined, external: AggregatedTool[]): Set<string> {
        return new Set(getLocalToolDefinitions({
            yolo: true,
            plan: false,
            external,
            skills: this._discoverSkillsForRun(workspaceRoot ?? ''),
        }).map((t) => t.name));
    }

    /** Report agent files that failed to load or loaded with something ignored.
     *  Discovery runs on every turn, so the same problem is re-reported only
     *  when it CHANGES - otherwise the channel would fill with the same line
     *  once per round. */
    private _logSubagentIssues(defs: readonly SubagentDefinition[]): void {
        const issues = subagentIssues(defs);
        const signature = issues.map((i) => `${i.def.name}:${i.fatal ? 'error' : 'warning'}:${i.message}`).join('\n');
        if (signature === this._subagentIssueSignature) return;
        this._subagentIssueSignature = signature;
        const channel = diagnosticsChannel;
        if (!channel) return;
        if (issues.length === 0) return;
        channel.appendLine(`[subagents] ${issues.length} agent file issue(s):`);
        for (const issue of issues) {
            channel.appendLine(
                `  ${issue.fatal ? 'ERROR' : 'warn '} ${issue.def.name}`
                + `${issue.def.filePath ? ` (${issue.def.filePath})` : ''}: ${issue.message}`);
        }
        channel.appendLine('  Run "Xratu: Agent Files" to see them, or fix the frontmatter.');
    }
    /** Serializes read-modify-write pricing mutations so two rapid edits cannot
     *  clobber each other's snapshot of the settings object. */
    private _pricingWrite: Promise<void> = Promise.resolve();
    /** The in-flight local turn, held so a throttled snapshot can persist it
     *  BEFORE the run commits - a host crash mid-run used to lose the whole
     *  turn (local mode has no server copy). Cleared in _runLocalAgent's
     *  finally; the ledgers alone are authoritative after that. */
    private _localPendingTurn: { prompt: string; events: any[]; attachments?: AttachmentMeta[] } | null = null;
    private _localPartialTimer: ReturnType<typeof setTimeout> | null = null;
    readonly _localSessionStore: LocalSessionStore;
    /** Seq for in-app notification banners (replaces vscode.window toasts). */
    private _notifSeq = 0;
    /** Config file the MCP page just wrote, with a hash of the exact bytes -
     *  the file watcher consumes ONE event whose current file content hashes
     *  equal (the save's own echo - the save path reloads itself); a manual
     *  edit of that same file hashes differently and reloads normally. */
    private _mcpPageWritePending: { path: string; hash: string } | null = null;
    private _mcpPageWriteTimer: ReturnType<typeof setTimeout> | null = null;
    /** Pending confirm-banner resolvers keyed by notification id - the webview
     *  answers via notificationAction; a reload/dispose resolves with null. */
    private _pendingNotifies = new Map<string, (action: string | null) => void>();

    private _onDidChangeVirtualDoc = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChangeVirtualDoc.event;
    private _virtualDocuments = new Map<string, string>();
    /** Exact before/after file content captured around edit-family tool
     *  calls, keyed by tool_call id - the source for the webview's
     *  "open diff in editor" button while the session is live. Bounded FIFO
     *  (see _endEditSnapshot); restored history falls back to args-derived
     *  reconstruction in editDiff.ts. */
    private readonly _editSnapshots = new Map<string, { path: string; before: string; after: string }>();
    private _webviewSubscriptions: vscode.Disposable[] = [];

    public provideTextDocumentContent(uri: vscode.Uri): string {
        return this._virtualDocuments.get(uri.toString()) || '';
    }

    /** Capture the target file's content just before an edit-family tool runs.
     *  Returns null when there is nothing sensible to snapshot (non-edit tool,
     *  missing/unsafe path, or a file too large to hold in memory twice). */
    private _beginEditSnapshot(
        call: { name: string; arguments: Record<string, unknown> },
        workspaceRoot: string
    ): { path: string; full: string; before: string } | null {
        if (!EDIT_DIFF_TOOLS.has(call.name)) return null;
        const raw = typeof call.arguments?.path === 'string' ? call.arguments.path : '';
        if (!raw) return null;
        let full: string;
        try {
            full = sanitizePath(raw, workspaceRoot);
        } catch {
            return null;
        }
        let before: string;
        try {
            if (fs.statSync(full).size > EDIT_SNAPSHOT_MAX_CHARS) return null;
            before = fs.readFileSync(full, 'utf-8');
        } catch {
            // Missing file = creation; '' is the correct before side.
            before = '';
        }
        return { path: raw, full, before };
    }

    /** Pair a snapshot with the post-edit content and retain it (bounded FIFO).
     *  The webview's "open diff" button looks snapshots up by tool_call id;
     *  restored sessions (empty map) reconstruct from args instead. */
    private _endEditSnapshot(
        callId: string,
        snap: { path: string; full: string; before: string }
    ): void {
        let after: string;
        try {
            if (fs.statSync(snap.full).size > EDIT_SNAPSHOT_MAX_CHARS) return;
            after = fs.readFileSync(snap.full, 'utf-8');
        } catch {
            return;
        }
        this._editSnapshots.set(callId, { path: snap.path, before: snap.before, after });
        while (this._editSnapshots.size > EDIT_SNAPSHOT_MAX_ENTRIES) {
            const oldest = this._editSnapshots.keys().next();
            if (oldest.done) break;
            this._editSnapshots.delete(oldest.value);
        }
    }

    /** Webview's "open diff in editor": resolve each completed edit call to a
     *  before/after pair (exact snapshot first, args reconstruction second) and
     *  open the host's native diff editor. */
    async _openEditDiff(
        edits: Array<{ tool?: string; args?: string; callId?: string; result?: string }>
    ): Promise<void> {
        const resolved: Array<{ path: string; before: string; after: string }> = [];
        for (const edit of Array.isArray(edits) ? edits : []) {
            if (!edit || typeof edit.args !== 'string') continue;
            const snap = typeof edit.callId === 'string' ? this._editSnapshots.get(edit.callId) : undefined;
            if (snap) {
                resolved.push({ path: snap.path, before: snap.before, after: snap.after });
                continue;
            }
            const built = editDiffFromArgs(
                typeof edit.tool === 'string' ? edit.tool : undefined,
                edit.args,
                typeof edit.result === 'string' ? edit.result : undefined
            );
            if (built) resolved.push(built);
        }
        if (resolved.length === 0) {
            this.notifyBanner('error', 'openDiffFailed');
            return;
        }
        let chosen = resolved[0];
        if (resolved.length > 1) {
            const pick = await vscode.window.showQuickPick(
                resolved.map((r, i) => ({ label: r.path || `#${i + 1}`, index: i })),
                { placeHolder: ui('openDiffPick') }
            );
            if (!pick) return;
            chosen = resolved[pick.index];
        }
        if (!openEditDiff(this._virtualDocuments, chosen.path, chosen.before, chosen.after)) {
            this.notifyBanner('error', 'openDiffFailed');
        }
    }

    constructor(
        private readonly _extensionUri: vscode.Uri,
        readonly _secrets: vscode.SecretStorage,
        checkpoints: ShadowCheckpointStore,
        readonly _globalState: vscode.Memento,
        localStorageUri: vscode.Uri
    ) {
        this._checkpoints = checkpoints;
        this._storagePath = localStorageUri.fsPath;
        this._localSessionStore = new LocalSessionStore(localStorageUri.fsPath);
        this._usageLedger = new UsageLedgerStore(localStorageUri.fsPath);
        // Prune once per host session: the append counter resets with the
        // process, so an install whose windows each append fewer than
        // COMPACT_EVERY rounds would never drop entries past retention.
        void this._usageLedger.compact().catch(() => undefined);
        setUiLocale(this._globalState.get<string>('xratu.locale') === 'en' ? 'en' : 'fa');
        this._contextWindows = this._loadContextWindows();
        this._modelCatalog = readModelCatalog(this._globalState.get<string>('xratu.modelCatalog'));
        this._modelsDevFile = path.join(localStorageUri.fsPath, 'models-dev.json');
        void this._initModelsDev();
        this._loadTaskListEdits();
        setTaskListWriteListener((tasks) => this._noteTaskListWrite(tasks));
        // exit_plan_mode (agent-initiated): ends plan mode exactly like the
        // user's toolbar toggle - state flips so the NEXT request carries
        // plan_mode=false, and the webview echo keeps the toolbar honest.
        setPlanModeExitListener(() => {
            if (this._planMode) {
                this._planMode = false;
                this._view?.webview.postMessage({ type: 'planMode', enabled: false });
            }
        });
        // Background jobs live in a module-level registry that outlives the
        // view, so the listener is dropped on dispose - otherwise a window
        // reload leaves a closure posting banners into a dead webview.
        this._unsubscribeJobEvents = onJobEvent((event) => this._handleJobEvent(event));
    }

    /** Point the job registry at its checkpoint file. Called from `activate`
     *  once globalStorage is known; the registry itself stays storage-agnostic. */
    attachBackgroundJobStore(store: BackgroundJobStore): void {
        this._backgroundJobs = store;
        setJobChangeListener(() => {
            void store.save(adoptableJobRecords());
        });
    }

    /** Tell the user that processes from a previous window survived, so a
     *  reload does not look like it silently lost them. */
    reportAdoptedJobs(count: number): void {
        this.notifyBanner('info', 'notifBackgroundAdopted', { count: String(count) });
        // The badge is populated from this push alone, so a recovered job that
        // nobody sends another event for would sit running with no chip until
        // something unrelated happened to refresh the list.
        this._postBackgroundJobs();
    }

    /** Records we could NOT re-prove as still ours. Surfaced rather than
     *  dropped quietly: the common cause is a host that cannot read process
     *  start times, which disables recovery entirely. */
    reportUnrecoverableJobs(count: number): void {
        console.warn(`xratu: ${count} background job record(s) could not be verified as still running and were dropped`);
        this.notifyBanner('warning', 'notifBackgroundUnrecoverable', { count: String(count) });
    }

    /** Release the job-event listener. Registered as a subscription so VS Code
     *  disposes it on deactivate / window reload. */
    disposeJobEvents(): void {
        this._unsubscribeJobEvents?.();
        this._unsubscribeJobEvents = null;
    }

    /** Provider-reported context windows, per host. Persisted so a mid-session
     *  extension reload does NOT silently drop the real window: without it
     *  _contextWindowHint() returns undefined and the run falls back to
     *  LOCAL_DEFAULT_CONTEXT_WINDOW (8192) - compacting a 1.3M-window
     *  conversation at ~8k. A legacy FLAT table (model -> window, no host) is
     *  discarded rather than promoted: it belonged to one provider and would
     *  bleed onto every other one. */
    private _loadContextWindows(): Record<string, Record<string, number>> {
        try {
            const raw = this._globalState.get<string>('xratu.contextWindows');
            const parsed = raw ? JSON.parse(raw) : {};
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
            const out: Record<string, Record<string, number>> = {};
            for (const [host, table] of Object.entries<any>(parsed)) {
                if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
                const clean: Record<string, number> = {};
                for (const [model, win] of Object.entries<any>(table)) {
                    if (typeof win === 'number' && Number.isFinite(win) && win >= 1024) clean[model] = Math.floor(win);
                }
                if (Object.keys(clean).length) out[host.toLowerCase()] = clean;
            }
            return out;
        } catch {
            return {};
        }
    }

    private async _saveContextWindows(): Promise<void> {
        await this._globalState.update('xratu.contextWindows', JSON.stringify(this._contextWindows));
    }

    private async _saveModelCatalog(): Promise<void> {
        await this._globalState.update('xratu.modelCatalog', serializeModelCatalog(this._modelCatalog));
    }

    /** Load the on-disk models.dev catalog, then refresh it in the background
     *  ONLY when a saved credential uses a provider the catalog covers - a
     *  local-only or Iranian-provider install never makes the request. */
    private async _initModelsDev(): Promise<void> {
        await this._ensureModelsDevLoaded();
        try {
            const credentials = await this._getSavedCredentials();
            if (credentials.some((c) => modelsDevProviderKey(providerIdForUrl(c.baseUrl)))) {
                void this._ensureModelsDevCatalog();
            }
        } catch {
            // Credentials unavailable at startup: the fetch happens lazily.
        }
    }

    /** The one-time disk load, shared so a concurrent fetch cannot race it. */
    private _ensureModelsDevLoaded(): Promise<void> {
        return (this._modelsDevLoaded ??= this._loadModelsDevCache());
    }

    /** Load the persisted models.dev catalog. Best-effort: a missing or
     *  corrupt file is the normal first-run state and simply means the next
     *  refresh fetches a fresh copy. */
    private async _loadModelsDevCache(): Promise<void> {
        try {
            const cache = readModelsDevCache(await fs.promises.readFile(this._modelsDevFile, 'utf8'));
            if (!cache) return;
            // A fetch that somehow finished first wins over the older disk copy.
            if (this._modelsDevCatalog) return;
            this._modelsDevCatalog = cache.catalog;
            this._modelsDevFetchedAt = cache.fetchedAt;
        } catch {
            // Missing cache - the next _ensureModelsDevCatalog() fetches it.
        }
    }

    /** Persist the models.dev catalog atomically (temp + rename). A failed
     *  write must never break model discovery, so it is swallowed. */
    private async _saveModelsDevCache(): Promise<void> {
        if (!this._modelsDevCatalog) return;
        try {
            await fs.promises.mkdir(path.dirname(this._modelsDevFile), { recursive: true });
            const temp = `${this._modelsDevFile}.tmp`;
            await fs.promises.writeFile(
                temp,
                serializeModelsDevCache({ fetchedAt: this._modelsDevFetchedAt, catalog: this._modelsDevCatalog }),
                'utf8',
            );
            await renameWithRetry(temp, this._modelsDevFile);
        } catch {
            // Best-effort cache.
        }
    }

    /** The models.dev catalog, refreshed at most once per TTL. A failed fetch
     *  serves the stale copy (offline/degraded) instead of nothing, backs off
     *  before retrying, and concurrent callers share one in-flight request.
     *  Never throws. */
    private async _ensureModelsDevCatalog(): Promise<ModelsDevCatalog | null> {
        // Never fetch before the disk load has settled, or the load could
        // clobber a just-fetched catalog with the older persisted copy.
        await this._ensureModelsDevLoaded();
        if (this._modelsDevCatalog && Date.now() - this._modelsDevFetchedAt < MODELS_DEV_TTL_MS) {
            return this._modelsDevCatalog;
        }
        if (Date.now() < this._modelsDevNextAttemptAt) return this._modelsDevCatalog;
        if (this._modelsDevLoading) return this._modelsDevLoading;
        const load = (async (): Promise<ModelsDevCatalog | null> => {
            try {
                const fetched = await fetchModelsDevCatalog(undefined, undefined, getProxyDispatcher(MODELS_DEV_URL));
                if (!fetched) {
                    this._modelsDevNextAttemptAt = Date.now() + MODELS_DEV_RETRY_MS;
                    return this._modelsDevCatalog;
                }
                this._modelsDevCatalog = fetched;
                this._modelsDevFetchedAt = Date.now();
                void this._saveModelsDevCache();
                return fetched;
            } finally {
                this._modelsDevLoading = null;
            }
        })();
        this._modelsDevLoading = load;
        return load;
    }

    /** Provider-reported windows for one host (empty when none). */
    private _contextWindowsFor(host: string | null | undefined): Record<string, number> {
        const key = (host ?? '').trim().toLowerCase();
        return key ? (this._contextWindows[key] ?? {}) : {};
    }

    /** Replace a host's provider-reported windows with the latest probe's
     *  snapshot. Replacing (not merging) is deliberate: a model the provider
     *  no longer reports - or one whose window it withdrew - must not linger
     *  and keep overriding the curated fallback. */
    private _rememberContextWindows(host: string | null | undefined, models: LocalModelInfo[]): void {
        const key = (host ?? '').trim().toLowerCase();
        if (!key) return;
        const reported: Record<string, number> = {};
        for (const m of models) {
            if (m.id && m.contextWindowReported && m.contextWindow) reported[m.id] = m.contextWindow;
        }
        const next = { ...this._contextWindows };
        if (Object.keys(reported).length) next[key] = reported;
        else delete next[key];
        this._contextWindows = next;
        void this._saveContextWindows();
    }

    // --- Session task list ("the list IS the plan") --------------------------
    // The current list derives from the newest update_task_list tool_call in
    // _history; user edits are a small per-session override that any NEW
    // model write invalidates (setTaskListWriteListener → _noteTaskListWrite).

    _taskListEdits: Record<string, TaskListItem[]> = {};

    /** Live task list for the IN-FLIGHT run, refreshed on every model write
     *  (_noteTaskListWrite). The trailing reminder is rebuilt from this each
     *  round, so the model sees the plan it just changed rather than the
     *  snapshot frozen when the run started. Null between runs. */
    private _activeRunTaskList: TaskListItem[] | null = null;
    /** True while a local run is draining events; a write outside a run must
     *  only move the session override, never this snapshot. */
    private _runInFlight = false;

    private _loadTaskListEdits(): void {
        try {
            const raw = this._globalState.get<string>('xratu.taskListEdits');
            const parsed = raw ? JSON.parse(raw) : {};
            this._taskListEdits = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                ? parsed : {};
        } catch {
            this._taskListEdits = {};
        }
    }

    async _saveTaskListEdits(): Promise<void> {
        await this._globalState.update('xratu.taskListEdits', JSON.stringify(this._taskListEdits));
    }

    /** A model write invalidates the session's edit override, and refreshes
     *  the in-flight run so its trailing reminder tracks the new list. */
    private _noteTaskListWrite(tasks?: TaskListItem[]): void {
        // The reminder reads this every round. Only a call that actually
        // carries a parsed list may refresh it - the bare call driven by the
        // toolCall event fires before execution and must not clobber it.
        if (this._runInFlight && tasks?.length) {
            this._activeRunTaskList = tasks;
        }
        if (this._sessionId && this._taskListEdits[this._sessionId]) {
            delete this._taskListEdits[this._sessionId];
            void this._saveTaskListEdits().catch((e) =>
                console.error('xratu: task list edit persist failed:', e));
            this._pushTaskListState();
        }
    }

    /** Current merged list for the live session: user override wins, else the
     *  newest model write in history. Null when this session has no list. */
    private _currentTaskList(): TaskListItem[] | null {
        const override = this._sessionId ? this._taskListEdits[this._sessionId] : undefined;
        if (override && override.length) return override;
        for (let i = this._history.length - 1; i >= 0; i--) {
            const row = this._history[i];
            if (row.role !== 'assistant' || !Array.isArray(row.events)) continue;
            for (let j = row.events.length - 1; j >= 0; j--) {
                const ev = row.events[j];
                if (ev && ev.type === 'tool_call' && ev.tool === TASK_LIST_TOOL_NAME) {
                    const parsed = parseTaskListArgs(ev.args);
                    return parsed && parsed.length ? parsed : null;
                }
            }
        }
        return null;
    }

    /** Echo the session's task-list EDIT OVERRIDE (null = none). The webview
     *  shows the override over the newest update_task_list step's args and
     *  falls back to those args when there is no override - pushing the
     *  derived list here would race a mid-run write (history rows commit at
     *  end of run) and flash a stale checklist. */
    _pushTaskListState(): void {
        const override = this._sessionId ? this._taskListEdits[this._sessionId] : undefined;
        this._view?.webview.postMessage({
            type: 'taskListState',
            tasks: override && override.length ? override : null,
        });
    }

    /** Native-toast fallback text - resolved from uiStrings (bilingual,
     *  locale follows the user's persisted choice). */
    private static _fallbackText(key: string, params?: Record<string, string>): string {
        return ui(key, params);
    }

    /** Show an in-app notification banner (info/warning/error). The message
     *  is an i18n KEY (+ optional interpolation params) resolved webview-side
     *  via tf(); falls back to a native VS Code toast when the webview can't
     *  render banners. */
    public notifyBanner(kind: 'info' | 'warning' | 'error', valueKey: string, params?: Record<string, string>): void {
        const showNative = () => {
            const text = XratuChatViewProvider._fallbackText(valueKey, params);
            const fn = kind === 'error' ? vscode.window.showErrorMessage
                : kind === 'warning' ? vscode.window.showWarningMessage
                    : vscode.window.showInformationMessage;
            void fn(text);
        };
        if (!this._view) {
            showNative();
            return;
        }
        this._view.webview.postMessage({
            type: 'notification',
            id: `n${++this._notifSeq}`,
            kind,
            valueKey,
            params
        }).then((ok) => {
            if (!ok) showNative();
        });
    }

    /** Confirm dialog rendered as an in-app banner with action buttons.
     *  `actions` are i18n keys; resolves with the picked ACTION KEY, or null
     *  on dismiss/cancel - callers compare keys, never localized labels. */
    public confirmBanner(messageKey: string, actions: string[], params?: Record<string, string>): Promise<string | null> {
        const native = () => {
            const labels = actions.map((a) => XratuChatViewProvider._fallbackText(a));
            const msg = XratuChatViewProvider._fallbackText(messageKey, params);
            return Promise.resolve(
                vscode.window.showWarningMessage(msg, ...labels).then((picked) =>
                    picked ? (actions[labels.indexOf(picked)] ?? null) : null
                )
            );
        };
        if (!this._view) return native();
        const id = `n${++this._notifSeq}`;
        return new Promise<string | null>((resolve) => {
            this._pendingNotifies.set(id, resolve);
            this._view!.webview.postMessage({ type: 'notification', id, kind: 'warning', valueKey: messageKey, params, actions })
                .then((ok) => {
                    if (!ok) {
                        this._pendingNotifies.delete(id);
                        native().then(resolve);
                    }
                });
        });
    }

    /** Webview answered (or was replaced/disposed) - settle the confirm. */
    _resolveNotification(id: string, action: string | null): void {
        const resolve = this._pendingNotifies.get(id);
        if (resolve) {
            this._pendingNotifies.delete(id);
            resolve(action);
        }
    }

    /** A geo-blocked provider (403/451): the raw error is already shown, so
     *  additionally offer a one-tap switch to an Iranian provider. The active
     *  credential is NEVER changed without the user picking the action. */
    private async _maybeOfferIranianFallback(error: unknown): Promise<void> {
        if (!isGeoBlockedError(error)) return;
        const action = await this.confirmBanner('geoBlockedHint', ['geoBlockedSwitch']);
        if (action !== 'geoBlockedSwitch') return;
        const credentials = await this._getSavedCredentials();
        // Exclude the EFFECTIVE active credential: switching a geo-blocked
        // provider to itself is a no-op. Resolve the id the same way the rest
        // of the host does (configured id, else the first saved one).
        const activeId = await this._resolveActiveCredentialId();
        const iranian = credentials.find((c) => c.id !== activeId && isIranianProvider(c.providerId));
        if (iranian) {
            await this._selectLlmCredential(iranian.id);
            this.notifyBanner('info', 'geoBlockedSwitched');
            return;
        }
        this.notifyBanner('warning', 'geoBlockedNoProvider');
        await this._setLlmCredentials('geoBlocked', 'byok');
    }

    /** Interactive rollback: pick a shadow checkpoint and restore files to it. */
    public async restoreCheckpointFlow(): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.notifyBanner('error', 'notifNoFolder');
            return;
        }
        // listCheckpoints throws when the shadow store cannot be initialized (git
        // missing, unwritable storage). Callers `void` this flow, so an
        // uncaught throw became an unhandled rejection and the restore button
        // silently did nothing - the palette path surfaced the same failure.
        let listing: string;
        try {
            listing = await this._checkpoints.listCheckpoints(folder.uri.fsPath, 20);
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            diagnosticsChannel?.appendLine(`xratu checkpoints - list failed: ${error}`);
            this.notifyBanner('error', 'notifCheckpointsUnavailable', { error });
            return;
        }
        const entries = listing.split('\n').filter((l) => l.includes('|'));
        if (entries.length === 0 || listing === 'No checkpoints found.') {
            this.notifyBanner('info', 'notifNoCheckpoints');
            return;
        }
        const picked = await vscode.window.showQuickPick(
            entries.map((line) => {
                const [sha, date, ...subject] = line.split('|');
                return { label: subject.join('|').trim() || 'checkpoint', description: `${date.trim()} (${sha.trim()})`, sha: sha.trim() };
            }),
            { placeHolder: ui('checkpointRestorePlaceholder') }
        );
        if (!picked) return;
        const confirm = await this.confirmBanner(
            'notifRestoreConfirm',
            ['notifRestoreAction', 'notifCancel'],
            { target: picked.description }
        );
        if (confirm !== 'notifRestoreAction') return;
        try {
            const result = await this._checkpoints.restoreCheckpoint(folder.uri.fsPath, picked.sha);
            // changed=false = workspace already matched the checkpoint -
            // nothing was restored, so stay silent.
            if (result.changed) {
                this.notifyBanner('info', 'notifRestored', { sha: result.sha, safety: result.safety });
            }
        } catch (e) {
            this.notifyBanner('error', 'notifRestoreFailed', {
                error: e instanceof Error ? e.message : String(e)
            });
        }
    }

    /** Hunk-level review of what changed since a checkpoint: pick a file,
     *  then a hunk, and open the native side-by-side diff landed on that
     *  hunk. The palette path picks the checkpoint here; the transcript's
     *  review button arrives with the row's checkpoint sha instead. Data
     *  comes from the shadow store (checkpoint side) and the working tree
     *  (current side); the preview itself is editDiffView's virtual docs. */
    public async reviewChangesFlow(fromSha?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.notifyBanner('error', 'notifNoFolder');
            return;
        }
        const root = folder.uri.fsPath;
        let sha = fromSha;
        if (!sha) {
            let listing: string;
            try {
                listing = await this._checkpoints.listCheckpoints(root, 20);
            } catch (e) {
                const error = e instanceof Error ? e.message : String(e);
                diagnosticsChannel?.appendLine(`xratu checkpoints - list failed: ${error}`);
                this.notifyBanner('error', 'notifCheckpointsUnavailable', { error });
                return;
            }
            const entries = listing.split('\n').filter((l) => l.includes('|'));
            if (entries.length === 0 || listing === 'No checkpoints found.') {
                this.notifyBanner('info', 'notifNoCheckpoints');
                return;
            }
            const picked = await vscode.window.showQuickPick(
                entries.map((line) => {
                    const [hash, date, ...subject] = line.split('|');
                    return { label: subject.join('|').trim() || 'checkpoint', description: `${date.trim()} (${hash.trim()})`, sha: hash.trim() };
                }),
                { placeHolder: ui('reviewCheckpointPlaceholder') }
            );
            if (!picked) return;
            sha = picked.sha;
        }
        let changed: ChangedFile[];
        try {
            changed = await this._checkpoints.diffCheckpoint(root, sha);
        } catch (e) {
            this.notifyBanner('error', 'notifReviewFailed', {
                error: e instanceof Error ? e.message : String(e)
            });
            return;
        }
        if (changed.length === 0) {
            this.notifyBanner('info', 'notifReviewNoChanges');
            return;
        }
        const pickedFile = await vscode.window.showQuickPick(
            changed.map((f) => ({
                label: f.path,
                description: f.untracked
                    ? ui('reviewFileNew')
                    : f.binary
                        ? ui('reviewFileBinary')
                        : `+${f.added} \u2212${f.removed}`,
                file: f,
            })),
            { placeHolder: ui('reviewFilesPlaceholder') }
        );
        if (!pickedFile) return;
        const picked = pickedFile.file;
        if (picked.binary) {
            this.notifyBanner('info', 'notifReviewBinary', { file: picked.path });
            return;
        }
        let before = '';
        let after = '';
        try {
            if (picked.untracked) {
                // A new file may be an image - never feed NUL bytes to the
                // virtual-document diff. Binary detection reads only the head.
                const buf = await fs.promises.readFile(path.join(root, picked.path));
                if (buf.subarray(0, 8192).includes(0)) {
                    this.notifyBanner('info', 'notifReviewBinary', { file: picked.path });
                    return;
                }
                after = buf.toString('utf-8');
            } else {
                before = (await this._checkpoints.readCheckpointFile(root, sha, picked.path)) ?? '';
                after = await fs.promises.readFile(path.join(root, picked.path), 'utf-8');
            }
        } catch {
            // A file deleted since the checkpoint keeps its old side only.
            after = after || '';
        }
        if (Math.max(before.length, after.length) > REVIEW_MAX_CHARS) {
            this.notifyBanner('info', 'notifReviewTooLarge', { file: picked.path });
            return;
        }
        if (before === after) {
            this.notifyBanner('info', 'notifReviewNoHunks', { file: picked.path });
            return;
        }
        const hunks = hunkSummaries(before, after);
        if (hunks && hunks.length > 0) {
            const pickedHunk = await vscode.window.showQuickPick(
                hunks.map((h) => ({
                    label: `+${h.newStart} (+${h.added} \u2212${h.removed})`,
                    description: `@@ +${h.newStart},${h.newCount}`,
                    detail: h.sample,
                    hunk: h,
                })),
                { placeHolder: ui('reviewHunksPlaceholder') }
            );
            if (!pickedHunk) return;
            const h = pickedHunk.hunk;
            const end = Math.max(h.newStart, h.newStart + Math.max(h.newCount, 1) - 1);
            openEditDiff(this._virtualDocuments, picked.path, before, after, [h.newStart - 1, end - 1]);
            return;
        }
        // No hunk list: either the LCS budget refused (hunks === null) or the
        // sides differ in a way grouping could not express - show the file.
        if (!openEditDiff(this._virtualDocuments, picked.path, before, after)) {
            this.notifyBanner('info', 'notifReviewNoHunks', { file: picked.path });
        }
    }

    /** Restore to a specific turn's checkpoint (the restore icon on a user
     *  bubble). Confirms the scope first - files only, or files plus a
     *  conversation rewind to before that turn - then reuses the same shadow
     *  restore + ledger truncation as edit/resend. */
    async _restoreCheckpointAt(userIndex: number, sha: string): Promise<void> {
        if (!this._view) return;
        if (this._abortControllers.size > 0) {
            this.notifyBanner('warning', 'sessionSwitchBusy');
            return;
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.notifyBanner('error', 'notifNoFolder');
            return;
        }

        const choice = await this.confirmBanner(
            'checkpointScopeConfirm',
            ['checkpointScopeFiles', 'checkpointScopeFilesAndChat', 'notifCancel'],
        );
        if (choice !== 'checkpointScopeFiles' && choice !== 'checkpointScopeFilesAndChat') return;
        const rewindChat = choice === 'checkpointScopeFilesAndChat';

        // The confirm is non-blocking: a run may have started (or the history
        // changed) while it was open. Re-check before mutating anything.
        if (this._abortControllers.size > 0) {
            this.notifyBanner('warning', 'sessionSwitchBusy');
            return;
        }

        let emptySeed = false;
        try {
            const result = await this._checkpoints.restoreCheckpoint(folder.uri.fsPath, sha);
            if (result.changed) {
                this.notifyBanner('info', 'notifRestored', { sha: result.sha, safety: result.safety });
            }
        } catch (e) {
            // Empty seed = the workspace was empty at that turn's start.
            // Restoring TO the seed would wipe files created since, so skip
            // the file restore - but never silently.
            if (e instanceof EmptySeedError) {
                emptySeed = true;
            } else {
                this.notifyBanner('error', 'notifCpRestoreFailed', {
                    error: e instanceof Error ? e.message : String(e),
                });
                return;
            }
        }

        if (!rewindChat) {
            if (emptySeed) this.notifyBanner('info', 'checkpointEmptySeed');
            return;
        }

        // Re-resolve the turn: the index may be stale after the confirm.
        const targetIdx = this._findUserEntry(userIndex);
        if (targetIdx < 0) {
            this.notifyBanner('warning', 'checkpointTurnGone');
            return;
        }
        // Match _rewindAndResend: discard approval bookkeeping for the turns
        // being removed, or it can later close timeline items that are gone.
        this._approvalCloseItems = {};
        this._history = this._history.slice(0, targetIdx);
        this._truncateLocalHistoryAt(userIndex);
        this._dropOrphanedTaskListEdit();
        this._view.webview.postMessage({ type: 'truncateFromUser', userIndex });
        await this._persistLocalSession();
    }

    /** Read files via vscode.workspace.fs and hand them to the webview
     *  composer (explorer context menu + palette file dialog paths - the
     *  sidebar webview view cannot receive drag-and-drop, by VS Code design). */
    public async attachUrisPublic(uris: string[]): Promise<void> {
        await this.ensureView();
        await this._handleUriAttachments(uris);
    }

    /** Palette commands are useless before the panel exists - surface it. */
    public async ensureView(): Promise<void> {
        if (!this._view?.visible) {
            await vscode.commands.executeCommand(`${XratuChatViewProvider.viewType}.focus`);
            for (let i = 0; i < 20 && !this._view; i++) {
                await new Promise((r) => setTimeout(r, 50));
            }
        }
    }

    /** The agent loop runs in the extension - there is nothing to poll.
     *  Post 'connected' so the webview never sits on its 'disconnected'
     *  default (cloud-era connection-loss indicators are gone). */
    _startConnectionPolling() {
        this._view?.webview.postMessage({ type: 'connectionStatus', status: 'connected' });
    }

    async _showStartScreen() {
        if (!this._view) return;
        // The only gate: a saved credential. Returning users (or anyone who
        // just connected from the welcome screen) go straight to chat;
        // otherwise the welcome screen offers provider setup (Phase 3:
        // BYOK/local entry with auto-discovery, no accounts).
        const credentials = await this._getSavedCredentials();
        if (credentials.length === 0) {
            this._view.webview.postMessage({ type: 'showWelcome' });
            return;
        }
        await this._restoreLocalSession();
        this._restoreChatUI();
        // workspaceKind picks the empty-state suggestion set: the default chips
        // all assume an established project ("tour this codebase", "hunt for
        // bugs"), which is dead on arrival in a folder that has nothing in it.
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this._view.webview.postMessage({
            type: 'showChat',
            workspaceKind: root ? classifyWorkspace(root) : 'empty',
        });
        this._pushSessionState();
        void this._fetchModels();
    }

    /** Echo the active editor's file (workspace-relative) to the webview so
     *  suggestion-chip workflows can name the user's actual file. Null when
     *  no real file editor is active or it lives outside the workspace. */
    _pushEditorContext(): void {
        if (!this._view) return;
        const editor = vscode.window.activeTextEditor;
        let activeFile: string | null = null;
        if (editor && editor.document.uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
            activeFile = vscode.workspace.asRelativePath(editor.document.uri, false);
        }
        void this._view.webview.postMessage({ type: 'editorContext', activeFile });
    }

    /** Index of the userIndex-th user entry in _history, or -1. */
    private _findUserEntry(userIndex: number): number {
        let seen = -1;
        for (let i = 0; i < this._history.length; i++) {
            if (this._history[i].role === 'user') {
                seen++;
                if (seen === userIndex) return i;
            }
        }
        return -1;
    }

    /** Index of the userIndex-th user message in the local agent ledger, or -1
     *  when it is not present. Returns -2 when that turn's model context was
     *  EVICTED (see `_localEvictedUserTurns`): the caller must reset the model
     *  ledger instead of slicing by an ordinal that no longer lines up. */
    private _findLocalUserEntry(userIndex: number): number {
        const localUserIndex = userIndex - this._localEvictedUserTurns;
        if (localUserIndex < 0) return -2;
        let seen = -1;
        for (let i = 0; i < this._localHistory.length; i++) {
            if (this._localHistory[i].role === 'user') {
                seen++;
                if (seen === localUserIndex) return i;
            }
        }
        return -1;
    }

    /** Rewind the model ledger to just before the userIndex-th DISPLAYED turn.
     *  When that turn's context was evicted, the ledger is reset and the
     *  eviction offset is re-anchored to the new visible baseline (the display
     *  ledger still shows those turns, but the model no longer has them). */
    private _truncateLocalHistoryAt(userIndex: number): void {
        const localIdx = this._findLocalUserEntry(userIndex);
        if (localIdx === -2) {
            this._localHistory = [];
            this._localEvictedUserTurns = Math.max(0, userIndex);
            this._localReplayUserTurns = null;
            return;
        }
        if (localIdx >= 0) {
            this._localHistory = this._localHistory.slice(0, localIdx);
            // The user is deliberately going back: replay the retained turns so
            // the model sees what they are editing, even if the rolling summary
            // still covers some of them (a harmless duplicate beats a silent
            // omission).
            this._localReplayUserTurns = null;
        }
    }

    /** The model ledger is always a SUFFIX of the display turns (eviction only
     *  drops its oldest turns), so the eviction offset is derivable from the
     *  turn counts. Deriving it - rather than trusting a stored value - keeps
     *  rewind aligned after a reload even for snapshots written by older
     *  builds or hand-edited files. */
    private _deriveEvictedUserTurns(): void {
        this._localEvictedUserTurns = Math.max(
            0,
            countUserRows(this._history) - countUserRows(this._localHistory),
        );
    }

    /** Restore the compaction replay boundary from a snapshot. Stored as a
     *  SUFFIX count, so the snapshot's front-trim can only ever shrink it -
     *  clamp to the restored ledger and normalize "replay everything" to null. */
    private _restoreReplayBoundary(stored: number | null | undefined): void {
        const total = countUserRows(this._localHistory);
        this._localReplayUserTurns = stored == null
            ? null
            : Math.max(0, Math.min(stored, total));
        if (this._localReplayUserTurns != null && this._localReplayUserTurns >= total) {
            this._localReplayUserTurns = null;
        }
        this._compactionRunReplayBase = null;
    }

    /** Shared rewind primitive behind message edit and response regenerate:
     *  restore the turn's workspace checkpoint, truncate server history at
     *  the Nth user message, mirror the truncation in the webview, then
     *  re-send (edited text, or the original for regenerate). */
    /** A rewind (edit-resend / regenerate) truncates history for the SAME
     *  session id - drop the task-list edit override unless an
     *  update_task_list write survives in the remaining ledger, or the next
     *  request would echo a phantom checklist the model never saw. */
    private _dropOrphanedTaskListEdit(): void {
        if (!this._sessionId || !this._taskListEdits[this._sessionId]) return;
        for (const row of this._history) {
            if (row.role !== 'assistant' || !Array.isArray(row.events)) continue;
            if (row.events.some((ev) => ev?.type === 'tool_call' && ev.tool === TASK_LIST_TOOL_NAME)) return;
        }
        delete this._taskListEdits[this._sessionId];
        void this._saveTaskListEdits().catch((e) =>
            console.error('xratu: task list edit persist failed:', e));
    }

    async _rewindAndResend(userIndex: number, newText: string | null, attachments?: ComposerAttachment[]): Promise<void> {
        if (!this._view || this._abortControllers.size > 0) return;

        let targetIdx = this._findUserEntry(userIndex);
        const entry = targetIdx >= 0 ? this._history[targetIdx] : undefined;

        const text = (newText ?? entry?.content ?? '').trim();
        // Attachment-only edits are valid (the composer allows them) - the
        // warning fires only when there is nothing to resend at all.
        if (!text && !(attachments && attachments.length > 0)) {
            this.notifyBanner('warning', 'notifRewindNoText');
            return;
        }

        // 1. Workspace files back to this turn's pre-prompt state. Prefer
        // THIS turn's checkpoint; fall back to the newest one recorded before
        // it (restored-from-server sessions carry no per-turn shas). The
        // store safety-snapshots the CURRENT state either way.
        const folder = vscode.workspace.workspaceFolders?.[0];
        let baseSha = entry?.cp;
        if (folder && !baseSha && targetIdx > 0) {
            for (let i = targetIdx - 1; i >= 0; i--) {
                if (this._history[i].cp) { baseSha = this._history[i].cp; break; }
            }
        }
        if (folder && baseSha) {
            try {
                await this._checkpoints.restoreCheckpoint(folder.uri.fsPath, baseSha);
            } catch (e) {
                // Empty seed = the workspace was empty at this turn's start;
                // there is nothing meaningful to restore, so rewind the chat
                // history anyway instead of failing the edit. (Restoring TO
                // the seed would wipe files added since - skip it entirely.)
                if (e instanceof EmptySeedError) {
                    baseSha = undefined;
                } else {
                    this.notifyBanner('error', 'notifCpRestoreFailed', {
                        error: e instanceof Error ? e.message : String(e)
                    });
                    return;
                }
            }
        }
        // No checkpoint for this turn - only chat history rewinds; silent.

        // Rewind BOTH ledgers in place.
        this._approvalCloseItems = {};
        if (targetIdx >= 0) {
            this._history = this._history.slice(0, targetIdx);
        }
        this._truncateLocalHistoryAt(userIndex);
        this._dropOrphanedTaskListEdit();
        this._view.webview.postMessage({ type: 'truncateFromUser', userIndex });
        this._view.webview.postMessage({ type: 'restoreUser', value: text });
        await this._persistLocalSession();

        // Re-send through the normal chat path. Skip its pre-send capture:
        // after a restore the tree matches baseSha, so a fresh commit would
        // record the SAFETY snapshot (post-edit state) as this turn's
        // baseline and corrupt future rewinds.
        await this._handleChatRequest(text, attachments?.length ? attachments : undefined, { baseSha: folder && baseSha ? baseSha : undefined });
    }

    /** Saved provider credentials live in VS Code SecretStorage. The webview only
     * receives metadata + a masked key; the real API key never leaves the extension host.
     * Runtime collapse: every credential is an OpenAI-compatible endpoint - the
     * old `runtimeMode` discriminator is accepted on read and dropped. */
    private async _getSavedCredentials(): Promise<StoredCredential[]> {
        const raw = await this._secrets.get('xratu.llmCredentials');
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    return parsed
                        .filter((c) =>
                            c && typeof c.id === 'string' &&
                            typeof c.baseUrl === 'string' &&
                            typeof c.apiKey === 'string'
                        )
                        .map((c) => {
                            const storedId = typeof c.providerId === 'string' ? c.providerId : '';
                            const derivedId = this._providerIdForUrl(c.baseUrl);
                            // A stored id can be stale: an opencode.ai/zen/go URL
                            // saved before the Go preset existed carries
                            // 'opencode'. Trust the more specific derived id.
                            const providerId = storedId === 'opencode' && derivedId === 'opencode-go'
                                ? derivedId
                                : (storedId || derivedId);
                            const record: StoredCredential = {
                                id: c.id,
                                providerId,
                                baseUrl: c.baseUrl.trim(),
                                apiKey: c.apiKey,
                                label: typeof c.label === 'string' ? c.label : this._providerLabelForUrl(c.baseUrl),
                            };
                            // Only a record naming a REGISTERED provider counts
                            // as OAuth-backed: an unknown id (feature removed,
                            // older install) degrades to a keyless credential
                            // instead of a turn that throws at request time.
                            if (typeof c.oauthProviderId === 'string' && getOAuthProvider(c.oauthProviderId)) {
                                record.oauthProviderId = c.oauthProviderId;
                                if (typeof c.oauthStorageKey === 'string') record.oauthStorageKey = c.oauthStorageKey;
                            }
                            return record;
                        });
                }
            } catch { /* fall through to legacy migration */ }
        }

        // Migrate the pre-multi-provider single credential into the new vault once.
        const [apiKey, baseUrl] = await Promise.all([
            this._secrets.get('xratu.llmApiKey'),
            this._secrets.get('xratu.llmBaseUrl'),
        ]);
        if (!apiKey || !baseUrl) return [];

        const migrated = [{
            id: crypto.randomUUID(),
            providerId: this._providerIdForUrl(baseUrl),
            baseUrl: baseUrl.trim(),
            apiKey,
            label: this._providerLabelForUrl(baseUrl),
        }];
        await this._secrets.store('xratu.llmCredentials', JSON.stringify(migrated));
        await this._secrets.store('xratu.activeLlmCredentialId', migrated[0].id);
        return migrated;
    }

    /** Heuristic "on-machine runtime" check - see endpointGuard.ts. */
    private _isLikelyLocalUrl(baseUrl: string): boolean {
        return isLikelyLocalUrl(baseUrl);
    }

    /** "on-machine runtime" heuristic - see _isLikelyLocalUrl. */
    private _providerIdForUrl(baseUrl: string): string {
        return providerIdForUrl(baseUrl);
    }

    private _providerLabelForUrl(baseUrl: string): string {
        return providerLabelForUrl(baseUrl);
    }

    /** Sum two usage records (each field added when present). */
    private _addUsage(prev: LocalUsage | null, next: LocalUsage): LocalUsage {
        if (!prev) return { ...next };
        return {
            promptTokens: (prev.promptTokens ?? 0) + (next.promptTokens ?? 0),
            completionTokens: (prev.completionTokens ?? 0) + (next.completionTokens ?? 0),
            totalTokens: (prev.totalTokens ?? 0) + (next.totalTokens ?? 0),
            cachedTokens: (prev.cachedTokens ?? 0) + (next.cachedTokens ?? 0),
            cacheWriteTokens: (prev.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
        };
    }

    /** Per-model price overrides (may carry an explicit currency). */
    private _modelPriceOverrides(): Record<string, PriceOverride> {
        return vscode.workspace.getConfiguration('xratu')
            .get<Record<string, PriceOverride>>('modelPricing') ?? {};
    }

    /** Per-host gateway rates (Toman per USD + optional markup). */
    private _gatewayRates(): Record<string, GatewayRate> {
        return vscode.workspace.getConfiguration('xratu')
            .get<Record<string, GatewayRate>>('providerPricing') ?? {};
    }

    /** Pricing context for a provider base URL (host, Iranian flag, rates). */
    private _priceLookupFor(baseUrl: string, model?: string): PriceLookup {
        return this._priceLookupForHost(baseUrlHost(baseUrl), isIranianProvider(this._providerIdForUrl(baseUrl)), model);
    }

    /** Pricing context for an already-known host - the Usage page's rate sheet
     *  resolves models for hosts that may no longer be in saved credentials.
     *  A live provider-reported price from the host-scoped catalog is included
     *  when present. */
    private _priceLookupForHost(host: string | null, iranian: boolean, model?: string): PriceLookup {
        const rates = this._gatewayRates();
        const gatewayRate = host ? (rates[host] ?? rates[host.toLowerCase()] ?? null) : null;
        const fallback = Number(vscode.workspace.getConfiguration('xratu').get('tomanPerUsd')) || 0;
        const id = model ?? this._selectedModel ?? '';
        const meta = id ? cachedModelInfo(this._modelCatalog, host, id) : null;
        const providerPrice = meta?.pricing
            ? {
                input: meta.pricing.input,
                output: meta.pricing.output,
                ...(meta.pricing.cachedInput != null ? { cachedInput: meta.pricing.cachedInput } : {}),
                ...(meta.pricing.cachedInputWrite != null ? { cachedInputWrite: meta.pricing.cachedInputWrite } : {}),
            }
            : null;
        return { host, iranian, gatewayRate, fallbackRate: fallback > 0 ? fallback : null, providerPrice };
    }

    /** Cost of one usage record for the CURRENT run's provider, in the
     *  currency the price is quoted in (never converted). */
    private _costFor(usage: LocalUsage | null): { amount: number; currency: 'USD' | 'IRT' } | null {
        if (!usage || this._runSubscription) return null;
        const price = priceForModel(
            this._selectedModel ?? '',
            this._modelPriceOverrides(),
            this._priceLookupFor(this._runBaseUrl ?? ''),
        );
        if (!price) return null;
        const est = costForUsage(price, usage);
        return est ? { amount: est.amount, currency: est.currency } : null;
    }

    /** Cache the cost-display currency for a provider base URL. Called when a
     *  run starts AND when the active provider is resolved (model fetch), so a
     *  reopened Iranian session is not shown in USD after an extension
     *  reload. */
    private _setCostCurrencyFor(baseUrl: string): void {
        this._runBaseUrl = baseUrl;
        const lookup = this._priceLookupFor(baseUrl);
        // A resolved price knows its own currency - an explicit USD per-model
        // override on an Iranian provider must bill in USD, so it wins over the
        // provider's default ledger.
        const price = priceForModel(this._selectedModel ?? '', this._modelPriceOverrides(), lookup);
        if (price?.currency) {
            this._runCostCurrency = price.currency;
            return;
        }
        // Otherwise: Toman-billed when the provider is a known Iranian one, or
        // when a gateway rate is configured for its host.
        const hasGatewayRate = lookup.gatewayRate != null
            || (lookup.iranian && lookup.fallbackRate != null);
        this._runCostCurrency = lookup.iranian || hasGatewayRate ? 'IRT' : 'USD';
    }

    /** The session total in the run's currency, falling back to the other
     *  currency when this run's ledger has no spend yet (mixed sessions). */
    private _sessionCostForRun(): { amount: number; currency: 'USD' | 'IRT' } | null {
        const primary = this._sessionCost[this._runCostCurrency];
        if (primary > 0) return { amount: primary, currency: this._runCostCurrency };
        const other = this._runCostCurrency === 'USD' ? 'IRT' : 'USD';
        return this._sessionCost[other] > 0 ? { amount: this._sessionCost[other], currency: other } : null;
    }

    /** Estimated cost of one usage record, or null when the model's price is
     *  unknown (the UI then shows nothing rather than a wrong number). */
    private _localCostFor(usage: LocalUsage | null): { amount: number; currency: 'USD' | 'IRT' } | null {
        return this._costFor(usage);
    }

    /** Post the session's cumulative cost (monotonic - never reduced by a
     *  rewind or a checkpoint restore: the tokens were already spent). */
    private _postSessionCost(): void {
        this._view?.webview.postMessage({
            type: 'sessionCost',
            cost: this._sessionCostForRun(),
        });
    }

    /** Zero the session token ledgers (new session / cleared history). */
    private _resetSessionUsage(): void {
        this._sessionUsage = { input: 0, output: 0, cached: 0 };
        this._sessionUsageByHost = {};
    }

    /** Restore the persisted token ledgers from a session snapshot. */
    private _restoreSessionUsage(snapshot: {
        totalInputTokens?: number;
        totalOutputTokens?: number;
        totalCachedTokens?: number;
        usageByHost?: Record<string, { input?: number; output?: number; cached?: number }>;
    }): void {
        const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
        this._sessionUsage = {
            input: n(snapshot.totalInputTokens),
            output: n(snapshot.totalOutputTokens),
            cached: n(snapshot.totalCachedTokens),
        };
        const byHost: Record<string, { input: number; output: number; cached: number }> = {};
        for (const [host, u] of Object.entries(snapshot.usageByHost ?? {})) {
            if (!u) continue;
            const entry = { input: n(u.input), output: n(u.output), cached: n(u.cached) };
            if (entry.input || entry.output || entry.cached) byHost[host] = entry;
        }
        this._sessionUsageByHost = byHost;
    }

    /** Add one non-estimated round to the session token ledgers. */
    private _addSessionUsage(usage: LocalUsage): void {
        const prompt = usage.promptTokens ?? 0;
        const completion = usage.completionTokens ?? 0;
        const cached = usage.cachedTokens ?? 0;
        this._sessionUsage.input += prompt;
        this._sessionUsage.output += completion;
        this._sessionUsage.cached += cached;
        const host = baseUrlHost(this._runBaseUrl ?? '');
        if (!host) return;
        const entry = this._sessionUsageByHost[host] ?? { input: 0, output: 0, cached: 0 };
        entry.input += prompt;
        entry.output += completion;
        entry.cached += cached;
        this._sessionUsageByHost[host] = entry;
    }

    /** Append one round to the global usage ledger (best-effort: a failed
     *  append must never break the run). */
    private async _recordUsage(entry: UsageEntry): Promise<void> {
        try {
            await this._usageLedger.append(entry);
        } catch (e) {
            console.error('xratu: usage ledger append failed', e);
        }
    }

    /** Sync cost resolver for the ledger: host -> Iranian flag + gateway rate,
     *  built ONCE from the saved credentials + settings. */
    private async _ledgerCostResolver(): Promise<
        (entry: UsageEntry) => { amount: number; currency: 'USD' | 'IRT' } | null
    > {
        const credentials = await this._getSavedCredentials();
        const iranianHosts = new Set<string>();
        for (const c of credentials) {
            const host = baseUrlHost(c.baseUrl);
            if (host && isIranianProvider(c.providerId)) iranianHosts.add(host);
        }
        const rates = this._gatewayRates();
        const overrides = this._modelPriceOverrides();
        const fallback = Number(vscode.workspace.getConfiguration('xratu').get('tomanPerUsd')) || 0;
        return (entry) => {
            const host = entry.host;
            const meta = cachedModelInfo(this._modelCatalog, host, entry.model);
            const lookup: PriceLookup = {
                host,
                iranian: iranianHosts.has(host),
                gatewayRate: host ? (rates[host] ?? rates[host.toLowerCase()] ?? null) : null,
                fallbackRate: fallback > 0 ? fallback : null,
                providerPrice: meta?.pricing
                    ? {
                        input: meta.pricing.input,
                        output: meta.pricing.output,
                        ...(meta.pricing.cachedInput != null ? { cachedInput: meta.pricing.cachedInput } : {}),
                        ...(meta.pricing.cachedInputWrite != null ? { cachedInputWrite: meta.pricing.cachedInputWrite } : {}),
                    }
                    : null,
            };
            const price = priceForModel(entry.model, overrides, lookup);
            if (!price) return null;
            const est = costForUsage(price, {
                promptTokens: entry.input,
                completionTokens: entry.output,
                cachedTokens: entry.cached,
                cacheWriteTokens: entry.cacheWrite,
            });
            return est ? { amount: est.amount, currency: est.currency } : null;
        };
    }

    /** Re-derive the CURRENT session's ledgers from the usage ledger. Only
     *  done when the ledger actually holds this session's rounds: a session
     *  that predates the ledger keeps its snapshot totals (recomputing from an
     *  empty set would zero a real total). */
    /** Adopt the ledger's totals for this session. `before` is the same
     *  session's totals from the PRE-reprice ledger: when retention pruned
     *  older rounds, the retained sum is smaller than what the session already
     *  reported, and replacing the totals would silently shrink them. In that
     *  case only the reprice delta is applied and the snapshot's tokens, cost
     *  and per-host breakdown stay - the ledger can no longer reproduce them. */
    private async _syncSessionFromLedger(entries: readonly UsageEntry[], before?: UsageTotals): Promise<void> {
        if (!this._sessionId) return;
        const mine = entriesForSession(entries, this._sessionId);
        if (!mine.length) return;
        const totals = sumUsage(mine);
        const retained = totals.input + totals.output + totals.cached;
        const reported = this._sessionUsage.input + this._sessionUsage.output + this._sessionUsage.cached;
        if (before && retained < reported) {
            this._sessionCost = {
                USD: this._sessionCost.USD + (totals.USD - before.USD),
                IRT: this._sessionCost.IRT + (totals.IRT - before.IRT),
            };
            await this._persistLocalSession();
            this._postSessionCost();
            return;
        }
        this._sessionCost = { USD: totals.USD, IRT: totals.IRT };
        this._sessionUsage = { input: totals.input, output: totals.output, cached: totals.cached };
        const byHost: Record<string, { input: number; output: number; cached: number }> = {};
        for (const entry of mine) {
            if (!entry.host) continue;
            const bucket = byHost[entry.host] ?? { input: 0, output: 0, cached: 0 };
            bucket.input += entry.input;
            bucket.output += entry.output;
            bucket.cached += entry.cached;
            byHost[entry.host] = bucket;
        }
        this._sessionUsageByHost = byHost;
        await this._persistLocalSession();
        this._postSessionCost();
    }

    /** Re-price recorded usage after a price change, so PAST usage follows the
     *  new rate instead of being frozen at the old one. The read-modify-write
     *  runs inside the ledger's queue: reading here and replacing afterwards
     *  would drop a round appended in between. */
    private async _repriceLedger(onlyModel?: string): Promise<void> {
        const resolve = await this._ledgerCostResolver();
        const sessionId = this._sessionId;
        let before: UsageTotals | null = null;
        const { entries, changed } = await this._usageLedger.update((current) => {
            // Captured in the same critical section as the reprice, so the
            // delta below is measured against the entries actually replaced.
            before = sessionId ? sumUsage(entriesForSession(current, sessionId)) : null;
            return recomputeCosts(current, resolve, onlyModel);
        });
        if (!changed) return;
        await this._syncSessionFromLedger(entries, before ?? undefined);
    }

    /** Base URL of the active credential, or '' when none is selected. */
    private async _activeBaseUrl(): Promise<string> {
        const id = await this._resolveActiveCredentialId();
        const credentials = await this._getSavedCredentials();
        return credentials.find((c) => c.id === id)?.baseUrl ?? '';
    }

    /** Re-resolve the run's cost currency after a pricing edit and re-post the
     *  total, so a changed gateway rate is reflected without a new turn. */
    private async _refreshCostDisplay(): Promise<void> {
        this._setCostCurrencyFor(await this._activeBaseUrl());
        this._postSessionCost();
    }

    /** The Usage page's view: all-time per-provider usage, the sparse
     *  per-day/per-model cost series, and the effective rate per model. */
    async _sendUsageState(): Promise<void> {
        if (!this._view) return;
        const credentials = await this._getSavedCredentials();
        const byHost = new Map<string, { label: string; iranian: boolean }>();
        for (const c of credentials) {
            if (c.oauthProviderId && getOAuthProvider(c.oauthProviderId)?.subscription) continue;
            const host = baseUrlHost(c.baseUrl);
            if (host && !byHost.has(host)) {
                byHost.set(host, { label: c.label || c.baseUrl, iranian: isIranianProvider(c.providerId) });
            }
        }

        const ledger = await this._usageLedger.read();
        const apiLedger = ledger.filter((entry) => entry.billing !== 'chatgpt-plan');
        const planLedger = ledger.filter((entry) => entry.billing === 'chatgpt-plan');
        const cutoff = Date.now() - 30 * 86_400_000;
        const recentPlan = planLedger.filter((entry) => entry.ts >= cutoff);
        const providers = totalsByHost(apiLedger).map((t) => ({
            host: t.host,
            label: byHost.get(t.host)?.label ?? (t.host || '—'),
            iranian: byHost.get(t.host)?.iranian ?? false,
            input: t.input,
            output: t.output,
            cached: t.cached,
            USD: t.USD,
            IRT: t.IRT,
        }));

        this._view.webview.postMessage({
            type: 'usageState',
            providers,
            rates: this._modelRates(apiLedger, byHost),
            // Sparse per-day/per-model/per-host cells: the chart's month,
            // model and provider filters all run in the webview.
            history: aggregateByDayAndModel(apiLedger, USAGE_CHART_DAYS),
            allTime: sumUsage(apiLedger),
            chatgpt: {
                totals: sumUsage(recentPlan),
                models: modelHosts(recentPlan).map(({ model, tokens }) => ({ model, tokens })),
                hasHistory: planLedger.length > 0,
            },
        });
        await this._sendOAuthState();
    }

    /**
     * The effective rate for every model that was actually used, plus one row
     * per override whose model has not been used. An override applies to a
     * model across providers, so it collapses to a single host-less row;
     * everything else is resolved per host (a gateway rate is per host, so the
     * same model can legitimately carry different rates). Busiest first.
     */
    private _modelRates(
        ledger: readonly UsageEntry[],
        byHost: Map<string, { label: string; iranian: boolean }>,
    ): UsageRateRow[] {
        const overrides = this._modelPriceOverrides();
        const pairs = modelHosts(ledger);
        // Keyed by the lowercased id: an override is stored lowercased, so a
        // mixed-case model id from the ledger must still match its own row.
        const totalsByModel = modelTotals(pairs);

        const rows: Array<{ row: UsageRateRow; tokens: number }> = [];
        const overridden = new Set<string>();
        for (const [id, override] of Object.entries(overrides)) {
            if (!override || (override.input == null && override.output == null)) continue;
            const key = id.trim().toLowerCase();
            if (!key) continue;
            overridden.add(key);
            const totals = totalsByModel.get(key);
            rows.push({
                tokens: totals?.tokens ?? 0,
                row: {
                    id,
                    // Host-independent: the override wins on every provider.
                    host: '',
                    input: Number(override.input) || 0,
                    output: Number(override.output) || 0,
                    cachedInput: override.cachedInput != null ? Number(override.cachedInput) : null,
                    currency: override.currency === 'IRT' ? 'IRT' : 'USD',
                    source: 'override',
                    USD: totals?.USD ?? 0,
                    IRT: totals?.IRT ?? 0,
                },
            });
        }

        for (const pair of pairs) {
            const key = pair.model.trim().toLowerCase();
            if (overridden.has(key)) continue;
            const lookup = this._priceLookupForHost(pair.host, byHost.get(pair.host)?.iranian ?? false, pair.model);
            const resolved = resolvePrice(pair.model, overrides, lookup);
            rows.push({
                tokens: pair.tokens,
                row: {
                    id: pair.model,
                    host: pair.host,
                    input: resolved?.price.input ?? 0,
                    output: resolved?.price.output ?? 0,
                    cachedInput: resolved?.price.cachedInput ?? null,
                    currency: resolved?.price.currency ?? (lookup.iranian ? 'IRT' : 'USD'),
                    source: !resolved
                        ? 'unknown'
                        : resolved.source === 'override'
                            ? 'override'
                            : resolved.source === 'provider'
                                ? 'provider'
                                : resolved.source === 'gateway' || resolved.source === 'toman-table'
                                    ? 'gateway'
                                    : 'builtin',
                    USD: pair.USD,
                    IRT: pair.IRT,
                },
            });
        }

        return rows
            .sort((a, b) => b.tokens - a.tokens || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0))
            .map((r) => r.row);
    }

    /** Run a pricing read-modify-write on a single serialized queue. */
    private _queuePricingWrite(task: () => Promise<void>): Promise<void> {
        const run = this._pricingWrite.then(task, task);
        // Keep the chain alive even if a task rejects.
        this._pricingWrite = run.catch(() => undefined);
        return run;
    }

    /** Write a per-model price override (in the given currency). */
    async _saveModelPricing(
        id: string,
        input: number,
        output: number,
        cachedInput?: number | null,
        currency?: 'USD' | 'IRT',
    ): Promise<void> {
        const key = id.trim().toLowerCase();
        if (!key) return;
        const inputValue = Number(input);
        const outputValue = Number(output);
        if (!Number.isFinite(inputValue) || !Number.isFinite(outputValue) || inputValue < 0 || outputValue < 0) return;
        // A blank cached field means "not specified", NOT "free": coercing it
        // to 0 would bill every cached token at zero. `null` has to survive
        // until the override is built, so the rate falls back to `input`.
        const cachedValue = cachedInput == null ? null : Number(cachedInput);
        await this._queuePricingWrite(async () => {
            const overrides: Record<string, PriceOverride> = { ...this._modelPriceOverrides() };
            overrides[key] = {
                input: inputValue,
                output: outputValue,
                ...(cachedValue != null && Number.isFinite(cachedValue) && cachedValue >= 0 ? { cachedInput: cachedValue } : {}),
                ...(currency === 'IRT' ? { currency: 'IRT' as const } : {}),
            };
            await vscode.workspace.getConfiguration('xratu')
                .update('modelPricing', overrides, vscode.ConfigurationTarget.Global);
        });
        // Past usage follows the new price, then the page is refreshed.
        await this._repriceLedger(key);
        await this._sendUsageState();
        await this._refreshCostDisplay();
    }

    async _removeModelPricing(id: string): Promise<void> {
        const key = id.trim().toLowerCase();
        let removed = false;
        await this._queuePricingWrite(async () => {
            const overrides: Record<string, PriceOverride> = { ...this._modelPriceOverrides() };
            if (!(key in overrides)) return;
            delete overrides[key];
            removed = true;
            await vscode.workspace.getConfiguration('xratu')
                .update('modelPricing', overrides, vscode.ConfigurationTarget.Global);
        });
        if (!removed) return;
        await this._repriceLedger(key);
        await this._sendUsageState();
        await this._refreshCostDisplay();
    }

    // --- OAuth credentials ------------------------------------------------
    // The token set lives in its OWN secret per provider, never inside the
    // credential vault: `apiKey` stays a string on every record (the reader
    // filters on it and every older version expects it), so an OAuth
    // connection carries `''` there and a real key here. Deleting the OAuth
    // feature therefore cannot strand a record the vault cannot parse.

    private _oauthTokenStore(): OAuthTokenStore {
        return {
            read: async (storageKey) => {
                const raw = await this._secrets.get(`xratu.oauthTokens.${storageKey}`);
                if (!raw) return null;
                try {
                    const parsed = JSON.parse(raw) as OAuthTokenSet;
                    return parsed && typeof parsed.accessToken === 'string' ? parsed : null;
                } catch {
                    return null;
                }
            },
            write: async (storageKey, tokens) => {
                const key = `xratu.oauthTokens.${storageKey}`;
                if (tokens === null) {
                    await this._secrets.delete(key);
                    return;
                }
                await this._secrets.store(key, JSON.stringify(tokens));
            },
        };
    }

    private _oauthTokenManager(): OAuthTokenManager {
        return this._oauthManager ??= new OAuthTokenManager({
            store: this._oauthTokenStore(),
            // Locks live beside the other per-window state: one directory per
            // storage key, shared by every window on this machine (the
            // refresh rotation race is cross-PROCESS, not cross-tab).
            lockDir: path.join(this._storagePath, 'oauth-locks'),
        });
    }

    /** One context for every OAuth network call: proxyFetch is the only
     *  egress that honours a configured proxy dispatcher, and a token request
     *  that bypasses it fails for exactly the users who need OAuth most. */
    private _oauthContext(signal?: AbortSignal): OAuthLoginContext {
        return {
            fetch: ((input, init) => {
                const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
                return proxyFetch(input, { ...init, dispatcher: getProxyDispatcher(url) });
            }) as typeof fetch,
            signal,
        };
    }

    /** Resolve what a request needs from a credential: the bearer value plus
     *  any provider routing headers. This is the ONLY async seam - everything
     *  downstream (header builders, wire adapters) keeps receiving a plain
     *  string, so OAuth costs one await per turn, not per request. */
    private async _resolveCredentialAuth(active: StoredCredential, signal?: AbortSignal): Promise<{
        apiKey: string | null;
        headers?: Record<string, string>;
        apiStyle?: 'chat' | 'messages' | 'responses' | 'google';
        subscription?: boolean;
        tokens?: OAuthTokenSet;
        onUnauthorized?: () => Promise<string | null>;
    }> {
        if (!active.oauthProviderId) {
            return { apiKey: active.apiKey || null };
        }
        const provider = getOAuthProvider(active.oauthProviderId);
        const handler = provider ? { ...provider, storageKey: active.oauthStorageKey ?? provider.storageKey } : undefined;
        // A record whose provider vanished (older install, half-removed
        // feature) degrades to "no key" instead of throwing at turn start.
        if (!handler) return { apiKey: null };
        if (handler.subscription && !active.oauthStorageKey) throw new OAuthFlowError('reauth_required', 'Legacy ChatGPT connection needs sign-in');
        const manager = this._oauthTokenManager();
        const ctx = this._oauthContext(signal);
        const tokens = await manager.resolveTokens(handler, ctx);
        if (handler.subscription && !chatGptPlanEnabled(tokens)) throw new OAuthFlowError('plan_permission_missing', 'ChatGPT plan permission was not granted');
        return {
            apiKey: tokens.accessToken,
            headers: handler.headers?.(tokens),
            apiStyle: handler.apiStyle,
            subscription: handler.subscription,
            tokens,
            // The 401 retry: force ONE refresh, replay the round. Never a
            // loop - a second 401 is a real rejection, not a stale token.
            onUnauthorized: async () => {
                try {
                    const next = await manager.forceRefreshTokens(handler, this._oauthContext(signal));
                    if (handler.subscription && !chatGptPlanEnabled(next)) return null;
                    return next.accessToken;
                } catch {
                    return null;
                }
            },
        };
    }

    /** Sign out: revoke server-side (best effort), clear the token, drop the
     *  credential record. Idempotent. */
    async _oauthSignOut(credentialId: string): Promise<void> {
        const credentials = await this._getSavedCredentials();
        const target = credentials.find((c) => c.id === credentialId);
        if (!target?.oauthProviderId) return;
        const provider = getOAuthProvider(target.oauthProviderId);
        let revoked = true;
        if (provider) {
            const handler = { ...provider, storageKey: target.oauthStorageKey ?? (provider.subscription ? 'openai-codex' : provider.storageKey) };
            if (this._globalState.get<string>('xratu.activeLlmCredentialId') === credentialId) this._abortControllers.get('chat')?.abort();
            if (this._oauthFlow?.providerId === provider.providerId) this._cancelOAuthFlow();
            await this._oauthTokenManager().withTokenLock(handler, async () => {
                const store = this._oauthTokenStore();
                const tokens = await store.read(handler.storageKey);
                if (tokens) {
                    try { await handler.revoke?.(tokens, this._oauthContext(AbortSignal.timeout(60_000))); }
                    catch { revoked = false; }
                }
                await store.write(handler.storageKey, null);
                await this._oauthTokenManager().withTokenLock({ ...handler, storageKey: 'oauth-credential-vault' },
                    () => this._deleteLlmCredential(credentialId, true, false));
            });
        } else {
            await this._deleteLlmCredential(credentialId, true, false);
        }
        await this._fetchModels();
        await this._sendSavedCredentials();
        await this._sendOAuthState();
        if (!revoked) this._postOAuthState({ error: { valueKey: 'oauthRevocationUnconfirmed' } });
        this._view?.webview.postMessage({ type: 'credentialsSaved' });
    }

    /** Post a PATCH of the OAuth status; the webview always receives the whole
     *  picture. A partial post would make the page drop the connected-account
     *  list every time a flow reports progress. `null`/`undefined` clears a
     *  key rather than storing an empty value, so a stale device code cannot
     *  outlive its flow. */
    private _postOAuthState(patch: Record<string, unknown>): void {
        const next: Record<string, unknown> = { ...this._oauthState };
        for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === undefined) delete next[key];
            else next[key] = value;
        }
        this._oauthState = next;
        this._view?.webview.postMessage({ type: 'oauthState', state: next as never });
    }

    /** Push the authoritative OAuth status: which providers exist, which are
     *  connected (with the account), and whether a flow is in progress. */
    private async _sendOAuthState(): Promise<void> {
        const credentials = await this._getSavedCredentials();
        const store = this._oauthTokenStore();
        const accounts: Array<{ providerId: string; credentialId: string; accountLabel?: string; accountId?: string; planEnabled?: boolean; active?: boolean }> = [];
        for (const credential of credentials) {
            if (!credential.oauthProviderId) continue;
            const handler = getOAuthProvider(credential.oauthProviderId);
            if (!handler) continue;
            const tokens = await store.read(credential.oauthStorageKey ?? handler.storageKey);
            if (!tokens) continue;
            accounts.push({
                providerId: handler.providerId,
                credentialId: credential.id,
                accountLabel: tokens.email ?? tokens.accountLabel,
                accountId: tokens.accountId,
                active: this._globalState.get<string>('xratu.activeLlmCredentialId') === credential.id,
                planEnabled: handler.subscription ? chatGptPlanEnabled(tokens) : true,
            });
        }
        this._postOAuthState({
            providers: listOAuthProviders().map((h) => ({
                providerId: h.providerId,
                label: h.label ?? this._providerLabelForUrl(h.canonicalBaseUrl),
                methods: h.methods,
            })),
            accounts,
            registrations: Object.entries(this._globalState.get<Record<string, { clientId: string; subject: string; email?: string }>>('xratu.oauthRegistrations') ?? {})
                .map(([credentialId, r]) => ({ providerId: 'chatgpt-codex', credentialId, label: r.email ?? '' })),
            inProgress: this._oauthFlow ? { providerId: this._oauthFlow.providerId, method: this._oauthFlow.method } : null,
            // The device code belongs to the flow that asked for it.
            deviceCode: this._oauthFlow?.method === 'device' ? this._oauthState.deviceCode : null,
            authorizeUrl: this._oauthFlow?.method === 'browser' ? this._oauthState.authorizeUrl : null,
        });
    }

    /**
     * Drive one sign-in flow. The HOST owns the transport - it is the only
     * place with a browser launcher, a socket, and an abort controller - and
     * the handler supplies the protocol pieces.
     *
     * Browser flow: PKCE authorize URL -> system browser -> loopback callback,
     * with a manual-code race so a user who cannot reach 127.0.0.1 (SSH,
     * container, occupied port) is never stuck.
     * Device flow: no local server at all - the only transport that works in
     * remote VS Code and behind a filtering network.
     */
    async _startOAuthSignIn(providerId: string, method: 'browser' | 'device' = 'browser', credentialId?: string): Promise<void> {
        const handler = getOAuthProvider(providerId);
        if (!handler || !(handler.methods ?? ['browser']).includes(method)) {
            this._postOAuthState({ error: { valueKey: 'oauthUnavailable' }, inProgress: null });
            return;
        }
        if (this._oauthFlow) this._cancelOAuthFlow();

        const controller = new AbortController();
        const flow: OAuthFlowState = { providerId, method, controller, manualCode: createManualCodeSlot() };
        this._oauthFlow = flow;
        this._postOAuthState({ inProgress: { providerId, method }, error: null, authorizeUrl: null, deviceCode: null });

        try {
            const hostId = await this._oauthTokenManager().withTokenLock({ ...handler, storageKey: 'oauth-host-id' }, async () => {
                let value = await this._secrets.get('xratu.oauthHostId');
                if (!value) {
                    value = this._globalState.get<string>('xratu.oauthHostId') ?? `urn:uuid:${crypto.randomUUID()}`;
                    await this._secrets.store('xratu.oauthHostId', value);
                }
                return value;
            }, controller.signal);
            const registrations = this._globalState.get<Record<string, { clientId: string; subject: string; email?: string }>>('xratu.oauthRegistrations') ?? {};
            const registration = credentialId ? registrations[credentialId] : undefined;
            const credentials = await this._getSavedCredentials();
            const selected = credentials.find((c) => c.id === credentialId);
            const previous = selected ? await this._oauthTokenStore().read(selected.oauthStorageKey ?? handler.storageKey) : null;
            this._assertOAuthFlow(flow);
            const tokens = await handler.login({ ...this._oauthContext(controller.signal), hostId, method,
                openExternal: async (url) => {
                    this._assertOAuthFlow(flow);
                    await abortable(Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))), controller.signal);
                    this._assertOAuthFlow(flow);
                },
                registration: registration ? { ...registration, idToken: previous?.idToken } : undefined,
                authorize: (options) => this._runBrowserSignIn(flow, options),
                onEvent: (event) => {
                    this._assertOAuthFlow(flow);
                    if (event.type === 'device-code') this._postOAuthState({ deviceCode: event });
                },
            });
            this._assertOAuthFlow(flow);
            await this._oauthCompleteSignIn(handler, tokens, flow);
        } catch (error) {
            if (this._oauthFlow === flow) {
                this._postOAuthState({ error: { valueKey: oauthErrorValueKey(error) }, inProgress: null });
            }
        } finally {
            if (this._oauthFlow === flow) {
                this._oauthFlow = null;
                await this._sendOAuthState();
            }
        }
    }

    private _assertOAuthFlow(flow: OAuthFlowState): void {
        if (this._oauthFlow !== flow || flow.controller.signal.aborted) throw new OAuthCancelledError();
    }

    private async _runBrowserSignIn(flow: OAuthFlowState, options: OAuthAuthorization): Promise<OAuthCallback> {
        const signal = flow.controller.signal;
        const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
        let server: LoopbackServer | undefined;
        try {
            try {
                server = await startLoopbackServer({
                    candidatePorts: [1455, 1457, 0], callbackPath: '/auth/callback',
                    expectedState: options.expectedState, timeoutMs,
                    successHtml: '<!doctype html><meta charset="utf-8"><p>' + ui('oauthCallbackDone') + '</p>',
                    errorHtml: '<!doctype html><meta charset="utf-8"><p>' + ui('oauthCallbackFailed') + '</p>',
                });
                flow.server = server;
            } catch (error) {
                this._assertOAuthFlow(flow);
                if (!(error instanceof OAuthFlowError) || error.code !== 'ports_busy') throw error;
                this._postOAuthState({ error: { valueKey: 'oauthPortsBusy' } });
            }
            this._assertOAuthFlow(flow);
            const redirectUri = server?.redirectUri ?? 'http://127.0.0.1:1455/auth/callback';
            const authorizeUrl = options.buildUrl(redirectUri);
            const safeUrl = new URL(authorizeUrl);
            safeUrl.searchParams.delete('id_token_hint');
            this._postOAuthState({ authorizeUrl: safeUrl.toString() });
            // The visible link also lets the user continue when the launcher
            // throws or returns false; the pending callback remains usable.
            try { await abortable(Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(authorizeUrl))), deadline); }
            catch { deadline.throwIfAborted(); /* manual browser link remains available */ }
            this._assertOAuthFlow(flow);
            const manual = flow.manualCode.promise.then((input): OAuthCallback => {
                this._assertOAuthFlow(flow);
                let url: URL;
                try { url = new URL(input); }
                catch { throw new OAuthFlowError('bad_response', 'Paste the complete callback URL'); }
                if (url.origin !== new URL(redirectUri).origin || url.pathname !== '/auth/callback'
                    || url.searchParams.get('state') !== options.expectedState) {
                    throw new OAuthFlowError('state_mismatch', 'Invalid manual callback');
                }
                const error = url.searchParams.get('error');
                if (error) throw new OAuthFlowError(error, 'Authorization declined');
                const code = url.searchParams.get('code');
                if (!code) throw new OAuthFlowError('no_code', 'No authorization code received');
                return { code, state: options.expectedState, clientId: url.searchParams.get('client_id') ?? undefined, redirectUri };
            });
            const callback = await abortable(Promise.race([
                ...(server ? [server.waitForCallback().then((result) => ({ ...result, redirectUri }))] : []), manual,
            ]), deadline);
            this._assertOAuthFlow(flow);
            return callback;
        } finally {
            server?.dispose();
            if (flow.server === server) flow.server = undefined;
        }
    }

    /** Accept a hand-pasted redirect code: the escape hatch when the loopback
     *  callback cannot complete (port taken by another process, remote
     *  window, browser on another machine). */
    async _submitOAuthManualCode(input: string): Promise<void> {
        const flow = this._oauthFlow;
        if (!flow) {
            this._postOAuthState({ error: { valueKey: 'oauthNoFlow' } });
            return;
        }
        const code = input.trim();
        if (!code) {
            this._postOAuthState({ error: { valueKey: 'oauthCodeEmpty' } });
            return;
        }
        flow.manualCode.submit(code);
    }

    async _cancelOAuthSignIn(): Promise<void> {
        if (!this._oauthFlow) return;
        this._cancelOAuthFlow();
        this._postOAuthState({ inProgress: null });
        await this._sendOAuthState();
    }

    private _cancelOAuthFlow(): void {
        const flow = this._oauthFlow;
        if (!flow) return;
        this._oauthFlow = null;
        flow.controller.abort();
        // Release the paste slot too: a flow that is gone must not leave a
        // pending promise holding its caller.
        flow.manualCode.release();
        flow.server?.cancel();
        flow.server?.dispose();
    }

    private async _oauthCompleteSignIn(handler: OAuthProviderHandler, tokens: OAuthTokenSet, flow: OAuthFlowState): Promise<void> {
        const storageKey = handler.subscription ? chatGptStorageKey(tokens) : handler.storageKey;
        let record!: StoredCredential;
        await this._oauthTokenManager().withTokenLock({ ...handler, storageKey }, async () => {
            this._assertOAuthFlow(flow);
            await this._oauthTokenManager().withTokenLock({ ...handler, storageKey: 'oauth-credential-vault' }, async () => {
                const credentials = await this._getSavedCredentials();
                const registrations = this._globalState.get<Record<string, { clientId: string; subject: string; email?: string }>>('xratu.oauthRegistrations') ?? {};
                const existing = credentials.find((c) => c.oauthStorageKey === storageKey);
                const registrationId = Object.keys(registrations).find((id) => registrations[id].clientId === tokens.clientId && registrations[id].subject === tokens.subject);
                record = {
                    id: existing?.id ?? registrationId ?? crypto.randomUUID(), providerId: handler.providerId,
                    baseUrl: handler.canonicalBaseUrl, apiKey: '', label: tokens.accountLabel ?? handler.label ?? handler.providerId,
                    oauthProviderId: handler.providerId, oauthStorageKey: storageKey,
                };
                await this._oauthTokenStore().write(storageKey, tokens);
                if (tokens.clientId && tokens.subject) {
                    registrations[record.id] = { clientId: tokens.clientId, subject: tokens.subject, email: tokens.email };
                    await this._globalState.update('xratu.oauthRegistrations', registrations);
                }
                await this._persistSavedCredentials([...credentials.filter((c) => c.id !== record.id), record]);
                await this._globalState.update('xratu.activeLlmCredentialId', record.id);
                await this._secrets.store('xratu.llmBaseUrl', record.baseUrl);
            }, flow.controller.signal);
        }, flow.controller.signal);
        await this._fetchModels();
        await this._sendSavedCredentials();
    }

    private _maskApiKey(apiKey: string): string {
        if (apiKey.length <= 8) return '••••••••';
        return `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`;
    }

    private async _persistSavedCredentials(credentials: StoredCredential[]): Promise<void> {
        await this._secrets.store('xratu.llmCredentials', JSON.stringify(credentials));
    }

    private async _getLlmCredentials(): Promise<{
        llm_api_key?: string;
        llm_base_url?: string;
        extra_headers?: Record<string, string>;
        discoverModels?: () => Promise<{ models: import('./local/localTypes').LocalModelInfo[] }>;
    }> {
        const credentials = await this._getSavedCredentials();
        if (!credentials.length) return {};
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId');
        // '' is an EXPLICIT "no credential selected" (user deselected / fell
        // back to free) - only a missing id falls back to the first entry.
        if (activeId === '') return {};
        const active = credentials.find((c) => c.id === activeId) ?? credentials[0];
        if (active.id !== activeId) await this._globalState.update('xratu.activeLlmCredentialId', active.id);
        // An OAuth credential has no static key to hand the prober, and its
        // routing headers are part of auth: resolve them here or model
        // discovery 401s while the credential itself is perfectly usable.
        if (active.oauthProviderId) {
            try {
                const auth = await this._resolveCredentialAuth(active);
                const handler = getOAuthProvider(active.oauthProviderId)!;
                const tokens = auth.tokens;
                return { llm_api_key: auth.apiKey ?? undefined, llm_base_url: active.baseUrl, extra_headers: auth.headers,
                    discoverModels: handler.discoverModels && tokens ? () => handler.discoverModels!(this._oauthContext(), tokens) : undefined };
            } catch {
                // A dead/rejected token must not turn model listing into an
                // error toast; the turn path surfaces the re-auth requirement.
                return {};
            }
        }
        return { llm_api_key: active.apiKey, llm_base_url: active.baseUrl };
    }

    private async _sendSavedCredentials(): Promise<void> {
        if (!this._view) return;
        const credentials = await this._getSavedCredentials();
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId') ?? credentials[0]?.id ?? null;
        this._view.webview.postMessage({
            type: 'savedCredentials',
            credentials: credentials.map((c) => ({
                id: c.id,
                providerId: c.providerId,
                baseUrl: c.baseUrl,
                maskedKey: this._maskApiKey(c.apiKey),
                label: c.label,
                active: c.id === activeId,
                // Presence only - the webview renders a sign-out button for an
                // OAuth connection, it never learns a token's contents.
                oauth: !!c.oauthProviderId,
            })),
        });
    }

    async _setLlmCredentials(reason?: string, openCard?: 'byok' | 'local'): Promise<void> {
        const credentials = await this._getSavedCredentials();
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId') ?? credentials[0]?.id ?? null;
        const active = credentials.find((c) => c.id === activeId);
        this._view?.webview.postMessage({
            type: 'openCredentials',
            reason,
            currentUrl: active?.baseUrl ?? '',
            activeCredentialId: activeId,
            openCard,
        });
        await this._sendSavedCredentials();
        // The page renders OAuth state on entry; without this push it would
        // show no providers until the first flow reported something.
        await this._sendOAuthState();
    }

    async _saveLlmCredentials(base_url: string, api_key: string, returnToChat = false): Promise<void> {
        if (!base_url) {
            this._view?.webview.postMessage({ type: 'byokCredentialError', valueKey: 'credUrlRequired' });
            return;
        }
        // Local runtimes (Ollama, LM Studio, etc.) usually don't need an API key.
        const cleanUrl = base_url.trim().replace(/\/$/, '');
        const credentials = await this._getSavedCredentials();
        // A keyless connect to a URL that already has a saved credential
        // reuses the stored key: discovery probes saved custom endpoints
        // WITH their key, so the one-click connect must not fail key
        // validation or create a duplicate empty-key entry.
        if (!api_key) {
            const existingForUrl = credentials.find((c) => c.baseUrl.replace(/\/$/, '') === cleanUrl && c.apiKey);
            if (existingForUrl) api_key = existingForUrl.apiKey;
        }
        const isLocal = this._isLikelyLocalUrl(cleanUrl);
        if (!api_key && !isLocal) {
            this._view?.webview.postMessage({ type: 'byokCredentialError', valueKey: 'credUrlKeyRequired' });
            return;
        }
        const insecureError = insecureRemoteHttpError(cleanUrl, api_key);
        if (insecureError) {
            this._view?.webview.postMessage({ type: 'byokCredentialError', valueKey: insecureError });
            return;
        }
        const providerId = this._providerIdForUrl(cleanUrl);
        const label = this._providerLabelForUrl(cleanUrl);
        // Updating the same key replaces its existing entry; a different key
        // at the same provider remains a separate saved connection.
        const existing = credentials.find((c) =>
            c.baseUrl.replace(/\/$/, '') === cleanUrl && c.apiKey === api_key
        );
        const id = existing?.id ?? crypto.randomUUID();
        const next = credentials.filter((c) => c.id !== id);
        next.push({ id, providerId, baseUrl: cleanUrl, apiKey: api_key, label });

        await this._persistSavedCredentials(next);
        await this._globalState.update('xratu.activeLlmCredentialId', id);

        // Keep legacy slots synchronized for older Xratu code/data.
        await this._secrets.store('xratu.llmBaseUrl', cleanUrl);
        await this._secrets.store('xratu.llmApiKey', api_key);

        await this._fetchModels();
        await this._sendSavedCredentials();

        this._view?.webview.postMessage({
            type: 'credentialsSaved',
            returnToChat,
        });
    }

    async _selectLlmCredential(id: string): Promise<void> {
        const credentials = await this._getSavedCredentials();
        if (!credentials.some((c) => c.id === id)) return;
        const currentId = this._globalState.get<string>('xratu.activeLlmCredentialId');
        if (currentId === id) {
            // Toggle OFF: clicking the active credential deselects it - the
            // user's explicit "no credential" gesture. Model listing drops
            // to the empty setup state until a provider is re-selected.
            await this._globalState.update('xratu.activeLlmCredentialId', '');
            this._selectedModel = null;
            await this._fetchModels();
            await this._sendSavedCredentials();
            await this._sendOAuthState();
            this._view?.webview.postMessage({ type: 'credentialsSaved' });
            return;
        }
        await this._globalState.update('xratu.activeLlmCredentialId', id);
        await this._fetchModels();
        await this._sendSavedCredentials();
        await this._sendOAuthState();
        this._view?.webview.postMessage({ type: 'credentialsSaved' });
    }

    /** Replace the stored API key of a saved connection. Only the webview's
     *  NEW key travels here - the old key never leaves the host. */
    async _updateLlmCredential(id: string, api_key: string): Promise<void> {
        const key = api_key.trim();
        if (!key) return;
        const credentials = await this._getSavedCredentials();
        const target = credentials.find((c) => c.id === id);
        if (!target) return;
        target.apiKey = key;
        await this._persistSavedCredentials(credentials);
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId');
        if (activeId === id) {
            // The active connection's legacy slot mirrors its key.
            await this._secrets.store('xratu.llmApiKey', key);
            await this._fetchModels();
        }
        await this._sendSavedCredentials();
        this._view?.webview.postMessage({ type: 'credentialsSaved' });
    }

    async _deleteLlmCredential(id: string, oauthCleared = false, refresh = true): Promise<void> {
        const credentials = await this._getSavedCredentials();
        const target = credentials.find((c) => c.id === id);
        if (target?.oauthProviderId && !oauthCleared) return this._oauthSignOut(id);
        const next = credentials.filter((c) => c.id !== id);
        if (next.length === credentials.length) return;

        // A deleted connection takes its remembered model with it - otherwise
        // a stale selection lingers in the picker (re-surfaced by the legacy
        // fallback in _fetchModels) with no provider behind it.
        await this._forgetCredentialModel(id);
        await this._persistSavedCredentials(next);
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId');
        if (activeId === id) {
            const nextActive = next[0]?.id ?? null;
            if (nextActive) await this._globalState.update('xratu.activeLlmCredentialId', nextActive);
            else await this._globalState.update('xratu.activeLlmCredentialId', '');
        }
        if (!next.length) {
            await this._secrets.delete('xratu.llmApiKey');
            await this._secrets.delete('xratu.llmBaseUrl');
            // Last credential gone: clear the legacy model secret and the
            // in-memory selection too, or the picker keeps showing a model
            // that belongs to a connection that no longer exists.
            await this._secrets.delete('xratu.selectedModel');
            this._selectedModel = null;
        } else {
            const active = next.find((c) => c.id === this._globalState.get<string>('xratu.activeLlmCredentialId')) ?? next[0];
            await this._secrets.store('xratu.llmApiKey', active.apiKey);
            await this._secrets.store('xratu.llmBaseUrl', active.baseUrl);
            await this._globalState.update('xratu.activeLlmCredentialId', active.id);
        }
        if (refresh) {
            await this._fetchModels();
            await this._sendSavedCredentials();
        }
    }

    // --- Per-credential model memory -------------------------------------
    // Switching back to a saved connection restores the last model selected
    // under it. Keyed by credential id (not provider id: two saved keys at
    // the same provider are separate connections with separate model lists).

    private _credentialModelMap(): Record<string, string> {
        try {
            const raw = this._globalState.get<string>('xratu.modelsByCredential');
            const parsed = raw ? JSON.parse(raw) : {};
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                ? parsed : {};
        } catch {
            return {};
        }
    }

    private async _resolveActiveCredentialId(): Promise<string | null> {
        const credentials = await this._getSavedCredentials();
        if (!credentials.length) return null;
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId');
        if (activeId === '') return null;
        const active = credentials.find((c) => c.id === activeId) ?? credentials[0];
        return active.id;
    }

    async _rememberModelForActiveCredential(model: string | null): Promise<void> {
        if (!model) return;
        const credId = await this._resolveActiveCredentialId();
        if (!credId) return;
        const map = this._credentialModelMap();
        if (map[credId] === model) return;
        map[credId] = model;
        await this._globalState.update('xratu.modelsByCredential', JSON.stringify(map));
    }

    /** Drop a deleted credential's remembered model so it can't resurface. */
    private async _forgetCredentialModel(credId: string): Promise<void> {
        const map = this._credentialModelMap();
        if (!(credId in map)) return;
        delete map[credId];
        await this._globalState.update('xratu.modelsByCredential', JSON.stringify(map));
    }

    private async _modelForActiveCredential(): Promise<string | null> {
        const credId = await this._resolveActiveCredentialId();
        if (!credId) return null;
        return this._credentialModelMap()[credId] ?? null;
    }

    // --- Runtime selection (free vs BYOK) --------------------------------
    // Free = the free tier: the client sends NO key. BYOK = the user's own
    // key. The choice persists in globalState, never in the secret store.

    /** Per-runtime model memory: the free runtime remembers its own selection
     *  (a single opaque id) separately from every BYOK credential's map. */
    private async _freeSelectedModel(): Promise<string | null> {
        return this._globalState.get<string>('xratu.freeSelectedModel') ?? null;
    }

    private async _rememberFreeModel(model: string): Promise<void> {
        await this._globalState.update('xratu.freeSelectedModel', model);
    }

    // --- Context-window knowledge (BYOK) --------------------------------
    // Layered resolver: the user's explicit per-model override wins, then
    // provider-reported/snapshot entries from the served table. The winning
    // value is echoed per request so the run uses a known window.
    // budgets with exactly what the pill shows.

    private _contextWindowOverrides(): Record<string, number> {
        try {
            const raw = this._globalState.get<string>('xratu.contextWindowOverrides');
            const parsed = raw ? JSON.parse(raw) : {};
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                ? parsed : {};
        } catch {
            return {};
        }
    }

    async _setContextWindowOverride(model: string, window: number | null): Promise<void> {
        if (!model) return;
        const map = this._contextWindowOverrides();
        if (typeof window === 'number' && window >= 1024 && Number.isFinite(window)) {
            map[model] = Math.floor(window);
        } else {
            delete map[model];
        }
        await this._globalState.update('xratu.contextWindowOverrides', JSON.stringify(map));
    }

    /** Best-known window for the model about to run: explicit override, else
     *  the longest matching provider-reported entry for this host, else the
     *  curated knowledge table. Undefined when nothing is known. `model`
     *  defaults to the selected one; a subagent that names its own model must
     *  be sized by ITS window, not the parent's. */
    private _contextWindowHint(model?: string | null): number | undefined {
        model = model || this._selectedModel;
        if (!model) return undefined;
        const override = this._contextWindowOverrides()[model];
        if (typeof override === 'number' && override >= 1024) return override;
        const lowered = model.toLowerCase();
        const table = this._contextWindowsFor(baseUrlHost(this._runBaseUrl ?? ''));
        let best: { len: number; win: number } | null = null;
        for (const [needle, win] of Object.entries(table)) {
            if (lowered.includes(needle.toLowerCase()) && (!best || needle.length > best.len)) {
                best = { len: needle.length, win };
            }
        }
        if (best) return best.win;
        // models.dev's exact per-model window beats the curated family fallback
        // (and a stale catalog cache persisted by an older version).
        const baseUrl = this._runBaseUrl ?? '';
        const modelsDev = modelsDevModelInfo(this._modelsDevCatalog, providerIdForUrl(baseUrl), model)?.contextWindow;
        if (typeof modelsDev === 'number' && modelsDev >= 1024) return modelsDev;
        // Exact metadata for THIS model - provider-reported, else models.dev,
        // else curated - beats the curated family fallback below.
        const exact = cachedModelInfo(this._modelCatalog, baseUrlHost(baseUrl), model)?.contextWindow;
        if (typeof exact === 'number' && exact >= 1024) return exact;
        return knownContextWindow(model);
    }

    // --- Thinking-level (reasoning effort) selection ----------------------
    // Per-model, client-held like the context-window overrides: the level is
    // echoed per request. Null/absent = Default - the runtime's own default
    // applies unchanged.

    private _thinkingLevels(): Record<string, ThinkingLevel> {
        try {
            const raw = this._globalState.get<string>('xratu.thinkingLevels');
            const parsed = raw ? JSON.parse(raw) : {};
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
            const clean: Record<string, ThinkingLevel> = {};
            for (const [model, level] of Object.entries(parsed)) {
                if (typeof level === 'string' && THINKING_LEVEL_SET.has(level)) {
                    clean[model] = level as ThinkingLevel;
                }
            }
            return clean;
        } catch {
            return {};
        }
    }

    /** Level selected for the model about to run; undefined = Default. */
    private _thinkingLevelHint(model: string | null | undefined): ThinkingLevel | undefined {
        if (!model) return undefined;
        return this._thinkingLevels()[model];
    }

    /** The effort to actually send: the user's variant, unless the provider
     *  authoritatively told us the model accepts no reasoning parameter, or
     *  reported a variant set that does not include the chosen one (a stale
     *  selection from before the model list changed) - sending either only
     *  yields a 400 we would then have to strip. */
    private _reasoningEffortFor(model: string, baseUrl: string): ThinkingLevel | undefined {
        return this._thinkingEffortFor(this._thinkingLevelHint(model), model, baseUrl);
    }

    /** Model ids the active provider has told us about (empty when nothing has
     *  been discovered yet - callers must treat empty as "don't judge"). Used
     *  to warn about an agent file naming a model this provider does not list. */
    private _knownModelIds(baseUrl: string): Set<string> {
        const entry = catalogEntryFor(this._modelCatalog, baseUrlHost(baseUrl), Date.now());
        return new Set((entry?.models ?? []).map((m) => m.id));
    }

    /** An EXPLICIT thinking level (an agent file's `reasoning_effort:`) rather
     *  than the per-model user selection, with the same provider guards: an
     *  unknown level, a model that takes no reasoning parameter, or a level
     *  this model does not advertise all send nothing rather than a 400. */
    private _thinkingEffortFor(
        level: string | undefined,
        model: string,
        baseUrl: string,
    ): ThinkingLevel | undefined {
        if (!level || !THINKING_LEVEL_SET.has(level)) return undefined;
        const meta = cachedModelInfo(this._modelCatalog, baseUrlHost(baseUrl), model);
        if (meta?.supportsReasoning === false) return undefined;
        if (meta?.reasoningLevels?.length && !meta.reasoningLevels.includes(level as ThinkingLevel)) return undefined;
        return level as ThinkingLevel;
    }

    /** Provider/curated max output for the model, when known. The runtime
     *  lowers its context-derived cap to this so a provider with a smaller
     *  output limit is not sent a cap it will reject. */
    private _maxOutputLimitFor(model: string, baseUrl: string): number | undefined {
        const meta = cachedModelInfo(this._modelCatalog, baseUrlHost(baseUrl), model);
        const limit = meta?.maxOutputTokens ?? knownMaxOutputTokens(model);
        return typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;
    }

    async _setThinkingLevel(model: string, level: ThinkingLevel | null): Promise<void> {
        if (!model) return;
        const map = this._thinkingLevels();
        if (level && THINKING_LEVEL_SET.has(level)) {
            map[model] = level;
        } else {
            delete map[model];
        }
        await this._globalState.update('xratu.thinkingLevels', JSON.stringify(map));
    }

    // ---------------------------------------------------------------------------
    // Local runtime detection
    // ---------------------------------------------------------------------------

    /** Whether the active credential runs through the in-extension agent
     *  loop. Phase 1 runtime collapse: there is exactly ONE runtime - the
     *  local OpenAI-compatible loop - and every credential (remote BYOK or
     *  on-machine) runs through it, so this is trivially true. Kept as a
     *  function so the deletion pass can sweep its call sites mechanically. */
    private async _isLocalRuntime(): Promise<boolean> {
        return true;
    }

    /** Effective reply language: explicit user choice, else derived from the
     *  UI locale (fa UI -> Persian replies). 'auto' is stored explicitly and
     *  means "follow the user's message language" (no prompt block). */
    _resolveReplyLanguage(): 'fa' | 'en' | 'auto' {
        const stored = this._globalState.get<string>('xratu.replyLanguage');
        if (stored === 'fa' || stored === 'en' || stored === 'auto') return stored;
        return this._globalState.get<string>('xratu.locale') === 'en' ? 'en' : 'fa';
    }

    /** Build the system prompt for local mode. The persona base is the
     *  canonical prompt bundled in systemPrompt.ts - the runtime is fully
     *  local, so the prompt travels with the extension. Only the
     *  local-operational notes and static context are appended here. */
    private _buildLocalSystemPrompt(rulesContext: string, sessionSummary: string | null, planMode: boolean, workspaceRoot: string): string {
        const replyLanguage = this._resolveReplyLanguage();
        return buildLocalSystemPrompt({
            rulesContext,
            sessionSummary,
            planMode,
            evictedUserTurns: this._localEvictedUserTurns,
            replyLanguage,
            // fa replies preload the natural-farsi skill body so the writing
            // rules hold from the first token - the model otherwise drifts to
            // written Persian (را، همان، میدهد) in longer outputs. Resolved
            // per run like the skill tool itself (project copies win, a
            // disabled skill injects nothing).
            farsiSkill: replyLanguage === 'fa' ? this._loadFarsiSkillBody(workspaceRoot) : undefined,
        });
    }

    /** Body of the winning `natural-farsi` skill copy (discovery priority:
     *  project overrides before global, user-disabled skills inject nothing),
     *  or undefined when the skill is missing/unreadable. */
    private _loadFarsiSkillBody(workspaceRoot: string): string | undefined {
        try {
            const resolution = resolveSkillForRun(
                workspaceRoot || undefined,
                'natural-farsi',
                new Set(this._disabledSkillIds()),
            );
            if (resolution.status !== 'ok') return undefined;
            return readSkillBody(resolution.skill.dirPath) ?? undefined;
        } catch {
            return undefined;
        }
    }

    /** Project rules for the run, resolved ONCE per session so the system
     *  prompt stays byte-stable across turns (see `RulesSnapshot`). Recomputing
     *  them per turn from the active editor's directory chain rewrote the
     *  cacheable prefix whenever a nested AGENTS.md was crossed, dropping the
     *  session cache rate under 50%. */
    private _localRulesContext(): Promise<string> {
        // Key on the SAME root `collectProjectRules()` resolves from - the
        // active editor's workspace folder, else the first workspace folder -
        // so switching workspace folders (multi-root) recomputes, while moving
        // between files inside one root does not.
        const editor = vscode.window.activeTextEditor;
        const folder = (editor && editor.document.uri.scheme === 'file'
            ? vscode.workspace.getWorkspaceFolder(editor.document.uri)
            : undefined) ?? vscode.workspace.workspaceFolders?.[0];
        const root = folder?.uri.fsPath ?? '';
        return this._localRulesSnapshot.resolve(root, () => collectProjectRules());
    }

    /** Convert extension history to local agent message format (no image base64).
     *  Normalizes the message shape for strict OpenAI-compatible servers (LM
     *  Studio et al.): assistant content must be a STRING (never undefined -
     *  a dropped key is rejected with "Invalid 'content': content field must
     *  be a string or an array of objects") and tool_calls must carry
     *  `function.arguments`. The normalizer also repairs turns persisted by
     *  older builds that stored the `argumentsJson` key or dropped content. */
    private _buildLocalHistory(): Array<import('./local/localAgent').LocalAgentMessage> {
        // Skip turns already folded into the rolling compaction summary (they
        // live in the system prompt instead). The rows stay in `_localHistory`
        // for display/rewind; only the REPLAYED history starts after them.
        const total = countUserRows(this._localHistory);
        const replay = this._localReplayUserTurns == null
            ? total
            : Math.max(0, Math.min(this._localReplayUserTurns, total));
        return buildReplayHistory(skipLeadingUserTurns(this._localHistory, total - replay));
    }

    /** Append to the model ledger with the in-memory content cap applied.
     *  Every write to `_localHistory` goes through here so a huge tool result
     *  (terminal output is capped at 200k chars, expansion at 120k) or a huge
     *  tool-call argument (an edit patch) cannot sit in memory at full size for
     *  the life of the session. */
    private _pushLocalHistory(row: LocalSessionHistoryMessage): void {
        // Scale the per-message cap to the run's window: the fixed 40k-char cap
        // (~13k tokens) silently discarded ~80% of a legitimate 200k-char tool
        // result even at 11% window fill on a 1M window, which the user sees as
        // context loss. Never tighter than before, generous when there is room.
        //
        // `providerBlocks`/`reasoningContent` are deliberately NOT clipped: the
        // bytes must match what the provider cached, and an Anthropic thinking
        // signature that is truncated is rejected outright. A pathologically
        // large (or aggregate-over-budget) carrier is DROPPED instead, via
        // `serializedWithinCap` here and `boundCarriers` in `_trimLocalHistory`,
        // so the in-memory ledger and the on-disk snapshot agree.
        const cap = contentCapForWindow(this._contextWindowHint());
        const { providerBlocks, reasoningContent, ...rest } = row;
        this._localHistory.push({
            ...rest,
            ...(typeof row.content === 'string' && row.content.length > cap
                ? { content: clipHistoryContent(row.content, cap) }
                : {}),
            ...(Array.isArray(row.tool_calls) && row.tool_calls.length
                ? { tool_calls: row.tool_calls.map((tc) => this._clipToolCall(tc, cap)) }
                : {}),
            ...(providerBlocks && serializedWithinCap(providerBlocks) ? { providerBlocks } : {}),
            ...(typeof reasoningContent === 'string' && serializedWithinCap(reasoningContent)
                ? { reasoningContent }
                : {}),
        });
    }

    /** Clip one tool call's `function.arguments` string. Kept valid JSON - the
     *  ledger is replayed to the provider, which rejects malformed arguments. */
    private _clipToolCall(tc: any, cap: number = IN_MEMORY_CONTENT_CAP): any {
        const args = tc?.function?.arguments;
        if (typeof args !== 'string' || args.length <= cap) return tc;
        return { ...tc, function: { ...tc.function, arguments: clipToolCallArguments(args, cap) } };
    }

    /** Drop the oldest complete turns from the model ledger past the cap, and
     *  enforce the aggregate provider-carrier budget (a turn-count cap does not
     *  bound carriers - one turn can run unbounded rounds). Carriers are dropped
     *  from the OLDEST rows, keeping the newest reasoning whole.
     *
     *  Only `_localHistory` is evicted - the display ledger stays complete, and
     *  the offset is tracked so a displayed userIndex still resolves to the
     *  right row (see `_findLocalUserEntry`). */
    private _trimLocalHistory(): void {
        const { rows, evicted } = evictOldestTurns(this._localHistory, MAX_IN_MEMORY_TURNS);
        this._localHistory = boundCarriers(rows);
        if (evicted) {
            this._localEvictedUserTurns += evicted;
            // Eviction drops from the FRONT, which only eats the already-
            // skipped prefix first; the replay suffix shrinks only once that
            // prefix is exhausted.
            const total = countUserRows(this._localHistory);
            if (this._localReplayUserTurns != null) {
                this._localReplayUserTurns = Math.min(this._localReplayUserTurns, total);
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Local approval coordinator
    // ---------------------------------------------------------------------------

    /** Request approval from the user for local tool calls. Returns decisions.
     *  The pending promise is tracked so a cancel can reject it - otherwise
     *  the suspended local agent generator would hang forever.
     *  Calls whose kind was allowed for this session resolve silently; only
     *  the remainder reach the approval card. */
    private _requestLocalApproval(approvalId: string, approvals: Array<{ tool_call_id: string; tool_name: string; args: Record<string, unknown> }>): Promise<Record<string, boolean>> {
        const preDecided: Record<string, boolean> = {};
        const pending = approvals.filter((a) => {
            if (isSessionApproved(a.tool_name, a.args, this._sessionApprovedKinds)) {
                preDecided[a.tool_call_id] = true;
                return false;
            }
            return true;
        });
        if (pending.length === 0) return Promise.resolve(preDecided);
        return new Promise((resolve, reject) => {
            this._localApprovalResolvers[approvalId] = {
                resolve: (decisions) => resolve({ ...preDecided, ...decisions }),
                reject,
            };
            // The webview renders ONE approval card at a time: a second
            // concurrent needsApproval post would replace the first and
            // orphan its promise (parallel subagents request approvals at the
            // same time). Resolvers all register immediately - a cancel still
            // rejects queued cards - but each card is presented only when the
            // previous one has settled.
            this._approvalCardChain = this._approvalCardChain.then(() => new Promise<void>((release) => {
                if (!this._localApprovalResolvers[approvalId]) {
                    release();
                    return;
                }
                this._approvalCardRelease.set(approvalId, release);
                void this._processNeedsApproval({
                    approval_id: approvalId,
                    approvals: pending.map((a) => ({
                        tool_call_id: a.tool_call_id,
                        tool_name: a.tool_name,
                        args: a.args,
                    })),
                    auto: [],
                });
            }));
        });
    }

    /** Free the single approval-card slot after a decision or cancel. */
    private _releaseApprovalCard(approvalId: string): void {
        const release = this._approvalCardRelease.get(approvalId);
        if (release) {
            this._approvalCardRelease.delete(approvalId);
            release();
        }
    }

    /** Resolve a local approval from the UI decision. */
    private _resolveLocalApproval(approvalId: string, decisions: Record<string, boolean>): void {
        const resolver = this._localApprovalResolvers[approvalId];
        if (resolver) {
            delete this._localApprovalResolvers[approvalId];
            resolver.resolve(decisions);
        }
        this._releaseApprovalCard(approvalId);
    }

    /** Reject every pending local approval. Used on cancel/logout: the local
     *  agent generator is suspended awaiting the decision and must resume
     *  (with an AbortError) instead of waiting on a user who has moved on. */
    private _rejectPendingLocalApprovals(): void {
        for (const [approvalId, resolver] of Object.entries(this._localApprovalResolvers)) {
            delete this._localApprovalResolvers[approvalId];
            const err = new Error('Request cancelled while waiting for approval');
            err.name = 'AbortError';
            resolver.reject(err);
            this._view?.webview.postMessage({ type: 'approvalResolved', approval_id: approvalId, resolution: 'rejected' });
            this._releaseApprovalCard(approvalId);
        }
    }

    /** Park an `ask_user_question` decision until the webview answers. The
     *  pending promise is tracked so a cancel can reject it - the tool call
     *  is suspended on it inside the agent loop. Cards are presented one at
     *  a time, mirroring the approval-card chain. */
    private _requestLocalDecision(question: UserQuestion): Promise<UserQuestionOutcome> {
        return new Promise((resolve, reject) => {
            const decisionId = `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            this._localDecisionResolvers.set(decisionId, { resolve, reject, question });
            this._decisionCardChain = this._decisionCardChain.then(() => new Promise<void>((release) => {
                if (!this._localDecisionResolvers.has(decisionId)) {
                    release();
                    return;
                }
                this._decisionCardRelease.set(decisionId, release);
                this._view?.webview.postMessage({
                    type: 'decisionRequest',
                    decision_id: decisionId,
                    header: question.header,
                    question: question.question,
                    options: question.options,
                });
            }));
        });
    }

    /** Free the single decision-card slot after an answer or cancel. */
    private _releaseDecisionCard(decisionId: string): void {
        const release = this._decisionCardRelease.get(decisionId);
        if (release) {
            this._decisionCardRelease.delete(decisionId);
            release();
        }
    }

    /** Turn a webview `decisionResponse` into a user question outcome. A label
     *  that matches one of the card's options resolves as that option (its
     *  description rides back to the model); anything else is the card's
     *  free-text answer. */
    _handleToolDecision(decisionId: string, answer: string | null | undefined, dismissed: boolean): void {
        const entry = this._localDecisionResolvers.get(decisionId);
        if (!entry) return;
        const trimmed = typeof answer === 'string' ? answer.trim() : '';
        if (dismissed || !trimmed) {
            this._resolveLocalDecision(decisionId, { kind: 'dismissed' });
            return;
        }
        const match = entry.question.options.find((o) => o.label === trimmed);
        this._resolveLocalDecision(decisionId, match
            ? { kind: 'selected', label: match.label, description: match.description }
            : { kind: 'custom', text: trimmed });
    }

    /** Resolve a pending decision from the UI (or a cancel). `outcome` is
     *  also echoed back as `decisionResolved` so the card settles into its
     *  answered state even when the user never saw the answer leave. */
    private _resolveLocalDecision(decisionId: string, outcome: UserQuestionOutcome): void {
        const resolver = this._localDecisionResolvers.get(decisionId);
        if (resolver) {
            this._localDecisionResolvers.delete(decisionId);
            resolver.resolve(outcome);
        }
        this._view?.webview.postMessage({
            type: 'decisionResolved',
            decision_id: decisionId,
            answer: outcome.kind === 'dismissed' ? null : outcome.kind === 'selected' ? outcome.label : outcome.text,
        });
        this._releaseDecisionCard(decisionId);
    }

    /** Reject every pending decision. Used on cancel/logout: the ask_user_question
     *  call is suspended awaiting the card and must resume (with an AbortError)
     *  instead of waiting on a user who has moved on. */
    private _rejectPendingLocalDecisions(): void {
        for (const [decisionId, resolver] of [...this._localDecisionResolvers]) {
            this._localDecisionResolvers.delete(decisionId);
            const err = new Error('Request cancelled while waiting for the user');
            err.name = 'AbortError';
            resolver.reject(err);
            this._view?.webview.postMessage({ type: 'decisionResolved', decision_id: decisionId, answer: null });
            this._releaseDecisionCard(decisionId);
        }
    }

    /** Public: whether the active credential is a local runtime. */
    public async isLocalMode(): Promise<boolean> {
        return this._isLocalRuntime();
    }

    /** Public: discover reachable local runtimes. */
    public async discoverLocalModels(signal?: AbortSignal): Promise<DiscoveredLocalModel[]> {
        const discovered = await discoverLocalRuntimes(signal);
        // Also probe saved custom credentials - after the runtime collapse
        // every credential is an OpenAI-compatible endpoint worth probing.
        // Stored URLs are not revalidated at load, so the cleartext-key guard
        // applies here too: skip credentials that would leak their key over
        // remote HTTP (the credentials page blocks saving new ones).
        const credentials = await this._getSavedCredentials();
        const modelsDev = credentials.some((c) => modelsDevProviderKey(providerIdForUrl(c.baseUrl)))
            ? await this._ensureModelsDevCatalog()
            : null;
        for (const cred of credentials) {
            if (cred.providerId === 'custom') {
                if (insecureRemoteHttpError(cred.baseUrl, cred.apiKey)) continue;
                const probed = await probeCustomEndpoint(cred.baseUrl, signal, cred.apiKey, getProxyDispatcher(cred.baseUrl), modelsDev);
                if (probed) {
                    discovered.push(probed);
                }
            }
        }
        return discovered;
    }

    /** Public: check if the selected model likely supports vision. */
    public isLocalModelVisionCapable(): boolean {
        if (!this._selectedModel) return false;
        return modelIsLikelyVision(this._selectedModel);
    }

    /** Public: check if the selected model likely supports function calling. */
    public isLocalModelToolCapable(): boolean {
        if (!this._selectedModel) return true;
        return modelLikelySupportsTools(this._selectedModel);
    }

    // ---------------------------------------------------------------------------
    // Local agent runner
    // ---------------------------------------------------------------------------

    /** Webview steered a live local run: process the payload through the
     *  SAME attachment pipeline as a normal send (ref resolution,
     *  validation, PDF extraction) and queue it for the loop's next round
     *  boundary. With no live run (race: the turn settled first) it
     *  degrades to an ordinary send. */
    async _handleSteer(value: string, attachments?: ComposerAttachment[], steerId?: string): Promise<void> {
        const text = value.trim();
        if (!text && !(attachments && attachments.length > 0)) {
            this._confirmSteer(steerId, 'drop');
            return;
        }
        // The webview holds the steer bubble until we confirm injection; a
        // rejection below must release it (the composerError carries the id).
        if (!this._localRunActive) {
            // Race: the run already settled. Degrade to an ordinary turn - the
            // webview rendered nothing yet, so confirm first (mode 'turn').
            this._confirmSteer(steerId, 'turn');
            void this._handleChatRequest(text, attachments);
            return;
        }
        // Identity of the run this steer is AIMED at - captured before any
        // await. Attachment processing (reference resolution, PDF text
        // extraction) can take seconds; if the targeted run settles in that
        // window, queueing would land the steer in the SHARED queue where an
        // unrelated next run drains it. Re-check on append instead. A session
        // switch (epoch bump - clearHistory/openSession) invalidates the
        // steer outright: its webview bubbles no longer exist to match.
        const turnToken = this._localTurnToken;
        const sessionEpochAtEntry = this._sessionEpoch;
        const refError = await resolveReferenceAttachments(attachments);
        if (refError) {
            this._view?.webview.postMessage({ type: 'composerError', value: '', valueKey: refError.key, params: refError.params, ...(steerId ? { steerId } : {}) });
            return;
        }
        const attachValidationError = validateHostAttachments(attachments);
        if (attachValidationError) {
            this._view?.webview.postMessage({ type: 'composerError', value: '', valueKey: attachValidationError.key, params: attachValidationError.params, ...(steerId ? { steerId } : {}) });
            return;
        }
        const pdfExtraction = await extractPdfAttachments(attachments ?? []);
        if (pdfExtraction.error) {
            this._view?.webview.postMessage({ type: 'composerError', value: '', valueKey: pdfExtraction.error.key, params: pdfExtraction.error.params, ...(steerId ? { steerId } : {}) });
            return;
        }
        const sendAttachments = pdfExtraction.attachments;
        if (this._sessionEpoch !== sessionEpochAtEntry) {
            // The session this steer belonged to was cleared/switched while
            // attachments were processed - drop it; its bubbles are gone and
            // queueing would corrupt the fresh session.
            this._confirmSteer(steerId, 'drop');
            return;
        }
        if (!this._localRunActive || this._localTurnToken !== turnToken) {
            // The targeted run settled while attachments were processed - the
            // webview held the bubble, so confirm it as a plain turn (its own
            // user row keeps the ledgers aligned) and run it standalone.
            this._confirmSteer(steerId, 'turn');
            void this._handleChatRequest(text, sendAttachments);
            return;
        }
        const images = sendAttachments
            ?.filter((a) => isImageAttachment(a.mimeType))
            .map((a) => ({ name: a.name, mimeType: a.mimeType, dataBase64: a.dataBase64 }));
        this._localSteerQueue.push({
            text: buildLocalUserText(text, sendAttachments),
            ...(images?.length ? { images } : {}),
            ...(sendAttachments?.length ? {
                meta: sendAttachments.map((a) => ({ name: a.name, mime_type: a.mimeType, size: a.size })),
                // Follow-up-turn carry: images only - text attachments are
                // already fenced into `text` and must not be duplicated.
                carryAttachments: sendAttachments
                    .filter((a) => isImageAttachment(a.mimeType))
                    .map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, dataBase64: a.dataBase64 })),
            } : {}),
            ...(steerId ? { steerId } : {}),
        });
    }

    /** Confirm a pending steer bubble to the webview. Only steers that came
     *  through `steerRun` carry an id; askQuestion-routed ones already
     *  rendered their own user row. */
    _confirmSteer(steerId: string | undefined, mode: 'steer' | 'turn' | 'drop' = 'steer'): void {
        if (!steerId) return;
        this._view?.webview.postMessage({ type: 'steerApplied', steerId, mode });
    }

    /**
     * The user pressed "run in background" on a running command row.
     *
     * The turn is released and the process lives on: `moveToBackground` settles
     * the tool call's `released` promise, which is what unblocks the agent
     * loop. No approval is re-requested - this is a scope REDUCTION (the
     * command was already approved and is already running), and asking again
     * would train the user to click through dialogs for a strictly safer state.
     */
    _backgroundTerminalCall(callId: string | undefined): void {
        const job = getJobByCallId(callId);
        if (!job) {
            // The command may have finished (or been killed) between the row
            // rendering and the click. Say so instead of silently doing nothing.
            this.notifyBanner('info', 'notifBackgroundJobGone');
            return;
        }
        if (!job.moveToBackground(true)) {
            // Two different failures share this return: the command already
            // exited, or it is ALREADY background (the model backgrounded it
            // and the button press raced the echo). Saying "no longer running"
            // about a live background job is simply wrong.
            this.notifyBanner(job.status === 'running' ? 'info' : 'warning',
                job.status === 'running' ? 'notifBackgroundAlreadyRunning' : 'notifBackgroundJobGone');
            return;
        }
        this._view?.webview.postMessage({
            type: 'terminalBackgrounded',
            callId: job.callId,
            jobId: job.id,
            byUser: true,
        });
        this._postBackgroundJobs();
    }

    /** Stop a background job from the UI. */
    async _killBackgroundJob(jobId: string): Promise<void> {
        const job = getTerminalJob(jobId);
        if (!job || job.status !== 'running') {
            this._postBackgroundJobs();
            return;
        }
        job.kill('stopped from the chat panel');
        await job.finished;
        this._view?.webview.postMessage({ type: 'backgroundJobStopped', jobId });
        this._postBackgroundJobs();
    }

    /** Push the live job list the composer badge renders. */
    private _postBackgroundJobs(): void {
        this._view?.webview.postMessage({
            type: 'backgroundJobs',
            jobs: listTerminalJobs()
                .filter((j) => j.background)
                .map((j) => ({
                    jobId: j.id,
                    command: j.command,
                    running: j.status === 'running',
                    uptimeSeconds: j.uptimeSeconds(),
                })),
        });
    }

    /**
     * A background job reached a terminal state.
     *
     * Delivered on the steer rail so it joins the conversation at a round
     * boundary (after tool results, before the next model request) rather than
     * being spliced between a tool result and an assistant message - splicing
     * would break message-role alternation and invalidate the prompt cache.
     *
     * When no run is live the report is HELD rather than turned into a turn of
     * its own: the user did not ask anything, and waking the agent to announce
     * a dev server exiting spends their tokens without being asked.
     */
    private _handleJobEvent(event: JobEvent): void {
        if (event.kind === 'started') {
            // Mark the row so it swaps its "run in background" button for a
            // stop control, and refresh the composer badge. Without this a
            // model-started job is invisible outside its own tool result.
            this._view?.webview.postMessage({
                type: 'terminalBackgrounded',
                callId: event.callId,
                jobId: event.jobId,
                byUser: event.byUser,
            });
            this._postBackgroundJobs();
            return;
        }
        const notice = event.notice;
        const text = formatJobCompletion(notice);
        if (this._localRunActive) {
            this._localSteerQueue.push({ text, system: true });
        } else {
            this._pendingJobNotices.push(text);
            // Bounded: each notice carries a job's output tail, and a watcher
            // that restarts while the user is away could otherwise hand dozens
            // of them to the next turn - token spend nobody asked for, pushing
            // the context toward overflow. The most recent are the useful ones.
            if (this._pendingJobNotices.length > MAX_PENDING_JOB_NOTICES) {
                this._pendingJobNotices.splice(0, this._pendingJobNotices.length - MAX_PENDING_JOB_NOTICES);
            }
        }
        this._postBackgroundJobs();
    }

    /** Drop queued steers from `fromIndex` on (a session switch, a no-run
     *  guard, or an empty completion) and release their held webview bubbles
     *  so they cannot render later in the wrong session. */
    private _discardQueuedSteers(fromIndex = 0): void {
        for (const entry of this._localSteerQueue.slice(fromIndex)) {
            this._confirmSteer(entry.steerId, 'drop');
        }
        if (fromIndex <= 0) this._localSteerQueue.length = 0;
        else this._localSteerQueue.splice(fromIndex);
    }

    private async _runLocalAgent(
        prompt: string,
        rulesContext: string,
        attachments?: ComposerAttachment[],
        existingController?: AbortController,
        planMode?: boolean,
    ): Promise<StreamOutcome> {
        const credentials = await this._getSavedCredentials();
        if (!credentials.length) {
            this._view?.webview.postMessage({ type: 'error', valueKey: 'localCredMissing' });
            return { resultEvent: null, needsApprovalId: null, errorEvent: null, events: [], noRun: true };
        }
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId');
        const active = credentials.find((c) => c.id === activeId) ?? credentials[0];
        // The async seam: an OAuth connection resolves its token set ONCE per
        // turn (refreshing when stale), then everything downstream keeps
        // receiving a plain bearer string - no async plumbing through the
        // header builders or the wire adapters.
        //
        // A rejected/expired token must NOT escape as a thrown error: this
        // runs before the try below, so it would bypass the error surface and
        // leave the composer spinning with no explanation. "Sign in again" is
        // a different action from "something went wrong" and the user needs to
        // be told which one happened.
        const controller = existingController ?? new AbortController();
        this._abortControllers.set('chat', controller);
        const noRun = (): StreamOutcome => {
            if (this._abortControllers.get('chat') === controller) this._abortControllers.delete('chat');
            return { resultEvent: null, needsApprovalId: null, errorEvent: null, events: [], noRun: true };
        };
        let auth: Awaited<ReturnType<typeof this._resolveCredentialAuth>>;
        try {
            auth = await this._resolveCredentialAuth(active, controller.signal);
        } catch (e) {
            if (!controller.signal.aborted) {
                this._view?.webview.postMessage({ type: 'error', valueKey: oauthErrorValueKey(e) });
                if (active.oauthProviderId) await this._sendOAuthState();
            }
            return noRun();
        }
        const insecureError = insecureRemoteHttpError(active.baseUrl, auth.apiKey);
        if (insecureError) {
            this._view?.webview.postMessage({ type: 'error', valueKey: insecureError });
            return noRun();
        }
        const model = this._selectedModel;
        if (!model) {
            this._view?.webview.postMessage({ type: 'error', valueKey: 'noModelSelected' });
            return noRun();
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';

        // Reuse the controller registered by _handleChatRequest when the
        // caller already owns one (local branch) so cancel covers the full
        // isTyping window; standalone invocations create their own.
        // Matches the caller's epoch (captured right before this call) -
        // post-cancel messages must not leak into a new session view.
        const epoch = this._sessionEpoch;

        const outcome: StreamOutcome = {
            resultEvent: null,
            needsApprovalId: null,
            errorEvent: null,
            events: [],
        };

        this._localAccumulatedText = '';
        this._localAccumulatedThinking = '';
        this._localThinkingBlockEvent = null;
        this._localThinkingBlockRaw = null;
        this._localCurrentUsage = null;
        this._localTurnUsage = null;
        // `events` is held by reference and grows as the run streams - the
        // throttled snapshot below always captures the current tail.
        this._localPendingTurn = {
            prompt,
            events: outcome.events,
            ...(attachments?.length ? {
                attachments: attachments.map((a) => ({
                    name: a.name,
                    mime_type: a.mimeType,
                    size: Math.ceil(a.dataBase64.length * 3 / 4),
                })),
            } : {}),
        };

        // External MCP tools ride the local loop too: aggregated before the
        // run starts (listTools is async) and routed through the same manager.
        const externalTools = externalMcpInstance
            ? await externalMcpInstance.listTools().catch(() => [])
            : [];

        // The turn's plan mode was captured by the caller BEFORE any await -
        // a mid-preflight toggle must not expose mutating tools in an
        // already-started plan turn. (Declared up here, before the executor:
        // no awaits sit between this point and its old home below, and the
        // subagent runner needs it.)
        const runPlanMode = planMode ?? this._planMode;

        // Stable per-conversation identity, used for two provider needs: OpenCode
        // Go REQUIRES it as `x-opencode-session` (MissingSessionID otherwise),
        // and OpenAI-family hosts use it as `prompt_cache_key` to route a
        // conversation's requests to the same prompt cache. Prefer the persisted
        // session id; fall back to one stable id per live chat.
        const conversationId = this._sessionId ?? (this._ephemeralSessionId ??= `xratu-${crypto.randomUUID()}`);

        // One approval gate for the whole run tree: a child tool call that
        // needs consent surfaces as the same webview approval card. YOLO is
        // consulted LIVE per call (mid-run toggles apply from the next call).
        const localApprovalGate: LocalApprovalGate = {
            requestApproval: (id, calls) => {
                if (this._yoloMode && !runPlanMode) {
                    return Promise.resolve(
                        Object.fromEntries(calls.map((c) => [c.id, true]))
                    );
                }
                return this._requestLocalApproval(
                    id,
                    calls.map((c) => ({ tool_call_id: c.id, tool_name: c.name, args: c.arguments }))
                );
            },
        };

        // One decision gate for the run tree root: `ask_user_question` blocks
        // here until the webview card is answered. Children never get one -
        // interactive questions stay at the root thread (filterToolsForSubagent
        // strips the tool from their toolsets too).
        const decisionGate: UserQuestionGate = {
            ask: (question) => this._requestLocalDecision(question),
        };

        // Subagent delegation (the `task` tool): named agent profiles, run as
        // nested agent loops in a fresh context. Discovery is per run like
        // skills; children share the parent's transport but never its history,
        // conversation identity, or round budget. The base request is a
        // factory: every task call gets its OWN cacheKey / OpenCode session id,
        // because two delegated tasks are two conversations.
        //
        // Agent files are VALIDATED against this host before the model ever
        // sees them: a `tools:` list of names that do not exist (Claude Code's
        // `Read`/`Bash` vocabulary, a typo) used to produce a child that could
        // do nothing at all while looking perfectly launchable - the single
        // worst failure mode this feature had. Unresolvable lists are now
        // definition errors, and partial mismatches are warnings.
        const runSkills = this._discoverSkillsForRun(workspaceRoot);
        const subagentDefs = discoverSubagents({
            workspaceRoot: workspaceRoot || undefined,
            validation: {
                toolNames: this._agentToolNames(workspaceRoot, externalTools),
                knownModels: this._knownModelIds(active.baseUrl),
            },
        });
        this._logSubagentIssues(subagentDefs);
        const subagentRunner = createSubagentRunner(
            {
                baseRequest: (def) => {
                    const subagentConversationId = `${conversationId}::subagent-${crypto.randomUUID()}`;
                    // A profile may name its own model/reasoning level; the
                    // caps and the window follow THAT model, never the parent's.
                    const childModel = def.model || model;
                    const childEffort = def.reasoningEffort
                        ? this._thinkingEffortFor(def.reasoningEffort, childModel, active.baseUrl)
                        : this._reasoningEffortFor(childModel, active.baseUrl);
                    return {
                        baseUrl: active.baseUrl,
                        apiKey: auth.apiKey,
                        headers: auth.headers,
                        ...(auth.onUnauthorized ? { onUnauthorized: auth.onUnauthorized } : {}),
                        subscription: auth.subscription,
                        model: childModel,
                        signal: controller.signal,
                        maxOutputLimit: this._maxOutputLimitFor(childModel, active.baseUrl),
                        reasoningEffort: childEffort,
                        autoCompactRatio: resolveCompactRatio(
                            vscode.workspace.getConfiguration('xratu').get('autoCompactThreshold')),
                        contextWindow: this._contextWindowHint(childModel) ?? LOCAL_DEFAULT_CONTEXT_WINDOW,
                        dispatcher: getProxyDispatcher(active.baseUrl),
                        apiStyle: resolveApiStyle(active.baseUrl, childModel, auth.apiStyle),
                        ...(isOpenCodeHost(active.baseUrl) ? { sessionId: subagentConversationId } : {}),
                        cacheKey: subagentConversationId,
                    };
                },
                tools: (def) => filterToolsForSubagent(
                    getLocalToolDefinitions({
                        yolo: this._yoloMode,
                        plan: runPlanMode,
                        external: externalTools,
                        skills: runSkills,
                    }),
                    def,
                ),
                systemPrompt: (def) => buildSubagentSystemPrompt({
                    agentPrompt: def.prompt,
                    rulesContext,
                    planMode: runPlanMode,
                }),
                // Child executor WITHOUT the subagent runner: `task` is
                // unexecutable in a child even if the model hallucinates it.
                executor: createLocalToolExecutor(
                    workspaceRoot,
                    (wsRoot, reason) => this._checkpoints.ensureTurnSnapshot(wsRoot, reason),
                    externalMcpInstance ?? undefined,
                    (skillName) => resolveSkillForRun(
                        workspaceRoot || undefined,
                        skillName,
                        new Set(this._disabledSkillIds()),
                    ),
                    // A delegated child must not leave a background process
                    // behind it - see the `nested` guard in mcp.ts.
                    undefined,
                    undefined,
                    { nested: true },
                ),
                approvalGate: localApprovalGate,
                onUsage: (usage) => {
                    // Delegated rounds are real spend on the same account:
                    // fold them into the turn/session/global ledgers exactly
                    // like parent rounds.
                    this._handleLocalAgentEvent({ type: 'usage', usage, estimated: false }, outcome);
                },
            },
            subagentDefs,
            this._subagentRuns(),
        );

        const rawExecutor = createLocalToolExecutor(
            workspaceRoot,
            (wsRoot, reason) => this._checkpoints.ensureTurnSnapshot(wsRoot, reason),
            externalMcpInstance ?? undefined,
            // Dispatch-time gate + body source in ONE resolver: the skill
            // call resolves the winning copy (per-source identity, shadowed
            // copies excluded), checks the live disabled list, and reuses the
            // resolved dirPath for the load - no second discovery per call.
            (skillName) => resolveSkillForRun(
                workspaceRoot || undefined,
                skillName,
                new Set(this._disabledSkillIds()),
            ),
            subagentRunner,
            decisionGate,
        );

        // The git line under the composer must not wait for the whole run to
        // settle: any tool can touch the working tree (an edit, or a git
        // command run through the terminal). Wrapped generically so the
        // executor's own signature stays the single source of truth.
        const executor: typeof rawExecutor = {
            execute: async (call, onOutput) => {
                // Snapshot file state around edit-family calls so the
                // webview's "open diff" button can show the exact before/after
                // of THIS call later (restored sessions fall back to args).
                const snap = this._beginEditSnapshot(call, workspaceRoot);
                try {
                    const result = await rawExecutor.execute(call, onOutput);
                    if (snap && !result.isError) this._endEditSnapshot(call.id, snap);
                    return result;
                } finally {
                    this._scheduleGitStatusPush();
                }
            },
        };

        // Text attachments ride the prompt as fenced blocks (no vision
        // needed) - PDFs arrive here ALREADY text-extracted by the caller;
        // only images go through as image_url parts.
        const localUserText = buildLocalUserText(prompt, attachments);
        const localAttachments = attachments
            ?.filter((a) => isImageAttachment(a.mimeType))
            .map((a) => ({
                name: a.name,
                mimeType: a.mimeType,
                dataBase64: a.dataBase64,
            }));

        // The turn's plan mode was captured by the caller BEFORE any await -
        // a mid-preflight toggle must not expose mutating tools in an
        // already-started plan turn. (Resolved above, next to the executor.)
        const systemPrompt = this._buildLocalSystemPrompt(rulesContext, this._sessionSummary, runPlanMode, workspaceRoot);

        // Cost display for this run: Toman only for Iranian providers AND only
        // when the user set a rate (never guess an exchange rate).
        this._setCostCurrencyFor(active.baseUrl);
        this._runSubscription = auth.subscription === true;

        try {
            // Seed the live reminder list for this run; model writes refresh it
            // through the task-list write listener.
            this._activeRunTaskList = this._currentTaskList();
            this._runInFlight = true;
            // Baseline for the run's cumulative dropped-user-turn report.
            this._compactionRunReplayBase = this._localReplayUserTurns;
            const agent = runLocalAgent(
                {
                    baseUrl: active.baseUrl,
                    apiKey: auth.apiKey,
                    headers: auth.headers,
                    ...(auth.onUnauthorized ? { onUnauthorized: auth.onUnauthorized } : {}),
                        subscription: auth.subscription,
                    model,
                    systemPrompt,
                    userText: localUserText,
                    attachments: localAttachments,
                    history: this._buildLocalHistory(),
                    // Carry the rolling compaction summary into the run so the
                    // pre-request compaction MERGES newly dropped turns into
                    // the accumulated summary instead of overwriting it.
                    sessionSummary: this._sessionSummary,
                    tools: getLocalToolDefinitions({
                        yolo: this._yoloMode,
                        plan: runPlanMode,
                        external: externalTools,
                        // Agent Skills are rescanned per run (tool schemas
                        // snapshot at session start); disabled ones are
                        // filtered out host-side. Discovered once above and
                        // shared with the subagent toolset.
                        skills: runSkills,
                        // Subagent profiles: adds the `task` delegation tool.
                        subagents: subagentDefs,
                    }),
                    ...(this._currentTaskList()?.length ? { taskList: this._currentTaskList()! } : {}),
                    taskListProvider: () => this._activeRunTaskList ?? undefined,
                    signal: controller.signal,
                    // Read per run so a change takes effect on the next turn
                    // without a reload. Unset (the default) means UNLIMITED:
                    // the loop ends when the model stops calling tools, like
                    // other agent harnesses, rather than at a fixed count. The
                    // old hardcoded 25 (clamped to 32 by the runtime) made long
                    // workflows impossible to run and impossible to extend.
                    maxRounds: resolveAgentRounds(
                        vscode.workspace.getConfiguration('xratu').get('maxAgentRounds')),
                    // Compaction threshold: the user's policy rather than a
                    // constant. Read per run so a change applies to the next
                    // turn without a reload.
                    autoCompactRatio: resolveCompactRatio(
                        vscode.workspace.getConfiguration('xratu').get('autoCompactThreshold')),
                    // Window for compaction/budget math. Prefer the probed or
                    // override value; the fallback is deliberately CONSERVATIVE
                    // (not 32k): claiming a window larger than the runtime
                    // actually has overflows it and makes small local models
                    // degenerate (repetition loops). Over-estimating small
                    // only costs extra history compaction, which is functional.
                    contextWindow: this._contextWindowHint() ?? LOCAL_DEFAULT_CONTEXT_WINDOW,
                    maxOutputLimit: this._maxOutputLimitFor(model, active.baseUrl),
                    reasoningEffort: this._reasoningEffortFor(model, active.baseUrl),
                    // Route model traffic through the configured proxy. The
                    // dispatcher is cached and undefined when no proxy is set.
                    dispatcher: getProxyDispatcher(active.baseUrl),
                    // OpenCode Zen/Go route some model families to /messages
                    // or /responses on the same base URL; everything else is
                    // OpenAI chat/completions.
                    apiStyle: resolveApiStyle(active.baseUrl, model, auth.apiStyle),
                    // OpenCode Go requires a stable per-conversation session id
                    // (MissingSessionID otherwise). Other hosts only need the
                    // cache-key identity below.
                    ...(isOpenCodeHost(active.baseUrl) ? { sessionId: conversationId } : {}),
                    // Sent as `prompt_cache_key` on hosts that accept it; the
                    // transport decides (see supportsPromptCacheKey).
                    cacheKey: conversationId,
                    // Several `task` calls in one message run as concurrent
                    // subagents - that is the point of delegation - but each
                    // one is a full agent loop with its own context and round
                    // budget, so the group runs in waves (a few at a time)
                    // rather than as one uncapped bill.
                    parallelTools: [SUBAGENT_TOOL_NAME],
                    parallelToolLimit: resolveParallelSubagents(
                        vscode.workspace.getConfiguration('xratu').get('maxParallelSubagents')),
                },
                executor,
                // Shared with nested subagent runs (same live YOLO check).
                localApprovalGate,
                {
                    // Mid-run steering: the loop drains this at every round
                    // boundary (after tool results, before the next model
                    // request), so steered messages join the conversation
                    // without restarting the turn.
                    drain: () => this._localSteerQueue.splice(0).map((e) => ({
                        text: e.text,
                        ...(e.images?.length ? { attachments: e.images } : {}),
                        ...(e.steerId ? { steerId: e.steerId } : {}),
                    })),
                },
            );

            for await (const event of agent) {
                this._handleLocalAgentEvent(event, outcome);
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                outcome.aborted = true;
                if (epoch === this._sessionEpoch) {
                    this._view?.webview.postMessage({ type: 'error', valueKey: 'requestCancelled' });
                }
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                // Persian one-liner + raw detail when the failure is a known
                // class (offline, deterministic - see local/errorExplain);
                // unknown failures keep passing through raw.
                const http = providerHttpStatus(err);
                const explained = explainError(http ? `${msg} ${http.body}` : msg, http?.status);
                if (explained) {
                    this._view?.webview.postMessage({ type: 'error', valueKey: explained.valueKey, params: explained.params });
                } else {
                    this._view?.webview.postMessage({ type: 'error', value: msg });
                }
                outcome.errorEvent = { error: msg };
                void this._maybeOfferIranianFallback(err);
            }
        } finally {
            this._runInFlight = false;
            this._activeRunTaskList = null;
            this._abortControllers.delete('chat');
            // The run is over - committed, aborted or errored. Clear BEFORE
            // the caller's commit persist so the snapshot never carries a
            // pendingTurn for a turn that is already in the ledgers, and stop
            // the throttled flush.
            this._localPendingTurn = null;
            if (this._localPartialTimer) {
                clearTimeout(this._localPartialTimer);
                this._localPartialTimer = null;
            }
        }

        return outcome;
    }

    /** Translate a local agent event into webview messages + outcome tracking. */
    private _handleLocalAgentEvent(event: LocalAgentEvent, outcome: StreamOutcome): void {
        switch (event.type) {
            case 'chunk':
                this._localAccumulatedText += event.value;
                // Batched onto the shared live tick - see _noteStreamChunk.
                this._noteStreamChunk(event.value);
                this._scheduleLocalPartialPersist();
                break;
            case 'thinking':
                // The accumulated copy is the LIVE terminal value: the result
                // event re-posts it at completion, and that re-post is only
                // idempotent while it is byte-identical to what streamed - so
                // it stays RAW. Every PERSISTENCE path clips on the way out:
                // the thinking event clips as it streams (below), the result
                // event clips in trimDisplayEvent at transfer, and the pending
                // snapshot clips in sanitizePendingTurn.
                this._localAccumulatedThinking = event.value;
                this._flushLiveSegment();
                this._noteThinking(event.value);
                // Record the reasoning in the turn's event timeline so it keeps
                // its position relative to tool/text steps and survives reload
                // (_restoreChatUI replays thinking events in order). The first
                // delta of a block pushes the event; later cumulative deltas
                // extend it in place instead of growing the array - the event
                // carries the BOUNDED copy from the first delta on.
                if (this._localThinkingBlockEvent && this._localThinkingBlockRaw != null
                    && event.value.startsWith(this._localThinkingBlockRaw)) {
                    this._localThinkingBlockRaw = event.value;
                    this._localThinkingBlockEvent.content = clipHistoryContent(event.value, MAX_CONTENT_CAP);
                } else {
                    this._localThinkingBlockRaw = event.value;
                    this._localThinkingBlockEvent = { type: 'thinking', content: clipHistoryContent(event.value, MAX_CONTENT_CAP) };
                    outcome.events.push(this._localThinkingBlockEvent);
                }
                this._scheduleLocalPartialPersist();
                break;
            case 'toolCall':
                this._flushLiveSegment();
                // A tool call closes the current reasoning block - reasoning
                // after it belongs to a fresh block and needs its own pill.
                this._localThinkingBlockEvent = null;
                this._localThinkingBlockRaw = null;
                // Display-only event (the model ledger takes its tool rows
                // from `assistant_message.tool_calls`): trim at PUSH so a
                // whole written file never rides the run-lifetime array - the
                // turn-end transfer produced these exact bytes anyway.
                // `update_task_list` stays whole (the checklist re-parses it).
                outcome.events.push(trimDisplayEvent({ type: 'tool_call', id: event.id, tool: event.tool, args: event.args }));
                this._scheduleLocalPartialPersist();
                if (event.tool === TASK_LIST_TOOL_NAME) {
                    this._noteTaskListWrite();
                }
                this._view?.webview.postMessage({
                    type: 'toolCall',
                    tool: event.tool,
                    args: JSON.stringify(event.args, null, 2),
                    callId: event.id,
                });
                break;
            case 'toolResult': {
                this._flushLiveSegment();
                this._localThinkingBlockEvent = null;
                this._localThinkingBlockRaw = null;
                const persisted = persistedEventFromAgentEvent(event);
                if (persisted) outcome.events.push(persisted);
                // Re-enforce the run-lifetime bounds (output budget, thinking
                // ceiling, carrier budget) after every payload-bearing push.
                boundOutcomeEvents(outcome.events);
                this._scheduleLocalPartialPersist();
                this._view?.webview.postMessage({
                    type: 'toolResult',
                    tool: event.tool,
                    output: event.output,
                    callId: event.id,
                    // Images the tool returned (MCP screenshots etc). The
                    // webview renders them but never sends them back; the
                    // persisted row keeps metadata only (historyRows).
                    ...(event.images?.length
                        ? { images: event.images.map(toToolImageView) }
                        : {}),
                });
                break;
            }
            case 'toolOutput':
                // Live output while a long tool runs - display only, never
                // persisted (the final tool_result carries the capped output).
                this._view?.webview.postMessage({
                    type: 'toolOutput',
                    callId: event.id,
                    value: event.value,
                });
                break;
            case 'steer':
                // The webview held this steer bubble while the tool call ran;
                // confirm it now so the timeline splits at the exact point the
                // model receives the message.
                this._confirmSteer(event.steerId);
                // Ledger-only: the webview renders the bubble on confirmation.
                outcome.events.push({
                    type: 'steer_user',
                    text: event.text,
                    ...(event.attachments?.length ? {
                        attachments: event.attachments.map((a) => ({
                            name: a.name,
                            mime_type: a.mimeType,
                            size: Math.ceil(a.dataBase64.length * 3 / 4),
                        })),
                    } : {}),
                });
                break;
            case 'assistantMessage': {
                const persisted = persistedEventFromAgentEvent(event);
                if (persisted) outcome.events.push(persisted);
                boundOutcomeEvents(outcome.events);
                this._scheduleLocalPartialPersist();
                break;
            }
            case 'usage':
                // Mid-stream ESTIMATES only feed the webview's live context
                // meter; the turn's recorded usage stays on the real
                // round-end event (server-reported).
                if (!event.estimated) {
                    this._localCurrentUsage = event.usage;
                    // A turn can span several model rounds (tool calls); the
                    // turn's COST is the sum across rounds, not just the last.
                    this._localTurnUsage = this._addUsage(this._localTurnUsage, event.usage);
                    // Session spend accumulates per round and is never reduced
                    // by a rewind/checkpoint restore.
                    const roundCost = this._costFor(event.usage);
                    if (roundCost != null && roundCost.amount > 0) {
                        this._sessionCost[roundCost.currency] += roundCost.amount;
                        this._postSessionCost();
                        // Persist soon (throttled): a crash between the round
                        // and the next full save must not lose the spend.
                        this._scheduleLocalPartialPersist();
                    }
                    // Token ledger rides alongside the cost ledger.
                    this._addSessionUsage(event.usage);
                    this._scheduleLocalPartialPersist();
                    // Global timestamped ledger: the daily chart and retroactive
                    // repricing both read from it (see usageLedger.ts).
                    void this._recordUsage({
                        ts: Date.now(),
                        sessionId: this._sessionId,
                        host: baseUrlHost(this._runBaseUrl ?? '') ?? '',
                        model: this._selectedModel ?? '',
                        ...(this._runSubscription ? { billing: 'chatgpt-plan' as const } : {}),
                        input: event.usage.promptTokens ?? 0,
                        output: event.usage.completionTokens ?? 0,
                        cached: event.usage.cachedTokens ?? 0,
                        cacheWrite: event.usage.cacheWriteTokens ?? 0,
                        amount: roundCost ? roundCost.amount : null,
                        currency: roundCost ? roundCost.currency : null,
                    });
                }
                // Mirror cloud behavior: the webview's context meter tracks
                // each round's cumulative usage while the turn streams.
                this._view?.webview.postMessage({
                    type: 'usage',
                    usage: event.usage ? {
                        input_tokens: event.usage.promptTokens,
                        output_tokens: event.usage.completionTokens,
                        cached_tokens: event.usage.cachedTokens ?? null,
                        cost: this._localCostFor(this._localTurnUsage),
                    } : null,
                });
                break;
            case 'compactionSummary': {
                // Local compaction summarized the dropped turns with the
                // user's model - keep it rolling: the next local request's
                // system prompt and the session snapshot carry it forward.
                // Advance the replay boundary so the next turn does not re-send
                // (and re-summarize) the turns the summary now covers. The run
                // reports a CUMULATIVE count against the baseline captured at
                // run start; the current turn's row is not in `_localHistory`
                // yet, so `total` is the prior-turn count.
                this._sessionSummary = event.value;
                const total = countUserRows(this._localHistory);
                const base = this._compactionRunReplayBase ?? total;
                const dropped = typeof event.droppedUserTurns === 'number'
                    ? Math.max(0, event.droppedUserTurns)
                    : 0;
                const replay = Math.max(0, Math.min(base - dropped, total));
                this._localReplayUserTurns = replay >= total ? null : replay;
                break;
            }
            case 'retrying':
                // Transient transport drop. Display-only: patch the streaming
                // bubble with the countdown so a slow re-dial does not look
                // like a hang. Never committed to the transcript.
                this._view?.webview.postMessage({
                    type: 'retrying',
                    attempt: event.attempt,
                    maxAttempts: event.maxAttempts,
                    nextRetryInMs: event.nextRetryInMs,
                    // Offline (DNS/route) failures label the countdown
                    // differently so the user knows it is their link.
                    offline: event.offline,
                });
                break;
            case 'attempting':
                // Clear the countdown right before the next fetch so the bubble
                // falls back to the typing dots.
                this._view?.webview.postMessage({ type: 'attempting' });
                break;
            case 'needsApproval':
                outcome.needsApprovalId = event.approvalId;
                break;
            case 'status':
                if (event.value === 'done') {
                    outcome.resultEvent = {
                        persian_explanation: this._localAccumulatedText,
                        thinking: this._localAccumulatedThinking,
                        usage: this._localCurrentUsage ? {
                            input_tokens: this._localCurrentUsage.promptTokens,
                            output_tokens: this._localCurrentUsage.completionTokens,
                            cached_tokens: this._localCurrentUsage.cachedTokens ?? null,
                            cost: this._localCostFor(this._localTurnUsage),
                        } : null,
                        context_window: this._contextWindowHint() ?? null,
                    };
                }
                break;
            case 'error': {
                outcome.errorEvent = { error: event.value };
                const explained = explainError(event.value);
                this._view?.webview.postMessage(explained
                    ? { type: 'error', valueKey: explained.valueKey, params: explained.params }
                    : { type: 'error', value: event.value });
                break;
            }
        }
    }

    async _fetchModels(): Promise<boolean> {
        if (!this._view) return false;
        // A remembered model for THIS credential wins over the in-memory one -
        // the in-memory value may belong to the credential we just switched
        // away from. The legacy secret is the pre-multi-provider fallback.
        // With NO active credential there is nothing to restore: wipe instead,
        // or a deleted connection's model lingers in the picker forever.
        if (await this._resolveActiveCredentialId()) {
            this._selectedModel = (await this._modelForActiveCredential())
                ?? this._selectedModel
                ?? (await this._secrets.get('xratu.selectedModel') ?? null);
        } else if (this._selectedModel) {
            this._selectedModel = null;
            await this._secrets.delete('xratu.selectedModel');
        }
        // Let the picker spin its refresh button for the duration of the fetch.
        this._view.webview.postMessage({ type: 'modelsRefreshing', active: true });
        try {
            const llm = await this._getLlmCredentials();
            if (!llm.llm_base_url) {
                // Nothing configured - the picker stays empty until a
                // provider is connected.
                this._view.webview.postMessage({
                    type: 'modelInfo', defaultModel: '', models: [],
                    visionCapable: this.isLocalModelVisionCapable(),
                    contextWindows: {},
                    overrides: this._contextWindowOverrides(),
                    thinkingLevels: this._thinkingLevels(),
                    selectedModel: this._selectedModel ?? undefined
                });
                this._view.webview.postMessage({ type: 'byokSetupHint' });
                return false;
            }
            // Runtime collapse: every credential - remote BYOK or on-machine
            // runtime - is an OpenAI-compatible endpoint the extension probes
            // and chats with directly.
            return await this._fetchLocalModels(llm.llm_base_url, llm.llm_api_key, llm.extra_headers, llm.discoverModels);
        } catch (e) {
            // Probe failure - tell the user instead of failing silently.
            this._view.webview.postMessage({
                type: 'byokCredentialError',
                value: e instanceof Error ? e.message : String(e)
            });
            return false;
        } finally {
            this._view.webview.postMessage({ type: 'modelsRefreshing', active: false });
        }
    }

    private async _fetchLocalModels(baseUrl: string, apiKey?: string, extraHeaders?: Record<string, string>, discoverModels?: () => Promise<{ models: import('./local/localTypes').LocalModelInfo[] }>): Promise<boolean> {
        if (!this._view) return false;
        const insecureError = insecureRemoteHttpError(baseUrl, apiKey);
        if (insecureError) {
            this._view.webview.postMessage({ type: 'byokCredentialError', valueKey: insecureError });
            return false;
        }
        // Deselect/switch may happen while the probe below is in flight -
        // remember which credential started this fetch so a stale result
        // never resurrects a selection the user just cleared (a stale model
        // paired with the fallback credential would mislabel chat requests).
        const fetchCredId = await this._resolveActiveCredentialId();
        this._view.webview.postMessage({ type: 'modelsRefreshing', active: true });
        try {
            // Only providers the catalog covers trigger the request.
            const modelsDev = modelsDevProviderKey(providerIdForUrl(baseUrl))
                ? await this._ensureModelsDevCatalog()
                : null;
            let probed = discoverModels ? await discoverModels() : await probeLocalEndpoint(baseUrl, undefined, apiKey, getProxyDispatcher(baseUrl), modelsDev, extraHeaders);
            if ((await this._resolveActiveCredentialId()) !== fetchCredId) {
                return false;
            }
            // Offline / flaky network: serve the host's cached catalog rather
            // than an empty picker. A stale-but-real list is strictly better
            // than "unreachable", and a run still works when the endpoint
            // comes back. The cache is NOT refreshed here (the fetch failed).
            let fromCache = false;
            if (!probed) {
                const cached = catalogEntryFor(this._modelCatalog, baseUrlHost(baseUrl), Date.now());
                if (cached) {
                    probed = { models: cached.models };
                    fromCache = true;
                }
            }
            if (!probed) {
                this._view.webview.postMessage({
                    type: 'byokCredentialError',
                    valueKey: 'localUnreachable',
                });
                return false;
            }

            // OpenCode also lists non-chat models (Jev structured-decision,
            // image, embedding, audio). They cannot drive the agent loop, so
            // keep them out of the picker instead of letting the user select a
            // model that always fails.
            const models = probed.models
                .map((m) => m.id)
                .filter(Boolean)
                .filter((id) => !(isOpenCodeHost(baseUrl) && isNonChatModel(id)));

            const host = baseUrlHost(baseUrl);
            // Cache the normalized metadata per HOST so the same model id on
            // two providers never shares a window or a price, and a later run
            // can resolve price/limit without re-probing. A cache-served list
            // must not be re-stamped as freshly fetched.
            if (!fromCache) {
                this._modelCatalog = setCatalogEntry(this._modelCatalog, host, probed.models, Date.now());
                void this._saveModelCatalog();
                this._rememberContextWindows(host, probed.models);
            }

            // What the picker/meter sees: provider-reported windows for this
            // host, then the best window each probed model carries - which is
            // provider-reported, else models.dev, else curated.
            const servedWindows: Record<string, number> = { ...this._contextWindowsFor(host) };
            for (const m of probed.models) {
                if (!m.id || servedWindows[m.id]) continue;
                const win = m.contextWindow ?? knownContextWindow(m.id);
                if (win) servedWindows[m.id] = win;
            }

            // Per-model capability badges. Only informative signals are sent:
            // vision when supported, "no tools" when the model cannot drive the
            // agent loop, and reasoning support so the thinking selector can be
            // hidden for models that do not accept the parameter.
            const capabilities: Record<string, { vision?: boolean; noTools?: boolean; reasoning?: boolean; noReasoning?: boolean; reasoningLevels?: ThinkingLevel[] }> = {};
            for (const m of probed.models) {
                if (!m.id) continue;
                const vision = m.supportsVision ?? modelIsLikelyVision(m.id);
                const tools = m.supportsTools ?? modelLikelySupportsTools(m.id);
                const entry: { vision?: boolean; noTools?: boolean; reasoning?: boolean; noReasoning?: boolean; reasoningLevels?: ThinkingLevel[] } = {};
                if (vision) entry.vision = true;
                if (!tools) entry.noTools = true;
                if (m.supportsReasoning === true) entry.reasoning = true;
                else if (m.supportsReasoning === false) entry.noReasoning = true;
                // Provider-reported (or curated) variants restrict the picker;
                // absent = offer the default set.
                if (m.reasoningLevels?.length) entry.reasoningLevels = m.reasoningLevels;
                if (entry.vision || entry.noTools || entry.reasoning || entry.noReasoning || entry.reasoningLevels) {
                    capabilities[m.id] = entry;
                }
            }

            // Prefer the model remembered for this credential, then the
            // in-memory selection; fall back to the provider's first model.
            const remembered = await this._modelForActiveCredential();
            const preferred = remembered && models.includes(remembered)
                ? remembered
                : this._selectedModel;
            this._selectedModel = preferred && models.includes(preferred)
                ? preferred
                : (models[0] ?? null);
            // The active provider is known here (even before any run), so the
            // cost currency is correct for a reopened session.
            this._setCostCurrencyFor(baseUrl);
            this._view.webview.postMessage({
                type: 'modelInfo',
                defaultModel: models[0] ?? '',
                models,
                displayNames: Object.fromEntries(probed.models.filter((m) => m.displayName).map((m) => [m.id, m.displayName!])),
                contextWindows: servedWindows,
                overrides: this._contextWindowOverrides(),
                thinkingLevels: this._thinkingLevels(),
                selectedModel: this._selectedModel ?? undefined,
                visionCapable: this.isLocalModelVisionCapable(),
                capabilities,
            });
            // Re-post the total in case it was shown in the wrong currency.
            this._postSessionCost();
            return true;
        } catch (e) {
            this._view.webview.postMessage({
                type: 'byokCredentialError',
                valueKey: 'localUnreachableDetail',
                params: { detail: e instanceof Error ? e.message : String(e) },
            });
            return false;
        } finally {
            this._view.webview.postMessage({ type: 'modelsRefreshing', active: false });
        }
    }

    /** Command-palette entry point (keeps _setLlmCredentials private-adjacent). */
    public async setLlmCredentialsPublic(): Promise<void> {
        await this.ensureView();
        void this._setLlmCredentials();
    }

    /** Command-palette entry point: focus the webview and route to Settings. */
    public async openSettingsPublic(): Promise<void> {
        await this.ensureView();
        this._view?.webview.postMessage({ type: 'openSettings' });
    }

    /**
     * "Xratu: Agent Files" - the one surface where subagent profiles are
     * visible at all. Agent files are plain markdown the user may have
     * written for ANOTHER tool (`.claude/agents/`, `~/.agents/agents/`) and
     * they fail SILENTLY: an unparsable file, a name that does not match the
     * file, a `tools:` list of names this host does not have. Each of those
     * used to make a profile simply not exist, with no error anywhere. This
     * picker lists every discovered profile with its source and status, and
     * can scaffold a correct one.
     */
    public async manageAgentFiles(): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const external = externalMcpInstance ? await externalMcpInstance.listTools().catch(() => []) : [];
        const toolNames = this._agentToolNames(workspaceRoot, external);
        const defs = discoverSubagents({ workspaceRoot, validation: { toolNames } });
        type Item = vscode.QuickPickItem & { def?: SubagentDefinition; create?: boolean };
        const items: Item[] = [{
            label: `$(add) ${ui('agentCreateItem')}`,
            description: ui('agentCreateDescription'),
            create: true,
        }];
        for (const def of defs) {
            const status = def.error
                ? ui('agentStatusBroken')
                : def.warning ? ui('agentStatusWarning') : ui('agentStatusOk');
            items.push({
                label: `${def.error || def.warning ? '$(warning) ' : '$(check) '}${def.name}`,
                description: `${status} · ${agentSourceLabel(def.source)}`,
                detail: def.error || def.warning || def.description,
                def,
            });
        }
        const picked = await vscode.window.showQuickPick(items, {
            title: ui('agentPickerTitle'),
            placeHolder: ui('agentPickerPlaceholder'),
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked) return;
        if (picked.create) {
            await this._scaffoldAgentFile(workspaceRoot, toolNames);
            return;
        }
        if (picked.def?.filePath) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.def.filePath));
            await vscode.window.showTextDocument(doc);
        }
    }

    /** Write a starter agent file the loader will definitely accept. */
    private async _scaffoldAgentFile(workspaceRoot: string | undefined, toolNames: ReadonlySet<string>): Promise<void> {
        const name = await vscode.window.showInputBox({
            title: ui('agentCreateTitle'),
            prompt: ui('agentCreatePrompt'),
            placeHolder: 'code-reviewer',
            validateInput: (value) => {
                const trimmed = value.trim();
                if (!trimmed) return ui('agentCreateErrorEmpty');
                if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmed)) return ui('agentCreateErrorName');
                if (trimmed.length > 64) return ui('agentCreateErrorName');
                return null;
            },
        });
        if (!name) return;
        const trimmed = name.trim();
        // Project scope when a folder is open (the agent belongs to the repo),
        // else the shared cross-agent root so it follows the user everywhere.
        const dir = workspaceRoot
            ? path.join(workspaceRoot, '.xratu', 'agents')
            : path.join(os.homedir(), '.agents', 'agents');
        const file = path.join(dir, `${trimmed}.md`);
        if (fs.existsSync(file)) {
            void vscode.window.showWarningMessage(ui('agentCreateErrorExists', { path: file }));
            return;
        }
        const uri = vscode.Uri.file(file);
        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
            await vscode.workspace.fs.writeFile(uri, Buffer.from(agentFileTemplate(trimmed, Array.from(toolNames)), 'utf8'));
        } catch (e) {
            void vscode.window.showErrorMessage(ui('agentCreateFailed', { error: e instanceof Error ? e.message : String(e) }));
            return;
        }
        this._subagentIssueSignature = '';
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        // The old webview is gone (reload/re-init): any confirm banner it owed
        // an answer can never be answered - settle them as cancelled.
        for (const [id, resolve] of this._pendingNotifies) {
            this._pendingNotifies.delete(id);
            resolve(null);
        }
        // Same for local-approval and decision-card promises: the cards died
        // with the old page, so nobody can ever answer them - without this the
        // suspended runLocalAgent generator (or ask_user_question tool call)
        // waits forever, holding its controller slot.
        this._rejectPendingLocalApprovals();
        this._rejectPendingLocalDecisions();

        // DEV-ONLY: `XRATU_WEBVIEW_LOG=<path>` appends every host→webview
        // envelope to a JSONL tape, so a session that misbehaved on screen can
        // be replayed into a real browser later (test/e2e/replay.mjs) instead
        // of being re-created by hand. Recording never blocks delivery:
        // createRecordedPostMessage swallows fs errors and always forwards.
        const tapePath = process.env.XRATU_WEBVIEW_LOG?.trim();
        if (tapePath && !recordedWebviews.has(webviewView.webview)) {
            try {
                const fd = fs.openSync(tapePath, 'a');
                recordedWebviews.add(webviewView.webview);
                webviewView.webview.postMessage = createRecordedPostMessage(
                    webviewView.webview.postMessage.bind(webviewView.webview),
                    (line: string) => { fs.writeSync(fd, line); },
                );
            } catch (err) {
                console.error('xratu: XRATU_WEBVIEW_LOG unusable, messages will not be recorded:', err);
            }
        }

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Dispose old subscriptions before creating new ones (prevents listener leak on re-init)
        for (const sub of this._webviewSubscriptions) { sub.dispose(); }
        this._webviewSubscriptions = [];

        this._webviewSubscriptions.push(
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    this._startConnectionPolling();
                    this._pushEditorContext();
                    // Skills live on disk - rescan on every focus so the
                    // capabilities page never shows a stale list.
                    void this._sendSkillsState();
                } else {
                            }
            })
        );

        // Keep the webview's editor context fresh - suggestion workflows
        // name the open file, so every editor switch must be echoed.
        this._webviewSubscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                if (webviewView.visible) this._pushEditorContext();
            })
        );

        this._webviewSubscriptions.push(
            webviewView.webview.onDidReceiveMessage((data) => {
                void routeWebviewMessage(this, data, {
                    mcpConfigStore: mcpConfigStoreInstance,
                    externalMcp: externalMcpInstance,
                });
            })
        );
    }

    /** Local branches from the last listing - also the ALLOWLIST `_gitCheckout`
     *  validates against, so a webview-supplied string never reaches git. */
    private _gitBranches: string[] = [];

    /** Read the workspace's git status, plus the folder it belongs to compacted
     *  against $HOME (a long absolute path would crowd out the branch and the
     *  counts). */
    private async _readGitStatus(): Promise<{ status: GitStatusSummary; root: string | null }> {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let status = emptyGitStatus();
        if (root) {
            try {
                const { stdout } = await execFileAsync(
                    'git',
                    ['-C', root, 'status', '--porcelain=v1', '--branch'],
                    { timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
                );
                status = parseGitStatus(String(stdout ?? ''));
            } catch {
                status = emptyGitStatus();
            }
        }
        const home = os.homedir();
        const displayRoot = root
            ? (home && (root === home || root.startsWith(home + path.sep)) ? `~${root.slice(home.length)}` : root)
            : null;
        return { status, root: displayRoot };
    }

    /** Debounce handle for the git line's post-tool refresh. */
    private _gitStatusTimer: ReturnType<typeof setTimeout> | null = null;

    /** Refresh the git line soon, coalescing bursts: tools touch the working
     *  tree far faster than `git status` is worth running. */
    private _scheduleGitStatusPush(): void {
        if (this._gitStatusTimer) return;
        this._gitStatusTimer = setTimeout(() => {
            this._gitStatusTimer = null;
            void this._sendGitStatus();
        }, 500);
    }

    /** Push the git status for the line under the composer. A non-repo (or a
     *  missing git) reports `isRepo: false` and the UI renders nothing - a
     *  status line that guesses is worse than no line. */
    async _sendGitStatus(): Promise<void> {
        if (!this._view) return;
        const { status, root } = await this._readGitStatus();
        this._view.webview.postMessage({ type: 'gitStatusState', status, root });
    }

    /** Push the branch list for the picker. The CURRENT branch comes from the
     *  status the line is already showing - one source of truth, not a second
     *  git call that could disagree with the line the user just clicked. */
    async _sendGitBranches(): Promise<void> {
        if (!this._view) return;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let branches: string[] = [];
        if (root) {
            try {
                const { stdout } = await execFileAsync(
                    'git',
                    ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
                    { timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
                );
                branches = parseBranchList(String(stdout ?? ''));
            } catch {
                branches = [];
            }
        }
        this._gitBranches = branches;
        const { status } = await this._readGitStatus();
        this._view.webview.postMessage({ type: 'gitBranchesState', branches, current: status.branch });
    }

    /** Switch the workspace to another branch.
     *
     *  The name must be one we just LISTED, not merely well-formed: the picker
     *  is the only caller, so an arbitrary string from the webview must never
     *  reach git's argv. `git checkout` refuses on its own when the switch
     *  would overwrite local changes (no -f here, deliberately), and a failure
     *  is REPORTED - a picker that silently does nothing reads as broken. */
    async _gitCheckout(branch: string): Promise<void> {
        if (!this._view) return;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root && isSafeBranchName(branch) && this._gitBranches.includes(branch)) {
            try {
                await execFileAsync('git', ['-C', root, 'checkout', branch], {
                    timeout: 15_000,
                    maxBuffer: 4 * 1024 * 1024,
                    windowsHide: true,
                });
            } catch (err) {
                const detail = String((err as { stderr?: unknown })?.stderr || (err as Error)?.message || err)
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)[0] ?? '';
                this.notifyBanner('error', 'gitCheckoutFailed', { error: detail.slice(0, 200) });
            }
        }
        await this._sendGitStatus();
        await this._sendGitBranches();
    }

    /** Push the MCP page's complete view: merged config + live statuses.
     *  Header values are included (the page is the single editing surface -
     *  masking them would make saves destructive). The addable catalog now
     *  rides `mcpMarketplaceState` instead of this payload. */
    async _sendMcpState(): Promise<void> {
        if (!externalMcpInstance || !mcpConfigStoreInstance || !this._view) return;
        const config = await mcpConfigStoreInstance.load();
        const statuses = await externalMcpInstance.getServerStatuses();
        const servers = statuses.map((s) => ({
            ...config.servers[s.name],
            name: s.name,
            state: s.state,
            toolCount: s.toolCount,
            lastError: s.lastError,
            source: s.source,
        }));
        this._view.webview.postMessage({
            type: 'mcpState',
            servers,
            hasWorkspace: !!config.workspacePath,
            legacyInUse: config.legacyInUse,
        });
    }

    /** Push the Proxy page's view: stored settings plus the LIVE resolution
     *  (which layer won - the answer is often "your OS system proxy", which
     *  is invisible in the settings UI otherwise). */
    async _sendProxyState(): Promise<void> {
        if (!this._view) return;
        const cfg = vscode.workspace.getConfiguration('xratu');
        const resolved = getProxyResolution();
        this._view.webview.postMessage({
            type: 'proxyState',
            mode: resolved.mode,
            proxyUrl: cfg.get<string>('proxyUrl') ?? '',
            noProxy: cfg.get<string>('noProxy') ?? '',
            resolvedUrl: resolved.url,
            resolvedSource: resolved.source,
            systemProxy: resolved.systemProxy,
            noProxyList: resolved.noProxy,
        });
    }

    /** Persist proxy settings (Proxy page). Writes the `xratu.*` settings -
     *  the dispatcher picks them up on the next request (its cache keys off
     *  the resolved URL). */
    async _saveProxySettings(mode: 'auto' | 'custom' | 'off', proxyUrl: string, noProxy: string): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('xratu');
        await cfg.update('proxyMode', mode, vscode.ConfigurationTarget.Global);
        await cfg.update('proxyUrl', proxyUrl.trim(), vscode.ConfigurationTarget.Global);
        await cfg.update('noProxy', noProxy.trim(), vscode.ConfigurationTarget.Global);
        await this._sendProxyState();
    }

    /** Scan loopback for running proxy clients (Clash family, v2rayN, …). */
    async _detectProxies(): Promise<void> {
        if (!this._view) return;
        let candidates: Array<{
            service: string;
            url: string | null;
            ports: Array<{ port: number; protocol: 'http' | 'mixed' | 'socks5'; url: string; usable: boolean }>;
        }> = [];
        try {
            candidates = (await detectLocalProxies()).map((c) => ({
                service: c.service,
                url: c.url,
                ports: c.ports.map((p) => ({
                    port: p.port,
                    protocol: p.protocol,
                    url: p.url,
                    usable: p.usable,
                })),
            }));
        } catch {
            candidates = [];
        }
        this._view.webview.postMessage({ type: 'proxyDetectResult', candidates });
    }

    /** Live connectivity check through the CURRENT resolution. When a proxy
     *  is configured the PROXY itself is verified first (TCP probe) and every
     *  target is FORCED through it: a target that answers on its own (a
     *  localhost runtime matching no_proxy) must never prove a dead proxy
     *  works. Planning + verdict shaping are pure (src/proxyTest.ts); every
     *  failure carries an i18n key, never baked English. */
    async _testProxyConnection(): Promise<void> {
        if (!this._view) return;
        const post = (result: ProxyTestResult) => {
            this._view?.webview.postMessage({
                type: 'proxyTestResult',
                ok: result.ok,
                ...(result.detailKey ? { detailKey: result.detailKey } : {}),
                ...(result.params ? { params: result.params } : {}),
            });
        };
        const resolution = getProxyResolution();
        let providerUrl: string | null = null;
        try {
            providerUrl = (await this._getLlmCredentials()).llm_base_url ?? null;
        } catch { /* no active provider - generic endpoints still answer */ }
        const plan = planProxyTest({
            proxyUrl: resolution.url,
            providerUrl,
            providerIsLocal: !!providerUrl && isLikelyLocalUrl(providerUrl),
        });
        if (plan.blockedKey) {
            post({ ok: false, detailKey: plan.blockedKey });
            return;
        }
        // "Connection refused" to the proxy IS the diagnosis - say so before
        // any endpoint can drown it in a generic timeout.
        if (resolution.url) {
            const proxyFailure = await probeProxyReachable(resolution.url);
            if (proxyFailure) {
                post({ ok: false, detailKey: 'proxyDetailProxyDead', params: proxyFailure });
                return;
            }
        }
        const outcomes = await Promise.all(plan.targets.map(async ({ url, throughProxy }) => {
            let host = url;
            try {
                host = new URL(url).host;
            } catch { /* keep the raw string for the report */ }
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 10000);
                let response: Response;
                try {
                    const init: RequestInit & { dispatcher?: unknown } = {
                        signal: controller.signal,
                        redirect: 'follow',
                    };
                    // 'proxy' forces the proxy even past no_proxy - testing
                    // the proxy must never fall back to a direct path.
                    const dispatcher = getProxyDispatcher(url, throughProxy ? 'proxy' : undefined);
                    if (dispatcher) init.dispatcher = dispatcher;
                    response = await proxyFetch(url, init);
                } finally {
                    clearTimeout(timer);
                }
                // Any real HTTP answer means the route works - even 401
                // (needs a key) or 404 (wrong path) came back THROUGH it.
                return {
                    ok: response.status < 500,
                    detailKey: 'proxyDetailHttp',
                    params: { status: String(response.status), host },
                } as ProxyTestOutcome;
            } catch (err: any) {
                return {
                    ok: false,
                    detailKey: err?.name === 'AbortError' ? 'proxyDetailTimeout' : 'proxyDetailFetchFailed',
                    params: err?.name === 'AbortError'
                        ? { host }
                        : { message: String(err?.message ?? err), host },
                } as ProxyTestOutcome;
            }
        }));
        post(summarizeProxyTest(outcomes));
    }

    /** TCP-connect the proxy endpoint itself. Returns null when it accepts
     *  connections, else the { endpoint, reason } params for the "proxy
     *  unreachable" report - the single most useful diagnosis when the
     *  connection to the proxy is dead. */

    /** Push the live marketplace. The fetch happens HERE, never in the
     *  webview: its CSP is `connect-src 'none'`, and the host is where the
     *  proxy, timeouts and size caps live. `query` echoes back so the webview
     *  can drop a stale response that lost the debounce race. */
    async _sendMarketplaceState(options: { query?: string; force?: boolean } = {}): Promise<void> {
        if (!mcpMarketplaceInstance || !this._view) return;
        const query = options.query ?? '';
        let state: MarketplaceState;
        try {
            state = await mcpMarketplaceInstance.load({ query, force: options.force === true });
        } catch (err) {
            console.error('xratu: MCP marketplace load failed', err);
            state = {
                entries: [],
                tagLabels: {},
                sources: [],
                status: 'offline',
                fetchedAt: null,
                error: err instanceof Error ? err.message : String(err),
                liveSearch: false,
            };
        }
        this._view.webview.postMessage({ type: 'mcpMarketplaceState', ...state, query });
    }

    /** Opt-in README detection for an entry a catalog shipped without install
     *  metadata. The entry is looked up in the LAST LOADED catalog by id - a
     *  webview-supplied URL would let the page make the host fetch anything. */
    async _sendMarketplaceDetection(id: string): Promise<void> {
        if (!mcpMarketplaceInstance || !this._view) return;
        const entry = id ? mcpMarketplaceInstance.findEntry(id) : null;
        if (!entry) {
            this._view.webview.postMessage({ type: 'mcpMarketplaceDetected', id, install: null, confidence: 'none' });
            return;
        }
        try {
            const detected = await mcpMarketplaceInstance.detectFromReadme(entry);
            this._view.webview.postMessage({
                type: 'mcpMarketplaceDetected',
                id,
                install: detected.install,
                confidence: detected.installConfidence,
            });
        } catch (err) {
            console.error('xratu: MCP marketplace README detection failed', err);
            this._view.webview.postMessage({ type: 'mcpMarketplaceDetected', id, install: null, confidence: 'none' });
        }
    }

    /** MCP page saves are dispatched concurrently by the webview message
     *  handler - serialize write → echo-marker → reload → state-push so an
     *  earlier save can never complete out of order (or have its echo
     *  consumed by a later save's watcher event). */
    private _mcpSaveQueue: Promise<unknown> = Promise.resolve();

    _saveMcpConfig(target: McpSaveTarget, servers: ExternalServerConfig[]): Promise<void> {
        const run = this._mcpSaveQueue.then(() => this._saveMcpConfigNow(target, servers), () => this._saveMcpConfigNow(target, servers));
        this._mcpSaveQueue = run.catch(() => undefined);
        return run;
    }

    private async _saveMcpConfigNow(target: McpSaveTarget, servers: ExternalServerConfig[]): Promise<void> {
        if (!externalMcpInstance || !mcpConfigStoreInstance) return;
        const map: Record<string, ExternalServerConfig> = {};
        for (const entry of Array.isArray(servers) ? servers : []) {
            const name = String((entry as { name?: unknown }).name ?? '').trim();
            if (!name) continue;
            const { name: _n, state: _s, toolCount: _t, lastError: _l, source: _src, ...cfg } = entry as ExternalServerConfig & Record<string, unknown>;
            map[name] = cfg as ExternalServerConfig;
        }
        // The page only sees the MERGED view (workspace wins per key over
        // global), so rebuilding the global file from its rows alone would
        // silently delete a global entry shadowed by a same-name workspace
        // override. Re-attach the invisible entries - payload names win if
        // the user explicitly wrote a server with that name.
        if (target === 'global') {
            const current = await mcpConfigStoreInstance.load();
            for (const [name, cfg] of Object.entries(current.shadowedGlobalEntries)) {
                if (!(name in map)) map[name] = cfg;
            }
        }
        // The config-file watcher fires on this write too - arm the pending
        // marker (path + content hash) so the watcher consumes its echo
        // instead of double-reloading (each reload restarts the stdio
        // servers).
        const writeTarget = target === 'workspace' ? mcpConfigStoreInstance.workspacePath : mcpConfigStoreInstance.globalPath;
        if (writeTarget) {
            const written = JSON.stringify({ mcpServers: map }, null, 2) + '\n';
            this._mcpPageWritePending = {
                path: writeTarget,
                hash: crypto.createHash('sha256').update(written, 'utf-8').digest('hex'),
            };
            if (this._mcpPageWriteTimer) clearTimeout(this._mcpPageWriteTimer);
            this._mcpPageWriteTimer = setTimeout(() => {
                this._mcpPageWritePending = null;
                this._mcpPageWriteTimer = null;
            }, 10_000);
        }
        await mcpConfigStoreInstance.save(target, map);
        await externalMcpInstance.reload();
        await this._sendMcpState();
    }

    /** Raw mcp.json edits (the MCP page's "Edit raw JSON" opens the file in
     *  the editor): drop cached connections and re-push the page state.
     *  Called debounced by the file watchers with the changed path; an event
     *  whose file still hashes to the page's just-written content is the
     *  save's own echo and is consumed without a redundant reload. Omitting
     *  the path (workspace-trust transitions) always reloads. */
    public async reloadMcpFromDisk(changedPath?: string): Promise<void> {
        if (!externalMcpInstance) return;
        const pending = this._mcpPageWritePending;
        if (pending && changedPath && sameMcpPath(pending.path, changedPath)) {
            let echo = false;
            try {
                const current = fs.readFileSync(changedPath);
                echo = crypto.createHash('sha256').update(current).digest('hex') === pending.hash;
            } catch {
                echo = false;
            }
            this._mcpPageWritePending = null;
            if (this._mcpPageWriteTimer) {
                clearTimeout(this._mcpPageWriteTimer);
                this._mcpPageWriteTimer = null;
            }
            if (echo) return;
        }
        await externalMcpInstance.reload();
        await this._sendMcpState();
    }

    /** Discover Agent Skills for the upcoming run, minus user-disabled ones.
     *  Never throws - a broken skills directory must not kill a run. */
    private _discoverSkillsForRun(workspaceRoot: string): DiscoveredSkill[] {
        try {
            return listableSkills(
                discoverSkills({ workspaceRoot: workspaceRoot || undefined }),
                new Set(this._disabledSkillIds()),
            );
        } catch {
            return [];
        }
    }

    /** Raw disabled-skill store: `source:name` ids (current scheme) plus any
     *  pre-id bare names, which keep working via the name fallback. */
    private _disabledSkillIds(): string[] {
        const raw = this._globalState.get<string>('xratu.disabledSkills');
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }

    async _setSkillEnabled(id: string, enabled: boolean): Promise<void> {
        const id0 = String(id ?? '').trim();
        if (!id0) return;
        const set = new Set(this._disabledSkillIds());
        if (enabled) {
            // Drop both the exact id and any stale bare-name entry.
            set.delete(id0);
            const name = id0.includes(':') ? id0.slice(id0.indexOf(':') + 1) : '';
            if (name) set.delete(name);
        } else {
            set.add(id0);
        }
        await this._globalState.update('xratu.disabledSkills', JSON.stringify(Array.from(set).sort()));
    }

    /** Push the transcript display prefs. An empty blob is a valid state: the
     *  webview resolves every missing id to its own default. */
    _sendTranscriptPrefs(): void {
        if (!this._view) return;
        this._view.webview.postMessage({
            type: 'transcriptPrefs',
            prefs: parseTranscriptPrefs(this._globalState.get<string>('xratu.transcriptPrefs')),
        });
    }

    async _setTranscriptPref(id: string, enabled: boolean): Promise<void> {
        const prefs = withTranscriptPref(
            parseTranscriptPrefs(this._globalState.get<string>('xratu.transcriptPrefs')),
            id,
            enabled,
        );
        await this._globalState.update('xratu.transcriptPrefs', JSON.stringify(prefs));
    }

    /** Push the Skills page view: discovered skills (valid, invalid, and
     *  shadowed) with enabled flags and folder paths for reveal actions. */
    async _sendSkillsState(): Promise<void> {
        if (!this._view) return;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const disabled = new Set(this._disabledSkillIds());
        let skills: DiscoveredSkill[] = [];
        try {
            skills = discoverSkills({ workspaceRoot: root || undefined });
        } catch {
            skills = [];
        }
        // Auto-renamed folders leave editor tabs on the old path - close
        // them so a later save cannot resurrect the old folder.
        if (skills.some((s) => s.renamedFrom)) {
            for (const s of skills) {
                if (s.renamedFrom) {
                    await closeStaleSkillEditors(
                        path.join(path.dirname(s.dirPath), s.renamedFrom),
                        s.dirPath,
                    );
                }
            }
            // The carried-over editor buffer may itself contain a NEWER
            // name than disk had at scan time - rescan once so the state
            // pushed below is already final (one refresh, not two).
            try {
                skills = discoverSkills({ workspaceRoot: root || undefined });
            } catch {
                /* keep the first scan */
            }
        }
        const isEnabled = (s: DiscoveredSkill): boolean =>
            !s.error && !s.shadowed && !disabled.has(skillId(s.source, s.name)) && !disabled.has(s.name);
        this._view.webview.postMessage({
            type: 'skillsState',
            skills: skills.map((s) => ({
                id: skillId(s.source, s.name),
                name: s.name,
                description: s.description,
                dirPath: s.dirPath,
                source: s.source,
                bodyChars: s.bodyChars,
                error: s.error ?? null,
                shadowed: !!s.shadowed,
                enabled: isEnabled(s),
            })),
        });
    }


    /** Scaffold a unique `new-skill` folder in the global skills directory
     *  and return its path (null when the directory cannot be created). */
    async _createSkillScaffold(): Promise<string | null> {
        const globalSkills = path.join(os.homedir(), '.agents', 'skills');
        try {
            await fs.promises.mkdir(globalSkills, { recursive: true });
        } catch {
            return null;
        }
        let name = 'new-skill';
        for (let n = 2; await isDir(path.join(globalSkills, name)); n++) {
            name = `new-skill-${n}`;
        }
        const dir = path.join(globalSkills, name);
        try {
            await fs.promises.mkdir(dir, { recursive: true });
        } catch {
            return null;
        }
        return dir;
    }

    /** Settings "Clear history": wipe EVERY stored session on this machine,
     *  then land in a fresh empty one. The active session is invalidated
     *  BEFORE the deletions so an in-flight or pending persist cannot
     *  resurrect a directory mid-clear, reconciliation runs before the
     *  listing so orphaned directories and legacy snapshots are included,
     *  and deletion failures are counted, not fatal - the clear proceeds
     *  with an honest error afterward. */
    async _clearAllSessions(): Promise<void> {
        this._cancelActiveRequests();
        this._sessionEpoch++;
        // Mirror the run-loop finally: a pending partial flush must not fire
        // against a session we are about to invalidate and delete.
        this._localPendingTurn = null;
        if (this._localPartialTimer) {
            clearTimeout(this._localPartialTimer);
            this._localPartialTimer = null;
        }
        // The abort above is asynchronous - the run loop unwinds on a later
        // event. Await its settlement so the fresh session is not exposed
        // while the dead run can still write, and a steer aimed at the old
        // run cannot fall into the epoch-drop path unanswered. If the run
        // refuses to settle, ABORT the clear: proceeding from here would
        // recreate exactly the race this flow exists to prevent.
        if (this._localRunSettled) {
            const settled = await Promise.race([
                this._localRunSettled,
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
            ]);
            if (settled === false) {
                this._view?.webview.postMessage({ type: 'error', valueKey: 'clearHistoryBusy' });
                return;
            }
        }
        this._sessionEpoch++;
        this._resetSessionLedgers();

        let failed = 0;
        try {
            // list() reads only the index - reconcile first so orphaned
            // session directories and eligible legacy snapshots are covered.
            await this._localSessionStore.reconcile(this._localWorkspaceKey());
            const all = await this._localSessionStore.list();
            for (const meta of all) {
                const ok = await this._localSessionStore.delete(meta.id);
                if (!ok) failed++;
            }
        } catch (e) {
            console.error('xratu: clear all sessions failed', e);
            failed++;
        }
        // Per-session task-list overrides live in global state - wipe them
        // with the sessions, before the fresh empty one is created.
        this._taskListEdits = {};
        await this._saveTaskListEdits();
        await this.clearHistory();
        if (failed > 0) {
            this._view?.webview.postMessage({
                type: 'error',
                valueKey: 'clearHistoryIncomplete',
                params: { count: String(failed) },
            });
        }
    }

    /** Permanently remove a skill folder. Caller supplies a webview path -
     *  guarded to known skills locations. */
    async _deleteSkillFolder(dirPath: string): Promise<void> {
        if (!(await isDir(dirPath)) || !(await isKnownSkillsPath(dirPath))) return;
        try {
            await fs.promises.rm(dirPath, { recursive: true, force: true });
        } catch (e) {
            console.error('xratu: skill delete failed', e);
        }
    }


    private _restoreChatUI() {
        if (!this._view) return;
        // Replay never streams chunks - any stale segment state from an
        // errored turn must not leak into the replayed bubbles.
        this._resetLiveSegments();
        for (const msg of this._history) {
            if (msg.role === 'user') {
                this._view.webview.postMessage({ type: 'restoreUser', value: msg.content, attachments: msg.attachments, cp: msg.cp });
            } else if (msg.role === 'assistant') {
                if (Array.isArray(msg.events) && msg.events.length > 0) {
                    this._view.webview.postMessage({ type: 'startResponse' });
                    for (const parsed of msg.events) {
                        if (parsed.type === 'thinking') {
                            this._view.webview.postMessage({ type: 'thinking', value: parsed.content });
                            this._view.webview.postMessage({ type: 'thinkingHtml', value: this._renderMarkdown(parsed.content, true) });
                        } else if (parsed.type === 'tool_call') {
                            this._view.webview.postMessage({
                                type: 'toolCall',
                                tool: parsed.tool,
                                args: JSON.stringify(parsed.args, null, 2),
                                callId: parsed.id ?? undefined
                            });
                        } else if (parsed.type === 'tool_result') {
                            this._view.webview.postMessage({
                                type: 'toolResult',
                                tool: parsed.tool,
                                output: parsed.output,
                                callId: parsed.id ?? undefined
                            });
                        } else if (parsed.type === 'result') {
                            this._displayAssistantResponse(parsed);
                        }
                    }
                } else if (msg.content) {
                    this._displayAssistantResponse({ persian_explanation: msg.content });
                }
            }
        }
    }

    private _renderMarkdown(text: string, live = false): string {
        const source = live ? closeOpenFence(text) : text;
        const rawHtml = (live ? mdLive : md).render(source);
        // Sanitize before sending to webview - allowlist-based, not regex blocklist
        return _sanitizeHtml(rawHtml);
    }

    _localWorkspaceKey(): string {
        const folder = vscode.workspace.workspaceFolders?.[0];
        return folder?.uri.fsPath || 'default';
    }

    // ------------------------------------------------------------------
    // Session management (multi-session: create / list / switch / rename
    // / delete) - sessions live in the LocalSessionStore. The toolbar's
    // centered title button drives
    // all of it through the webview protocol.
    // ------------------------------------------------------------------

    private static readonly TITLE_MAX_LEN = 48;

    private _workspaceName(): string {
        const activeEditor = vscode.window.activeTextEditor;
        const folder = (activeEditor && vscode.workspace.getWorkspaceFolder(activeEditor.document.uri))
            || vscode.workspace.workspaceFolders?.[0];
        return folder?.name || 'default';
    }

    private _deriveSessionTitle(text: string): string {
        const clean = text.replace(/\s+/g, ' ').trim();
        if (!clean) return this._workspaceName();
        // Code-point truncation (mirrors LocalSessionStore) - UTF-16
        // slicing would split a surrogate pair at the boundary.
        const chars = Array.from(clean);
        return chars.length > XratuChatViewProvider.TITLE_MAX_LEN
            ? chars.slice(0, XratuChatViewProvider.TITLE_MAX_LEN).join('') + '…'
            : clean;
    }

    /** Legacy key shape preserved verbatim - existing installs already
     *  persist their last-active session under it (the `xratu.lastLocalSession`
     *  branch was dead code: `_localRuntime` was never set). */
    private _lastSessionStateKey(): string {
        return `xratu.lastSession.${this._workspaceName()}`;
    }

    /** Echo current session identity to the webview (toolbar title button). */
    private _pushSessionState(): void {
        this._view?.webview.postMessage({
            type: 'sessionState',
            id: this._sessionId,
            title: this._sessionTitle,
        });
        // The checklist + progress chip are per-session: every session
        // switch re-echoes the merged task list for the NEW session.
        this._pushTaskListState();
        // Cumulative session spend is per-session too (and monotonic).
        this._postSessionCost();
    }

    /** Reset the per-session ledgers. Callers own cancel + epoch bump. */
    private _resetSessionLedgers(): void {
        this._forgetSubagentRuns();
        this._sessionId = null;
        // A new conversation gets a fresh OpenCode session id.
        this._ephemeralSessionId = null;
        this._history = [];
        this._localHistory = [];
        this._localEvictedUserTurns = 0;
        this._localReplayUserTurns = null;
        this._compactionRunReplayBase = null;
        this._localRulesSnapshot.reset();
        this._sessionSummary = null;
        this._sessionTitle = null;
        // A brand-new session starts its own spend counter.
        this._sessionCost = { USD: 0, IRT: 0 };
        this._resetSessionUsage();
        this._approvalCloseItems = {};
        this._sessionApprovedKinds.clear();
        this._virtualDocuments.clear();
        // Edit snapshots are per-session: the new session's ids never collide,
        // and the args fallback covers anything restored later.
        this._editSnapshots.clear();
    }

    private async _reloadWebviewChat(): Promise<void> {
        if (!this._view) return;
        // webview.html reload destroys the old page; the template defaults to
        // welcome-screen shown. The fresh page sends webviewReady, whose
        // handler runs _showStartScreen() exactly once - never call it here
        // too: both calls replay the chat history and every message renders
        // TWICE on the fresh page (hello, response, hello, response).
        this._view.webview.html = this._getHtmlForWebview(this._view.webview);
    }

    /** Session picker listing for the webview. With `all` the list spans
     *  every workspace; otherwise it is scoped to the current one. */
    async _listSessions(all: boolean): Promise<void> {
        const metas = await this._localSessionStore.list(all ? undefined : this._localWorkspaceKey());
        const items = metas.map((m) => ({ id: m.id, title: m.title, workspace: m.workspace, updatedAt: m.updatedAt }));
        this._view?.webview.postMessage({ type: 'sessionList', items, currentId: this._sessionId });
    }

    /** Full-text search across stored sessions (session-picker search box). */
    async _searchSessions(query: string, all: boolean, requestId?: number): Promise<void> {
        const metas = await this._localSessionStore.search(query, all ? undefined : this._localWorkspaceKey());
        const items = metas.map((m) => ({ id: m.id, title: m.title, workspace: m.workspace, updatedAt: m.updatedAt }));
        this._view?.webview.postMessage({ type: 'sessionSearchResults', query, requestId, items });
    }

    /** Session transitions (switch/create) are dispatched concurrently by
     *  the webview message handler - serialize them so a stale load/create
     *  cannot overwrite a newer transition's session state. */
    private _sessionTransitionQueue: Promise<unknown> = Promise.resolve();

    _serializeSessionTransition<T>(fn: () => Promise<T>): Promise<T> {
        const run = this._sessionTransitionQueue.then(fn, fn);
        this._sessionTransitionQueue = run.catch(() => undefined);
        return run;
    }

    /** Swap the visible session to `id`. Allowed while a run streams: the
     *  live run is cancelled first (the epoch bump keeps its settled state
     *  out of the new session's view), then the webview reloads so
     *  streaming state starts clean. Serialized against clearHistory. */
    _openSession(id: string): Promise<void> {
        return this._serializeSessionTransition(() => this._openSessionNow(id));
    }

    private async _openSessionNow(id: string): Promise<void> {
        this._cancelActiveRequests();
        // The abort above is asynchronous - await the dead run's settlement
        // so buffered events and its throttled save cannot render into, or
        // persist over, the session we are about to expose. A run that
        // refuses to settle ABORTS the switch: proceeding would let its
        // events write into the new session.
        if (this._localRunSettled) {
            const settled = await Promise.race([
                this._localRunSettled,
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
            ]);
            if (settled === false) {
                this.notifyBanner('warning', 'sessionSwitchBusy');
                return;
            }
        }
        this._sessionEpoch++;
        this._resetSessionLedgers();

        const snapshot = await this._localSessionStore.load(id);
        if (!snapshot) {
            this.notifyBanner('warning', 'sessionLoadFailed');
            return;
        }
        this._sessionId = snapshot.sessionId;
        this._localHistory = snapshot.localHistory;
        this._history = snapshot.uiHistory as HistoryMessage[];
        this._deriveEvictedUserTurns();
        this._restoreReplayBoundary(snapshot.replayUserTurns);
        // Restore the session's cumulative spend (reset by _resetSessionLedgers
        // above) - switching sessions must not zero an existing total.
        this._sessionCost = {
            USD: snapshot.totalCostUsd ?? 0,
            IRT: snapshot.totalCostIrt ?? 0,
        };
        this._restoreSessionUsage(snapshot);
        this._sessionSummary = snapshot.summary ?? null;
        // A stored title that is still the workspace placeholder reads as
        // untitled - otherwise the placeholder blocks first-message seeding
        // and is locked in as renamedTitle on the next save.
        this._sessionTitle = resolveSessionTitle(snapshot.title, snapshot.renamed, snapshot.workspace, snapshot.uiHistory);
        if (snapshot.model) {
            this._selectedModel = snapshot.model;
            void this._rememberModelForActiveCredential(snapshot.model);
        }
        await this._globalState.update(this._lastSessionStateKey(), this._sessionId);
        await this._reloadWebviewChat();
    }

    /** Start a brand-new session (toolbar +, Settings entry). Previously
     *  "clear history" - which DESTROYED the conversation; multi-session
     *  keeps it and creates a fresh one instead. */
    public clearHistory(): Promise<void> {
        return this._serializeSessionTransition(() => this._clearHistoryNow());
    }

    private async _clearHistoryNow() {
        // A live stream must die WITH the session: without this, the zombie
        // run keeps consuming events and writes its result (or its cancel
        // bookkeeping) into the freshly created session.
        this._cancelActiveRequests();
        // Same settlement wait as _openSession - a run that refuses to
        // settle ABORTS the switch instead of racing the fresh session.
        if (this._localRunSettled) {
            const settled = await Promise.race([
                this._localRunSettled,
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
            ]);
            if (settled === false) {
                this._view?.webview.postMessage({ type: 'error', valueKey: 'clearHistoryBusy' });
                return;
            }
        }
        this._sessionEpoch++;
        this._resetSessionLedgers();

        try {
            const meta = await this._localSessionStore.create(this._localWorkspaceKey());
            this._sessionId = meta.id;
            this._sessionTitle = null;
        } catch (e) {
            console.error('xratu: create local session failed', e);
        }
        await this._globalState.update(this._lastSessionStateKey(), this._sessionId);
        await this._reloadWebviewChat();
    }

    /** Rename a session (picker inline edit); persists in the local store. */
    async _renameSession(id: string, title: string): Promise<void> {
        const clean = title.replace(/\s+/g, ' ').trim();
        if (!clean) return;
        await this._localSessionStore.rename(id, clean);
        if (id === this._sessionId) {
            this._sessionTitle = clean.slice(0, 128);
            this._pushSessionState();
        }
        await this._listSessions(false);
    }

    /** Hard-delete a session (picker context action; the webview confirms).
     *  Deleting the OPEN session falls back to a fresh empty one. */
    async _deleteSession(id: string): Promise<void> {
        await this._localSessionStore.delete(id);
        if (this._taskListEdits[id]) {
            delete this._taskListEdits[id];
            void this._saveTaskListEdits().catch((e) =>
                console.error('xratu: task list edit persist failed:', e));
        }
        if (id === this._sessionId) {
            await this.clearHistory();
            return;
        }
        await this._listSessions(false);
    }

    /** Reopen the last-active LOCAL session for this workspace (or the
     *  preferred id already held in memory). Empty result = clean slate. */
    private async _restoreLocalSession(): Promise<void> {
        const preferred = this._sessionId ?? this._globalState.get<string>(this._lastSessionStateKey());
        const meta = await this._localSessionStore.findCurrent(this._localWorkspaceKey(), preferred);
        if (!meta) {
            this._forgetSubagentRuns();
            this._sessionId = null;
            this._ephemeralSessionId = null;
            this._history = [];
            this._localHistory = [];
            this._localEvictedUserTurns = 0;
            this._localReplayUserTurns = null;
            this._compactionRunReplayBase = null;
            this._localRulesSnapshot.reset();
            this._sessionSummary = null;
            this._sessionTitle = null;
            this._sessionCost = { USD: 0, IRT: 0 };
            this._resetSessionUsage();
            return;
        }
        const snapshot = await this._localSessionStore.load(meta.id);
        if (!snapshot) {
            this._forgetSubagentRuns();
            this._sessionId = null;
            this._ephemeralSessionId = null;
            this._history = [];
            this._localHistory = [];
            this._localEvictedUserTurns = 0;
            this._localReplayUserTurns = null;
            this._compactionRunReplayBase = null;
            this._localRulesSnapshot.reset();
            this._sessionSummary = null;
            this._sessionTitle = null;
            this._sessionCost = { USD: 0, IRT: 0 };
            this._resetSessionUsage();
            return;
        }
        this._localHistory = snapshot.localHistory;
        this._history = snapshot.uiHistory as HistoryMessage[];
        this._deriveEvictedUserTurns();
        this._restoreReplayBoundary(snapshot.replayUserTurns);
        // Adopting a stored session REPLACES the live chat identity. A stale
        // ephemeral id (from the chat this webview was showing before the
        // reload) must not survive as the subagent-registry key, or the
        // restored chat could resolve a task_id against the PREVIOUS chat's
        // runs - one conversation's context leaking into another. Forgetting
        // here costs a resume; the alternative costs isolation, so forget.
        if (this._ephemeralSessionId) {
            this._forgetSubagentRuns();
            this._ephemeralSessionId = null;
        }
        this._sessionId = snapshot.sessionId;
        // Cumulative spend survives a rewind (tokens were already spent).
        this._sessionCost = {
            USD: snapshot.totalCostUsd ?? 0,
            IRT: snapshot.totalCostIrt ?? 0,
        };
        this._restoreSessionUsage(snapshot);
        this._sessionSummary = snapshot.summary ?? null;
        // Same placeholder rule as _openSessionNow - see resolveSessionTitle.
        this._sessionTitle = resolveSessionTitle(snapshot.title, snapshot.renamed, snapshot.workspace, snapshot.uiHistory);
        this._selectedModel = snapshot.model || this._selectedModel;
        if (snapshot.model) void this._rememberModelForActiveCredential(snapshot.model);
        if (snapshot.pendingTurn?.prompt) {
            // Crash mid-run: fold the interrupted turn into the ledgers
            // exactly like the cancel path - the partial pills/text stay
            // visible and the model replays its tool context (dangling
            // tool calls get placeholder results). Persisted back WITHOUT
            // the pendingTurn below so it can never restore twice.
            const pt = snapshot.pendingTurn;
            const restoredEvents: any[] = [];
            // Legacy snapshots stored reasoning only on the side (pt.thinking);
            // newer ones record it as an ordered event inside pt.events.
            // Prepending the side copy when an event already exists would
            // duplicate (and misorder) the reasoning pill.
            const hasThinkingEvent = (pt.events ?? []).some((e: any) => e?.type === 'thinking');
            if (pt.thinking && !hasThinkingEvent) {
                restoredEvents.push({ type: 'thinking', content: clipHistoryContent(pt.thinking, MAX_CONTENT_CAP) });
            }
            restoredEvents.push(...(pt.events ?? []).map(trimDisplayEvent));
            if (pt.text) restoredEvents.push({ type: 'result', persian_explanation: pt.text });
            this._history.push({
                role: 'user',
                content: pt.prompt,
                ...(pt.attachments?.length ? { attachments: pt.attachments } : {}),
            });
            // Steered user messages were real turns: mirror the success path so
            // the display ledger keeps the SAME user-turn count as the model
            // ledger. Without this a crash mid-run with a steer left the two
            // ledgers one turn apart and rewind mapped the wrong row.
            for (const event of pt.events ?? []) {
                if (event.type === 'steer_user') {
                    this._history.push({
                        role: 'user',
                        content: event.text,
                        ...(event.attachments?.length ? { attachments: event.attachments } : {}),
                    });
                }
            }
            if (restoredEvents.length > 0) {
                this._history.push({ role: 'assistant', events: restoredEvents, content: '' });
            }
            this._pushLocalHistory({ role: 'user', content: pt.prompt });
            for (const event of pt.events ?? []) {
                const row = historyRowFromEvent(event);
                if (row) this._pushLocalHistory(row);
            }
            const answered = new Set(
                this._localHistory.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
            );
            for (const m of this._localHistory) {
                for (const tc of m.tool_calls ?? []) {
                    if (!answered.has(tc.id)) {
                        this._pushLocalHistory({ role: 'tool', tool_call_id: tc.id, content: '[interrupted by a crash]' });
                        answered.add(tc.id);
                    }
                }
            }
            // The fold above added rows to BOTH ledgers; re-derive so a legacy
            // snapshot whose steer events had no display rows cannot leave the
            // offset stale.
            this._deriveEvictedUserTurns();
            await this._persistLocalSession().catch((e) => {
                console.error('xratu: local session persist failed:', e);
            });
        }
        await this._globalState.update(this._lastSessionStateKey(), this._sessionId);
    }

    /** Throttled mid-run snapshot: persist the IN-FLIGHT local turn every
     *  5s so a host crash loses at most the last few seconds instead of the
     *  whole turn. Restored via `pendingTurn` in _restoreLocalSession. */
    private _scheduleLocalPartialPersist(): void {
        if (this._localPartialTimer) return;
        this._localPartialTimer = setTimeout(() => {
            this._localPartialTimer = null;
            if (!this._localPendingTurn) return;
            this._persistLocalSession().catch((e) => {
                console.error('xratu: local partial persist failed:', e);
            });
        }, 5000);
    }

    private async _persistLocalSession(): Promise<void> {
        // Bound the model ledger BEFORE snapshotting: one choke point covers
        // both turn commits and the 5s mid-run partial persist, and keeps the
        // on-disk copy consistent with what is in memory.
        this._trimLocalHistory();
        const epochAtEntry = this._sessionEpoch;
        if (!this._sessionId) {
            // First send with no open local session (fresh install, or the
            // last snapshot was cleared) - create one on demand or history
            // would never persist.
            try {
                const meta = await this._localSessionStore.create(this._localWorkspaceKey());
                if (epochAtEntry !== this._sessionEpoch) {
                    // The session was invalidated while creating (clear
                    // history / open session) - do not adopt the stray.
                    void this._localSessionStore.delete(meta.id).catch(() => undefined);
                    return;
                }
                this._sessionId = meta.id;
            } catch (e) {
                console.error('xratu: create local session failed', e);
                return;
            }
        }
        if (epochAtEntry !== this._sessionEpoch) {
            // Invalidated mid-persist - saving would resurrect a deleted
            // session directory under an already-stale id.
            return;
        }
        const sessionIdAtEntry = this._sessionId;
        const titleWasNull = this._sessionTitle == null;
        const hasUserTurn = this._history.some((m) => m.role === 'user');
        const saved = await this._localSessionStore.save(
            this._sessionId!,
            {
                workspace: this._localWorkspaceKey(),
                model: this._selectedModel,
                summary: this._sessionSummary,
                localHistory: this._localHistory,
                replayUserTurns: this._localReplayUserTurns,
                uiHistory: this._history,
                totalCostUsd: this._sessionCost.USD,
                totalCostIrt: this._sessionCost.IRT,
                totalInputTokens: this._sessionUsage.input,
                totalOutputTokens: this._sessionUsage.output,
                totalCachedTokens: this._sessionUsage.cached,
                usageByHost: this._sessionUsageByHost,
                pendingTurn: this._localPendingTurn ? {
                    prompt: this._localPendingTurn.prompt,
                    events: this._localPendingTurn.events,
                    text: this._localAccumulatedText,
                    thinking: this._localAccumulatedThinking,
                    ...(this._localPendingTurn.attachments?.length
                        ? { attachments: this._localPendingTurn.attachments }
                        : {}),
                } : null,
            },
            this._sessionTitle ?? undefined,
            // Persist at the SAME window-relative cap the run keeps in memory,
            // so a reload restores what memory held instead of a silently
            // shortened copy of it (the reload-loss sawtooth).
            contentCapForWindow(this._contextWindowHint())
        );
        // The store derives the title from the first user message when the
        // user has not renamed the session - adopt it so the toolbar shows
        // the real name without a reload. Only after a user turn is actually
        // ledgered (a mid-run partial persist has no user row yet, and
        // adopting the workspace placeholder there would lock it in), and
        // only if the session was not switched while the save was in flight
        // - a stale adoption would pin the OLD session's title onto the new
        // one.
        if (
            saved &&
            titleWasNull &&
            hasUserTurn &&
            epochAtEntry === this._sessionEpoch &&
            this._sessionId === sessionIdAtEntry
        ) {
            this._sessionTitle = saved.meta.title;
            this._pushSessionState();
        }
        await this._globalState.update(this._lastSessionStateKey(), this._sessionId);
    }

    // Live markdown during streaming: text deltas accumulate here and a
    // throttled flush keeps the webview updating WHILE the answer streams
    // instead of only after the final event. The same sanitize allowlist as
    // fullResponse applies to every intermediate render.
    //
    // EVERYTHING display-transient rides ONE 100ms tick (raw chunk text,
    // cumulative thinking, segment markdown): per-delta postMessage floods the
    // host→webview bridge and re-renders the streaming bubble dozens of times
    // per second, and 'thinking' is CUMULATIVE per delta (O(n²) traffic if
    // relayed directly). Display-only - buffers never carry state the
    // fullResponse/final segment accounting depends on.
    private _liveMdText = '';
    private _liveMdTimer: ReturnType<typeof setTimeout> | null = null;
    // Timeline segmentation (parallel to the webview's text steps): chunks
    // accumulate into the CURRENT segment; every thinking/tool event closes
    // it so fullResponse can ship per-segment rendered markdown and the
    // final answer stays interleaved between the pills. Both lists reset at
    // turn start and are consumed by _displayAssistantResponse.
    private _liveSegments: string[] = [];
    private _liveSeg = '';
    // Raw text deltas not yet posted to the webview (batched into ONE
    // 'chunk' message per tick).
    private _pendingChunk = '';
    // Latest cumulative thinking text not yet posted (latest value wins).
    private _pendingThinking: string | null = null;

    private _noteStreamChunk(delta: string): void {
        this._liveMdText += delta;
        this._liveSeg += delta;
        this._pendingChunk += delta;
        this._scheduleLiveFlush();
    }

    /** Queue a cumulative thinking update for the next live tick. */
    private _noteThinking(content: string): void {
        this._pendingThinking = content;
        this._scheduleLiveFlush();
    }

    private _scheduleLiveFlush(): void {
        if (this._liveMdTimer) return;
        this._liveMdTimer = setTimeout(() => {
            this._liveMdTimer = null;
            this._flushLiveDisplay();
        }, 100);
    }

    /** One throttled flush of every transient stream display: raw chunk
     *  text first (so the raw step is up to date), then cumulative
     *  thinking, then the CURRENT SEGMENT's rendered markdown - the webview
     *  patches its trailing text step with this html so formatted markdown
     *  appears between the pills while streaming. Rendering the whole
     *  accumulated text here would duplicate earlier segments (each already
     *  has its own step). */
    private _flushLiveDisplay(): void {
        if (this._pendingChunk) {
            this._view?.webview.postMessage({ type: 'chunk', value: this._pendingChunk });
            this._pendingChunk = '';
        }
        if (this._pendingThinking !== null) {
            this._view?.webview.postMessage({ type: 'thinking', value: this._pendingThinking });
            // Rendered markdown for the thinking pill body (same throttle +
            // sanitize pipeline as text segments) - the pill renders formatted
            // reasoning instead of a raw wall of text. Cumulative, so the
            // latest value always covers the whole block.
            this._view?.webview.postMessage({ type: 'thinkingHtml', value: this._renderMarkdown(this._pendingThinking, true) });
            this._pendingThinking = null;
        }
        // A flush racing a segment close must not render an empty segment.
        if (!this._liveSeg) return;
        this._view?.webview.postMessage({
            type: 'streamHtml',
            value: this._renderMarkdown(this._liveSeg, true),
        });
    }

    /** Close the current text segment (called before every non-chunk UI
     *  event, mirroring where the webview opens a new text step). The FINAL
     *  render must happen HERE, synchronously, before the pill event posts:
     *  the tick would otherwise fire with an empty _liveSeg and drop the
     *  tail - and since the trailing step renders only its html, that text
     *  would never appear (the visible "stream stops on tool call"). */
    private _flushLiveSegment(): void {
        if (this._liveMdTimer) {
            clearTimeout(this._liveMdTimer);
            this._liveMdTimer = null;
        }
        this._flushLiveDisplay();
        if (this._liveSeg) {
            this._view?.webview.postMessage({
                type: 'streamHtml',
                value: this._renderMarkdown(this._liveSeg, true),
            });
            this._liveSegments.push(this._liveSeg);
            this._liveSeg = '';
        }
    }

    /** Cancel pending live renders - the final fullResponse takes over. */
    private _endLiveMarkdown(): void {
        if (this._liveMdTimer) {
            clearTimeout(this._liveMdTimer);
            this._liveMdTimer = null;
        }
        this._liveMdText = '';
        this._pendingChunk = '';
        this._pendingThinking = null;
    }

    /** New turn: nothing streamed yet, so the segment timeline starts empty. */
    _resetLiveSegments(): void {
        this._liveSegments = [];
        this._liveSeg = '';
    }

    _cancelActiveRequests() {
        for (const controller of this._abortControllers.values()) {
            controller.abort();
        }
        this._abortControllers.clear();
        this._rejectPendingLocalApprovals();
        this._rejectPendingLocalDecisions();
    }

    private _displayAssistantResponse(parsed: any) {
        if (!this._view) return;
        if (parsed.error || parsed.error_key) {
            // error_key (i18n key) is the committed marker of cancelled/
            // failed turns - the replay path surfaces the localized reason.
            this._view.webview.postMessage({
                type: 'error',
                value: parsed.error,
                valueKey: parsed.error_key,
                params: parsed.error_params,
            });
            return;
        }

        const renderedHtml = parsed.persian_explanation
            ? this._renderMarkdown(parsed.persian_explanation)
            : null;

        // Per-segment timeline: the webview's text steps get their FINAL
        // formatted content between the pills instead of the whole answer
        // collapsing into one bottom block. Empty for restored sessions -
        // those keep the single rendered block.
        this._flushLiveSegment();
        const segmentsHtml = this._liveSegments.length > 0
            ? this._liveSegments.map((seg) => this._renderMarkdown(seg))
            : undefined;
        this._resetLiveSegments();

        // Legacy turns (persisted before reasoning entered the event timeline)
        // carry thinking only on the result event - restore it so the pill
        // isn't lost. Newer turns replay it as an ordered timeline event, and
        // re-posting the same cumulative text here is idempotent for live runs.
        if (typeof parsed.thinking === 'string' && parsed.thinking.trim()) {
            this._view.webview.postMessage({ type: 'thinking', value: parsed.thinking });
            this._view.webview.postMessage({ type: 'thinkingHtml', value: this._renderMarkdown(parsed.thinking, true) });
        }

        this._view.webview.postMessage({
            type: 'fullResponse',
            persian: parsed.persian_explanation,
            renderedHtml: renderedHtml,
            segmentsHtml,
            usage: parsed.usage ?? null,
            contextWindow: parsed.context_window ?? null,
            usableContextTokens: parsed.usable_context_tokens ?? null
        });
    }


    /** Files dragged from the VS Code explorer: the webview only receives
     *  text/uri-list, so the HOST reads the bytes via vscode.workspace.fs,
     *  derives the MIME from the filename and echoes full attachments back. */
    private async _handleUriAttachments(uris: string[]): Promise<void> {
        if (!this._view || !uris.length) return;
        const attachments: ComposerAttachment[] = [];
        let totalBytes = 0;
        let error: { key: string; params?: Record<string, string> } | null = null;
        for (const raw of uris.slice(0, ATTACH_MAX_COUNT)) {
            let uri: vscode.Uri;
            try {
                uri = vscode.Uri.parse(raw);
            } catch {
                continue;
            }
            const name = path.basename(uri.fsPath);
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type & vscode.FileType.Directory) {
                    error = { key: 'attachIsFolder', params: { name } };
                    continue;
                }
                if (stat.size === 0) {
                    error = { key: 'attachEmpty', params: { name } };
                    continue;
                }
                if (stat.size > ATTACH_MAX_BYTES) {
                    error = { key: 'attachTooLarge', params: { name } };
                    continue;
                }
                if (totalBytes + stat.size > ATTACH_MAX_TOTAL_BYTES) {
                    error = { key: 'attachTotalTooLarge' };
                    break;
                }
                const mime = mimeFromFilename(name);
                if (!mime || (!isImageAttachment(mime) && !isTextAttachment(mime) && !isPdfAttachment(mime))) {
                    error = { key: 'attachUnsupported', params: { name } };
                    continue;
                }
                const bytes = await vscode.workspace.fs.readFile(uri);
                totalBytes += stat.size;
                attachments.push({
                    id: `a-${crypto.randomUUID()}`,
                    name,
                    mimeType: mime,
                    size: stat.size,
                    dataBase64: Buffer.from(bytes).toString('base64'),
                });
            } catch {
                error = { key: 'attachReadError', params: { name } };
            }
        }
        if (error) {
            this._view.webview.postMessage({ type: 'composerError', value: '', valueKey: error.key, params: error.params });
        }
        if (attachments.length > 0) {
            this._view.webview.postMessage({ type: 'attachmentsFromHost', attachments });
        }
    }

    /** Workspace file list for the composer's @-mention popup. Git keep-set
     *  (tracked + untracked, .gitignore-respected) with a findFiles fallback
     *  - the SAME source the project-tree context uses, so the popup never
     *  offers node_modules/build output, and secret files are filtered even
     *  outside git. LISTING is not attaching: a user who explicitly refs
     *  .env still can (their call, same as the picker). */
    async _pushFileList(): Promise<void> {
        if (!this._view) return;
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        let files: string[] = [];
        if (wsFolder) {
            try {
                files = Array.from(await gitWorkspaceFiles(wsFolder.uri.fsPath));
            } catch (e) {
                console.error('xratu: git file list failed:', e);
            }
            if (files.length === 0) {
                try {
                    const uris = await vscode.workspace.findFiles(
                        '**/*',
                        '**/{node_modules,.git,.venv,venv,__pycache__,.mypy_cache,.pytest_cache,.ruff_cache,target,dist,out,build}/**',
                        FILE_LIST_MAX_ENTRIES + 1
                    );
                    files = uris
                        .map((u) => vscode.workspace.asRelativePath(u, false))
                        .filter((p) => !/(^|\/)\.env$|\.secrets?\.env$/.test(p));
                } catch (e) {
                    console.error('xratu: findFiles fallback failed:', e);
                }
            }
            files.sort();
            if (files.length > FILE_LIST_MAX_ENTRIES) files = files.slice(0, FILE_LIST_MAX_ENTRIES);
        }
        this._view.webview.postMessage({ type: 'fileList', files });
    }


    async _handleChatRequest(prompt: string, attachments?: ComposerAttachment[], opts?: { baseSha?: string; steerCarry?: boolean }): Promise<void> {
        if (!this._view) { return; }
        // Plan mode is captured BEFORE any await: the run later builds its
        // system prompt, toolset and approval gate from this snapshot, so a
        // toggle during pre-flight can never expose mutating tools in an
        // already-started plan turn (or vice versa).
        const planModeAtStart = this._planMode;
        // A run is already live - NEVER run a second concurrent turn (the
        // shared stream buffers would corrupt both). Route the message
        // through the steer pipeline instead: it re-checks run identity and
        // queues for the live round boundary. (Internal carry turns are
        // exempt - their parent loop owns the flag.)
        if (this._localRunActive && !opts?.steerCarry) {
            await this._handleSteer(prompt, attachments);
            return;
        }
        // Claim run ownership SYNCHRONOUSLY - before any await. Two rapid
        // askQuestion sends both passed the guard above while the first was
        // still in pre-flight (checkpoint, rules, project-tree I/O), and ran
        // CONCURRENT turns: both runs share the accumulated-text buffers, so
        // the first ends "done" with an empty transcript and dies with a
        // bogus no-response error. With the claim here, the second request
        // sees the flag set and steers instead. Every exit path - early
        // return, thrown preflight call, normal completion - runs the
        // cleanup in the outer finally below.
        this._localRunActive = true;
        this._localTurnToken += 1;
        // Completions that landed while no run was live become part of this
        // turn's context now. They are NOT auto-woken into a turn of their own:
        // a background job exiting is not the user asking for anything, and
        // starting a turn unprompted spends the user's tokens. They ride the
        // steer queue, so the loop delivers them at its first round boundary.
        if (this._pendingJobNotices.length) {
            for (const notice of this._pendingJobNotices.splice(0)) {
                this._localSteerQueue.push({ text: notice, system: true });
            }
        }
        if (!opts?.steerCarry) {
            // The run that OWNS _localRunActive publishes a settlement
            // deferred - session-wiping flows await it before exposing the
            // fresh session (steerCarry turns are owned by their parent
            // loop and must not replace it).
            this._localRunSettled = new Promise<void>((resolve) => { this._resolveRunSettled = resolve; });
        }
        // Everything this turn posts from here on belongs to THIS session
        // view - a new session (clearHistory) bumps the epoch and any
        // post-cancel bookkeeping below becomes a no-op.
        const epoch = this._sessionEpoch;
        // Ownership floor for queued steers: anything appended above this
        // length belonged to an earlier turn; this turn may only clear what
        // it accumulated (see the noRun branch). The loop cannot have
        // drained anything before the flag was set.
        const steerQueueFloor = this._localSteerQueue.length;
        // True once THIS turn actually reached the agent loop. Every pre-flight
        // early return (attachment resolution/validation/PDF, cancel before the
        // loop) leaves `false`, and its finally discards the steers that were
        // queued above the floor - otherwise they linger in the shared queue
        // and get injected into an unrelated next turn.
        let agentStarted = false;
        try {
            // Seed the display title (server applies the same truncation rule);
            // an explicit rename always wins because this only fills a null.
            if (this._sessionTitle == null && prompt.trim()) {
                this._sessionTitle = this._deriveSessionTitle(prompt);
                this._pushSessionState();
            }

            // Context ships the PROJECT TREE only - never automatic file
            // contents.  Output panels, debug consoles and webviews are
            // irrelevant here by construction; the agent reads specific files
            // through its own tools when it needs their content.
            // @-mention refs resolve FIRST (filling path-only chips with fresh
            // bytes); everything downstream validates them like any attachment.
            const refError = await resolveReferenceAttachments(attachments);
            if (refError) {
                this._view.webview.postMessage({ type: 'composerError', value: '', valueKey: refError.key, params: refError.params });
                return;
            }
            const attachValidationError = validateHostAttachments(attachments);
            if (attachValidationError) {
                this._view.webview.postMessage({ type: 'composerError', value: '', valueKey: attachValidationError.key, params: attachValidationError.params });
                return;
            }
            // PDFs become text attachments HERE (single pipeline for cloud AND
            // local); the display metadata below keeps the original pdf identity.
            const pdfExtraction = await extractPdfAttachments(attachments ?? []);
            if (pdfExtraction.error) {
                this._view.webview.postMessage({ type: 'composerError', value: '', valueKey: pdfExtraction.error.key, params: pdfExtraction.error.params });
                return;
            }
            const sendAttachments = pdfExtraction.attachments;
            const attachmentMeta: AttachmentMeta[] | undefined = attachments && attachments.length > 0
                ? attachments.map((a) => ({ name: a.name, mime_type: a.mimeType, size: a.size, path: a.path }))
                : undefined;

            this._view.webview.postMessage({ type: 'startResponse' });
            // Fresh turn: the streamed-text segment timeline starts empty.
            this._resetLiveSegments();
            // Register the cancel controller IMMEDIATELY after startResponse: the
            // pre-prompt checkpoint (shadow-git snapshot) and rules collection
            // below can take seconds, and the webview is ALREADY showing its
            // busy/stop state - cancel must work for the whole isTyping window,
            // not just once the model fetch begins. The abort checks between the
            // pre-flight steps below make the cancel take effect at the next
            // boundary.
            const controller = new AbortController();
            this._abortControllers.set('chat', controller);
            try {
                // Pre-prompt checkpoint: a no-op commit when the tree is unchanged,
                // and THE restore point when this message is later edited/resended.
                // Runs before beginTurn so the turn's lazy snapshot reuses this HEAD
                // instead of creating a second commit.  Rewind-resends skip it and
                // reuse the restored sha instead (see _rewindAndResend).
                const wsFolder = vscode.workspace.workspaceFolders?.[0];
                let prePromptSha: string | undefined = opts?.baseSha;
                if (wsFolder && !prePromptSha) {
                    try {
                        prePromptSha = await this._checkpoints.createCheckpoint(wsFolder.uri.fsPath, 'prompt');
                    } catch (e) {
                        // Non-fatal for the chat itself, but NEVER silent: a broken
                        // capture disables every future file-restore invisibly.
                        console.error('xratu: pre-prompt checkpoint failed:', e);
                    }
                }
                // New turn -> the shadow-checkpoint store may snapshot once more.
                this._checkpoints.beginTurn();

                // Cancel during the pre-flight work: settle like any other cancelled
                // turn (the webview's typing bubble flips to "Request cancelled.") -
                // nothing was streamed or ledgered yet.
                if (controller.signal.aborted) {
                    this._abortControllers.delete('chat');
                    if (epoch === this._sessionEpoch) {
                        this._view?.webview.postMessage({ type: 'error', valueKey: 'requestCancelled' });
                    }
                    return;
                }

                const rulesContext = await this._localRulesContext();

                if (controller.signal.aborted) {
                    this._abortControllers.delete('chat');
                    if (epoch === this._sessionEpoch) {
                        this._view?.webview.postMessage({ type: 'error', valueKey: 'requestCancelled' });
                    }
                    return;
                }

                // Tell the webview which bubble owns this checkpoint so its
                // restore action has a target. Posted only AFTER both preflight
                // abort checks: a cancelled turn never commits its user row, so
                // attaching a sha then would point at a missing turn. steerCarry
                // turns re-enter with their user row ALREADY ledgered, so their
                // index is one less than the user count.
                if (prePromptSha) {
                    const userCount = this._history.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0);
                    const promptUserIndex = userCount - (opts?.steerCarry ? 1 : 0);
                    if (promptUserIndex >= 0) {
                        this._view?.webview.postMessage({ type: 'userCheckpoint', userIndex: promptUserIndex, sha: prePromptSha });
                    }
                }

                // The chat cancel controller was registered right after
                // startResponse (covering checkpoint/rules work) - the loop's
                // fetches and pre-flight checks share it.
                agentStarted = true;
                const outcome = await this._runLocalAgent(prompt, rulesContext, sendAttachments, controller, planModeAtStart);
                this._endLiveMarkdown();
                // Final pass over the run-lifetime ledger before either
                // terminal path consumes it: a reasoning block (or carrier
                // pileup) that never crossed another tool push gets bounded
                // here, so what the ledgers and the snapshot retain is the
                // bounded copy.
                boundOutcomeEvents(outcome.events);
                // An empty completion (context overflow, degenerate round) must
                // read as an error, not finalize a silent empty bubble.
                if (outcome.resultEvent && !String(outcome.resultEvent.persian_explanation ?? '').trim() && outcome.events.length === 0) {
                    outcome.resultEvent = null;
                }
                if (outcome.resultEvent) {
                    this._displayAssistantResponse(outcome.resultEvent);
                    // A completed local run has ALWAYS resolved its approvals
                    // in-process (the generator resumes itself, unlike the cloud
                    // pause/resume protocol), so the turn is final - commit the
                    // full message sequence even when needsApprovalId was set.
                    // steerCarry turns re-enter with an ALREADY-ledgered user row
                    // (the carry loop below pushed it) - skip their own push.
                    if (!opts?.steerCarry) {
                        this._pushLocalHistory({ role: 'user', content: prompt });
                    }
                    for (const event of outcome.events) {
                        const row = historyRowFromEvent(event);
                        if (row) this._pushLocalHistory(row);
                    }
                    outcome.events.push({ type: 'result', ...outcome.resultEvent });

                    // Commit the turn to the ledgers BEFORE persisting - a failed
                    // snapshot write (Windows AV locking local-sessions.json) must
                    // not silently drop the turn from the in-memory history too.
                    if (!opts?.steerCarry) {
                        this._history.push({ role: "user", content: prompt, cp: prePromptSha, attachments: attachmentMeta });
                    }
                    for (const event of outcome.events) {
                        if (event.type === 'steer_user') {
                            this._history.push({
                                role: 'user',
                                content: event.text,
                                ...(event.attachments?.length ? { attachments: event.attachments } : {}),
                            });
                        }
                    }
                    this._history.push({ role: "assistant", events: outcome.events.map(trimDisplayEvent), content: JSON.stringify(outcome.resultEvent) });
                    await this._persistLocalSession().catch((e) => {
                        console.error('xratu: local session persist failed:', e);
                    });
                    // Steers typed while the model streamed its FINAL text never
                    // reached a round boundary - carry each as its own follow-up
                    // turn. The user row is ledgered HERE (steerCarry skips the
                    // nested turn's own push); the webview already rendered the
                    // bubble when it steered.
                    while (this._localSteerQueue.length > 0 && epoch === this._sessionEpoch) {
                        const carry = this._localSteerQueue.shift()!;
                        // Confirm the held bubble before the follow-up turn
                        // streams, so the user row lands above its response.
                        this._confirmSteer(carry.steerId);
                        this._pushLocalHistory({ role: 'user', content: carry.text });
                        this._history.push({
                            role: 'user',
                            content: carry.text,
                            ...(carry.meta?.length ? { attachments: carry.meta } : {}),
                        });
                        await this._persistLocalSession().catch((e) => {
                            console.error('xratu: local session persist failed:', e);
                        });
                        await this._handleChatRequest(carry.text, carry.carryAttachments, { steerCarry: true });
                    }
                } else if (outcome.aborted) {
                    // Cancelled mid-run: keep the partial turn in BOTH ledgers so
                    // the local model replays the tool/thinking context next turn,
                    // and edit/regenerate indexing stays aligned.
                    if (epoch === this._sessionEpoch) {
                        this._commitUnfinishedLocalTurn(prompt, attachmentMeta, prePromptSha, outcome, opts?.steerCarry, '[cancelled by user]');
                        await this._persistLocalSession().catch((e) => {
                            console.error('xratu: local session persist failed:', e);
                        });
                    }
                } else if (outcome.errorEvent) {
                    // Failed mid-run (provider 5xx, stream cut, malformed SSE, …):
                    // the turn was REAL - tool calls already ran, files may have
                    // changed, the task list may have been rewritten. Dropping it
                    // here is what caused "context lost after a red message": the
                    // next request replayed a history missing the entire turn, and
                    // the task list (derived from these history rows) vanished with
                    // it. Commit exactly like a cancel, placeholder-answer dangling
                    // tool calls, keep the pre-prompt checkpoint shas, and persist.
                    if (epoch === this._sessionEpoch) {
                        this._commitUnfinishedLocalTurn(prompt, attachmentMeta, prePromptSha, outcome, opts?.steerCarry, '[interrupted by error]');
                        await this._persistLocalSession().catch((e) => {
                            console.error('xratu: local session persist failed:', e);
                        });
                    }
            } else if (outcome.noRun) {
                // Pre-run guard (no credential / insecure URL / no model): the
                // run never started, the guard already posted its own error, and
                // no provider ever saw the prompt - ledger nothing, stay quiet.
                // Steers queued while THIS turn was believed live belong to it
                // and drop; the queue is shared state, so anything below the
                // floor (a concurrent run's steers) is not ours to remove. The
                // loop never started, so no drain can have shifted the indices.
                if (this._localSteerQueue.length > steerQueueFloor) {
                    this._discardQueuedSteers(steerQueueFloor);
                }
            } else {
                // Empty completion - no text, no events. Nothing streamed to
                // preserve, but the prompt itself must still join the ledger:
                // the webview rendered its user bubble, and a dropped row would
                // desync edit/regenerate indexing. Then surface the error.
                if (epoch === this._sessionEpoch) {
                    this._commitUnfinishedLocalTurn(prompt, attachmentMeta, prePromptSha, outcome, opts?.steerCarry, '[interrupted by error]');
                    await this._persistLocalSession().catch((e) => {
                        console.error('xratu: local session persist failed:', e);
                    });
                }
                this._discardQueuedSteers();
                this._view?.webview.postMessage({ type: 'error', valueKey: 'localNoResponse' });
            }
            } finally {
                // Unconditional cleanup on EVERY exit - normal completion, the
                // pre-flight abort returns, AND a thrown preflight call (a
                // throw used to leak the flag and the 'chat' controller: every
                // later message steered into a queue nothing drained,
                // edit-resend bailed on the stale controller, session switch
                // stayed locked until reload). A session switch mid-run (epoch
                // bump) additionally drops queued steers - they belong to the
                // dead session. The run-active flag is NOT reset for steerCarry
                // turns: the carry loop that spawned them owns it, and a reset
                // here would let a steer arriving between carry turns start a
                // CONCURRENT second turn.
                if (epoch !== this._sessionEpoch) this._discardQueuedSteers();
                else if (!agentStarted) this._discardQueuedSteers(steerQueueFloor);
                if (!opts?.steerCarry) {
                    this._localRunActive = false;
                    this._settleLocalRun();
                }
                this._abortControllers.delete('chat');
            }
        return;
        } finally {
            // Unconditional cleanup for exits the inner finally cannot see:
            // early returns and throws in the pre-controller region (title
            // seed, attachment resolution, PDF extraction, project-tree I/O).
            // Idempotent - the inner finally performs the same bookkeeping
            // once the controller is registered.
            if (epoch !== this._sessionEpoch) this._discardQueuedSteers();
            else if (!agentStarted) this._discardQueuedSteers(steerQueueFloor);
            if (!opts?.steerCarry) {
                this._localRunActive = false;
                this._settleLocalRun();
            }
            this._abortControllers.delete('chat');
        }
}


    /** Ledger an UNFINISHED local turn (cancelled or errored mid-run): the
     *  user's prompt and everything the model streamed/executed stays in
     *  BOTH ledgers, so the next turn replays the full context (including
     *  any task-list writes - the checklist derives from these history
     *  rows). Dangling assistant tool_calls get placeholder results -
     *  providers reject a request whose assistant tool_calls are never
     *  answered. Steers that never reached a round boundary still render
     *  as user bubbles webview-side - ledger them here so edit/regenerate
     *  indexing stays aligned. */
    private _commitUnfinishedLocalTurn(
        prompt: string,
        attachmentMeta: AttachmentMeta[] | undefined,
        prePromptSha: string | undefined,
        outcome: StreamOutcome,
        steerCarry: boolean | undefined,
        toolPlaceholder: string,
    ): void {
        if (!steerCarry) {
            this._history.push({ role: 'user', content: prompt, cp: prePromptSha, attachments: attachmentMeta });
            this._pushLocalHistory({ role: 'user', content: prompt });
        }
        for (const event of outcome.events) {
            const row = historyRowFromEvent(event);
            if (row) this._pushLocalHistory(row);
            if (event.type === 'steer_user') {
                this._history.push({
                    role: 'user',
                    content: event.text,
                    ...(event.attachments?.length ? { attachments: event.attachments } : {}),
                });
            }
        }
        // _history's display-ledger convention (matching the success path):
        // steer user rows BEFORE the assistant row, so a restored session
        // replays the steer bubbles above the partial answer and editing a
        // steered message truncates the partial turn with it.
        //
        // The replay ledger also needs the terminal state the live webview
        // got as transient messages: placeholder results for dangling
        // tool_calls (otherwise the restored pill spins forever) and a
        // terminal `result` marker (otherwise the cancel/error bubble
        // vanishes on reload). These are DISPLAY events only - the model
        // context is built from _localHistory.
        const displayEvents: any[] = outcome.events.map(trimDisplayEvent);
        const answered = new Set(
            outcome.events.filter((e) => e.type === 'tool_result').map((e) => e.id)
        );
        for (const event of outcome.events) {
            if (event.type === 'tool_call' && !answered.has(event.id)) {
                displayEvents.push({
                    type: 'tool_result',
                    id: event.id,
                    tool: event.tool,
                    output: toolPlaceholder,
                });
                answered.add(event.id);
            }
        }
        // Partial text streamed before the interruption lives only in
        // _localAccumulatedText (round events carry no display chunk rows) -
        // commit it as its own result so the replay keeps what the user saw.
        const partialText = this._localAccumulatedText.trim();
        if (partialText) {
            displayEvents.push({ type: 'result', persian_explanation: partialText });
        }
        displayEvents.push(outcome.errorEvent
            ? { type: 'result', error: outcome.errorEvent.error }
            : { type: 'result', error_key: outcome.aborted ? 'requestCancelled' : 'localNoResponse' });
        this._history.push({ role: 'assistant', events: displayEvents, content: '' });
        while (this._localSteerQueue.length > 0) {
            const carry = this._localSteerQueue.shift()!;
            // Never reached a round boundary before the cancel/error: release
            // its held bubble so the rendered user rows match this ledger.
            this._confirmSteer(carry.steerId);
            this._pushLocalHistory({ role: 'user', content: carry.text });
            this._history.push({
                role: 'user',
                content: carry.text,
                ...(carry.meta?.length ? { attachments: carry.meta } : {}),
            });
        }
        const answeredLocal = new Set(
            this._localHistory.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
        );
        for (const m of this._localHistory) {
            for (const tc of m.tool_calls ?? []) {
                if (!answeredLocal.has(tc.id)) {
                    this._pushLocalHistory({ role: 'tool', tool_call_id: tc.id, content: toolPlaceholder });
                    answeredLocal.add(tc.id);
                }
            }
        }
    }

    private async _buildDiffPreview(toolName: string, args: any): Promise<ApprovalDiff | null> {
        const filePath: string = args.path || '';
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
        let fullPath: string;
        try {
            fullPath = sanitizePath(filePath, workspaceRoot);
        } catch {
            return null;
        }
        try {
            const fileUri = vscode.Uri.file(fullPath);
            const stat = await vscode.workspace.fs.stat(fileUri).then((s) => s, () => null);
            let oldContent = '';
            let newContent: string;
            if (!stat && toolName === 'edit_file') {
                newContent = args.new_content || '';
            } else if (toolName === 'apply_patch') {
                // Simulate the SEARCH/REPLACE blocks in memory so the card
                // shows a real unified diff instead of raw markers.
                oldContent = stat ? (await vscode.workspace.openTextDocument(fileUri)).getText() : '';
                const patched = applyMarkerPatch(oldContent, String(args.patch ?? ''));
                if (patched === null) return null;
                newContent = patched;
            } else {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                oldContent = doc.getText();
                newContent = toolName === 'edit_file'
                    ? (args.new_content || '')
                    : oldContent.replace(args.old_str ?? '', () => (args.new_str ?? ''));
            }
            const hunks = computeDiffHunks(oldContent, newContent);
            if (hunks === null) return null;
            const lines: string[] = [];
            let added = 0;
            let removed = 0;
            for (const h of hunks) {
                lines.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
                for (const l of h.removedLines) { lines.push('- ' + l); removed++; }
                for (const l of h.addedLines) { lines.push('+ ' + l); added++; }
            }
            return { file: filePath, added, removed, lines };
        } catch {
            return null;
        }
    }


    private async _processNeedsApproval(parsed: any) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
        const out: any[] = [];
        const closeItems: Array<{ tool_call_id: string; tool_name: string }> = [];
        const preDenied: Record<string, boolean> = {};

        for (const approval of parsed.approvals ?? []) {
            const toolName: string = approval.tool_name ?? 'unknown';
            let args = approval.args;
            if (typeof args === 'string') {
                try { args = JSON.parse(args); } catch { args = {}; }
            }
            approval.args = args;
            let diff: ApprovalDiff | null = null;
            // Only approvable items carry a kind - a pre-denied call must
            // never teach the session gate to auto-approve its kind later.
            // Null kind (shell-composed terminal commands) never records.
            const kind = sessionApprovalKind(toolName, args ?? {});

            if (toolName === 'edit_file') {
                // Deny an unknown mode BEFORE the preview: otherwise the card
                // shows an overwrite-style diff for a call that can only fail
                // at dispatch. Mirrors dispatchTool's check.
                const resolved = resolveEditMode(approval.args?.mode);
                if ('error' in resolved) {
                    preDenied[approval.tool_call_id] = false;
                    closeItems.push({ tool_call_id: approval.tool_call_id, tool_name: toolName });
                    this._view?.webview.postMessage({ type: 'error', value: resolved.error });
                    out.push({ tool_call_id: approval.tool_call_id, tool_name: toolName, args: approval.args, diff: null });
                    continue;
                }
            }
            if (toolName === 'edit_file' || toolName === 'replace_in_file' || toolName === 'apply_patch') {
                try {
                    sanitizePath(approval.args?.path || '', workspaceRoot);
                } catch {
                    preDenied[approval.tool_call_id] = false;
                    // Pre-denied calls still have an open timeline row from
                    // their streamed tool_call event - they need closing too.
                    closeItems.push({ tool_call_id: approval.tool_call_id, tool_name: toolName });
                    this._view?.webview.postMessage({ type: 'error', value: `Path is outside the workspace: ${approval.args?.path}` });
                    // Keep the item in the payload (flagged pre-denied) - the
                    // approval card renders it with a denied tag instead of
                    // showing an empty card.
                    out.push({ tool_call_id: approval.tool_call_id, tool_name: toolName, args: approval.args, diff: null });
                    continue;
                }
                diff = await this._buildDiffPreview(toolName, approval.args);
            }
            out.push({ tool_call_id: approval.tool_call_id, tool_name: toolName, args: approval.args, diff, kind });
        }

        closeItems.push(...out.map((a) => ({ tool_call_id: a.tool_call_id, tool_name: a.tool_name, kind: a.kind })));

        for (const auto of (parsed.auto ?? []) as any[]) {
            // Server-executed deferred calls (read_file & co.) shown as pills
            // during the run but resolved inside the resume without their own
            // streamed tool_result - mark them closable.
            closeItems.push({
                tool_call_id: String(auto.tool_call_id ?? ''),
                tool_name: auto.tool_name ?? 'tool'
            });
        }
        this._approvalCloseItems[parsed.approval_id] = closeItems;

        this._view?.webview.postMessage({
            type: 'needsApproval',
            approval_id: parsed.approval_id,
            approvals: out,
            preDenied
        });
    }

    async _handleToolApproval(approvalId: string, toolDecisions: Record<string, boolean>, sessionApprove = false, _retryCount = 0): Promise<void> {
        if (_retryCount > 1) return;
        const approvals = this._approvalCloseItems[approvalId] ?? [];

        const approvalsMap: Record<string, boolean> = {};
        Object.assign(approvalsMap, toolDecisions);

        // --- Local approval: resolve the pending promise, the local agent
        //     generator continues on its own (no cloud /chat/approve call).
        if (approvalId.startsWith('local-')) {
            // "Allow for this session": every approvable kind in this round
            // is trusted for the REST of the session (cleared on new session).
            if (sessionApprove) {
                for (const a of approvals) {
                    if (a.kind) this._sessionApprovedKinds.add(a.kind);
                }
            }
            this._resolveLocalApproval(approvalId, toolDecisions);
            delete this._approvalCloseItems[approvalId];
            const decisionValues = approvals.map((a) => toolDecisions[a.tool_call_id] === true);
            const acceptedCount = decisionValues.filter(Boolean).length;
            const resolution = acceptedCount === 0 ? 'rejected' : acceptedCount === decisionValues.length ? 'approved' : 'mixed';
            this._view?.webview.postMessage({ type: 'approvalResolved', approval_id: approvalId, resolution });
            return;
        }
    }


    private _getHtmlForWebview(webview: vscode.Webview) {
        const nonce = getNonce();
        const cspSource = webview.cspSource;

        // DEV-LOOP ESCAPE HATCH. `XRATU_DEV_WEBVIEW_URL` pointing at a running
        // Vite dev server serves the app from the dev server instead of the
        // built bundle, so React/CSS edits hot-reload instead of costing an
        // esbuild+vite rebuild plus a webview reload. Off by default, and read
        // from the environment rather than contributed as a setting so it can
        // never appear in Settings UI (and needs no package.nls pair).
        const devUrl = parseDevWebviewUrl(process.env.XRATU_DEV_WEBVIEW_URL);
        if (devUrl) {
            try {
                const sourceHtml = fs.readFileSync(
                    path.join(this._extensionUri.fsPath, 'webview-ui', 'index.html'),
                    'utf-8',
                );
                const uiLocale = this._globalState.get<string>('xratu.locale') === 'en' ? 'en' : 'fa';
                const devHtml = buildDevWebviewHtml({ sourceHtml, devUrl, locale: uiLocale, nonce });
                if (devHtml) return devHtml;
                console.error('xratu: XRATU_DEV_WEBVIEW_URL set but webview-ui/index.html has no /src/main.tsx entry - using the built bundle');
            } catch (err) {
                console.error('xratu: dev webview unavailable, using the built bundle:', err);
            }
        }

        // The React webview is built by Vite into a single self-contained
        // index.html (JS + CSS inlined).  We inject a strict CSP with a
        // per-load nonce and attach that nonce to the inlined module script.
        const csp = [
            "default-src 'none'",
            `style-src ${cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `img-src ${cspSource} data:`,
            // data: is required for the inlined Vazirmatn woff2 (Vite inlines
            // every asset into the single-file webview; see vite.config.ts).
            `font-src ${cspSource} data:`,
            "connect-src 'none'",
            "frame-src 'none'",
            "form-action 'none'",
            "base-uri 'none'",
        ].join('; ');

        try {
            const fs = require('fs');
            const builtPath = path.join(
                this._extensionUri.fsPath,
                'dist',
                'webview-ui',
                'index.html'
            );
            let html = fs.readFileSync(builtPath, 'utf-8');

            // Inject the CSP into <head>.  If the bundle somehow already
            // ships a CSP meta, drop it in favour of ours.
            html = html.replace(
                /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i,
                ''
            );
            html = html.replace(/<head>/i, `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);

            // Attach the nonce to the inlined module script and strip any
            // crossorigin attribute that would break same-origin loading.
            html = html.replace(/<script([^>]*)>/i, (_m: string, attrs: string) => {
                const cleaned = attrs.replace(/\s+crossorigin/gi, '');
                return `<script${cleaned} nonce="${nonce}">`;
            });

            // Bake the persisted UI language into the page BEFORE the bundle
            // runs - the webview must never depend on a postMessage echo for
            // its first paint (the echo rides behind awaits on the
            // webviewReady path and is lost whenever that boot chain fails).
            const uiLocale = this._globalState.get<string>('xratu.locale') === 'en' ? 'en' : 'fa';
            html = html.replace(/<head>/i, `<head>\n<script nonce="${nonce}">window.XRATU_LOCALE=${JSON.stringify(uiLocale)};</script>`);

            return html;
        } catch (err) {
            console.error('Failed to load webview bundle:', err);
            return `<!DOCTYPE html><html><body><p>Webview build not found. Run: npm run compile</p></body></html>`;
        }
    }
}

/** Bundled skills seeded into the user's global cross-agent skills root
 *  (~/.agents/skills), the same location the Skills page scans. Each entry
 *  is [skill directory name, path relative to the extension root]. */
const BUNDLED_SKILLS: ReadonlyArray<readonly [string, string]> = [
    ['natural-farsi', path.join('assets', 'skills', 'natural-farsi', SKILL_FILE)],
    ['jalali-dates', path.join('assets', 'skills', 'jalali-dates', SKILL_FILE)],
    ['finglish-normalize', path.join('assets', 'skills', 'finglish-normalize', SKILL_FILE)],
    ['iran-connectivity-fallback', path.join('assets', 'skills', 'iran-connectivity-fallback', SKILL_FILE)],
    ['iran-dev-access', path.join('assets', 'skills', 'iran-dev-access', SKILL_FILE)],
    ['local-llm-low-ram', path.join('assets', 'skills', 'local-llm-low-ram', SKILL_FILE)],
];

/** Seed/update the bundled skills. Per-skill bookkeeping:
 *  - `xratu.skills.seeded.<name>` marks that this install has SEEN the skill;
 *    a skill the user deleted afterwards is never resurrected (the flag
 *    makes later runs skip creation), and disabling via the Skills page
 *    stays the supported "off" switch.
 *  - `xratu.skills.seededHash.<name>` records the content hash we wrote, so
 *    bundled content updates reach untouched copies while a user-edited
 *    copy ('foreign', or a legacy seed with no hash) is theirs forever. */
async function seedBundledSkills(context: vscode.ExtensionContext): Promise<void> {
    if (vscode.workspace.isTrusted === false) return;
    const root = path.join(os.homedir(), '.agents', 'skills');
    const legacy = context.globalState.get<boolean>('xratu.skills.bundledSeeded') === true;
    for (const [name, relPath] of BUNDLED_SKILLS) {
        try {
            const flagKey = `xratu.skills.seeded.${name}`;
            const hashKey = `xratu.skills.seededHash.${name}`;
            const skillMd = await fs.promises.readFile(path.join(context.extensionPath, relPath), 'utf-8');
            if (!context.globalState.get<boolean>(flagKey)) {
                // Legacy installs seeded natural-farsi under the old
                // once-flag with no hash recorded: treat their copy as
                // user-owned so updates never clobber it.
                if (legacy && name === 'natural-farsi') {
                    await context.globalState.update(flagKey, true);
                    await context.globalState.update(hashKey, 'foreign');
                    continue;
                }
                const result = await ensureBundledSkill(root, name, skillMd);
                await context.globalState.update(flagKey, true);
                // 'exists' = a copy was already there (user-authored): never
                // ours to update. 'created' records our hash.
                await context.globalState.update(hashKey, result === 'created' ? sha256Hex(skillMd) : 'foreign');
                continue;
            }
            const updated = await updateBundledSkillIfUntouched(
                root, name, skillMd, context.globalState.get<string>(hashKey) ?? 'foreign');
            if (updated === 'updated') {
                await context.globalState.update(hashKey, sha256Hex(skillMd));
            }
        } catch (e) {
            console.error('xratu: bundled skill seed failed', name, e);
        }
    }
}

/** Cap on completion reports held while no run is live. Each carries a job's
 *  output tail, and they are all delivered to the next turn. */
const MAX_PENDING_JOB_NOTICES = 16;

export function activate(context: vscode.ExtensionContext) {
    const checkpoints = new ShadowCheckpointStore(context);
    diagnosticsChannel = vscode.window.createOutputChannel('Xratu');
    context.subscriptions.push(diagnosticsChannel);
    // Checkpoint failures are swallowed so they cannot block a user action;
    // route them here so a workspace that has lost its undo points says so.
    setCheckpointDiagnostics((message) => diagnosticsChannel?.appendLine(message));
    const mcpConfigStore = new McpConfigStore(context);
    const externalMcp = new ExternalMcpManager(() => mcpConfigStore.load());
    externalMcpInstance = externalMcp;
    mcpConfigStoreInstance = mcpConfigStore;
    mcpMarketplaceInstance = new McpMarketplaceStore(context);

    // Ship with the DuckDuckGo search MCP active (first run only - the seed
    // is skipped as soon as the global config file exists). Fire-and-forget:
    // the manager reloads configs on demand, and failures must never block
    // activation.
    mcpConfigStore.seedDefaults().catch((e) =>
        console.error('xratu: MCP default-server seed failed:', e));

    // Ship with the natural-farsi writing skill (first run only). Lands in
    // the shared cross-agent skills root so it survives workspace switches.
    // A once-flag means a user who deletes it stays deleted; exclusive
    // create inside - an existing copy is never clobbered. Fire-and-forget:
    // the next skills scan picks the folder up, and failures must never
    // block activation.
    seedBundledSkills(context).catch((e) =>
        console.error('xratu: bundled skills seed failed:', e));

    // Not awaited: activation must not block on the highlighter. `ensureShiki`
    // owns the retry so a transient failure cannot leave `shikiHighlighter`
    // null for the whole session.
    void ensureShiki();

    const provider = new XratuChatViewProvider(context.extensionUri, context.secrets, checkpoints, context.globalState, context.globalStorageUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(XratuChatViewProvider.viewType, provider)
    );

    // The job-event listener lives in a module-level registry, so it has
    // to be dropped explicitly - VS Code disposing the subscriptions is what
    // guarantees a window reload leaves nothing posting into a dead webview.
    context.subscriptions.push({ dispose: () => provider.disposeJobEvents() });

    // Adopt background jobs a previous host window left running. A reload must
    // not turn the user's dev server into an unstoppable orphan - but nothing is
    // adopted on the strength of a pid alone: `load` re-proves each recorded
    // process identity first, because pid numbers are recycled.
    const backgroundJobs = new BackgroundJobStore(context.globalStorageUri.fsPath);
    provider.attachBackgroundJobStore(backgroundJobs);
    void backgroundJobs.load().then(({ alive, dropped }) => {
        for (const record of alive) {
            adoptDetachedJob(record);
        }
        if (alive.length) provider.reportAdoptedJobs(alive.length);
        // The dropped list is the interesting half: it is every record that
        // could NOT be re-proven as ours (recycled pid, malformed file, or a
        // host with no way to read process start times). Reporting it is the
        // difference between "nothing to recover" and "recovery is broken and
        // we are staying quiet about it".
        if (dropped.length) provider.reportUnrecoverableJobs(dropped.length);
    }).catch(() => undefined);

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('xratu-diff', provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('xratu.clearHistory', async () => {
            await provider.ensureView();
            await provider.clearHistory();
        }),
        vscode.commands.registerCommand('xratu.setLlmCredentials', async () => {
            await provider.setLlmCredentialsPublic();
        }),
        vscode.commands.registerCommand('xratu.openSettings', async () => {
            await provider.openSettingsPublic();
        }),
        vscode.commands.registerCommand('xratu.agentFiles', async () => {
            await provider.manageAgentFiles();
        }),
        vscode.commands.registerCommand('xratu.reviewChanges', () => {
            void provider.reviewChangesFlow();
        }),
        vscode.commands.registerCommand('xratu.restoreCheckpoint', async () => {
            await provider.ensureView();
            await provider.restoreCheckpointFlow();
        }),
        vscode.commands.registerCommand('xratu.attachFile', async () => {
            // Drag-and-drop into a SIDEBAR webview view is impossible in VS
            // Code (the workbench makes webview iframes pointer-transparent
            // during drags and never re-dispatches DROP to them) - this native
            // file dialog is the reliable "attach from anywhere" path.
            const picks = await vscode.window.showOpenDialog({
                canSelectMany: true,
                canSelectFolders: false,
                openLabel: 'Attach to Xratu',
                title: 'Attach files to Xratu chat',
            });
            if (picks?.length) {
                await provider.attachUrisPublic(picks.map((u) => u.toString()));
            }
        }),
        vscode.commands.registerCommand('xratu.attachFromExplorer', async (uriOrContext: vscode.Uri | { selectedUri?: vscode.Uri } | undefined) => {
            // Explorer right-click → "Attach to Xratu". The menu passes the
            // selected resource URI.
            const uri = uriOrContext instanceof vscode.Uri
                ? uriOrContext
                : uriOrContext?.selectedUri;
            if (uri) {
                await provider.attachUrisPublic([uri.toString()]);
            }
        })
    );

    // Raw mcp.json edits (MCP page → "Edit raw JSON") apply live: reload the
    // manager and re-push page state. Editors fire several events per save -
    // debounce so one save is one reload. Only the files the config store
    // actually READS (global + first workspace folder) may trigger a reload;
    // the multi-root glob watcher alone would disconnect servers on edits to
    // folders the store ignores.
    const onMcpFileChanged = (() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let lastUri: vscode.Uri | null = null;
        const watchedPaths = (): string[] => {
            const store = mcpConfigStoreInstance;
            if (!store) return [];
            const paths = [store.globalPath];
            const ws = store.workspacePath;
            if (ws) paths.push(ws);
            return paths;
        };
        return (uri: vscode.Uri) => {
            lastUri = uri;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                const changed = lastUri?.fsPath;
                if (!changed || !watchedPaths().some((p) => sameMcpPath(p, changed))) return;
                void provider.reloadMcpFromDisk(changed).catch((e) =>
                    console.error('xratu: mcp config reload failed:', e));
            }, 500);
        };
    })();
    const mcpWatchers = [
        vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
            vscode.Uri.file(path.dirname(mcpConfigStore.globalPath)),
            path.basename(mcpConfigStore.globalPath)
        )),
        vscode.workspace.createFileSystemWatcher('**/.xratu/mcp.json'),
    ];
    for (const w of mcpWatchers) {
        context.subscriptions.push(w);
        w.onDidChange(onMcpFileChanged);
        w.onDidCreate(onMcpFileChanged);
        w.onDidDelete(onMcpFileChanged);
    }

    // Trust transitions re-resolve the effective config. Entering restricted
    // mode forces a window reload (so the filtered load() applies fresh);
    // onDidGrantWorkspaceTrust is the one in-session transition and may
    // newly connect workspace-sourced servers.
    context.subscriptions.push(
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            void provider.reloadMcpFromDisk().catch((e) =>
                console.error('xratu: mcp trust-transition reload failed:', e));
            // Activation skipped the bundled-skills seed in Restricted Mode -
            // this transition is its only second chance in this window.
            void seedBundledSkills(context).catch((e) =>
                console.error('xratu: bundled skills trust-transition seed failed:', e));
        })
    );
}

export function deactivate() {
    // Background jobs are the user's own processes (a dev server, a watcher)
    // that they explicitly asked to keep running. They are checkpointed, NOT
    // killed: killing them on a window reload would take down the thing the
    // user started. `adoptDetachedJob` re-adopts them on the next activate.
    setJobChangeListener(undefined);
    // External stdio MCP servers are child processes - without this they
    // outlive extension-host reloads until the process dies on its own.
    void externalMcpInstance?.stopAll();
    externalMcpInstance = null;
    mcpConfigStoreInstance = null;
    mcpMarketplaceInstance = null;
}
