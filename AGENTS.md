# Xratu

Open-source AI coding assistant for VS Code. Bring your own key (BYOK) or
point it at a local runtime (Ollama, LM Studio, vLLM, llama.cpp). Every agent
loop, tool, approval, and history store runs entirely inside the extension
host, on the user's machine.

## Repo layout

The repo IS the extension — single-product, flat layout (no wrapper dir).

```
src/            extension host (TypeScript, bundled by esbuild — no type checking)
  local/        THE agent runtime: localAgent.ts (OpenAI-compatible loop),
                localModelClient.ts (runtime probing), localSessionStore.ts
                (history on disk)
  mcp.ts        built-in tool definitions + executor + plan/YOLO gating
  externalMcp.ts user-configured MCP servers (mcp__<server>__<tool>)
  webTools.ts   web_search / fetch_url (SSRF-guarded)
  shadowGit.ts  checkpoints (SHADOW git — never the user's repo)
  taskList.ts   "the list IS the plan" task tooling
webview-ui/     React chat UI (vite build, SEPARATE tsconfig project)
test/           node test suites (webview bundle, host-side logic)
assets/         brand assets (assets/brand) + bundled skills (assets/skills)
.github/        CI (type-check ×2, build, tests) and release workflow
```

## Contributing

- **Never push directly to `main`.** Short-lived branches (`feat/`, `fix/`,
  `chore/`) → pull request → CI green → squash-merge. The PR is the review
  artifact; `main` must always build and pass CI.
- **Conventional commits** (`feat:`, `fix:`, `chore:`, `docs:` …) — the
  changelog and release automation depend on them.
- Version bumps in `package.json` happen in the PR that changes user-visible
  behavior, not retroactively.
- Small, scoped PRs. One logical change per PR; mechanical moves/deletions
  get their own PR, separate from behavior changes.
- Every PR gets reviewed (automated reviewers are installed on this repo) and
  every finding must be triaged — fix it or reply with a reason — before
  merge. Green CI alone is not enough.
- Do not commit secrets, `.env` files, or machine-specific paths.

## Verification — run before claiming done

```bash
node_modules/.bin/tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p webview-ui/tsconfig.json   # SEPARATE project — host tsc does NOT cover it
node esbuild.js
npm run test:webview
```

CI runs exactly these on both ubuntu and windows, plus the host-side test
suites. Skipping the webview tsc step is the classic CI-only failure — never
skip it.

For packaging: `npm run package-vsix`. For interactive development:
`npm run compile` + F5 via `.vscode/launch.json`.

Host-side pure logic (path guards, parsers, protocol shapes) goes in
testable modules with node test suites — precedent: `test/test-endpoint-guard.mjs`
(run after `npx tsc -p . --outDir out`; npm script per suite). Security-
relevant heuristics (e.g. `endpointGuard.ts`) ALWAYS get a regression test.

## Webview UI inspection — screenshot the real UI before/after visual work

Never judge webview UI from CSS alone; drive the built bundle in a real
browser and LOOK at it:

1. Build: `npm run build:webview`, then serve it:
   `node test/e2e/serve.mjs dist/webview-ui 4173` (same server the Playwright
   e2e suite uses).
2. Drive it like `test/e2e/app.spec.ts` does: `addInitScript` a mock
   `acquireVsCodeApi` (records outbound messages), then post
   `FromExtensionMessage` envelopes at the page via
   `window.postMessage(msg, '*')` — `showChat`, `showWelcome`,
   `openCredentials`, `openSettings`, `mcpState`, `skillsState`, etc. (shapes
   in `webview-ui/src/types.ts`). No VS Code needed.
3. Inject the `--vscode-*` custom properties the webview expects (the
   standalone page has no VS Code theme): define the set used by
   `theme.css` with Dark Modern-ish values, or everything renders on
   transparent/white.
4. Screenshot each page state at SIDEBAR width (~420px) AND wide, in both
   `fa` (RTL) and `en` — RTL breaks differently than LTR.
5. CAVEAT: `fullPage: true` screenshots stitch artifacts into pages with
   internal scroll containers — content looks clipped when it isn't. Verify
   suspected clipping with a viewport screenshot after
   `scrollIntoViewIfNeeded`, or by comparing `getBoundingClientRect` up the
   ancestor chain (an `overflow: hidden` ancestor only clips if
   `scrollHeight > clientHeight`).

## Non-negotiable rules

- **WINDOWS-FIRST — consider Windows compatibility in EVERY change.** This is
  a Windows-first product; POSIX-only assumptions are bugs even if they
  compile. Checklist: build paths with `path.join` (never string-concatenated
  `/`); spawn processes via `cross-spawn` (resolves `npx`/`uvx` `.cmd` shims)
  and kill process TREES with `killTree()` (`taskkill /T /F`), never a bare
  `child.kill()`; tolerate UTF-8 BOM + CRLF when parsing user-editable files;
  no `~` expansion or POSIX-only paths.
- **No secrets in the repo. Ever.** Model + provider credentials live in VS
  Code secrets storage; `CredentialsPage.tsx` is the single editing surface.
- **Never weaken security behaviors** without an explicit discussion in the
  PR description:
  - `webTools.ts` SSRF guards (`validatePublicUrl`), including the
    deliberate `198.18.0.0/15` fake-IP allowance and the known, accepted
    DNS-rebinding TOCTOU (validated DNS ≠ connected DNS; the real fix is IP
    pinning across every redirect hop — don't "simplify" the guard instead).
  - `sanitizePath()` (`src/paths.ts`) on every file-tool path.
  - `_sanitizeHtml` for webview HTML — extend `ALLOWED_TAGS/ATTRS`
    deliberately, never loosen globally.
  - Checkpoints are SHADOW-git (`shadowGit.ts`) — never `git add`/commit in
    the USER'S repo.
  - Terminal tool: security boundary = the approval gate, NOT a shell
    blocklist; only irreversible system-destruction patterns are hard-denied
    client-side.
  - Plan mode: mutating tools are dropped/denied deterministically
    (`mcp.ts::MUTATING_TOOLS` + `getLocalToolDefinitions({plan: true})`),
    external MCP tools included — never reduce this to a prompt hint.
- **Keep changes minimal and scoped; match surrounding style.** No drive-by
  refactors, no comment churn.

## i18n — every user-visible string goes through the system; NO hardcoded UI text

- Source of truth: `webview-ui/src/i18n.ts` — EVERY key needs BOTH a `fa`
  and an `en` entry (the `en` map is type-checked against `fa` keys).
- Keys resolve at RENDER time. Never call `t()` at module scope (constants,
  PRESETS arrays) — it freezes the locale; use `labelKey`/`hintKey`-style
  overrides resolved inside the component.
- Host → webview errors post i18n KEYS, not text:
  `{ type: 'error' | 'composerError', valueKey, params? }`. Webview resolves
  via `tf(valueKey, params)` / `tOrRaw()` — raw backend/provider text
  (e.g. `err.message`) passes through unchanged, so forwarding provider
  messages raw is fine. New host error = new key pair in `i18n.ts`.
- Native VS Code surfaces (toasts when the webview can't render, QuickPicks,
  host-rendered HTML like the code-copy button) use `src/uiStrings.ts`
  (`ui()`, `setUiLocale()`). Keys MUST mirror their webview i18n names; locale
  syncs from the persisted `xratu.locale`.

## RTL / LTR — direction is locale-driven, never hardcoded

- `dir` is set ONLY on the root `.app` div in App.tsx
  (`locale === 'fa' ? 'rtl' : 'ltr'`). Do NOT add `dir="rtl"` to inner
  pages/components.
- Code, diffs, file paths, model names, URLs, numbers → `dir="ltr"`;
  arbitrary content (chat bubbles, tool args) → `dir="auto"`.
- Directional icons flip by locale: back buttons use
  `getLocale() === 'fa' ? <ArrowRight/> : <ArrowLeft/>`.
- CSS is RTL-safe (logical props / flex auto-flip); don't introduce
  `margin-left`/`padding-right`/`left:` in shared components.
- New agent tools need BOTH a `TOOL_LABELS` entry (MessageItem.tsx) and a
  `TOOL_ICONS` entry, with their fa/en strings in `i18n.ts`.

## Extension build gotchas

- Host bundle builds via esbuild (no type checking) — ALWAYS pair with
  `tsc --noEmit` (see Verification).
- `webview-ui` transpiles without type checking in `test:webview`; host
  tsconfig excludes webview-ui — the two type-checks are independent.
- Cancel uses per-kind AbortControllers — keep chat/approve controllers
  separate.
- Tool schemas snapshot at session start; tool changes reach in-flight
  agents only in a fresh session.
