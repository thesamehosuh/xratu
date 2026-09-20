/**
 * Base-URL normalization shared by the local agent runtime and the runtime
 * probe. Kept dependency-free so it can be unit-tested without VS Code.
 *
 * Rule: a base URL that already carries a path is used verbatim - versioned
 * segments (`/v1`, `/v1beta/openai`, `/paas/v4`, `/compatibility/v1`, `/api`)
 * must never be rewritten. Only a bare origin gets the conventional `/v1`
 * suffix so user-entered custom roots work out of the box.
 */

/**
 * OpenAI-compatible providers whose API is intentionally served from a bare
 * origin with NO `/v1` segment (the chat endpoint hangs directly off the
 * root). These are presets we control, so the list stays small and explicit.
 */
const ROOT_BASE_HOSTS = new Set(['api.perplexity.ai']);

export function normalizeBaseUrl(value: string): string {
    const raw = value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(raw)) {
        throw new Error('Model URL must start with http:// or https://');
    }

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('Model URL is not a valid URL');
    }

    // A real path already roots the API; preserve it exactly.
    if (parsed.pathname && parsed.pathname !== '/') {
        return raw;
    }
    if (ROOT_BASE_HOSTS.has(parsed.hostname.toLowerCase())) {
        return raw;
    }
    // Append /v1 to the PATH, not the raw string, so a query string or
    // fragment isn't pushed behind the suffix (e.g. `?tenant=foo`).
    if (parsed.search || parsed.hash) {
        parsed.pathname = '/v1';
        return parsed.toString();
    }
    return `${raw}/v1`;
}
