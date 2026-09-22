/**
 * Model-ledger row mapping - the SINGLE place a committed agent event becomes
 * a persisted history row, and a row becomes the message the next request
 * replays.
 *
 * Dependency-free on purpose (type-only imports, no `vscode`), so the host and
 * the `test:prompt-cache-rate` suite exercise the SAME code. A test that
 * reimplements this mapping cannot catch a regression in it.
 *
 * PROMPT CACHING: providers match the longest byte-identical PREFIX of the
 * request. The in-run loop sends provider-native carriers (`providerBlocks`,
 * `reasoningContent`) and internal flags (`isError`); if the replayed row drops
 * them - or emits the same keys in a different ORDER - the bytes differ and
 * prefix caching misses from that message onward. So this module:
 *   - carries the carriers through verbatim, and
 *   - emits message keys in the SAME order the in-run loop produces them
 *     (chat tool rows: role, tool_call_id, content, isError).
 */
import type { LocalAgentEvent, LocalAgentMessage } from './localAgent';
import type { LocalSessionHistoryMessage } from './localSessionStore';
import { clipHistoryContent, clipToolCallArguments } from './historyBounds';

/**
 * The persisted transcript event for one model-ledger event (the shape the host
 * pushes to `outcome.events`). Only `assistantMessage`/`toolResult` produce
 * rows; display-only events return null.
 *
 * It lives here, next to `historyRowFromEvent`, so the host and the cache-rate
 * suite run the SAME pipeline: raw agent event -> persisted event -> history
 * row -> replayed message. Content is clipped at the in-memory floor; the
 * per-message window cap is applied later by the host's `_pushLocalHistory`.
 */
export function persistedEventFromAgentEvent(event: LocalAgentEvent): any | null {
    if (event.type === 'assistantMessage') {
        return {
            type: 'assistant_message',
            content: clipHistoryContent(event.text),
            tool_calls: event.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                // OpenAI wire shape: `arguments` (string). Storing any other key
                // here corrupts the REPLAYED history - strict local servers
                // (LM Studio) 400 on the NEXT request. Bounded as valid JSON: a
                // large edit patch must not sit in the per-turn array at full
                // size.
                function: { name: call.name, arguments: clipToolCallArguments(call.argumentsJson) },
            })),
            // Provider-native replay carriers: persisted into the MODEL ledger
            // so the next request replays the bytes the provider cached.
            // `trimDisplayEvent` strips them before they reach the UI.
            ...(event.providerBlocks?.length ? { providerBlocks: event.providerBlocks } : {}),
            ...(event.reasoningContent ? { reasoningContent: event.reasoningContent } : {}),
        };
    }
    if (event.type === 'toolResult') {
        return {
            type: 'tool_result',
            id: event.id,
            tool: event.tool,
            // Bound the retained copy: a single terminal/expansion result can
            // be 100k+ chars and this array is held for the whole turn. The live
            // webview postMessage stays full so the render is unchanged.
            output: clipHistoryContent(event.output),
            // Replayed to the provider (Messages maps it to `is_error`);
            // keeping the exact flag makes the replayed tool row byte-identical
            // to the one the provider cached.
            ...(event.isError != null ? { isError: event.isError } : {}),
        };
    }
    return null;
}

/**
 * The row for one committed agent event, or null for display-only events.
 * `providerBlocks`/`reasoningContent` are persisted so the NEXT request
 * replays the bytes the provider cached; `isError` so the Messages transport
 * can map the same `is_error` on replay.
 */
export function historyRowFromEvent(event: any): LocalSessionHistoryMessage | null {
    if (!event || typeof event !== 'object') return null;
    if (event.type === 'assistant_message') {
        return {
            role: 'assistant',
            content: event.content || '',
            ...(event.tool_calls?.length ? { tool_calls: event.tool_calls } : {}),
            ...(event.providerBlocks ? { providerBlocks: event.providerBlocks } : {}),
            ...(event.reasoningContent ? { reasoningContent: event.reasoningContent } : {}),
        };
    }
    if (event.type === 'tool_result') {
        return {
            role: 'tool',
            tool_call_id: event.id,
            content: event.output,
            ...(event.isError != null ? { isError: event.isError } : {}),
        };
    }
    if (event.type === 'steer_user') {
        return { role: 'user', content: event.text };
    }
    return null;
}

/**
 * Convert persisted model-ledger rows into the messages the next request
 * replays. Normalizes for strict OpenAI-compatible servers (assistant content
 * must be a STRING; `tool_calls` must carry `function.arguments`) and repairs
 * turns persisted by older builds that stored `argumentsJson` or dropped
 * content. Key order matches the in-run loop's `messages.push` calls.
 */
export function buildReplayHistory(rows: readonly LocalSessionHistoryMessage[]): LocalAgentMessage[] {
    return rows.map((row): LocalAgentMessage => {
        if (row.role === 'tool') {
            return {
                role: 'tool',
                ...(row.tool_call_id != null ? { tool_call_id: row.tool_call_id } : {}),
                content: row.content ?? '',
                ...(row.isError != null ? { isError: row.isError } : {}),
            };
        }
        const toolCalls = row.tool_calls?.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
                name: tc.function?.name,
                arguments: typeof tc.function?.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function?.arguments ?? tc.function?.argumentsJson ?? {}),
            },
        }));
        return {
            role: row.role as LocalAgentMessage['role'],
            content: row.content ?? '',
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
            ...(row.isError != null ? { isError: row.isError } : {}),
            ...(row.providerBlocks ? { providerBlocks: row.providerBlocks } : {}),
            ...(row.reasoningContent ? { reasoningContent: row.reasoningContent } : {}),
        };
    });
}
