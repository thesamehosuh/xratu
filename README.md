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

An open-source AI coding agent for VS Code. Use free OpenCode models, bring
your own API key, or run a model locally. Available in English and Persian.

<p align="center">
  <img src="assets/brand/xratu-demo.gif" width="1080" alt="Xratu: setup, coding, approvals, and reviewing changes" />
</p>

## Get started

Install [Xratu from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=xratu.xratu).
For a manual install, download a `.vsix` from [Releases](https://github.com/thesamehosuh/xratu/releases)
and choose **Extensions → ⋯ → Install from VSIX…**.

1. Open your project folder in VS Code, then open Xratu from the activity bar.
2. Choose **Start free**, **Use my provider**, or **Run locally**.
3. Choose a model, click **Start chat**, and describe what you want to build or fix.

| Setup path | What you need |
|------------|---------------|
| **Start free** | Xratu can install OpenCode 2 for you. Free model availability and rate limits depend on OpenCode. |
| **Use my provider** | Connect your provider, including Iranian gateways or a custom OpenAI-compatible endpoint. |
| **Run locally** | Start Ollama, LM Studio, vLLM, or llama.cpp with a model loaded. |

To change your connection later, open **Settings → Providers**. Use
**Settings → Engines** to choose the engine for a new conversation.

## What you can do

- Ask the agent to read a codebase, edit files, run commands, and investigate bugs.
- Use **Plan mode** to explore and plan with changes blocked.
- Attach images, PDFs, or code, and steer the agent while it works.
- Inspect diffs in **Changes**, detailed output in **Activity**, and running
  commands in **Background**. Restore files from a checkpoint when needed.
- Work with the agent in a shared **Browser**, or extend it through **MCP**,
  **Skills**, and custom **Agents**.

The built-in Xratu engine supports local models, subagents, and conversation
rewind. OpenCode shares Xratu’s MCP servers, marketplace installs, browser,
task list, and enabled skills while keeping its own credentials and native
sessions. Its native subagents appear in Agents with live traces and attributed
approvals/questions; Stop covers nested and background children. The turn stays
active until their reports settle. Delegation is unavailable in Plan mode;
conversation rewind and offline mode remain unavailable with OpenCode.

## Approvals and privacy

Edits, commands, and tool actions use approval controls. **YOLO mode removes
those approval prompts**; enable it only when you want tools to run unattended.
Checkpoints use separate shadow git storage and leave your repository's git
index and history alone.

API keys use VS Code secrets storage. Chat history and checkpoints stay on your
machine. Prompts and relevant context go to your selected provider; web tools
and MCP servers contact their configured services. The extension has no telemetry.
For local-only use, choose a local model and enable **Offline mode**; terminal
commands remain unrestricted.

## More help

- [Full guide](docs/guide.md): OpenCode, checkpoints, browser, MCP, skills, subagents, and proxy settings.
- [Local models and hardware](assets/guides/offline.en.md).
- [Provider comparison](assets/guides/providers.en.md), including Iranian providers.
- [Report a bug](https://github.com/thesamehosuh/xratu/issues) or [report a security issue](SECURITY.md).

## Contributing

```bash
npm ci
npm run compile
```

See [AGENTS.md](AGENTS.md) for development, verification, and PR requirements.

[Apache-2.0](LICENSE)
