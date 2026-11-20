# Xratu Stable-Release Readiness Audit

- **Baseline audited:** branch `fix/local-runtime-and-browser-reload` @ `ffc346b` (PR #246)
- **Date:** 2026-11-20
- **Goal:** Identify concrete blockers, bugs, security/Windows defects, UX flaws, and release/packaging gaps standing in the way of shipping a clean, final stable VS Code extension release (followed by repo cleanup before starting the standalone desktop app).
- **Read-only baseline checks:**
  - `npm run lint`: **0 errors**, 307 warnings (mostly `@typescript-eslint/no-explicit-any` debt)
  - `tsc --noEmit -p tsconfig.json`: **pass**
  - `tsc --noEmit -p webview-ui/tsconfig.json`: **pass**
  - `test:nls`, `test:farsi-orthography`, `test:release-workflow`, `test:protocol-drift`, `test:vsix-contents`: **all pass**

---

## Executive Summary

The core architecture is **already release-grade** — plan-mode gating, `sanitizePath`, shadow-git user-repo isolation, OAuth token management, archive extraction security, download atomicity, OpenCode MCP bridge security, host/webview protocol alignment, and `fa`/`en` i18n parity are all solid. **No architectural rewrites or broad refactors are needed.**

What remains is a bounded set of concrete bugs heavily concentrated in:
1. **Windows runtime behavior** (the primary target platform)
2. **VS Code webview sandbox differences** (not exercised by standalone Playwright Chromium)
3. **LLM streaming & compaction edge cases**
4. **Release, packaging & documentation drift**

Summary counts: **2 Blockers (P0)**, **17 High (P1)**, **22 Medium (P2)**, plus **3 Release/Packaging items (R1–R3)** and a **Post-Release Repo Cleanup Checklist**.

---

## P0 — Release Blockers (Must Fix)

### B1. Windows host freeze: synchronous `powershell.exe` on every mutating tool call + 50ms lock-contention spin loop
- **Files:**
  - `src/sessions/ownership.ts:35, 38` (`processIdentityStatus`, `captureIdentity`)
  - `src/sessions/resources.ts:20-34` (`WorkspaceWriter.run`)
  - `src/extension.ts:5005-5006` (wraps every mutating parent tool call in `workspaceWriter.run`)
  - `src/tooling/processIdentity.ts:145-160, 186-193` (`cp.execFileSync('powershell.exe', ...)`)
  - `src/tooling/backgroundJobs.ts:287-298, 310-311` (`adoptDetachedJob` getters)
- **Failure scenario:**
  - Every mutating tool call (`write_file`, `edit_file`, `run_terminal_command`, `extract_archive`, etc.) runs inside `WorkspaceWriter.run()`, which instantiates a fresh `FileCoordinatorStore` / `SessionFileOwnership` and calls `captureIdentity(process.pid)`. On Windows (`win32`), `captureIdentity()` synchronously runs `cp.execFileSync('powershell.exe', ...)` with a 10s timeout — blocking the VS Code extension host event loop for ~0.5–2s on **every single mutating tool call**.
  - When two VS Code windows contend on the same workspace, `WorkspaceWriter.run()` retries every 50ms (`resources.ts:24-30`), calling synchronous `processIdentityStatus(previous.identity)` → `cp.execFileSync('powershell.exe', ...)` in a tight loop, completely freezing the extension host and blocking Stop/Cancel.
  - Separately, `adoptDetachedJob`'s `status` / `finishedAt` getters (`backgroundJobs.ts:287-311`) call synchronous `processIdentityStatus` every 10s on Windows whenever adopted background jobs are listed/rendered.
- **Suggested fix:** Cache `selfIdentity` asynchronously once per host process (matching `src/downloads/ownerLock.ts:14-25`), add an async `processIdentityStatusAsync()` used by `SessionFileOwnership` and `adoptDetachedJob`, and increase/back off the cross-window retry interval.

### B2. MCP Server Editor permanently traps users inside the VS Code webview sandbox (`window.confirm`)
- **Files:**
  - `webview-ui/src/components/CapabilitiesPage.tsx:469, 472, 482-488, 1182, 1331`
  - `webview-ui/src/components/SidePanel.tsx` (`sibling.inert = true`)
- **Failure scenario:** VS Code webviews run inside sandboxed iframes without `allow-modals`, so Chromium/Electron silently blocks `window.confirm(...)` and immediately returns `false`. Once a user opens "Add server" or "Edit server" and modifies any field (`draftDirty === true`), clicking Cancel, clicking `X`, clicking the backdrop, or pressing `Escape` runs `if (draftDirty && !window.confirm(t('mcpDiscardConfirm'))) return;` and aborts closing. Because `SidePanel` sets `inert` on the rest of the app, the user is **permanently trapped in the modal** until they manually undo every edit, save a valid server, or reload VS Code. (Not caught by Playwright E2E because standalone Chromium allows `window.confirm()`.)
- **Suggested fix:** Replace both `window.confirm()` calls (`lines 469, 483` — confirmed the only `window.confirm`/`alert`/`prompt` calls in `webview-ui/src/`) with an inline discard confirmation state inside the drawer.

---

## P1 — High Severity (Fix Before Shipping)

### Extension Host, Lifecycle & Windows Compatibility

#### H1. `deactivate()` does not await process/server teardown — orphaned processes on Windows/reload
- **Files:** `src/extension.ts:416, 8655, 8809-8823`, `src/externalMcp.ts:180-191`, `src/browserController.ts:118`, `src/engines/opencode/server.ts:47-52`, `src/tooling/processTree.ts:97-116`
- **Failure scenario:** `deactivate()` awaits `downloadShutdown?.()` only. It calls `void externalMcpInstance?.stopAll()` without `await`, relies on synchronous `context.subscriptions` (`disposeBrowser()`) for fire-and-forget `void this._engines.dispose()` (OpenCode server + MCP bridge) and `this._browser.dispose()` (Playwright Chromium), and never calls `_cancelActiveRequests(true)` or `_cancelOAuthFlow()` (which holds the `127.0.0.1:1455` loopback HTTP listener). On Windows, the extension host exits before async `killTree` (`taskkill /pid <pid> /T /F`) finishes, leaking `opencode.exe`, stdio MCP servers, Chromium, file locks, and port `1455`.
- **Suggested fix:** Await `Promise.allSettled([...])` for `externalMcpInstance?.stopAll()`, `provider.disposeEngines()`, `provider.disposeBrowserAsync()`, `_cancelOAuthFlow()`, and `_cancelActiveRequests(true)` inside `deactivate()`.

#### H2. Windows drive-letter casing & symlink mismatches break `edit_file` dirty buffers, recursive `list_files`, search paths, and OpenCode resume/stop
- **Files:**
  - Built-in tools: `src/mcp.ts:1062, 1070-1071, 1073-1075, 1105, 1123-1124, 1156-1157, 1165-1166`
  - OpenCode adapter: `src/engines/opencode/engine.ts:87, 259-260, 288, 493`, `src/engines/opencode/sessionTree.ts:23`, `src/extension.ts:847`
- **Failure scenarios:** VS Code's `uri.fsPath` lowercases Windows drive letters (`c:\...`) and does not resolve symlinks/junctions, while `fs.realpathSync()` and OpenCode 2 (Bun/OS canonicalization) emit uppercase `C:\...` (and `/private/...` on macOS):
  1. `edit_file` (`mcp.ts:1074`): `path.resolve(doc.uri.fsPath) === path.resolve(fullPath)` is `false` on Windows, so `openDoc` never matches — `edit_file` bypasses `WorkspaceEdit`, reads stale disk content instead of dirty open editor buffers, and overwrites disk directly (data-loss risk).
  2. Recursive `list_files` (`mcp.ts:1105, 1123-1124`): `root = sanitizePath(...)` resolves symlinks while line 1123 computes `path.relative(workspaceRoot, file)` against the unresolved `workspaceRoot`, failing to match `gitWorkspaceFiles(workspaceRoot)` and returning `{ entries: [] }`.
  3. `grep_search` & `glob_search` (`mcp.ts:1062, 1070-1071, 1156-1157, 1165-1166`): `line.startsWith(rootPrefix)` fails on Windows drive-case or symlink differences, returning full absolute host paths.
  4. OpenCode session & child ownership (`engine.ts:87, 259, 288, 493`, `sessionTree.ts:23`, `extension.ts:847`): raw `===`/`!==` comparisons break Turn 2 resume (`engineWorkspaceMismatch`), cause `NativeSessionTree.owns()` to miss active children during Stop and `stopChildShells()`, and reject direct native child follow-ups.
- **Suggested fix:** Use a shared canonical path helper (`realpathSync` fallback + `.toLowerCase()` on `win32`) for all equality/containment/prefix checks.

#### H3. Double-escaping `&amp;` in `_sanitizeHtml` corrupts every Markdown link with query parameters
- **Files:** `src/sanitizeHtml.ts:127-169`, `src/extension.ts:6719-6724`
- **Failure scenario:** `markdown-it` emits standard HTML-escaped attributes (e.g. `href="https://example.com/?a=1&amp;b=2"`). `_sanitizeHtml` extracts `attrVal` verbatim and passes it through `escapeHtml(attrVal)` a second time (`lines 162, 164, 166`), producing `href="https://example.com/?a=1&amp;amp;b=2"`. Every Markdown link with `&` query params (GitHub filters, docs, search URLs, YouTube) decodes to literal `&amp;` and breaks on click; `&` in `title`/`alt` also double-escapes.
- **Suggested fix:** Decode standard HTML entities in `attrVal` once before validation and re-escaping (or avoid re-escaping already-escaped entities).

#### H4. Missing `webviewView.onDidDispose` + unhandled `postMessage` rejections wedge `confirmBanner` & leak listeners
- **Files:** `src/extension.ts:1650-1698, 2024, 5863-5946`
- **Failure scenario:** `resolveWebviewView` never registers `webviewView.onDidDispose` and never pushes `_webviewSubscriptions` into `context.subscriptions`. Disposing/moving/reloading the view leaves stale `this._view`, leaked `onDidChangeActiveTextEditor` subscriptions, and unsettled `_pendingNotifies` / `_localApprovalResolvers` / `_localDecisionResolvers`. In addition, `notifyBanner` (`1662-1670`) and `confirmBanner` (`1690-1696`) call `this._view.webview.postMessage(...).then(...)` with no `.catch`, causing unhandled rejections on disposed views, bypassing native toast fallback, and leaving `confirmBanner` permanently pending (wedging `_restoreRequestActive = true` in `_restoreCheckpointAt` at line 2024).
- **Suggested fix:** Register `webviewView.onDidDispose` to clear `this._view`, dispose `_webviewSubscriptions`, and resolve/reject pending interactive prompts safely; add rejection handling to `notifyBanner`/`confirmBanner` `postMessage` calls.

#### H5. Background job completion notices (`system: true`) corrupt `_history` turn indexing and can trigger unprompted LLM turns
- **Files:** `src/extension.ts:1026-1030, 4571-4572, 5139, 5396, 7859-7863, 8056-8089, 8254-8265`, `src/local/localAgent.ts:349-358, 835`
- **Failure scenario:** Background job completion notices are queued into `_localSteerQueue` with `{ text, system: true }`, but `system` is never checked anywhere.
  1. When drained inside `runLocalAgent` (`extension.ts:5139`), the notice becomes a `steer_user` event and pushes a normal `role: 'user'` row to `this._history` (`line 8058`) even though the live webview rendered no user bubble. Every completed background job shifts `userIndex` by `+1`, so edit-message, regenerate, and per-turn checkpoint restore target the **wrong turn**, and on reload `[Background job ...]` renders as if the user typed it.
  2. If a notice remains in `_localSteerQueue` when a turn finishes (`8074-8089`) or interrupts (`8254-8265`), it is pushed as a visible `role: 'user'` row and on success launches an unprompted `steerCarry` agent turn (spending user tokens, contradicting comments at lines 4535 and 7855).
- **Suggested fix:** Check `system` when draining and carrying `_localSteerQueue`: mark system notices `hidden: true` (excluded from user-turn indexing/rendering) and never trigger a post-turn `steerCarry` run solely for `system: true` items.

#### H6. Partial shadow-git init permanently bricks checkpointing for that workspace
- **Files:** `src/shadowGit.ts:238-267`
- **Failure scenario:** In `ensureRepo()`, `git init --bare` (`line 254`) creates `dir/HEAD` before `read-tree --empty` and `commit --allow-empty` run (`lines 259-266`). If seeding fails once (timeout, transient Windows AV lock, reload mid-init), `dir/HEAD` exists as an unborn ref. On every subsequent call, `fs.existsSync(headPath)` (`line 240`) returns `true`, skipping seeding forever. All future `createCheckpoint`/`diffCheckpoint`/`listCheckpoints` calls fail with `bad default revision 'HEAD'` until globalStorage is manually deleted.
- **Suggested fix:** Verify `rev-parse --verify HEAD` (or a seeded commit check) rather than `fs.existsSync(headPath)`.

#### H7. Cold-start Explorer/Palette attachments silently dropped + infinite re-processing loop on invalid files
- **Files:** `src/extension.ts:2117-2132, 7725-7727, 8708-8732`, `webview-ui/src/App.tsx:1964`, `webview-ui/src/components/InputBar.tsx:992-1037`
- **Failure scenarios:**
  1. **Host cold start:** `attachUrisPublic()` calls `await this.ensureView()` and immediately posts `attachmentsFromHost`. `ensureView()` resolves as soon as `resolveWebviewView` sets `this._view` — before React mounts and sends `webviewReady`, silently dropping files attached via Explorer right-click or Command Palette before opening Xratu.
  2. **Webview loop/restart:** `App.tsx:1964` passes an inline arrow `onInjectedAttachmentsApplied={() => setHostAttachments(null)}` that is in `InputBar.tsx:1037`'s `useEffect` deps. If a file fails normalization (`normalized.length === 0`), line `1018` returns early **without calling `onInjectedAttachmentsApplied`**, leaving `hostAttachments` non-null so every subsequent `App` render re-runs the effect and re-parses the broken file forever. Valid async PDF/WebP conversions also cancel and restart on any parent re-render.
- **Suggested fix:** Queue cold-start host attachments behind webview readiness; in `InputBar`, hold the callback in a ref and always call `onInjectedAttachmentsApplied` when processing finishes (even when `normalized.length === 0`).

#### H8. OpenCode server restart race permanently orphans `opencode serve` processes
- **Files:** `src/engines/opencode/server.ts:16, 44, 47-52`
- **Failure scenario:** `dispose()` sets `this.child = undefined; this.connection = undefined;` before `child1` emits `'close'`. If anything calls `connect()` before `child1`'s `'close'` fires (e.g. `NativeShellMonitor`'s 1s `refresh()` timer or a retry), `start()` spawns `child2` and stores `this.child = child2; this.connection = promise2`. When `child1`'s `'close'` fires, line 44 runs `this.connection = undefined; if (this.child === child) this.child = undefined;` — wiping `child2`'s `this.connection` unconditionally (same in `.catch` at line 16). The next `connect()` spawns `child3` and overwrites `this.child`, permanently orphaning `child2`.
- **Suggested fix:** Guard `this.connection = undefined` with `if (this.child === child)` in `'close'` and check the local promise reference in `connect()`'s `.catch`.

---

### Built-in Agent Runtime, Compaction & Security

#### H9. Overly strict SSE stream validation crashes valid streams on common OpenAI-compatible & Gemini servers
- **Files:** `src/local/streamValidation.ts:69, 79, 82, 83, 86, 151` (plus `48, 51, 53, 54, 102, 124, 138, 145, 153-160`), `src/local/wireAdapters.ts:544-547`
- **Failure scenarios:**
  1. `streamValidation.ts:79`: `delta.tool_calls !== undefined` crashes with `ModelStreamError` on `"tool_calls": null` (emitted on normal text chunks by vLLM, LiteLLM, SGLang, Groq, FastAPI proxies).
  2. `streamValidation.ts:82, 86`: Continuation chunks for streaming tool calls commonly emit `"id": null` (vLLM/Groq), `"id": ""` (OpenRouter/DeepSeek/Google OpenAI-compat), or `"arguments": null`, aborting every tool call.
  3. `streamValidation.ts:151`: Google native trailing candidate with `content: { role: 'model' }` (no `parts`) passes `candidate.content != null` and crashes on `array(content.parts)`.
  4. `wireAdapters.ts:544-547`: `typeof reason === 'string'` treats `finish_reason: ""` (Go-based OpenAI proxies) as stream end, crashing the next chunk with `'Model returned content after completion.'`; `Object.keys(delta).length` rejects trailing usage chunks carrying `delta: { content: "" }` or `{ role: null, content: null }`.
- **Suggested fix:** Use `!= null` for optional fields; allow `call.id === ''` on delta chunks (still enforce non-empty `id` at batch finalization); require `typeof reason === 'string' && reason.length > 0` for `streamEnded`; check for non-empty delta values before rejecting post-completion deltas.

#### H10. Chat Completions parallel tool calls without `call.index` collide on slot `0` and throw
- **Files:** `src/local/wireAdapters.ts:572-584`
- **Failure scenario:** `const index = Number(call.index ?? 0)` causes index-less parallel tool calls (Google's shipped `/v1beta/openai/` preset and some Ollama/compatible endpoints) to collide on slot `0`, hitting `current.id && current.id !== call.id` (`line 582`) and throwing `ModelStreamError('Model changed a tool call identity during streaming.')`.
- **Suggested fix:** When `call.index == null`, allocate a new slot whenever `call.id` is present and differs from the active slot's `id`.

#### H11. Second compaction & forced overflow recovery silently fail once `HISTORY_TRUNCATION_MARKER` is at `messages[1]`
- **Files:** `src/local/contextWindow.ts:265-282`, `src/local/compaction.ts:502-510`, `src/local/localAgent.ts:401-438, 753-773`
- **Failure scenario:** Once a first compaction places `{ role: 'user', content: HISTORY_TRUNCATION_MARKER + summary }` at `messages[1]`, `compactMessages` starts at `start = 1`, drops only the marker (`end = 2`), and advances `start` to `2`:
  - **Proactive pre-request compaction (`force = false`, `gateRatio = 0.72`):** At `start > 1`, `contextWindow.ts:273` breaks immediately because `0.72 < 0.90`. `dropped` contains only `[HISTORY_TRUNCATION_MARKER]`. `compactWithSummary` strips the marker → `droppedTurns = []` → returns `null` (without committing `elideOldToolResults`), and `localAgent.ts:419` falls through to mechanical `boundHistory`, dropping real turns **unsummarized** (`unsummarizedDrop = true`).
  - **Forced overflow recovery (`force = true`):** If elision or dropping the marker brings `total <= target`, the loop exits with `dropped = [HISTORY_TRUNCATION_MARKER]`. `localAgent.ts:760` re-attaches the identical summary and retries the exact same overflowing prompt, burning the single recovery attempt.
- **Suggested fix:** Skip an existing `HISTORY_TRUNCATION_MARKER` at `messages[1]` before counting the first real dropped turn so `start === firstRealTurnIndex` acts like `start === 1`.

#### H12. Google native synthetic tool-call IDs reset to `google-call-0` every round, colliding across rounds
- **Files:** `src/local/wireAdapters.ts:1866-1872` (downstream: `src/local/compaction.ts:534-563`, `src/local/historyRows.ts:216-267`, `src/extension.ts:1263, 4928, 7232-7242, 8229-8242`)
- **Failure scenario:** `let syntheticId = 0` resets on every HTTP request, producing `google-call-0` in Round 1, Round 2, Round 3, etc. Cancel/reload recovery sees `google-call-0` already in `answered` from Round 1 (leaving stuck spinners on reload); active compaction replay collides `compactedToolCalls` vs `compactedKeptToolCalls`; subagent observations and edit diff snapshots overwrite earlier rounds.
- **Suggested fix:** Use a per-process monotonic counter or short UUID prefix (`google-call-${randomUUID().slice(0, 8)}-${i}`); `toGoogleBody` (`wireAdapters.ts:1645`) already strips synthetic IDs on the wire.

#### H13. `compactActiveTurn` breaks Anthropic extended-thinking block ordering & Google role alternation
- **Files:** `src/local/compaction.ts:557-568`, `src/local/wireAdapters.ts:687-695, 1609-1639`
- **Failure scenario:** `compactActiveTurn` splices `{ role: 'assistant', content: summary, compactedToolCalls }` right before `recent[0]` (the latest tool-calling assistant turn):
  - **Anthropic Messages (`wireAdapters.ts:692-693`):** Merges both assistant rows into `[{ type: 'text', text: summary }, { type: 'thinking', ... }, { type: 'tool_use', ... }]`. Anthropic rejects a thinking-enabled assistant turn not starting with `thinking`/`redacted_thinking` (HTTP 400 → matches `REASONING_REJECT_RE`, silently disabling thinking or failing the turn).
  - **Google Gemini (`wireAdapters.ts:1638`):** When `recent[0]` lacks `providerBlocks`, line 1638 pushes a separate `{ role: 'model', parts }` without merging into the preceding `role: 'model'` checkpoint (unlike line 1615) → Gemini HTTP 400.
- **Suggested fix:** In `toMessagesBody`, avoid prepending a `text` block ahead of `thinking`/`redacted_thinking` blocks (or place checkpoint as a `user` context turn); in `toGoogleBody:1638`, merge consecutive `role: 'model'` entries as line 1615 does.

#### H14. Download destination validation

Review download destination validation before release. Keep reproduction details in the maintainer security workflow.

---

### Webview UI & RTL

#### H15. `byokError` banner "Fix" button opens an empty/unloaded Credentials page
- **Files:** `webview-ui/src/App.tsx:1858-1868` (compare `1584-1591`, `1762-1768`), `src/extension.ts:2141-2170, 3386-3401`
- **Failure scenario:** After `xratu.setupCompleted === true`, normal boot does not send `savedCredentials` or `oauthState` until `{ type: 'openCredentials' }` is requested. Clicking **"Fix"** on the chat `byok-hint err` banner sets `screen = 'credentials'` locally without sending `{ type: 'openCredentials' }` (or setting `settingsEngine = 'xratu'`). In a fresh window where Providers wasn't previously visited, `CredentialsPage` opens empty (`savedCredentials === []`, `oauthState === null`).
- **Suggested fix:** Post `{ type: 'openCredentials' }` and set `settingsEngine` appropriately from the Fix button handler.

#### H16. `settingsEngine` latches once & `EngineScope` switcher is never rendered
- **Files:** `webview-ui/src/App.tsx:116, 353-359, 1398, 1407, 1453, 1619-1622`, `webview-ui/src/components/EngineScope.tsx` (exported & styled, never imported)
- **Failure scenario:** `settingsEngine` initializes from `engineState.active` only once (`settingsScopeInitialized.current`). Switching the active chat engine via the composer picker or Engines page leaves sidebar **Providers** and **Agent files** pointing at the old engine. Worse, clicking **"Manage Xratu agent files"** (`App.tsx:1620`) flips `settingsEngine` to `'xratu'` with no switcher UI to return to OpenCode's native Providers/Agents/MCP/Skills inventories.
- **Suggested fix:** Either render `EngineScope` on scoped settings pages as intended or sync `settingsEngine` cleanly with engine switches plus a clear return path.

#### H17. Composer engine picker dropdown opens mirrored on the opposite side of the window in Persian (`fa` RTL)
- **Files:** `webview-ui/src/components/Dropdown.tsx:90-91, 161-167, 197`, `webview-ui/src/components/InputBar.tsx:1263`, `webview-ui/src/styles/workSurface.css:218, 781`
- **Failure scenario:** `Dropdown` portals its `position: fixed` listbox directly under `.app` (`dir="rtl"` in Persian), so `insetInlineStart` maps to physical `right`. However, `Dropdown.tsx:90-91` computes `rtl` from `getComputedStyle(trigger).direction === 'rtl'`. Because `.composer-engine-picker` explicitly has `dir="ltr"` inside `.composer-actions`, `rtl` evaluates `false` and sets `insetInlineStart: rect.left` — which `.dropdown-portal` applies as `right: rect.left`, detaching the menu to the opposite side of the screen.
- **Suggested fix:** Compute `rtl` from the portal container (`getComputedStyle(portalHost).direction === 'rtl'`), not `trigger`.

---

## P2 — Medium Severity (Triage With Astra — Quick Wins vs Skip)

### Security, Privacy & Platform Robustness
1. **Unredacted proxy credentials in Webview UI + broken auth/IPv6 URLs in `ProxyPage` & `proxyDetect`:**
   - `src/extension.ts:6148-6150` posts raw `resolved.url` / `systemProxy` without `redactProxyUrl()` (leaking `user:pass` on screen and into `XRATU_WEBVIEW_LOG`).
   - `webview-ui/src/components/ProxyPage.tsx:52-62` (`splitProxyUrl`) truncates `http://user:pass@proxy:8080` to `http://user` and `http://[::1]:7890` to `http://[`, corrupting `xratu.proxyUrl` on save.
   - `src/proxyDetect.ts:279, 341, 344` passes bracketed `[::1]` to `net.connect` (`ENOTFOUND [::1]`) and omits `formatHost` in `probeController`.
2. **Offline mode leaves OpenCode server & native OAuth polling running when active chat engine is `xratu`:**
   - `src/extension.ts:4171-4184` only disposes `_openCodeEngine` when `this._activeEngine === 'opencode'`. OpenCode's server and `_nativeConnect` OAuth poll (`629-636`) can stay alive after switching chat to `xratu` and bypass `networkSignal` over loopback. Call `await this._resetOpenCodeEngine()` unconditionally when enabling Offline Mode.
3. **Windows `refreshLock.ts` lacks `rmSync` retries & has `staleMs` (120s) > `timeoutMs` (60s):**
   - `src/oauth/refreshLock.ts:127-128, 163, 172, 201` (used by both `OAuthTokenManager` and `LocalSessionStore`). A transient Windows Defender/AV `EBUSY` on `rmSync` strands the lock directory, forcing 60s `LockTimeoutError` failures for up to 2 minutes. Add `{ maxRetries: 5, retryDelay: 50 }` and consider a shorter `staleMs` or PID liveness check for session locks.
4. **Timed-out stdio MCP connects bypass `killTree`:**
   - `src/externalMcp.ts:383-392` calls `built?.transport?.close?.()` instead of `closeState(...)` on connect failure/timeout. The SDK's `StdioClientTransport.close()` signals only the `cmd.exe` shim, orphaning `npx`/`uvx` grandchildren on Windows.
5. **`PullRequestStore` lock & delivery recovery can permanently wedge (`prStoreBusy`):**
   - `src/pullRequests/store.ts:38-56`, `src/pullRequests/service.ts:39-48`: a crash between `open(lock, 'wx')` and `writeFile(pid)` leaves a 0-byte lock where `alive` stays `true` forever; crashes holding `${lock}.recovery` have no stale recovery; bare `process.kill(pid, 0)` breaks on PID reuse. Reuse `withDirectoryLock`.
6. **Sanitizer defense-in-depth bugs + broken `test/test-sanitizer.mjs`:**
   - `src/sanitizeHtml.ts:48, 66, 128`: `JAVASCRIPT_URI_RE` misses ASCII tabs/newlines inside scheme (`java\tscript:`) and `vbscript:`; `ALLOWED_ATTRS['svg']` lists uppercase `'viewBox'` while `attrLower` is lowercased, so `viewBox` is always stripped.
   - `test/test-sanitizer.mjs:16-118, 150-164, 268-271`: tests a diverged inline copy, overwrites `assertRemoved` on call 1 (silently skipping later tag assertions), and passes its `java\tscript:` test spuriously.
7. **Unbounded/unsanitized read in `reviewChangesFlow` + >16 MB historical files misreported as empty:**
   - `src/extension.ts:1906, 1914` reads full files before checking `REVIEW_MAX_CHARS` and without `sanitizePath`.
   - `src/shadowGit.ts:614-622` + `src/workSurface.ts:84-88`: `readCheckpointFile` returns `null` on `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` (>16 MB), which `workSurface.ts` maps to `''` instead of `kind: 'tooLarge'`.
8. **Shadow `index.lock` 60s lockout after timeout + unbounded shadow-repo disk growth:**
   - `src/shadowGit.ts:147-150, 200, 309-330`: a timed-out 20s `git add --all` kills `git.exe`, leaving `index.lock` that `clearStaleLocks()` refuses to delete for 60s even while holding `_serialized()`. Shadow repos under `globalStorageUri/checkpoints/` also have no retention cap, GC, or cleanup on `_clearAllSessionsNow()`.
9. **OAuth ID token `nbf` check has zero clock-skew tolerance:**
   - `src/oauth/providers/openaiChatGpt.ts:92`: `claims.nbf > now` rejects logins when a user's Windows clock is even 1s behind server time. Add standard 60s leeway.

### Broken / Incomplete Feature Flows
10. **Parallel tool batch silently drops tool images:** `src/local/localAgent.ts:952-966` skips `toolResultContent` and omits `images` from `toolResult` whenever a round runs via `runOne()` (`task` alongside an image-returning tool).
11. **Failed downloads cannot be cancelled/cleaned up from Downloads UI:** `src/downloads/types.ts:7-12` returns `['restart']` only for `'failed'`, trapping `.part` files, destination paths, SecretStorage URLs, and pending slots (`MAX_PENDING = 20`). Fix: return `['restart', 'cancel']`.
12. **`editDiffFromArgs` missing current `edit_file` (`edits: [{ old_text, new_text }]`) schema:** `src/editDiff.ts:39-83` — "Open diff in editor" fails (`openDiffFailed`) on restored sessions once `_editSnapshots` is empty.
13. **`isKnownSkillsPath` omits `.claude/skills` roots:** `src/skillsHost.ts:26-53` vs `src/skills.ts:300-306` — Open/Reveal/Delete silently fail for discovered `<workspace>/.claude/skills` and `~/.claude/skills` entries.
14. **OpenCode "Reinstall" cannot repair a corrupted binary of the current `OPENCODE_VERSION`:** `src/engines/opencode/installation.ts:120-122` skips replacing `binary` whenever `fs.access(binary)` succeeds, looping on version check failure.
15. **OpenCode Ask-first approval diff for `write_file` shows "deletes entire file":** `src/engines/opencode/services.ts:31-40` maps `filePath/oldString/newString` but omits `content -> new_content` needed by `_buildDiffPreview` (`src/extension.ts:8294-8312`).
16. **Model-supplied nonexistent `sessionID` in native `subagent` permission check aborts the entire OpenCode turn:** `src/engines/opencode/engine.ts:491-494` does not catch `isSessionNotFoundError(error)` on `client.session.get`.
17. **Deleting the last Ollama model leaves stale model selected & cached:** `src/extension.ts:4210-4217` fails `/v1` base-URL comparison (`http://localhost:11434/v1` vs `http://localhost:11434`), and `src/local/modelMetadata.ts:324-332` returns `null` for HTTP 200 `{ models: [] }`, causing `_fetchModels` (`extension.ts:5657`) to fall back to stale `_modelCatalog`.
18. **`xratu.attachFromExplorer` ignores Explorer multi-file selection:** `src/extension.ts:8723-8732` only reads arg 1, ignoring `selectedUris` (arg 2).
19. **Persian PDF stack-overflow risk + `pdfClient.ts` document leak:** `webview-ui/src/components/InputBar.tsx:197` spreads unchunked UTF-8 bytes into `String.fromCharCode(...)` (48k–72k+ args on 24k-char Persian PDFs → `RangeError`); `webview-ui/src/pdfClient.ts:63-116` never calls `loadingTask.destroy()` / `doc.destroy()`.
20. **Message Copy buttons bypass host clipboard bridge:** `webview-ui/src/components/MessageItem.tsx:2190-2198` calls `navigator.clipboard.writeText` directly (swallowing errors) instead of `postMessage({ type: 'copyToClipboard' })`, failing silently in Linux/Remote/unfocused webviews.

### i18n, Copy & UI Polish
21. **Missing i18n keys & hardcoded host English:**
    - `'oauthBadResponse'` (`src/extension.ts:623, 634, 653`) does not exist in `webview-ui/src/i18n.ts` — renders literal `"oauthBadResponse"` in OpenCode OAuth UI.
    - `setupOwnershipXratu`, `gitCheckoutFailed`, `sessionDeleteFailed` (`src/extension.ts:4235, 6103, 7124`) exist in webview `i18n.ts` but are missing from `src/uiStrings.ts` (raw keys in native toast fallbacks).
    - Hardcoded English in `src/extension.ts:8716-8717` (`xratu.attachFile` dialog) and `src/extension.ts:8380` (`Path is outside the workspace: ...`).
22. **Broken/misleading UI copy & unflipped RTL icon:**
    - `webview-ui/src/components/PullRequestsPanel.tsx:42-50` + `webview-ui/src/i18n.ts:1547, 3045` (`prEmptyHint`): empty state instructs users to paste a GitHub PR URL into an input box that does not exist.
    - `webview-ui/src/cost.ts:15-19`: hardcodes `toLocaleString('fa-IR')` + `تومان` regardless of locale, leaking Persian digits/text into English (`en`) Usage charts and tooltips.
    - `webview-ui/src/components/CredentialsPage.tsx:1167`: OpenCode OAuth cancel button uses `t('engineCancel')` ("Cancel installation" / "لغو نصب") instead of `"Cancel"`.
    - `webview-ui/src/components/BrowserPanel.tsx:126`: Go button renders hardcoded `<ArrowRight>` instead of the locale-flipped `Forward` icon already defined on line 115.

---

## Release, Packaging & Documentation Readiness

### R1. Version / Tag / Release Notes / CI Gate Mismatch (Must Resolve Before Tagging)
- **Version drift:** `package.json` is `"3.0.1"`, latest git tag is `v2.4.3`, and `.github/release-notes/v3.1.0.md` exists (no `v3.0.0.md` or `v3.0.1.md`). Pick one final stable version and align `package.json`, the git tag, and `.github/release-notes/<tag>.md`.
- **`.github/workflows/release.yml` gaps at the audited baseline:** The tag workflow runs the host and webview type checks and webview unit tests before packaging. Pull request CI also runs lint, host tests, and browser tests.
  - Never verifies `package.json`'s `"version"` equals `${RELEASE_TAG#v}` — tagging `v3.1.0` with `package.json` at `3.0.1` silently publishes `xratu-v3.1.0.vsix` carrying manifest version `3.0.1`.
  - Omits `HUSKY: '0'` (which `.github/workflows/ci.yml:27` sets to prevent `npm ci` prepare failures), `npm run lint`, and `npm run test:host` (including `test:vsix-contents`).
  - Publishes only to GitHub Releases — VS Code Marketplace publishing (`vsce publish`) is manual; remember to upload or wire it deliberately.
- **Open Dependabot PRs:** PR `#241` (`@vscode/vsce` `4.0.0 → 4.1.0`) fails `test:vsix-contents` across Ubuntu/Windows/macOS (`vsce ls --no-dependencies` exits 1) — do not merge `#241` as-is. Triage passing PRs `#229`, `#230`, `#231`, `#244` (merge or close) before freezing.

### R2. Massive Double-Bundled Shiki & Unpruned `playwright-core` Bloat (High-ROI Optional Fix)
Measured on `xratu-3.0.1.vsix` (**41.4 MB uncompressed / 9.1 MB VSIX**):
- `dist/extension.js` is **12.8 MB minified** and `dist/webview-ui/index.html` is **13.3 MB**. Both `src/markdownRender.ts:11` and `webview-ui/src/highlight.ts:11` import from the full `'shiki'` barrel, pulling all 200+ `@shikijs/langs` (~8.4 MB, including COBOL, ABAP, Wolfram), all ~50 themes (~1.4 MB), and oniguruma WASM (~623 KB — blocked by webview CSP) into **both** bundles, even though Xratu only uses 2 themes (`github-dark`, `github-light`) and ~45 languages. Every sidebar open parses a 13.3 MB single-file HTML document.
- `esbuild.js:45` copies the entire `playwright-core` tree (~14 MB unpacked), shipping ~5+ MB of unused `types/*.d.ts` (2 MB), `lib/vite/{traceViewer,dashboard,recorder,htmlReport}`, and `lib/tools/skills`.
- Also add `dist/pdf.worker.min.mjs` and `dist/node_modules/playwright-core/package.json` to `needed` in `test/test-vsix-contents.mjs:130` to guard against accidental runtime asset stripping.

### R3. Documentation, Notices & Marketplace Metadata Drift
- **Contradictory YOLO default:** `README.md:76` and code (`src/extension.ts:948, 1317`) have **YOLO enabled by default**, while `docs/guide.md:153-154, 272-273` still states every edit/command requires approval by default.
- **Stale navigation & removed settings:** `docs/guide.md:355, 361` references removed `Settings → Servers & skills → Skills`; `SECURITY.md:40-41` references removed SearXNG/Brave settings and an old README "Privacy" section name.
- **Stale third-party notices:** `THIRD_PARTY_NOTICES.txt:41` lists OpenCode client `2.0.30` (`package.json` ships `2.1.4`) and omits several bundled runtime packages (`shiki`, `pdfjs-dist`, `markdown-it`, `lucide-react`, `react`, `react-dom`, `ws`, `cross-spawn`, `@modelcontextprotocol/sdk`).
- **Marketplace metadata:** `package.nls.json:3` (`ext.description`) does not mention free OpenCode models; `package.json` lacks `bugs`, `homepage`, `qna`, and a `CHANGELOG.md`.

---

## Explicitly Safe to Defer (Skip to Avoid Scope Creep)

- Unconditional `vscode.workspace.createFileSystemWatcher('**/*')` at activation (`src/extension.ts:8780`).
- `UsageLedgerStore` fixed `.tmp` filename without cross-window lock (`src/local/usageLedger.ts:416-421`).
- Wrap-up round missing 401/5xx retry (`src/local/localAgent.ts:1105-1190`); Anthropic `xhigh` `max_tokens` clamp (`src/local/wireAdapters.ts:790`); Chat `REASONING_CONTENT_REJECT_RE` one-shot guard (`wireAdapters.ts:481-487`).
- Dead `onRegenerate` prop wiring (`webview-ui/src/App.tsx:1228`), unused `fa.resultTag` key (`i18n.ts:929`), `ChildSessionsPanel` Enter-to-submit (`ChildSessionsPanel.tsx:139`).
- Chunked UTF-8 stdout decoding (`src/tooling/backgroundJobs.ts:666`, `src/pullRequests/github.ts:27`).
- `_setupComplete` write ordering edge case (`src/extension.ts:680-690`).
- `src/proxy.ts:193-199` bare IPv6 `noProxy` split; `src/providerIdentity.ts:47-50` `localhost:8080` → `llamacpp` mapping.
- 307 `@typescript-eslint/no-explicit-any` lint warnings.

---

## Areas Audited & Confirmed Solid

- **Security invariants:** `src/paths.ts` (`sanitizePath` + Windows drive-relative + symlink guards), `src/tooling/toolPolicy.ts` (complete plan-mode & subagent stripping), `src/archives/archive.ts` (zip-slip/bomb/Windows reserved names/atomic rollback), `src/engines/opencode/mcpBridge.ts` (loopback bind, 256-bit Bearer token, Origin CSRF block, parent-only tool denial), `src/sessionApproval.ts` (shell composition block, root-only trust), `src/extension.ts` webview CSP (strict nonce, `default-src 'none'`).
- **Core subsystems:** `src/oauth/` token refresh & JWKS verification, `src/pricing.ts` & `src/local/usageLedger.ts` currency isolation, `src/local/localSessionStore.ts` atomic Windows rename retry & replay repair, `src/downloads/` hard-link publication & SecretStorage URL isolation, `src/engines/opencode/installation.ts` SHA-512 verification, `src/browserController.ts` URL/offline filtering, `src/sessions/coordinator.ts` serialized command queue & receipt idempotency, `webview-ui` single-file CSP/font/Shiki-JS/PDF.js-worker pipeline, `toolMeta.ts` complete tool coverage, and `dockLayout.ts`.

---

## Post-Release Repo Cleanup Checklist (After Tagging Stable, Before Desktop App)

1. **Local workspace clutter:** Delete 7 root `.vsix` files (`xratu-3.0.0.vsix`–`xratu-3.1.2.vsix`, ~63 MB) plus local `test-results/`, `output/`, `dist-tests/`.
2. **Tracked repo artifacts:** Delete tracked AI Studio leftover `metadata.json`; decide whether to delete or archive `docs/design/` (75 files, 5.3 MB).
3. **Git hygiene:** Delete stale local branches (58 total, ~50 merged/squash-merged), prune 5 stale worktrees (`git worktree prune` + remove `xratu-warning-error-layout`), and close/merge the 5 open Dependabot PRs. (`.git` is 172 MB largely due to `assets/brand/` video/GIF history — leave history alone and start the desktop app repo fresh.)

---

## Recommended Execution Order (For Astra's Review)

1. **PR A — Blockers + Host/Windows/OpenCode Lifecycle:** `B1`, `H1`, `H2`, `H4`, `H6`, `H8` (+ quick wins `P2.2`, `P2.3`, `P2.4`, `P2.14`, `P2.15`, `P2.16`).
2. **PR B — Built-in Runtime, Compaction, Security & Tools:** `H3`, `H5`, `H9`, `H10`, `H11`, `H12`, `H13`, `H14` (+ quick wins `P2.1`, `P2.6`, `P2.9`, `P2.10`, `P2.11`, `P2.12`, `P2.13`, `P2.17`).
3. **PR C — Webview Sandbox Trap, UI Flows, RTL & Copy:** `B2`, `H7`, `H15`, `H16`, `H17` (+ quick wins `P2.18`, `P2.19`, `P2.20`, `P2.21`, `P2.22`).
4. **PR D — Release Prep:** `R1`, `R3`, and optionally `R2` (`shiki/core` + `playwright-core` trim).
5. **Tag & Ship** → **Post-Release Repo Cleanup**.
