# Xratu product redesign

This is a product and interaction proposal, not a production UI patch. Open `index.html` directly in a browser. It needs no dependencies or network access. Use the direction and page selectors to explore all 20 screens; appearance and language can also be changed. All commands, connections, installation actions, costs, model names and counts are fixtures. No action runs a tool, installs a package, edits workspace files or stores credentials.

## Recommendation

The default is a calm, empty conversation with the composer centered. The sidebar, work tabs and docked work view are closed. The standard panel-left button toggles the entire sidebar at every width. Task tabs and the side panel have separate reveal controls. The side panel hosts the same movable views as the main tabs; it is not an unrelated inspector.

Keep Xratu's familiar conversation: right-aligned user bubbles with subtle corner marks, normal assistant prose, compact tool rows and the existing composer control arrangement. In an empty conversation the centered composer stays expanded with its controls visible, including when unfocused. After messages exist, a resting composer is a 46px pill. Focusing the same textarea expands it to the familiar card, with the model picker below and mode/approval controls above. The context-window meter is hidden by default and can be enabled in Conversation settings. Expansion and collapse take 160ms; reduced motion removes the transition. In an empty chat the composer sits in the middle; after conversation starts it docks at the bottom. Pending approvals remain visible even when the input is collapsed.

The composer restores the shipping InputBar's anchored menus rather than prototype dialogs: compact Build/Plan and Ask first/Auto-approve choices; a searchable full-width model drop-up with provider, capability and reasoning controls; and BranchPicker's searchable branch list above the card. The unframed Git status line retains directory, branch and change counts. The send action uses the exact installed Lucide Send outline from InputBar. The attachment menu exposes workspace references and a local file chooser; the context menu stays absent until the meter is enabled. These operate only on fixture state, preserve the mounted draft, close on Escape/outside click and restore trigger focus. New conversation is the first sidebar action below the directory selector and above Workspace.

The three directions are optional arrangements of the same product:

- **Studio — direct a task.** Conversation is central; reveal the selected docked work view when useful. Recommended default.
- **Canvas — inspect the work.** Reveal code review beside the conversation while discussing changes. Useful in an expanded panel.
- **Control — supervise agents.** Reveal the attention queue and dock the Running agents view while managing delegated work. Useful when several things are running.

Settings is a separate destination in all three. Its category navigation contains Providers, Engines, MCP, Marketplace, Skills, Agent files, Usage, Network and General. Conversation, Changes, Activity and the other current-task views occupy the work tab strip only. The settings destination has a way back to the last work view and preserves the draft.

Work panels retain the shipping docking model: Conversation stays in main; Changes and Browser initially live in the side area; Activity, Running agents, Background, Downloads and Pull requests can be moved. Drag tabs between strips, reorder them, use the move buttons, or use Ctrl+Shift+Left/Right (mirrored for RTL). Panel nodes remain direct children of one workspace grid; moving changes placement without detaching the composer or browser iframe. The side area can collapse into a narrow icon strip and can be resized. Narrow windows expose opened work views in main. Idle tabs stay absent until activity belongs to them or the user chooses them through **+**. Activity can reveal the relevant tabs; an explicit tab-strip hide stays respected. The side rail only contains available panels, and an empty side area offers **+**.

Work views use compact toolbars without website page headings. Browser has an address/navigation row, viewport picker and an edge-to-edge local preview. Its production implementation should retain BrowserPanel's managed-frame protocol, session identity, viewport sizing and input delivery; this prototype's iframe is a static local sample.

A completed assistant response follows MessageItem and CompactSteps: a closed actions/count/duration disclosure, final prose, a Review action and changed files, then copy and timestamp. Chat cost displays and the Ask for review action are removed. Expanding tools reveals compact action rows with file/command hints and the terminal exit code. Intermediate prose folds out of the final conversation view. The footer stays absent while the response is running or awaiting approval.

The prototype's **Explore layout** control is outside the product shell and reveals the complete arrangement for comparison. It is a design-review control, not the landing experience. These layouts can become adaptive views of one product; they do not require separate feature sets.

## What was audited

- Xratu's actual built webview, driven with mocked extension messages and the repository's `installVscodeTheme` fixture. Baseline screenshots cover a live command approval in English/Persian at 420px and 1080px. Configuration and auxiliary surfaces were inspected in source, not exercised against live provider accounts.
- The existing `~/repos/t3code` checkout, commit `ec80933ac8cd02fec5c97b342462ccc9567cdb1e`. That checkout was reused without modification. This is an audit of that local revision, not a claim that it matches the latest running T3 release.
- Official Codex, Cursor and Claude Code desktop documentation. These are documented interaction references; their desktop source code was not audited. Cursor and Claude desktop are not open-source code references. OpenCode was excluded from the design direction following the user's correction.

### T3 Code source evidence

Paths below are relative to the audited T3 checkout. The prototype implements original HTML/CSS; no T3 components were copied.

| Source | Finding | Xratu implication |
| --- | --- | --- |
| `apps/web/src/index.css:101–128` | Semantic geometry includes an 8px control radius, 52px workspace bar and 46rem chat column. | Establish shared geometry before rebuilding individual pages. |
| `components/AppSidebarLayout.tsx` | Workspace navigation and settings navigation belong to a shared shell; sidebar dimensions are explicit. | Stop treating configuration as a separate visual product. |
| `components/Sidebar.tsx:1264–1335` | Working, waiting, approval, input, limited and failed are distinct states. Background work recedes; action-required work remains prominent. | Organize attention by required action, not just recency or an animated dot. |
| `components/chat/ComposerSurface.tsx` | The composer and its attachments form a coherent surface with a shared context strip. | Put the approval/question next to the place the user responds. |
| `components/chat/ComposerBannerStack.tsx` | Banners have explicit priority, expansion, keyboard focus and dismissal behavior. Activity stays attached; notices stack behind it. | Model attention and focus deliberately; do not simply stack every message. |
| `components/chat/WorkLog.tsx:32–95` | Grouped and standalone work entries share compact geometry; detail is progressively disclosed. | Give the transcript clear result, progress and evidence levels. |
| `components/chat/ComposerPrimaryActions.tsx` | Submission behavior distinguishes pending input, running work, steering/queueing and interruption. | Button meaning must match the current run state. |
| `components/DiffPanelShell.tsx:8` | Review supports inline, sheet, sidebar and embedded contexts. | Adapt review to the available width rather than shrinking desktop columns into a sidebar. |
| `components/DiffPanel.tsx:263–315` | Review selection and collapse identity are scoped to a thread and turn/source. | Preserve Xratu's checkpoint/session guards while changing presentation. |
| `components/chat/MessagesTimeline.tsx` | Following output, virtualized rows and disclosure anchors are treated as behavior. | Scroll continuity and perceived speed are part of the redesign. |

### External references

- [Codex features](https://developers.openai.com/codex/app/features) and [review](https://developers.openai.com/codex/app/review): work context and inspecting results. These URLs may redirect to the current official ChatGPT documentation.
- [Cursor's Agents Window](https://cursor.com/changelog/3-0): agent-centered workspace and switching between agent and editor contexts.
- [Claude Code desktop](https://code.claude.com/docs/en/desktop): arranged workspace panes, session details, file review and targeted feedback.
- [Cursor public repository](https://github.com/cursor/cursor): not the desktop implementation.
- [Claude Code license](https://github.com/anthropics/claude-code/blob/main/LICENSE.md): public repository availability does not make the product open source.

## Problems to solve

1. **No persistent product model.** Work surfaces, configuration overlays, engine scopes and session controls have accumulated separate navigation patterns. Users need a stable sense of workspace, current conversation and configuration scope.
2. **Attention is fragmented.** In the baseline, an approval sits in the transcript while the composer and several status messages separately report waiting. One visible decision surface should explain the exact action, source and scope.
3. **Wide space adds little utility.** The baseline expands the chat column but leaves review and task context elsewhere. Expanded layouts should help users inspect evidence beside the conversation.
4. **Configuration is a collection of features.** Providers, engine installation, native inventories, local discovery, marketplace installation and routing need task-specific layouts with a shared shell, not one generic accordion treatment.
5. **State competes with content.** Tool execution, reasoning, intermediate prose and final results need different visual importance. Keep detail accessible without giving every event equal weight.
6. **Narrow widths are a primary surface.** A 420px VS Code panel needs a complete single-column workflow and accessible page navigation. Desktop splits are enhancements.

## Three prototypes

| Direction | Structural change | Best use | Tradeoff |
| --- | --- | --- | --- |
| Studio | Conversation with optional workspace navigation and docked work view; a separate settings destination. | Default Xratu shell and configuration. | Full navigation needs a drawer at sidebar widths. |
| Canvas | Optional workspace rail and task tabs; contextual code review beside conversation; dedicated settings navigation outside the tabs. | Expanded editor panels and active code inspection. | Less suitable as the default at 420px; icon-only navigation requires clear accessible names. |
| Control | Attention and working shelves lead navigation; parent/child task roster beside conversation; configuration inspector leads the work area. | Delegation-heavy work and monitoring. | Too much structure for a simple one-agent conversation. |

All directions use a shared neutral canvas: `#181818` for the workspace, navigation and configuration surfaces, `#111111` for the familiar composer/user-message inset, `#303030` dividers and `#ededed` text. Light mode uses white across the shell. Active segmented choices retain their gray fill; sessions, tabs and subpages do not use the earlier blue-gray surface wash. Selected sessions, navigation, tabs and files use brighter/heavier text without accent stripes or underlines. Session hover uses neutral border/text emphasis, and the sidebar's Ready to review badge is removed. Studio retains the `#82dbc5` accent; Control retains its violet accent. Amber marks required decisions. Canvas is shown in light mode in the evidence; all directions support both appearances.

Typography follows the host environment: Segoe UI/system UI for Latin and Tahoma for the standalone Persian prototype. Production should retain the repository's bundled Persian face and VS Code theme tokens. The hierarchy is page titles, section headings, readable content, compact metadata. It is not a marketing page.

The initial chat-only proposal was rejected. The scope was revised to full navigation and distinct workflows across the entire product before the prototype was built.

## Page-by-page redesign

| Screen | Proposed workflow |
| --- | --- |
| Workspace | Attention queue, ready-to-review results, in-progress child work and recent conversations. This is an IA proposal; a true cross-session inbox requires host-side state work. |
| Conversation | Results and grouped execution history in the transcript; approval attached above the composer with exact command and requesting agent. Draft persists through page changes. |
| Changes | File navigation, selected checkpoint scope, readable diff, reviewed state, file feedback and explicit restore confirmation. |
| Activity | Searchable chronological evidence, separate from actionable approval controls. Return to Conversation to decide. |
| Running agents | Parent context, child status, observed trace and individual stop. Preserve call identity in implementation. |
| Background | Process inventory and live output; explicit stop and browser entry points. |
| Browser | Compact address/navigation controls, viewport picker and a full-panel local preview; movable between main and side. Production retains the managed browser frame pipeline. |
| Downloads | Active progress and pause controls separated from completed files and open-folder actions. |
| Pull requests | Linked PR inventory, checks and actionable review feedback. |
| History | Searchable local sessions with engine identity visible before resume. |
| Providers | Connections first, local runtimes and Iranian presets visible, selected-connection inspector, credentials and models in one place. |
| Engines | Clear active engine, installed alternative and installation controls. Switching explicitly starts a fresh conversation. |
| MCP servers | Searchable connection state, workspace/global source and selected-server tool inventory. Native inventory remains read-only. |
| Marketplace | Discover tools, then inspect install scope and command before adding. Prototype commands are illustrative, not installation instructions. |
| Skills | Search by task, expose source and enabled state in rows; inspect instructions on demand. |
| Agent files | Roles, source and validation states first. Invalid tool vocabulary stays visible. Descriptions and allowed tools belong in the inspector. |
| Usage | USD and IRT separated; daily spend visualization and provider detail instead of unrelated metric cards. The sample chart is a fixed USD fixture. |
| Network & proxy | Explicit automatic/custom/direct choice, resolved route and destination-level routing. Local runtime bypass stays visible. |
| Settings | Task-based groups for language, conversation, network and local data; compact controls; history deletion behind a consequence dialog. |
| First-run setup | Engine/connection choice, connection step and entry to work. Keep this separate from returning-user configuration. |

## Implementation boundaries

The HTML is a navigable design model. Search, file selection, reviewed marks, draft retention, language, appearance, approval simulation, engine-switch simulation, scope selection and several dialogs work in memory. Some secondary controls deliberately show a prototype toast; catalog filters and charts are not backed by real data. The inline lab controls are review tools and would not ship.

For production:

- Preserve the mounted transcript/composer, docking registry and local history.
- Keep chat engine identity separate from configuration-engine scope and saved-session engine identity.
- Keep secrets in VS Code secret storage and OpenCode credentials in its own SDK-managed store.
- Reuse checkpoint membership, request identity and stale-response guards. Never substitute real repository Git for shadow checkpoints.
- Do not turn read-only native inventories into editable Xratu configuration.
- Preserve deterministic plan-mode gating, approval source attribution and child call identity.
- Keep user messages physically right, arbitrary content auto-directed and code/URLs/paths LTR.
- Move prototype copy into paired production i18n keys and native strings; preserve the no-ZWNJ Persian rule.
- Prefer existing capabilities. Workspace attention across multiple sessions is a separately scoped behavior change, not something a CSS rewrite provides.

## Delivery sequence

1. Shared shell, calm entry, collapsible navigation and distinct work/settings navigation. Preserve the existing transcript and InputBar identity.
2. Rebuild Providers, Engines, MCP, Marketplace, Skills and Agent files around selection and contextual editing. Keep engine/source scope explicit.
3. Rebuild Conversation, review and decision surfaces with mounted-state preservation.
4. Apply the same system to Usage, Network, Settings and auxiliary work surfaces.
5. Add the workspace attention inbox only with a defined host state model and focused regression coverage.

Each implementation PR should include before/after English/Persian evidence, the appropriate version bump for user-visible behavior and the existing relevant test gates. No production implementation or version bump is included in this design-only delivery.

## Verification

The expanded layouts of the standalone prototype were captured in **240 states**: 3 directions × 20 screens × 2 locales × 2 widths (420px and 1440px). The matrix reported zero JavaScript exceptions and zero document/main-panel horizontal overflow. Screenshots use viewport/element captures, not stitched full-page captures of internal scroll containers. Selected desktop and narrow screenshots were inspected directly; the complete screenshot matrix remains under `output/playwright/harness-redesign`.

Twelve additional screenshots cover empty/resting, empty/focused and non-empty/focused composers in both locales at both widths. The composer revision passed 32 checks for calm entry, centering, focus/blur, retained drafts, sidebar collapse and reduced motion. The message/docking revision passed 36 focused checks for MessageItem structure, tool disclosure, footer/copy behavior, changed-file navigation, drag/drop and keyboard docking, mounted input and browser identity, compact sidebar and narrow Persian layout. Another 57 checks verify default-hidden context, activity/explicit tab availability, explicit-hide precedence, plus selection and session hover in both locales/widths. Eighteen evidence captures compare the actual extension's completed message with the prototype and show Browser in both dock positions. The prototype evidence and the 240-state matrix were refreshed after the neutral-surface, progressive-tab and stripe-removal changes. Computed selection borders/shadows were checked across that matrix; the eight actual-extension baseline captures remain unchanged. The centered, expanded empty composer was rechecked. Restoring composer dropdowns added 89 checks covering menus, search, selections, keyboard handling, draft identity, send icon, Git status and the first sidebar action, in both locales/widths. Twelve dropdown evidence captures and three current-extension reference captures supplement the refreshed layouts.

Repository checks: lint passed with 0 errors and 294 existing warnings; host typecheck, separate webview typecheck, esbuild and all webview suites passed. No extension source files changed.

The concept board was generated with built-in `image_gen`. Its prompt is saved in `image-prompt.txt`. It is exploratory imagery; use the interactive HTML for actual proposed states, labels and permission behavior. Generated art may contain invented labels or controls.
