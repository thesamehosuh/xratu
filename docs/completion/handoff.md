# Brief for the implementation model

Copy the following into each task and replace the card/sub-PR placeholder. Give the model one bounded change at a time.

```text
Implement Xratu completion card C__ [specific sub-PR/slice].

Read AGENTS.md, docs/completion/README.md, the matching evidence in
docs/completion/audit.md, and ONLY the relevant card/dependencies in
docs/completion/implementation.md. Reconcile the audit baseline with the
current source before coding. The audit is a map, not a substitute for reading.

First identify the user-visible failure and write a meaningful failing
regression/reproduction for a bug. For an enhancement, implement the smallest
complete user journey described by the card. Do not implement later cards.
Report if the issue is already fixed or if the proposed premise is disproved.

Trace the complete path:
UI intent -> typed message -> host validation -> runtime/service operation ->
event -> persistence -> restored event -> reducer -> rendered result.
List which of these seams actually need changing. Preserve session, workspace,
engine, request, turn, and revision identity wherever relevant.

Use existing modules and test harnesses. New filenames in the plan are proposals.
Keep code changes small. Mechanical extraction gets a separate PR; do not rewrite
extension.ts/App.tsx or introduce a new framework just to reduce line count.

After implementation, run the common gate and the card-specific tests. Run both
host and webview tsc. Use fresh compiled host output. UI work requires the real
built bundle, shared theme fixture, English/Persian, narrow/wide inspection,
and the relevant E2E tests. Use deterministic deferred operations to test races.

All new UI strings need fa/en keys resolved at render time. Read the natural-farsi
skill before writing Persian. Keep no-ZWNJ orthography. Host messages carry keys.
Use Windows-safe paths/process launch/tree cleanup, real approvals, deterministic
plan restrictions, SecretStorage, path/SSRF guards, and shadow checkpoints.

Use a short-lived branch and conventional commit. Follow the repository's version
bump, bilingual documentation, PR, review-triage, and CI policies. No direct push
to main. Do not touch unrelated/untracked user work. Do not publish a release
unless the active task authorizes it.

Finish with the handoff below. If a test was not run or failed, state that exactly.
Do not mark the card complete with an unresolved acceptance criterion.
```

## Decisions the executor must not guess

- If two connections share a model ID, connection identity still distinguishes them.
- An acknowledgement for an old draft cannot clear newer text.
- A stale confirmation cannot acquire authority over a new session.
- The outcome of a disconnected tool call may be unknown; unknown is not failed-before-execution.
- A transcript restore cannot impersonate native runtime rewind.
- File-only restore, conversation rewind, checkpoint diff, and Git diff have different meanings.
- Display trace persistence does not make a child task resumable.
- Provider-reported zero cost, unknown cost, and publicly free eligibility are different values.
- A shell exit code is evidence of that command's result, not proof the whole task succeeded.
- A read-only inspection page can have separate host-authorized controls; do not make child transcripts interactive approval substitutes.
- A queue entry that became `delivering` cannot be locally deleted and called cancelled without host confirmation.
- Defaults/migrations must preserve old sessions. Unknown new fields should degrade safely; invalid identity must not silently fall back to another execution target.

## Required handoff after each change

```text
Card / slice:
Branch / commit / PR:
Baseline reconciled against:
User-visible before -> after:
Acceptance criteria met (with evidence):
Acceptance criteria still open:
Changed files and responsibilities:
Protocol / storage changes and migration behavior:
Identity and cancellation behavior:
Tests run with exact commands and results:
Real UI states inspected (locale, width, theme):
Live engine / platform checks not run:
Review findings and their disposition:
Known limitations / next dependent card:
```

Keep this handoff in the PR description or a task artifact. Do not create a new “source of truth” status database. The PR is the review artifact; this plan remains the scope/acceptance reference.

## Race-test recipes

Use controllable promises/fake clocks rather than arbitrary sleeps. A representative restore test:

```text
Given session A at epoch 10 and turn T with checkpoint S:
1. Request restore; keep its confirmation unresolved.
2. Switch to session B, completing its transition.
3. Resolve A's confirmation as files-and-chat.
4. Assert zero restore writes, zero B-history truncations, and a stale-action result.
5. Repeat without switching; assert exactly one restore and the intended truncation.
```

A representative send test:

```text
Given draft revision 3 containing X:
1. Submit request R with revision 3; hold acknowledgement.
2. Type Y, creating revision 4.
3. Acknowledge R as accepted.
4. Assert Y remains; X appears once in the host conversation.
5. Deliver the acknowledgement again; assert no second turn or clear.
6. Repeat with rejection and with a switch to another session before acknowledgement.
```

A representative uncertain-outcome test:

```text
Given an MCP tool whose handler increments a test counter:
1. Dispatch one call.
2. Increment the counter, then terminate the transport before replying.
3. Assert the manager reports unknown outcome and counter == 1.
4. Issue a separate new call after reconnection; assert it can execute normally.
```

A representative persistence test:

```text
Produce an actual host tool event with exitCode 7 -> serialize it -> run the real
snapshot sanitizer/bounder -> load it -> reduce restored events -> render outcome.
Assert failure and code 7 survive every seam. Repeat with null exit code and an
old snapshot containing only textual output. Never turn null into success.
```

These are scenario specifications, not prescribed class names. Extend the existing
harness to exercise production code; a mock that contains the intended fix proves
nothing about the product.

## Final reviewer questions

Does the visible control have a successful end-to-end path? Is there a recovery path for failure/cancellation? Can a late response act on the wrong session? Does reload preserve the right state without restarting mutations? Does the other engine behave honestly? Are identity and optional metadata preserved through old-snapshot restoration? Did the test observe behavior rather than simply assert that the new helper was called?

If any answer is unknown, add the missing proof or record the unresolved criterion. Do not cover uncertainty with a success toast or broader retry.
