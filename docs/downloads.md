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

## Local verification and archives

`verify_file` streams an existing workspace file through SHA-256, optionally
checking a publisher digest. Its default input limit is 20 GiB (maximum 1 TiB).
`inspect_archive` lists ZIP, TAR and TAR.GZ/TGZ contents without writing files;
it returns totals and at most 200 entries, while validating the whole inventory.
ZIP inspection reads metadata, not payload CRCs. Both tools are read-only,
available in plan mode, and work offline without a download-service instance.

`extract_archive` uses the normal approval gate and a shadow checkpoint before
writing. Native parent/child calls share the same gate; plan mode denies it in
both the advertised catalog and the executor. It creates a new workspace
directory with exclusive `mkdir`; the parent must already exist. An existing
directory, including an empty one, is refused. Files use exclusive creation.
Cancellation and errors close streams/handles before removing owned output;
cleanup checks the destination directory identity before removing it.

The implementation uses the existing `tar` parser, `yauzl` for streaming ZIP
reads and `crc-32` for ZIP payload integrity. These are bundled JavaScript
libraries, with no platform binaries, subprocesses or shell commands. Archive
formats are detected from content, so a downloaded file need not have a suffix.
An optional SHA-256 is checked against the same open source handle before any
output directory is created. The source's identity, size and modification times
are checked after reading to catch concurrent changes. Hashing without a trusted
expected value does not authenticate a file.

Input archives are capped at 20 GiB. Expanded files default to 1 GiB, with an
agent-selectable maximum of 20 GiB. At most 10,000 entries and output paths
(including implicit parents) are allowed; agents can lower that limit. TAR
metadata records are capped at 64 KiB each, and the complete uncompressed TAR
stream also has a bounded overhead budget. Paths have at most 32 components and
1,024 UTF-8 bytes. Absolute, traversing, reserved, Windows-unsafe and `.git`
paths are refused on every platform. Case and Unicode normalization aliases,
duplicates and file/directory conflicts fail. Links, devices, FIFOs, encrypted
ZIPs and unsupported formats/types fail explicitly. Only ordinary executable
bits are retained; ownership, timestamps, ACLs and special permission bits are
not restored. Extraction never executes a downloaded file. The existing
`sanitizePath` workspace/symlink guard applies to sources and destinations;
this does not provide isolation from other local processes racing filesystem
changes.

`npm run test:archives` covers all supported formats, hostile paths encoded
independently of the host OS, case/Unicode collisions, CRC/SHA failures, partial
cleanup, cancellation during writes, limits, and built-in/native plan gating.
It runs through the existing host-test discovery in Linux, Windows and macOS CI.

## Validation

`npm run test:downloads` exercises real HTTP streaming, dropped connections,
resume validators, route decisions, stalls, backoff, cancellation, reload,
integrity, path/redirect guards, collisions and concurrency. Plan/native tool
tests cover bridge gating; webview/e2e tests cover read-only behavior, docking,
locale changes and narrow/wide layouts.
