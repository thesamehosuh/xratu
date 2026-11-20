# Xratu 3.0: coordinated sub-sessions

Status: implementation and verification. This document preserves the original
proposal; [DELIVERY.md](DELIVERY.md) records the implemented scope and deliberate
limits. See [the code and browser audit](AUDIT.md) for the starting state.

The repository was already at 3.0.3; the implementation prepares 3.1.0 without
publishing a release or downgrading the existing version.

## Product decision

A subagent is a durable child conversation, launched for an assignment and coordinated with its parent. It has its own history, execution, instructions, model, permissions, resources, and results. A profile is only a reusable starting configuration.

The core interaction is: delegate work, enter any child, intervene directly, leave it running, inspect its result, continue it later, and return useful work to the parent. Reloading the UI must not erase that relationship. Looking at another conversation must not cancel execution.

Build a proper coordinator first, then make the Subagents tab its control surface. The existing single-turn runner, trace-derived roster, and root-only control routing are replaceable. Keep proven model replay, process cleanup, path guards, native ownership checks, and localization behavior where they remain correct.

## What the user should be able to do

1. Ask the parent to investigate three independent causes. Three child sessions appear immediately, including queued ones. Each retains one row across every follow-up.
2. Open one child, read its actual conversation, and send “Check the Windows path too.” See whether that instruction is queued or has been delivered. Leave without stopping it.
3. Answer a child's question or approve its command in that child's view. The overview also exposes that pending decision through the same underlying request.
4. Stop a specific child, wait for its tools to settle, then continue it with preserved context. Parent and siblings keep working.
5. Launch a child manually, choose relevant context and a model connection, and keep its result private until choosing “Report to parent.”
6. Close/reopen the webview or reload VS Code. Recover conversations and delivered results. Clearly distinguish stopped execution from recoverable conversation history.
7. Compare two investigations, carry selected findings back with source links, or continue a useful child as a separate main conversation.

## A proper coordinator

Introduce a host-owned `SessionCoordinator`. Its lifetime is the extension host, not a webview or parent turn. It owns a registry of sessions, one command queue per session, the execution scheduler, durable mailboxes, decision routing, resource ownership, and recovery. Engine adapters execute work; React displays state.

```text
UI commands / model orchestration tools / recovery
                        |
                 SessionCoordinator
       identity + policy + durable state transitions
                        |
       +----------------+-----------------+
       |                |                 |
   Scheduler        Mailboxes       Decisions/resources
       |                |                 |
       +----------------+-----------------+
                        |
            Engine session driver interface
             /                       \
   Built-in loop driver         OpenCode driver
   local model history          native sessions/inbox
                        |
          Session events -> store -> UI projections
```

There is one authority for each concern. The coordinator owns Xratu relationships and admission. The built-in driver owns one model loop per execution. OpenCode owns its native execution, history, and report inbox. Xratu observes and controls verified native sessions; it does not shadow-run them.

### Identities and data model

| Entity | Lifetime and purpose |
| --- | --- |
| Session | Durable UUID; parent/root IDs, title, workspace identity, engine binding, profile snapshot, connection reference, context policy, and archive state. |
| Execution | One attempt to advance a session; unique ID and generation, admitted configuration, cancellation scope, progress, outcome, usage. At most one active execution per session. |
| Delegation | A parent's assignment to a child; initiating turn/tool-call identity, expected result, delivery policy, and revision. A child can serve later assignments without becoming another session. |
| Message | Durable sender/recipient, body or attachment references, origin, delivery mode, and receipt. A direct user message and an automated parent instruction remain distinguishable. |
| Result | Immutable child execution report with outcome, evidence/artifact references, changed-file scope, verification, limitations, and delivery receipt. |
| Decision | Approval or question tied to the exact session, execution generation, native identity if present, and tool call. |
| Resource | Owned process/browser/download/checkpoint scope, with explicit grants where shared. |

An execution finishing does not delete its session. An archived session is not a failed execution. A child returning a result is not proof that the parent has consumed it.

Persist the resolved launch configuration, including the profile version/hash and nonsecret connection identity. A profile edit affects new children. Applying it to an existing child is an explicit next-execution change. Credential values stay in secret storage; native credentials stay native.

Parent/root relationships are coordinator-assigned and cycle-checked. Model arguments cannot claim another session's sender, ancestry, execution, or decision identity. Model-facing inspection is bounded to its authorized family; the user's overview can navigate a broader workspace scope. Resolve workspace identities with the existing platform-aware realpath/path guards, including Windows spelling and symlinks.

### State and command semantics

Execution states: `queued`, `starting`, `running`, `waiting_for_approval`, `waiting_for_answer`, `waiting_for_children`, `stopping`, `completed`, `failed`, `cancelled`, `interrupted`. Store the outcome reason separately, including budget exhaustion and provider failure. Waiting is not failure. A completed session can accept another execution.

All mutations enter the coordinator as validated commands with an idempotency key and expected session/execution revision. Per-session serialization prevents UI sends, parent follow-ups, and recovery from starting two loops. A scheduler claim is persisted before calling the engine. An execution-generation fence rejects obsolete sends, decisions, and tool admissions.

Keep command handling short: commit a transition, dispatch work, and process its completion as another event. Never hold the session command queue while awaiting the engine, a tool, an approval, or a child; otherwise Stop and Send cannot reach the session they are meant to control. Driver run handles are per session/execution, replacing singleton “active turn” fields. The visible session and selected engine/provider are UI defaults, never implicit routing for an existing execution.

Commands include create child, send/queue instruction, interrupt and replace instruction, continue, cancel queued execution, stop execution/subtree, change next-execution configuration, publish result, archive, and promote a conversation. UI and model tools call the same service; neither gets a privileged shortcut.

“Pause” is not a misleading synonym for cancelling a tool. Ship explicit **Stop** and **Continue** first. Add “Pause after this step” only when a driver can acknowledge a real safe boundary. Show `Stopping` until tool processes and native queued reports have settled.

### Scheduling and background work

- Parent turns and child executions have separate lifetimes. Background launch returns a child reference; it does not leave a tool call pending indefinitely.
- Keep the configured global concurrency ceiling, add per-connection ceilings and a visible FIFO queue. Local runtimes can use a one-request default; user overrides remain possible. No model is silently changed when capacity is unavailable.
- A waiting parent releases its request slot. Approval waits retain session ownership but consume no model-request slot. Avoid parent-waits-for-child scheduling deadlocks.
- Make request admission fair across session families, so one fan-out does not starve a manual message. Coalesce multiple child completions into one eligible parent continuation.
- Avoid report ping-pong: automatically wake a parent only for an outstanding delegation result or an explicitly addressed instruction. An acknowledgement is not a new assignment. Total family budgets also bound automatic continuations.
- Model-initiated background assignments can wake an idle parent to consume their reports. User-created side investigations default to manual reporting. Store this choice on the delegation.
- A parent's current response may end while background children work. Display root-session state separately from tree state, with working/queued/needs-input counts. Never label the whole assignment complete while required results remain pending.
- Closing a tab, docking a pane, or navigating away changes subscriptions only. An extension-host shutdown ends built-in execution; this release does not promise work continues after VS Code exits.

### Messages and result delivery

Each session has a persisted inbox with `queued`, `delivered`, `cancelled`, and `rejected` receipts. The built-in driver accepts instructions at supported model/tool boundaries, preserving valid assistant/tool-result groups. “Interrupt and send” explicitly stops the current generation before resuming. Plain Send does not secretly abandon in-flight work.

Only bounded result envelopes and deliberate messages enter the parent ledger. Child tool logs and UI observation traces never do. Parent compaction cannot sever the child reference or its undelivered result.

Use a durable outbox and stable result IDs. Commit a result and its pending delivery together. Parent-history insertion and the consumed receipt must recover idempotently. The guarantee is no duplicate logical report in the parent history; it is not exactly-once execution of arbitrary shell commands or provider requests. A crash after an external side effect can have an uncertain outcome and must be shown as such.

OpenCode's native inbox is authoritative for native reports. Mirror its delivery state into Xratu's relationship index; do not inject a second copy. Preserve native report ownership and ordering, including nested reports that cause another native execution.

### Stop has an exact scope

| Control | Effect |
| --- | --- |
| Stop in an opened child | Cancel that child's active execution and its owned descendants; preserve the conversation. Siblings and parent remain usable. |
| Stop all in the family overview / root task control | Fence new automatic launches and parent wakeups, cancel queued work and instructions for that assignment, then settle the active tree. |
| Cancel on a queued row | Remove that execution from admission without calling the model. |
| Continue | Create a new execution generation after settlement; reuse committed context, not old abort signals or pending approvals. |
| Close a session view | Detach the view only. |

Cancellation first fences admission and messages, then requests engine/tool cancellation, then waits for actual settlement. A timeout becomes a recovery state, not a successful stop. Native recovery may require restarting Xratu's managed server; if so, reconcile every affected owned session and show the interruption. Never restart or kill an unrelated native server. Foreground compatibility calls receive a cancelled/partial result once the child settles, so the parent's tool protocol remains valid.

### Persistence, recovery, and cross-window ownership

Extend the existing file-based session store with versioned session metadata, committed event journals, compacted snapshots, and a rebuildable family index. Keep one ordered writer per session, atomic replacement and Windows rename retries. Do not make a native database dependency a prerequisite for the VSIX.

Journal model-ledger commits as they occur, not only at the end of a child invocation. Stream deltas may be batched, but accepted instructions, committed tool calls/results, decisions, terminal outcomes, and report deliveries need durable boundaries. Recover a truncated last journal record without dropping prior commits. Page histories from disk and bound loaded views independently of retention and model compaction.

Acquire an execution ownership lock before resuming a family in a VS Code window. Verify process identity when reclaiming an abandoned lock; elapsed time alone cannot grant a second live window ownership. Reuse the repository's directory-lock/process-identity primitives where suitable. Persist a new ownership generation on acquisition.

Workspace mutation ownership also needs a cross-window lock: two different session families can share the same checkout, so a family lock alone does not prevent concurrent writers. Viewing another window's active family is allowed; adopting its execution is not. Keep lock ordering explicit to avoid session/workspace lock inversions.

Startup recovery reconciles stored execution state with actual runtime state. Built-in running work becomes interrupted; never automatically repeat uncertain mutations. Native sessions are verified by workspace, ancestry, binding, and active execution before adoption or cleanup. Missing binaries, deleted connections, or unavailable native history produce specific recovery actions rather than a new session masquerading as the old one.

Late text from a fenced execution cannot overwrite the current transcript. Legitimate late billing is still recorded once against its original execution. Session deletion/archive must settle execution and decisions before removing active state. Storage failures remain visible and stop unsafe continuation.

### Decisions and resources

Move approvals and questions into a session-routed decision service. A child question can now be answered directly; parent-session control tools remain inaccessible to children. This deliberately replaces the old root-only-question assumption and needs corresponding AGENTS documentation and regression tests.

The same pending decision can be surfaced in the child conversation and the overview, but has one authoritative resolution. Approve/deny includes the exact execution generation; stale cards cannot authorize newer work. Denying one tool is distinct from stopping the child.

Preserve deterministic Plan gating, live tree-wide YOLO behavior, tool allowlists at advertisement and execution, path/SSRF guards, and native ownership checks. Strict read-only profiles omit arbitrary shell and tools with unknown mutation behavior. A verification-capable profile explicitly exposes approval-gated commands instead of claiming a sandbox it does not provide.

Processes, browser contexts, downloads, and checkpoints receive session/resource ownership. Children can manage their resources without controlling siblings by knowing an ID. A shared dev server needs an explicit grant or handoff. No orphan background process is permitted just because its model turn finished. Background processes appear in the existing Background surface with a child-session source link.

## Engine boundary

Replace the single `subagents: boolean` capability with per-operation support: create/adopt child, read paged history, send queued instruction, interrupt, resume, observe descendants, answer decisions, change model/connection, enforce budgets, fork context, and isolate files. Unsupported actions stay absent or explain the actual constraint when it affects a choice.

Built-in children use the coordinator's scheduler, persistence, and mailbox. OpenCode children retain native definitions, tools, permissions, compaction, and history. Extend its existing native coordinator rather than discard its ancestry checks and report-settlement logic. Xratu's coordinator holds durable relationships above it; the native driver translates verified native events into session events without flattening grandchildren into one root trace.

Native scheduling is not silently equivalent to built-in request scheduling. Prove an enforceable admission boundary before exposing a native concurrency or budget control; otherwise show runtime-owned scheduling and observe it. Events arriving after native launch cannot retroactively enforce a launch limit. The phase-1 spike must establish which controls the pinned runtime can honor.

Changing a provider/model applies at an idle boundary. Portable transcript content can migrate where supported; opaque provider reasoning must not cross incompatible identities. A native engine switch creates a new conversation branch with a handoff, not a fraudulent “resume.” Mixed engines in one family are a later capability unless this contract proves straightforward in the engine spike.

## Context, budgets, and file ownership

### Context choices at launch

- **Brief:** assignment, selected file references, constraints, and expected outcome. Default for automatic delegation.
- **Selected context:** include chosen messages/evidence plus the brief. Default manual affordance.
- **Fork here:** snapshot the parent's portable history at a specific committed boundary. Parent messages after that point are not shared automatically. Driver support and child context-window fit must be checked first.

Show “Context” as inspectable sources, not raw prompt dumps. File references describe launch intent; subsequent reads see the chosen workspace's current state. Do not promise snapshot-isolated files from a conversation fork.

Budgets cover rounds, tokens, elapsed execution time, and optional spend in its actual currency. Store child usage separately, then aggregate the family without double-counting. Reserve admission headroom for concurrent requests and refuse new requests when exhausted. A billed request can overshoot an estimate; unknown pricing cannot support a hard money cap. Native limits are offered only when enforced through a verified runtime boundary, otherwise clearly observational.

### Shared checkout first; explicit isolation next

For the core cutover, allow parallel research but one mutating execution owner per shared checkout, including the parent. A writer lease covers the execution's mutation-capable work; release it on settlement, not while a foreground command may still write. Readers may run concurrently and must verify stale evidence before action. This is conservative concurrency control, not an OS sandbox; approved shell commands retain their real capabilities.

Delegation must yield the writer lane: after the parent's in-flight side-effecting tools settle, hand the lane to the child before the parent waits. A parent continuing alongside a background writer can do read-only work; its next mutation queues until it regains ownership. No parent may hold the writer lease while waiting on a child that needs it. Treat arbitrary shell and unknown external tools as mutation-capable for this scheduling rule. Add this deadlock case to the scheduler tests.

Track files touched by known tools, shared workspace revisions, and before/after checkpoint references. An interval diff in a shared checkout can contain unrelated user changes: label that scope honestly. Restoring a checkpoint requires affected executions to settle and stale decisions to be fenced.

Separate Git worktrees are the next implementation slice for genuinely parallel writers. They are real repository worktrees, explicitly separate from SHADOW-git checkpoints. Define base revision, dirty/untracked input transfer, dependency setup, Windows cleanup, artifact retention, diff review, and conflict handling before enabling them. Applying child changes is explicit and precondition-checked; never silently overwrite or merge into the user's checkout. Without Git, use shared mode or offer a later managed-copy capability.

## Redesign the Subagents tab

The live tab becomes **Subagents** with two useful modes: an overview and an opened child conversation. Its primary objects are sessions, not tool invocations. Keep the profile inventory under **Agent profiles** so running work and reusable configuration are unmistakable.

### Overview

Show compact session rows grouped by **Needs you**, **Working / queued**, and **Finished**. Each row contains task title, actual state or latest meaningful activity, and a compact result indicator. Waiting approvals/questions outrank routine activity without constantly reordering the keyboard user's selection. Counts distinguish active children from total history.

Provide **New sub-session**, search/filter, and access to profiles. One empty state with that action. No obligatory dashboard statistics, raw tool-name badges, introductory paragraphs, agent avatars, animated topology, or repeating metric cards. Summaries come from actual events and reports; no extra model calls just to decorate the roster.

### Enter a child

Open its real multi-turn transcript and a composer explicitly addressed to that child. Keep a parent breadcrumb and a compact session switcher visible. Show its pending decision above its composer. Model/connection and permission controls belong to this child and disclose inherited constraints.

The main actions are Send, Stop/Continue, Report to parent, and Open changes. Configuration, budget details, raw capabilities, and archive belong in appropriate menus or inspectors. The child's conversation, activity, results, and changed files share session identity; they are not four copies of trace text.

On wide layouts, the roster can sit beside the focused conversation. The child can also dock beside the parent using the existing work-surface placement model. On narrow layouts, use list-to-detail navigation with a compact switcher and Back, giving the conversation the full height. Do not stack a permanently scrolling roster over it. Drafts, selected child, scroll, and expanded details survive switching and docking.

The parent transcript retains a compact delegation reference that opens the child and shows result-delivery state. Finishing does not auto-remove a child's row or steal focus. Completed children remain searchable and resumable.

### Visual direction

Use Xratu's editor context as the visual foundation: one quiet workspace, readable conversation, and a compact navigation hierarchy. Spend the visual emphasis on the selected conversation and decisions that need action. This is closer to entering a focused editor session than supervising a wall of bots.

Prototype calibration palette: workspace `#181818`, conversation `#1f1f1f`, boundary `#303030`, text `#ededed`, Xratu action `#82dbc5`, attention `#d7ba7d`. Production maps these roles to the current VS Code/theme tokens and supports light/high-contrast themes. Preserve the neutral surface choices from the broader harness design.

Use the host UI font plus existing Vazirmatn support, a restrained 13/14/16px hierarchy, and code font only for code and paths. Status needs words/icons as well as color. Use logical layout properties, root locale direction, `dir="auto"` for content, LTR technical identifiers, and physically right-aligned user bubbles in both locales. All strings need English and Persian entries.

### Profiles

Rename the configuration page to **Agent profiles**. Offer built-in starters, create, duplicate, edit, launch, source, and validation state. A compact form edits task instructions, model connection, tool capabilities, and limits; advanced source editing remains available. Native inventories stay read-only and show supported launch/navigation actions only.

Parse the supported format deliberately. Preserve valid legacy files, show unsupported restriction syntax as an error, surface unknown tool names, and never turn an unreadable allowlist into unrestricted access. Keep effective configuration and source precedence inspectable. The full inventory is not silently capped because the model's advertised catalog must be small.

## Ideas worth building on this foundation

| Idea | Concrete interaction | Priority |
| --- | --- | --- |
| Take over a child | Enter it and give direct instructions without forwarding through the parent. Parent sees a durable intervention receipt; execution remains single-owner. | Core |
| Report only what matters | Send a result or selected evidence to the parent with source links and a delivery receipt. | Core |
| Branch a thought | Select a committed conversation point and investigate an alternative without copying the whole future parent conversation. | After engine capability spike |
| Compare approaches | Launch two read-only investigations from the same brief, inspect evidence/results together, and carry chosen findings back. No automatic extra judge run. | Next |
| Promote to main | Continue a useful child as its own root conversation while preserving origin and completed parent handoff. Existing parent obligations must be settled first. | Next |
| Save a useful profile | Save the deliberate instructions/configuration from a successful child, excluding secrets and incidental transcript content. | Next |
| Nested teams and peer messaging | Explicit depth/role/total-budget controls, dependency ownership, and routed mailboxes. | Later; do not make 3.0 depend on recursive swarms |

The coordinator stores a tree from the start because native engines already have descendants. The built-in first release retains structural delegation denial in children. More UI control does not require unbounded recursion.

## Delivery plan

Use small, reviewable branches/PRs. Existing dirty changes are separate work and must not be absorbed. Each phase gets its relevant tests and a usable vertical slice; the final cutover removes the superseded paths.

| Phase | Implementation | Exit criterion |
| --- | --- | --- |
| 1. Contracts and engine spike | Session/execution/delegation IDs, state machine, commands/events, capability contract; verify installed OpenCode child history/send/resume operations against real fixtures. Document intentional AGENTS assumption changes. | Two drivers can represent the same family lifecycle without inventing unsupported controls. |
| 2. Coordinator and durable store | Pure host modules for coordinator, store, inbox/outbox, scheduler, ownership locks, generation fencing, and per-session execution contexts. Extract only the provider state needed by this boundary. | Two children survive navigation and recovery with one owner each; replayed commands/results do not duplicate work. |
| 3. Built-in vertical slice | Run ordinary child conversations through the coordinator; persist committed history; independent steering/cancel/resume; scoped decisions and usage; foreground compatibility wrapper plus background launch. | Parent delegates, user intervenes, child reports, restart restores the same session. |
| 4. Native integration | Durable native bindings, child transcript loading, targeted operations, decisions, nested observations, native inbox reconciliation, and real subtree settlement. | Native background/nested fixtures pass without duplicate reports, orphan execution, or leaked approvals. |
| 5. Interaction prototype, then live UI | Review the new list/detail and optional wide split using real content at 420px/wide in both locales; implement session projection/store, child transcript/composer, attention decisions, and docking. | Every core scenario works from the actual Subagents tab; changing focus never cancels work or loses a draft. |
| 6. Context, profiles, and resource controls | Context chooser, child model/connection configuration, limits, profile editor/validation, process/browser/download ownership, and shared-checkout writer admission. | Controls correspond to enforced capabilities; child resources and costs are correctly attributed. |
| 7. Parallel writer isolation | Managed worktrees, explicit bases and dirty input handling, review/apply/conflict/retention flows; integrate Changes with child identity. | Two writers do not touch the same checkout; applying changes detects conflicting user edits and works on Windows. |
| 8. Migration and release | Migrate old observations as legacy records, compatibility bridge, remove obsolete runtime/trace ownership, concise EN/FA feature docs and release notes, version bump at the agreed release number. | Existing histories remain readable and every new run uses the coordinator. Required CI and review findings are settled. |

The first executable milestone is phases 1–3, not a cosmetic page patch. The first visible milestone is phase 5 backed by the real coordinator. Worktree isolation is a separate reviewable slice; do not ship parallel shared-checkout writers as a shortcut if it takes longer.

Proposed host module seams: `src/sessions/{types,coordinator,store,mailbox,scheduler,decisions,resources,recovery}.ts`, with engine drivers under the engine boundary. Proposed UI seams: a session event store/hook, a shared conversation view, `SubsessionsPanel`, overview, context chooser, and profile editor. Names can change when the extraction exposes a better boundary. Avoid a global rewrite of unrelated settings or provider services.

## Compatibility and cutover

- Old parent histories and child traces remain readable as legacy observations. A trace cannot reconstruct missing model history; never give a legacy row a fake Resume action.
- Verified native child bindings can be reattached when the runtime still has them. Unverifiable IDs remain history, not execution authority.
- Keep `task` as a compatibility adapter initially. New model-facing orchestration operations are `spawn_agent`, `send_agent`, `inspect_agents`, `wait_agents`, and `stop_agent`, all backed by the coordinator. `wait_agents` subscribes to state/result events; it is not a busy polling loop.
- Keep orchestration tools out of built-in children. Keep parent task-list and mode controls out as well. New child questions route through the decision service with their own identity.
- Migrate store schemas with a recoverable pre-migration copy and repeatable steps. Update export/import, deletion, retention, session search, and checkpoint restore semantics with the new family model.
- Phase out `_subagentRunsByChat`, call-derived live rosters, fabricated child assistant messages, and root-only per-agent stop dispatch after all launches use the new service. Retain bounded observations only for legacy display or compact previews.
- The current package version is already 3.0.3. Choose the actual release number from the repository's release state; do not force a 3.0.0 downgrade to match the milestone label.

## Acceptance and verification

Required product scenarios: simultaneous parent/child interaction; one stable row over several child executions; foreground and background delivery; stop-one/stop-tree/cancel-queued; child question and approval handled in place; child model limits computed for that child; navigation and docking without cancellation; durable restart/resume; unavailable provider/native session recovery; parent compaction with pending results; scoped process cleanup; and readable legacy history.

Coordinator fault tests cover duplicate commands, concurrent sends/resumes from UI and parent, two VS Code windows, stop during admission, stop before native child binding, late events after stop, crash before/after tool effects, interrupted journal writes, index rebuild, storage failures, report insertion before/after acknowledgement, cancelled native inbox items, and parent wakeups while another continuation is active. Assert execution ownership and model-ledger validity, not just UI labels.

Resource tests cover shared writer contention, user edits during child work, checkpoint restore while children run, process ownership, background resource handoff, and worktree cleanup with modified/untracked files. Budgets test concurrent reservations, unknown prices, native support limits, late usage, and currency separation.

UI checks use the actual built bundle with the shared VS Code theme fixture. Inspect overview, child conversation, queued/delivered instruction, approval, question, stopping, failed/interrupted recovery, finished result, context chooser, and profiles in EN/FA at 420px and wide widths. Include keyboard navigation, focus restoration, readable glyph metrics, reduced motion, light/high-contrast themes, and retained drafts/scroll. Save and look at before/after screenshots.

Run the repository's required lint, host tsc, separate webview tsc, esbuild, and webview suites for each implementation PR. Relevant existing suites include subagents, subagent-runner, subagent-observation, parallel-subagents, opencode-coordinator, engines, session-store/actions, steering/admission, usage provenance, background jobs/recovery, plan tools, work-surface, protocol drift, and Farsi orthography. Add dedicated coordinator/store/mailbox/scheduler fault suites. Run relevant browser agent-observation, subagent-live, work-surface, app, and native coordinator coverage; run engine/onboarding coverage if capability/setup behavior changes.

No implementation phase is complete merely because the page looks convincing. The release gate is the full interaction working through the coordinator, including interruption and recovery.

## Defaults to validate as implementation progresses

These are starting choices, not reasons to defer work: fresh briefs for automatic delegation; selected context for manual launch; automatic reporting for model assignments; manual reporting for user side investigations; structural no-recursion for built-in children; one shared-checkout writer; configurable per-connection capacity; no background-execution promise after VS Code exits; and capability-based native controls.

Revisit these defaults against working scenarios and the engine spike. The fixed requirements are durable child identity, direct user control, real approvals, correct execution ownership, recoverable delivery, and a fully usable Subagents tab at sidebar width.
