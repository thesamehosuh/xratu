# Web research audit and delivery plan

Implementation tracking: [automatic research delivery](web-research-delivery.md).
The maintainer superseded the provider/key configuration proposal: one PR,
automatic anonymous research, retired legacy routes, and only proxy routing UI.
The original audit below is retained as historical evidence.

Audited 2026-10-21. Xratu base: `0c35ba2`, including the existing uncommitted working tree. This is a report and proposed implementation, with no runtime changes. Every actionable finding encountered is retained below, including issues beyond search.

## Recommendation

Make web research a built-in, model-independent capability that works on the first request: **anonymous Parallel Search MCP by default, anonymous Exa as an automatic fallback, a proper local page reader, and visible sources and failures**. Keep the public tool names `web_search` and `fetch_url`. Users should not need an account, a key, Python, `uvx`, an MCP installation, or a browser download for ordinary research.

Keep Brave, Parallel API keys, Exa keys, and user-operated SearXNG as explicit options. Preserve existing configured routes. Let users disable hosted providers or restrict research to their chosen service. Add a version-aware documentation workflow after general search works reliably.

This is an architectural recommendation, not a claim that one provider wins a search-quality benchmark. Two anonymous services worked in live probes, but neither provides an unlimited or guaranteed free service. Reliable access beyond their anonymous allowances needs the user's account or an Xratu-funded service agreement.

## What was inspected

Xratu: search and fetch execution, tool schemas, prompts, external MCP discovery/results, first-run defaults, secret storage, proxy/offline behavior, native OpenCode service bridging, result rendering, and relevant tests. Existing download-related work was left untouched.

Competitors: source in the local checkouts, rather than assumptions from feature lists. These were clean snapshots; no competitor checkout was updated. Commit dates describe the available snapshots, not the latest upstream releases.

| Project | Local commit | Commit date | Main evidence |
| --- | --- | --- | --- |
| OpenCode | `6ea95e5` | 2026-09-22 | [Search implementation](https://github.com/sst/opencode/blob/6ea95e5e6fe2bfc545c854caa6bece366e7c3b56/packages/core/src/tool/websearch.ts), [page reader](https://github.com/sst/opencode/blob/6ea95e5e6fe2bfc545c854caa6bece366e7c3b56/packages/core/src/tool/webfetch.ts) |
| Cline | `35b46a7` | 2026-09-22 | [Provider tool contract](https://github.com/cline/cline/blob/35b46a71b3435de1140ae7b824619746196fef77/sdk/packages/shared/src/llms/model-tools.ts), [Cline search service](https://github.com/cline/cline/blob/35b46a71b3435de1140ae7b824619746196fef77/sdk/packages/llms/src/providers/vendors/cline.ts), [Exa plugin example](https://github.com/cline/cline/blob/35b46a71b3435de1140ae7b824619746196fef77/sdk/examples/plugins/web-search.ts) |
| Continue | `5522c6f` | 2026-07-20 | [Web context service](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/context/providers/WebContextProvider.ts), [search tool](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/tools/implementations/searchWeb.ts) |
| Hermes | `5937b95` | 2026-06-22 | [Provider registry](https://github.com/nousresearch/hermes-agent/blob/5937b95192bc02a98a8a29d44caffd71f2b25694/agent/web_search_registry.py), [provider contract](https://github.com/nousresearch/hermes-agent/blob/5937b95192bc02a98a8a29d44caffd71f2b25694/agent/web_search_provider.py), [DDGS adapter](https://github.com/nousresearch/hermes-agent/blob/5937b95192bc02a98a8a29d44caffd71f2b25694/plugins/web/ddgs/provider.py) |
| Goose | `c815645` | 2026-09-22 | [Exa setup](https://github.com/block/goose/blob/c81564584190da4bd00178fd01316912119bdd37/documentation/docs/mcp/exa-mcp.md), [Tavily setup](https://github.com/block/goose/blob/c81564584190da4bd00178fd01316912119bdd37/documentation/docs/mcp/tavily-mcp.md) |
| Codex | `d93909a` | 2026-09-22 | [Mode resolution](https://github.com/openai/codex/blob/d93909a939e40c3c1031f5a713bacad8c0d9afe6/codex-rs/core/src/config/mod.rs), [search/open/find actions](https://github.com/openai/codex/blob/d93909a939e40c3c1031f5a713bacad8c0d9afe6/codex-rs/core/src/web_search.rs) |
| Roo Code | `b867ec9` | 2026-05-15 | [OpenAI native adapter](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/api/providers/openai-native.ts), native tool inventory |
| Aider | `5dc9490` | 2026-05-22 | [URL scraper](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/scrape.py), [web command](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/commands.py) |
| T3 Code | `ec80933` | 2026-10-09 | [Native search event projection](https://github.com/pingdotgg/t3code/blob/ec80933ac8cd02fec5c97b342462ccc9567cdb1e/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts) |
| DeepSeek Harness | `49a606b` | 2026-09-02 | [Web capability types](https://github.com/deepseek-ai/deepseek-harness/blob/49a606bc5b5934603f22a26957a07dc799ab0291/packages/web/web/src/types.ts), [search and source metadata](https://github.com/deepseek-ai/deepseek-harness/blob/49a606bc5b5934603f22a26957a07dc799ab0291/packages/web/tool-web/src/search.ts) |

REA and CLM were inspected for relevance. They are reverse-engineering tooling and model infrastructure respectively, rather than comparable general coding-assistant search implementations. Unrelated system/package-manager repositories were outside this audit.

Xratu's managed OpenCode version is `2.0.30` in [releases.ts](../src/engines/opencode/releases.ts). The separate OpenCode source checkout is useful architectural evidence; it does not establish the exact behavior of that packaged binary. Native parity must be tested against the pinned binary and supported custom installations.

## Current behavior

There are three paths users can encounter:

1. **Built-in agent:** `web_search` and `fetch_url` are always available online, including Plan mode. Search `auto` selects SearXNG when a URL exists, otherwise Brave. With untouched settings it returns `Error: no web-search provider is configured.` Parallel is implemented, but its REST adapter also requires a key. See [webTools.ts](../src/webTools.ts#L19) and [mcp.ts](../src/mcp.ts#L488).
2. **First-run external MCP:** Xratu seeds `uvx duckduckgo-mcp-server==0.7.0`, with its own tool names, when creating a new global MCP file. This supplies a keyless option if the runtime/package works. It is not the built-in search backend; external tools are excluded in Plan mode. Existing MCP files and legacy settings deliberately prevent seeding. See [registry](../src/mcpRegistry.ts#L87), [seeding](../src/mcpConfig.ts#L163), and [tool gating](../src/mcp.ts#L551).
3. **OpenCode engine:** native `websearch`/`webfetch` are displayed as Xratu's familiar names, but execute in OpenCode. Built-in web tools are not in the native service allowlist. Changing Xratu search settings therefore does not configure native search. See [display mapping](../src/engines/opencode/engine.ts#L28) and [service allowlist](../src/engines/opencode/services.ts#L10).

The project has foundations worth preserving: SSRF checks on public page reads, per-hop redirect validation, byte and idle limits on page reads, proxy routing, offline enforcement, a browser with real approvals, MCP HTTP transport, and result cards. The missing piece is a consistent research workflow built on those foundations.

## Findings to fix or redesign

Priority: **P1** materially affects reliability, trust, or user friction; **P2** completes the research experience; **P3** is a follow-on improvement. "Observed" means read from the source or reproduced; proposed designs and risk implications are identified as such. No finding below is being silently discarded.

| ID | Priority | Finding and evidence | Proposed resolution |
| --- | --- | --- | --- |
| S01 | P1 | Fresh built-in search cannot run without configuration. `auto` resolves to Brave with an empty key. Reproduced directly from the current source. [Code](../src/webTools.ts#L319) | Add anonymous hosted search behind the existing built-in tool; retain configured routes. |
| S02 | P1 | Keyless DDG depends on an external runtime/package, a successful first-run seed, and non-Plan mode. It creates a second search vocabulary. [Registry](../src/mcpRegistry.ts#L87), [gating](../src/mcp.ts#L557) | Remove it from new-install defaults once built-in search passes release gates. Keep existing user entries and the optional catalog entry. |
| S03 | P1 | The tool explicitly says to hide search failures; the system prompt permits answering from model knowledge when search is unconfigured. That can undermine a request to verify current facts. [Tool description](../src/mcp.ts#L495), [prompt](../src/systemPrompt.ts#L137) | Remove concealment. Require concise disclosure when verification fails, with supported recovery. Never imply a search succeeded. |
| S04 | P1 | Most built-in failures return an `Error:` string without `isError: true`. Reproduced for missing configuration and HTTP 401. This affects both web tools. [Executor](../src/webTools.ts#L419) | Return typed outcomes; preserve machine-readable failure status through the loop, history, and UI. |
| S05 | P1 | Search deadlines end when headers arrive; subsequent `resp.json()` calls have no byte cap or local body deadline. Page fetching already has stronger bounds. [Timeout helper](../src/webTools.ts#L185), [search parsing](../src/webTools.ts#L355) | Bound headers, body, decoding, and total operation time. Limit compressed/decompressed response exposure as supported by the transport. |
| S06 | P1 | `auto` is configuration selection, with no health-based fallback, cooldown, quota handling, or shared budget. Aborts caught in adapters are reported as timeouts/network errors. [Search](../src/webTools.ts#L313) | Add deterministic routing and typed cancellation, timeout, auth, rate-limit, and unavailable states. Retry only eligible failures within one shared deadline. |
| S07 | P1 | HTML extraction strips links, heading structure, code fences, and indentation while keeping navigation. A small HTML fixture reproduced all of these. [Extraction](../src/webTools.ts#L171) | Prefer native Markdown, then DOM-based content extraction and Markdown conversion that preserves code, links, lists, and tables. |
| S08 | P2 | Reads expose only a truncated prefix. There is no document handle, find-in-page, focused excerpt request, or way to continue reading beyond the prefix. [Reader](../src/webTools.ts#L226), [schema](../src/mcp.ts#L507) | Retain bounded documents locally; extend `fetch_url` with optional focus/find/range controls and truncation metadata. |
| S09 | P2 | Search has no explicit freshness, language, country, or publication-date contract. Adapters drop date metadata. [Schemas](../src/mcp.ts#L496), [adapters](../src/webTools.ts#L355) | Add a small normalized request contract; preserve supplied dates and unknown values. Expose which filters are actually enforced. |
| S10 | P1 | Multiple domains become `site:a site:b`, rather than an explicit union, and results are not checked against the requested domains. Operator parsing differs between backends. [Brave](../src/webTools.ts#L369), [SearXNG](../src/webTools.ts#L393) | Validate domain inputs; use native filters when supported and post-filter with hostname/subdomain boundaries. Do not claim hard filtering from query hints alone. |
| S11 | P1 | Search API keys are read from normal VS Code configuration, unlike model credentials in SecretStorage. The setting does not have the usual dedicated secret-editing flow. [Config](../src/webTools.ts#L25), [manifest](../package.json#L60) | Provider-specific secrets in SecretStorage, edited through CredentialsPage. Migrate the old key without printing it or writing it to another provider. |
| S12 | P2 | Search settings live in native VS Code configuration; the reviewed webview settings/credentials surfaces have no search provider health, quota, or recovery flow. | Add one compact research section: Auto/Off/selected provider, actual status, Test, and credential actions. Keep technical details on demand. |
| S13 | P1 | Search cards depend on parsing a numbered text format. Arbitrary MCP/native output falls back to raw output. There is no structured source metadata in LocalToolResult. [Parser](../webview-ui/src/toolPresentation.ts#L16), [cards](../webview-ui/src/components/ToolDetails.tsx#L83), [result type](../src/local/localTypes.ts#L145) | Carry bounded, versioned source metadata separately from model text, through live events and saved sessions. Preserve historical text fallback. |
| S14 | P1 | Engines show similar search names with different execution, settings, errors, and guarantees. Xratu's public-fetch guard does not govern native tools. [Mapping](../src/engines/opencode/engine.ts#L28), [services](../src/engines/opencode/services.ts#L10) | Make execution ownership visible. Add a controlled Xratu research service bridge where supported; retain an explicit native option. Test actual native behavior. |
| S15 | P1 | Reviewed tests cover SSRF and cancellation, but not a complete search adapter/routing contract, first-use search success, or source fidelity across restore. [SSRF tests](../test/test-ssrf-guard.mjs), [runtime controls](../test/test-runtime-controls.mjs) | Add hermetic provider contracts and user-flow tests, plus small opt-in live compatibility probes. |
| S16 | P2 | Parallel search keeps only the first excerpt of each result; search output has no overall text budget. Richer evidence can be lost while an unexpectedly large snippet can still flood context. [Formatting](../src/webTools.ts#L355) | Rank and budget excerpts per source and per call. Record truncation and allow targeted retrieval. Avoid including both JSON text and structured content twice. |
| S17 | P2 | Library-documentation research is not version-aware. Context7 is an optional `npx` catalog entry, not a general web-search substitute. [Registry](../src/mcpRegistry.ts#L75) | Prefer official docs matching lockfile/package versions. Offer Context7 over hosted HTTP as an optional specialist route, with a general-search fallback. |
| S18 | P1 | Built-in web tool descriptions do not establish a source trust boundary or a citation requirement. Unlike browser/external-tool metadata, source text is not explicitly framed as untrusted evidence in these definitions. [Definitions](../src/mcp.ts#L494), [prompt](../src/systemPrompt.ts#L137) | Mark retrieved material as untrusted data and ask for links supporting factual claims. Validate citation destinations against observed sources; test injection attempts. |
| S19 | P2 | The page reader rejects PDF and other non-text MIME types and does not render JavaScript. Existing browser tools provide an escalation route, but browser actions require approval and are unavailable in Plan mode. [MIME handling](../src/webTools.ts#L271), [browser policy](../src/browserPolicy.ts#L29) | Route hard public pages to hosted extraction when allowed; add bounded text-PDF support. Offer browser escalation when needed, keeping its approval and mode boundaries. |
| S20 | P2 | The existing setting descriptions still call the shared search key a Brave key, although Parallel is selectable. This can send users to the wrong setup. [English strings](../package.nls.json#L6), [Persian strings](../package.nls.fa.json#L6) | Replace ambiguous shared-key copy with provider-specific labels, capability/status copy, and current setup links in both locales. |
| S21 | P1 | Keyed REST search requests do not explicitly disable redirects while sending custom credential headers. The external MCP HTTP path already rejects credential-bearing redirects. A leaking redirect was not observed; this is an inconsistent transport policy. [Search calls](../src/webTools.ts#L332), [MCP policy](../src/externalMcp.ts#L261) | Reject redirects on credential-bearing provider requests, or handle only explicitly trusted same-origin transitions. Add a regression proving custom API-key headers cannot cross origins. |
| S22 | P1 | Direct page reads have per-hop header and per-read idle timers, but no single elapsed-time ceiling. DNS validation is outside those timers; a continuously trickling body can stay active well beyond 15 seconds. [DNS](../src/webTools.ts#L153), [body reads](../src/webTools.ts#L197), [reader](../src/webTools.ts#L226) | Add one abortable total budget covering DNS, redirects, headers, and body, while retaining idle and byte limits. Test trickle responses and cancellation during DNS. |

### Broader findings retained for follow-up

| ID | Priority | Finding and evidence | Proposed resolution |
| --- | --- | --- | --- |
| X01 | P1 | The local external-MCP dispatch drops `r.isError`, even though ExternalMcpManager correctly returns it. This affects every external tool, including DDG. [Dispatch](../src/mcp.ts#L1452), [manager](../src/externalMcp.ts#L448) | Preserve failure status end to end, with a regression covering an actual external failure. |
| X02 | P2 | External MCP maps `res.content` and discards `structuredContent`. A structured-only result would have no useful text through this path; rich sources cannot reach the UI faithfully. [Mapping](../src/externalMcp.ts#L458), [content mapper](../src/mcpToolContent.ts) | Preserve validated, bounded structured results; define a safe text projection for models and a versioned UI projection. Apply across tool families. |
| X03 | P1 | Any thrown external tool-call error triggers one reconnect and replay, without knowing whether the first invocation completed or was mutating. Duplicate side effects are a risk inferred from this policy, not an observed incident here. [Retry](../src/externalMcp.ts#L436) | Restrict replay to safe/idempotent requests or positively known pre-dispatch failures. Report uncertain mutation outcomes instead of replaying them. |
| X04 | P1 | A local turn awaits every enabled MCP listing. A slow optional service can delay the entire run; the default Torob entry has a 120-second connect budget. Listings are concurrent but the aggregate still waits for all. [Aggregation](../src/externalMcp.ts#L376), [turn preflight](../src/extension.ts#L4518), [default](../src/mcpRegistry.ts#L45) | Cache healthy inventories and use bounded startup/discovery budgets. Freeze a completed tool snapshot at session start; recover remaining tools for a fresh session. Do not mutate an in-flight schema. |
| X05 | P2 | Fresh installations enable general search plus marketplace-specific services, including package-launching services, regardless of the user's coding task. This increases initial dependencies and tool inventory. [Defaults](../src/mcpRegistry.ts#L35) | Keep Iranian presets visible and readily enabled; redesign fresh-install defaults around core capabilities and explicit optional integrations. Preserve existing user choices. |
| X06 | P2 | Seeding intentionally never revisits an existing MCP file. A registry-default change alone will not deliver reliable built-in research to established users. Empty/disabled configs are user intent. [Seeding](../src/mcpConfig.ts#L180) | Ship built-in capability changes independently of seeding; define versioned, non-destructive migrations and explicit Off behavior. Never repopulate an intentionally emptied file. |
| X07 | P1 | Privacy documentation says API keys are in VS Code secrets, but search uses a normal setting and external MCP headers/env can live in JSON. This is a user-facing accuracy gap. [Guide](guide.md#privacy), [search config](../src/webTools.ts#L25), [MCP storage](../src/mcpConfig.ts#L1) | Correct the claims alongside the search-key migration. Track general external-MCP secret references as a separate improvement; keep native credentials owned by the native runtime. |
| X08 | P2 | The known public-fetch DNS validation/connection TOCTOU remains an accepted limitation. Proxy-resolved hostnames and the intentional fake-IP allowance are compatibility constraints, not reasons to remove guards. [Guard](../src/webTools.ts#L85), [repo instructions](../AGENTS.md) | Track an IP-pinning design covering every redirect and both direct/proxy routing. Any change needs explicit security discussion and compatibility regressions. |
| X09 | P3 | Lint on the audited working tree passed with 0 errors and 290 warnings, rather than the "handful" described in AGENTS.md. Attribution to committed debt versus in-progress edits was not established. | Record the warning baseline, classify useful fixes, and update the stated policy. Keep cleanup scoped; do not lower the enforced rules. |
| X10 | P2 | Native search compatibility can drift independently of the engine binary. The live Exa schema now requires `objective` and rejects extra properties, while the reviewed OpenCode adapter sends older fields without `objective`. This identifies a compatibility risk; the pinned Xratu binary was not exercised. | Add live protocol canaries, versioned adapter contracts, and a user-visible fallback. Verify the pinned native engine before claiming or fixing an actual native failure. |

## What competitors teach us

| Project | Observed approach | User friction and useful lesson |
| --- | --- | --- |
| OpenCode | Directly calls Exa/Parallel hosted MCP behind a local tool; keys are optional. Selects a provider by explicit flags or a stable session split. Uses bounded bodies and a 25-second call timeout. | Closest fit for Xratu. Copy the built-in access pattern, then improve deterministic fallback and compatibility checking. A session split is not failover. |
| Cline | SDK adapters expose provider search through OpenAI, Anthropic, and Google; Cline has a search service route. Also includes an Exa-key plugin example. | Reusing a supported provider avoids another setup, but support is route/model dependent. Do not assume an OpenAI-compatible endpoint implements native web tools. |
| Continue | Search and web context share a hosted Continue proxy endpoint; search bounds returned content. | A managed service hides provider setup. It also transfers operating cost and availability to the product. Source proves the client route, not current backend service reliability. |
| Hermes | Separates search/extraction capabilities, explicit selection, availability, and setup metadata; includes keyed services, SearXNG, and optional DDGS. | Good model for normalized contracts and actionable setup. Its inspected Parallel backend still requires a key; its DDGS option still requires a Python package. |
| Goose | Inspected Exa/Tavily guides install MCP extensions with runtime and key setup. | Optional integrations are useful, but that setup is too much for Xratu's basic research path. These are inspected integration guides, not proof of every Goose search option. |
| Codex | Provider-native search with policy/capability-aware modes; distinguishes search, opening pages, and finding within pages. | Borrow focused reading and clear live/cached semantics. Native availability cannot be generalized to Xratu's local and custom-model routes. |
| Roo Code | Reviewed adapter handles native search stream events; reviewed native inventory did not reveal a provider-independent general search tool. | Event handling alone does not establish a working search feature. Keep support claims narrower than UI labels. |
| Aider | `/web` retrieves a URL through HTTP or optional Playwright and converts HTML to Markdown. | Useful reader pattern; URL fetching alone cannot discover unknown pages. Browser setup is an escalation path. |
| T3 Code | Projects native Codex search into durable activity with search patterns and running/completed states. | Make research observable and restorable. A search activity row does not itself supply a search backend. |
| DeepSeek Harness | A web service seam owns provider selection and typed search/fetch results; tool code formats sources separately and persists structured metadata. Supports multiple adapters. | Best structural reference for preserving sources, errors, and UI evidence without parsing presentation text. Avoid copying its full plugin architecture into a small extension. |

## Service options and live checks

Official service documentation was checked during the audit; prices and access policies can change.

| Option | Access and operational tradeoff | Recommendation |
| --- | --- | --- |
| Parallel hosted MCP | Anonymous search and page fetching are documented for light use. Production/higher limits use an account; authenticated usage can incur charges. [Service](https://parallel.ai/mcp), [integration docs](https://docs.parallel.ai/integrations/mcp/search-mcp) | Default candidate. No user installation; useful structured results in the probe. |
| Exa hosted MCP | Anonymous access is documented; rate limits apply. Extra search controls are available through an advanced tool. [MCP docs](https://exa.ai/docs/get-started/exa-mcp) | Automatic fallback within Auto mode. Its live default schema must be supported explicitly. |
| Existing Parallel REST | Current pricing lists fast/turbo search at $1 per 1,000 requests with the default result allowance, and extraction at $1 per 1,000 URLs. [Pricing](https://docs.parallel.ai/getting-started/pricing) | Preserve for user-owned keys and authenticated controls. Do not confuse REST key requirements with anonymous MCP access. |
| Brave | $5 per 1,000 Search requests with $5 monthly credits; an account and card are required for that credit path. Saved-result rights depend on the plan. [Current pricing and FAQ](https://brave.com/search/api/), [account details](https://api-dashboard.search.brave.com/documentation/resources/help-feedback) | Keep an explicit BYOK route. Do not advertise the old 2,000-query free-plan claim found in the Hermes snapshot. Check retention rights for saved transcripts and caching. |
| Exa account | Current pricing advertises $10 monthly credits and an onboarding bonus without a payment method. [Pricing](https://exa.ai/pricing) | Useful optional upgrade when anonymous access is insufficient. Account/API credits are distinct from anonymous MCP limits. |
| Tavily | 1,000 monthly credits without a card; basic search costs one credit and advanced search two. [Pricing](https://docs.tavily.com/documentation/api-credits) | Reasonable later adapter if user demand or evaluation justifies another provider. Not a prerequisite for the core release. |
| SearXNG | User-operated instances avoid another commercial search account; JSON must be enabled. Many public instances disable it. [API docs](https://docs.searxng.org/dev/search_api.html) | Keep for self-hosting and controlled deployments. Do not rotate through random public instances as the default. |
| DDG scraping | Already accessible through the seeded MCP package. Runtime dependencies and upstream scraping behavior remain failure points. | Preserve as opt-in compatibility, rather than the reliability foundation. |
| Context7 | Hosted MCP can avoid local Node setup; anonymous access has lower limits. [Official setup](https://github.com/upstash/context7/blob/master/docs/resources/troubleshooting.mdx) | Optional library/version specialist, rather than the only general search engine. |

### Observed live behavior

The probes used the repo's existing MCP SDK with anonymous Streamable HTTP. They sent only public FastAPI documentation queries/URLs, with no project contents, provider credentials, or browser session. Each timing includes connecting and the call, from this machine's network. This was three smoke calls, not a benchmark or a regional reachability survey.

| Probe | Outcome | End-to-end time | Payload observation |
| --- | --- | --- | --- |
| Parallel `web_search` | Success; official FastAPI repository documentation surfaced | 2,744 ms | 18,736 text characters plus structured results |
| Exa `web_search_exa` | Success; official FastAPI site surfaced | 3,321 ms | 9,481 text characters; no structuredContent in this response |
| Parallel `web_fetch` | Success reading the official documentation page | 2,335 ms | 17,179 text characters plus structured results |

The fetch payload also included navigation content. Hosted extraction still needs relevance and token-budget evaluation; it is not an automatic cure for noisy pages.

Live `tools/list` supplied a useful compatibility finding: Exa's default search currently requires `query` and `objective`, with optional `numResults`, and sets `additionalProperties: false`. The inspected OpenCode source sends a different schema. Parallel returned `objective`/`search_queries` plus optional conversation/model metadata, and a structured result object. Adapter code must accommodate these actual contracts; do not paste a competitor's old request verbatim.

Hermetic probes of the current Xratu source also reproduced missing `isError` on configuration/auth failures, the `site:a site:b` query construction, and destructive HTML-to-text conversion. These did not make external calls.

## Proposed architecture

### One research service, with small adapters

Introduce a small `src/web/` boundary: contracts, routing, hosted MCP adapters, existing keyed adapters, public reader, and source projection. Keep `src/webTools.ts` as the compatibility entry point during migration. This needs an interface and a few adapters, not another general plugin framework.

Requests keep `query`, `max_results`, and `domains` compatible. Add optional `objective`, freshness/language hints, and focused read controls incrementally. Keep host policy controls out of model arguments: provider credentials, endpoints, fallback permission, and paid access must come from trusted user configuration.

Results should carry:

- Outcome: success, empty, unavailable, rate-limited, authentication-required, cancelled, blocked, or unsupported.
- Evidence: stable source ID, requested/final URL, optional title, excerpts, optional publication date, retrieval time, and reader route. Unknown fields remain unknown.
- Provenance: actual provider, cached/live/unknown status, requested versus enforced filters, truncation, and concise warnings.
- Separate projections: bounded model text and bounded/versioned display metadata. Sources used in an answer must survive compaction and session restore without putting display-only traces into the model ledger.

Use the existing MCP SDK for hosted requests behind this service. Reuse proxy/offline networking policies. Parse and validate supported response envelopes, including errors returned inside successful HTTP responses. Do not let arbitrary remote tool descriptions, tools, endpoints, or control instructions become Xratu built-ins. On provider schema changes, accept only known compatible contracts or fail visibly to a working route.

### Routing policy

1. Enforce Offline and research Off before any discovery or request. Respect disabled providers and workspace trust.
2. Honor explicit provider selection. On invalid credentials, an explicit policy denial, or a privacy-restricted configuration, report the problem; do not silently send the query elsewhere.
3. In Auto, preserve existing configured SearXNG/key behavior through an explicit migration rule. The old shared key must retain its original provider association; do not try it against several services.
4. With no configured route, try anonymous Parallel, then anonymous Exa on an eligible availability/quota/protocol failure. Disclose both possible destinations in the research control. A domain restriction must remain enforced after fallback.
5. A genuine empty result is a valid outcome, not proof of provider failure. Let the agent refine the query when appropriate. Never retry cancelled requests.
6. Use one total deadline, per-attempt bounds, per-provider concurrency limits, and a bounded circuit breaker. Respect Retry-After rather than hammering a limited endpoint. Initial budgets should be measured and tuned; an 18–20 second total ceiling and prompt cancellation are reasonable starting targets.
7. Coalesce identical in-flight reads/searches. Add a bounded, short-lived memory cache only where provider retention terms permit it. Include provider/auth identity, filters, locale, and freshness in keys; clear it on credential/policy changes. Distinguish cached evidence from a fresh verification.

Generate any provider conversation identifier once per chat and reuse it across related calls. Do not send workspace paths or native session IDs as identifiers. Omit optional model analytics metadata unless needed and disclosed. Never rotate identifiers to evade free limits.

### Page-reading policy

Start with direct public fetching, requesting Markdown when supported, then a DOM-based reader with Markdown conversion. Preserve article structure and code, avoid executing page scripts, resolve relative links, and retain the final URL. Keep SSRF, redirect, byte, charset, proxy, timeout, and cancellation protections.

When direct reading is blocked, empty, or obviously a JavaScript shell, hosted extraction can supply a second route **only when hosted reading is enabled**. Tell the user which service read the page. Do not forward credentials, cookies, signed/private URLs, or full local context to a hosted reader. A local-only preference must stay local-only on failure. The proxy and hosted extraction are different privacy/network choices.

For the default policy, limit automatic hosted extraction to clean public URLs obtained from public search results. User-supplied URLs and URLs carrying query strings or other potentially sensitive data remain direct-only unless the user enables an appropriate hosted-read grant. URL heuristics cannot prove confidentiality, so do not claim they can. This keeps routine documentation research simple while making additional disclosure a deliberate choice.

Support bounded text extraction from public PDFs as a follow-up. Scanned PDFs, authenticated pages, and interactive sites need explicit unsupported/recovery states or the existing browser. Never bypass browser approvals to make Plan mode appear more capable.

Use a bounded document store to support targeted excerpts, find, and continuation. Evict predictably; make expired handles recoverable. The goal is to read the relevant section without repeatedly placing the whole page in context.

### Engines and subagents

The built-in research service must work for every tool-capable built-in model, including local models. Tool selection quality on small models needs a task evaluation, not just successful HTTP tests. Built-in children inherit the same route restrictions and shared resource limits while keeping their own tool allowlists.

For OpenCode, first verify native search in the pinned runtime. Add Xratu research through a narrow service bridge with distinct wire identities and the same host executor. Prefer one advertised general research pair per session when supported native tool controls allow it. Preserve an explicit native-search choice for users who want native ownership. If the runtime cannot suppress duplicate capabilities safely, make the limitation visible and track it rather than claiming parity.

This is a deliberate change to the current local-only web-tool boundary and needs a scoped engine PR. Never open all external MCP tools in Plan mode: only the known read-only research service can be allowlisted. Preserve per-child source attribution, cancellation, native permission/form identity, and native credential ownership. Resume with the session's recorded engine identity and report actual execution ownership.

### User experience

The default experience is asking a question and getting linked evidence. Avoid a new onboarding step or a mandatory provider picker.

Put compact research controls in existing settings and credential surfaces: mode, allowed providers, actual availability, Test, and optional account/key management. Do not create another top-level page just for these controls. Show a quota or connection problem where the user can recover, with one relevant action. Track search charges separately from language-model usage when known; never imply that an authenticated call is free because the model is free.

Show actual query/progress and a compact set of source rows, preserving date/unknown-date and partial results. Answers use source links near supported claims. Source cards record retrieved evidence; they must not imply that the answer cited every displayed source. Keep provider diagnostics and full outputs in Activity/on-demand details. Render titles and excerpts as untrusted content through existing sanitization, validate link schemes, and keep existing RTL and physical-right user bubbles intact.

## Delivery sequence

Small PRs with dependencies and measurable acceptance criteria. Estimates are engineering estimates for one maintainer, excluding reviewer/provider delays; they are not commitments.

| PR | Scope and dependency | Findings covered | Exit criterion | Estimate |
| --- | --- | --- | --- | --- |
| 1 | Correct result status and introduce the small typed research result contract | S04, X01; foundation for S13/X02 | Missing config, 401, 429, transport failure, and cancellation produce correct durable states. Existing text/image consumers remain compatible. | 1–2 days |
| 2 | Anonymous hosted adapters and Auto routing; consumes PR 1 | S01, S05, S06, S10, S15, S16, S21; X10 canaries | A fresh install searches without external runtimes in Act and Plan. Eligible fallback works; Off, private-route policy, cancellation, filters, and quotas are enforced. | 2–3 days |
| 3 | Local reader, Markdown fidelity, focused reads, hosted extraction policy; consumes PR 1 | S07, S08, S22, part of S19 | Relevant code and links survive extraction; bounds and SSRF regressions pass; unavailable pages produce useful recovery. | 2–3 days |
| 4 | Credentials, compact controls, sources/restore, prompt policy, migrations; consumes PRs 1–3 | S02, S03, S09, S11–S13, S18, S20, X02, X06, X07 | No mandatory setup; secret migration is safe; source and failure states restore; English/Persian sidebar and wide flows pass. Core default is complete here. | 2–3 days |
| 5 | Native research ownership and parity; consumes PRs 2–4 | S14, X10 | Verified against pinned/custom-supported OpenCode, Plan, native children, cancellation, resume, proxy, and settings scope. | 1–2 days |
| 6 | Version-aware docs, text-PDF reading, quality evaluation; consumes PRs 2–4 | S17, remainder of S19; quality validation for S09/S18 | Evaluation shows official/version-correct sources, usable targeted reading, and honest unsupported/freshness states. | 2–3 days |

The six research PRs total roughly **10–16 engineering days**. Two independent prerequisite fixes, X03 and X04 below, add an estimated **2–4 days**, for a release program of roughly **12–20 engineering days across eight scoped PRs**. These estimates need recalibration after the first contract and startup changes. The hosted adapters can be evaluated early; reliable first-use delivery also depends on fixing the MCP startup wait.

Make **X03 safe MCP retries** and **X04 inventory startup latency** separate prerequisite PRs for the complete release. X04 is required before calling the default low-friction: otherwise a built-in search request can still wait for unrelated external services. X03 is required before claiming safe automatic recovery across the broader tool layer. Both can proceed independently of the research service; neither should be hidden inside a provider adapter change.

Retain scoped follow-up PRs for **X05 integration defaults**, **X08 IP pinning**, **X09 warning debt**, and general MCP secret references from X07. Their fix directions remain in the findings table. Preserve known limitations accurately until resolved; all are retained work, not rejected findings.

Every behavior PR bumps the package version as required by the repo. Keep READMEs concise; update detailed guides, localized settings text, and dependency notices where applicable. Mechanical moves and default-integration changes should remain separate from unrelated behavior.

## Definition of complete

Proposed release gates, not achieved measurements:

- **First use:** on a clean Windows installation with no Node/Python/uv/Docker beyond VS Code's own runtime and no search key, ordinary research works with the built-in engine. Repeat on macOS/Linux and with a local model. No optional MCP connection may be required for the search itself.
- **Modes and ownership:** built-in Act and Plan have working read-only research; Offline and Off send no requests and cancel in-flight work. Native ownership and guarantees are accurate. No arbitrary external-MCP exemption is added to Plan.
- **Reliability:** a representative 40-query set covers English/Persian, exact errors, official library/version docs, recent releases, multi-domain searches, and obscure queries. Target at least 95% successful retrieval on supported online test networks; measure relevance and answer support separately. Two successful smoke searches do not satisfy this gate.
- **Network matrix:** direct, configured HTTP/HTTPS proxy, no_proxy, proxy failure, fake-IP DNS, TLS failure, offline toggle, shared-IP rate limits, and unavailable providers. Test Iran-relevant routes from actual user networks before making availability claims.
- **Evidence quality:** manually review source relevance and citations for the query set; record unsupported/incorrect claims and version mismatches. Aim for an official source in the first five for at least 90% of official-documentation queries and a valid observed source for every emitted citation. These are targets to calibrate after a baseline run.
- **Performance:** measure p50/p95 for search, page reads, fallback, and cold session startup separately. Start with a p95 ordinary-search target below 8 seconds on the measured network and a bounded fallback ceiling; do not publish network-independent promises.
- **Bounds and recovery:** oversized/chunked bodies, malformed JSON/SSE, MCP error envelopes, source duplication, empty responses, schema drift, 401/402/403/429/5xx, DNS failures, slow bodies, expired read handles, and cancellation all settle clearly. No retry causes an unapproved or duplicate mutation.
- **Trust:** prompt-injection fixtures cannot change host tool policy; redirects cannot leak auth headers. Keep public URL checks and per-hop guards. Validate any custom SearXNG endpoint as trusted configuration while still permitting intentional user-owned local instances; do not apply the public-page rule blindly to configured infrastructure.
- **Privacy:** query/URL destinations are visible; custom/private routes never fall back to public services without an allowed policy. Keys stay out of settings, logs, transcripts, and URLs. Verify provider retention terms cover the intended cache and saved tool history.
- **UI and restore:** source metadata and outcome states survive saved sessions, compaction, tool folding, and native/subagent rendering. Inspect English/Persian at approximately 420 px and wide widths using the real themed webview. Keep the composer mounted and controls keyboard-accessible.

For every implementation PR, run the repository's mandatory lint, both independent type checks, host build, and webview suites. Add hermetic search/reader tests; run SSRF, proxy, runtime controls, MCP config/content, and relevant engine/subagent/observation suites for touched boundaries. UI/engine changes also need the documented real-browser e2e checks. Live probes stay opt-in with public queries and no paid credentials in CI.

## Product decisions and alternatives

Proceed with these defaults unless evaluation contradicts them: Auto enabled online, Parallel first, Exa fallback, local direct reading first, explicit hosted-reader policy, no account requirement, and existing configured routes preserved. This minimizes setup while keeping source and failure states visible.

A user key can increase limits, but adding a key must never silently enable spending or change the chosen model account. Add OAuth only after the built-in path is stable; it is useful for account upgrades, not necessary for the anonymous default.

A managed Xratu gateway is the future option if anonymous quotas become a real product limit. It can hide keys and centralize reliability, but introduces hosting cost, abuse handling, service operations, and another data recipient. As a rough pricing illustration, 100,000 Parallel fast searches at the published base rate would be $100, excluding extraction, extra results, model tokens, hosting, and any negotiated terms. [Published rates](https://docs.parallel.ai/getting-started/pricing) Do not promise that cost or production access from the anonymous endpoint.

Do not make users install a browser or MCP runtime for basic search, embed a shared paid key in the extension, depend on arbitrary public SearXNG instances, scrape search pages as the sole backend, or require provider-native search for local models. Keep those paths available where useful, with their actual constraints.

## Validation performed for this report

- Source audit and commit inventory for the ten competitor snapshots above.
- Anonymous MCP tool discovery on Parallel and Exa, followed by the three public smoke calls reported above.
- Hermetic reproduction of built-in configuration/auth failure status, multi-domain query construction, and HTML extraction loss, directly from the current TypeScript source.
- Passed on the audited working tree: `npm run lint` (0 errors, 290 warnings), host `tsc --noEmit`, separate webview `tsc --noEmit`, `node esbuild.js`, `npm run test:webview`, `npm run test:ssrf-guard`, and `npm run test:runtime-controls`. Host tests used fresh TypeScript output. This validates the current tree, not a future implementation of this plan.
- No runtime or UI implementation was changed, so this audit did not run browser UI checks or claim a broad search-quality benchmark.
