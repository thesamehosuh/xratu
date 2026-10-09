# Compare providers and pay from Iran

API credit and a chat subscription are different products. Before paying, confirm that your plan includes API access, the exact model, streaming and tool calling. Xratu needs the provider's base URL and API key, not a website login.

## Curated comparison

| Provider | Pricing evidence / payment route | Connect in Xratu |
| --- | --- | --- |
| [AvalAI](https://avalai.ir/products/) | Advertises upstream API rates without an additional commission; offers IRT/Toman or UNIT credit and domestic bank payment. Confirm current FX, credit expiry and per-model rates in the [developer dashboard](https://chat.avalai.ir/platform). | Preset: `https://api.avalai.ir/v1`; create an API key in the developer dashboard. |
| [Kaya AI](https://kayaai.ir) | Check the provider dashboard for current model rates and available payment options; public pricing could not be independently verified. Xratu can read provider-reported model rates when available. | Preset: `https://kayaai.ir/api`; copy the API key from your account. |
| [GapGPT](https://gapgpt.app) | Check the [pricing page](https://gapgpt.app/pricing) and confirm API credit rather than a chat-only plan. Numeric API rates/payment terms were not independently verified. | Preset: `https://api.gapgpt.app/v1`; verify the endpoint and key in the provider dashboard. |
| [Liara AI](https://docs.liara.ir/ai/about/) | Check the service's current tariff and credit rules in the [console](https://console.liara.ir). | Create an AI service following the official quick-start; paste its account-specific base URL and key. |
| [Metis AI](https://metisai.ir) | Confirm current API pricing/payment in its dashboard. | Paste the account's OpenAI-compatible endpoint; the preset deliberately supplies no guessed URL. |
| [ArvanCloud](https://www.arvancloud.ir) | Confirm current AI service pricing/payment in its dashboard. | Paste the endpoint assigned to your service; no shared endpoint is assumed. |
| Navaan | Public onboarding URL and current tariffs were not independently verified. | Use your existing account's dashboard endpoint/key. |
| Ollama / LM Studio | No provider token bill; hardware, electricity and model download/storage still cost resources. | Connect a discovered loopback runtime. See the bundled offline guide. |

Only the AvalAI pricing/payment description above is verified against its own published product page. Other rows intentionally point to current source information rather than guessing prices. None of these entries is a live availability guarantee. Do not buy a plan solely because a preset exists.

## Compare actual cost and latency

1. Choose the same model on each connected provider. In Providers, expand **Compare connection latency** and run **Test active model**. It sends only “Reply with OK.” with a 32-token output cap, no project contents or tools. Each run may be charged; it times the first text token and total response from this machine. Measurements last for this webview session and do not benchmark reasoning quality or sustained throughput.
2. Repeat several times on the same network/proxy, with the same model; use a median instead of ranking providers by one sample. Failures and streams without text are displayed, not treated as zero latency. Model routing and load can change between requests.
3. Copy current input/output/cached-input prices into Usage overrides, selecting USD or IRT as appropriate. Use identical token counts to compare: `(input × input rate + output × output rate + cached input × cached rate) / 1,000,000`. Split uncached and cached input; do not count cached tokens twice. Check whether the source quotes rates per 1k or 1M tokens, and whether it uses rial or toman (10 rial = 1 toman).
4. Compare total cost for your real task as well as the headline token rate. Tool-heavy turns and retries can consume more tokens. Xratu's Usage page reports your observed spend, but estimates are not a substitute for the provider invoice.

## Onboarding

Open the official link, register, choose API credit, check the invoice currency and expiry, and add a small amount of credit through the provider's supported payment route. Create an API key, paste the key and base URL in Xratu → Providers, connect, and select a model. Keys stay in VS Code secret storage. Never paste keys in chat, the terminal, screenshots or this guide.
