---
name: local-llm-low-ram
description: Use when the user wants to run LLMs locally on a small machine (8GB RAM, no dedicated GPU), asks about Ollama or LM Studio setup, quantization levels, which model fits their hardware, or how to wire a local runtime into Xratu — honest sizing math, realistic speed expectations, and the context-window trap.
---

# Local LLMs on a small machine

Sizing advice calibrated as of 2026; the math below ages better than model
names do.

## Sizing math (the part people get wrong)

Weights size = parameters x bytes-per-weight. A 7-8B model at 4-bit (Q4)
is roughly 4.5-5.5GB on disk and in memory, plus context and overhead.

| Machine | Comfortable target |
|---|---|
| 8GB RAM, no GPU | Start around 3B at Q4; larger models need measured headroom |
| 16GB RAM | Start around 7B-8B at Q4; estimate before increasing size |
| Dedicated GPU | Fit weights, KV cache and overhead within actual free VRAM |

Leave headroom for the OS, VS Code, extension host, runtime, KV cache,
and compute buffers; a fixed 2GB allowance is not a reliable total. When memory is tight, a smaller model that answers is worth more
than a bigger one that swaps. **Check actual free memory first** (`free -h`
on Linux, Task Manager on Windows) before picking a size - the table is a
target, not a promise about the machine in front of you. Swap (or zram)
keeps a too-big model from crashing but turns generation into minutes per
reply; if the machine is swapping, downsize instead of tolerating it.

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
compaction churn. Do not call any context size universally safe on an 8GB
machine. Start modestly and measure the loaded model with Xratu's actual
prompt and tool catalog. Distinguish the model's advertised maximum from
the runtime's currently allocated context; inspect `ollama ps`, or use
`lms load <model> --context-length <tokens> --estimate-only` before loading.
See [Ollama context](https://docs.ollama.com/context-length) and
[LM Studio load](https://lmstudio.ai/docs/cli/local-models/load).

Before recommending a model for agent work, verify a small tool-call/result
round trip as well as ordinary generation. Check its model card and runtime
support; a text response alone does not establish usable tool calling.

## Wiring it into Xratu

- **Ollama**: install, `ollama pull <model>`, then keep it running -
  Xratu auto-discovers the local endpoint (no API key needed) and lists its
  models. On Windows, check the Ollama tray app and how it was installed
  before starting another server. Reopen the app if needed; standalone
  installations can use `ollama serve`.
- **LM Studio / vLLM / llama.cpp**: serve any OpenAI-compatible endpoint;
  Xratu auto-discovers these too (Settings -> API keys shows what was
  found; the URL can always be pasted manually).
- If discovery finds nothing, walk the user through starting the runtime
  first - a connection-refused error from the local endpoint almost always
  means the runtime isn't running yet. Discovery only probes localhost
  ports, so a runtime on another machine needs its URL pasted manually.

## Obtaining models on an unreliable connection

Check existing local models before proposing a multi-gigabyte download.
Choose one runtime-compatible quantization and a specific revision; do not
download every weight format in a repository. For split weights include every
required shard and any required config/tokenizer files. Use publisher metadata
and hashes when available, retain partial transfers, and check actual free disk
space as well as RAM. A small completed download is more useful than several
unfinished alternatives. Use `native-downloads` for supported public files and
`iran-dev-access` for source/routing failures when those skills are available.

## Expectations to set

CPU speed depends on the model, CPU, context, and memory bandwidth. Measure
a short request rather than promising a fixed token rate.
That is fine for planning, explanations, small edits and review - say so
up front instead of letting the user conclude something is broken. Keep
tool-heavy workflows to small steps: every tool result costs context, and
context is the scarcest resource on these machines.

Model catalogs change constantly - name EXAMPLES by class ("a 7-8B code
model at Q4") and let the runtime's catalog pick the exact name, rather
than promising a specific model id that may be gone next month.
