# Xratu v2 completion playbook

Audit baseline: Xratu **2.2.4**, commit `b2748c9`; T3 Code reference checkout `ec80933ac8cd02fec5c97b342462ccc9567cdb1e`. Prepared 2026-10-12. These are local checkout observations, not claims about either project's latest release.

## The recommendation

Finish the reliability and continuity of the existing product before expanding its feature count. Xratu already has real agent loops, approval gates, checkpointing, multimodal transports, native execution, background jobs, subagent traces, setup, and a substantial test suite. The unfinished feeling comes partly from boundaries: state survives one navigation but not another; a common UI offers an operation one engine rejects; a native runtime emits information the adapter drops; recovery restores a transcript without enough identity to resume confidently.

“Complete” for this iteration means a developer can set up a runtime, start a task, steer it, answer approvals, inspect delegated work, review edits, recover from interruption, and return tomorrow without losing drafts, changing the execution target silently, or guessing what happened. Every unsupported operation should have an accurate explanation and a usable next step.

This is a completion program, not a promise that the entire backlog fits into a few days. The first five days should concentrate on the core release below. Larger engine, browser, and worktree expansions follow only after that release is stable.

## Read and execute

1. Read [the audit](audit.md) for evidence and limitations. **R** means browser-reproduced, **S** means source-confirmed, **H** means a hypothesis requiring a regression/reproduction, and **E** means an enhancement or deliberate current limitation. Do not report all of them as bugs.
2. Use [the implementation cards](implementation.md), one card or explicitly named sub-PR at a time. Each specifies existing code, required behavior, edge cases, and validation.
3. Paste [the executor brief](handoff.md) into the implementation model's task. Require the acceptance evidence and a handoff after each PR.
4. Reconcile this baseline with the current branch before editing. Work may have landed since this audit. Do not implement a ticket that is already solved.

## First release: make current workflows dependable

Execute in this order; cards identify finer dependencies:

- **C01 — Transactional session/checkpoint/workspace actions.** Highest consequence: stale confirmations and partially applied transitions.
- **C02 — MCP uncertain outcomes.** Prevent automatic replay of a possibly executed external mutation.
- **C03 — Engine capability gating.** Stop exposing native edit/resend paths that cannot succeed.
- **C04 — Durable, session-scoped drafts.** Preserve text and attachment identity through switching, rejection, and reload.
- **C05 — Explicit execution identity.** Bind workspace, engine, connection reference, and model consistently.
- **C06 — Native run visibility and recovery.** Surface retry/compaction and distinguish interrupted execution from completed work.
- **C07 — Structured tool outcomes.** Preserve exit status and typed result metadata through host, persistence, and UI.
- **C08 — Durable review state.** Keep notes and reviewed marks tied to the correct content revision.
- **C21 — Release acceptance.** Run continuously; finish the release only when the core journeys pass.

Suggested five-day allocation, with review time included:

- **Day 1:** C01 and C02, then C03 if the first two are green. Reproduce first; do not start with a refactor.
- **Day 2:** C04; implement C05's explicit mismatch guards and connection metadata in a separate PR.
- **Day 3:** C06's event visibility and C07's typed terminal outcomes. Keep automatic native recovery out unless proven safe.
- **Day 4:** C08 and C09's smallest useful line-comment slice, if the core is stable.
- **Day 5:** C21, interruption/reload dogfooding, regression fixes, bilingual docs, package/install validation. Add no major feature this day.

If work slips, retain correctness, draft recovery, and capability honesty. Defer line comments and expansion cards. A smaller verified release is the intended outcome.

## Following releases: finish the daily loop

- **C09:** anchored line comments and review handoff.
- **C10:** editable/cancellable pending messages and a distinct “next turn” queue.
- **C11:** recoverable session management, export, archive, and carefully scoped forks.
- **C12:** inspectable context, rules, and compaction.
- **C13:** actionable diagnostics and sanitized support exports.
- **C14:** browser collaboration ownership and ordinary web interactions.
- **C15:** subagent lifecycle controls and explicit provider selection.
- **C16:** consistent connection, model, and local-runtime setup/recovery.
- **C17:** finish MCP/skills management and runtime freshness feedback.
- **C18:** finish git handoff; isolate worktrees only after workspace ownership is correct.
- **C19:** measured performance, accessibility, localization, and panel recovery.
- **C20:** native engine parity and additional adapters, each separately scoped.

## Design decisions to preserve

- Keep VS Code as the application shell. Use its editor, diff editor, terminal, source control, and workspace facilities where appropriate. Do not transplant T3's desktop/mobile/server stack.
- Keep the built-in runtime a first-class offline/BYOK path. OpenCode's state, credentials, tools, and history remain native-owned.
- Adopt T3's identity, capability, receipt, and lifecycle ideas selectively. Do not add Effect, SQLite, event sourcing, a scheduler, or a new state framework simply to resemble T3.
- Do not equate capability parity with identical implementation. A native engine can truthfully lack rewind while still being a complete supported workflow.
- Keep display state separate from model context. Review marks, browser frames, subagent observations, and diagnostics are not conversation ledger entries.
- Preserve the existing Windows, approval, plan-mode, path, SSRF, secret-storage, i18n, and shadow-git rules in `AGENTS.md`.
- Existing agent Git tools can operate on the real repository under their approval policy. Checkpoint implementation must continue to use only shadow git. These are different operations.

## Exit criteria

The core release is ready when C01–C08 acceptance criteria and C21 pass, with each unsupported native operation accurately gated. The broader program is complete when the daily-loop cards have either shipped or have an explicit documented product decision to defer them. “No TODOs,” screenshots of empty pages, and green unit tests alone are not completion criteria.

No runtime code was changed during this audit. The pre-existing untracked `test/e2e/zz-diagnose.spec.ts` is user-owned and was left untouched.
