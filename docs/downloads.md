# Native downloads

Xratu manages public HTTP(S) downloads inside the extension host. Agents use
`start_download`, `control_download` and `list_downloads` in both the built-in
runner and OpenCode's authenticated MCP bridge. Downloads is a read-only work
surface tab: there are no start, pause, resume, cancel, routing or configuration
controls for users to operate. Normal tool approvals still apply, including
native and built-in children. Plan mode permits only status reads.

## Engine decision

The implementation uses Node streams, file handles and Xratu's existing
`proxyFetch`/undici stack. There is no backend, binary installer, new dependency,
RPC daemon, inbound port, or persistent download process. This also avoids an initial download
of the download engine on the very connection that needs recovery.

aria2 was considered for segmentation, multi-source transfers and its mature
recovery support. Those advantages do not outweigh maintaining trusted binaries
for Windows/macOS/Linux and both architectures, RPC lifecycle/security, proxy
configuration, and GPL redistribution/source obligations for the HTTP file use
case. [aria2's license](https://aria2.github.io/) is GPL-2.0-or-later; a future
adapter must review distribution compliance before shipping binaries. No aria2
code or binaries are included here. New code follows Xratu's repository license;
the existing undici dependency retains its MIT notice in THIRD_PARTY_NOTICES.

## Transfer and recovery

- Two concurrent transfers, twenty unfinished records, one hundred retained
  records, a 20 GiB default per-file budget (agent-selectable up to 1 TiB).
  File data streams to disk with backpressure; hashing uses a 256 KiB buffer.
  Partial files are excluded from shadow checkpoints. Completed artifacts of
  50 MiB or more receive a path-specific shadow exclusion before publication,
  so later coding turns do not archive multi-gigabyte downloads. These files
  are consequently outside checkpoint restore; the user's gitignore/index are
  untouched. Smaller completed files follow normal checkpoint behavior.
  Exclusion failures are diagnostic only and never prevent delivering a file.
- A request or stalled body has a 30-second idle deadline. Transient transport,
  DNS and selected HTTP failures retry up to twenty times with exponential
  backoff and jitter (normally capped at 60 seconds). Retry-After is honored
  up to five minutes. No unbounded loop or automatic route switching.
- Same-directory `.xratu-download-<id>.part` files preserve received bytes.
  Metadata is serialized to an atomic manifest, checkpointed every five seconds
  and at state transitions. Restore trusts actual partial length, revalidates
  paths, and marks active records interrupted. An approved agent resume is
  required after a host restart; opening a workspace never silently downloads.
- Recovery sends Range and If-Range using a strong ETag or Last-Modified.
  Content-Range, lengths, validators and identity encoding are checked before
  appending. A source that changes, ignores Range, or lacks a usable validator
  requires an explicit restart. Partial bytes are never appended to a 200 body.
  Optional publisher SHA-256 is checked before publication. Without it, HTTP
  validators prevent accidental mixing but do not prove publisher authenticity.
- Final publication uses an exclusive same-directory hard link, then removes
  the partial. Existing files, including destination races, are never replaced.
  NTFS, APFS and ext4 support this; filesystems without hard-link support fail
  safely with `downloadFileError`. A crash during publication can leave a final
  file and/or partial needing agent inspection; recovery never overwrites it.
- Cancel removes only the owned partial and its saved source URL. Completed
  files remain ordinary workspace files. Chat stop/session changes do not stop
  an accepted transfer. Extension shutdown aborts and checkpoints transfers.

## Routing and boundaries

`auto` honors configured proxy mode and no_proxy. `proxy` forces an already
configured HTTP(S) proxy, bypassing no_proxy and failing if unavailable.
`direct` bypasses it. Explicit modes do not change global settings. The model
can inspect proxy availability and the effective route without seeing proxy
credentials. The bundled `native-downloads` skill guides domestic-mirror,
blocked-source, expired-link and route-switch decisions. Source reachability is
evidence-driven; domain suffixes are not routing rules.

Every attempt and redirect applies the existing public URL guard with the
ACTUAL route: direct traffic resolves DNS locally even when a global proxy is
configured; proxied hostnames retain proxy DNS behavior, and private IP literals
remain forbidden on every route. The deliberate fake-IP allowance and accepted
DNS-rebinding TOCTOU from webTools are unchanged. HTTPS-to-HTTP redirects,
embedded credentials, non-HTTP protocols and custom authentication headers are
unsupported. Offline mode aborts managed network requests and blocks resumes;
turning it off does not silently restart paused downloads.

Destinations stay inside the current workspace through sanitizePath, including
symlink checks. `.git` and managed partial names are reserved. Ownership is
workspace-scoped, never a chat ID; another active window is refused by an owner
lock. Owner records include host/PID namespace, process incarnation and kernel
boot identity where available;
an in-process registry distinguishes live owners from abandoned instances in
the same extension host. A short directory mutex serializes claims and releases,
and owner records are written atomically. Malformed/stale records recover without
manual deletion. Windows uses the existing asynchronous process-identity probe
only during ownership checks. Foreign-host/namespace owners and unverified live
processes are refused. The acquisition mutex retains the existing OAuth lock's
documented stale-reclamation TOCTOU limitation.

Restored history validates paths lexically without requiring completed targets
to still exist or resolve. Unsafe unfinished destinations fail individually;
they do not prevent other downloads. Cancellation can discard such a record's
source credentials without following an unsafe path to delete its partial file.

Source URLs can carry signed queries and are stored through VS Code
SecretStorage. Manifests, status results and UI contain only the source origin.
Tool arguments still follow normal local conversation-history retention; do
not treat signed URLs supplied to an agent as absent from chat history.

Progress is published directly to the webview at most once per second between
state changes. It never enters the model ledger and never wakes a model. There
is no completion-driven automatic next turn; agents inspect status when a
dependent task needs the file. A server with unknown length can finish at EOF;
use the publisher checksum to detect application-level truncation in that case.

## Validation

`npm run test:downloads` exercises real HTTP streaming, dropped connections,
resume validators, route decisions, stalls, backoff, cancellation, reload,
integrity, path/redirect guards, collisions and concurrency. Plan/native tool
tests cover bridge gating; webview/e2e tests cover read-only behavior, docking,
locale changes and narrow/wide layouts.
