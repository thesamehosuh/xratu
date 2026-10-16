# Audit evidence

See [the execution order](README.md) and [implementation cards](implementation.md). Source references below are relative to this repository. Prefer the named symbols when line numbers move.

## Coverage and confidence

This was a workflow-oriented source audit, not a line-by-line proof of the whole repository. It covered the host/router/session store, built-in and OpenCode engine boundaries, composer and work surface, checkpoints/review, browser controller, subagent runner, MCP transport, rules/context, provider/setup, test runners, and CI. Relevant T3 implementations were read locally, without modifying or running T3.

Evidence labels:

- **R — reproduced:** observed in the built webview with a mock VS Code host.
- **S — source-confirmed:** the missing behavior or ordering is explicit in the code; consequences may still require a focused regression test.
- **H — hypothesis:** plausible failure needing a test before a fix is selected.
- **E — enhancement/limit:** absent or deliberately restricted capability, not automatically a defect.

A mock-host browser does not prove extension-host integration, real provider behavior, Windows operation, or live OpenCode compatibility. No paid inference, real account authentication, destructive restore, or real repository branch switch was performed.

## Verification baseline

- `npm run lint`: passed with **0 errors and 291 warnings**. The instructions' “handful” of warnings understates the observed debt; do not turn rules down.
- Host `tsc --noEmit -p tsconfig.json`: passed.
- Webview `tsc --noEmit -p webview-ui/tsconfig.json`: passed.
- `node esbuild.js`: passed.
- `npm run build:webview`: passed.
- `npm run test:webview`: all suites passed.
- `npm run test:host -- --json <temporary-file>`: **78 suites passed**.
- Targeted browser suites: `app.spec.ts`, `work-surface.spec.ts`, `engines.spec.ts`, `onboarding.spec.ts`, `welcome-flow.spec.ts`: **107 tests passed** in approximately 1.5 minutes.
- Inspected actual built empty-chat UI in English/Persian at 420 and 1080 CSS pixels using the repository's shared Dark Modern theme fixture. This was a limited smoke inspection, not a complete visual audit of every page.

T3 preview initialization succeeded, but snapshots timed out twice with `Preview automation snapshot timed out after 15000ms.` Inspection therefore used Playwright CLI and installed Chromium. The mock retained VS Code webview state across reload, so draft loss was not caused by a mock that always returns empty state.

## Findings

### F01 — Drafts are neither durable nor scoped to a session [R, S]

**Evidence:** [InputBar.tsx](../../webview-ui/src/components/InputBar.tsx), module globals `draftText`/`draftAttachments`, state initialization and mirroring; [App.tsx](../../webview-ui/src/App.tsx), `sessionState` handler and `<InputBar>` props. The composer has no session identity prop. [vscode.ts](../../webview-ui/src/vscode.ts) already provides persisted webview-state helpers used by layout.

**Reproduction:** type `Draft belongs to chat A`; emit `sessionState` for B; the input still contains A's draft. Reload and replay A's session identity; the input is empty. Observed result: `{"afterSessionSwitch":"Draft belongs to chat A","afterReload":""}`. This directly reproduces the identity-message boundary, not the entire live extension session-switch path.

**Impact:** unsent work can disappear on reload or appear under the wrong conversation. Navigation-only draft tests do not cover this. **Card:** C04.

### F02 — Common chat UI exposes unsupported native editing [S]

**Evidence:** [engine types](../../src/engines/types.ts) define `rewind`; [OpenCodeEngine](../../src/engines/opencode/engine.ts) sets it false. [App.tsx](../../webview-ui/src/App.tsx) passes `handleEditMessage` unconditionally. [MessageItem.tsx](../../webview-ui/src/components/MessageItem.tsx) enables user edit from callback/busy state, without an engine capability. `_rewindAndResend` in [extension.ts](../../src/extension.ts) rejects OpenCode with `engineRewindUnsupported`.

**Impact:** edit → compose → send reaches a known dead end. InputBar clears on send, while this rejection emits a notification rather than a draft-restoration acknowledgement. Native submission loss is a **regression-test target**, not claimed as a live-provider reproduction. **Cards:** C03, C04.

### F03 — Restore confirmation does not pin the original session/turn [S, H]

**Evidence:** `_restoreCheckpointAt` in [extension.ts](../../src/extension.ts) captures a folder, awaits `confirmBanner`, rechecks active requests, then restores files. It resolves the user index only **after** restoring; it does not capture/recheck `_sessionEpoch`, original session ID, or matching turn checkpoint before file mutation. `restoreCheckpoint` in [webviewRouter.ts](../../src/webviewRouter.ts) accepts a SHA and positional index. [shadowGit.ts](../../src/shadowGit.ts) checks commit existence, not chat ownership.

**Risk to reproduce:** open restore confirmation in A, switch to B, answer A's confirmation. An idle B passes the busy check; the old checkpoint can be applied and the new history can be truncated by positional index. Do not test against real user files. Existing guarded review reads do not prove restore safety. **Card:** C01.

### F04 — Session adoption mutates current state before loading succeeds [S]

**Evidence:** `_openSessionNow` in [extension.ts](../../src/extension.ts) increments the epoch and calls `_resetSessionLedgers()` before loading the target snapshot. If load returns nothing, it warns and returns. The current host state has already changed; the visible old conversation can remain.

**Required regression:** missing/corrupt target session leaves the old identity/history/model usable and consistent. A failed load must not create an empty replacement of the old session. **Card:** C01.

### F05 — Session execution identity is incomplete for built-in connections [S, H]

**Evidence:** [LocalSessionSnapshot](../../src/local/localSessionStore.ts) stores workspace/model/native engine reference but no built-in credential/connection ID. `_openSessionNow` and `_restoreLocalSession` restore `snapshot.model` and call `_rememberModelForActiveCredential`. Several execution/checkpoint/git paths use `workspaceFolders[0]`; `_localRulesContext` and `collectProjectRules` may use the active editor's workspace folder instead.

**Risk to reproduce:** session A created with connection A, activate B, reopen A; a model-only restore may use B or alter B's remembered model. In a multi-root workspace, rules from root B can accompany tools rooted in A. Native workspace identity already has separate checks; preserve them. **Card:** C05.

### F06 — External MCP automatically replays ambiguous failures [S, H]

**Evidence:** `ExternalMcpManager.callTool` in [externalMcp.ts](../../src/externalMcp.ts) loops twice; the first thrown `client.callTool` error closes cached state and continues, without distinguishing before-send failure from response loss after execution.

**Risk:** an external mutation can execute twice if the first result is lost. A mock server that increments a counter then drops its reply can prove the issue without contacting any real service. Automatic reconnect for later calls is useful; repeating the current mutation is a separate decision. **Card:** C02.

### F07 — Native lifecycle information is discarded [S]

**Evidence:** [OpenCodeEngine.runTurn](../../src/engines/opencode/engine.ts) ignores `session.retry.scheduled` except during probes. It has no cases for native compaction events or failed-step usage. It concatenates text/reasoning globally rather than tracking the text-block identities visible in T3's adapter. The built-in [LocalAgentEvent](../../src/local/localTypes.ts) already includes retry information. [events.ts](../../src/engines/opencode/events.ts) times out a quiet stream after 45 seconds and has no reconciliation path; run cleanup attempts interrupt.

**Impact:** rate-limit waits can look like inactivity, native compaction is invisible, and interrupted-stream recovery is coarse. The existence of the timeout is not proof that legitimate live streams fail; heartbeat behavior must be tested. **Card:** C06.

### F08 — Native tool results lose structured outcomes [S]

**Evidence:** `contentText` in [engine.ts](../../src/engines/opencode/engine.ts) keeps only text. Native `metadata.exit` influences `isError` but does not enter the tool-result event. [CompletedOutcome.tsx](../../webview-ui/src/components/CompletedOutcome.tsx) recognizes completed checks by parsing `Exit code: N` out of text, only for `run_terminal_command`. Background jobs already carry typed exit codes. [LocalToolResult](../../src/local/localTypes.ts) supports images but not a terminal-outcome object.

**Impact:** native command success/failure detail does not reliably populate the outcome summary; `run_tests` and image/resource tool results need explicit treatment. Do not infer missing exit codes as zero or call every shell command a test. **Card:** C07.

### F09 — Review state and feedback are transient and coarse [S]

**Evidence:** [ChangesPanel.tsx](../../webview-ui/src/components/ChangesPanel.tsx) keeps reviewed fingerprints and comments in local Maps, clears them on checkpoint/session change, and sends feedback as `path + newline + comment`. Reviewed fingerprints include entire before/after text. [ReviewDiff.tsx](../../webview-ui/src/components/ReviewDiff.tsx) renders bounded unified diff rows, without selectable old/new line anchors. Reads in [workSurface.ts](../../src/workSurface.ts) are membership/path/size guarded and should be reused.

**Impact:** switching away and back to a checkpoint loses review work; reload loses notes; a feedback draft does not say which revision/lines it concerns. **Cards:** C08, C09.

### F10 — Pending steering has no user control surface [S, E]

**Evidence:** [App.tsx](../../webview-ui/src/App.tsx) stores `pendingSteers` and renders label-only `queuedSteers` chips. Busy sends always use `steerRun`. Host queues and native delivery IDs exist, but the visible queue has no edit/remove operation or distinct “run after completion” mode.

**Impact:** users cannot retract an undelivered correction or distinguish a correction to the active task from their next task. Do not discard current steering semantics while adding queues. **Card:** C10.

### F11 — Browser is a deliberately limited first version [S, E]

**Evidence:** [browserController.ts](../../src/browserController.ts) owns one ephemeral page, serializes actions, rejects stale browser/session identities, blocks popups/downloads, dismisses dialogs, and exposes screenshots/locators/evaluate. It has no human-vs-agent ownership state; both can enqueue interactions. [browserTypes.ts](../../src/browserTypes.ts) has no dialog/upload/select/tab/profile contracts.

**Impact:** useful basic inspection exists, but common website flows and simultaneous user/agent interaction are incomplete. Native OpenCode does not receive Xratu local browser tools. **Card:** C14. Profiles and multi-tab browsing are expansions, not prerequisite fixes.

### F12 — Child observation exists; independent lifecycle controls do not [S, E]

**Evidence:** [subagentRunner.ts](../../src/local/subagentRunner.ts) supports chat-scoped task continuation and a run registry. In [extension.ts](../../src/extension.ts), child `baseRequest` uses the parent's connection and AbortSignal while allowing model/effort overrides. [SubagentsPanel.tsx](../../webview-ui/src/components/SubagentsPanel.tsx) is an observation surface, consistent with current product rules.

**Impact:** no independent cancel/retry/provider selection through the UI. Do not describe the current runner as lacking delegation, parallelism, follow-up context, or approvals: all exist. **Card:** C15.

### F13 — Rules are bounded/cached but not fully explainable [S, E]

**Evidence:** [projectRules.ts](../../src/projectRules.ts) reads root-to-active-file rules with 4,000 characters/file and 8,000 total; later sections can be omitted. `_localRulesContext` freezes the resolved rules by root for prompt-cache stability. The root changes with the active editor even though the execution root often does not. [compaction.ts](../../src/local/compaction.ts) already implements summarizing compaction and deterministic fallback.

**Impact:** users cannot readily see which instructions loaded, which were truncated, or whether changed rules apply. More automatic rereading is not automatically better: it can break prefix caching and instruction consistency. **Card:** C12.

### F14 — Session management stops before longer-term organization [S, E]

**Evidence:** [Toolbar.tsx](../../webview-ui/src/components/Toolbar.tsx) already supports workspace/all-workspace lists, full-text search requests, rename, and delete. [localSessionStore.ts](../../src/local/localSessionStore.ts) has atomic saves/reconciliation/bounds and pending-turn snapshots. No archive/export/fork workflow appears in the audited router/UI protocol.

**Impact:** missing organization/portability and limited discoverability of interrupted work. Do not replace the session store merely because T3 has a database. **Card:** C11.

### F15 — Git UI stops at status and branch selection [S, E]

**Evidence:** [GitStatusBar.tsx](../../webview-ui/src/components/GitStatusBar.tsx), [BranchPicker.tsx](../../webview-ui/src/components/BranchPicker.tsx), `_gitCheckout` in [extension.ts](../../src/extension.ts). Checkout validates a listed branch and lets Git refuse destructive overwrites, but the host function has no active-run exclusion. Built-in git tools already support commit/branch/pull/push/merge under tool gating in [xratu_mcp_tools.ts](../../src/xratu_mcp_tools.ts).

**Risk to reproduce:** switching branch during an active edit changes the execution tree under the run. **Enhancements:** discoverable SCM handoff, branch creation, optional isolated worktrees, PR linkage. **Cards:** C01 for the race, C18 for expansion.

### F16 — Protocol and host complexity increase boundary risk [S]

**Evidence:** `extension.ts` was 7,640 lines, `App.tsx` 1,828, router 694 at audit time. Webview protocol unions are typed, while router input derives VS Code's upstream `any` and performs case-specific checks. Protocol-drift and event tests already exist. There is no justification for a wholesale rewrite.

**Recommendation:** extract only seams needed by the tickets: action context, execution identity, draft store, tool outcomes, and event reduction. Validate new inbound shapes at the boundary. Make mechanical extractions separate PRs. **Cards:** C01–C07, C19.

## Existing strengths that must not be rebuilt

The audit found working implementations for BYOK/local discovery, OAuth token management, model capability metadata, free-model eligibility/probing, first-run setup, request IDs, native session references, proxy/offline policies, deterministic plan gating, tool approval/source attribution, subagent wave limits, transient network retries, compaction, history bounding, shadow checkpoints, background process identity/recovery, bounded browser streaming, dock persistence, long-history paging, and bilingual strings. Most have focused suites. Extend their actual behavior; don't replace them with “v2” versions based on screenshots of T3.

## T3 reference map

Paths below are relative to the **T3 checkout**, not Xratu. They identify patterns to study, not code to copy wholesale. Check licensing and update `THIRD_PARTY_NOTICES.txt` if implementation is adapted.

- `apps/web/src/composerDraftStore.ts`: scoped draft keys, persisted attachment metadata, migrations, cleanup; use for C04. Its large Zustand store is not an instruction to introduce Zustand.
- `apps/web/src/lib/discardComposerDraft.ts`: undo without overwriting newer content; use for C04/C11.
- `apps/web/src/components/chat/QueuedRunsControl.tsx` and `queuedMessageEdit.ts`: queued-run IDs, edit/cancel lifecycle, attachment preservation; use for C10.
- `apps/web/src/reviewCommentContext.ts`: old/new-side line coordinates and bounded diff snippets; use for C09.
- `apps/server/src/orchestration-v2/CommandReceiptStore.ts`: accepted/rejected command receipts and command IDs; use the principle in C01/C04/C10 without importing its storage architecture.
- `apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts`: revalidation at admission and execution and shared-workspace hazards; use for C01/C18. Xratu need not adopt T3's isolated-worktree-only policy, but must explicitly address unrelated working-tree edits.
- `packages/provider-opencode/src/server/v2/adapter.ts`: block/event identity, native compaction, failed-step usage, subagent projection, form lifecycle; use for C06/C07/C20. Prefer this v2 adapter to the older OpenCode adapter when comparing the current engine.
- `apps/server/src/vcs/GitVcsDriverCore.ts` and `apps/web/src/worktreeCleanup.ts`: worktree ownership and cleanup boundaries; inspect before C18.

## What remains unverified

Live OpenCode forms/events/reconnects, actual cloud/subscription/provider flows, remote VS Code browser behavior, Windows/macOS runtime behavior, large real-world session performance, and every page's keyboard/light-theme rendering need the C21 matrix. A healthy local baseline does not close those gaps. Some enhancements below are product judgments, explicitly labeled, rather than missing promises.
