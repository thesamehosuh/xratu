# Offline setup and local model guide

This guide ships inside Xratu and opens without an internet connection.

1. Install Ollama or LM Studio and download a coding model while online. Xratu cannot install a runtime or download weights without internet access.
2. Open Settings → Providers, scan local runtimes and connect one. Select its model in the chat picker. For Ollama on port 11434, expand **Manage Ollama models** to download or delete weights. Downloads show progress and can be cancelled; deletion requires confirmation. Other runtimes manage weights in their own applications.
3. Turn on **Offline mode** in Settings. The banner confirms the policy. Only loopback HTTP(S) endpoints (`localhost`, `127.0.0.1`, `::1`) are allowed; LAN/remote runtimes are blocked. Managed requests cannot follow redirects in offline mode or use a proxy. Cloud requests, model-catalog refreshes, web tools and external MCP are disabled. Previously configured connections remain saved.
4. Keep using local file tools, history, checkpoints and local inference. Disable Offline mode before downloading another model or connecting a cloud provider.

Offline mode controls Xratu-managed network traffic. Terminal commands and user-opened browser links can still access the network; it is not an operating-system network sandbox. Enabling the mode cancels current chat/download/benchmark/OAuth operations and closes external MCP connections. The marketplace uses cached/bundled entries if live fetching is unavailable.

## Choose a size before downloading

Quantized weights need memory in addition to the context cache, inference buffers and the operating system. Q4_K_M is a useful starting point; Q8 roughly doubles weight memory. Exact VRAM use depends on architecture, context length and offloading.

| Available hardware | Conservative starting point | Context |
| --- | --- | --- |
| 8 GB system RAM, CPU | 3B Q4 model; an 8B model may need more free RAM than this machine has | 4–8k |
| 16 GB system RAM, CPU | 7–8B Q4; try larger models only after checking free memory | 8k |
| 8 GB GPU VRAM | 7–8B Q4 with overhead and a modest context; 14B often does not fit fully | 4–8k |
| 16 GB GPU VRAM | 14B Q4 may fit; reserve space for context and buffers | 8k initially |

A 7–8B Q4 model typically needs about 4.5–5.5 GB just for weights. Leave at least 2 GB of system RAM for the OS and runtime, plus context memory. Check Task Manager on Windows or your OS's memory monitor before downloading. Lower model size/context if it swaps or runs out of memory. CPU inference is often only a few tokens per second. Quantization is a tradeoff: Q3 and smaller can noticeably hurt coding quality.

## If a local connection fails

- Connection refused: reopen Ollama's tray app or start LM Studio's local server, then scan again.
- No models: download one before going offline. Check that it supports tool calling.
- Context error: lower the manual context override or choose a model with a larger supported context. A longer context also consumes more memory.
- Out of memory: use a smaller Q4 model, lower context, or reduce GPU offloading in the runtime.
- Unknown provider error: keep the original error detail. Settings → Explain errors optionally adds a localized explanation for recognized failures without calling another model.
