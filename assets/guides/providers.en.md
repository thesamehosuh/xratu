# Compare providers and pay from Iran

For API-key providers, **API credit and a website chat subscription are separate products**. Before paying, confirm that your plan includes API access, the exact model you want, streaming, and tool calling. Xratu connects with a base URL and API key — not a website login. *(ChatGPT subscriptions connect separately via **Continue with ChatGPT**.)*

## Provider comparison

| Provider | Pricing & payment notes | Connect in Xratu |
|----------|-------------------------|------------------|
| [AvalAI](https://avalai.ir/products/) | Advertises upstream API rates without added commission; supports IRT/Toman or UNIT credit and domestic bank payment. Verify current FX, credit expiry, and per-model rates in the [developer dashboard](https://chat.avalai.ir/platform). | Preset: `https://api.avalai.ir/v1` — create an API key in the developer dashboard. |
| [Kaya AI](https://kayaai.ir) | Check the dashboard for current model rates and payment options (public pricing was not independently verified). Xratu reads provider-reported rates when available. | Preset: `https://kayaai.ir/api` — copy your API key from your account. |
| [GapGPT](https://gapgpt.app) | Check the [pricing page](https://gapgpt.app/pricing) and confirm **API credit** rather than a chat-only plan (numeric API rates and payment terms were not independently verified). | Preset: `https://api.gapgpt.app/v1` — confirm the endpoint and key in the dashboard. |
| [Liara AI](https://docs.liara.ir/ai/about/) | Check current tariffs and credit rules in the [console](https://console.liara.ir). | Create an AI service per the official quick-start and paste its account-specific base URL and key. |
| [Metis AI](https://metisai.ir) | Confirm current API pricing and payment in its dashboard. | Paste your account's OpenAI-compatible endpoint (no shared URL is assumed). |
| [ArvanCloud](https://www.arvancloud.ir) | Confirm current AI service pricing and payment in its dashboard. | Paste the endpoint assigned to your service (no shared URL is assumed). |
| Navaan | Public onboarding URL and current tariffs were not independently verified. | Copy the base URL and key from your existing account dashboard. |
| Ollama / LM Studio | No provider token bill (hardware, electricity, downloads, and disk still cost resources). | Connect a local loopback runtime — see the bundled offline guide. |

> **Verification note:** Only the AvalAI pricing/payment summary above is verified against its published product page. Every other row links directly to the provider instead of guessing tariffs. Presence as a preset is not a live availability guarantee — always verify before purchasing credit.

## Quick onboarding steps

1. Open the provider's official link and register.
2. Choose **API credit** (not a web chat subscription), check invoice currency and credit expiry, and start with a small top-up.
3. Generate an API key, then open **Settings → Providers** in Xratu.
4. Pick the preset, paste your key (and base URL if required), connect, and choose a model.

API keys stay in VS Code SecretStorage. Never paste keys into chat, the terminal, screenshots, or documentation.

## Compare real latency and cost

1. **Run a latency probe**: Select the same model on each connected provider, expand **Compare connection latency** in **Providers**, and click **Test active model**.
   - Sends only `"Reply with OK."` with a 32-token output cap — no project files or tools.
   - Each run may incur a small API charge. It measures first-text-token time and total response time from your machine.
   - Results last for the current webview session and do not benchmark reasoning quality or sustained throughput.
2. **Use medians, not one sample**: Repeat several times on the same network and proxy with the same model. Failures and streams without text are shown as errors, never counted as zero latency.
3. **Calculate token cost consistently**: Enter current input, output, and cached-input rates in **Usage** price overrides (selecting `USD` or `IRT`). Compare identical token counts:

   ```text
   cost = (uncached_input × input_rate + cached_input × cached_rate + output × output_rate) / 1,000,000
   ```

   Keep uncached and cached input separate so cached tokens are not counted twice. Double-check whether a provider quotes rates per **1K** or **1M** tokens, and whether prices are in **Rial** or **Toman** (`10 Rial = 1 Toman`).
4. **Check real-task spend**: Headline rates don't tell the whole story — tool-heavy turns and retries use more tokens. Xratu's **Usage** page tracks observed spend, but estimates never replace your provider invoice.
