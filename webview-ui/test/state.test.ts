import { reduceChat, createInitialChatState } from '../src/state';
import type { FromExtensionMessage } from '../src/types';

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
    if (cond) pass++;
    else {
        fail++;
        console.error('  FAIL:', name);
    }
}

const M = (type: string, extra: Record<string, unknown> = {}): FromExtensionMessage =>
    ({ type, ...extra }) as FromExtensionMessage;

// 1. Initial
let s = createInitialChatState();
ok(s.messages.length === 0 && !s.busy && s.streamingId === null, 'initial state');

// 2. Happy path
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
ok(s.busy && s.streamingId, 'startResponse sets busy+streaming');
const sid = s.streamingId!;
s = reduceChat(s, M('chunk', { value: 'سلام' }));
s = reduceChat(s, M('chunk', { value: ' دنیا' }));
let st = s.messages.find((m) => m.id === sid)!;
ok(st.text === 'سلام دنیا', 'chunks concatenate');
s = reduceChat(s, M('fullResponse', { persian: 'final', usage: { input_tokens: 3, output_tokens: 4 } }));
ok(!s.busy && s.streamingId === null, 'fullResponse clears busy+streaming');
st = s.messages.find((m) => m.id === sid)!;
ok(st.status === 'done' && st.text === 'final', 'fullResponse finalizes');
ok(s.lastUsage?.input_tokens === 3 && s.lastUsage?.output_tokens === 4, 'usage surfaced to state');

// 3. thinking + tool timeline
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
s = reduceChat(s, M('thinking', { value: 'thinking…' }));
s = reduceChat(s, M('toolCall', { tool: 'read_file', args: '{"path":"a"}' }));
s = reduceChat(s, M('toolResult', { tool: 'read_file', output: 'content' }));
s = reduceChat(s, M('fullResponse', { renderedHtml: '<p>ok</p>' }));
const a = s.messages[s.messages.length - 1];
ok(a.steps.length === 2, 'result pairs into call row (two steps)');
ok(
    a.steps[0].kind === 'thinking' && a.steps[1].kind === 'toolCall',
    'step order'
);
ok(
    a.steps[1].result === 'content',
    'tool result attached to its call row'
);
ok(a.renderedHtml === '<p>ok</p>', 'renderedHtml set');

// 4. Error without streaming
s = createInitialChatState();
s = reduceChat(s, M('error', { value: 'boom' }));
ok(s.messages.length === 1 && s.messages[0].status === 'error' && !s.busy, 'error without stream');

// 5. Error during streaming
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
const sid2 = s.streamingId!;
s = reduceChat(s, M('chunk', { value: 'partial' }));
s = reduceChat(s, M('error', { value: 'failed' }));
st = s.messages.find((m) => m.id === sid2)!;
ok(st.status === 'error' && !s.busy && s.streamingId === null, 'streaming error handled');
ok(st.text === 'partial' && st.errorText === 'failed', 'streamed text kept with error reason');

// 5b. Error with renderedHtml-only / steps-only content - the reason must
// still land in errorText (m.text is NOT a complete content indicator).
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
const sid3 = s.streamingId!;
s = reduceChat(s, M('streamHtml', { value: '<p>md</p>' }));
s = reduceChat(s, M('error', { value: 'html failed' }));
st = s.messages.find((m) => m.id === sid3)!;
ok(st.status === 'error' && st.renderedHtml === '<p>md</p>', 'renderedHtml content preserved');
ok(st.errorText === 'html failed', 'renderedHtml-only failure reason kept');

s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
const sid4 = s.streamingId!;
s = reduceChat(s, M('toolCall', { tool: 'read_file', args: '{}', callId: 'tc1' }));
s = reduceChat(s, M('error', { value: 'tools failed' }));
st = s.messages.find((m) => m.id === sid4)!;
ok(st.status === 'error' && st.steps.length === 1, 'steps content preserved');
ok(
    st.steps[0].kind === 'toolCall' && st.steps[0].callId === 'tc1' && st.steps[0].result,
    'error path keeps the original tool step with its result'
);
ok(st.errorText === 'tools failed', 'steps-only failure reason kept');

// 5c. sendFailed with steps-only content - same predicate.
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
const sid5 = s.streamingId!;
s = reduceChat(s, M('toolCall', { tool: 'read_file', args: '{}', callId: 'tc2' }));
s = reduceChat(s, M('sendFailed', { value: 'rejected' }));
st = s.messages.find((m) => m.id === sid5)!;
ok(st.status === 'error' && st.errorText === 'rejected', 'sendFailed steps-only reason kept');
ok(
    st.steps.length === 1 && st.steps[0].kind === 'toolCall' && st.steps[0].callId === 'tc2' && st.steps[0].result,
    'sendFailed path keeps the original tool step with its result'
);

// 6. restoreUser appends a user row
s = createInitialChatState();
s = reduceChat(s, M('restoreUser', { value: 'hi' }));
ok(s.messages.length === 1 && s.messages[0].role === 'user', 'restoreUser appends user turn');

// 9. Out-of-order thinking before startResponse
s = createInitialChatState();
s = reduceChat(s, M('thinking', { value: 'pre' }));
ok(s.streamingId, 'thinking creates streaming msg');
s = reduceChat(s, M('fullResponse', { persian: 'x' }));
ok(s.streamingId === null, 'fullResponse after pre-stream thinking');

// 10. Stray chunk after fullResponse
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
s = reduceChat(s, M('fullResponse', { persian: 'done' }));
const before = s.messages.length;
s = reduceChat(s, M('chunk', { value: 'late' }));
ok(s.messages.length === before + 1, 'stray chunk creates new message, no crash');

// 11. Non-chat messages are no-ops
s = createInitialChatState();
const snap = JSON.stringify(s);
['connectionStatus', 'showWelcome', 'showChat', 'yoloMode', 'planMode', 'registered', 'modelInfo'].forEach(
    (t) => {
        s = reduceChat(s, M(t, { status: 'connected', enabled: true }));
    }
);
ok(JSON.stringify(s) === snap, 'non-chat messages do not mutate state');

// 12. Stress: 2000 chunks
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
for (let i = 0; i < 2000; i++) s = reduceChat(s, M('chunk', { value: 'a' }));
const big = s.messages.find((m) => m.id === s.streamingId)!;
ok(big.text.length === 2000, '2000 chunks concatenated');
s = reduceChat(s, M('fullResponse', { persian: 'end' }));
ok(s.streamingId === null, 'stress fullResponse clears');

// 13. needsApproval + approvalResolved
s = createInitialChatState();
s = reduceChat(s, M('needsApproval', { approval_id: 'a1', approvals: [{ tool_call_id: 't1', tool_name: 'edit_file' }] }));
ok(s.messages.length === 1 && s.messages[0].tone === 'pending', 'needsApproval pending msg');
ok(s.messages[0].approval && s.messages[0].approval.approval_id === 'a1', 'approval payload attached');
s = reduceChat(s, M('needsApproval', { approval_id: 'a2', approvals: [{ tool_call_id: 't2', tool_name: 'edit_file' }] }));
ok(s.messages.length === 2, 'two stacked approvals both visible');
s = reduceChat(s, M('approvalResolved', { approval_id: 'a1' }));
ok(s.messages.length === 1 && s.messages[0].approval?.approval_id === 'a2',
   'approvalResolved removes only its own round');
s = reduceChat(s, M('approvalResolved', { approval_id: 'a2' }));
ok(s.messages.length === 0, 'second resolution clears the stack');

// 14. Duplicate toolCall with the same callId is ignored (deferred resume
//     re-emission) - a second row would spin forever with no result of its own.
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
s = reduceChat(s, M('toolCall', { tool: 'read_file', args: '{}', callId: 'c1' }));
s = reduceChat(s, M('toolCall', { tool: 'read_file', args: '{}', callId: 'c1' }));
s = reduceChat(s, M('toolResult', { tool: 'read_file', output: 'r1', callId: 'c1' }));
let tmsg = s.messages.find((m) => m.id === s.streamingId)!;
ok(tmsg.steps.length === 1 && tmsg.steps[0].result === 'r1', 'duplicate call id does not open a second row');

// 15. Interleaved results pair by callId, not recency
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
s = reduceChat(s, M('toolCall', { tool: 'a', args: '{}', callId: 'x' }));
s = reduceChat(s, M('toolCall', { tool: 'b', args: '{}', callId: 'y' }));
s = reduceChat(s, M('toolResult', { tool: 'b', output: 'by', callId: 'y' }));
s = reduceChat(s, M('toolResult', { tool: 'a', output: 'ax', callId: 'x' }));
tmsg = s.messages.find((m) => m.id === s.streamingId)!;
ok(tmsg.steps.length === 2, 'interleaved ids keep one row per call');
ok(tmsg.steps[0].result === 'ax' && tmsg.steps[1].result === 'by', 'results pair by id');

// 16. Legacy events without callId still fall back to recency pairing
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
s = reduceChat(s, M('toolCall', { tool: 'legacy', args: '{}' }));
s = reduceChat(s, M('toolResult', { tool: 'legacy', output: 'ok' }));
tmsg = s.messages.find((m) => m.id === s.streamingId)!;
ok(tmsg.steps.length === 1 && tmsg.steps[0].result === 'ok', 'fallback recency pairing without callId');

// 17. Thinking segments: cumulative text extends the last pill; a RESET
//     (new reasoning block after tool calls) opens a NEW pill as the LAST
//     row - that is what keeps the running spinner visible post-tool.
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
s = reduceChat(s, M('thinking', { value: 'abc' }));
s = reduceChat(s, M('thinking', { value: 'abcdef' }));
tmsg = s.messages.find((m) => m.id === s.streamingId)!;
ok(tmsg.steps.length === 1 && tmsg.steps[0].text === 'abcdef', 'cumulative thinking extends one pill');
ok(!!tmsg.steps[0].startedAt && !!tmsg.steps[0].endedAt, 'thinking pill carries timing');
s = reduceChat(s, M('toolCall', { tool: 'a', args: '{}', callId: 'x' }));
s = reduceChat(s, M('toolResult', { tool: 'a', output: 'r', callId: 'x' }));
s = reduceChat(s, M('thinking', { value: 'second block' }));
tmsg = s.messages.find((m) => m.id === s.streamingId)!;
ok(tmsg.steps.length === 3, 'reset opens a second thinking pill');
ok(
    tmsg.steps[2].kind === 'thinking' && tmsg.steps[2].text === 'second block',
    'new thinking segment lands as the last row'
);

// 18. streamHtml renders live into the streaming message and can never
//     clobber a finalized fullResponse.
s = reduceChat(s, M('streamHtml', { value: '<p>live</p>' }));
tmsg = s.messages.find((m) => m.id === s.streamingId)!;
ok(tmsg.renderedHtml === '<p>live</p>', 'live markdown patches streaming message');
const streamedId = tmsg.id;
s = reduceChat(s, M('fullResponse', { renderedHtml: '<p>final</p>', persian: 'f' }));
s = reduceChat(s, M('streamHtml', { value: '<p>late</p>' }));
ok(
    s.messages.find((m) => m.id === streamedId)?.renderedHtml === '<p>final</p>',
    'late streamHtml does not clobber final render'
);

// 19. streamHtml patches the LAST TEXT step (live segment markdown between
//     pills); a non-text last row (segment closed by a tool/thinking event)
//     falls back to message-level renderedHtml instead of misplacing html.
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
s = reduceChat(s, M('chunk', { value: 'first seg ' }));
s = reduceChat(s, M('toolCall', { tool: 'a', args: '{}', callId: 'x' }));
// Segment closed by the tool event: the last row is the unpaired call.
s = reduceChat(s, M('streamHtml', { value: '<p>raced</p>' }));
tmsg = s.messages.find((m) => m.id === s.streamingId)!;
ok(
    tmsg.renderedHtml === '<p>raced</p>' &&
    tmsg.steps.every((st) => st.html === undefined),
    'non-text last row falls back to message-level renderedHtml'
);
s = reduceChat(s, M('chunk', { value: 'second seg' }));
s = reduceChat(s, M('streamHtml', { value: '<p>seg2</p>' }));
tmsg = s.messages.find((m) => m.id === s.streamingId)!;
ok(
    tmsg.steps.filter((st) => st.kind === 'text').length === 2 &&
    tmsg.steps[tmsg.steps.length - 1].html === '<p>seg2</p>' &&
    tmsg.steps[0].html === undefined,
    'live segment html lands on the trailing text step only'
);

// 20. fullResponse distributes segmentsHtml across matching text steps.
const segMsgId = s.streamingId!;
s = reduceChat(s, M('toolResult', { tool: 'a', output: 'r', callId: 'x' }));
s = reduceChat(s, M('fullResponse', {
    persian: 'done',
    segmentsHtml: ['<p>seg1</p>', '<p>seg2</p>'],
}));
tmsg = s.messages.find((m) => m.id === segMsgId)!;
const textSteps = tmsg.steps.filter((st) => st.kind === 'text');
ok(textSteps.length === 2 && textSteps[0].html === '<p>seg1</p>' && textSteps[1].html === '<p>seg2</p>',
    'segmentsHtml attaches final html per text step');
ok(tmsg.renderedHtml === undefined, 'matched segments suppress the single bottom block');

// 21. Mid-run usage events update the meter without ending the stream.
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
s = reduceChat(s, M('usage', { usage: { input_tokens: 90000, output_tokens: 500 } }));
ok(s.lastUsage?.input_tokens === 90000 && s.busy, 'mid-run usage updates meter live');
s = reduceChat(s, M('fullResponse', { persian: 'x', usage: { input_tokens: 91000, output_tokens: 800 } }));
ok(s.lastUsage?.input_tokens === 91000 && !s.busy, 'final usage overwrites mid-run value');

// 21b. A fullResponse WITHOUT a usage object must not erase the meter:
//      the occupied context never shrinks between turns, so nulling it
//      dropped the input-bar ring to 0% for the whole next turn.
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
s = reduceChat(s, M('usage', { usage: { input_tokens: 60000, output_tokens: 400 } }));
s = reduceChat(s, M('fullResponse', { persian: 'no usage here' }));
ok(s.lastUsage?.input_tokens === 60000 && !s.busy, 'usageless fullResponse keeps last known fill');
s = reduceChat(s, M('usage', { usage: { input_tokens: 61000, output_tokens: 400 } }));
s = reduceChat(s, M('fullResponse', { persian: 'stray, no streaming id' }));
ok(s.lastUsage?.input_tokens === 61000, 'usageless fullResponse without stream keeps last known fill');

// 21c. ALL-ZERO usage is meaningless (provider ignored include_usage →
//      backend run.usage() reports {0,0} on rounds and the result). It must
//      be treated exactly like null: never overwrite the last known fill.
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
s = reduceChat(s, M('usage', { usage: { input_tokens: 40000, output_tokens: 300 } }));
s = reduceChat(s, M('usage', { usage: { input_tokens: 0, output_tokens: 0 } }));
ok(s.lastUsage?.input_tokens === 40000, 'zero-valued usage event keeps last known fill');
s = reduceChat(s, M('fullResponse', { persian: 'x', usage: { input_tokens: 0, output_tokens: 0 } }));
ok(s.lastUsage?.input_tokens === 40000 && !s.busy, 'zero-valued final usage keeps last known fill');
const zeroMsg = s.messages[s.messages.length - 1];
ok(zeroMsg.usage === null, 'zero-valued usage normalized to null on the message');

// 22. Task list: the update_task_list call lands as a step carrying its
//     args; the paired ack result attaches; the result row itself is
//     skipped (the call row carries the list).
s = createInitialChatState();
s = reduceChat(s, M('startResponse'));
s = reduceChat(s, M('toolCall', {
    tool: 'update_task_list',
    args: JSON.stringify({ tasks: [{ label: 'Step one', status: 'completed' }, { label: 'Step two', status: 'in_progress' }, { label: 'Step three', status: 'pending' }] }),
    callId: 'tl1',
}));
s = reduceChat(s, M('toolResult', { tool: 'update_task_list', output: 'Task list updated (3 items, 1 completed).', callId: 'tl1' }));
tmsg = s.messages.find((m) => m.id === s.streamingId)!;
ok(tmsg.steps.length === 1 && tmsg.steps[0].tool === 'update_task_list', 'task list call is a single row');
ok(!!tmsg.steps[0].result, 'task list ack pairs onto the call row');

// 23. taskListState is a non-chat-affecting host message.
s = createInitialChatState();
const snap2 = JSON.stringify(s);
s = reduceChat(s, M('taskListState', { tasks: [{ label: 'a', status: 'pending' }] }));
ok(JSON.stringify(s) === snap2, 'taskListState does not mutate chat state');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
