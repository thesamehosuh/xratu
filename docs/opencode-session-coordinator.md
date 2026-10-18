# OpenCode session coordinator

Reference: T3 Code `ec80933ac8cd02fec5c97b342462ccc9567cdb1e`, especially
`packages/provider-opencode/src/server/v2/adapter.ts` and
`OpenCode2AdapterV2.test.ts`. The third-party notices cover the adaptation and
the real nested-background recording used by the regression suite.

## Ownership and turn lifetime

OpenCode creates native children. Xratu does not translate its own agent files
into native configuration or change native credentials. `session.created`
establishes the parent relation; the parent's `subagent` tool progress binds
the child to the actual native call ID. Early child events wait in a bounded
buffer. Reused children require an SDK-confirmed parent and workspace, must be
idle, and receive the current permission rules before admission. An unrelated
session can never be adopted by approving a tool or enabling YOLO.

Unlike T3's separate child threads and continuation scheduler, Xratu retains
one active chat turn until the whole tree settles. A root execution ending
while background descendants run keeps Stop available. Background launch
success does not complete a delegation; native synthetic reports target the
session that launched the child. Reports, their delivery, nested executions,
and follow-ups must settle before Xratu releases the turn. Settings/mode
changes take effect on the next turn, so active children keep a frozen policy.

## Display, approvals and shared services

Child prose and tools enter bounded display observations on the original
root call, including across steer-induced bubble splits. Child tool IDs carry
the native session ID and subsequent execution scope; equal call IDs in different sessions cannot collide.
Nested work stays on that root observation. Step usage contributes once to
the shared spend ledger and to its observation, never to parent model text.
Native children use their own native models; observations record the model
reported by their session.

Permission and form requests run concurrently with event consumption. Each
request owns a cancellation signal and a native session/request identity.
External replies, cancellation, terminal events and Stop close stale cards.
Own reply events cannot cancel an HTTP reply still being delivered. Approvals
and questions identify the root delegation that spawned the requesting child.
Form fields are checked before showing a partial form, and choice/count/number
bounds are validated before replying. Unsupported or invalid forms are
cancelled. A declined permission carries a message so OpenCode treats it as a
declined tool rather than a user Stop.

Native children inherit native permissions at creation. Plan deterministically
denies delegation; probe sessions also deny it. Normal child mutations retain
real approval gates even when the root uses YOLO. Native session rules keep
mutations asking; Xratu silently approves only the root's requests in YOLO.
This differs from the built-in Xratu runner: native agent files, nesting and
native tools remain OpenCode's responsibility; Xratu profile tool allowlists,
round budgets and parallel-wave limits are not native configuration.

The authenticated MCP bridge binds children to the same root turn and frozen
signal. Shared browser, skill and configured MCP services remain available.
`task`, `update_task_list`, `exit_plan_mode` and `ask_user_question` on the
Xratu bridge are structurally denied to children. Native delegation/questions
use the native coordinator instead. Xratu's file/SSRF guards still protect
built-in services, not OpenCode's native tools.

## Stop, restore and transport failures

Stop reaches announced children, nested background descendants and the root.
The adapter checks OpenCode's active sessions and SDK ancestry too, so an event
lost before its child announcement cannot leave work unobserved. It waits for
native finalizers, drains queued inputs and child reports, and checks for a parent woken
by cancellation. Failure to establish settlement restarts the managed server,
whose process-tree shutdown covers its native subprocesses.

A restored session fences previous active descendants before switching models
or permissions and sending another prompt. Saved observations restore through
the existing interrupted-state normalization. Native history and session IDs
remain available for the next user turn. Child-owned running shells are
removed at settlement; root shells explicitly backgrounded by the user retain
the existing Background controls.

A lost SSE connection interrupts the entire tree rather than silently
continuing a partially observed execution. Automatic history backfill and
transparent stream reconnection are not claimed: the user can continue the
same native session after cleanup. This avoids treating a previous execution's
session outcome as evidence that the interrupted turn succeeded.

Run `npm run test:opencode-coordinator`, `test:engines`,
`test:subagent-observation`, `test:subagents`, `test:subagent-runner`,
`test:work-surface`, the webview suites, and the engine/work-surface e2e checks.
