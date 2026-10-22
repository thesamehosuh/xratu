# Prompt cache continuity

The built-in runner must replay the complete prompt that preceded an assistant
response, including model-only status/task reminders. Matching most of the text
does not guarantee that a provider can find a previous cache-write boundary.

## Failure and fix

The runner used to send a fresh context/task note on each request without
retaining the previous note. The next request diverged at that missing note,
before the cached endpoint. Keeping ordinary conversation rows unchanged did
not preserve the whole prompt. The former prefix-similarity tests allowed that
loss and described their estimates as cache-hit rates.

Each assistant round now carries the exact preceding note as `contextNote` in
the model ledger. Every wire adapter reinserts it in its original position.
It survives normal persistence and interrupted-turn recovery, stays out of
display events, consumes the shared carrier budget, and counts toward context
occupancy. It does not introduce extra user turns into the logical ledger.
Runtime snapshots apply only to the response immediately following them, so
historical warnings and round-limit notices cannot govern a later user turn.

Supported OpenAI routes also retain encrypted reasoning with
`reasoning.context: all_turns`, matching native Codex. Subscription requests
carry stable `session-id` and `thread-id` headers from the conversation's cache
identity. Other compatible hosts and older models keep their existing schema.
An explicit context rejection falls back without dropping the user's effort.

Modern public OpenAI Responses requests use explicit cache boundaries. The
legacy ChatGPT subscription endpoint rejects those newer fields and does not
receive them. Other endpoints that reject them fall back once per run. The
replay fix works independently of these optional controls.

Anthropic requests retain recent cache boundaries across large batches and
steers, within the four-breakpoint limit. Building a request must not mutate
native response blocks. Google and Chat Completions retain the same historical
notes while preserving their existing role and field compatibility rules.

## Evidence and limits

The interrupted dogfooding session recorded 23 completed requests, 1,000,909
input tokens and 48,000 cached tokens (4.8%). Its input grew from 14,288 to
57,809 tokens. No delegated agents ran.

A bounded live check of the fixed ChatGPT subscription transport on GPT-6.1
Sol reported 17,536 cached tokens out of 17,751 input tokens on a tool
continuation (98.8%). This check used synthetic context and a synthetic tool
result; it performed no file operation. Smaller preliminary probes returned
zero cache reads, so small prompts alone were not a sufficient validation.
These measurements are different workloads, not a controlled billing
benchmark or a guarantee about the percentage of a subscription limit.

The historical session did not retain raw requests or provider cache-miss
diagnostics. Its precise server-side miss attribution cannot be recovered.
Xratu's output channel now records actual input/cache counts for all four
adapters and OpenAI's effective reasoning context/cache diagnostics when
available. It records no prompt, tool output, authorization header or token.

## Regression coverage

- `test:prompt-cache-rate` runs the real loop and persistence mappings through
  plain and reasoning conversations in all four formats. Every continuation
  must retain the complete previous prompt. A negative control drops only the
  context notes and must reproduce the prefix break.
- `test:prompt-cache-boundaries` checks provider lookup boundaries, immutable
  native blocks, batched tools/steers, scoped capabilities and safe rejection
  fallback. Its diagnostic assertions use server-reported usage fixtures.
- Session/carrier tests cover note persistence, crash recovery, display
  stripping, occupancy estimates and oversized-carrier bounds.

Provider eviction, compaction, changed models/settings/tools and deliberately
bounded history can still invalidate a cache. Local prefix tests do not measure
remote cache availability.

References: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[OpenAI reasoning context](https://developers.openai.com/api/docs/guides/reasoning),
[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[Gemini context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching).
