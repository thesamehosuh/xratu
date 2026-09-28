---
name: local-llm-low-ram
description: Use when the user wants to run LLMs locally on a small machine (8GB RAM, no dedicated GPU), asks about Ollama or LM Studio setup, quantization levels, which model fits their hardware, or how to wire a local runtime into Xratu — honest sizing math, realistic speed expectations, and the context-window trap.
---

# Local LLMs on a small machine

## Sizing math (the part people get wrong)

Weights size = parameters x bytes-per-weight. A 7-8B model at 4-bit (Q4)
is roughly 4.5-5.5GB on disk and in memory, plus context and overhead.

| Machine | Comfortable target |
|---|---|
| 8GB RAM, no GPU | 3B-8B at Q4, keep the context window modest |
| 16GB RAM | 7B-14B at Q4, or 7B-8B at Q8 |
| Dedicated GPU (8GB+) | 7B-14B at Q4 fully offloaded - the sweet spot |

Leave headroom: the OS and the inference runtime want ~2GB beyond the
weights. When memory is tight, a smaller model that answers is worth more
than a bigger one that swaps.

## Quantization

- **Q4_K_M is the default recommendation** - the quality/size sweet spot
  for coding work.
- Q8 roughly doubles size for marginal quality gain (only when RAM allows).
- Q3 and below visibly hurt reasoning and code correctness - use only when
  nothing else fits.

## The context-window trap

Xratu probes a local model's real context window at connect time and sizes
its history accordingly - but a manually configured window that is too
large eats RAM for the weights, and one that is too small triggers
compaction churn. 8k is the safe baseline on 8GB machines; only raise it
after checking the model card AND the machine's free memory.

## Wiring it into Xratu

- **Ollama**: install, `ollama pull <model>`, then keep it running -
  Xratu auto-discovers the local endpoint (no API key needed) and lists its
  models.
- **LM Studio / vLLM / llama.cpp**: serve any OpenAI-compatible endpoint;
  Xratu auto-discovers these too (Settings -> API keys shows what was
  found; the URL can always be pasted manually).
- If discovery finds nothing, walk the user through starting the runtime
  first - a connection-refused error from the local endpoint almost always
  means the runtime isn't running yet.

## Expectations to set

CPU inference on an 8GB machine is slow (single-digit tokens per second).
That is fine for planning, explanations, small edits and review - say so
up front instead of letting the user conclude something is broken. Keep
tool-heavy workflows to small steps: every tool result costs context, and
context is the scarcest resource on these machines.

Model catalogs change constantly - name EXAMPLES by class ("a 7-8B code
model at Q4") and let the runtime's catalog pick the exact name, rather
than promising a specific model id that may be gone next month.
