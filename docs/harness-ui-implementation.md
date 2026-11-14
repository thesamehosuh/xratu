# Approved workspace UI implementation

Reference: `docs/design/harness-redesign/index.html`, its interaction code, gallery,
audit and preview captures. The original design artifacts are preserved.

## Mismatch checklist

- [x] Layout: calm conversation, centered empty composer, whole-sidebar collapse,
  first-position New conversation action and separate Settings destinations.
- [x] Spacing and type: 57px workspace bar, 218px navigation, 700px conversation
  measure, compact work toolbars and responsive inventory/inspector columns.
- [x] Color and selection: neutral theme-derived surfaces; heavier selected text;
  no selection stripes, active work-tab/file underlines or session surface wash.
- [x] Icons: existing Send and neutral Stop, familiar panel-left collapse, real
  engine/provider marks and localized accessible names.
- [x] Interaction: original permission/model/branch/attachment controls; 160ms
  composer transition with reduced-motion support; context meter opt-in.
- [x] State: mounted textarea/transcript/browser, retained selection and drafts,
  a single saved panel arrangement, explicit tab hiding.
- [x] Conversation: compact completed tools, actionable approvals/questions,
  copy/time footer, removed chat costs and Ask for review action.
- [x] Pages: Providers, Engines, MCP, Marketplace, Skills, Agent files, Usage,
  Network, General, Appearance, History, Workspace and every work panel.
- [x] Responsiveness/localization: English/Persian, narrow/wide and light/dark
  matrix; RTL navigation placement and short-panel scrolling corrected.
- [x] Final regression run and screenshot comparison.

## Changes requested during implementation

Studio, Canvas and Control were removed for this version after review. The work
surface keeps one saved panel arrangement. Users open panels through + or the
sidebar and move, reorder and resize them directly. Keyboard docking and narrow
window access remain available, and Reset layout returns to the calm default.
The last saved layout carries over without applying any retired preset.

Appearance uses the same 680px measure, grouped preference rows and aligned
controls as General Settings. App theme can follow VS Code or stay Dark
independently. Eight tappable accent circles offer Teal, Blue, Violet, Amber,
Rose, Neutral, White and Graphite, with a selected checkmark, named tooltips and
RTL-aware arrow-key navigation. Accent colors apply to actions, focus, selection
and the sidebar, engine and welcome brand marks; error and diff colors retain
their meaning.
It also offers the VS Code theme picker, interface font and text size, independent
conversation and code sizes, conversation width, message spacing and reduced motion, with a live preview
and reset. Closed, validated preferences persist in webview state without
replacing docking or draft state. Welcome keeps its original typography and
layout. Saved Dark applies during startup too, and host-rendered code blocks
use the shared local highlighter so editor-light token colors remain readable.
The SVG mask is quoted so the bundled data URL renders the outline correctly.
Dark mode supplies its own foreground and shell background, preventing black
brand labels and an exposed white toolbar strip over a light editor theme.

Default conversation text remains 14px and code 13.5px. English uses the VS Code
interface font; Persian retains the bundled Vazirmatn face. Sidebar navigation, project/session titles and primary controls share the default
14px interface scale, with 17px navigation icons and at least 40px rows. Interface
size can be changed independently to 12, 14, 16 or 18px. These choices do not alter
the conversation text-size preference.
Font stress checks reproduced a stale textarea height after switching to 18px
(21px of overflow for a short draft), a fixed-height collapsed input and a
leftover row gap that misaligned its actions. The same textarea now remeasures
on typography, font loading and width changes; its resting height and action
centers follow the selected size. Conversation font also applies to the draft.
Code size now reaches narrow fenced blocks, detailed tool output, diffs and
background logs. Form labels retain the interface scale, and the MCP Enabled
chip grows to fit its glyphs instead of retaining a 20px fixed height.
Source line gutters also reserve enough character width for every displayed
line number, keeping four- and five-digit numbers aligned at larger code sizes.
Text actions use the locale-aware line height so Persian glyphs are not trimmed.

General settings now has searchable preferences, compact conversation controls,
and a keyboard-accessible history confirmation. Settings search also finds option
values and reveals advanced matches. The sidebar hover target spans each row.
Segmented controls have no filled track; only the selected choice has gray fill.
The default welcome page retains the shipping layout and typography; an explicit
accent or Dark choice also applies there.

Subpages follow the approved list/inspector structure. Providers and native
connections use the same compact connection-dialog geometry. Engines shows real
provider/model/connection facts and native installation details. Its neutral
controls follow the prototype: Manage providers, arrow + Switch engine, Configure,
and the Installation pair Verify path / Reinstall. Switching still creates a
fresh conversation through the existing engine command; reinstall uses the
managed, verified installer. Maintenance/removal stays available on demand. MCP and Skills
retain source filters, actual enabled/error states and contextual actions. Search
and source filters select details from the visible results; a hidden result cannot
leave stale actions in the inspector. Marketplace uses separate catalog cards.
History groups conversations into dated lists with saved engine/model identity.

Usage follows the approved summary/chart/table hierarchy: USD and toman totals,
input/output counts, daily stacked bars and a provider table. The full prompt is
reported in the summary; the provider table separates uncached input and cache
hits. Currency totals remain separate. Period, model, provider, cost/token and
rate-editing controls still use the actual ledger. Proxy places destination
routing beside the detected-connection inspector, with editable bypasses and
actual local proxy discovery below the destination list. The original
Xratu → proxy → provider connection diagram is restored. Filled teal actions
use dark ink in dark themes and white in light themes, including nested labels.
Retry connection uses the error foreground at rest and on hover. Attachment chips
use a neutral surface for their secondary text. Connection failures render inside
the provider dialog, and its security note shares one compact row with Connect.
The welcome form keeps its existing layout.
Filled actions switch ink and fill together. Disabled actions use a neutral
surface. A frame-by-frame routing regression catches the former gray-on-color
transition during draft, hover and saved host-echo changes, in both locales and
widths under light, dark and independent Dark themes.
Usage reserves space above the plot and rounds the visible top bar segments.
Session scope uses quiet Project / Everywhere choices and a search icon that
opens a focused field; Escape clears and closes it. The top toolbar no longer
contains Tools or Settings actions. Changes keeps guarded native-editor access
and omits the leftover Ask for a review action.

## Production boundaries

- Workspace attention uses the current session's real approvals, questions,
  agent observations and processes. History uses the real local index, now with
  saved engine/model metadata. A cross-session attention inbox is not fabricated.
- Browser uses the managed frame/input/session pipeline. The prototype's static
  iframe, sample site and fixed statuses are not shipped.
- Downloads offer the manager's supported resume/retry/cancel operations. Mock
  New download/Pause/Open folder controls are not added without host support.
- Provider models are shown only when the available inventory belongs to the
  built-in engine. Native configuration and credentials retain their own scope.
- MCP tools come from the current cached discovery inventory. A changed config
  hides stale tool names; page inspection does not trigger discovery.
- Proxy exposes the supported global policy, web-search policy and per-MCP
  overrides. The prototype's additional provider/download per-destination
  selectors are fixtures; global routing and local bypasses remain real.
- Usage retains model-level ledger detail, unknown/zero-cost states and cache
  accounting. Its examples differ from the prototype's fixed provider totals.
- Credentials retain their existing editing surface and native SDK ownership.
  Existing approval, checkpoint, cancellation and network boundaries stay intact.

## Evidence and validation

Local visual artifacts: `output/playwright/approved-ui/` and
`output/playwright/refinements/`. The latter adds populated conversation, changes, agent, background and approval states, provider search/Iranian/local/error
states, and Appearance preferences in both themes/locales/widths: 168 new
viewport captures across the eight combinations. The eight before captures
come from the unchanged base revision, built separately. The after matrix uses
the shared `installVscodeTheme` fixture and real host message shapes. Screenshots
are viewport captures, not stitched internal-scroll captures.

The interactive comparisons are `output/playwright/approved-ui/comparison.html`
and `output/playwright/refinements/gallery.html`.
The current palette gallery is `output/playwright/appearance-colors/gallery.html`;
`output/playwright/sidebar-legibility/comparison.html` shows the sidebar before
and after the size adjustment. The palette matrix adds 160 viewport captures,
including brand labels, monochrome actions and code over both editor themes.
It includes prototype/implementation and before/after pairs, with narrow Persian
and light-theme examples. The screenshot matrix covers open menus, retained input
selection, explicit tab hiding, workspace placement, approvals, failures, completed
tools, dialogs and every destination. A second set of populated Usage states
covers both recorded cost and token-only usage.

Initial implementation validation (Linux):

- `npm run lint`: 0 errors, 294 existing warnings.
- Host `tsc --noEmit -p tsconfig.json`: passed.
- Webview `npx tsc --noEmit -p webview-ui/tsconfig.json`: passed.
- `node esbuild.js` and `npm run build:webview`: passed.
- `npm run test:webview`: all suites passed, including paired i18n/Farsi checks.
- Complete browser sweep: 460 passed and 16 manual capture checks skipped.
  Eight tests still used the previous navigation path; those were updated and
  passed in the targeted runs below. No failing assertion remains unaddressed.
- Theme/provider/onboarding verification after the navigation fixes: 55 passed.
- Final compact-footer, Appearance, attachment, lifecycle and welcome run:
  34 passed, including all eight theme/locale/width combinations.
- Research navigation verification: 8 passed.
- The full sweep includes all work-surface, engine and transcript suites.
- Host suites passed: work-surface, engines, session-store, MCP tool images,
  browser (9), downloads (44), subagent loader, runner and observation, and
  OpenCode coordinator.
- `git diff --check`: clean.

Latest appearance and font refinement validation (Linux):

- All five required checks passed again: lint (0 errors, 294 warnings), both
  independent TypeScript projects, host build and all webview suites. The
  standalone webview build also passed.
- Font stress matrix: 32 passed, covering 12/18px text, 12/16px code, both
  fonts, both locales, 420/1440px, and light/dark. Each covers empty/focused,
  collapsed, streaming, approval, question, tool, completed, settings and dialog
  states, plus viewport reflow and retained draft/caret/browser identity.
- Large-code Changes and Background checks: 4 passed across locales/widths.
- Full work-surface, approval-card, background, agent-observation and transcript
  scroll suites: 176 passed after the font fixes.
- App, typography and docking preservation: 155 passed during the sizing pass.
- Palette/destination/reset checks: 21 passed; eight palettes retain contrast,
  brand outlines and saved state, including Dark over a light editor theme.
- Theme contract: 32 passed. Engine/onboarding checks: 41 passed.
- Routing contrast/provider refinements: 33 passed, including 12 checks that
  sample every animation frame through disabled, draft, hover and saved states.
  The regression failed against the previous build and passed after paired
  ink/fill updates and neutral disabled surfaces.
- Accent/onboarding/welcome checks: 22 passed after the primary-action fix.
- Host work-surface (9), engines, subagent observation, loader and runner passed.
- Final `git diff --check`: clean.

Font captures are in `output/playwright/font-extremes/`; the stress cases inspect
actual code, glyph bounds and live controls rather than relying on preview prose.

Browser checks use the built extension bundle, the repository's shared VS Code
fixture and mocked/replayed host messages. Live credentials and model requests
were not used. Windows/macOS CI and an installed VS Code package were not run in
this local pass.

The remaining differences from the prototype are the production boundaries
listed above and the requested General/Appearance pages and original welcome.
The final screenshot pass checks material layout and interaction differences;
production data, engine identity and native capabilities remain authoritative.

References consulted during the earlier harness comparison:
- [Claude Code VS Code interface](https://code.claude.com/docs/en/vs-code)
- [Codex review flow](https://developers.openai.com/codex/app/review)

The repository prototype and recorded corrections govern the implementation.

## Installed-build polish follow-up

This pass addresses the issues reported after installing the first 3.0.0 build:

- Providers: account sign-in is a compact section near the top. Browser/device-code progress, saved accounts, reconnect, account selection and sign-out retain their real host messages. The provider search has one border; saved connection icons derive their border from the chosen accent.
- Plan usage: account identity, recorded token totals, input/output and model shares replace the older account block. These are local measurements; the Manage usage link remains the destination for actual subscription limits. References were the local T3 Code `ProviderAuthenticationSection`, `UsageLimits` and sidebar components.
- Settings: short dropdowns use viewport space rather than the containing preference card's height. Proxy has a full-row neutral hover and Clear history has a red hover.
- Typography: the selected interface font applies to navigation, settings, controls and chat. Code size remains independently configurable. Defaults remain unchanged.
- Skills: the entire row selects its skill and focuses the corresponding keyboard-accessible name control; toggles retain their separate action.
- Tabs: + opens a focus-trapped popup, with panel descriptions and an Already open state. Closing it preserves the mounted transcript, composer, draft and selection. Existing saved placeholder tabs remain compatible. Hidden tab bars occupy zero height and do not paint labels over their content.
- Workspace: Changes, Activity, Agents, Background, Browser, Downloads and Pull requests remain discoverable and actionable when idle, above recent conversations.
- Navigation: the sidebar can be resized by pointer or keyboard, with a persisted 200–360 px width and double-click reset. Compact session rows use their full width for the title and reveal rename/delete on hover or keyboard focus; per-row dates, paths and model metadata are removed.
- Sessions: the current session is clickable without reloading it. Session changes now reset and replay the transcript in the mounted webview rather than assigning new webview HTML. Panel placement, opened panels, active views and browser/transcript nodes survive; per-session drafts, checkpoint/file state, approvals and usage still follow session identity. Unfinished onboarding stays on its setup path.
- Composer: autosizing observes the stable outer container rather than the textarea width animated by horizontal padding. The dimensions share the same 160 ms curve and reduced-motion behavior.

Evidence is under `output/playwright/installed-polish/`: the previously installed bundle provides before images, and the real built webview supplies English/Persian, 420/1440 px, light/dark after images, including all authentication states, the add-provider form, Skills, Workspace, the panel picker and plan usage.

The reported “Location plugins did not finish activating” message has not been located in Xratu source, VS Code logs, the installed managed OpenCode binary, or the local T3 source. That initial attribution was later resolved through upstream reports after the user identified the conversation surface; see the native-startup recovery pass below.

Follow-up validation:

- Required lint, host and webview TypeScript checks, esbuild and all webview suites pass. Lint has 0 errors and 294 existing warnings.
- Work surface + polish browser run: 131 passed, including the new reset/replay protocol and preserved transcript/browser nodes. The final production VSIX bundle passes all 18 dedicated polish checks, including pointer resizing, saved widths and all accent borders.
- Font extremes, Engines, onboarding and Welcome browser run: 81 passed. App and OAuth coverage also passed in the broader run; obsolete blank-tab fixture assumptions and hidden reset-focus behavior were corrected before the clean final work-surface run.
- Host work-surface, engine, session-actions, session-connection, session-approval, session-store, native coordinator and managed browser suites pass. Source-extracted session adoption verifies one reset/replay, no webview HTML assignment, retained startup behavior and unchanged serialized adoption guards.
- Persian orthography passes (399 files); the Arabic-letter search-normalization regex now uses Unicode escapes while preserving its behavior.
- Updated 3.0.0 VSIX installed locally with the VS Code CLI. The installed extension host and webview files match the packaged build by SHA-256. Reload Window is needed to activate the replacement in an already running window.

The plugin-message attribution was resolved in the later native-startup recovery pass below. Live use in the installed VS Code window and Windows/macOS execution still require confirmation beyond the mock/replay and local host suites.

## Usage dashboard, session actions and native startup recovery

The final Usage pass changes the page structure, rather than restyling the previous account card. Tokens and Cost share period navigation, filters, an activity chart and a switchable model/provider breakdown. ChatGPT has its own recorded 30-day view with account identity, a disjoint token breakdown and model shares. Its aggregate is never presented as a remaining subscription allowance. Pricing edits and mixed USD/Toman accounting remain available; currencies are not converted or added together. A refresh action requests fresh host data. Model rows rank by tokens or by the chart's selected currency, depending on the view.

The references were T3 Code's UsagePage, UsageShareBar and UsageLimits, plus the [OpenAI usage dashboard documentation](https://help.openai.com/en/articles/10478918-reviewing-api-usage-and-costs). No additional analytics, external credentials, telemetry or fabricated quotas were introduced. New copy has paired English/Persian entries. Neutral surfaces and the user's accent/font continue through each view.

Session rename/delete controls now center on the row using logical 50% placement rather than a fixed top offset. Browser regression checks measure both the buttons and their SVGs against the row's center in both locales, themes and widths.

The previously unassigned plugin message is now traced to OpenCode: [startup activation timeout report](https://github.com/anomalyco/opencode/issues/61443) and [session resume race](https://github.com/anomalyco/opencode/issues/57204). “Location” refers to OpenCode's location-scoped plugin activation. Slow authentication refresh is one reported trigger, not a confirmed cause of this user's incident. Xratu now retries only HTTP 503 reads containing that exact startup message, with a bounded backoff and the original cancellation signal. Other failures and mutations are not retried. A catalog-read barrier precedes native session/bridge mutations. The regression server verifies recovery, cancellation, finite exhaustion, unaffected 401/unrelated 503 failures, and exactly one native session creation and prompt. Existing native permission/coordinator behavior remains covered.

Before/after and view-state screenshots are under `output/playwright/usage-redesign/`, taken from the real bundle with the shared VS Code fixture. A native shared-browser review also caught and corrected a leftover plan-metrics style that stacked the new breakdown and suppressed its share bar.

Final validation for this pass: all five required checks pass; lint has 0 errors and 294 warnings. The Usage/App/subpage/polish browser run passes 62 checks, engine/onboarding/Welcome passes 45, and focused work-surface browser coverage passes 3. The production VSIX passes all 8 Usage/hover matrices. Host engines, native coordinator and work-surface suites pass, as does Persian orthography (400 files). The updated 3.0.0 build is installed in local VS Code and its host/webview files match the package by SHA-256. Reload Window is required to activate it in the current window. Live provider startup delay was reproduced by a controlled HTTP server, rather than deliberately slowing or modifying the user's actual authentication.

## Interface size and session follow-up

The interface font family selector stays. A separate 12/14/16/18px interface-size
preference now scales sidebar labels, composer controls, settings, inventory rows
and auxiliary pages together. Conversation and code sizes remain independent.
The default primary control size is 14px; metadata uses a small, bounded step
down. Existing preferences without the new property retain the default.

Proxy hover spans its preference group. Skills rows have no unhighlighted gaps.
Agent files and the Workspace recent-conversation heading share their surrounding
content's center. Session action buttons inherit the hovered row's surface;
delete confirmation wraps inside the sidebar, including at 18px in Persian.

Add connection begins with the existing searchable provider control, followed by
the credential form. Entering an HTTP(S) endpoint in that search selects Custom
provider and fills the base URL. Account authentication remains available below.
No credential-storage or native authentication ownership changed.

The composer engine name opens the shared compact dropdown. Switching calls the
existing host engine-selection action and starts a fresh conversation; it stays
disabled during execution or engine operations. Reopening a truly unused chat
keeps the selected engine and model. Conversations with history, pending turns
or a native session ID retain their original engine identity. Deleting the
active chat reuses an existing unused chat; deleting the last empty chat leaves
an unsaved conversation rather than immediately recreating a persisted one.
Cancellation, serialized transitions and stale-workspace checks still gate these
operations. Regression tests cover empty-chat reuse, deletion, selected-model
preservation, stale lookup rejection and existing native-history adoption.

Verification for this pass uses an isolated copy and separate loopback ports.
During recording, the promotional-video agent's shared preview assets, browser
sessions, processes and installed extension were left untouched. Final packaging
and installation follow the user's confirmation that recording has finished. The evidence gallery is
`output/playwright/interface-size/gallery.html`: English/Persian, 420/1440px,
light/dark, interface sizes 12 and 18, engine menus, deletion, Agent files and
custom endpoints. Earlier installed-build captures remain linked for comparison.

All five required checks pass (lint: 0 errors, 294 warnings), along with the
webview, session-actions, session-connection, session-approval, engine and
work-surface host suites. Persian orthography passes across 401 files. The
34-check focused browser matrix passes. The broader App/engine/onboarding/
Welcome/work-surface run passed 186 checks and caught two 420px model-label
clipping failures introduced by the engine control. Narrow conversation panels
now omit redundant CPU/brain icons and tighten gaps/padding without changing
text size or removing controls. Both failing cases and both wide counterparts
pass after that correction; the full 8-case interface matrix is rerun against
the corrected build. The mock Changes responder also follows replacement
checkpoint request IDs, preserving the production stale-response guard.

No unresolved material mismatch was found in these follow-up states. An already running VS Code
window needs Reload Window after installation to activate this follow-up.
Windows/macOS execution and live provider authentication remain outside this
Linux browser/mock verification.
