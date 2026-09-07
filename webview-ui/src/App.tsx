import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ChevronDown, Link, ListChecks } from 'lucide-react';
import { postMessage } from './vscode';
import type {
    ConnectionStatus as ConnStatus,
    ComposerAttachment,
    DiscoveredLocalRuntime,
    FromExtensionMessage,
    McpRegistryEntry,
    McpSaveTarget,
    McpServerPayload,
    McpServerView,
    NotificationItem,
    SessionMeta,
    SkillView,
    TaskListItem,
    ThinkingLevel,
    ToExtensionMessage,
    SavedCredential,
} from './types';
import { createInitialChatState, reduceChat } from './state';
import { Toolbar, type SessionsScope } from './components/Toolbar';
import { MessageList } from './components/MessageList';
import { TASK_LIST_TOOL, TaskListEditor, parseTaskListStep } from './components/MessageItem';
import { CredentialsPage } from './components/CredentialsPage';
import { InputBar } from './components/InputBar';
import { SettingsPage } from './components/SettingsPage';
import { CapabilitiesPage } from './components/CapabilitiesPage';
import { Welcome } from './components/Welcome';
import { NotificationBanner } from './components/NotificationBanner';
import { getLocale, setLocale, t, tf, tOrRaw } from './i18n';

type Screen = 'boot' | 'welcome' | 'chat' | 'credentials' | 'settings' | 'capabilities';

/** Composer attachments → persisted-history shape (base64 dropped, images
 *  keep an inline preview for the just-sent bubble). */
function toAttachmentMeta(attachments: ComposerAttachment[]) {
    return attachments.map((a) => ({
        name: a.name,
        mime_type: a.mimeType,
        size: a.size,
        path: a.path,
        previewDataUrl: a.mimeType.startsWith('image/')
            ? `data:${a.mimeType};base64,${a.dataBase64}`
            : undefined,
    }));
}

export function App() {
    // 'boot' = waiting for the host's start-screen verdict (showWelcome /
    // showChat). Rendering the welcome here by default made it flash for a
    // few ms on every webview load before the host switched to the chat UI.
    const [screen, setScreen] = useState<Screen>('boot');
    const [chat, dispatch] = useReducer(reduceChat, undefined, createInitialChatState);
    /** Host-echoed current task list (user edits merged; null = none). The
     *  interactive checklist shows this over the newest update_task_list
     *  step's args; edits go back to the host for persistence + reminder. */
    const [taskList, setTaskList] = useState<TaskListItem[] | null>(null);
    const [conn, setConn] = useState<ConnStatus>('disconnected');
    const [yolo, setYolo] = useState(false);
    const [plan, setPlan] = useState(false);
    const [byokHint, setByokHint] = useState(false);
    const [byokError, setByokError] = useState<string | null>(null);
    const [credReason, setCredReason] = useState<string | null>(null);
    /** Bumped on retry - remounts CredentialsPage so its mount-time local
     *  discovery scan runs again, identical to leaving and re-entering. */
    const [credNonce, setCredNonce] = useState(0);
    const [credUrl, setCredUrl] = useState<string | null>(null);
    /** Runtime card to pre-expand on the credentials page (echoed target). */
    const [credOpenCard, setCredOpenCard] = useState<'byok' | 'local' | null>(null);
    const [activeCredentialId, setActiveCredentialId] = useState<string | null>(null);
    /** Where the credentials page's Back button returns to - 'settings' when
     *  it was opened from Settings, 'chat' for every other entry path. */
    const [credReturnTo, setCredReturnTo] = useState<'chat' | 'settings'>('chat');
    /** Same return-tracking for the capabilities page's Back button. */
    const [capReturnTo, setCapReturnTo] = useState<'chat' | 'settings'>('chat');
    const [savedCredentials, setSavedCredentials] = useState<SavedCredential[]>([]);
    const [injectedText, setInjectedText] = useState<{ id: number; text: string } | null>(null);
    // Workspace-relative path of the file open in the active editor - the
    // host pushes it on focus/editor changes; suggestion workflows name it.
    const [activeFile, setActiveFile] = useState<string | null>(null);
    const [showJump, setShowJump] = useState(false);
    const [modelInfo, setModelInfo] = useState<{
        defaultModel: string;
        models: string[];
        contextWindows: Record<string, number>;
    } | null>(null);
    const [selectedModel, setSelectedModel] = useState<string | null>(null);
    // User's explicit per-model context-window overrides (mirrored from the
    // host's persisted map on every modelInfo).
    const [ctxOverrides, setCtxOverrides] = useState<Record<string, number>>({});
    // Per-model reasoning-effort levels (mirrored from the host's persisted
    // map on every modelInfo; a missing entry = Default).
    const [thinkingLevels, setThinkingLevels] = useState<Record<string, ThinkingLevel>>({});
    const [modelsRefreshing, setModelsRefreshing] = useState(false);
    const [extensionVersion, setExtensionVersion] = useState<string | null>(null);
    const [localRuntimes, setLocalRuntimes] = useState<DiscoveredLocalRuntime[]>([]);
    const [localModelsScanning, setLocalModelsScanning] = useState(false);
    /** Host-reported discovery failure - distinct from an empty result. */
    const [localScanError, setLocalScanError] = useState<string | null>(null);
    /** Heuristic vision support of the selected model (null = unknown). */
    const [visionCapable, setVisionCapable] = useState<boolean | null>(null);
    /** Host rejected the last send - restore value + attachments so the
     *  user can retry without re-attaching everything. */
    const [composerRestore, setComposerRestore] = useState<{ value: string; attachments: ComposerAttachment[] } | null>(null);
    /** Message being edited in the composer card (pencil → composer flow):
     *  the composer prefills its text, sending performs the rewind-resend. */
    const [editDraft, setEditDraft] = useState<{ userIndex: number; value: string } | null>(null);
    /** Host-read attachments from an explorer drag, waiting to be merged. */
    const [hostAttachments, setHostAttachments] = useState<ComposerAttachment[] | null>(null);
    // Workspace file list for the composer's @-mention popup (host-provided).
    const [workspaceFiles, setWorkspaceFiles] = useState<string[] | null>(null);
    /** Host-side attachment rejection - shown INLINE in the composer.
     *  Keyed with an incrementing id: identical consecutive rejections must
     *  each display (and never re-display an older one). */
    const [composerError, setComposerError] = useState<{ id: number; value: string; valueKey?: string; params?: Record<string, string> } | null>(null);
    /** In-app notification banners (replaces VS Code toasts). Queue order is
     *  preserved; NotificationBanner shows the head. Confirm banners answer
     *  the host with the picked action (null = dismissed/cancelled). */
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    /** UI language - mirrored from the host's persisted choice on ready. */
    const [locale, setLocaleState] = useState<'fa' | 'en'>(getLocale());
    /** Session picker state - the toolbar's centered title button drives it. */
    const [sessionTitle, setSessionTitle] = useState<string | null>(null);
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
    const [sessionsOpen, setSessionsOpen] = useState(false);
    const [sessions, setSessions] = useState<SessionMeta[]>([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);
    const [sessionsScope, setSessionsScope] = useState<SessionsScope>('workspace');
    /** MCP page state - host-owned; pushed on mcpGetState / mcpSave /
     *  mcpRestart responses. */
    const [mcpServers, setMcpServers] = useState<McpServerView[]>([]);
    const [mcpHasWorkspace, setMcpHasWorkspace] = useState(false);
    const [mcpLegacyInUse, setMcpLegacyInUse] = useState(false);
    const [mcpRegistry, setMcpRegistry] = useState<McpRegistryEntry[]>([]);
    /** Skills page state - host-owned; pushed on skillsGetState / skillsToggle. */
    const [skills, setSkills] = useState<SkillView[]>([]);

    // Local-scan cosmetics: probing runtimes can finish near-instantly, so
    // keep the spinner alive for at least ~1s - a flashing spinner looks
    // broken rather than fast.
    const scanStartedAt = useRef(0);
    const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const onLocalModelsDiscovered = useCallback((runtimes: DiscoveredLocalRuntime[], error?: string) => {
        setLocalRuntimes(runtimes);
        setLocalScanError(error ?? null);
        const elapsed = Date.now() - scanStartedAt.current;
        if (scanTimer.current) clearTimeout(scanTimer.current);
        scanTimer.current = setTimeout(
            () => setLocalModelsScanning(false),
            Math.max(0, 1000 - elapsed)
        );
    }, []);

    const send = useCallback((msg: ToExtensionMessage) => postMessage(msg), []);

    /** Kick off local-runtime discovery (welcome screen + credentials page).
     *  Probing can finish near-instantly - the ≥1s spinner floor lives in
     *  onLocalModelsDiscovered so a fast scan never looks broken. */
    const startLocalScan = useCallback(() => {
        scanStartedAt.current = Date.now();
        if (scanTimer.current) clearTimeout(scanTimer.current);
        setLocalModelsScanning(true);
        setLocalScanError(null);
        send({ type: 'discoverLocalModels' });
    }, [send]);

    // The message handler below is registered once (dep: [send]) and so
    // closes over a stale chat.busy - read the live value through this ref
    // so mid-run navigation can tell a live stream from a settled one.
    const busyRef = useRef(chat.busy);
    busyRef.current = chat.busy;

    const dismissNotification = useCallback((id: string, action: string | null) => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
        send({ type: 'notificationAction', id, action });
    }, [send]);

    // Smart auto-scroll: only follow the stream if the user is already near
    // the bottom (so reading history isn't yanked away mid-scroll).
    const containerRef = useRef<HTMLDivElement | null>(null);
    // Inner CONTENT wrapper (all bubbles) - its size changes when tool/thinking
    // pills expand or collapse; the scroller's own box never does.
    const contentRef = useRef<HTMLDivElement | null>(null);
    const atBottom = useRef(true);
    const lastScrollTop = useRef(0);
    // Track scrollHeight alongside scrollTop: a CONTENT SHRINKAGE clamps
    // scrollTop down (browser clamp when the document shrinks under a
    // bottom-pinned view), and that clamp fires a scroll event with an
    // upward delta - identical to a user scroll-up. Without the scrollHeight
    // comparison the clamp latches atBottom=false and the stream follow dies
    // until the user manually scrolls back down.
    const lastScrollHeight = useRef(0);
    // A chevron-triggered smooth scroll is in flight - instant pins (stream
    // follow, resize observer) must not compete with it or the animation
    // snaps mid-flight. Cleared on arrival at the bottom or by timeout.
    const smoothJumpInFlight = useRef(false);
    const onScroll = () => {
        const el = containerRef.current;
        if (el) {
            // Any upward scroll immediately opts out of auto-follow - content
            // grows at the bottom during streaming, so without this a slow
            // wheel/touchpad scroll up is snapped back on every chunk.
            // EXCEPT when the document itself shrank: the scrollTop clamp
            // that follows is bookkeeping, not intent (see lastScrollHeight).
            const shrunk = el.scrollHeight < lastScrollHeight.current;
            if (!shrunk && el.scrollTop < lastScrollTop.current - 1) atBottom.current = false;
            else {
                const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                atBottom.current = nearBottom;
                if (nearBottom) smoothJumpInFlight.current = false;
            }
            lastScrollTop.current = el.scrollTop;
            lastScrollHeight.current = el.scrollHeight;
            setShowJump(!atBottom.current);
        }
    };
    const stickToBottom = useCallback((smooth = false) => {
        const el = containerRef.current;
        if (!el || !atBottom.current) return;
        el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    }, []);

    // ResizeObserver-driven pin: while a run is LIVE, any content growth -
    // tool pill expand/collapse, streamed rows, rendered edit results -
    // keeps the view pinned to the bottom (height changes below the fold
    // otherwise silently unpin the follow). The pin ALWAYS respects the
    // user's scroll position: an upward scroll sets atBottom=false via
    // onScroll, and no busy-mode override may defeat that - yanking the
    // user back down on every streamed chunk makes the response
    // unreadable. When idle, growth from opening history pills must not
    // yank the view either, so the near-bottom gate still applies.
    const pinToBottom = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        if (!atBottom.current) return;
        // Never override an in-flight smooth jump with an instant snap.
        if (smoothJumpInFlight.current) return;
        el.scrollTo({ top: el.scrollHeight });
    }, []);

    // Follow stream output: instant (no animation) so it never fights itself.
    useEffect(() => {
        stickToBottom(false);
    }, [chat.messages, stickToBottom]);

    // Follow layout growth that React state doesn't know about - e.g. the
    // user expanding/collapsing <details> rows inside messages, or a pill
    // mounting with a large diff. The observer MUST watch the content
    // wrapper: the scroll container's own border box is fixed (overflow
    // scrolls inside it), so observing it never fires and pill expand/close
    // left the view unpinned. Attachment happens via a CALLBACK ref, not a
    // mount effect: the effect ran once while the boot page was up
    // (contentRef still null) and never re-ran, so the observer silently
    // never attached and mid-stream pill expansion had no pin at all.
    const roRef = useRef<ResizeObserver | null>(null);
    const attachContentObserver = useCallback((node: HTMLDivElement | null) => {
        if (contentRef.current && roRef.current) roRef.current.unobserve(contentRef.current);
        contentRef.current = node;
        if (!node) return;
        if (!roRef.current && typeof ResizeObserver !== 'undefined') {
            roRef.current = new ResizeObserver(() => {
                pinToBottom();
                // Late layout (async shiki highlighting, decoded images) can
                // land a frame after the resize that fired this callback -
                // re-pin once more.
                requestAnimationFrame(() => pinToBottom());
            });
        }
        roRef.current?.observe(node);
    }, [pinToBottom]);

    const jumpToBottom = useCallback(() => {
        const el = containerRef.current;
        if (el) {
            smoothJumpInFlight.current = true;
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            atBottom.current = true;
            setShowJump(false);
            // Fallback: if the animation is interrupted (interrupting user
            // scroll, content reflow past the target) the near-bottom scroll
            // handler may never fire - don't leave the flag latched.
            window.setTimeout(() => {
                smoothJumpInFlight.current = false;
            }, 800);
        }
    }, []);

    // ESC always cancels a live run - not just when the composer has focus
    // (during a tool call or approval wait focus lives elsewhere). Inputs
    // handle their own Escape (editing fields, menus), and an open popup
    // consumes the first press, so those never double-fire a cancel.
    useEffect(() => {
        // Safety net: the host should always follow webviewReady with
        // showWelcome/showChat. Some failure paths (e.g. a session refresh
        // that errors out) return silently - fall back to the welcome screen
        // instead of staying blank forever.
        const timer = setTimeout(() => {
            setScreen((s) => (s === 'boot' ? 'welcome' : s));
        }, 4000);
        return () => clearTimeout(timer);
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !busyRef.current) return;
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
            if (document.querySelector('.model-pop, .ctx-menu, .attach-menu, .session-pop')) return;
            e.preventDefault();
            send({ type: 'cancelRequest' });
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [send]);

    useEffect(() => {
        send({ type: 'webviewReady' });

        const handler = (event: MessageEvent) => {
            const msg = event.data as FromExtensionMessage;
            switch (msg.type) {
                case 'connectionStatus':
                    setConn(msg.status);
                    setExtensionVersion(msg.details?.version ?? null);
                    break;
                case 'showWelcome':
                    setScreen('welcome');
                    break;
                case 'showChat':
                    setScreen('chat');
                    break;
                case 'sessionState':
                    setCurrentSessionId(msg.id);
                    setSessionTitle(msg.title);
                    break;
                case 'sessionList':
                    setSessions(msg.items);
                    setCurrentSessionId(msg.currentId);
                    setSessionsLoading(false);
                    break;
                case 'yoloMode':
                    setYolo(msg.enabled);
                    break;
                case 'planMode':
                    setPlan(msg.enabled);
                    break;
                case 'taskListState':
                    setTaskList(msg.tasks);
                    break;
                case 'modelInfo':
                    setModelInfo({
                        defaultModel: msg.defaultModel,
                        models: msg.models,
                        contextWindows: msg.contextWindows ?? {},
                    });
                    setSelectedModel((c) => msg.selectedModel ?? c ?? (msg.defaultModel || null));
                    setVisionCapable(msg.visionCapable ?? null);
                    if (msg.overrides) setCtxOverrides(msg.overrides);
                    setThinkingLevels(msg.thinkingLevels ?? {});
                    setByokHint(false);
                    setByokError(null);
                    break;
                case 'modelsRefreshing':
                    setModelsRefreshing(msg.active);
                    break;
                case 'sendFailed':
                    // Surface the host's error AND put the composer back
                    // the way it was before the failed send.
                    // ALWAYS reaches the reducer: it clears the streaming/
                    // busy state so a rejected send can't leave the typing
                    // indicator spinning.
                    setComposerRestore({ value: msg.prompt, attachments: msg.attachments ?? [] });
                    dispatch({
                        type: 'sendFailed',
                        value: msg.valueKey ? '' : msg.value,
                        valueKey: msg.valueKey,
                        params: msg.params,
                        prompt: msg.prompt,
                        silent: msg.silent,
                    });
                    break;
                case 'attachmentsFromHost':
                    setHostAttachments(msg.attachments);
                    break;
                case 'fileList':
                    setWorkspaceFiles(msg.files);
                    break;
                case 'composerError':
                    setComposerError((prev) => ({ id: (prev?.id ?? 0) + 1, value: msg.value ?? '', valueKey: msg.valueKey, params: msg.params }));
                    break;
                case 'byokSetupHint':
                    setByokHint(true);
                    break;
                case 'byokCredentialError':
                    setByokError(msg.valueKey ? tf(msg.valueKey, msg.params) : (msg.value ?? t('byokInvalid')));
                    break;
                case 'openCredentials':
                    setScreen('credentials');
                    setCredReturnTo('chat');
                    setCredOpenCard(msg.openCard ?? null);
                    // Leaving chat for the credentials page drops streaming
                    // state - but NOT while a run is live, or the in-flight
                    // response/tool calls get amputated across two bubbles.
                    if (!busyRef.current) dispatch({ type: 'byokReset' });
                    setCredReason(msg.reason ?? null);
                    if (msg.currentUrl !== undefined) setCredUrl(msg.currentUrl);
                    setActiveCredentialId(msg.activeCredentialId ?? null);
                    break;
                case 'savedCredentials':
                    setSavedCredentials(msg.credentials);
                    setActiveCredentialId(msg.credentials.find((c) => c.active)?.id ?? null);
                    break;
                case 'credentialsSaved':
                    if (msg.returnToChat) setScreen('chat');
                    setByokError(null);
                    break;
                case 'localModelsDiscovered':
                    if (onLocalModelsDiscovered) onLocalModelsDiscovered(msg.runtimes, msg.error);
                    break;
                case 'openSettings':
                    setScreen('settings');
                    break;
                case 'notification':
                    setNotifications((prev) => [...prev, { id: msg.id, kind: msg.kind, valueKey: msg.valueKey, params: msg.params, actions: msg.actions }]);
                    break;
                case 'locale':
                    setLocale(msg.locale);
                    setLocaleState(msg.locale);
                    break;
                case 'editorContext':
                    setActiveFile(msg.activeFile);
                    break;
                case 'mcpState':
                    setMcpServers(msg.servers);
                    setMcpHasWorkspace(msg.hasWorkspace);
                    setMcpLegacyInUse(msg.legacyInUse);
                    setMcpRegistry(msg.registry);
                    break;
                case 'skillsState':
                    setSkills(msg.skills);
                    break;
                default:
                    dispatch(msg);
            }
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [send]);

    const handleSend = useCallback(
        (text: string, attachments: ComposerAttachment[]) => {
            const value = text.trim();
            // An attachment-only turn is a valid send even with no text -
            // the attachment hint instructs the model.
            if ((!value && attachments.length === 0)) return;
            // Composer edit mode: the pencil loaded a past user message;
            // sending it rewinds + resends instead of opening a new turn.
            if (editDraft) {
                setEditDraft(null);
                send({ type: 'editMessage', userIndex: editDraft.userIndex, value, attachments });
                return;
            }
            if (chat.busy) {
                // The agent loop lives in the extension - STEER the live run.
                // The message joins the conversation before the model's next
                // tool call; the in-flight bubble closes at the steer point
                // and the continuation opens a fresh one below it.
                dispatch({
                    type: 'steerUser',
                    value,
                    attachments: toAttachmentMeta(attachments),
                } as FromExtensionMessage);
                send({ type: 'steerRun', value, attachments });
                atBottom.current = true;
                const el = containerRef.current;
                if (el) {
                    el.scrollTo({ top: el.scrollHeight });
                    setShowJump(false);
                }
                return;
            }
            dispatch({
                type: 'restoreUser',
                value,
                attachments: toAttachmentMeta(attachments),
            } as FromExtensionMessage);
            // Sending ALWAYS lands the view on the newest message, even if
            // the user was scrolled up reading history - following the
            // STREAM afterwards stays conditional (atBottom), so scrolling
            // up mid-response is never fought.
            atBottom.current = true;
            const el = containerRef.current;
            if (el) {
                el.scrollTo({ top: el.scrollHeight });
                setShowJump(false);
            }
            send({ type: 'askQuestion', value, attachments });
        },
        [chat.busy, send, editDraft]
    );

    const handleCancel = useCallback(() => {
        send({ type: 'cancelRequest' });
    }, [send]);

    // MessageItem memoizes on callback identity - these MUST be stable or the
    // memo is defeated and every chunk re-renders the ENTIRE message list
    // (the streaming bubble re-renders dozens of times per second).
    const handleApprovalDecision = useCallback(
        (approvalId: string, decisions: Record<string, boolean>, sessionApprove?: boolean) =>
            send({ type: 'approvalDecision', approvalId, decisions, sessionApprove }),
        [send]
    );
    const handleRegenerate = useCallback(() => send({ type: 'regenerate' }), [send]);
    // Pencil on a user bubble: load the message into the composer card for
    // editing (handleSend performs the rewind-resend when it goes out).
    const handleEditMessage = useCallback(
        (userIndex: number, value: string) => setEditDraft({ userIndex, value }),
        []
    );

    // Task-list edit: optimistic local update + host persistence (the host
    // stores the per-session override and echoes taskListState back).
    const handleTaskListEdit = useCallback(
        (tasks: TaskListItem[]) => {
            setTaskList(tasks);
            send({ type: 'taskListEdit', tasks });
        },
        [send]
    );

    // The newest update_task_list step is the interactive checklist; older
    // ones render read-only from their own args (stepId no longer matches).
    const taskListView = useMemo(() => {
        for (let i = chat.messages.length - 1; i >= 0; i--) {
            const m = chat.messages[i];
            if (m.role !== 'assistant') continue;
            for (let j = m.steps.length - 1; j >= 0; j--) {
                const s = m.steps[j];
                if (s.kind === 'toolCall' && s.tool === TASK_LIST_TOOL) {
                    const parsed = parseTaskListStep(s.text);
                    if (!parsed) return null;
                    return {
                        stepId: s.id,
                        tasks: taskList ?? parsed,
                        editable: !!s.result,
                        onChange: handleTaskListEdit,
                    };
                }
            }
        }
        return null;
    }, [chat.messages, taskList, handleTaskListEdit]);

    // Header progress chip (Cline/Kilo-style "3/8" readout) - hidden while
    // the session has no task list.
    const taskProgress = useMemo(() => {
        if (!taskListView || taskListView.tasks.length === 0) return null;
        const total = taskListView.tasks.length;
        const done = taskListView.tasks.filter((t) => t.status === 'completed').length;
        return { done, total, pct: Math.round((done / total) * 100) };
    }, [taskListView]);

    // The chip toggles a dropdown panel listing the tasks in place (no
    // scroll-to-anchor). Dismiss on any click outside the chip + panel.
    const [taskChipOpen, setTaskChipOpen] = useState(false);
    useEffect(() => {
        if (!taskChipOpen) return;
        const close = (e: MouseEvent) => {
            const target = e.target as Element | null;
            if (!target?.closest('.task-list-chip-wrap')) setTaskChipOpen(false);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [taskChipOpen]);

    // In-app notification banner - rendered on every screen so host
    // notifications (and confirm banners) are always visible.
    const banner = (
        <NotificationBanner notifications={notifications} onDismiss={dismissNotification} />
    );

    if (screen === 'credentials') {
        return (
            <div className="app" dir={locale === 'fa' ? 'rtl' : 'ltr'}>
                <CredentialsPage
                    key={credNonce}
                    reason={credReason}
                    error={byokError}
                    currentUrl={credUrl}
                    activeCredentialId={activeCredentialId}
                    initialOpenCard={credOpenCard}
                    savedCredentials={savedCredentials}
                    localRuntimes={localRuntimes}
                    localModelsScanning={localModelsScanning}
                    localScanError={localScanError}
                    onRetryFetch={() => {
                        // Remount the page (same as leaving and re-entering):
                        // the mount effect re-runs local discovery with fresh state.
                        setCredNonce((n) => n + 1);
                        send({ type: 'listModels' });
                    }}
                    modelsRefreshing={modelsRefreshing}
                    onSave={(base_url, api_key) => send({ type: 'saveLlmCredentials', base_url, api_key, returnToChat: savedCredentials.length === 0 })}
                    onSelectCredential={(id) => send({ type: 'selectLlmCredential', id })}
                    onDeleteCredential={(id) => send({ type: 'deleteLlmCredential', id })}
                    onUpdateCredential={(id, api_key) => send({ type: 'updateLlmCredential', id, api_key })}
                    onDiscoverLocalModels={startLocalScan}
                    onSaveLocalRuntime={(baseUrl, apiKey) => send({ type: 'saveLlmCredentials', base_url: baseUrl, api_key: apiKey ?? '', returnToChat: savedCredentials.length === 0 })}
                    onBack={() => setScreen(credReturnTo)}
                />
                {banner}
            </div>
        );
    }

    if (screen === 'capabilities') {
        return (
            <div className="app" dir={locale === 'fa' ? 'rtl' : 'ltr'}>
                <CapabilitiesPage
                    onBack={() => setScreen(capReturnTo)}
                    onOpenRawSettings={() => send({ type: 'openMcpSettings' })}
                    servers={mcpServers}
                    hasWorkspace={mcpHasWorkspace}
                    legacyInUse={mcpLegacyInUse}
                    registry={mcpRegistry}
                    skills={skills}
                    onRefreshMcp={() => send({ type: 'mcpGetState' })}
                    onSave={(target: McpSaveTarget, list: McpServerPayload[]) => send({ type: 'mcpSave', target, servers: list })}
                    onRestart={(name) => send({ type: 'mcpRestart', name })}
                    onRefreshSkills={() => send({ type: 'skillsGetState' })}
                    onToggleSkill={(id, enabled) => send({ type: 'skillsToggle', id, enabled })}
                    onRevealSkillsFolder={(dirPath) => send({ type: 'skillsReveal', ...(dirPath ? { dirPath } : {}) })}
                    onOpenSkill={(dirPath) => send({ type: 'skillsOpen', dirPath })}
                    onNewSkill={() => send({ type: 'skillsCreate' })}
                    onDeleteSkill={(dirPath) => send({ type: 'skillsDelete', dirPath })}
                />
                {banner}
            </div>
        );
    }

    if (screen === 'settings') {
        return (
            <div className="app" dir={locale === 'fa' ? 'rtl' : 'ltr'}>
                <SettingsPage
                    onBack={() => setScreen('chat')}
                    error={byokError}
                    version={extensionVersion}
                    locale={locale}
                    onSetLocale={(l) => {
                        setLocale(l);
                        setLocaleState(l);
                        send({ type: 'setLocale', locale: l });
                    }}
                    onOpenCredentials={() => {
                        setCredReturnTo('settings');
                        setScreen('credentials');
                    }}
                    onOpenCapabilities={() => {
                        setCapReturnTo('settings');
                        setScreen('capabilities');
                        send({ type: 'mcpGetState' });
                        send({ type: 'skillsGetState' });
                    }}
                    onClearHistory={() => {
                        // "Clear history" really clears: every stored session
                        // on this machine is deleted, then a fresh one starts.
                        send({ type: 'clearAllSessions' });
                    }}
                />
                {banner}
            </div>
        );
    }

    if (screen === 'boot') {
        // Empty shell until the host resolves the start screen - keeps the
        // locale/direction root mounted without flashing the welcome page.
        return <div className="app" dir={locale === 'fa' ? 'rtl' : 'ltr'} />;
    }

    if (screen === 'welcome') {
        return (
            <div className="app" dir={locale === 'fa' ? 'rtl' : 'ltr'}>
                <Welcome
                    localRuntimes={localRuntimes}
                    localModelsScanning={localModelsScanning}
                    localScanError={localScanError}
                    locale={locale}
                    onSetLocale={(l) => {
                        setLocale(l);
                        setLocaleState(l);
                        send({ type: 'setLocale', locale: l });
                    }}
                    onConnectRuntime={(rt) =>
                        send({ type: 'saveLlmCredentials', base_url: rt.baseUrl, api_key: '', returnToChat: true })
                    }
                    onOpenCredentials={() => send({ type: 'openCredentials' })}
                    onRescan={startLocalScan}
                />
                {banner}
            </div>
        );
    }

    return (
        <div className="app" dir={locale === 'fa' ? 'rtl' : 'ltr'}>
            <Toolbar
                conn={conn}
                yolo={yolo}
                plan={plan}
                sessionTitle={sessionTitle}
                sessionsOpen={sessionsOpen}
                sessions={sessions}
                sessionsLoading={sessionsLoading}
                currentSessionId={currentSessionId}
                sessionsScope={sessionsScope}
                onNewSession={() => {
                    setEditDraft(null);
                    send({ type: 'newSession' });
                }}
                onToggleSessions={() => {
                    setSessionsOpen((open) => {
                        if (!open) {
                            setSessionsLoading(true);
                            setSessions([]);
                            send({ type: 'listSessions', all: sessionsScope === 'all' });
                        }
                        return !open;
                    });
                }}
                onSessionsScope={(scope) => {
                    setSessionsScope(scope);
                    if (sessionsOpen) {
                        setSessionsLoading(true);
                        send({ type: 'listSessions', all: scope === 'all' });
                    }
                }}
                onOpenSession={(id) => {
                    setSessionsOpen(false);
                    setEditDraft(null);
                    send({ type: 'openSession', id });
                }}
                onRenameSession={(id, title) => send({ type: 'renameSession', id, title })}
                onDeleteSession={(id) => {
                    send({ type: 'deleteSession', id });
                    // The host refreshes the list itself (open-deletion resets
                    // the webview); the remaining rows just go stale briefly.
                }}
                onToggleYolo={() => send({ type: 'toggleYolo' })}
                onTogglePlan={() => send({ type: 'togglePlanMode' })}
                onEditCredentials={() => {
                    // byokHint stays: the setup empty state must persist until
                    // models actually load (modelInfo clears it), not until
                    // the user peeks at the credentials page and returns.
                    setByokError(null);
                    send({ type: 'openCredentials' });
                }}
                onOpenCapabilities={() => {
                    setCapReturnTo('chat');
                    setScreen('capabilities');
                    send({ type: 'mcpGetState' });
                    send({ type: 'skillsGetState' });
                }}
                onOpenSettings={() => setScreen('settings')}
            />
            {taskProgress && taskListView && (
                <div className="task-list-chip-wrap">
                    <button
                        type="button"
                        className={`task-list-chip${taskChipOpen ? ' open' : ''}`}
                        aria-label={t('taskListChipAria')}
                        aria-expanded={taskChipOpen}
                        title={t('taskListChipAria')}
                        onClick={() => setTaskChipOpen((o) => !o)}
                    >
                        <ListChecks size={13} />
                        <span className="task-list-chip-bar" aria-hidden="true">
                            <span style={{ width: `${taskProgress.pct}%` }} />
                        </span>
                        <span dir="ltr">
                            {taskProgress.done}/{taskProgress.total}
                        </span>
                        <ChevronDown size={12} className="task-list-chip-caret" />
                    </button>
                    {taskChipOpen && (
                        <div className="task-list-chip-menu">
                            <div className="task-list-chip-menu-list">
                                <TaskListEditor
                                    tasks={taskListView.tasks}
                                    editable={taskListView.editable && !chat.busy}
                                    onChange={taskListView.onChange}
                                />
                            </div>
                        </div>
                    )}
                </div>
            )}
            <div className="chat-area">
                <MessageList
                    ref={containerRef}
                    contentRef={attachContentObserver}
                    onScroll={onScroll}
                    messages={chat.messages}
                    busy={chat.busy}
                    conn={conn}
                    setupMode={byokHint && !byokError}
                    onOpenCredentials={(target) => send({ type: 'openCredentials', target })}
                    activeFile={activeFile}
                    onPickSuggestion={(text) => setInjectedText({ id: Date.now(), text })}
                    onApprovalDecision={handleApprovalDecision}
                    onRegenerate={handleRegenerate}
                    onEditMessage={handleEditMessage}
                />
                {showJump && (
                    <button
                        type="button"
                        className="jump-btn"
                        onClick={jumpToBottom}
                        aria-label={t('jumpToBottom')}
                        title={t('jumpToBottom')}
                    >
                        <ChevronDown size={16} />
                    </button>
                )}
            </div>
            {/* Connection/setup ERRORS only - the "no creds configured" hint
                lives in the empty message list (setupMode), not here. */}
            {byokError && (
                <div className="byok-hint err" role="alert">
                    <div className="byok-hint-icon">
                        <Link size={14} />
                    </div>
                    <div className="byok-hint-copy">
                        <strong>{t('credSetupError')}</strong>
                        <span>{byokError}</span>
                    </div>
                        <button
                            type="button"
                            className="chip-btn"
                            onClick={() => {
                                setCredReason(null);
                                setCredReturnTo('chat');
                                setScreen('credentials');
                            }}
                        >
                        {t('credFix')}
                    </button>
                </div>
            )}
            {/* In-app banners sit above the composer card, same slot as the
                byok-hint banner. */}
            {banner}
            <InputBar
                busy={chat.busy}
                usage={chat.lastUsage}
                contextWindow={
                    (selectedModel ? ctxOverrides[selectedModel] : undefined) ??
                    resolveWindow(modelInfo?.contextWindows, selectedModel)
                }
                defaultContextWindow={resolveWindow(modelInfo?.contextWindows, selectedModel)}
                ctxOverridden={!!(selectedModel && ctxOverrides[selectedModel] != null)}
                planMode={plan}
                onSend={handleSend}
                onCancel={handleCancel}
                injectedText={injectedText}
                onInjectedApplied={() => setInjectedText(null)}
                models={modelInfo?.models ?? []}
                selectedModel={selectedModel}
                onSelectModel={(m) => {
                    setSelectedModel(m);
                    send({ type: 'selectModel', value: m });
                }}
                onRefreshModels={() => send({ type: 'listModels' })}
                refreshing={modelsRefreshing}
                onSetContextWindow={(win) => {
                    if (!selectedModel) return;
                    setCtxOverrides((c) => {
                        const next = { ...c };
                        if (win != null) next[selectedModel] = win;
                        else delete next[selectedModel];
                        return next;
                    });
                    send({ type: 'setContextWindowOverride', model: selectedModel, window: win });
                }}
                thinkingLevel={selectedModel ? thinkingLevels[selectedModel] ?? null : null}
                onSetThinkingLevel={(level) => {
                    if (!selectedModel) return;
                    setThinkingLevels((c) => {
                        const next = { ...c };
                        if (level != null) next[selectedModel] = level;
                        else delete next[selectedModel];
                        return next;
                    });
                    send({ type: 'setThinkingLevel', model: selectedModel, level });
                }}
                modelVisionCapable={visionCapable}
                restoreDraft={composerRestore}
                onRestoreApplied={() => setComposerRestore(null)}
                injectedAttachments={hostAttachments}
                onInjectedAttachmentsApplied={() => setHostAttachments(null)}
                hostError={composerError}
                onHostErrorApplied={() => setComposerError(null)}
                editDraft={editDraft}
                onCancelEdit={() => setEditDraft(null)}
                workspaceFiles={workspaceFiles}
                onRequestFiles={() => send({ type: 'requestFileList' })}
            />
        </div>
    );
}

/** Resolve the model's context window using the backend-served table
 *  (longest substring match - mirrors deps.resolve_context_window). */
function resolveWindow(
    table: Record<string, number> | undefined,
    model: string | null
): number | null {
    if (!table || !model) return null;
    const lowered = model.toLowerCase();
    let best: { len: number; win: number } | null = null;
    for (const [needle, win] of Object.entries(table)) {
        if (lowered.includes(needle.toLowerCase()) && (!best || needle.length > best.len)) {
            best = { len: needle.length, win };
        }
    }
    return best?.win ?? null;
}
