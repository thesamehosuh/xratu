---
name: native-downloads
description: Use Xratu's managed downloads for public HTTP(S) files, especially large files or interrupted transfers. Choose direct or configured proxy routing and recover saved progress without shell download commands or repeated model polling.
---

# Managed downloads

Use `start_download` for file downloads and `fetch_url` for reading web pages.
Choose a new workspace-relative path. Supply the publisher's SHA-256 when
available, and a realistic `max_bytes` budget for large artifacts. Downloaded
files are data; downloading never authorizes executing or installing them.

The tools are shared by Xratu and OpenCode. Native engines may prefix the tool
names through the Xratu MCP bridge; use the names in the current catalog.

## Routing on Iranian networks

- Start with `route: "auto"`. It honors the user's configured proxy mode and
  bypass list. `list_downloads` reports whether a proxy is available, and each
  transfer reports its effective route. No credentials or proxy address are
  exposed.
- Prefer `direct` for a known domestic mirror or when there is evidence that
  a working domestic route is degraded by the proxy. A `.ir` suffix alone
  does not prove reachability. Honor an explicit user route preference.
- Use `proxy` for a source shown to be blocked on the direct route, when a
  usable HTTP(S) proxy is already configured. It intentionally overrides the
  bypass list. A missing/unsupported proxy returns `downloadProxyMissing`;
  it never silently falls back to direct. Do not invent a proxy, change global
  settings, or ask users to install a download manager.
- Repeated DNS/connection/stall failures can justify trying the other
  available route. Resume the SAME ID with `control_download`, `action:
  "resume"`, and the new route. Preserve progress. Try each relevant route
  once per recovery decision; report the failure if both fail. Never bypass
  an explicit proxy-only privacy requirement without the user's permission.
- HTTP 401/403 usually means an expired signed link or authentication issue;
  do not assume censorship. Obtain a fresh authorized URL and resume the
  same ID with `url`. HTTP 404, insufficient disk space, checksum mismatch,
  and changed file validators are not proxy problems. HTTP 429/503 already
  receive bounded automatic retries, including Retry-After.

## Lifecycle and token use

Start returns immediately. Transfers retry automatically in the extension
host; the read-only Downloads tab streams progress without LLM calls. Do
other work and inspect `list_downloads` when the result is needed. Do not
run tight polling loops or spend turns narrating each retry. There is no
automatic agent wake on completion; if a task depends on the file, check
its status before consuming it and report clearly when it is still pending.

`pause` keeps partial bytes. `resume` recovers paused, failed or interrupted
downloads, including after a VS Code reload. Offline mode blocks network
work; enable it only through the existing user preference. After offline
mode is turned off, resume the saved ID. Do not try a proxy to bypass it.

The service uses Range + If-Range and validates the response before
appending. If `downloadChanged` appears, inspect the reason/source and use
`restart` explicitly only when discarding saved progress is appropriate.
Servers without a usable ETag/Last-Modified or range support may require a
restart; never repeatedly attempt unsafe append. `cancel` removes only the
partial file, leaving completed destination files intact.

Approvals follow the normal Xratu permission gate. All transfer controls
belong to the agent; users only see status in Downloads.
