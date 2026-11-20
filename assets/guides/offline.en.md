# Offline setup and local models

This guide ships inside Xratu and opens without an internet connection.

## Set up while online

1. **Install a local runtime and download a coding model.** Xratu cannot install Ollama/LM Studio or download weights while offline. Make sure the model you choose supports tool calling.
2. **Connect it in Xratu.** Open **Settings → Providers**, scan for local runtimes, connect one, and pick its model in the chat model picker.
   - For **Ollama** on port `11434`, expand **Manage Ollama models** to download or delete weights directly in Xratu (pulls show progress and can be cancelled; deletes ask for confirmation).
   - For **LM Studio**, **vLLM**, and **llama.cpp**, manage models in their own apps.
3. **Turn on Offline mode.** Open **Settings** and enable **Offline mode**. The status banner confirms it is active.
4. **Work offline.** Local file tools, chat history, shadow checkpoints, archive/checksum tools, and local inference continue working. Turn **Offline mode** off again when you want to pull new models or use a cloud provider.

## What Offline mode does (and doesn't do)

- **Allowed**: Loopback HTTP(S) endpoints only (`localhost`, `127.0.0.1`, `::1`), local workspace tools, local history/checkpoints, and cached/bundled MCP Marketplace listings.
- **Blocked**: Cloud providers, OpenCode, LAN/remote runtimes, web research, external MCP servers, live catalog refreshes, proxy routing, and HTTP redirects. Existing saved connections stay intact.
- **Immediate effect**: Turning Offline mode on cancels active remote chat requests, OpenCode runs, downloads, Ollama pulls, remote latency tests, and OAuth flows, and closes external MCP and open browser connections (reopened browser tabs permit loopback URLs only). A built-in chat running against a local loopback model is not cancelled and can continue running tools — stop it explicitly if you want it to stop.
- **Not an OS firewall**: Offline mode governs Xratu-managed network traffic only. Terminal commands you approve and links you open in your own browser can still access the network.

## Choose a model size for your hardware

Running a local model needs memory for three things: the **quantized weights**, the **context cache (KV cache)**, and **OS/runtime overhead**. `Q4_K_M` is a reliable starting point; `Q8` roughly doubles weight memory. Actual VRAM use varies by architecture, context length, and GPU offloading.

| Available hardware | Conservative starting point | Starting context |
|--------------------|-----------------------------|------------------|
| 8 GB system RAM (CPU) | 3B Q4 (an 8B model often exceeds free RAM) | 4–8k |
| 16 GB system RAM (CPU) | 7–8B Q4 (check free memory before going larger) | 8k |
| 8 GB GPU VRAM | 7–8B Q4 with modest context (14B rarely fits fully) | 4–8k |
| 16 GB GPU VRAM | 14B Q4 (leave headroom for context and buffers) | 8k |

- A 7–8B `Q4` model typically needs **4.5–5.5 GB** for weights alone. Leave at least **2 GB** of system RAM for the OS and runtime, plus context memory.
- Check Task Manager (Windows) or your OS memory monitor before pulling a large model. Lower model size or context length if the machine starts swapping.
- CPU-only inference often runs at only a few tokens per second.
- Aggressive quantization (`Q3` and lower) can noticeably degrade coding and tool-calling reliability.

## Troubleshooting

- **Connection refused**: Make sure Ollama's tray app is running or LM Studio's local server is started, then rescan in **Providers**.
- **No models listed**: Download at least one model before going offline, and verify that it supports tool calling.
- **Context length error**: Lower the manual context override or pick a model with a larger context window (longer contexts use more memory).
- **Out of memory**: Switch to a smaller `Q4` model, shorten the context window, or reduce GPU layer offloading in your runtime.
- **Unfamiliar runtime error**: Keep the original error message. Enable **Settings → Explain errors** to add localized explanations for recognized failures without making another model call.
