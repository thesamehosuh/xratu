import { forwardRef, type Ref } from 'react';
import { Bug, FolderTree, FlaskConical, FolderSearch, Laptop, Link, Unlink, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ChatMessage, ConnectionStatus } from '../types';
import { MessageItem, type TaskListView } from './MessageItem';
import { t } from '../i18n';

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
    { messages, onScroll, contentRef, onPickSuggestion, onApprovalDecision, onRegenerate, onEditMessage, busy, conn, setupMode, onOpenCredentials, activeFile, taskList },
    ref
) {
    // Per-item context the footer buttons need: 0-based index among USER
    // bubbles (matches the host's history indexing) and last-assistant flag.
    let userCount = 0;
    const userIndexOf = new Map<string, number>();
    for (const m of messages) {
        if (m.role === 'user') userIndexOf.set(m.id, userCount++);
    }
    const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;

    return (
        <div
            className="messages"
            ref={ref}
            onScroll={onScroll}
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
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
            {messages.map((m, i) => (
                <MessageItem
                    key={m.id}
                    message={m}
                    onApprovalDecision={onApprovalDecision}
                    onRegenerate={onRegenerate}
                    onEditMessage={onEditMessage}
                    userIndex={userIndexOf.get(m.id)}
                    isLastAssistant={m.id === lastAssistantId}
                    busy={busy}
                    conn={i === messages.length - 1 ? conn : undefined}
                    taskList={taskList && taskList.stepId && m.steps.some((s) => s.id === taskList.stepId) ? taskList : undefined}
                />
            ))}
            </div>
        </div>
    );
});
