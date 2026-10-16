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
rewind. OpenCode uses its own credentials and native sessions; subagents,
conversation rewind, and offline mode are currently unavailable with that engine.

## Pull requests

The agent links PRs it creates or works on to the conversation. Linked PRs
appear beside the composer and in Activity, showing check status and whether
the agent is watching. Select an indicator to see checks and reviews in the
**Pull requests** sidebar, which appears only after a PR is linked.
Install GitHub CLI and run
`gh auth login` first. This integration currently supports github.com; Git push
authentication remains separate from GitHub API authentication.

**Watch** checks for new failures, passing required checks, comments/reviews,
and conflicts every 30 seconds while the VS Code extension host is running.
Links, cursors, and pending updates survive reloads. Offline mode pauses reads;
closing VS Code pauses monitoring. GitHub rate limits pause retries without
ending a watch. Own-account comments are excluded to prevent reply loops.

Ask the agent to watch a PR to continue the owning conversation when updates
arrive. You can also start or stop a watch from its details. This uses the selected model's
budget and retains normal approvals. If the conversation is inactive, busy,
or its branch, model, account, or engine changed, updates wait in its PR panel;
the session picker shows pending updates, and **Review with agent** delivers
them into the current context. Interrupted continuations require
an explicit retry. **Stop watching**, **Unlink**, and the conversation's Stop
action withdraw pending continuations. Close/merge, eight failed reads, or ten
consecutive comment-only updates also end a watch.

Both engines expose `link_pull_request`, `unlink_pull_request`,
`list_thread_pull_requests`, `get_pull_request`, `watch_pull_request`, and
`unwatch_pull_request`. Agents link PRs they create using the link tool.
Subagents can read PR state but cannot change links or watches; the parent
conversation owns monitoring. PR tools do not merge or publish changes.

For `git_commit`, `files` commits only the selected paths' current working-tree
contents and preserves unrelated staged work. Without `files` or `stage_all`,
it commits the existing staged index. Staging errors stop the operation.

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
