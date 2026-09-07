import type { ChatMessage, FromExtensionMessage, Step } from './types';
import { t, tf, tOrRaw } from './i18n';

export interface ChatState {
    messages: ChatMessage[];
    busy: boolean;
    streamingId: string | null;
    lastUsage: ChatMessage['usage'];
}

let _id = 0;
export function nextId(): string {
    return `m${++_id}-${Date.now().toString(36)}`;
}

export function createInitialChatState(): ChatState {
    return { messages: [], busy: false, streamingId: null, lastUsage: null };
}

function append(state: ChatState, msg: ChatMessage): ChatState {
    return { ...state, messages: [...state.messages, msg] };
}

function patch(state: ChatState, id: string, p: Partial<ChatMessage>): ChatState {
    return {
        ...state,
        messages: state.messages.map((m) => (m.id === id ? { ...m, ...p } : m)),
    };
}

// All-zero usage is MEANINGLESS, never a real measurement: every turn has
// prompt tokens > 0. Providers that ignore stream_options.include_usage make
// the backend's run.usage() report {0, 0} on every round and the result -
// treating that as a real value pinned the context meter at 0% (input bar
// "resets to 0" every turn while the model kept its context). Zeros and
// nulls are therefore the same: keep the last known fill instead.
function meaningfulUsage(u: ChatMessage['usage']): ChatMessage['usage'] {
    return u && ((u.input_tokens ?? 0) + (u.output_tokens ?? 0) > 0) ? u : null;
}

function ensureStreaming(state: ChatState): { state: ChatState; id: string } {
    if (state.streamingId) {
        const exists = state.messages.some((m) => m.id === state.streamingId);
        if (exists) return { state, id: state.streamingId };
    }
    const id = nextId();
    const msg: ChatMessage = {
        id,
        role: 'assistant',
        text: '',
        steps: [],
        status: 'streaming',
        createdAt: Date.now(),
    };
    return { state: { ...state, streamingId: id, messages: [...state.messages, msg] }, id };
}

/** Drop the userIndex-th user bubble and EVERYTHING after it (edit/resend
 *  and regenerate rewind the visible timeline alongside server history). */
function truncateFromUser(messages: ChatMessage[], userIndex: number): ChatMessage[] {
    let seen = -1;
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'user') {
            seen++;
            if (seen === userIndex) return messages.slice(0, i);
        }
    }
    return messages;
}

export function reduceChat(state: ChatState, msg: FromExtensionMessage): ChatState {
    switch (msg.type) {
        case 'restoreUser':
            return append(state, {
                id: nextId(),
                role: 'user',
                text: msg.value,
                steps: [],
                status: 'done',
                createdAt: Date.now(),
                attachments: msg.attachments,
            });

        case 'steerUser': {
            // Steering a live run: the in-flight assistant bubble CLOSES at
            // the steer point (streamingId cleared, so the next chunk opens
            // a fresh bubble AFTER the steer) and the steer renders as a
            // normal user bubble - the timeline reads in true order. A fresh
            // streaming bubble opens IMMEDIATELY: while the run finishes the
            // current round (tool execution can take a while) the user sees
            // the typing indicator, not a dead timeline.
            const closed = state.streamingId
                ? patch(state, state.streamingId, { status: 'done' })
                : state;
            const { state: s } = ensureStreaming(
                append(
                    { ...closed, streamingId: null },
                    {
                        id: nextId(),
                        role: 'user',
                        text: msg.value,
                        steps: [],
                        status: 'done',
                        createdAt: Date.now(),
                        attachments: msg.attachments,
                        steered: true,
                    }
                )
            );
            return s;
        }

        case 'startResponse': {
            const { state: s } = ensureStreaming(state);
            return { ...s, busy: true };
        }

        case 'chunk': {
            const { state: s, id } = ensureStreaming(state);
            return {
                ...s,
                messages: s.messages.map((m) => {
                    if (m.id !== id) return m;
                    // Streamed text is a TIMELINE segment, not a bottom blob:
                    // it extends the trailing text step so prose interleaves
                    // chronologically with the thinking/tool pills around it.
                    const steps = [...m.steps];
                    const last = steps[steps.length - 1];
                    if (last && last.kind === 'text') {
                        steps[steps.length - 1] = { ...last, text: last.text + msg.value };
                    } else {
                        steps.push({ id: nextId(), kind: 'text', text: msg.value });
                    }
                    return { ...m, steps, text: m.text + msg.value };
                }),
            };
        }

        case 'streamHtml': {
            // Live markdown from the host (throttled, pre-sanitized) for the
            // CURRENT text segment. Patches the LAST text step so formatted
            // markdown renders BETWEEN the pills while streaming - not only
            // after fullResponse. Only touches messages still streaming so
            // it can never clobber a finalized fullResponse that arrived in
            // the same tick.
            const id = state.streamingId;
            if (!id) return state;
            return {
                ...state,
                messages: state.messages.map((m) => {
                    if (m.id !== id) return m;
                    const steps = [...m.steps];
                    // The host's live render covers the CURRENT segment - the
                    // trailing text step while the stream is mid-prose. When
                    // the last step is not text (a thinking/tool event raced
                    // the 250ms timer and closed the segment), fall back to
                    // message-level renderedHtml: MessageItem ignores it
                    // while text steps exist, so nothing is misplaced.
                    if (steps.length > 0 && steps[steps.length - 1].kind === 'text') {
                        steps[steps.length - 1] = { ...steps[steps.length - 1], html: msg.value };
                        return { ...m, steps };
                    }
                    return { ...m, renderedHtml: msg.value };
                }),
            };
        }

        case 'thinking': {
            const { state: s, id } = ensureStreaming(state);
            return {
                ...s,
                messages: s.messages.map((m) => {
                    if (m.id !== id) return m;
                    const now = Date.now();
                    const steps = [...m.steps];
                    // Backend events are cumulative WITHIN one reasoning block
                    // and RESET when the model starts a fresh block. Extend the
                    // latest thinking pill while the text grows; otherwise open
                    // a NEW pill. A new pill after tool calls is what keeps the
                    // running spinner visible while the model reasons post-tool.
                    // Match the latest THINKING step anywhere in the list (not
                    // just the trailing step): a text chunk can land between
                    // two thinking deltas (the host flushes chunks first), and
                    // extending only the trailing step would fork the block
                    // into a duplicate pill re-showing the same text.
                    let target = -1;
                    for (let j = steps.length - 1; j >= 0; j--) {
                        if (steps[j].kind === 'thinking') {
                            target = j;
                            break;
                        }
                    }
                    if (target >= 0 && msg.value.startsWith(steps[target].text)) {
                        steps[target] = { ...steps[target], text: msg.value, endedAt: now };
                    } else {
                        steps.push({
                            id: nextId(),
                            kind: 'thinking',
                            text: msg.value,
                            startedAt: now,
                            endedAt: now,
                        });
                    }
                    return { ...m, steps };
                }),
            };
        }

        case 'thinkingHtml': {
            // Live markdown for the CURRENT thinking block: patch the latest
            // thinking step's html with the same targeting the cumulative
            // 'thinking' case uses (latest THINKING step anywhere in the
            // list - a text chunk may have landed between two deltas).
            const id = state.streamingId;
            if (!id) return state;
            return {
                ...state,
                messages: state.messages.map((m) => {
                    if (m.id !== id) return m;
                    const steps = [...m.steps];
                    for (let j = steps.length - 1; j >= 0; j--) {
                        if (steps[j].kind === 'thinking') {
                            steps[j] = { ...steps[j], html: msg.value };
                            return { ...m, steps };
                        }
                    }
                    return m;
                }),
            };
        }

        case 'toolCall': {
            const { state: s, id } = ensureStreaming(state);
            return {
                ...s,
                messages: s.messages.map((m) => {
                    if (m.id !== id) return m;
                    // Deferred calls can be re-emitted on resume; an id that
                    // already has a row must not open a second one - the
                    // duplicate would spin forever with no result of its own.
                    if (msg.callId && m.steps.some((st) => st.kind === 'toolCall' && st.callId === msg.callId)) {
                        return m;
                    }
                    const step: Step = {
                        id: nextId(),
                        kind: 'toolCall',
                        tool: msg.tool,
                        text: msg.args,
                        open: true,
                        callId: msg.callId,
                    };
                    return { ...m, steps: [...m.steps, step] };
                }),
            };
        }

        case 'toolResult': {
            const { state: s, id } = ensureStreaming(state);
            return {
                ...s,
                messages: s.messages.map((m) => {
                    if (m.id !== id) return m;
                    const steps = [...m.steps];
                    // Pair by server tool_call_id when available; fall back to
                    // the most recent unpaired call row for legacy events that
                    // carry no id (Cline-style paired rows).
                    let idx = -1;
                    if (msg.callId) {
                        idx = steps.findIndex(
                            (st) => st.kind === 'toolCall' && !st.result && st.callId === msg.callId
                        );
                    }
                    if (idx < 0) {
                        for (let i = steps.length - 1; i >= 0; i--) {
                            const st = steps[i];
                            if (st.kind === 'toolCall' && !st.result) {
                                idx = i;
                                break;
                            }
                        }
                    }
                    if (idx >= 0) {
                        steps[idx] = { ...steps[idx], result: tOrRaw(msg.output) };
                    } else {
                        // Orphan result - render as a completed standalone row,
                        // not a call-shaped row with an empty args section.
                        steps.push({
                            id: nextId(),
                            kind: 'toolResult',
                            tool: msg.tool,
                            text: '',
                            result: tOrRaw(msg.output),
                        });
                    }
                    return { ...m, steps };
                }),
            };
        }

        case 'usage': {
            // Mid-run cumulative usage - including the per-streamed-token
            // estimates both runtimes emit while a response streams: the
            // context meter moves with every streamed token, not only when
            // a round completes. A fullResponse carrying a real usage
            // object is authoritative and overwrites this; a zero/absent
            // one must NOT erase the last known fill - the conversation's
            // occupied context never shrinks between turns.
            return { ...state, lastUsage: meaningfulUsage(msg.usage) ?? state.lastUsage };
        }

        case 'fullResponse': {
            const id = state.streamingId;
            if (!id) {
                return { ...state, busy: false, lastUsage: meaningfulUsage(msg.usage) ?? state.lastUsage };
            }
            const streaming = state.messages.find((m) => m.id === id);
            const segs = msg.segmentsHtml;
            const textSteps = streaming ? streaming.steps.filter((st) => st.kind === 'text') : [];
            // When the host's per-segment renders line up with the streamed
            // text steps, each step carries its FINAL formatted content
            // between the pills - nothing is collapsed back into one bottom
            // block. On a mismatch (e.g. an approval resume continued a text
            // run) fall back to the single rendered block and drop the raw
            // segments so nothing renders twice.
            let steps: Step[] | undefined;
            let renderedHtml = msg.renderedHtml;
            if (streaming && segs && segs.length > 0 && segs.length === textSteps.length) {
                let i = 0;
                steps = streaming.steps.map((st) =>
                    st.kind === 'text' ? { ...st, html: segs[i++] } : st
                );
                renderedHtml = undefined;
            } else if (streaming && textSteps.length > 0) {
                steps = streaming.steps.filter((st) => st.kind !== 'text');
            }
            return {
                ...patch(state, id, {
                    renderedHtml,
                    text: msg.persian ?? '',
                    status: 'done',
                    usage: meaningfulUsage(msg.usage),
                    retryStatus: null,
                    ...(steps ? { steps } : {}),
                }),
                busy: false,
                streamingId: null,
                lastUsage: meaningfulUsage(msg.usage) ?? state.lastUsage,
            };
        }

        case 'byokReset': {
            // Leaving chat for the credentials page: drop streaming state
            return { ...state, busy: false, streamingId: null };
        }

        case 'retrying': {
            // Show retry count on the streaming bubble so the user sees the
            // system working - without this, a fast-failing connection looks
            // like an instant error.
            const id = state.streamingId;
            if (!id) return state;
            return {
                ...state,
                messages: state.messages.map((m) =>
                    m.id === id
                        ? { ...m, retryStatus: { attempt: msg.attempt, maxAttempts: msg.maxAttempts, nextRetryInMs: msg.nextRetryInMs } }
                        : m
                ),
            };
        }

        case 'attempting': {
            // Host is about to try a fetch - clear any previous retry countdown
            // so the bubble falls back to the typing dots (rendered yellow via
            // the conn-disconnected class on the bubble).
            const id = state.streamingId;
            if (!id) return state;
            return {
                ...state,
                messages: state.messages.map((m) =>
                    m.id === id
                        ? { ...m, retryStatus: null }
                        : m
                ),
            };
        }

        case 'error': {
            // Host posts i18n KEYS (+ optional params); raw backend text
            // passes through tOrRaw untouched.
            const value = msg.valueKey ? tf(msg.valueKey, msg.params) : tOrRaw(msg.value ?? '');
            if (state.streamingId) {
                // Cancellation/errors must NEVER wipe what already streamed:
                // keep text/steps, mark status, and close any pending tool
                // rows so nothing spins forever.  But if nothing streamed yet
                // (connection died before first chunk), show the error text so
                // the bubble is not empty.
                return {
                    ...state,
                    messages: state.messages.map((m) =>
                        m.id === state.streamingId
                            ? {
                                  ...m,
                                  text: m.text || value,
                                  // Keep the streamed content AND the reason:
                                  // red styling with no explanation reads as
                                  // a silent death ("stopped red without an
                                  // error message"). Streamed content can
                                  // live in steps/renderedHtml alone - m.text
                                  // is NOT a complete indicator.
                                  errorText: (m.text || m.renderedHtml || m.steps.length > 0) ? value : undefined,
                                  retryStatus: null,
                                  steps: m.steps.map((st) =>
                                      st.kind === 'toolCall' && !st.result
                                          ? { ...st, result: t('resultCancelled') }
                                          : st
                                  ),
                                  status: 'error' as const,
                                  tone: 'error' as const,
                              }
                            : m
                    ),
                    busy: false,
                    streamingId: null,
                };
            }
            return {
                ...append(state, {
                    id: nextId(),
                    role: 'assistant',
                    text: value,
                    steps: [],
                    status: 'error',
                    tone: 'error',
                    createdAt: Date.now(),
                }),
                busy: false,
            };
        }

        case 'needsApproval': {
            const approval = {
                approval_id: msg.approval_id,
                approvals: msg.approvals,
                preDenied: msg.preDenied,
            };
            if (state.streamingId) {
                const found = state.messages.some((m) => m.id === state.streamingId);
                if (found) {
                    return patch(state, state.streamingId, {
                        approval,
                        tone: undefined,
                    });
                }
            }

            return append(state, {
                id: nextId(),
                role: 'system',
                text: '',
                steps: [],
                status: 'done',
                tone: 'pending',
                createdAt: Date.now(),
                approval,
            });
        }

        case 'approvalResolved': {
            // An approval payload attached to the LIVE assistant bubble must
            // not delete that bubble - stripping the payload keeps the whole
            // streamed timeline (pills, partial text) visible while the run
            // resumes. Only the standalone system approval card goes away.
            return {
                ...state,
                messages: state.messages.flatMap((m) => {
                    if (m.approval?.approval_id !== msg.approval_id) return [m];
                    if (m.role === 'assistant') return [{ ...m, approval: undefined }];
                    return [];
                }),
            };
        }

        case 'sendFailed': {
            // A rejected send (the host's /chat fetch failed before any SSE
            // event) must give the composer back and never leave the typing
            // indicator spinning. Quota rejections arrive silent - the host
            // shows the actionable banner instead of a dead-end bubble, so
            // the empty streaming bubble is dropped. Non-silent rejections
            // turn it into the error bubble (same as 'error' did), and any
            // streamed content is closed out rather than dropped.
            const id = state.streamingId;
            const streaming = id ? state.messages.find((m) => m.id === id) : undefined;
            const value = msg.silent
                ? ''
                : (msg.valueKey ? tf(msg.valueKey, msg.params) : tOrRaw(msg.value ?? ''));
            let messages = state.messages;
            if (id && streaming) {
                if (!streaming.text && streaming.steps.length === 0 && !streaming.renderedHtml) {
                    // Nothing streamed: silent drops the empty bubble, the
                    // error path reuses it as the error bubble.
                    if (msg.silent) {
                        messages = messages.filter((m) => m.id !== id);
                    } else {
                        messages = messages.map((m) =>
                            m.id === id
                                ? { ...m, text: value, retryStatus: null, status: 'error' as const, tone: 'error' as const }
                                : m
                        );
                    }
                } else {
                    messages = messages.map((m) =>
                        m.id === id
                            ? {
                                  ...m,
                                  errorText: (m.text || m.renderedHtml || m.steps.length > 0) ? value : undefined,
                                  retryStatus: null,
                                  steps: m.steps.map((st) =>
                                      st.kind === 'toolCall' && !st.result
                                          ? { ...st, result: t('resultCancelled') }
                                          : st
                                  ),
                                  status: 'error' as const,
                                  tone: 'error' as const,
                              }
                            : m
                    );
                }
            } else if (!msg.silent && (msg.valueKey || msg.value)) {
                return { ...append(state, {
                    id: nextId(),
                    role: 'assistant',
                    text: value,
                    steps: [],
                    status: 'error',
                    tone: 'error',
                    createdAt: Date.now(),
                }), busy: false };
            }
            // The optimistic user bubble for THIS prompt was never accepted
            // as a turn (its text goes back to the composer) - remove it so
            // the webview's user-bubble indexing stays aligned with the host
            // ledger, which commits user rows for streamed turns only.
            // Without this, the next edit/regenerate rewinds the WRONG turn.
            if (msg.prompt) {
                const userIdx = messages.map((m) => m.role).lastIndexOf('user');
                if (
                    userIdx >= 0 &&
                    messages[userIdx].text === msg.prompt &&
                    messages.slice(userIdx + 1).every((m) => (id && m.id === id) || m.role === 'system')
                ) {
                    messages = messages.slice(0, userIdx);
                }
            }
            return { ...state, messages, busy: false, streamingId: null };
        }

        case 'truncateFromUser':
            return {
                ...state,
                messages: truncateFromUser(state.messages, msg.userIndex),
                busy: false,
                streamingId: null,
            };

        // Non-chat-affecting messages handled by the host shell.
        case 'connectionStatus':
        case 'showWelcome':
        case 'showChat':
        case 'yoloMode':
        case 'planMode':
        case 'taskListState':
        case 'modelInfo':
        case 'byokSetupHint':
        case 'byokCredentialError':
        case 'openCredentials':
        case 'credentialsSaved':
            return state;

        default:
            return state;
    }
}
