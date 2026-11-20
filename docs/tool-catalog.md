# Model tool catalog

The built-in runtime uses one first-party capability policy in
`src/tooling/toolPolicy.ts`. It controls advertisement, approval effects and
Plan-mode admission. Executors also reject names outside that policy. External
MCP capabilities retain server-specific approval and offline restrictions.
Native engines keep their own file/shell tools; Xratu bridges its host services.
Tool schemas remain fixed for each run.

## Breaking contracts

- `write_file`: whole-file create/overwrite/append, with existing overwrite guards.
- `edit_file`: `path` and `edits: [{old_text, new_text}]`. Every match must be
  unique. All edits validate before writing; failure leaves the file unchanged.
- `read_file`: either `path` with range arguments, or `files`, an array of
  independently ranged requests. Batch output shares an 80 KB budget.
- `list_files`: depth, hidden-entry and pagination controls replace a separate tree.
- `symbols`: `path` lists document symbols; `query` searches workspace symbols.
- `browser_open`: opens or navigates the shared tab; `browser_fill` replaces a
  field's value. `browser_wait_for` provides bounded readiness checks.
- `link_pull_request(linked: false)` unlinks and stops watching;
  `watch_pull_request(enabled: false)` stops watching and withdraws queued updates.

There are no legacy tool-name aliases. Old calls receive an unavailable-tool
error; the model must use the current catalog.

Generic Git wrappers, dependency inspection/installation, test-runner wrappers,
file metadata and copy/move/delete wrappers have been removed. Use approved
terminal commands that follow the repository's actual conventions.

## Host capabilities retained

Browser control, managed downloads, guarded archive inspection/extraction and
verification, PR tracking/watching, process ownership, questions, task lists,
skills and delegation remain supported. Plan mode and child restrictions still
apply. Native child sessions cannot change parent PR tracking or watches.

`view_image` reads bounded PNG/JPEG/GIF/WebP files. Terminal commands accept a
workspace-relative working directory, timeout, bounded yield and initial input.
`interactive: true` keeps piped input open; `process_input` delivers further
input through a separate approval gate. This does not allocate a PTY. Existing
background ownership, process-tree cancellation and exit-code reporting remain.

Free-text questions omit `options`. Multiple-choice questions require at least
two labeled options. Tool labels continue to resolve through both locales.
