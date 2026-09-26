import { forwardRef, type Ref } from 'react';
import { Bug, ChevronUp, FolderTree, FlaskConical, FolderSearch, Laptop, Link, Unlink, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ChatMessage, ConnectionStatus, OpenDiffEdit } from '../types';
import { MessageItem, type TaskListView } from './MessageItem';
import { getLocale, t } from '../i18n';

interface MessageListProps {
    messages: ChatMessage[];
    onScroll: () => void;
    /** Ref to the inner content wrapper - the host's ResizeObserver watches
     *  it so pill expand/collapse (content growth inside a fixed-height
     *  scroller) can keep the view pinned to the bottom. */
    contentRef?: Ref<HTMLDivElement>;
    onPickSuggestion: (text: string) => void;
    onApprovalDecision?: (approvalId: string, decisions: Record<string, boolean>) => void;
    /** Regenerate the last exchange (last assistant bubble only). */
    onRegenerate?: () => void;
    /** Load a user message into the composer card for editing (sending
     *  from the composer rewinds + resends). */
    onEditMessage?: (userIndex: number, value: string) => void;
    /** Restore workspace files to a turn's shadow checkpoint. */
    onRestoreCheckpoint?: (userIndex: number, sha: string) => void;
    /** Open the native diff editor for a completed edit step. */
    onOpenDiff?: (edits: OpenDiffEdit[]) => void;
    /** A run is in flight - footer actions hide while true. */
    busy?: boolean;
    /** Connection status - drives corner-bracket color on bubbles. */
    conn?: ConnectionStatus;
    /** No credential configured - empty state becomes a setup prompt. */
    setupMode?: boolean;
    /** Opens the credentials page; the target preselects the matching
     *  provider (remote-provider chip vs local-runtime chip). */
    onOpenCredentials?: (target: 'byok' | 'local') => void;
    /** Workspace-relative path of the file open in the active editor
     *  (host-pushed) - file-dependent suggestions name it. */
    activeFile?: string | null;
    /** Interactive view for the current update_task_list step (see
     *  MessageItem). Undefined when the session has no task list. */
    taskList?: TaskListView;
    /** Index of the first message to MOUNT. Older messages stay in the array
     *  (indices below are absolute) and are revealed by `onShowEarlier` - the
     *  live transcript is complete, only the DOM window is bounded. */
    firstVisible?: number;
    onShowEarlier?: () => void;
}

// Chips show a short label; the click builds a full WORKFLOW PROMPT that the
// composer types out and auto-sends. File-dependent suggestions name the
// active editor file when one exists, and fall back to a "pick the most
// central file yourself" directive so the agent always has a starting move.
const SUGGESTIONS: Array<{ icon: LucideIcon; key: Parameters<typeof t>[0]; filePromptKey: Parameters<typeof t>[0]; anyPromptKey?: Parameters<typeof t>[0] }> = [
    { icon: FolderTree, key: 'suggestExplore', filePromptKey: 'suggestExplorePrompt' },
    { icon: Bug, key: 'suggestBug', filePromptKey: 'suggestBugPromptFile', anyPromptKey: 'suggestBugPromptAny' },
    { icon: FlaskConical, key: 'suggestTest', filePromptKey: 'suggestTestPromptFile', anyPromptKey: 'suggestTestPromptAny' },
    { icon: Zap, key: 'suggestOptimize', filePromptKey: 'suggestOptimizePromptFile', anyPromptKey: 'suggestOptimizePromptAny' },
];

export const MessageList = forwardRef<HTMLDivElement, MessageListProps>(function MessageList(
    { messages, onScroll, contentRef, onPickSuggestion, onApprovalDecision, onRegenerate, onEditMessage, onRestoreCheckpoint, onOpenDiff, busy, conn, setupMode, onOpenCredentials, activeFile, taskList, firstVisible = 0, onShowEarlier },
    ref
) {
    // Per-item context the footer buttons need: 0-based index among USER
    // bubbles (matches the host's history indexing) and last-assistant flag.
    // Computed over the FULL array so indices stay absolute even when only a
    // window is mounted.
    let userCount = 0;
    const userIndexOf = new Map<string, number>();
    for (const m of messages) {
        if (m.role === 'user') userIndexOf.set(m.id, userCount++);
    }
    const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;
    // Clamp so an out-of-range window still mounts the newest bubble (never a
    // blank list) and never starts past the end.
    const start = Math.max(0, Math.min(firstVisible, messages.length - 1));

    // Bubble direction follows the app locale. Computed here (not inside the
    // memoized MessageItem) so a language flip re-renders existing bubbles
    // through the item's comparator.
    const dir = getLocale() === 'fa' ? 'rtl' : 'ltr';
    return (
        <div
            className="messages"
            ref={ref}
            onScroll={onScroll}
            role="log"
            /* role="log" implies aria-live="polite"; the whole log would then
               re-announce on every streamed chunk. Live announcements are
               scoped to the streaming message instead (MessageItem). */
            aria-live="off"
            aria-label={t('historyAria')}
        >
            <div className="messages-inner" ref={contentRef}>
            {messages.length === 0 && setupMode && (
                <div className="empty-state">
                    <div className="empty-mark" aria-hidden="true">
                        <Unlink size={26} />
                    </div>
                    <h2>{t('credSetupTitle')}</h2>
                    <p>{t('credSetupDesc')}</p>
                    <div className="chip-row">
                        <button type="button" className="chip" onClick={() => onOpenCredentials?.('byok')}>
                            <Link size={14} />
                            {t('credSetupAction')}
                        </button>
                        <button type="button" className="chip" onClick={() => onOpenCredentials?.('local')}>
                            <Laptop size={14} />
                            {t('credLocalBannerAction')}
                        </button>
                    </div>
                </div>
            )}

            {messages.length === 0 && !setupMode && (
                <div className="empty-state">
                    <div className="empty-mark" aria-hidden="true">
                        <FolderSearch size={26} />
                    </div>
                    <h2>{t('emptyTitle')}</h2>
                    <p>{t('emptySub')}</p>
                    <div className="chip-row">
                        {SUGGESTIONS.map(({ icon: Icon, key, filePromptKey, anyPromptKey }, i) => {
                            // {file} templates need an open editor; without one
                            // the "any" variant tells the agent to pick itself.
                            const template = activeFile || !anyPromptKey ? filePromptKey : anyPromptKey;
                            const prompt = t(template).replace('{file}', activeFile ?? '');
                            return (
                                <button
                                    key={key}
                                    type="button"
                                    className="chip chip-suggest"
                                    disabled={busy}
                                    style={{ animationDelay: `${i * 70}ms` }}
                                    onClick={() => onPickSuggestion(prompt)}
                                >
                                    <Icon size={14} />
                                    {t(key)}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
            {start > 0 && (
                <button
                    type="button"
                    className="show-earlier"
                    onClick={onShowEarlier}
                    aria-label={t('historyShowEarlierAria')}
                    title={t('historyShowEarlierAria')}
                >
                    <ChevronUp size={13} aria-hidden="true" />
                    <span>{t('historyShowEarlier')}</span>
                </button>
            )}
            {messages.slice(start).map((m, i) => (
                <MessageItem
                    key={m.id}
                    message={m}
                    onApprovalDecision={onApprovalDecision}
                    onRegenerate={onRegenerate}
                    onEditMessage={onEditMessage}
                    onRestoreCheckpoint={onRestoreCheckpoint}
                    onOpenDiff={onOpenDiff}
                    userIndex={userIndexOf.get(m.id)}
                    isLastAssistant={m.id === lastAssistantId}
                    busy={busy}
                    conn={start + i === messages.length - 1 ? conn : undefined}
                    taskList={taskList && taskList.stepId && m.steps.some((s) => s.id === taskList.stepId) ? taskList : undefined}
                    dir={dir}
                />
            ))}
            </div>
        </div>
    );
});
