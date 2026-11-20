# Xratu Guide

[Quick start](../README.md) · [فارسی](guide.fa.md)

**Contents:** [Getting started](#getting-started) · [Workspace and panels](#workspace-and-panels) · [Models and providers](#models-and-providers) · [Engines](#engines) · [Checkpoints and reviewing changes](#checkpoints-and-reviewing-changes) · [Subagents](#subagents) · [Browser control](#browser-control) · [Downloads and archives](#downloads-and-archives) · [Pull requests](#pull-requests) · [MCP servers](#mcp-servers) · [Agent Skills](#agent-skills) · [Proxy and network routing](#proxy-and-network-routing) · [Privacy](#privacy) · [Commands and settings](#commands-and-settings) · [License](#license)

---

## Getting started

Install Xratu from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=xratu.xratu), or download a `.vsix` package from [Releases](https://github.com/thesamehosuh/xratu/releases) and choose **Extensions → ⋯ → Install from VSIX…**.

1. Open your project folder in VS Code and click the Xratu icon in the activity bar.
2. On first launch, choose one of three setup paths:
   - **Start free** — installs OpenCode 2 with one click and checks available free models in parallel.
   - **Use my provider** — connects a cloud API key, ChatGPT subscription, Iranian gateway, or custom OpenAI-compatible endpoint.
   - **Run locally** — scans for Ollama, LM Studio, vLLM, or llama.cpp running on your machine.
3. Select a model and click **Start chat**.

First-run setup appears only until you complete it once (unfinished setup resumes next time you open Xratu). After that, manage connections in **Settings → Providers** and switch engines in **Settings → Engines** (or via **Xratu: Set Up Xratu**).

### Saved conversations and workspaces

- **Workspace binding**: Each saved chat remembers the workspace folder it belongs to. You can read transcripts from other projects anytime, but running tools or restoring checkpoints stays blocked until you open that original folder (or start a new chat in the current folder).
- **Connection reference**: New chats store a non-secret reference to the connection they used. If that connection was changed or removed, the transcript stays readable — pick a connection in **Providers** before continuing.

## Workspace and panels

Xratu gives you one workspace with a shared composer and eight dockable panels:

| Panel | Purpose |
|-------|---------|
| **Conversation** | Chat with the agent, approve tool requests, answer decision cards, and steer runs mid-turn. |
| **Changes** | Review shadow-git diffs inline, mark files reviewed, add file-specific notes to your draft, or open the native VS Code diff. |
| **Activity** | Read-only timeline of full tool outputs, commands, and timestamps while completed calls stay folded in Conversation. |
| **Agents** | Follow built-in or OpenCode subagents, inspect live traces, send follow-ups, answer scoped approvals, or stop children individually. |
| **Background** | Monitor live output from long-running shell commands and stop them when needed. |
| **Downloads** | Track resumable file transfers for the current chat with continue, retry, and cancel controls. |
| **Browser** | Share a live Chromium page with the agent for inspection, screenshots, and interaction. |
| **Pull requests** | Follow linked GitHub PRs, CI checks, review decisions, and comments. |

### Docking and layout

- **Conversation** stays in the main area. Drag **Changes**, **Activity**, **Agents**, **Background**, **Downloads**, **Browser**, or **Pull requests** between the main tabs and the side dock, or use each tab's menu.
- Wide panels show **Changes** beside **Conversation** by default. Narrow sidebar widths keep every view in the main tab bar.
- Drag the divider (or use arrow keys while focused) to resize the side dock. Layout and width are remembered, and closing a tab never cancels running work.

### Composer and session controls

- **Build vs Plan mode**: **Build** lets the agent edit files and run commands (subject to your approval setting). **Plan** mode is read-only planning with a task list — mutating tools, external MCP writes, and delegation are blocked in code, not just by prompt.
- **Ask first vs YOLO**: **Ask first** is the default — edits, terminal commands, browser actions, and MCP tools prompt you in the conversation before running. Enable **YOLO** in the composer when you want uninterrupted execution across the agent tree (your choice is saved; checkpoints still run, and **Plan** mode still blocks mutations).
- **Attachments and steering**: Attach images, PDFs, or code from the composer, use `@` to reference workspace files, or right-click files in VS Code Explorer and choose **Attach to Xratu Chat**. You can send steering messages while the agent is still working.
- **Long sessions**: Automatic context compaction keeps long tasks moving without losing the thread, and the composer footer shows the active git branch and context-window meter. On the built-in engine, you can also edit and resend earlier messages.
- **Unsent drafts**: Typed drafts stay with their conversation and workspace across page switches, chat switches, and webview reloads. File attachments stay in memory only and must be re-attached after a reload.

### Settings sidebar

Open Settings from the top bar to access three groups:

- **Models & engines**: **Providers**, **Engines**
- **Agent resources**: **Servers** (MCP), **Marketplace**, **Skills**, **Agent files**
- **Preferences**: **Usage**, **Proxy**, **Appearance**, **Settings**

On **Settings**, you can set the **Interface language** (English / Persian), **Reply language** (Auto / English / Persian), conversation detail level, thinking/command display, **Offline mode**, **Explain errors** (adds localized explanations for known provider errors without extra model calls), and **Clear history**.

On **Appearance**, you can switch between following your VS Code theme or dark mode, pick a preset or custom accent color, tune saturation and contrast, adjust interface/text/code font sizes, choose content width and density, or reduce motion.

**Providers**, **Servers**, **Skills**, and **Agent files** show which engine they configure. Browsing another engine's settings never changes the active chat.

## Models and providers

| Group | Providers |
|-------|-----------|
| **Cloud** | OpenAI, OpenRouter, OpenCode Zen, OpenCode Go, DeepSeek, Mistral, Google Gemini, Groq, xAI, Perplexity, Cohere, Together AI, Fireworks AI, Cerebras, NVIDIA NIM, Hugging Face, SambaNova, Moonshot AI, Z.AI |
| **Iranian** | Kaya AI, Avalai, GapGPT, Metis AI, Liara AI, ArvanCloud AI, Navaan |
| **Local** | Ollama, LM Studio, vLLM, llama.cpp |
| **Custom** | Any OpenAI-compatible HTTPS endpoint |

### Sign in with a ChatGPT subscription

In **Settings → Providers**, choose **Add connection → Continue with ChatGPT** and approve access in your browser. If the loopback callback cannot reach VS Code, open **Browser didn’t connect?** and paste the full redirect URL. Tokens are stored in VS Code SecretStorage, and plan usage is shown separately from API-key spend on **Usage**. See OpenAI's [sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) for account eligibility and details.

### Local runtimes and offline mode

Start Ollama, LM Studio, vLLM, or llama.cpp and scan for it in **Settings → Providers**.

- For Ollama on `localhost:11434`, expand **Manage Ollama models** to pull or remove models inside Xratu. Other runtimes manage weights in their own apps.
- Turn on **Offline mode** in **Settings** to restrict Xratu-managed network traffic to loopback (`localhost`, `127.0.0.1`, `::1`) and disable cloud providers, OpenCode, web research, and external MCP. Terminal commands remain unrestricted.

For step-by-step setup and honest RAM/VRAM sizing guidance, see the bundled [Offline setup and local models guide](../assets/guides/offline.en.md).

### For developers in Iran

- **First-class Iranian gateways**: Kaya AI, Avalai, GapGPT, Metis AI, Liara AI, ArvanCloud AI, and Navaan have their own section in **Settings → Providers**, accept domestic payment, and work without a VPN.
- **Toman cost tracking**: Configure per-host rates (`xratu.providerPricing`) or a fallback exchange rate (`xratu.tomanPerUsd`) to see costs in Toman on the **Usage** page.
- **Latency benchmarking**: In **Providers**, expand **Compare connection latency** to send a tiny opt-in `"Reply with OK."` probe (32-token cap, no project context) to the active model and compare first-token time, total time, and estimated cost across connections.
- **Proxy-native**: Works with Clash and v2rayN **System Proxy** mode out of the box — no TUN interface required.
- **Persian-first**: Full RTL Persian UI, Jalali dates, localized error explanations, and natural Persian replies via the preloaded `natural-farsi` skill.

| Provider | Base URL | Setup note |
|----------|----------|------------|
| Kaya AI | `https://kayaai.ir/api` | Pre-filled in preset; paste your API key |
| Avalai | `https://api.avalai.ir/v1` | Pre-filled in preset; paste your API key |
| GapGPT | `https://api.gapgpt.app/v1` | Pre-filled in preset; paste your API key |
| Metis AI | Per-service | Paste the OpenAI-compatible URL from your service dashboard |
| Liara AI | Per-service | Paste the URL assigned to your AI service |
| ArvanCloud AI | Per-service | Paste the URL assigned to your AI service |
| Navaan | Per-service | Paste the URL from your account dashboard |

See the bundled [Provider comparison guide](../assets/guides/providers.en.md) for verified onboarding links, payment notes, and cost-comparison steps.

## Engines

Xratu supports two execution engines inside the same workspace UI. Switching engines starts a fresh chat and leaves earlier conversations intact; reopening any saved chat resumes it on its original engine.

| Capability | Xratu (built-in) | OpenCode 2 |
|------------|------------------|------------|
| **Models & auth** | Cloud API keys, Iranian gateways, ChatGPT OAuth, local runtimes | OpenCode free models + OpenCode's own configured providers |
| **Shared Xratu tools** | Built-in file/shell/web/archive/download/PR/browser tools, MCP, skills | Shares Xratu MCP servers, enabled skills, browser, downloads, PRs, web research, and task list; keeps OpenCode's native file/shell tools |
| **Approvals & Plan mode** | Ask first / YOLO; Plan blocks mutations in code | Ask first / YOLO via Xratu cards; Plan blocks mutations & delegation |
| **Subagents** | Built-in & custom `.md` profiles with persistent child history | OpenCode native agents with live traces, attributed approvals & Stop |
| **Checkpoints & rewind** | Shadow checkpoints + message edit/resend & full rewind | Shadow checkpoints (file-only restore); no native conversation rewind |
| **Offline mode** | Supported (loopback local runtimes) | Unavailable (Xratu cannot isolate OpenCode's network access) |

### Installing and managing OpenCode 2

Open **Settings → Engines → OpenCode 2**. Xratu detects an existing 2.x binary on your `PATH`, or installs a checksum-verified standalone `2.0.30` binary into VS Code global storage with one click — no Node.js or npm required.

- Supports Windows, macOS, and Linux (x64/arm64, baseline x64, and Linux musl) with progress, cancellation, retry, and a custom executable path option.
- Managed installs offer **Update engine** when a newer verified version ships and **Remove engine** to stop the runtime and switch chat back to Xratu (binaries referenced by saved chats plus OpenCode's credentials, settings, and history are preserved).
- OpenCode 1.x is detected but not supported. Back up your OpenCode configuration and history before migrating from 1.x.

### Free models and availability checks

OpenCode's model picker shows each model's provider and defaults to **Free models only** (turn off the filter to view paid providers configured in OpenCode). Opening the picker tests every free model in parallel with a tiny isolated check and displays availability or rate limits with timestamps; use the retry button beside any model to check again. If a previously selected free model disappears, Xratu picks another verified free model and never silently falls back to a paid model.

### How OpenCode runs inside Xratu

- **Separate credentials & native sessions**: OpenCode uses its own saved credentials and CLI configuration; Xratu never copies its provider keys into OpenCode. In **Providers** (scoped to OpenCode), you can connect simple API-key and OAuth providers through the SDK; flows needing extra forms or commands use OpenCode's CLI.
- **Shared Xratu capabilities**: Enabled Xratu MCP servers connect through an authenticated loopback bridge (respecting Xratu's proxy routing, timeouts, and auto-approval rules; denied in Plan mode). Enabled Xratu skills are available via the bridged skill tool, while OpenCode's own native MCP, skills, and agent inventories remain read-only.
- **Approvals, steering, and safety**: Native permissions render as Xratu approval cards, questions as decision cards, and shell output streams into **Background**. Steering messages are delivered at OpenCode's next step boundary, and code/text attachments plus `@` references are passed as full local snapshots. Three consecutive failed native file edits automatically pause the run (even in YOLO mode) so you can inspect the error or switch models without rolling back earlier edits.

## Checkpoints and reviewing changes

Before each send and edit, Xratu snapshots your workspace into a separate **shadow git** repository inside extension storage. Your project's own `.git` index and commit history are never modified.

- **Review inline**: Open **Changes** (or click **Review changes** on a turn) to inspect per-file diffs, mark files as reviewed, attach review notes to your composer draft, or open the full native VS Code diff editor.
- **Restore**: Run **Xratu: Restore Checkpoint…** from the Command Palette. Restoring applies to the whole workspace and saves a safety snapshot first so you can undo a restore. Stop active workspace processes from **Background** before restoring. Files-only restore keeps your conversation transcript intact.

## Subagents

> The profile format and local persistence below apply to the built-in Xratu engine. OpenCode uses its own native agent definitions (shown read-only in Xratu).

A subagent is a child conversation with its own context, assignment, and optional model. The built-in coordinator persists child sessions on disk, so follow-ups can continue the same child even after a window reload. A profile provides starting instructions and tool access; editing a profile file does not alter children that already exist.

| Built-in profile | Capabilities |
|------------------|--------------|
| `explore` | Reads and searches files and web evidence; no editing or terminal tools. |
| `verify` | Runs approval-gated tests and commands (commands may produce build artifacts). |
| `general` | Inspects, edits files, runs commands, and verifies results. |

`xratu.maxParallelSubagents` (default `4`, range `1–8`) limits simultaneous child runs; extra assignments queue automatically. Mutation-capable children and the parent coordinate through a shared-workspace writer lease, while read-only `explore` runs can overlap freely. This coordinates concurrent edits — it is not a shell sandbox and does not create separate Git worktrees.

### Working with child conversations

Open the **Agents** tab to inspect and steer child conversations (on narrow sidebars, selecting a child opens full-height; on wide panels, the list stays visible beside it):

- **Steer or continue**: Send follow-up instructions directly to a running child (delivered at the next safe model boundary) or continue a settled child conversation.
- **Independent stop**: Stop one child without interrupting siblings or the parent.
- **Scoped approvals and questions**: Answer a child's approval or question card right inside its conversation (or from the parent — both resolve the same request once).
- **Tune between runs**: Change a child's model, reasoning effort, or round cap between executions.
- **Manual investigations**: Launch a fresh child directly from **Agent profiles** and click **Report to parent** when you want to hand its findings back to the main conversation.

If VS Code reloads mid-run, built-in child executions are interrupted cleanly rather than silently replaying uncertain tool calls. Committed child history and reports survive reload, while restoring a checkpoint invalidates discarded child context.

With **OpenCode**, native subagents appear in **Agents** with live traces, attributed approvals/questions, direct inbox messages while active, and individual Stop controls. Plan mode denies delegation on both engines.

### Writing a custom agent file

Run **Xratu: Agent Files…** from the Command Palette to inspect all loaded profiles (including load warnings and errors) or scaffold a new one. Profiles are Markdown files with YAML frontmatter; the body becomes the subagent's system prompt.

Search order (first match wins):

1. `.xratu/agents/<name>.md`
2. `.agents/agents/<name>.md` (shared across agent tools)
3. `.claude/agents/<name>.md` (Claude Code)
4. `~/.agents/agents/<name>.md`
5. `~/.claude/agents/<name>.md` (Claude Code)

```markdown
---
name: code-reviewer
description: Reviews changed code for correctness and security; use after a large edit.
tools: read_file, grep_search, glob_search, run_terminal_command
model: gpt-5-mini
reasoning_effort: low
max_rounds: 30
---

Review the diff for correctness and security problems. Report each finding
with a file path and line number, most severe first.
```

| Field | Meaning |
|-------|---------|
| `name` | Optional; must match the filename (lowercase letters, digits, single hyphens). |
| `description` | **Required.** Tells the parent model when to delegate to this profile. |
| `tools` | Optional comma-separated allow-list of Xratu tool names. Omit for the default child toolset. Parent-session controls, delegation tools, `ask_user_question`, and shared process controls are always stripped; use `ask_session_question` for child questions. |
| `model` | Optional model ID for this profile (context window and output cap follow that model). Defaults to the parent's model. |
| `reasoning_effort` | Optional: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `max_rounds` | Optional loop limit for this profile (default `50`). |

**Load-time tool validation**: Every name in `tools:` is checked against Xratu's actual toolset when the file loads. Unknown names are dropped with a warning, and a list with **zero** valid names fails with an error rather than creating a silently tool-less agent (important when reusing files written for tools that spell names `Read`, `Grep`, or `Bash`). Use **Xratu: Agent Files…** or the **Xratu** output channel to inspect issues. Built-in children always keep real approval gates for edits and commands.

## Browser control

Open the **Browser** tab, enter a website or local dev-server URL, and interact with the live page. Dock **Browser** in the side panel to keep it beside **Conversation**.

- **Shared control**: The agent works on the same page you see — it can inspect the accessibility tree, console, and network diagnostics, take screenshots, navigate, click, type, scroll, resize the viewport, and run page JavaScript.
- **Approvals and Plan mode**: Interactive browser actions require approval unless **YOLO** is on. **Plan** mode allows read-only inspection of an already-open page only.
- **Browser binary and isolation**: Xratu launches your installed Chrome or Edge on demand, or the Chromium executable specified in `xratu.browserExecutablePath`. Nothing is downloaded automatically. Chromium runs on the extension host with its sandbox enabled and an isolated temporary profile (in remote VS Code windows, `localhost` refers to the remote host).
- **Session lifecycle**: Each chat gets one browser page (popups and browser downloads are blocked). The page survives tab moves and webview reloads within the same chat, and closes when you switch chats, close the browser, or reload VS Code. **Offline mode** closes existing browser connections and permits loopback URLs only.

## Downloads and archives

Xratu includes managed HTTP(S) downloads plus offline file verification and safe archive extraction, available in both the built-in engine and OpenCode.

### Managed downloads

Ask the agent to download a file (via `start_download`, `control_download`, and `list_downloads`) and follow transfers in the **Downloads** tab.

- **Per-chat isolation and controls**: **Downloads** shows transfers for the current chat with **Continue**, **Retry**, and **Cancel** buttons. Cancelling removes the partial file; completed files stay untouched on disk.
- **Resumable and safe**: Interrupted transfers keep their progress and resume cleanly when the server supports HTTP `Range` validation. Opening a workspace never resumes downloads silently — continue them explicitly after a restart. Existing destination files are never overwritten, and source URLs (which may include signed tokens) are kept in VS Code SecretStorage rather than manifests or UI.
- **Per-transfer routing**: Each download can use `auto` (your proxy settings), `proxy`, or `direct` without changing global proxy configuration. **Offline mode** cancels active transfers and blocks resumes.
- **Large-file checkpoints**: Completed downloads of 50 MiB or larger are excluded from shadow checkpoints so later coding turns do not archive multi-gigabyte files.

### File verification and archives

- **`verify_file`** (read-only, works offline): Computes a workspace file's SHA-256 digest and optionally checks it against a publisher digest.
- **`inspect_archive`** (read-only, works offline and in Plan mode): Lists entries in ZIP, TAR, and TAR.GZ/TGZ archives without writing to disk.
- **`extract_archive`** (approval-gated, works offline): Extracts ZIP, TAR, and TAR.GZ/TGZ archives into a **new** workspace directory after taking a shadow checkpoint. Never overwrites existing files, rejects symlinks, path traversal, Windows-unsafe paths, and encrypted ZIPs, verifies ZIP CRCs (and optional publisher SHA-256), and never executes extracted files.

## Pull requests

Track GitHub pull requests directly inside Xratu from the **Pull requests** tab or via **Xratu: Pull Requests…**.

- **Uses your local `gh` login**: Xratu reads PR metadata through the installed [GitHub CLI (`gh`)](https://cli.github.com/) using your existing authentication. No GitHub tokens enter prompts or the webview.
- **Live status in one place**: See PR state (draft, open, merged, closed), branch pair, review decision, required and optional CI checks, and recent comments. Refresh, open on GitHub, or unlink from the row menu.
- **Watch mode**: Enable **Watch** (or ask the agent to monitor a PR) to check every 30 seconds without model calls and automatically resume the idle session when CI checks fail or pass, reviewers comment or request changes, or merge conflicts appear. Watches survive VS Code reloads, stop automatically when the PR closes or merges, and are unavailable in **Plan** mode or **Offline mode**.

## MCP servers

Configure Model Context Protocol servers in **Settings → Servers** or directly in two Cline-compatible JSON files:

- **Global**: `mcp.json` in Xratu's global storage directory
- **Workspace**: `.xratu/mcp.json` in the workspace root (overrides global per server key; honored in trusted workspaces only)

Supports `stdio` (`command`/`args`/`env`), `websocket`, and `streamableHttp`/`sse` (`url`/`headers`). Exposed tools appear as `mcp__<server>__<tool>` and follow the normal approval gate unless you explicitly enable per-tool auto-approval on the **Servers** page.

### Default and curated Iranian servers

- Fresh installs enable the official [Zarinpal documentation MCP](https://www.zarinpal.com/docs/mcpDocs/) (read-only public docs, no API key). Existing MCP configs are never overwritten.
- Curated Iranian servers lead the **Marketplace** under the **Iranian** tag filter — including unofficial, read-only integrations for **[Digikala](https://github.com/sepehr071/digikala-mcp)** (requires `uv`), **[Torob](https://github.com/mmdju/torob-mcp)** (runs locally with Node.js + Git; first startup may take up to 2 minutes to install dependencies), and **[Divar](https://github.com/mmdju/divar-mcp)** (hosted HTTP). All require your explicit opt-in before connecting or running code.
- The bundled [`iranian-marketplaces`](../assets/skills/iranian-marketplaces/SKILL.md) skill helps the agent pick between Digikala, Torob, and Divar and interpret Toman prices and rental deposits.

### Marketplace

Open **Settings → Marketplace** to browse and install servers without hand-editing JSON:

- **Configurable sources** (`xratu.mcpMarketplaceSources`): Defaults to the Cline public catalog (Apache-2.0) and the official MCP registry. Add any `http(s)` catalog URL, or set an empty list to disable remote catalogs.
- **Proxy-aware and offline-ready**: Catalogs fetch host-side through your configured proxy, cache for 24 hours, and always merge with Xratu's bundled curated list.
- **Transparent installs**: Every row shows its exact command or URL, and confirmation displays the exact config before saving. Servers needing credentials open the edit form. Auto-approval is never imported from a catalog.
- **README detection**: For catalog entries without install metadata, you can opt in to detect a command from the repo README — guessed commands are clearly labeled for review before saving.

## Agent Skills

Xratu supports the open [agentskills.io](https://agentskills.io) format so you can share skills with Claude Code, OpenCode, Roo Code, and other tools.

A skill is a folder containing a `SKILL.md` file with YAML frontmatter (`name` and `description`) plus markdown instructions (and optional scripts, references, or templates alongside it). Only `name` and `description` load up front; the agent loads the full instructions on demand via the `skill` tool.

Search order (first match wins):

1. `.xratu/skills/<name>/SKILL.md`
2. `.agents/skills/<name>/SKILL.md`
3. `.claude/skills/<name>/SKILL.md`
4. `~/.agents/skills/<name>/SKILL.md`
5. `~/.claude/skills/<name>/SKILL.md`

```markdown
---
name: deploy-staging
description: Deploy the app to staging; use when the user asks to deploy or ship to staging.
---

1. Run the test suite
2. Build the app
3. `npm run deploy:staging`
```

Enable or disable individual skills in **Settings → Skills**. Enabled Xratu skills also work in OpenCode through the bridged skill tool.

### Bundled first-party skills

Xratu ships eight skills seeded into `~/.agents/skills` when first introduced (so other agent tools can see them too). New bundled skills are added on upgrade; your edits are preserved, and deleted skills stay deleted.

| Skill | What it does |
|-------|--------------|
| `natural-farsi` | Writes natural Persian in your chosen formal or informal register with clean house orthography. Preloaded when reply language is Persian. |
| `finglish-normalize` | Understands Finglish (Persian written in Latin script) and matches your language and script. |
| `jalali-dates` | Uses Jalali (Shamsi) dates in Persian prose while keeping machine-readable dates in ISO format. |
| `iran-dev-access` | Helps evaluate service availability, payment routes, and practical alternatives from Iran. |
| `iran-connectivity-fallback` | Diagnoses repeated provider connection failures and suggests workable network or provider fallbacks. |
| `local-llm-low-ram` | Honest RAM/VRAM sizing guidance for running local models on modest hardware. |
| `native-downloads` | Guides managed downloads, route selection, checksum verification, and resume recovery. |
| `iranian-marketplaces` | Helps choose Digikala, Torob, or Divar tools and handle Toman prices, variants, and rental deposits. |

## Proxy and network routing

Open **Settings → Proxy** to control outbound routing:

- **Proxy modes**:
  - `auto` (default): checks `xratu.proxyUrl` → VS Code `http.proxy` → environment variables (`HTTPS_PROXY`/`HTTP_PROXY`) → OS system proxy.
  - `custom`: uses only your explicit HTTP/HTTPS proxy URL and `noProxy` bypass list.
  - `off`: connects directly without a proxy.
  *(SOCKS proxies are not supported yet.)*
- **Local proxy scan**: Detects Clash clients (Clash Verge Rev, mihomo, Mihomo Party, Clash Nyanpasu, ClashX), v2rayN/v2rayA, or Surge running on your machine and picks up their active ports. **System Proxy** mode is enough — no TUN needed.
- **Web search routing**: Route built-in web search via your proxy or directly (`xratu.webSearchUseProxy`), independently of model requests.
- **Per-MCP routing**: Set each remote MCP server to `auto`, `proxy`, or `direct`, and verify with a live connection test before saving.

## Privacy

- **Credentials and secrets**: Model API keys, ChatGPT OAuth tokens, and managed download source URLs are stored in VS Code SecretStorage. MCP header and environment values entered through **Settings → Servers** are saved as secret references. Manually edited `mcp.json` files can still contain raw secrets — never commit `.xratu/mcp.json` to version control. OpenCode stores its own credentials separately.
- **Local storage and zero telemetry**: Chat history and shadow checkpoints stay on your machine. Xratu collects no telemetry, analytics, or crash reports.
- **Automatic web research**: Web research runs automatically (including in Plan mode) with no account or search API key required.
  - `web_search` sends public queries to anonymous Parallel Search MCP, falling back to anonymous Exa if unavailable or rate-limited.
  - `fetch_url` reads public pages directly (returning Markdown, code, links, and bounded PDF text). Clean URLs observed in that chat's public search results can fall back to Parallel extraction; URLs with query strings or fragments stay direct-only.
  - Hosted search services receive the query text (or eligible public URL) and a random per-chat ID. Query text is sent unchanged, so avoid including local paths in `web_search` queries. Provider keys, cookies, and native session IDs are never sent. Pages are held briefly in memory (5 minutes) and never cached to disk. OpenCode uses this same Xratu research layer.
  - Legacy Brave/SearXNG search settings are retired; if you saved old search keys in VS Code settings, remove them manually.
- **Offline mode**: Restricts Xratu-managed network traffic to loopback endpoints and disables cloud models, OpenCode, web research, and external MCP. Terminal commands and browser links you open yourself remain unrestricted.
- **Reporting vulnerabilities**: Please report security issues privately through [SECURITY.md](../SECURITY.md), not in a public issue.

## Commands and settings

### Command Palette commands

| Command | Action |
|---------|--------|
| **Xratu: New Session** | Start a fresh conversation. |
| **Xratu: Set Up Xratu** | Open setup (first run) or Engine settings. |
| **Xratu: Open Settings** | Open Xratu's Settings page. |
| **Xratu: Set LLM Credentials** | Jump straight to Providers. |
| **Xratu: Agent Files…** | Inspect loaded subagent profiles, view validation issues, or create a new profile. |
| **Xratu: Restore Checkpoint…** | Restore workspace files from a shadow checkpoint. |
| **Xratu: Review Changes…** | Open inline diff review for the workspace. |
| **Xratu: Pull Requests…** | Open the Pull requests panel. |
| **Xratu: Attach Files…** | Pick files to attach to the current chat (also available via right-click **Attach to Xratu Chat** in Explorer). |

### VS Code settings

| Setting | Default | Description |
|---------|---------|-------------|
| `xratu.proxyMode` | `"auto"` | Outbound proxy mode: `auto`, `custom`, or `off`. |
| `xratu.proxyUrl` | `""` | Explicit HTTP/HTTPS proxy URL (e.g. `http://127.0.0.1:7890`). |
| `xratu.noProxy` | `""` | Comma-separated hosts that bypass the proxy (`*` and `host:port` supported). |
| `xratu.webSearchUseProxy` | `true` | Route built-in web search through the configured proxy. |
| `xratu.maxAgentRounds` | `0` | Hard cap on agent rounds per turn (`0` = unlimited). |
| `xratu.maxParallelSubagents` | `4` | Maximum concurrent subagents (`1–8`). |
| `xratu.compactionTokenBudget` | `120000` | Working-context token budget before summarizing older turns. |
| `xratu.autoCompactThreshold` | `90` | Context-window fill percentage that triggers compaction. |
| `xratu.browserExecutablePath` | `""` | Absolute path to a Chromium executable (blank auto-detects Chrome/Edge). |
| `xratu.mcpMarketplaceSources` | Cline + MCP registry | Remote catalog URLs for Marketplace (empty list disables remote catalogs). |
| `xratu.modelPricing` | `{}` | Per-model price overrides per 1M tokens (`input`, `output`, `cachedInput`, `currency`). |
| `xratu.providerPricing` | `{}` | Per-host gateway rates (`tomanPerUsd`, `markupPercent`). |
| `xratu.tomanPerUsd` | `0` | Fallback Toman-per-USD rate for Iranian gateways without a host rate. |

## License

[Apache-2.0](../LICENSE). Third-party attributions (including components adapted from [T3 Code](https://github.com/pingdotgg/t3code) under MIT) ship in [`THIRD_PARTY_NOTICES.txt`](../THIRD_PARTY_NOTICES.txt).
