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
import { base64ByteLength, type LocalAgentEvent, type LocalAgentMessage } from './localAgent';
import type { LocalSessionHistoryMessage } from './localSessionStore';
import { clipHistoryContent, clipToolCallArguments } from './historyBounds';

/**
 * What a persisted tool row remembers about an image it no longer carries:
 * METADATA ONLY. The base64 payload is never written - a session file is
 * rewritten on every turn, and a long session's screenshots would make it
 * hundreds of MB. `toolResultReplayText` turns this into the note the model
 * reads on the next request.
 */
export interface ToolImageMeta {
    mimeType: string;
    /** Decoded byte size of the original image. */
    bytes: number;
    caption?: string;
}

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
            // Images persist as METADATA ONLY (never base64 - the session file
            // is rewritten every turn). `historyRowFromEvent` substitutes the
            // text note a replay needs from this.
            ...(Array.isArray(event.images) && event.images.length
                ? { images: event.images.map(toolImageMeta) }
                : {}),
        };
    }
    return null;
}

/**
 * The text a REPLAYED tool row carries when its images are gone. Only the
 * metadata survived persistence, so this is the model's only signal that the
 * picture it saw earlier is no longer attached.
 */
export function toolResultReplayText(output: string, images: unknown): string {
    if (!Array.isArray(images) || images.length === 0) return output;
    const sizes = images
        .map((i: any) => (typeof i?.bytes === 'number' && i.bytes > 0
            ? `${(i.bytes / 1024).toFixed(0)} KB`
            : null))
        .filter(Boolean);
    const detail = sizes.length ? ` (${sizes.join(', ')})` : '';
    const note = `[${images.length} image(s) from this tool result are not retained in session history${detail} - re-run the tool if you need to see them again]`;
    return output ? `${output}\n${note}` : note;
}

/** Size/mime summary of a tool image, safe to write to disk. */
function toolImageMeta(image: any): ToolImageMeta {
    const dataBase64 = typeof image?.dataBase64 === 'string' ? image.dataBase64 : '';
    return {
        mimeType: typeof image?.mimeType === 'string' ? image.mimeType : '',
        bytes: base64ByteLength(dataBase64),
        ...(typeof image?.caption === 'string' && image.caption ? { caption: image.caption } : {}),
    };
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
            // A replayed tool row has no images (only metadata was persisted),
            // so the text must SAY so. Replaying the bare text would leave the
            // model reading a screenshot description with no picture attached,
            // which reads as a broken tool rather than a restored session.
            content: toolResultReplayText(event.output, event.images),
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
 *
 * ORPHAN `tool` rows are dropped. A provider requires every `tool` message to
 * answer a `tool_calls` entry in a PRECEDING assistant message, and rejects the
 * whole request otherwise. A row can lose its owner: the crash snapshot keeps
 * only the last `PENDING_TURN_EVENT_LIMIT` pending-turn events, and that cut
 * can land between an `assistant_message` (which carries the tool_calls) and its
 * `tool_result`. The result is replayed as a `tool` row with nothing above it,
 * and every later message in the session then fails with an opaque
 * `invalid_request_error` - the session is unrecoverable without discarding it.
 * Filtering here rather than only at persist time is deliberate: it also
 * REPAIRS snapshots already on disk, which no re-save would otherwise fix.
 *
 * The complementary case (an assistant `tool_calls` with no answer) is handled
 * by the commit paths, which append a placeholder result row.
 */
export function buildReplayHistory(rows: readonly LocalSessionHistoryMessage[]): LocalAgentMessage[] {
    const out: LocalAgentMessage[] = [];
    // Ids of tool_calls declared by assistant rows already emitted. A `tool` row
    // is only replayable while its owner is still in the message list.
    const declared = new Set<string>();
    for (const row of rows) {
        if (row.role === 'tool') {
            if (row.tool_call_id == null || !declared.has(row.tool_call_id)) continue;
            out.push({
                role: 'tool',
                tool_call_id: row.tool_call_id,
                content: row.content ?? '',
                ...(row.isError != null ? { isError: row.isError } : {}),
            });
            continue;
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
        for (const tc of toolCalls ?? []) {
            if (tc.id != null) declared.add(tc.id);
        }
        out.push({
            role: row.role as LocalAgentMessage['role'],
            content: row.content ?? '',
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
            ...(row.isError != null ? { isError: row.isError } : {}),
            ...(row.providerBlocks ? { providerBlocks: row.providerBlocks } : {}),
            ...(row.reasoningContent ? { reasoningContent: row.reasoningContent } : {}),
        });
    }
    return out;
}
