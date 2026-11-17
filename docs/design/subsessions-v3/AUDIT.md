# Sub-sessions: audit for the 3.0 redesign

This audit covers the working tree, including existing uncommitted UI changes. It is evidence for a redesign, not a certification of the implementation. No product source was changed during this audit. The package already reports 3.0.3; “3.0” below names the requested redesign milestone, not a proposal to downgrade the package.

## The actual Subagents tab

The built webview was opened in the shared browser with a mocked VS Code host and the repository's `installVscodeTheme` fixture. Actual host message shapes populated three children: one working, one awaiting approval, and one finished. These are UI fixtures, not real model runs. The tab was inspected at 1280×900 and 420×900 in English and Persian. The generated bundle was rebuilt after inspection to remove the temporary mock.

| English, wide | English, sidebar |
| --- | --- |
| [Screenshot](baseline/agents-en-1280.png) | [Screenshot](baseline/agents-en-420.png) |

| Persian, wide | Persian, sidebar |
| --- | --- |
| [Screenshot](baseline/agents-fa-1280.png) | [Screenshot](baseline/agents-fa-420.png) |

Observed behavior:

- The tab has a roster and a read-only child transcript. DOM inspection found no inputs or textareas inside it. A “Conversation” tab therefore looks like a conversation without allowing conversation.
- A waiting child shows a notice. “Review approval” switches to the parent's Conversation tab; the actual decision cannot be handled where the user is inspecting the child.
- The 420px layout stacks a separately scrolling roster above the details. With three children, the roster already needs scrolling. Roster, title, metadata, secondary tabs, and the approval notice take space before the child's content starts.
- Long task titles are abbreviated in the wide roster. The current tool's raw name is prominent, while the assignment, result delivery, and continuation affordances are weak or absent.
- Stop exists both in the roster and the detail header. There is no start, reply, queued instruction, continue, context selection, model change, or budget control.
- Finished work is represented as a finished invocation. There is no durable conversation to return to as a first-class item.

The separate [AgentsPage](../../../webview-ui/src/components/AgentsPage.tsx:6) manages reusable profiles, not running children. Both surfaces need new roles; fixing one does not redesign the other.

## Runtime findings

| Finding | Evidence | Design consequence |
| --- | --- | --- |
| A built-in child already has a separate context and stable conversation ID during its lifetime. | [subagentRunner.ts](../../../src/local/subagentRunner.ts:278) | Reuse the loop and replay expertise; replace ownership and storage. |
| Resumable child histories are an in-memory map, limited to eight runs per retained chat and four retained chats. | [run registry](../../../src/local/subagentRunner.ts:106), [extension registry](../../../src/extension.ts:1088) | A display history on disk is not a durable child session. Eviction must not destroy identity. |
| The child history is committed to that map on exit. The persisted trace is a different, lossy display representation. | [commitTurn](../../../src/local/subagentRunner.ts:323), [trace bounds](../../../src/subagentObservation.ts:45) | Persist committed child model events during execution; derive display pages separately. |
| A child is an awaited tool execution. Its abort signal is combined with the parent's turn signal. | [runner](../../../src/local/subagentRunner.ts:291), [parallel execution](../../../src/local/localAgent.ts:866) | Genuine background work requires an execution owner outside the parent turn. |
| The UI derives its roster from every parent `task` call. A follow-up invocation has another call identity even when it resumes the same child. | [collectAgentRuns](../../../webview-ui/src/subagentView.ts:4) | Session, execution, delegation, and tool-call identities must be distinct. |
| The child view synthesizes one assistant message from trace entries. | [agentMessage](../../../webview-ui/src/subagentView.ts:16) | It cannot become a proper multi-turn conversation just by adding a textarea. |
| Resume resolves the current profile by name again. Model and transport come from a factory tied to the parent's active connection. | [profile resolution](../../../src/local/subagentRunner.ts:265), [request factory](../../../src/extension.ts:4799) | Snapshot launch configuration and persist engine/connection identity. A profile edit must not silently rewrite a child. |
| A real session switch currently cancels the live run before adopting another session. | [session transitions](../../../src/extension.ts:6768) | Focus must become a subscription choice, independent of execution. Calling the existing open-session path is insufficient. |
| Current controls key cancellation by the parent tool call. | [stop route](../../../src/extension.ts:7387) | Preserve that historical attribution, but address new commands by stable child ID plus execution generation. |
| Child usage is rolled into the parent turn. | [onUsage](../../../src/extension.ts:4869), [usage entry](../../../src/local/usageLedger.ts:24) | Record child execution provenance before aggregating, including compaction and late reported usage. |

The broad bottleneck is the extension provider's single active conversation: histories, model, costs, pending actions, steering, connection state, and abort controllers are held together in mutable fields. Multiple independently interactive children need session-owned execution contexts. A replacement roster alone would expose these collisions.

## Native engine findings

[NativeSessionCoordinator](../../../src/engines/opencode/coordinator.ts:33) already handles meaningful native behavior: verified parent/child ownership, early-event buffering, reused-session claims, report settlement, and stopping one subtree. [NativeSessionTree](../../../src/engines/opencode/sessionTree.ts) reconciles active native sessions and drains queued work during Stop.

However, the current coordinator belongs to an active turn. Descendants are grouped into the first root delegation's display trace through `group()` and `emit()`. The engine holds root completion until native children and queued reports settle. Its public steering method targets the active root. This is not yet a durable, engine-independent session coordinator or an independently navigable session tree.

The redesign must retain verified native identity and native inbox semantics. It must not run a second built-in loop for a native child, deliver the same report twice, or confuse native launch success with child completion. Public OpenCode SDK/server URLs currently redirect to V1 documentation; the installed `@opencode/client` 2.1.4 types and runtime fixtures are the implementation contract to verify against.

## Boundaries that need deliberate redesign

- **Profiles and permission claims:** the Explore profile advertises read-only research but includes the terminal, with command behavior constrained by instructions and the approval gate. A future strict read-only mode must structurally omit arbitrary shell and unknown external mutations. “Can run verification commands” is a different capability.
- **Profile parser:** it supports a small frontmatter subset, not general YAML. A block `tools:` list is treated as absent rather than an invalid restriction. The 32-definition slice also has no catalog-overflow entry. Make unsupported restriction syntax fail visibly and separate the full profile inventory from bounded model advertisements.
- **Questions:** built-in children are structurally denied `ask_user_question`. Native children can already ask through attributed host forms. An interactive child experience needs a session-routed decision service and an explicit change to this assumption.
- **Resources:** built-in children share parent browser/download session binding. Background process creation is denied in children, while process control intentionally reaches session-wide jobs. Independent sessions need explicit process, browser, download, and checkpoint ownership or shared-resource grants.
- **Changes:** checkpoint diffs compare workspace snapshots. Under concurrent shared-checkout activity, that does not prove that one child authored every changed file. Attribution and isolation need to be designed before adding a “child changes” badge.
- **Plan and YOLO:** Plan currently denies delegation structurally. YOLO is a live grant across the active tree. Preserve these behaviors during cutover; enabling child conversations is not permission to weaken either gate.
- **Memory:** bounded UI traces are useful, but cannot be replay sources. Durable storage needs bounded paging, compaction, retention, visible truncation, and safe handling of provider-native opaque carriers.

## Research and interpretation

Claude Code documents separate-context subagents, resumable histories, background execution, forks, and direct fork follow-ups. The useful pattern is entering a worker's conversation while retaining its parent relationship. [Claude Code subagents](https://code.claude.com/docs/en/sub-agents).

Its agent view provides dispatch, peek/reply, and attach/detach for full background sessions; it explicitly distinguishes those sessions from spawned subagents. Xratu can use one session primitive with different relationships rather than reproduce those separate product categories. This is our proposed design. [Claude Code agent view](https://code.claude.com/docs/en/agent-view).

Agent teams add peer messaging and shared task coordination, with documented resumption and shutdown limitations. They are useful inspiration for later collaboration, not a prerequisite for reliable child sessions. [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams).

OpenCode's current agent documentation describes native child sessions and background reports. This reinforces the need to adapt native session semantics rather than simulate them. [OpenCode agents](https://opencode.ai/docs/agents/).

ACP separates a session's identity/history from the client displaying it and makes resume support an explicit capability. Use that separation in the engine boundary without making an ACP migration part of this release. [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup).

Research is from primary documentation. No competitor implementation is claimed to have been audited or copied.
