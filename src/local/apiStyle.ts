/**
 * Which HTTP API a provider/model speaks.
 *
 * Xratu's local runtime historically assumed OpenAI `/chat/completions` for
 * everything. OpenCode Zen/Go are OpenAI-compatible for most models but route
 * a few families to the Anthropic Messages API (`/messages`) and others to the
 * OpenAI Responses API (`/responses`) on the SAME base URL - so the endpoint
 * cannot be inferred from the base URL, only from the model id.
 *
 * This is deliberately scoped to hosts we have a documented model->endpoint
 * map for. Everywhere else stays `chat`, because e.g. OpenRouter serves Claude
 * models over `/chat/completions`.
 *
 * Pure and dependency-free so it can be unit-tested.
 */

export type ApiStyle = 'chat' | 'messages' | 'responses';

/** OpenCode Zen/Go model families documented under `/messages`. */
const OPENCODE_MESSAGES_PREFIXES = ['claude-', 'qwen', 'minimax-'];

/** OpenCode Zen/Go model families documented under `/responses`. */
const OPENCODE_RESPONSES_PREFIXES = ['gpt-', 'grok-', 'muse-spark-'];

function hostOf(baseUrl: string): string | null {
    const raw = baseUrl.trim();
    if (!raw) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
        // hostname (not host): an explicit :port must not defeat the match.
        return new URL(withScheme).hostname.toLowerCase();
    } catch {
        return null;
    }
}

/** True for opencode.ai (and subdomains), where the model decides the API. */
export function isOpenCodeHost(baseUrl: string): boolean {
    const host = hostOf(baseUrl);
    return host === 'opencode.ai' || (!!host && host.endsWith('.opencode.ai'));
}

/**
 * Resolve the API style for a request. Defaults to `chat` unless the host is
 * OpenCode and the model id maps to a different documented endpoint.
 */
export function resolveApiStyle(baseUrl: string, model: string): ApiStyle {
    if (!isOpenCodeHost(baseUrl)) return 'chat';
    const m = model.trim().toLowerCase();
    if (OPENCODE_MESSAGES_PREFIXES.some((prefix) => m.startsWith(prefix))) return 'messages';
    if (OPENCODE_RESPONSES_PREFIXES.some((prefix) => m.startsWith(prefix))) return 'responses';
    return 'chat';
}
