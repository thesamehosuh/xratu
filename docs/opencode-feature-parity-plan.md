# OpenCode integration audit and delivery plan

Status: audit with consolidated integration implementation. Originally audited against local commit
`03ba7ee`, extension 2.3.8, and installed `@opencode/client` 2.0.26.

## Product direction

OpenCode users should get the Xratu product: useful settings, capabilities,
task progress, browser access, approvals, change review, and history. Choosing
an engine should choose how the agent runs, while preserving the work invested
in the surrounding application.

Keep OpenCode's native harness for its free models. Keep credentials and native
history in OpenCode. Reuse Xratu services through explicit adapters where their
security and lifecycle guarantees can be preserved. Expose native resources
alongside Xratu-managed resources with clear ownership and actionable controls.

Success is behavioral parity for common workflows, rather than identical
internals or a promise that every runtime setting has the same semantics.

## Findings and evidence

### 1. Page replacement hides integrations that already work — highest priority

`webview-ui/src/App.tsx` replaces the entire MCP, marketplace, skills, and agent
page with `NativeConfiguration` when settings scope is OpenCode.
`webview-ui/src/components/EngineScope.tsx` supplies lists for servers and
skills, but no rows for marketplace or agents. Every native page ends with
the same setup action, including for an already configured user.

Meanwhile, `src/extension.ts::_getOpenCodeEngine` already supplies external
Xratu MCP tools and Xratu pull-request tools to OpenCode. The authenticated
loopback bridge in `src/engines/opencode/mcpBridge.ts` preserves Xratu's
existing connections, transports, proxy routing, and tool names in the display.
`OpenCodeEngine.configuration()` collapses all those tools into one server
called `Xratu`. Users cannot manage the underlying servers from this page.

Impact: the UI presents a much less capable product than the host actually
provides. Installing a marketplace server under Xratu can benefit OpenCode,
but the marketplace is replaced by a placeholder in OpenCode scope.

### 2. Reply language is implemented, then disabled by the UI — highest priority

`SettingsPage.tsx` disables all reply-language buttons for a native engine
and says OpenCode uses its own language instructions. However,
`_runOpenCodeAgent` calls `buildNativeSystemContext` with the persisted reply
language, and `OpenCodeEngine.runTurn` updates the separate `xratu.policy`
instruction entry on new and resumed sessions. `test/test-engines.mjs` already
asserts that English reaches native policy.

This is a verified UI/host mismatch, not missing SDK support.

### 3. The capability contract cannot describe the product

`src/engines/types.ts::EngineCapabilities` contains only `steering`, `rewind`,
and `localTools`. `src/engines/setup.ts::ENGINE_SETUP` separately describes
configuration, authentication, offline support, and subagents. UI branches
frequently inspect engine IDs or a `nativeEngine` boolean instead of a shared
feature descriptor.

Impact: a feature implemented in an adapter does not automatically become
available in its settings page. Blanket engine checks accumulate stale claims.

### 4. Major Xratu services never enter the native tool catalog

The current bridge source supplies external MCP and pull-request tools. It
does not supply Xratu's browser tools, `update_task_list`, skill tools, or
subagent runner. These exist in the built-in runtime through `mcp.ts` and
its executor; the OpenCode path does not call that executor.

Impact: having a browser panel or task-progress UI available does not make
those services callable by OpenCode. This requires host integration, not CSS.
Native tools with a similar purpose must be evaluated before adding duplicates.

### 5. Skills and agent files have different compatibility problems

Native skill inventory is fetched with `client.skill.list`, but Xratu's
discovery, validation, creation, editing, and enablement UI is replaced.
Discovery overlap is not evidence that all Xratu skills, disabled states,
supporting files, or bundled writing guidance have the same effect in OpenCode.

Agents are a deeper gap: native `subagent` is deliberately denied, and no
child approval/form/event lifecycle is mapped. Xratu's loader validates tools
against its own catalog; names, model IDs, restrictions, effort, and round
limits cannot be copied into a native profile without translation.

Current repository policy requires native MCP/skills to remain read-only and
native subagents to remain unavailable. Later phases below propose explicit
policy changes; this audit does not relax those boundaries.

### 6. Several shared features already exist and must be preserved

The native path already maps streaming text and reasoning, permission cards,
forms, steering delivery/cancellation, attachments, per-step usage/cost,
background shells, local display history, and session identity. Pre-prompt
shadow checkpoints run before either engine; native file restore exists,
while chat rewind is explicitly rejected.

The integration should extend these paths. Replacing the native runner or
replaying Xratu display history into it would discard existing guarantees.

### 7. Compaction, limits, and error feedback have observable gaps

The installed SDK declares `session.compaction.started`, `.delta`, `.ended`,
and `.failed`; the native event switch does not translate them. SDK
`session.compact` is available, but the adapter exposes no shared compaction
operation. Native usage events alone do not prove that the context ring
represents the runtime's effective post-compaction context.

Xratu's `maxAgentRounds` and `autoCompactThreshold` are consumed by the
built-in request path. `maxParallelSubagents` belongs to its nested runner.
They must not appear to govern native execution without an implemented mapping.

The built-in error path applies `explainError` when error explanations are
enabled; `_runOpenCodeAgent` forwards ordinary errors raw. Consequently, the
shared Explain errors preference has incomplete native behavior.

### 8. Tool aliases provide labels, but do not establish rich display parity

`engine.ts::TOOL_NAMES` aliases native read/edit/write/search/shell names to
Xratu names, while `session.tool.called` forwards native input unchanged.
Renderers such as `ToolDetails.tsx` expect Xratu argument conventions, including
`args.path`. Native output formatting may differ too. Exact affected tool
shapes need captured runtime fixtures before declaring individual renderers
broken. Normalize display data separately from native execution arguments.

### 9. Network and restore differences are real boundaries

Global proxy environment is already applied to OpenCode; bridged MCP runs
through Xratu's own connections and their routing. The Proxy page's blanket
MCP scope hint does not communicate that distinction. Native-owned MCP has
different ownership from a bridged Xratu server.

Offline mode intentionally blocks OpenCode. Xratu's file/SSRF guards do not
protect native tools. Shadow file restore does not rewind native conversation
memory. These are constraints to explain accurately, never hide by enabling
controls or injecting a prompt.

## Target experience by feature

| Surface | OpenCode today | Target |
| --- | --- | --- |
| Settings / language | Language reaches native policy; editing disabled | Shared working preference, refreshed between turns |
| Servers | One bridge row plus native inventory | Manage Xratu servers; inspect native servers; show which are available to this engine |
| Marketplace | Placeholder | Install into Xratu's existing manager and expose through the bridge |
| Skills | Native list | Useful inventory with origins and compatibility; reuse Xratu management for Xratu-owned files |
| Agent files | Unavailable | Profile diagnostics first; gated native child integration after approvals and traces work |
| Browser | Built-in service not bridged | Same Xratu browser service, session identity, approvals, screenshots, and panel |
| Tasks / plan | Xratu list tool absent | One authoritative task list and progress display, with plan-safe operations |
| Activity / tools | Shared stream, native arguments | Normalized display metadata and accurate native outputs |
| Usage / context | Native token and cost events | Preserve native accounting; expose compaction and effective-context evidence |
| Proxy | Global native route, bridged MCP routing | Explain route per resource; preserve existing routing controls |
| Errors | Ordinary native errors raw | Apply shared deterministic explanation with original detail retained |
| Changes / restore | Shadow checkpoints; files-only native restore | Preserve file restore; investigate conversation rewind separately |
| Providers | Native SDK auth separate from Xratu auth | Keep ownership; make model readiness and recovery easy to understand |
| Offline | Native execution blocked | Explicit supported-engine alternative; no false isolation claim |

## Architecture to implement

### Shared feature descriptors

Introduce one serializable descriptor consumed by host command admission and
the webview. For each feature report support (`available`, `limited`,
`unavailable`), ownership (`xratu`, `native`, `shared`), a localized reason when
needed, and supported actions. Keep runtime readiness (installed, connected,
busy, workspace, model suitability) separate from engine capability.

Derive settings scope from the selected settings engine, and execution scope
from the persisted session engine. Engine capabilities must not depend on a
model's marketing name. Model capabilities and native version support are
additional checks. The host remains authoritative when the UI is stale.

### Reuse services through an explicit native bridge allowlist

Extend the existing bridge by service, with per-session host context and
typed display events. Do not export every built-in tool or instantiate a
second general-purpose agent loop. Keep native file, shell, and provider
tools native unless a specific product requirement justifies replacement.

Every added service needs: native-to-Xratu session mapping, plan classification,
approval ownership, abort behavior, bounded results, persistence rules, and
fresh-catalog semantics. Avoid two prompts for one approval. Images must reach
both the native model and Xratu's transcript without persisting unbounded data.

The current bridge denies all calls during plan mode. Introduce per-tool
classification only when needed; unknown/external tools remain denied.
Task-list updates can be plan-safe application state without permitting file,
shell, browser mutation, or delegation. Keep independent bridge-side admission
in addition to native permission rules.

### Keep native and Xratu resources distinguishable

Shared pages list Xratu-managed resources with their real controls. Native
resources remain inspectable with source and status; use targeted setup or
recovery actions when relevant. Do not send an established user through
onboarding to edit an unrelated capability. Preserve independent settings
engine selection, drafts, scroll positions, and mounted work panels.

## Consolidated delivery: one integration PR

The settings fixes, common capability facts, MCP/marketplace management,
browser/task/skill services, native inventories, and lifecycle feedback are
being delivered together in one PR. The workstreams below retain their audit
numbering for traceability; they are not separate PRs. Native child execution,
manual compaction, native limit mapping, effective-context metrics, and
conversation rewind remain gated follow-up work. Compaction currently adds
localized runtime notices; persistent Activity entries remain follow-up work.

### Workstream 1 — correct settings that contradict implemented behavior (P0)

Enable reply-language controls for OpenCode; remove the inaccurate native
language hint. Apply shared deterministic error explanations to native errors
without losing raw detail. Correct proxy scope language for bridged MCP.

Acceptance: fa/en/auto changes reach `xratu.policy` on the next new or resumed
turn; user prose never carries host policy; Explain errors on/off works with
native provider failures. Both locales and narrow/wide layouts pass.

### Workstream 2 — establish the shared capability descriptor (P0)

Unify the existing engine/setup capability facts; migrate the affected UI and
host guards to feature checks without changing their permissions. Add tests
that assert UI actions agree with host capabilities and readiness.

Acceptance: no blanket native-engine switch controls all capability pages;
unsupported actions remain rejected by the host; stale session/scope replies
cannot enable controls for another engine.

### Workstream 3 — restore useful Servers and Marketplace pages (P0)

Keep existing Xratu server and marketplace management visible when OpenCode is
selected. Add a separate read-only native inventory. Show bridged tool counts,
connection errors, ownership, and when changes will reach the next idle turn.
Avoid presenting the internal random bridge identity as a user-managed server.

Acceptance: install a fixture server in OpenCode scope, run a tool, deny a
permission, change routing, disable/remove the server, and confirm the next
turn's catalog. Preserve all supported transports and auto-approval policy.
Plan calls, unknown session IDs, canceled turns, and wrong bridge tokens fail.

### Workstream 4 — connect Xratu browser workflows (P1)

Bridge the existing browser service using the native session's Xratu chat
identity. Reuse the browser panel, controls, approvals, path policies, and
bounded screenshot output. Preserve human/agent ownership and shutdown.
Version the new service catalog and avoid duplicate native tool selection.

Acceptance: an OpenCode task opens a page, inspects it, asks approval for an
action, obtains a screenshot, and reports the result. Cancel, denied action,
session switch, browser failure, and teardown do not leak ownership or state.
Plan mode follows the existing browser policy deterministically.

### Workstream 5 — task progress and plan handoff (P1)

First capture native tool inventory to decide whether a native checklist can
be faithfully adapted. Otherwise bridge Xratu's `update_task_list` into the
same task store and display events. Specify a native plan-to-build transition
using host admission and matching native permissions; a prompt alone cannot
authorize mutation. Keep task identity scoped to the conversation.

Acceptance: exactly one authoritative list survives streaming, cancellation,
resume, and plan-to-build handoff. The normal task UI works with both engines;
unknown tools and all prohibited mutations remain rejected in plan mode.

### Workstream 6 — useful Skills page and compatibility (P1)

Inventory discovery roots and precedence against the pinned native runtime.
Display source, validation issues, availability, and name collisions. Reuse
Xratu create/edit controls only for Xratu-owned files; keep native inventory
read-only. Confirm when edits require refresh or a new turn/session.

For Xratu-only skills, prefer documented native discovery or explicit native
skill loading when possible. If a bridge is necessary, preserve skill-relative
resources, enablement semantics, and supporting script paths; loading only a
Markdown body is not parity. Do not silently export all skills into native
configuration. Any native write support needs a separate policy-changing PR.

Acceptance: workspace/global/bundled skills, duplicates, disabled skills,
invalid frontmatter, BOM/CRLF, supporting files, and issue visibility are
covered. A skill selected in the UI actually influences the intended session.

### Workstream 7 — native events, context, and tool display (P1)

Translate compaction lifecycle and retry status; retain native accounting as
authoritative. Add optional manual compaction only through the engine adapter,
with session identity and cancellation checks. Normalize native arguments into
display-only metadata; cover edits, multi-edits, reads, search, shell exits,
web results, images, and unknown tools with captured fixtures.

Acceptance: compaction success/failure appears in Activity and context metrics
never imply reclaimed tokens without evidence. No double-counted usage on
resume. Rich file/tool details work while original execution inputs and native
call IDs remain unchanged.

### Workstream 8 — agents: compatibility specification and read-only inventory (P1)

Use the SDK's `agent.list` to populate native inventory without enabling
delegation. Show Xratu profile compatibility and concrete translation issues.
Specify tool-name/permission mapping, child model/variant identity, context
limits, round limits, concurrency, parent restrictions, approval sources,
forms, cancellation, traces, costs, and restoration.

Acceptance: unsupported profiles have explicit diagnostics; unknown tools
cannot silently produce an unrestricted or tool-less child. Current native
subagent denial remains intact until workstream 9 meets its gate.

### Workstream 9 — native child lifecycle and opt-in delegation (P2, gated)

Prefer native child sessions to preserve the free-model harness. Prove SDK
support with the pinned executable before choosing the implementation. Route
each child's approvals, questions, events, and usage to the correct parent
call; reuse Xratu's bounded observation views. Enforce recursion/tool strips,
model-specific caps, concurrency waves, and interruption semantics.

Enabling this workstream explicitly changes the repository's native-subagent policy and must
update AGENTS.md and both feature READMEs. Do not remove the deny rule merely
because native agent files exist. If native semantics cannot enforce a profile,
keep that profile unavailable with a reason.

Acceptance: parallel children, independent models, approval denial, unanswered
forms, parent cancellation, reconnect, interrupted restore, and cross-session
trace isolation pass. Loader, runner, and observation regression suites pass;
native children retain real approval gates and cannot regain stripped tools.

### Workstream 10 — limits and conversation rewind feasibility (P2)

Document which settings apply to each engine; test whether native step and
compaction controls can implement equivalent semantics before exposing them.
The installed SDK has compaction, fork, and revert APIs, which are evidence
for a feasibility investigation, not proof that Xratu rewind is supported.

For rewind, persist native message identity alongside the Xratu checkpoint and
design recovery from partial failure. Investigate conversation-only native
revert (`files: false`) while shadow git remains the sole Xratu file-restore
authority. Keep files-only restore explicit until the combined operation is
proven atomic or recoverable. Never claim chat rewind after restoring files.

## Validation and release gates

For every behavior PR run lint, both independent TypeScript checks, esbuild,
webview tests, and `test:engines`. Add targeted host regression tests and the
relevant engine/onboarding/welcome, work-surface, and lifecycle browser checks.
Capture and inspect actual built UI in fa/en at 420px and 1280px using the
shared VS Code theme fixture. Test Windows paths, BOM/CRLF, process-tree
cleanup, and custom/managed native binaries.

The parity journey is: choose free setup → open an existing chat → configure a
server from Marketplace → use it → inspect a page → track work → apply a
skill → inspect Changes and Activity → cancel/resume → restore files. The
later agent milestone adds parallel delegated work with approvals. Run each
journey against both engines with deterministic fixtures; retain a separately
authorized live free-model smoke test because fixture tests cannot prove
provider compatibility. Automated generation probes remain free-route-only.

The consolidated PR gets a user-visible version bump, automated review
triage, and Windows/macOS/Linux CI. Recheck prior native versions used by saved
sessions; new capability APIs need an explicit supported-version boundary.

Completion criteria:

- No settings control contradicts the active session's implemented behavior.
- No major capability page is a generic setup placeholder for a ready engine.
- Xratu-managed MCP/marketplace, browser, task progress, and compatible skills
  work through OpenCode with visible ownership and actionable failures.
- Approvals, plan policy, cancellation, session identity, and shadow restore
  retain their existing guarantees.
- Agent parity is complete only after the child lifecycle gate passes; offline
  isolation and conversation rewind remain accurately described until proven.

## Audit confidence and external references

This is a code and built-UI audit, with deterministic engine tests. It does not
claim a live free-provider run or complete native agent/skill compatibility.
The built webview was inspected using a mock host and the shared theme fixture;
no provider credentials were used. The original UI observations confirmed page
replacement and disabled language controls. The consolidated implementation
restores shared management and enables those controls; runtime findings and
regressions come from source and deterministic tests.

Pre-implementation baseline verification passed: `npm run lint` (0 errors, 290 existing warnings),
host and webview `tsc --noEmit`, `node esbuild.js`, `npm run build:webview`,
`npm run test:webview`, and `npm run test:engines`. These establish the current
baseline. Implementation verification additionally covers the real shared executor,
plan/service admission, native image parts, live skill disablement, browser
identity, error preferences, optional inventory failure, and both locales at
narrow/wide widths. Native child execution and conversation rewind remain
follow-up work.

Prefer the installed 2.0.26 declarations and executable fixtures when live
documentation differs. OpenCode V2 documentation supports the proposed
directions: [MCP session metadata](https://dev.opencode.ai/v2/docs/mcp-servers/),
[agent models, permissions, and child sessions](https://dev.opencode.ai/v2/docs/agents/),
and [plugin/session APIs](https://opencode.ai/v2/docs/build/plugins/). It does
not establish that Xratu's stronger restrictions already hold for native
children or that newer APIs exist in every saved runtime.
