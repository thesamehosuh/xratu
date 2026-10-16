# Implementation cards

Read [the audit](audit.md) and [executor brief](handoff.md) first. Each card is a bounded work package, not permission to implement this whole file in one PR. “New” filenames are proposals; match established repository conventions if there is a better existing seam.

All behavior changes require the common gate in C21, a version bump in the same PR, and relevant English/Persian documentation. Tests named below supplement that gate. Characterization tests should fail for the intended reason before changing production behavior.

## C01 — Make session and workspace mutations transactional

**Priority:** P0. **Evidence:** F03, F04, F15. **Depends on:** nothing. **Split:** restore safety; session adoption/branch guard in a second PR.

**Read:** `src/extension.ts` (`_restoreCheckpointAt`, `_rewindAndResend`, `_openSessionNow`, `_serializeSessionTransition`, `_gitCheckout`), `src/webviewRouter.ts`, `src/shadowGit.ts`, `test/test-engines.mjs`, `test/test-shadow-checkpoint.mjs`.

**Implement:**

1. Introduce a small immutable action context captured when an action is requested: session ID, session epoch, canonical workspace identity, engine ID, turn identity/checkpoint where applicable. Reuse the existing epoch rather than inventing a second competing session clock.
2. Validate restore SHA shape and its relationship to the requested turn/session **before** showing confirmation. Use full resolved SHA internally where practical. A positional user index alone is not an identity.
3. After confirmation, serialize with session transitions, then revalidate the captured context, busy state, turn membership, and workspace immediately before any file operation. Do not hold the transition queue while waiting for a human. Do not recursively acquire the same queue and deadlock it.
4. Distinguish file-only restore from conversation rewind. Explain whole-workspace scope and preserve the safety checkpoint. Identify live background writers in that workspace; refuse or explicitly stop them through existing controls before claiming a stable restore. Never quietly stop user processes.
5. Load and validate a target session before committing replacement host state. On failure retain the previous coherent session. Cancellation of an old run may be irreversible, but it must not erase the old conversation. Adopt loaded state only after settlement and revalidation.
6. Reject manual branch checkout while a run/transition is active. Recheck in the host even if the UI disables the picker. Preserve branch allowlisting and Git's non-force behavior.

**Acceptance:** confirmation for A cannot mutate B; deleted/stale target produces an actionable rejection without a file write; concurrent restore/switch cannot interleave ledgers; missing target load leaves the old chat coherent; busy branch checkout never invokes Git; successful restore still offers the safety snapshot. Test empty-seed and files-only behavior explicitly without changing policy incidentally.

**Proof:** isolated temporary trees and fake deferred confirmations; source-level host harness patterned after `test:engines`; `test:session-store`, `test:shadow-checkpoint`, `test:work-surface`, `test:git-status`; UI rejection/disabled-state tests. Include a delayed acknowledgement test, not just two sequential calls.

**Do not:** force-reset the real repo, remove confirmation, or implement per-file restore in this card.

## C02 — Stop retrying external mutations with unknown outcomes

**Priority:** P0. **Evidence:** F06. **Depends on:** nothing.

**Read:** `src/externalMcp.ts::callTool/getState`, `src/local/localTypes.ts`, `src/mcp.ts`, `test/test-mcp-image-server.mjs`.

**Implement:** separate connection establishment/reconnect from invocation replay. If `callTool` was invoked and threw, default to “outcome unknown; verify before retrying.” Closing a stale connection can prepare the **next** operation without repeating this one. Retry only when the transport provides credible evidence that dispatch never happened, or when a narrowly justified idempotency contract exists. MCP annotations alone are not authority to weaken approval or plan-mode policy. With no reliable evidence, choose no automatic replay.

Return an explicit error classification through the existing tool-result path and show an actionable explanation. Keep credentials, server headers, and arguments with secrets out of diagnostic text. Preserve successful image/text mapping and actual server-declared errors.

**Acceptance:** mock mutating tool increments a durable test counter then drops the connection; counter remains one, result says uncertain, future independent call reconnects. A connect-before-dispatch failure remains recoverable. Cancellation is not automatically retried. A tool's ordinary `isError` remains its own failure, not a fabricated transport failure.

**Proof:** add a focused registered host suite (or extend the real MCP test fixture), `test:mcp-tool-images`, `test:mcp-image-server`, `test:plan-tools`. The regression must observe invocation count.

**Do not:** add a generic “retry everything” button or assume exactly-once execution can be guaranteed over every MCP server.

## C03 — Make engine capabilities visible and enforceable

**Priority:** P1. **Evidence:** F02, F07, F11. **Depends on:** nothing; coordinate wire changes with C04/C07.

**Read:** `src/engines/types.ts`, both engine adapters, `src/webviewRouter.ts`, `webview-ui/src/types.ts`, `App.tsx`, `MessageList.tsx`, `MessageItem.tsx`, `InputBar.tsx`, `SettingsPage.tsx`.

**Implement:** derive one host-owned capability view for the active chat. Start from existing `steering`, `rewind`, `localTools`; add only distinctions current consumers need: file restore, Xratu browser tooling, native-vs-Xratu configuration ownership, and subagent support. Use supported/unsupported/reason keys where a boolean cannot explain the limitation. Keep settings engine scope separate from chat scope.

Gate historical edit/resend, relevant restore choices, and unavailable local-runtime controls at render time. Keep host checks too. Explain why a control is unavailable and offer an actual alternative: copy the old message into a **new** draft, continue in a fresh chat, or file-only restore when valid. No generic success toast for an unsupported action. On rejection preserve typed text.

**Acceptance:** the native chat does not offer an edit flow that ends in `engineRewindUnsupported`; built-in edit still works; switching settings scope never changes chat capability; restored native sessions show native capability regardless of current default; locale flips translate reasons. Unknown capability defaults conservatively.

**Proof:** `test:engines`, `test:protocol-drift`, `test:agent-events`, webview tests; add engine E2E cases for each disabled action and its alternative. Verify both locales at narrow/wide widths.

**Do not:** implement native rewind by truncating only Xratu history.

## C04 — Persist drafts by session and acknowledge sends

**Priority:** P1. **Evidence:** F01, F02. **Depends on:** C01 action identity; coordinate C03. **Split:** text scoping/persistence; attachments and acknowledged delivery.

**Read:** module draft globals in `InputBar.tsx`, `App.tsx::handleSend`, `vscode.ts`, host send/rejection paths, `src/attachments.ts`, `src/chatViewTypes.ts`.

**Implement:**

1. Replace globals with a typed draft store keyed by workspace + stable session identity, with a distinct new-chat key. Include text, attachment references, edit intent, revision, and update time. Promote new-chat identity atomically when the host assigns an ID.
2. Use merged VS Code webview state for small UI state. If attachments need durable bytes, store them in extension-owned draft storage with opaque IDs, bounds, cleanup, and atomic writes; keep secrets and large base64 out of webview state. Define expired/missing attachment behavior visibly.
3. On a session change, save A and restore B. An edit draft references the original session and turn; it cannot silently migrate. On edit cancel, restore the prior ordinary draft rather than discarding it.
4. Give sends a request ID and host acknowledgement tied to session/epoch and draft revision. Clear only the submitted revision after acceptance. If the user types another draft while acknowledgement is pending, never clear that newer content. Duplicate requests must not start duplicate turns.
5. Rejection restores the submitted content without overwriting newer typing; present it as recoverable content when merging would be ambiguous. Do not retry a possibly accepted send automatically after reload. Query or show its known receipt/status first.

**Acceptance:** A/B drafts remain independent; webview reload restores A; accepted send clears only A's submitted revision; native unsupported action preserves content; attachment-only drafts survive/recover honestly; double Enter produces one host turn; late rejection cannot replace another session's text. Keep draft bytes bounded and delete abandoned blobs after the defined retention period.

**Proof:** add pure store/migration tests and browser tests with persisted mocked API state; cover missing/corrupt state, old version, late ack, deleted session, and new-session ID promotion. Run attachment-related suites and `app.spec.ts`.

**Do not:** persist `File`, blob URLs, or an entire React state tree. Do not add a second conversation history store.

## C05 — Bind a conversation to an explicit execution target

**Priority:** P1. **Evidence:** F05, F13. **Depends on:** C01. **Split:** persisted connection identity/mismatch UI; canonical workspace resolution.

**Read:** `LocalSessionSnapshot`, `_openSessionNow`, `_restoreLocalSession`, `_runLocalAgent`, `_localWorkspaceKey`, `_localRulesContext`, native run setup, credentials selection.

**Implement:** add versioned optional built-in execution metadata: connection ID (never key/token), model, and canonical workspace reference. Reuse native `EngineSessionRef` semantics. Route tools, checkpoints, rules, git status, attachments, session filtering, and browser context through one resolved workspace for a run. Freeze identity for the run; changing the active editor must not redirect it.

For old sessions without connection identity, show that the connection must be chosen or explicitly adopted. For deleted/missing connections or workspaces, keep history readable and block only execution with a repair action. Do not overwrite another connection's preferred model during restore. In multi-root VS Code choose/confirm the execution folder, display it, and test editor changes. Use `Uri`/`path` APIs; account for Windows casing and remote extension-host location.

**Acceptance:** reopening a session never silently sends its history to a different provider; same model ID on two endpoints stays distinct; missing connection has a repair path; multi-root rules and tools target the same root; native resume retains its saved binary/workspace/native session; moved workspace is resolved explicitly, not guessed from a basename.

**Proof:** `test:session-store`, `test:engines`, `test:provider-identity`, `test:workspace-kind`, new host execution-target tests. Model restore must be tested with two connections sharing a model ID.

**Do not:** migrate API keys into session JSON or allow arbitrary webview-provided roots to become execution authority.

## C06 — Preserve native run lifecycle and expose recovery honestly

**Priority:** P1. **Evidence:** F07. **Depends on:** C03/C05 for identity; event visibility can start independently. **Split:** event mapping; stream-loss recovery.

**Read:** OpenCode `engine.ts`, `events.ts`, `shells.ts`; `LocalAgentEvent`, `historyRows.ts`, reducer/retry UI; T3 `packages/provider-opencode/src/server/v2/adapter.ts`.

**Implement:** map retry status with truthful fields; don't manufacture `maxAttempts` if native OpenCode doesn't provide one. Map compaction started/ended/failed and any supported failed-step usage. Preserve text/reasoning block identities and completion boundaries so intermediate prose doesn't collapse into one misleading final block. Keep unknown events forward-compatible and diagnostically visible without dumping credentials/payloads.

Treat stream loss separately from runtime failure. First prove SDK status/history capabilities against the installed/pinned version. If reconciliation can establish whether execution is running/completed/failed, use its IDs to rebuild missing display state and deduplicate usage/results. If not, mark the run interrupted/unknown and offer explicit repair; retain the existing best-effort interrupt. Never resend the original prompt merely because the stream disconnected. Keep Stop usable while waiting for permissions/forms/retry; stale forms must be retired on terminal events.

**Acceptance:** rate limit shows waiting/retry with cancellation; compaction is visible; failed-step reported usage is counted once; stream drop after completion does not replay tools; a missing native session offers a new-chat path preserving draft/history; a quiet-but-live stream follows the documented heartbeat policy. Pending steers settle or return to recoverable state, never disappear silently.

**Proof:** deterministic event fixtures including duplicates, ended-without-delta, delayed terminals, dropped stream, cancellation while approval waits, and steers delivered by a subsequent execution. `test:engines`, `test:agent-events`, `test:usage-ledger`, targeted engine E2E. One real pinned OpenCode smoke test remains a release gate.

**Do not:** promise seamless reconnect until native APIs can prove it. Do not import T3's orchestration framework.

## C07 — Carry structured outcomes through the entire event pipeline

**Priority:** P1. **Evidence:** F08. **Depends on:** none; coordinate C06. **Split:** terminal metadata; native non-text result mapping.

**Read:** `LocalToolResult`/`LocalAgentEvent`, `mcp.ts`, `xratu_mcp_tools.ts`, `historyRows.ts`, `localSessionStore.ts`, `eventBounds.ts`, `subagentObservation.ts`, UI `types.ts`/`state.ts`/`CompletedOutcome.tsx`/`ToolImages.tsx`.

**Implement:** introduce optional typed outcome metadata such as execution kind, command, actual exit code (`number | null`), and status (`completed`, `failed`, `cancelled`, `running`, `unknown`). Preserve it at every serialization/reduction/bounding seam, including restored and child events. Prefer this over output-string parsing. Keep a narrowly scoped legacy parser for older snapshots only.

Native metadata must enter the shared representation. Map supported bounded image/resource results deliberately; don't fetch arbitrary resource URLs to make a preview. Unsupported content should have an explicit summary/link contract, not silently vanish. Preserve native ownership of model context. A background launch isn't command success. `run_tests` can be classified as test execution, but an arbitrary successful command cannot.

**Acceptance:** built-in and native nonzero exits render the same outcome; absent exit stays unknown; output containing a fake `Exit code: 0` cannot override structured failure; cancellations don't render as passed checks; `run_tests` is visible; historical text-only snapshots still render; child screenshot/results remain intact.

**Proof:** `test:agent-events`, `test:history-bounds`, `test:event-bounds`, `test:engines`, `test:subagent-observation`, `test:subagent-runner`, relevant MCP image suites and webview outcome tests. Add a producer→persist→restore→render test, not only a component-prop test.

## C08 — Persist review work against content identity

**Priority:** P1. **Evidence:** F09. **Depends on:** C01/C05.

**Read:** `ChangesPanel.tsx`, `workSurface.ts`, `shadowGit.ts`, existing review E2E.

**Implement:** host-owned bounded review storage keyed by workspace/session/base checkpoint/path and a content revision (a digest, not full source strings). Store notes and reviewed state separately from model history. Preserve notes when switching files/checkpoints/sessions and returning. Mark a review stale when the working side changes; don't delete the note or silently reattach it to new content.

Host replies include request/session/checkpoint/revision identity. Notes save with request IDs and acknowledgement; stale saves cannot overwrite a newer revision. Preserve the current stale-reply guards, file membership, symlink/path safety, and size limits. Define cleanup on session deletion and checkpoint retention, including legacy sessions without review state.

**Acceptance:** write a note, switch A→B→A, reload: it remains on A. Mark reviewed then edit the file: mark becomes stale/unreviewed, note remains identified. Late old-session file reply cannot change current review. Two rapid note saves persist the newer text. Storage failures appear with retry and retain the draft.

**Proof:** new host review-store suite with migration/bounds, `test:work-surface`, `test:shadow-checkpoint`, `work-surface.spec.ts`. No whole-file copies in the persisted review metadata.

## C09 — Add anchored line feedback and a review-to-fix loop

**Priority:** P2. **Evidence:** F09. **Depends on:** C08, C04. **Split:** single-line comments; multi-comment submission.

**Implement:** extend `ReviewDiff` rows to expose old and new line numbers and side identity. Start with selecting one line or bounded range. Store comment ID, path, base SHA, working revision, side/range, bounded diff excerpt, and text. Use T3's `reviewCommentContext.ts` for coordinate reasoning, not its entire diff stack.

Add selected comments to the composer as structured context attachments with readable labels. Sending is an explicit user action; merely selecting/commenting does not start inference. Preview the actual context to be sent. Keep submitted/resolved/stale states distinct. A changed file invalidates anchors unless a tested remapping succeeds. Preserve file-level comments for binary/oversized diffs and the native editor fallback.

**Acceptance:** deleted-line comments reference the old side; inserted lines use the new side; two files' comments retain their own revisions; stale selection is called out; long snippets are bounded; adding feedback doesn't overwrite an existing draft; marked “resolved” does not mean the model independently verified the fix.

**Proof:** pure coordinate tests, long/truncated/CRLF/renamed-file fixtures, `test:work-surface` and real keyboard E2E in both locales. Add actual visible line numbers, not just hidden metadata.

## C10 — Make steering and queued next turns distinct

**Priority:** P2. **Evidence:** F10. **Depends on:** C01/C04/C06.

**Implement:** define a host-owned pending-message record with stable ID, session/epoch, text/attachment references, mode (`steer` or `next-turn`), and lifecycle (`pending`, `delivering`, `applied`, `cancelled`, `rejected`). Preserve existing “send while busy = steer” behavior initially; add an explicit alternative for next-turn queueing.

Allow edit/remove only while the message is still pending. Use revisions to arbitrate edit vs delivery. A message can be applied or cancelled, never both. Native delivery uses existing inbox IDs; if native cancellation isn't supported at a given boundary, show “already delivering.” Restored pending work must not start inference automatically without an established product policy; default to a paused recoverable queue.

**Acceptance:** remove a waiting message and it never enters model history; edit changes exactly one pending item; cancellation racing native delivery yields a truthful terminal state; next-turn messages wait until completion; Stop doesn't silently erase unsent work; switching sessions isolates queues.

**Proof:** deterministic deferred execution/approval tests and E2E with multiple pending messages. Study T3 `QueuedRunsControl.tsx` and `queuedMessageEdit.ts`. Do not enqueue a second native prompt to simulate editing the first.

## C11 — Finish session recovery, organization, and portability

**Priority:** P2. **Evidence:** F04, F14. **Depends on:** C01/C04/C05; C07 metadata before rich export. **Split:** recovery/archive; export; fork.

**Implement:** surface interrupted saved turns explicitly with Continue, Copy request, or New chat actions appropriate to the engine. Preserve the current pending-turn salvage and monotonic usage ledger. Add reversible archive and metadata filtering before implementing complex folders/tags. Include engine/connection/workspace in session rows, with sensitive fields omitted.

Add Markdown export of the visible conversation and optional versioned machine-readable export. Export must identify omitted attachments/truncated traces; never imply it can fully restore a native runtime database. Let the user choose the destination with VS Code APIs. Import, if added, treats all data as untrusted and never restores executable permission decisions or live task IDs.

Fork initially creates a new conversation with explicit context/handoff and provenance. Full built-in history fork is a separate tested slice preserving valid tool pairs and compaction boundaries; native fork requires native API support. Never alias native session IDs between conversations.

**Acceptance:** interrupted turn survives reopen; archive/unarchive preserves drafts/review notes; export includes correct engine and omission markers and no credentials; deleting one session doesn't remove shared runtime history unexpectedly; a fork cannot mutate the source session's ledger or refund usage.

**Proof:** `test:session-store`, `test:history-bounds`, `test:usage-ledger`, session UI tests, malformed/old export fixtures.

## C12 — Make context, rules, and compaction inspectable

**Priority:** P2. **Evidence:** F13. **Depends on:** C05; C06 for native information.

**Implement:** a compact context inspector explaining selected connection/model/window, measured vs estimated tokens, loaded root/nested rule files, truncation, attachments, skill/tool snapshot freshness, and summary presence. Show counts/metadata first; don't dump system prompts or sensitive context into diagnostics by default.

Fix rule collection to use the pinned execution root. Give omitted/truncated rules a visible status and define precedence under the total budget. Preserve stable prompt prefixes: user-triggered “refresh instructions for next turn” or new-chat refresh should be explicit, with cache implications. For edits in a nested directory, investigate a path-specific supplemental rule resolver instead of reserializing all instructions every token/turn.

Add an explicit compaction action only for engines that support it. It must use the run's actual context/output limits, retain pending task state and unanswered decisions, and accurately disclose when summarization degraded to deterministic trimming. Native compaction remains native-owned.

**Acceptance:** multi-root shows the same root used by tools; a rule beyond the cap is visibly omitted; refreshing rules applies at a known boundary; tiny-context models stay within budget; unknown window/usage is labeled; summary failure doesn't become a blank successful summary.

**Proof:** `test:compaction`, `test:compaction-e2e`, `test:compaction-policy`, prompt-cache suites, new rule-precedence tests and inspector E2E.

## C13 — Add diagnostics that lead to recovery

**Priority:** P2. **Evidence:** cross-cutting completion need; existing errors/output channel already exist. **Depends on:** C05–C07.

**Implement:** an in-app diagnostics page or focused drawer summarizing extension version, engine binary/version, connection state (without key), model catalog freshness, workspace identity, proxy source, offline state, browser availability, MCP health, and last categorized failure. Each failing subsystem gets its actual repair action: retry discovery, reconnect, edit path, open provider setup, or view output.

Provide a sanitized support export with a preview. Centralize redaction for authorization headers, API keys/tokens, callback query parameters, raw prompts/attachments, MCP env/header secrets, and optionally paths. Never copy the developer-only raw JSONL tape unfiltered. A diagnostic probe is read-only/catalog-only by default; paid inference needs explicit action.

**Acceptance:** no “connected” verdict from having a saved key alone; offline/native conflict explains the fix; support export passes seeded-secret regression tests; diagnostics failures don't break chat; cancellation ends probes; stale responses can't overwrite a later connection's status.

**Proof:** `test:provider-errors`, proxy/OAuth suites, new redaction tests, diagnostics E2E. Retain raw provider error detail locally where helpful, but treat it as potentially sensitive at export.

## C14 — Finish browser collaboration before adding browser breadth

**Priority:** P2. **Evidence:** F11. **Depends on:** C03/C05; C07 for result metadata. **Split:** ownership; basic interactions; optional tabs/profiles.

**Implement first:** human/agent/unclaimed ownership or an equivalent explicit interaction lock with a generation token. Acquire/recheck before each mutating tool command. User takeover cancels/rejects pending agent mutations; inspection can remain allowed. A serialized promise queue prevents simultaneous commands but does not establish user intent or ownership.

Then add explicit wait-for, native select, and dialog handling with bounded timeouts and clear cancellation. File upload uses a user-approved workspace/attachment handle validated host-side. Downloads need an explicit destination/approval and bounded retention. Do not route these through unrestricted evaluate just to avoid implementing a contract. Native OpenCode gets capability messaging; bridging local browser tools to it is a separate project.

Keep one isolated ephemeral page as the default. Multi-tabs, persistent profiles, authentication retention, recordings, and annotations are optional later slices with their own threat/ownership/lifetime designs. Do not load the user's personal browser profile automatically.

**Acceptance:** takeover prevents a previously queued click; stale browser generation cannot act on a replacement page; dialog doesn't hang the loop; uploads cannot escape the allowed file scope; cancel interrupts waits; offline switching still closes connections and enforces loopback-only; remote-host localhost semantics are visible.

**Proof:** `test:browser`, `test:plan-tools`, native browser E2E fixtures for popup/dialog/form/navigation/cancel. Inspect the live Browser panel at narrow/wide sizes and both locales. Test behavior, not only the screenshot stream.

## C15 — Add explicit subagent controls without weakening isolation

**Priority:** P2. **Evidence:** F12. **Depends on:** C05/C07; queue interactions depend on C10. **Split:** targeted cancellation; provider-aware profiles; optional resumed context.

**Implement:** per-child AbortController composed with the parent signal, stable run identity, and host-authorized stop/retry controls. Keep the observation pane read-only; controls operate through parent-owned host actions and retain approval attribution. Stop one child without stopping siblings. A retry is a new execution attempt with provenance; a continuation uses only a live chat-scoped registry record, never a persisted task ID masquerading as resumable.

For cross-connection children add an optional connection reference to profile configuration, resolved by the host from SecretStorage metadata. Validate the chosen model against that connection and compute all caps/effort/transport there. Attribute spend to the actual child connection. Missing connection fails visibly rather than falling back to the parent's paid model. Plan mode, offline policy, and tool strips apply equally.

**Acceptance:** independent stop settles pending approvals and leaves siblings running; session switch interrupts all old children; recovered traces remain interrupted; no child receives task/plan-edit/question escape tools; cross-provider usage is attributed correctly; unknown tools still surface load errors.

**Proof:** mandatory `test:subagents`, `test:subagent-runner`, `test:subagent-observation`, `test:parallel-subagents`, usage tests; English/Persian README sections and `test:farsi-orthography`; agent-observation E2E. Do not implement arbitrary recursive delegation.

## C16 — Complete provider/model/local-runtime recovery paths

**Priority:** P2. **Evidence:** enhancement; substantial setup already exists. **Depends on:** C03/C05/C13.

**Implement:** use one connection-state vocabulary across onboarding, Providers, composer, and diagnostics: saved, probing, catalog available, authenticated, unavailable, model missing. Credentials stay editable only through the existing surface. Preserve request IDs and cancellation when switching drawers/connections.

Model selection must distinguish provider instance, model, native variant/effort, capability certainty, and pricing certainty. Preserve explicit paid selections and the current no-automatic-paid-fallback invariant. Bound eligible free probes and expose cache time/cancel; provider availability checks must not silently become paid inference. Local setup should explain server missing vs server running/no models vs model too large/unsupported tools. Keep pull/cancel/delete outcomes visible after page navigation.

**Acceptance:** removed model offers a choice without paid fallback; duplicate model IDs on different connections never collide; OAuth cancel/reconnect is understandable; offline local setup completes with no cloud dependency; native auth forms unsupported by Xratu have an accurate native-setup route; deleting a selected local model invalidates selection safely.

**Proof:** `test:engines`, model-discovery/metadata/runtime-controls/OAuth suites, onboarding/welcome/engine E2E. Add only missing scenarios; do not rebuild the already guided setup.

## C17 — Finish MCP and skills management feedback

**Priority:** P2. **Evidence:** tools-only MCP bridge and file-based skills exist; broader protocol is an enhancement. **Depends on:** C02/C03/C13.

**Implement:** show which config scope and engine owns each item, current connection/discovery error, tool count, and whether changes take effect now or next chat. Restart/reconnect must produce a settled result, including timeout/error. Keep installed marketplace configuration review and exact command/URL confirmation.

For skills expose loaded/disabled/invalid/overridden source status, create/open-file, refresh, and “available next chat” when schemas were snapshotted. Reuse discovery and agent loader patterns for diagnostics; do not silently ignore malformed frontmatter. Add watchers only if debounced and scoped; explicit refresh is sufficient initially.

MCP OAuth, resources, prompts, and resource subscriptions are separate opt-in cards if actual users need them. They need separate schemas and approval rules; never advertise them just because the SDK supports them. Native MCP/skills remain read-only until a supported native configuration API is implemented.

**Acceptance:** bad config shows the exact server and repair path; changing a skill/tool during a run truthfully explains freshness; global/workspace overrides are clear; disabled server doesn't reconnect on the next status refresh; no secret-bearing config enters support exports.

**Proof:** MCP marketplace/config/image suites, skills/subagent loader suites, capabilities E2E, scoped native-view tests.

## C18 — Finish git handoff, then consider isolated worktrees

**Priority:** P2/P3. **Evidence:** F15. **Depends on:** C01/C05/C08; C11 for worktree session organization. **Split:** SCM handoff; branch create; worktrees; PR integration.

**Smallest useful release:** expose “Open Source Control” and native diff from Changes, clarify checkpoint diff versus Git diff, allow approved branch creation/selection, and show dirty/ahead/behind/conflict state where known. Reuse VS Code's SCM UI instead of implementing a second index/staging editor. Existing agent git tools remain available under their approval gate.

**Worktree expansion:** persist repo/worktree/session ownership; select the new execution root before the first run; handle setup failure and dirty cleanup with an explicit recovery path. Never delete a user-owned tree or remove one still used by a session/background job. Windows path spaces, linked `.git` files, detached HEAD, non-Git folders, and removed worktrees are first-class fixtures. Existing sessions keep their original workspace.

**PR expansion:** start with explicit create/open/link handoff through installed GitHub tooling; do not auto-push. Represent checks/review/conflicts separately if adding status. Persistent PR monitoring requires a real wakeup/lifecycle design in an extension host; it is not a timer pasted into App.

**Acceptance:** no branch mutation during a run; checkpoint restore never stages/commits the real index; create failure doesn't redirect chat to a nonexistent root; cleanup preserves dirty work; no hidden push/merge; non-Git workspaces remain usable.

**Proof:** git-status/shadow/workspace/session suites; isolated temporary Git repositories; Windows CI; one real VS Code SCM handoff check. Keep worktrees out of the five-day core release.

## C19 — Measure performance and close accessibility/state gaps

**Priority:** P2. **Depends on:** apply per component after its feature card; avoid an all-at-once rewrite.

**Implement:** collect baselines for first render, streaming updates, session switch, history expansion, large diff selection, and background-log growth using deterministic fixtures. The transcript already pages history; preserve scroll anchoring and hidden mounted panels. Optimize measured bottlenecks before introducing virtualization or moving every state variable into a new store.

Add recoverable error boundaries around independent heavy panels with a reset/retry action that doesn't clear chat. Audit focus return, keyboard-only navigation, modal traps, accessible names, live-region announcements, reduced motion, 200% zoom, light/dark themes, and both locales. A screenshot alone cannot validate these.

Set explicit budgets from the baseline and record hardware/browser/fixture; proposed initial guardrails are bounded mounted message count, bounded browser/log memory, and no growth across 20 open/close cycles. Choose latency thresholds after measuring, not from this document. Reduce relevant lint warnings in touched code; separate broad cleanup from behavior PRs.

**Acceptance:** malformed optional panel data cannot blank the whole app; reset doesn't erase draft/history; focused control remains reachable after docking/locale changes; long-running stream does not grow retained UI data without bound; performance tests compare the same fixture/build.

**Proof:** relevant existing work-surface/agent/browser/approval tests; targeted profiling traces, accessibility assertions, actual screen-reader or accessibility-tree review. Retain screenshots of substantive states, not just the empty welcome screen.

## C20 — Expand native support only behind tested contracts

**Priority:** P3. **Evidence:** explicit current limitations. **Depends on:** C03/C05/C06/C07/C21 core pass.

**OpenCode slices:** support additional auth/forms only from the pinned SDK's real field semantics; use option values rather than labels as identity, validate conditional/number/multiselect fields, and retire cancelled forms. Then consider native rewind and subagent observation as separate projects. Native rewind needs both runtime and display/history reconciliation with a recoverable partial-failure path. Native subagent permissions and tools remain native-owned.

**Additional engines:** one adapter per PR series (Codex or Claude Code), after verifying that engine's current official protocol/documentation during implementation. Define setup/version probe, credentials owner, model catalog, session identity, event mapping, permissions, questions, cancellation/process-tree cleanup, recovery, usage, and capabilities before adding a selectable UI entry. “Coming soon” selectable controls do not count as an implementation.

**Acceptance:** the same engine conformance fixture tests startup, successful turn, failure, cancellation, approval, question, resume, missing binary, and unsupported capability behavior. No credential copying between Xratu and native runtimes. Offline remains blocked where Xratu cannot enforce isolation. Old sessions continue to resolve their original engine.

**Proof:** `test:engines` plus per-adapter suites, live smoke on supported platforms, installer/checksum tests if adding managed binaries, bilingual docs and third-party notices. This audit does not certify uninspected external protocols.

## C21 — Release acceptance and completion gate

**Priority:** continuous, mandatory. **Depends on:** each released card. This is a test/dogfooding/release package, not a new product feature.

### Common gate for every behavior PR

```sh
npm run lint
node_modules/.bin/tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p webview-ui/tsconfig.json
node esbuild.js
npm run test:webview
```

Host suites consume `out/`. Use `npm run test:host` for a full fresh aggregate gate, or compile with `npm run compile-tests` before focused `npm run test:<suite>`. A new `test:*` host script is discovered automatically by the aggregate runner. Do not accidentally register a browser/manual/live-paid suite there.

For relevant UI changes:

```sh
npm run build:webview
npx playwright test -c test/e2e/playwright.config.ts app.spec.ts work-surface.spec.ts engines.spec.ts onboarding.spec.ts welcome-flow.spec.ts
```

Add the relevant browser/agent/approval specs for their cards. Full release: all E2E/host suites and the required three-OS CI matrix. Use the pinned browser for pixel baselines. Do not update screenshots just to hide a behavioral failure.

### Required journeys

1. **First use:** free OpenCode, BYOK, and local paths each reach a usable chat; missing binary/key/model/network has an actionable next step. Repeat failed/cancelled setup and resume.
2. **Normal work:** read → plan → explicit build transition → approved edit → terminal/test → review → feedback → fix. Unknown tool/mutation still fails deterministically in plan mode.
3. **Continuity:** draft in A → B → A; webview reload; host restart; send rejection; edit cancel; attachment-only send. No lost or cross-session content.
4. **Interruption:** cancel while streaming, tool running, approval waiting, child waiting, native retry, and setup probing. All visible states settle; no accidental re-execution on recovery.
5. **Ownership:** stale restore confirmation, late file reply, missing session, connection change, multi-root editor switch, branch switch attempt during run. Every operation keeps its intended target.
6. **Native parity:** real OpenCode permission/question/steer, rate limit/retry where reproducible, background shell, usage, restored native session, unsupported rewind explanation. Never simulate parity by changing only the UI.
7. **Review:** changed/new/deleted/binary/large files, old checkpoint, modified reviewed file, comment recovery, revision-stale feedback. Safety restore uses only shadow git.
8. **Extensibility:** MCP success/error/disconnect-unknown outcome, skill freshness, invalid agent tool list, parallel child approval and cancellation.
9. **Browser:** launch missing/installed, localhost, navigation, user takeover, stop, resize, session switch, offline transition, webview reload.
10. **Presentation:** English/Persian, ~420px/wide, dark/light, keyboard-only, zoom, reduced motion. Screenshots use `installVscodeTheme` and viewport captures; inspect actual content states.

### Release procedure

Run `npm run package-vsix`; install the artifact in a disposable VS Code profile and test a basic built-in and native journey plus reload. Validate an upgrade from an older session/draft fixture. This audit ran on Linux; Windows/macOS runtime checks remain necessary.

Keep conventional commits and small PRs. Triage every automated review finding, not just CI failures. Bump `package.json` in each user-visible PR according to repository policy; don't preassign all future release numbers. Update English/Persian READMEs and third-party notices when applicable. Only release from reviewed main using the existing tag workflow; no direct push to main. Keep `test:release-workflow` green if that workflow changes.

Record for each journey: build/commit, engine/version, platform, locale/width, actual result, evidence, and unresolved issue. A skipped live/platform test is a limitation, not a pass.
