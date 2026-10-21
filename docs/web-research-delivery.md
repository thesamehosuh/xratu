# Automatic web research delivery

This implements the [audit](web-search-audit.md) as one PR. The maintainer's
subsequent decisions replace the audit's provider/key/settings proposal:
research is automatic, legacy search implementations and their settings are
retired, and the only new control is **Proxy → Web search → Via proxy / Direct**.
DDG remains a disabled-by-default catalog option. No new onboarding or research
configuration page is introduced. Offline and workspace trust remain host policy.

## Implementation

`src/webTools.ts` retains the public URL guard and compatibility exports.
`src/web/` owns the typed outcomes, fixed hosted MCP contracts, shared routing,
bounded transport, DOM/Markdown reader, PDF text and ephemeral document store.
Anonymous Parallel is attempted first, followed by Exa on availability, timeout,
protocol or quota failures. Empty results are final. Authentication denials are
visible. Search makes no paid or keyed requests and ignores the old
`webSearchProvider`, `webSearchUrl` and `webSearchApiKey` settings.

The total operation ceiling is 20 seconds, with a 9-second search attempt bound,
8-second body idle bound, 2 MB decompressed response cap, two calls per provider,
and at most 16 in-flight operations. Identical requests share work while each
caller keeps its own cancellation. Quota cooldowns honor Retry-After, bounded
between one second and an hour; availability cooldown is ten seconds. Searches
have no result cache. The reader keeps at most eight 500k-character documents
for five minutes. Search excerpts have per-source and aggregate budgets.

Domain inputs are plain hostnames. Queries use a union and returned URLs are
post-filtered by hostname/subdomain boundary. Freshness/language/country requests
are explicitly hints; index freshness stays unknown. Publication dates are kept
when provided. A version-aware docs workflow instructs every built-in/native
model to inspect installed versions and prefer matching official documentation.
The optional Context7 catalog preset now uses hosted HTTP.

Public reading negotiates Markdown, then converts a non-executing DOM to
Markdown, preserving headings, links, lists, tables and code indentation.
PDF reading uses the existing bounded text extractor with cancellation and
cleanup. Scanned PDFs and interactive pages return recovery guidance; browser
approval and Plan restrictions are unchanged. Hosted extraction is limited to
clean URLs observed in public search results in this chat. User-supplied URLs,
query strings and fragments are direct-only. URLs are validated before hosted
disclosure too. These heuristics do not establish confidentiality.

Outcome/source metadata is a bounded versioned display carrier, separate from
model history. It travels through the loop, saved sessions, restore, Activity,
and subagent observations. Legacy text cards still work. Generic external MCP
structured results have a bounded JSON carrier and a structured-only text
projection. Titles/excerpts render as untrusted text and link schemes are
validated. Source cards represent observed evidence; answer citation correctness
still requires model/evaluation judgment. No renderer infers that every card was
cited or that an arbitrary answer link was verified.

OpenCode receives the research pair through the existing narrow service bridge.
Native `websearch`/`webfetch` are denied, including at the live permission gate;
bridged research is allowed in Plan without exempting external MCP tools.
Real bridge execution with a deterministic loopback model passed Act and Plan
in both pinned 2.0.30 and custom 2.1.2. Display metadata is matched to the native session and exact result text, then
removed on consumption/settlement. Existing native credential ownership,
child attribution, Stop/cancellation and resume boundaries are retained. Native
definitions may remain visible; the prompt identifies the bridged pair.

External MCP calls are never automatically replayed after dispatch: their remote
outcome can be uncertain. Inventory discovery gives each session a snapshot of
healthy tools within 1.5 seconds while slower services continue for later sessions.
Fresh installs seed an empty MCP config; optional Iranian marketplace presets
remain visible. Existing/empty/disabled configurations are not rewritten.
Explicit MCP saves replace header/environment values with references to a
separate MCP-only SecretStorage namespace; existing hand-edited files can still
contain plaintext. Model and native credentials cannot be referenced through it.

The requested small UI changes are included: Persian PR status uses «ادغام شده»;
YOLO defaults on, applies through the existing whole-tree grant, and persists a
user's choice to require approvals. Plan still deterministically rejects mutation.

## Finding coverage

| Findings | Disposition |
| --- | --- |
| S01–S03, S11–S12, S20, X06 | Automatic anonymous service; legacy provider/key settings removed per maintainer instruction; no replacement configuration UI. |
| S04–S06, S15–S16, S21–S22, X01 | Typed durable failures, bounded routing/transport, quota/cancellation handling, no credential-bearing search requests; hermetic regressions. |
| S07–S10, S17, S19 | DOM/Markdown/PDF reader, focused/continued reads, bounded handles, honest hints, strict domain post-filter, official/version documentation workflow, hosted Context7 preset. |
| S13, S18, X02 | Structured source/outcome carriers, safe display and restore, untrusted-evidence/citation prompts; generic structured MCP projection. Automatic answer-support verification is not claimed. |
| S14, X10 | Narrow native bridge, denial of legacy native research, source attribution, protocol canaries and pinned/custom runtime checks. |
| X03 | No replay of uncertain external calls; regression proves a mutation is invoked once. |
| X04 | Bounded inventory startup with incrementally cached healthy inventories and immutable per-session schemas. |
| X05 | All optional first-run MCP integrations disabled; catalog and existing choices preserved. |
| X07 | Accurate privacy docs and MCP-only secret references on explicit saves; legacy search no longer reads keys. Existing manual JSON is not silently rewritten. |
| X08 | Existing DNS validation/connection race remains an explicitly accepted limitation; design below preserves proxy/fake-IP compatibility. No claim of IP pinning. |
| X09 | Lint baseline measured at 0 errors / 290 warnings; policy wording corrected without lowering rules or unrelated cleanup. Most debt is explicit `any`; remaining categories include React effect dependencies and unused values. |

## Measured validation and remaining release gates

- Mandatory lint, independent host/webview type checks, esbuild, webview tests and
  all 92 host suites passed during implementation. The full relevant browser run
  passed 207 checks, including research, Proxy, work surfaces, engine setup, downloads and
  onboarding. Both locales and sidebar/wide layouts were inspected with the
  shared VS Code theme fixture. Final-head results belong in the PR.
- Live anonymous smoke searches returned official FastAPI sources via both
  adapters (Parallel 3.8 s; Exa 4.9 s on this machine). Parallel page extraction
  returned full content separately from excerpts; the reader preserves that body.
- The opt-in [40-query retrieval run](completion/web-research-evaluation.json)
  returned 11 successes, one availability failure, then quota/cooldown failures.
  This burst run **did not meet** the proposed 95% retrieval gate. Nine of 19
  official-source cases retrieved an official source in the first five; remaining
  cases included requests stopped by quotas. Successful retrieval latency was
  p50 3.2 s / p95 7.9 s. Do not count zero-time cooldown refusals as fast retrieval.
  No conversation IDs were rotated to bypass quotas. Anonymous services are
  useful for light research, not guaranteed production capacity.
- Native public search was exercised in isolated configuration/data directories
  against pinned 2.0.30 and custom 2.1.2. The pinned runtime accepted Exa but did
  not expose a Parallel provider; custom 2.1.2 accepted both. Xratu therefore
  bridges its own fixed contracts and denies the legacy native pair.
- No live model answer-quality benchmark, manual citation-support review for all
  40 cases, actual Windows/macOS installation test, or Iran network survey is
  claimed. CI supplies platform build/regression checks; real-network regional
  reliability and the audit's broad answer-quality targets remain release gates.

Opt-in tools:

```bash
npm run compile-tests
node test/live-web-research.mjs --live --output results.json
node test/live-native-research.mjs --binary /path/to/opencode
```

The native probe uses a deterministic loopback model and fixture research, with
isolated runtime storage; it spends no model/search credits. The retrieval probe
uses only the committed public queries and no credentials. Neither runs in CI.

## IP pinning design boundary (X08)

The current guard validates each redirect and refuses private literals even
behind proxies. Direct hostname validation and the subsequent connection still
use separate DNS lookups. Proxy-resolved hostnames cannot be checked against the
proxy's actual connected address from this extension. The deliberate
198.18.0.0/15 fake-IP allowance remains intact.

A complete future pinning change must resolve once per hop, validate every
candidate, connect only to that set while preserving hostname SNI/certificate
validation and Host, and reapply it across redirects. An undici connector can
implement this for direct traffic. Proxy support additionally needs an
IP-address CONNECT tunnel with original-host TLS identity or an authenticated
proxy-side address guarantee. Forcing local DNS for remote-DNS-only routes would
break supported networks; fake-IP mappings need their own explicit treatment.
Until both routing paths have compatible implementations and regressions,
claiming that this race is fixed would be inaccurate. This PR preserves the
existing accepted boundary and does not loosen it.
