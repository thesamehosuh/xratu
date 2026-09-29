# Xratu

<p align="center">
  <img src="assets/brand/logo-128.png" width="88" alt="Xratu" />
</p>

<p align="center">
  <a href="#xratu">English</a> ·
  <a href="README.fa.md">فارسی</a>
</p>

<p align="center">
  <a href="https://github.com/thesamehosuh/xratu/actions/workflows/ci.yml"><img src="https://github.com/thesamehosuh/xratu/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/VS%20Code-1.90%2B-007ACC.svg" alt="VS Code 1.90+" />
</p>

Open-source AI coding agent for VS Code. Bring your own key or use a local
runtime. Everything runs inside the extension host, on your machine.

## Your keys. Your models. Your machine.

- API keys live in VS Code secrets storage and go only to the endpoint you
  configure.
- Fully offline capable: Ollama, LM Studio, vLLM, and llama.cpp are
  auto-discovered on your machine.

## Features

- **Agentic coding** - reads files, edits code, runs terminal commands,
  searches the web. Every edit and command needs your approval; per-tool
  auto-approve if you trust a workflow, YOLO mode if you don't want the gate.
- **Plan mode** - read-only planning with a task list. Mutating tools are
  blocked in code, not by prompt.
- **Checkpoints** - shadow-git snapshots before sends and edits, restorable
  anytime. Your real git repo is never touched.
- **MCP servers** - stdio, WebSocket, or streamable HTTP/SSE, with
  Cline-compatible files-based config.
- **Agent Skills** - the open [agentskills.io](https://agentskills.io)
  standard; skills can be shared with Claude Code, Roo Code, OpenCode, and
  others.
- **Long sessions** - steer mid-task, edit & resend any message, image and
  PDF attachments, automatic context compaction.
- **Proxy-aware** - follows your proxy settings, VS Code's, the environment,
  or the OS system proxy; a scan finds the Clash/v2rayN client already
  running on your machine. Per-MCP routing (auto / via proxy / direct).
- **Persian-first** - fa UI, Jalali dates, Persian error explanations, and
  colloquial Farsi replies when you ask for them.

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
  Settings → API keys, take rial payment, and need no VPN. Usage costs show
  in Toman on the Usage page.
- **Fully local is fully offline** - a local runtime (Ollama, LM Studio,
  vLLM, llama.cpp) makes the agent complete with zero network dependency.
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

Xratu ships six skills, seeded to `~/.agents/skills` on first run (so
Claude Code, OpenCode, and the other agent tools see them too), editable
like any skill, and switchable per skill in Settings → Servers & skills →
Skills:

| Skill | What it does |
|-------|--------------|
| `natural-farsi` | Writes Persian the way Iranian developers actually type - colloquial register (رو not را), no half-spaces, technical terms left in English. Preloaded automatically when reply language is Persian. |
| `finglish-normalize` | Reads Finglish (Persian in Latin script) as Persian and matches the reply language and script to you. |
| `jalali-dates` | Jalali (Shamsi) dates in prose; machine-readable dates stay ISO. |
| `iran-dev-access` | What works from Iran and what to use instead - domestic gateways, local models, Iranian PaaS. |
| `iran-connectivity-fallback` | A provider timing out repeatedly? Offers the alternatives already configured on your machine - no circumvention guides. |
| `local-llm-low-ram` | Honest sizing math for running models locally on small machines. |

## Proxy

Settings → Proxy controls outbound routing:

- **Modes** - `auto` (Xratu setting → VS Code → environment → OS system
  proxy), `custom` (one explicit proxy URL plus a no-proxy list), or `off`.
- **Local client scan** - finds the Clash family (Clash Verge Rev, mihomo,
  Mihomo Party, Clash Nyanpasu, ClashX), v2rayN/v2rayA, or Surge already
  running on your machine and locks to its ports. "System Proxy" mode is
  enough - no TUN required.
- **Per-MCP routing** - each MCP server can ride auto / via proxy /
  direct, with a live connection test before you commit.
- MCP marketplace catalogs are fetched host-side through the same proxy and
  cached for 24 hours.

## Privacy

API keys are stored in VS Code secrets storage and sent only to the endpoint
you configure. Chat history and checkpoints live on your disk only.

## Development

```bash
npm ci
npm run compile        # host bundle (esbuild) + webview (vite)
npm run test:webview
```

CI type-checks host and webview separately and runs the test suites on
Ubuntu and Windows. See [AGENTS.md](AGENTS.md) for details.

## Contributing

Issues and PRs welcome. Open an issue before large changes. Conventional
Commits, CI green, and code review required for every PR.

## License

[Apache-2.0](LICENSE)
