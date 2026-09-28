---
name: iran-connectivity-fallback
description: Use when a configured cloud model provider request fails repeatedly with timeouts, connection resets, or generic network errors (not 401/403 auth errors, not 429 rate limits) — helps diagnose that the endpoint may be unreachable and offers already-configured, working alternatives instead of just surfacing a raw network error.
---

# Connectivity fallback

## When this applies

Trigger only on patterns consistent with the endpoint being unreachable, not
misconfigured:

- Repeated `ETIMEDOUT`, `ECONNRESET`, `fetch failed`, or DNS-resolution
  errors on the **same provider endpoint**, across more than one request.
- Failures that start immediately after a provider/model switch, with no
  prior successful call to that endpoint this session.

Do **not** trigger on:

- 401 / 403 responses (bad or missing key - that's a credentials problem,
  handled by the existing auth error path).
- 429 responses (rate limit - that's a quota problem, not reachability).
- A single isolated failure (could be a transient blip; don't jump to
  conclusions on one data point).

## What to do

1. **Name the pattern plainly, without diagnosing the cause.** Say something
   like: "Requests to `<provider>` are timing out repeatedly - this endpoint
   may not be reachable from your network right now." Do not assert a
   specific cause (state filtering, provider policy, ISP issue, outage) -
   any of these can produce the same symptom, and the agent isn't in a
   position to distinguish them from inside the extension host.
2. **Offer alternatives that are already configured or already available on
   the machine, in this order:**
   - A local runtime, if one has already been found (Ollama / LM Studio /
     vLLM / llama.cpp). This is the lowest-friction option - no network
     dependency at all (setup details live in the `local-llm-low-ram` skill).
   - Any other provider the user has already added credentials for.
   - If neither exists, point at Settings -> API keys to add one, and
     mention local runtimes as an offline-capable option worth trying.
3. **Note what the host already does:** when a provider answers with a
   region/geo block, Xratu shows a banner with a one-tap switch to a saved
   Iranian provider. Don't duplicate that offer - this skill covers what the
   banner can't: repeated timeouts and hand-picked alternatives.
4. **Stop there.** Do not suggest VPNs, proxies, DNS workarounds, or any
   other means of reaching a blocked or restricted endpoint. Troubleshooting
   ends at "here's a working alternative you already have," not "here's how
   to reach the one that isn't working."

## Tone

Practical and neutral. This is a networking-diagnosis skill, not a
commentary on why an endpoint might be unreachable - don't speculate about
policy, sanctions, or geography in the response.
