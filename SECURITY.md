# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private advisory form instead:

<https://github.com/thesamehosuh/xratu/security/advisories/new>

Include the extension version, your VS Code version, your OS, and reproduction
steps. You should get an acknowledgement within a few days.

Fixes ship in the next release. Only the latest published version receives
security fixes, so update before testing anything you have reported.

## What is in scope

Xratu runs an agent loop with terminal access inside your workspace, so most
reports are configuration choices rather than vulnerabilities. These are the
bugs we want to hear about:

- **Workspace escape** - a file tool writing or reading outside the workspace
  through a `sanitizePath` bypass, a symlink, or a traversal segment.
- **Secret exposure** - an API key or stored token reaching a log, a model
  request, a checkpoint, or any destination this README does not document.
- **SSRF guard bypass** - `webTools.ts` reaching loopback, link-local, cloud
  metadata (`169.254.169.254`), or a private range via a redirect, a DNS
  rebind, or an encoded address.
- **Webview injection** - anything escaping `_sanitizeHtml`'s allowed tags and
  attributes to run script in the webview origin.
- **Checkpoint integrity** - a snapshot that writes into your own git repo, or
  a restore that touches files the snapshot never captured.
- **Plan mode** - a mutating tool reachable while plan mode is on, including
  an external MCP tool.

## What is not a vulnerability

- **The agent doing what you approved.** Terminal commands run behind the
  approval gate; YOLO mode and per-tool auto-approve remove it deliberately.
  Widen either one only as far as you trust.
- **Requests to endpoints you configured** - your model provider, your SearXNG
  instance, Brave or Parallel for web search. The Privacy section of the README
  documents each one.
- **Prompt injection.** A model acting on instructions it read in a file, a
  skill, or a web page is inherent to the design. The mitigations are the
  approval gate and the fact that nothing executes without it.
- **A third-party MCP server doing what its author wrote it to do.** Review
  catalogs before adding them; auto-approve is never taken from a catalog.
- **Needing elevated privileges to install an MCP server's dependencies.**

## Security-relevant invariants

These are deliberate and covered by tests. A change that weakens one needs to
say so in the PR description:

| Behavior | Where |
|----------|-------|
| Path guards on every file-tool path | `src/paths.ts` |
| SSRF validation on every fetch, every redirect hop | `src/webTools.ts` |
| Webview HTML sanitizing | `_sanitizeHtml` |
| Checkpoints are shadow-git, never the user's repo | `src/shadowGit.ts` |
| Mutating tools dropped in plan mode, deterministically | `src/mcp.ts` |
| Terminal gate is approval-based, not a shell blocklist | `src/mcp.ts` |