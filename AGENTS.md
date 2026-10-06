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

## Subagents (agent files)

`src/subagents.ts` is the pure loader (discovery, frontmatter, validation);
`src/local/subagentRunner.ts` drives the nested loop. The `task` tool is how
the parent delegates; `subagents: SubagentDefinition[]` on
`getLocalToolDefinitions` adds it, and `SubagentHostContext.baseRequest(def)`
is what lets a profile pick its own model/effort (its caps and context window
must then be computed for THAT model, not the parent's).

Rules that exist because their absence was a real failure mode:

- **`tools:` is VALIDATED at load time** against the host's real tool names
  (`discoverSubagents({ validation: { toolNames } })`). Unknown names are
  dropped with a `warning`; a list that resolves to NOTHING is an `error`, so
  a foreign vocabulary (Claude Code's `Read`/`Grep`/`Bash` — those
  directories are deliberately scanned) can never yield a silently tool-less
  child. Never "fix" a bad `tools:` list by silently ignoring it again.
- **Every load problem must be surfaced.** `subagentIssues()` feeds both the
  `xratu.agentFiles` picker and the Xratu output channel; a definition with
  `error`/`warning` that nobody renders is a silent failure.
- **Strips hold structurally, not by prompt**: `task`,
  `update_task_list`, `exit_plan_mode`, `ask_user_question` never reach a
  child (`filterToolsForSubagent` + `wrapRestrictedExecutor`), even when a
  profile allow-lists them.
- **Approvals stay real for children.** Do NOT "fix" child prompts by
  auto-approving them (goose/hermes do; that is a deliberate difference).
  `task_id` is chat-scoped and the note says so — a persisted id must never
  outlive its in-memory registry.
- Parallel delegations run in WAVES (`xratu.maxParallelSubagents`, default 4);
  each one is a full loop with its own context and budget.
- Agent-file changes need BOTH `test:subagents` (loader/validation) and
  `test:subagent-runner` (the real nested loop) green, plus a README section
  in en + fa (the feature is user-facing, and Persian strings must pass
  `test:farsi-orthography` — no ZWNJ).

## Verification — run before claiming done

```bash
npm run lint
node_modules/.bin/tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p webview-ui/tsconfig.json   # SEPARATE project — host tsc does NOT cover it
node esbuild.js
npm run test:webview
```

CI runs exactly these on ubuntu, windows and macos, plus the host-side test
suites. Skipping the webview tsc step is the classic CI-only failure — never
skip it.

`npm run lint` is `eslint.config.mjs`, which encodes the Non-negotiable rules
below as AST rules (R1 killTree, R2 cross-spawn, R3 `dir`, R4 logical props).
It must be GREEN on a clean tree — it reports 0 errors and a handful of
`warn`s that are known, documented debt. Do not turn an R* rule down to make
the lint pass; fix the code, or amend the rule's justification comment in
`eslint.config.mjs`. A pre-commit hook runs eslint on staged files only.

For packaging: `npm run package-vsix`. For interactive development:
`npm run compile` + F5 via `.vscode/launch.json`.

Host-side pure logic (path guards, parsers, protocol shapes) goes in
testable modules with node test suites — precedent: `test/test-endpoint-guard.mjs`
(run after `npx tsc -p . --outDir out`; npm script per suite). Security-
relevant heuristics (e.g. `endpointGuard.ts`) ALWAYS get a regression test.

## Releasing

Pushing a `v*` tag is the whole release. `.github/workflows/release.yml` builds
the VSIX behind the same gate as CI and then creates the GitHub Release with
that exact artifact attached — no manual download/upload step.

Bump `version` in `package.json` in the same PR as the user-visible change (it
is what the packaged VSIX reports), then tag `main`:

```bash
git tag -a v1.4.3 -m "xratu 1.4.3" && git push origin v1.4.3
```

Release notes are optional. To write them yourself instead of accepting a
generated commit list, add `.github/release-notes/v1.4.3.md` **before** tagging
— the workflow prefers that file when it exists. Prose beats a commit list;
this repo's releases have always carried real notes.

Two invariants in that workflow are load-bearing and guarded by
`test:release-workflow` — keep that suite green if you touch it:

- Only the `publish` job holds `contents: write`. The `package` job runs
  `npm ci` and the build toolchain, so it must stay read-only or a compromised
  dependency script inherits the ability to publish.
- The tag is validated as strict semver in `package` and handed to `publish` as
  a job output. `on.push.tags: ['v*']` matches anything starting with `v`,
  metacharacters included, so that regex is the only thing between a tag name
  and a shell. Never let `publish` read `github.ref_name` directly.

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
3. Install the `--vscode-*` tokens with the shared fixture — the standalone
   page has NO VS Code theme, and hand-rolling the block silently fails when
   injected before `document.documentElement` exists (every surface renders
   transparent while still looking plausible, so screenshot reviews become
   worthless). Use `import { installVscodeTheme } from './vscodeTheme'`
   (`test/e2e/vscodeTheme.ts`) and `await installVscodeTheme(page)` BEFORE
   `page.goto`; it applies Dark Modern values and the `vscode-dark` body class
   the Shiki highlighter keys off. Do not hand-write the token block.
4. Screenshot each page state at SIDEBAR width (~420px) AND wide, in both
   `fa` (RTL) and `en` — RTL breaks differently than LTR.
5. CAVEAT: `fullPage: true` screenshots stitch artifacts into pages with
   internal scroll containers — content looks clipped when it isn't. Verify
   suspected clipping with a viewport screenshot after
   `scrollIntoViewIfNeeded`, or by comparing `getBoundingClientRect` up the
   ancestor chain (an `overflow: hidden` ancestor only clips if
   `scrollHeight > clientHeight`).

## Non-negotiable rules

Some of these are enforced by `npm run lint` (see `eslint.config.mjs`), which
is exactly why they are numbered R1-R4 there: R1 `killTree`, R2 `cross-spawn`
/ no shell strings, R3 `dir`, R4 logical CSS props. The rest — secrets, shadow
git, SSRF, plan-mode tool gating, Windows paths — are review-only.

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
