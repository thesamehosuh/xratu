/**
 * Deterministic, offline error explanations (Layer A of the Persian error UX).
 *
 * Provider and transport failures reach the chat as raw English/JSON strings.
 * This module maps them to stable i18n keys so the host can post a Persian
 * one-liner with the original text underneath (the `errInternal` shape:
 * `valueKey` + `params.detail`). It is pure and dependency-free so it stays
 * node-testable like the other host-side helpers.
 *
 * Deliberately NOT here: a model-powered "explain this in Persian" button
 * (Layer B). A model round to explain a possibly-broken connection is the
 * wrong first move - this layer works offline and instantly.
 *
 * Coverage classes (order matters: most specific first): context-length,
 * model-not-found, auth, rate-limit, timeout/stall, connection refused
 * (the local-runtime-not-running case), connection reset, DNS, TLS, generic
 * network, malformed stream, provider 5xx.
 */

export interface ExplainedError {
    valueKey: string;
    params: Record<string, string>;
}

/** Text patterns, most specific first. The first match wins. */
const TEXT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
    [/context[_ ]?(length|window)|maximum context|too many tokens|prompt is too long|context_length_exceeded/i, 'errContextLength'],
    [/model.{0,30}(not found|does not exist|not exist)|no such model|unknown model|invalid model/i, 'errModelNotFound'],
    [/invalid.{0,20}(api )?key|incorrect api key|invalid x-api-key|unauthorized|authentication failed|api key not/i, 'errAuth'],
    [/rate.?limit|too many requests|quota|exceeded your current quota/i, 'errRateLimited'],
    [/timed? ?out|etimedout|deadline exceeded|stream stalled|no data for/i, 'errTimeout'],
    [/econnrefused|connection refused/i, 'errConnRefused'],
    [/econnreset|connection reset|socket hang up|epipe/i, 'errConnReset'],
    [/enotfound|getaddrinfo|eai_again|name not resolved|err_name_not_resolved|dns/i, 'errDns'],
    [/cert_|certificate|self.?signed|unable_to_verify|ssl|tls handshake/i, 'errTls'],
    [/fetch failed|network error|failed to fetch|err_network|err_internet_disconnected|network request failed/i, 'errNetwork'],
    [/unexpected token|premature close|terminated|err_stream|malformed/i, 'errStream'],
    [/internal server error|bad gateway|service unavailable/i, 'errServer'],
];

/**
 * Map a raw error text (and optional HTTP status) to a Persian explanation
 * key, or null when nothing matches - the caller keeps the raw message then.
 *
 * `text` should carry everything visible (message + response body excerpt);
 * the raw text is embedded in `params.detail` verbatim.
 */
export function explainError(text: string, status?: number): ExplainedError | null {
    const detail = text;
    // Status wins over wording for the unambiguous classes.
    if (status === 401) return { valueKey: 'errAuth', params: { detail } };
    if (status === 429) return { valueKey: 'errRateLimited', params: { detail } };
    if (typeof status === 'number' && status >= 500) return { valueKey: 'errServer', params: { detail } };
    for (const [re, valueKey] of TEXT_RULES) {
        if (re.test(text)) return { valueKey, params: { detail } };
    }
    return null;
}
