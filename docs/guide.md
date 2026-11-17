# Xratu reference

[Quick start](../README.md) · [فارسی](guide.fa.md)

## Quick setup

The welcome screen offers **Start free**, **Use my provider**, and **Run locally**.
It skips completed steps, reuses saved connections, and asks you to choose a
model before opening chat. Free OpenCode models are checked in parallel;
provider and local catalogs are loaded without a paid test inference. A local
server with no models stays in setup; Ollama downloads are available in the app.
**Start chat** opens the new conversation after setup, including when saved
connections already exist.

Onboarding appears only before the first completed setup. Unfinished setup
resumes on the next launch. After setup, **Settings → Engines** and
**Xratu: Set Up Xratu** open engine settings; switching engines starts a new
chat without reopening onboarding. A missing Xratu connection opens Providers.
Installing OpenCode alone does
not mean a model is available; workspace, offline mode, and upstream rate limits
are checked separately.

Providers, MCP, Skills, and Agents show which engine they configure. Browsing
another engine's settings does not change the current conversation. OpenCode's
provider view lists its saved and environment connections and supports simple
SDK API-key and OAuth methods. Authentication methods with additional forms or
commands still use OpenCode's own setup. Native MCP and skill lists are read-only.
Manage Xratu MCP servers, marketplace installs, and skills with either settings
scope selected. OpenCode accesses enabled Xratu skills and their bundled resources
through the shared skill tool. Its own native resources remain a separate read-only
inventory. The browser, task list, reply language, and plan handoff also work
with OpenCode; ending a plan unlocks execution on the next turn. Native subagents
appear in Agents with their own traces, attributed approvals, and stop controls.
Usage attributes new native rounds to their engine/provider and preserves reported
costs when Xratu pricing is edited.

Historical edit/resend is available only with the built-in engine. OpenCode
keeps the copy action and file-only checkpoint restore; its native history cannot
be rewound by Xratu.

Files selected from VS Code are delivered only to the chat that requested them.
Switching chats during a file read discards that delayed delivery.

Saved conversations keep their original workspace. Histories from other projects,
missing folders, or legacy workspace markers remain readable. Execution and
checkpoint restore are blocked until the original workspace is verified; open
that folder or start a new chat here. Viewing history never rebinds its workspace.

New chats save a nonsecret connection reference. If a restored chat's connection
changed or was deleted, its transcript remains readable; select a connection in
Providers explicitly before continuing. Legacy chats without a connection
reference keep the current provider's model and do not overwrite its model memory.

## Unsent drafts

Unsent text stays with its conversation and workspace when switching chats or
reloading the webview. A new chat keeps its draft when its first message assigns
it a saved session ID. Cancelling a historical edit returns to the ordinary draft.
Only the first 200,000 UTF-16 code units of each draft survive a composer reload.
VS Code state retains up to 32 recent text drafts within 200,000 characters total;
older drafts are evicted. Attachments are kept in memory only and must be
attached again after reload, including session switches that reload the page. Normal sends stay in the composer until the host saves and acknowledges the
pending turn. Acceptance clears only the submitted revision; newer typing stays.
Rejected submissions keep their draft, and repeated request IDs are not executed twice.

## OpenCode inside Xratu

Open **Settings → Engines → OpenCode 2**. Xratu detects an existing 2.x
installation, or installs a verified standalone 2.0.30 binary with one click.
Managed installations offer **Update engine** when a newer verified release ships
with Xratu, and **Remove engine**. Updating opens a fresh chat and keeps older
binaries for saved sessions. Removal stops the managed runtime and switches chat
to Xratu; runtimes referenced by saved chats, OpenCode credentials, settings, and history are preserved. Update or
remove a custom/PATH installation using its original installer.
Node and npm are not required. Open a project folder, select **Use in new chat**,
and pick an OpenCode model. The free models work without an Xratu API key;
their availability and rate limits are controlled by OpenCode.
The model picker shows the provider after each name and defaults to **Free
models only**. Turn that filter off to see paid models configured in OpenCode.
If the selected model disappears, Xratu selects another verified free model.
If none remain, choose a model explicitly; Xratu never automatically falls back
to a paid model. An existing selection stays selected, including paid models.
Opening the model picker checks every free model in parallel using small requests
in separate temporary sessions. Results show availability or a rate limit with
the check time. Recent onboarding checks are reused for 30 seconds. The check button beside each free model always lets you retry it manually.
OpenCode uses its own saved credentials, including OpenRouter when selected;
Xratu does not replace them or copy its provider keys into the engine.

The installer supports Windows, macOS, and Linux on x64/arm64, with baseline
x64 builds and Linux musl variants. It has progress, cancellation, retry, and
a custom executable path. Managed binaries stay in VS Code global storage;
existing installations remain available. OpenCode 1.x is detected but cannot
run this engine. Back up your OpenCode configuration and history before
migrating from 1.x: OpenCode owns its database migration.

Switching engines starts a fresh conversation and preserves old Xratu
history. Reopening an OpenCode conversation resumes its native session, tied
to its original workspace and runtime. OpenCode manages authentication,
configuration, tools, compaction, and native history. Its CLI sign-in and
provider configuration apply here too; credentials are not copied into Xratu.

Native permission requests use Xratu approval cards, and questions use its
decision cards, including multiple selections. Plan mode deterministically
denies mutation and unknown tools. YOLO permits native tools without approval.
Native steering is delivered at OpenCode's next step boundary. Shell commands
stream output and expose background/stop controls in Xratu's Background panel.
Cancel waits for native execution to stop, then the same conversation can continue.
Three consecutive failed native file edits stop the run, including in YOLO mode.
Check the tool errors or choose another model before continuing the same chat.
A successful tool result or a non-edit tool breaks the failure streak. Earlier
changes stay in place; this does not repair malformed edits or roll them back.
Code/text uploads and `@` references are saved as local attachment snapshots
and passed to OpenCode as files, including during steering. They keep their
full contents instead of the built-in engine's 24,000-character preview.
Snapshots remain in Xratu's local storage so native history can read them
after a restart; workspace references still pass Xratu's path validation.
Enabled Xratu MCP servers, including the bundled defaults, are shared through
an authenticated loopback bridge. Their transports, proxy routing, timeouts,
images, and explicit auto-approval choices stay with Xratu. Changes apply on
the next turn; shared MCP tools are denied in Plan mode. OpenCode keeps its
native file and terminal tools and its separately configured MCP servers.
Native subagents use OpenCode agent definitions and permissions. Stop one child
from Agents or stop the whole tree from the composer; the parent turn stays active
until nested/background work and reports settle. Plan mode denies delegation.
Conversation rewind is unavailable; file-only shadow checkpoint restore remains available. Offline
mode blocks this engine because Xratu cannot enforce network isolation on the
OpenCode process. Xratu's file-path and web-fetch guards apply to its own tools;
OpenCode's native tools use OpenCode's permission boundary.

The engine interface leaves room for Codex and Claude Code adapters. This
release implements OpenCode only. Lifecycle, event, permission, question, and
managed installation logic is adapted from [T3 Code](https://github.com/pingdotgg/t3code)
under MIT; attribution ships in `THIRD_PARTY_NOTICES.txt`.

## Features

- **Work surface** - Conversation, Changes, and Activity share one compact
  composer. Finished tool calls fold into optional steps; Activity keeps the
  full outputs in a read-only view, with timestamps in expanded footers and
  on hover. Approvals and questions stay in Conversation. Review checkpoint
  diffs inline, mark files reviewed, and add feedback to your draft before
  sending. Wide panels show Changes alongside
  the conversation by default. Drag Conversation, Activity, Changes, Agents, Background, or Browser between the main
  tabs and sidebar, or use the tab menu. Placement and sidebar width are
  remembered; narrow windows keep every view in the main tabs. Drag the
  divider or use its arrow keys to resize. Conversation keeps its transcript
  and composer together, so chat can sit in the sidebar beside a larger Browser.
- **Sidebar pages** - providers, MCP servers, marketplace, skills, agent
  files, usage, proxy, and settings stay one click away. Setup opens in a
  focused side panel; Iranian providers remain visible. Drafts survive page
  changes, and user bubbles stay on the right with automatic text direction.
- **Agentic coding** - reads files, edits code, runs terminal commands,
  searches the web. Every edit and command needs your approval; per-tool
  auto-approve if you trust a workflow, YOLO mode if you don't want the gate.
  **YOLO mode drops the approval gate entirely** - file edits, terminal
  commands, and MCP tools all run unasked. Checkpoints still snapshot before
  edits and plan mode still blocks mutations, but nothing is holding the loop
  back. Point it at a scratch workspace, not a repo you care about.
- **Plan mode** - read-only planning with a task list. Mutating tools are
  blocked in code, not by prompt.
- **Checkpoints** - shadow-git snapshots before sends and edits. Use a turn's
  **Review changes** button or **Changes** to inspect files inline and open
  the full native diff. Restore a snapshot from the Command Palette with
  **Xratu: Restore Checkpoint…**. Your real git repo is never touched.
  Restore affects the whole workspace and preserves a safety snapshot. A stale
  session/turn confirmation is rejected. Stop workspace background processes
  from Background before restoring; files-only restore keeps the conversation.
  A missing or unreadable session leaves the current chat intact. Branch
  checkout waits until runs and session actions finish. Edits/resends and
  session deletion use the same transaction queue; a failed new-chat creation
  keeps the previous conversation.
- **MCP servers** - stdio, WebSocket, or streamable HTTP/SSE, with
  Cline-compatible files-based config.
- **Agent Skills** - the open [agentskills.io](https://agentskills.io)
  standard; skills can be shared with Claude Code, Roo Code, OpenCode, and
  others.
- **Subagents** - delegate a self-contained task to a named agent profile
  running in its own context; several can run at once. See
  [Subagents](#subagents).
- **Long sessions** - steer mid-task, edit & resend any message, image and
  PDF attachments, automatic context compaction.
- **Proxy-aware** - follows your proxy settings, VS Code's, the environment,
  or the OS system proxy; a scan finds the Clash/v2rayN client already
  running on your machine. Per-MCP routing (auto / via proxy / direct).
- **Persian-first** - fa UI, Jalali dates, Persian error explanations, and
  colloquial Farsi replies when you ask for them.

## Browser control

Open the **Browser** tab, enter a website or a local dev-server URL, and interact
with the live page. Move the tab to the sidebar to keep the conversation beside
it. The agent uses the same page: it can inspect accessibility and console/network
diagnostics, capture screenshots, navigate, click, type, scroll, run page JavaScript,
and resize the viewport. Agent actions require approval unless YOLO is on; plan
mode only allows inspection of an already-open browser.

Xratu launches installed Chrome or Edge on demand, or uses the absolute executable
path in `xratu.browserExecutablePath`. Chromium runs inside the extension host's
environment with its sandbox enabled and an isolated, temporary profile. In a
remote VS Code window, URLs such as `localhost:3000` refer to the remote host.
There is no automatic browser download. Launch failures appear in the tab.

The page survives tab moves and webview reloads within the same chat; switching
chats, closing the browser, or reloading VS Code discards it. Offline mode closes
existing browser connections and permits only loopback requests after reopening.
This first version supports one page per chat; popups and downloads are blocked.

## Models

| Group | Providers |
|-------|-----------|
| Cloud | OpenAI, Google Gemini, OpenRouter, xAI, Groq, DeepSeek, Mistral, Perplexity, Cohere, Together, Fireworks, Cerebras, NVIDIA NIM, Hugging Face, SambaNova, Moonshot, Z.AI, OpenCode Zen |
| Iranian | Kaya AI, Avalai, Metis AI, Liara AI, ArvanCloud AI, Navaan, GapGPT |
| Local | Ollama, LM Studio, vLLM, llama.cpp |
| Custom | Any OpenAI-compatible HTTPS endpoint |

## For developers in Iran

- **Iranian gateways as first-class presets** - Kaya AI, Avalai, Metis AI,
  Liara AI, ArvanCloud AI, Navaan, and GapGPT sit in their own group in
  Settings → Providers, take rial payment, and need no VPN. Usage costs show
  in Toman on the Usage page.
- **Proxy-native** - Iranian setups route through Clash/v2rayN "System
  Proxy" mode; Xratu picks it up (no TUN needed), scans for the local
  client and its ports, and routes MCP traffic per server.
- **Persian in, Persian out** - fa UI, Jalali dates, Persian error
  explanations, and with reply language set to Persian the agent writes
  colloquial Farsi - the bundled `natural-farsi` skill is preloaded, so the
  register holds from the first token.
- **No circumvention advice** - when an endpoint is unreachable or a signup
  fails, the agent maps working alternatives (domestic gateways, local
  models, Iranian PaaS) instead of VPN guides.

### Provider endpoints

| Provider | Base URL | Notes |
|----------|----------|-------|
| Kaya AI | `https://kayaai.ir/api` | preset ships the endpoint |
| Avalai | `https://api.avalai.ir/v1` | preset ships the endpoint |
| GapGPT | `https://api.gapgpt.app/v1` | preset ships the endpoint |
| Metis AI | per-service | paste the endpoint from your service page |
| Liara AI | per-service | each AI service has its own URL |
| ArvanCloud AI | per-service | paste the endpoint from your service page |
| Navaan | per-service | paste the endpoint from your service page |

All speak the OpenAI-compatible API. The first three work with nothing but
the API key; the rest hand each service its own URL at signup.

### Sign in with a ChatGPT subscription

In **Providers**, choose **Add connection → Continue with ChatGPT** and approve
plan access in the browser. If the callback cannot reach VS Code, paste the
complete redirect URL from **Browser didn’t connect?**. Xratu stores the
connection in VS Code SecretStorage. Older connections may need a fresh sign-in.

Plan usage appears separately from API-key costs on the **Usage** page. See
OpenAI's [sign-in integration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
for details.


## Getting started

Install from the VS Code Marketplace:
[xratu.xratu](https://marketplace.visualstudio.com/items?itemName=xratu.xratu)

Prefer a manual install? Grab the latest `xratu-*.vsix` from
[Releases](https://github.com/thesamehosuh/xratu/releases) and install it
via **Code → Extensions → ⋯ → Install from VSIX…**

1. Open the Xratu panel from the activity bar.
2. Pick a preset or a local runtime, paste your API key, choose a model.
3. Chat. Approve edits and commands as the agent works - or turn on
   auto-approval once you trust the loop.

## MCP servers

Xratu reads server config from two files:

- **Global**: `mcp.json` in the extension's global storage
- **Workspace**: `.xratu/mcp.json` in the workspace root (overrides global
  per server key)

Format is Cline-compatible: `command`/`args`/`env` for stdio, `url` for
remote. Tools surface to the agent as `mcp__<server>__<tool>` and follow the
same approval flow as built-ins.

Fresh installs enable the official [Zarinpal documentation MCP](https://www.zarinpal.com/docs/mcpDocs/)
for payment integration docs and error lookup. It needs no API key and only
reads public documentation. Existing MCP configuration is preserved; existing
users can add Zarinpal from the curated marketplace. Web research is built in.
Add **[Digikala](https://github.com/sepehr071/digikala-mcp),
[Torob](https://github.com/mmdju/torob-mcp) and
[Divar](https://github.com/mmdju/divar-mcp)** from the marketplace when you want them.
These integrations require explicit opt-in before connecting or running local code. Iranian
servers lead the curated marketplace list, and **Iranian** is the first tag
filter. Digikala
requires `uv`; Torob runs locally and requires Node.js and Git; Divar uses
its hosted HTTP endpoint. Torob downloads and builds dependencies on its
first launch; its startup budget is two minutes. If installation cannot finish
within that budget, install the pinned package separately before enabling it. These unofficial integrations are read-only and
need no API keys. Existing config (including disabled or removed servers)
is preserved; existing users can add them from the marketplace.

The bundled [`iranian-marketplaces` skill](../assets/skills/iranian-marketplaces/SKILL.md)
helps the agent choose the right source, compare sellers and variants, and
handle Toman prices, rental deposits and placeholder asking prices. It is
available on both fresh installs and upgrades; enable or disable it on the
Skills page independently of the servers.

### Marketplace

The MCP page also has a **Marketplace** tab, so you are not limited to servers
you type in by hand:

- **Sources** are configurable (`xratu.mcpMarketplaceSources`). Defaults are the
  public catalog published by the Cline project (Apache-2.0) and the official
  MCP registry; any http(s) catalog URL works, and an empty list turns remote
  catalogs off.
- Catalogs are fetched **host-side, through your proxy**, cached for 24 hours,
  and always merged with a curated list that ships inside the extension, so the
  tab keeps working offline.
- Adding is **never silent**: the row shows the exact command or URL, and the
  confirm step shows the config that will be written. Entries that need a
  credential open the edit form instead. Tool auto-approval is never taken from
  a catalog.
- An entry a catalog ships without install metadata can be resolved from its
  README on request; anything guessed that way is labelled and reviewed before
  it is saved.

## Agent Skills

A skill is a folder with a `SKILL.md` file - YAML frontmatter
(`name` + `description`) plus a markdown body. Only the name/description
load up front; the agent pulls in the rest via its `skill` tool when your
request matches. Search order (first match wins):

- `.xratu/skills/<name>/SKILL.md`
- `.agents/skills/<name>/SKILL.md` (shared with other agent tools)
- `.claude/skills/<name>/SKILL.md` (Claude Code)
- `~/.agents/skills/<name>/SKILL.md`
- `~/.claude/skills/<name>/SKILL.md` (Claude Code)

```markdown
---
name: deploy-staging
description: Deploy the app to staging; use when the user asks to deploy or ship to staging.
---

1. Run the test suite
2. Build the app
3. `npm run deploy:staging`
```

Extra files (scripts, references, templates) go next to the `SKILL.md`.
Enable/disable skills in Settings → Servers & skills → Skills.

### First-party skills

Xratu ships eight skills, seeded to `~/.agents/skills` when first introduced (so
Claude Code, OpenCode, and the other agent tools see them too), editable
like any skill, and switchable per skill in Settings → Servers & skills →
Skills:

New bundled skills are added on upgrade. User-edited copies are preserved,
and deleted skills stay deleted.

| Skill | What it does |
|-------|--------------|
| `natural-farsi` | Writes Persian in the chosen formal or informal register, with shared house orthography and technical vocabulary. Preloaded when reply language is Persian. |
| `finglish-normalize` | Reads Finglish (Persian in Latin script) as Persian and matches the reply language and script to you. |
| `jalali-dates` | Jalali (Shamsi) dates in prose; machine-readable dates stay ISO. |
| `iran-dev-access` | Research service availability, payment options, and alternatives from Iran. |
| `iran-connectivity-fallback` | Diagnose repeated provider connection failures and explore appropriate alternatives and network fixes. |
| `local-llm-low-ram` | Honest sizing math for running models locally on small machines. |
| `native-downloads` | Managed downloads, route selection, verification, and recovery without discarding saved progress. |
| `iranian-marketplaces` | Chooses Digikala, Torob or Divar tools for shopping and classifieds; compares sellers, variants and prices in Toman, and handles rental deposits and placeholder prices. |

## Subagents

The profile format below applies to the built-in engine. OpenCode uses its own
native agent definitions; Xratu displays those as a read-only inventory.

A subagent is a child conversation with its own history, assignment and model.
The built-in coordinator stores child sessions on disk, so follow-ups and
continuations reuse the same child after a window reload. A profile supplies
the starting instructions and capabilities; changing its file does not rewrite
children that already exist.

| Profile | Capabilities |
| --- | --- |
| `explore` | Reads and searches files and web evidence; no shell or editing tools. |
| `verify` | Runs approval-gated tests and commands; commands can write build artifacts. |
| `general` | Inspects, edits, runs commands and verifies results. |

`xratu.maxParallelSubagents` (default 4) bounds active child executions. Extra
assignments queue without being discarded. Mutation-capable children hold a
shared-checkout writer lease; parent mutations wait for that lease too.
Read-only exploration can run concurrently. This coordination is not a shell
sandbox or file isolation; separate Git worktrees are not created automatically.

### Working with child conversations

Open **Agents** to choose a conversation. At sidebar width the list opens into
a full-height child conversation; wide panels show both. Drafts survive child
switches and are saved through VS Code's local webview state.

- Send instructions directly to a running child; they are delivered at the next
  safe model boundary. The parent can send follow-ups too.
- Stop one child without stopping siblings. Continue the same conversation
  after its execution settles.
- Answer a child's scoped question or approval in its conversation. The same
  decision can also appear in the parent, with one authoritative resolution.
- Change its model, reasoning effort or round limit between executions.
- Use **Report to parent** to hand back a manually launched investigation.
  Delivery status records the handoff separately from execution completion.

**Agent profiles** can launch a fresh child from an assignment or open a custom
profile's source file. The parent has `spawn_agent`, `send_agent`,
`inspect_agents`, `wait_agents` and `stop_agent`; `task` remains the foreground
compatibility tool. Background launch returns immediately. Required results
should be received with `wait_agents`, without polling the inspector.

OpenCode keeps its native sessions, permissions and report inbox. The redesigned
view supports native observations, attributed decisions and individual Stop.
While a verified native child is running, direct messages enter its native
inbox. Once the native tree settles, further work is delegated through the
parent. Native history observations remain bounded, and built-in model/limit
controls are not presented as native settings.

A reload interrupts built-in execution rather than silently repeating tool
calls. Committed child history and reports survive. A tool with an interrupted
result is treated as having uncertain effects. Old traces remain readable;
a trace without a saved child ledger is not offered as a resumable conversation.
Checkpoint restore invalidates the discarded child's future context.

Background processes still use the **Background** tab. Child executors cannot
start unowned background jobs or control another session's processes.

### Writing an agent file

Run **Xratu: Agent Files** from the command palette to see every profile
Xratu loaded - including the ones that failed and why - and to scaffold a new
one. Files are plain markdown with YAML frontmatter; the body is the
subagent's system prompt. Search order (first match wins):

- `.xratu/agents/<name>.md`
- `.agents/agents/<name>.md` (shared with other agent tools)
- `.claude/agents/<name>.md` (Claude Code)
- `~/.agents/agents/<name>.md`
- `~/.claude/agents/<name>.md` (Claude Code)

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
| `name` | Optional; must match the file name (lowercase, digits, single hyphens). |
| `description` | **Required.** When to delegate to this agent - the model picks profiles from this line. |
| `tools` | Optional allow-list of tool names. Omit it for the child toolset. Parent orchestration, parent-session controls, `ask_user_question` and shared process control are always removed. Use `ask_session_question` for an attributed child question. |
| `model` | Optional. Run this profile on a specific model (its context window and output cap follow that model). Default: the parent session's model. |
| `reasoning_effort` | Optional: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `max_rounds` | Optional loop budget for this profile (default 50). |

`tools:` names are checked against the tools your install actually has when
the file loads. Names that do not exist are dropped with a warning, and a
list where **none** of the names exist is a hard error rather than a
subagent that silently cannot do anything - worth knowing, because agent
files written for other tools spell them `Read`, `Grep`, `Bash`. Run
**Xratu: Agent Files** (or look in the **Xratu** output channel) to see
these.

Built-in children cannot delegate recursively or change the parent's task list
or mode. Their writes and commands keep real approval gates. Agent tool
restrictions must use the supported comma-separated syntax; unsupported YAML
restriction forms are rejected rather than treated as unrestricted access.
Child history does not contain provider keys; credentials remain in VS Code
secret storage, and native credentials stay native.

## Proxy

Settings → Proxy controls outbound routing:

- **Modes** - `auto` (Xratu setting → VS Code → environment → OS system
  proxy), `custom` (one explicit proxy URL plus a no-proxy list), or `off`.
- **Local client scan** - finds the Clash family (Clash Verge Rev, mihomo,
  Mihomo Party, Clash Nyanpasu, ClashX), v2rayN/v2rayA, or Surge already
  running on your machine and locks to its ports. "System Proxy" mode is
  enough - no TUN required.
- **Web search** - use the configured proxy or connect directly, independently
  of model routing.
- **Per-MCP routing** - each MCP server can ride auto / via proxy /
  direct, with a live connection test before you commit.
- MCP marketplace catalogs are fetched host-side through the same proxy and
  cached for 24 hours.

## Privacy

Model API keys are stored in VS Code secrets storage. MCP header/environment
values entered through Servers are saved as secret references. Existing or
hand-edited MCP JSON may still contain raw secrets; do not commit it. Native
credentials stay with OpenCode. Chat history and checkpoints live on your disk.

Web research runs automatically, including in Plan mode. `web_search` sends
public queries to anonymous Parallel Search MCP, falling back to anonymous
Exa for availability or quota failures. There is no account or provider setup.
Anonymous quotas can temporarily prevent research; failures remain visible.
Legacy Brave/SearXNG/key settings are no longer used. Old key values are not
silently erased; remove them from user/workspace settings if previously saved. Optional DDG and marketplace
MCP presets are disabled on fresh installs; existing MCP files are not rewritten.

`fetch_url` reads public pages directly, preserving Markdown, code and links,
and supports bounded PDF text extraction. Clean URLs observed in this chat's
public search results can fall back to Parallel extraction. Other URLs and
URLs with query strings/fragments stay direct-only. Hosted services receive
only the query or eligible URL and a random per-chat identifier; no model
analytics, provider keys, cookies, local paths or native session IDs are sent.
URL heuristics do not prove confidentiality. Direct page reads use the normal
proxy routing; the Proxy page's Web search buttons govern hosted research.

Source rows record retrieved evidence and unknown dates, not a guarantee that
the answer cited every row. Temporary page handles support `find` and character
continuation and expire after five minutes. Documents are not cached on disk.
Observed source metadata and outcomes remain in local chat history.
OpenCode uses the same Xratu research executor; its legacy native search/fetch
are denied. Native definitions may remain visible in custom runtimes.
[Implementation and measured limits](web-research-delivery.md).

MCP servers, skills, and agent files are read from your disk. There is no
telemetry, no analytics, and no crash reporting in the extension. Report a
vulnerability through [SECURITY.md](../SECURITY.md), not a public issue.

## Development

```bash
npm ci
npm run compile        # host bundle (esbuild) + webview (vite)
npm run test:webview
```

CI type-checks host and webview separately and runs the test suites on
Ubuntu, Windows, and macOS. See [AGENTS.md](../AGENTS.md) for details.

## Contributing

Issues and PRs welcome. Open an issue before large changes. Conventional
Commits, CI green, and code review required for every PR.

### Local runtimes and connection comparison

Use Ollama, LM Studio, vLLM, or llama.cpp by selecting a discovered runtime in
**Providers**. The bundled [offline and hardware guide](../assets/guides/offline.en.md)
covers setup and model sizing. **Offline mode** limits Xratu-managed requests
to loopback services and disables web and external MCP tools. Terminal commands
remain unrestricted.

For Ollama at `localhost:11434`, **Manage Ollama models** can download or
remove models. Manage models for other runtimes in their own apps.

Iranian presets link to official onboarding pages. The bundled [provider comparison](../assets/guides/providers.en.md) separates verified pricing/payment information from unverified tariffs. **Compare connection latency** sends a small, opt-in request to the active model and shows first-text-token time, total time, and known rates/estimated cost. No project context is sent; requests may incur charges. Compare the same model across connections and repeat measurements instead of treating a single sample as a ranking.

Marketplace visual regressions are CI-gated on Linux for fa/en at 420px/900px, including catalog, confirmation and offline states. Baselines use the bundled font and lockfile-pinned Chromium; the same layout checks run on Windows and macOS. To deliberately update them, review the generated images after running `XRATU_VISUAL=1 npx playwright test -c test/e2e/playwright.config.ts marketplace.spec.ts --grep 'visual contract' --update-snapshots` on Linux.

## License

[Apache-2.0](../LICENSE)
