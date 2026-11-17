# Coordinated child sessions

The built-in engine now treats a subagent as a saved child conversation.
`src/sessions/coordinator.ts` owns admission, state transitions, receipts,
cancellation, durable reports, and recovery. The model loop executes through a
driver; the webview never owns execution.

## Delivered behavior

- Foreground `task` remains compatible. `spawn_agent`, `send_agent`,
  `inspect_agents`, `wait_agents`, and `stop_agent` support explicit background
  coordination and parent follow-up instructions.
- A child retains its identity, history, resolved profile/model, and round
  budget across follow-ups and reloads. Instructions have durable receipts;
  one child never runs overlapping executions.
- The Agents tab has a roster and independent conversation view, live state,
  tool activity, persistent drafts, direct instructions, individual Stop,
  scoped approvals/questions, idle model/effort/budget controls, and explicit
  Report to parent. Agent profiles launch manual investigations.
- Reports remain pending until committed to parent history. Manual results are
  returned through the normal parent admission path.
- Admission is bounded. Mutation-capable children acquire a shared workspace
  writer lease; strict Explore children can overlap. Verify is the separate
  approval-gated shell/testing profile. Unknown tools are treated as writers.
- Ownership covers separate extension windows. A live process owner never
  expires by age. Storage failures fence execution. Restored running work is
  interrupted, never automatically replayed. Lost tool results become explicit
  uncertain-effect rows on resume.
- History deletion removes associated child families, including families retired
  by checkpoint restoration. Active foreign owners prevent deletion.
- Native OpenCode children accept follow-up instructions while their verified
  delegation remains live. Native inbox delivery and queued instructions hold
  the coordinator open. Per-child Stop preserves the parent and siblings.
- English and Persian controls, narrow/wide layouts, existing docking, real
  approval gates, Plan restrictions, and model-ledger separation are retained.

## Deliberate limits

The initial plan includes product explorations beyond this implementation.
Automatic worktrees, arbitrary session forks, promotion to a separate root,
shared team memory, and cross-child messaging are not implemented. The shared
workspace lease is coordination, not an OS sandbox. Native history and model
configuration remain owned by OpenCode; settled native traces are read-only.
Native continuation after the parent delegation settles goes through the parent.
Background child results do not automatically start a new parent model turn;
the parent uses `wait_agents`, or the user chooses Report to parent.

The repository already reported 3.0.3, so this change prepares 3.1.0 rather than
reusing or downgrading an existing release number. Nothing is published or tagged.

## Verification

- Lint: zero errors, 304 existing/debt warnings; changed receipt code also checked separately.
- Host and webview TypeScript projects: passed independently.
- Extension bundle, production webview build, and all webview unit suites: passed.
- Full host run: all 105 suites passed. Subsequent receipt, immutable-checkpoint,
  idempotent-launch, deletion, scoped-question, and persistence changes received
  focused coordinator, runner, send-receipt, session-action, and orthography checks.
- Browser coverage: 190 app, work-surface, agent-observation, and child-session
  cases passed across the run and reruns. A shared test server stopped during
  one run; all 27 connection-refused cases passed against the restarted server.
  The four child-session cases passed again against the final webview bundle.
- Actual themed UI inspected at 420px and wide widths in English and Persian.
  This caught and fixed a hidden-panel overlay and incorrectly stretched actions.
- No live provider credentials were needed: integration tests drive the real
  nested model loop using mocked model transport and native SDK/SSE fixtures.

Changes remain on `feat/coordinated-sub-sessions`; no release was published.
