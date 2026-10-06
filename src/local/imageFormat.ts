/**
 * Image wire-format policy for the local agent: how attachments, tool
 * results and tool images are encoded on the wire, how a `data:` URL is
 * parsed, and how images are sized for token estimation. Split out of
 * localAgent.ts (which re-exports every public name below); VS Code-free.
 */

import type { ApiStyle } from './apiStyle';
import type { LocalAgentMessage, LocalToolImage } from './localTypes';

/**
 * Hard ceiling on a single inbound tool image. A buggy or hostile MCP server
 * can return an arbitrarily large image block; without a cap one call can
 * exhaust the context window (or the heap building the request body).
 * Oversize images are DROPPED, never truncated - a truncated image is a
 * corrupt image, which is worse for the model than an honest note.
 */
export const MAX_TOOL_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Media types every supported provider accepts in an inline image block.
 * Anthropic is the strictest (image/jpeg, image/png, image/gif, image/webp);
 * anything outside this set must be replaced by a text marker rather than
 * forwarded, or the whole NEXT request is rejected with a 400.
 */
export const PROVIDER_SAFE_IMAGE_MIME = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
]);

/** Whether a tool image can be forwarded to a provider as-is. */
export function isProviderSafeImageMime(mimeType: string): boolean {
    return PROVIDER_SAFE_IMAGE_MIME.has(String(mimeType || '').trim().toLowerCase());
}

/** Base64 payload size in bytes, without decoding it. Non-string input (a
 *  malformed block from a third-party server) measures as 0 rather than
 *  throwing - this runs inside tool dispatch, where an exception would take
 *  down the whole call instead of degrading one image. */
export function base64ByteLength(dataBase64: string): number {
    if (typeof dataBase64 !== 'string') return 0;
    const clean = dataBase64.replace(/\s/g, '');
    if (!clean) return 0;
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
}

/** `data:` URL for a tool image, honouring the negotiated wire format. */
export function toolImageDataUrl(
    image: LocalToolImage,
    format: ImageUrlFormat,
): string {
    return format === 'base64'
        ? image.dataBase64
        : `data:${image.mimeType};base64,${image.dataBase64}`;
}

/**
 * How image attachments are encoded in image_url.url.  OpenAI's spec wants a
 * `data:` URI, but popular local servers disagree: LM Studio (and Ollama's
 * compat endpoint) require RAW base64 and reject data URIs with
 * "'url' field must be a base64 encoded image", while vLLM/llama.cpp want the
 * data URI.  We start with the standard data URI and retry ONCE with raw
 * base64 when the server's 400 matches that error (see runLocalAgent).
 */
export type ImageUrlFormat = 'data-uri' | 'base64';

/**
 * Whether the raw-base64 fallback is even meaningful for a given API style.
 *
 * `image_url.url` is a CHAT-COMPLETIONS field, and the raw-base64 form exists
 * only to satisfy servers (LM Studio, Ollama's compat endpoint) that reject the
 * standard `data:` URI there. The messages / responses / google transports have
 * no such field: a data URI is the ONLY valid encoding and raw base64 is
 * unparseable, so applying the swap unconditionally SILENTLY DROPPED every
 * image on those three transports - the model got the text and no picture,
 * with nothing logged. One matching gateway 400 was enough to trigger it.
 */
export function imageFallbackApplies(apiStyle: ApiStyle): boolean {
    return apiStyle === 'chat';
}

/** Server 400s that indicate the image_url.url encoding was wrong. */
export const IMAGE_FORMAT_ERROR_RE = /must be a base64|base64 encoded image|unable to determine.+url|invalid image url/i;

/** MIME type of a `data:` URL, or '' when the string is not one. */
export function dataUrlMime(url: string): string {
    const m = /^data:([^;,]+)[;,]/i.exec(url.trim());
    return m ? m[1] : '';
}

/** Base64 payload of a `data:` URL, or '' when absent / not base64. */
export function dataUrlPayload(url: string): string {
    const t = url.trim();
    const comma = t.indexOf(',');
    if (comma < 0) return '';
    return /;base64/i.test(t.slice(0, comma)) ? t.slice(comma + 1).trim() : '';
}

/**
 * Tool-result message content: the text half, plus one inline image block per
 * tool image. Text comes FIRST so the model reads what the tool did before it
 * looks at the picture (Roo's `UseMcpToolTool` places images after text for
 * the same reason).
 *
 * Images no provider can accept are replaced by a text marker rather than
 * forwarded - one `image/svg+xml` block would otherwise 400 the next request
 * for the whole conversation. Same rule as goose's Anthropic allow-list.
 */
export function toolResultContent(
    text: string,
    images: LocalToolImage[] | undefined,
    imageFormat: ImageUrlFormat,
): LocalAgentMessage['content'] {
    if (!images?.length) return text;
    const content: NonNullable<LocalAgentMessage['content']> = [];
    if (text) content.push({ type: 'text', text });
    for (const image of images) {
        if (isProviderSafeImageMime(image.mimeType)) {
            content.push({
                type: 'image_url',
                image_url: {
                    url: toolImageDataUrl(image, imageFormat),
                    ...(image.width ? { width: image.width } : {}),
                    ...(image.height ? { height: image.height } : {}),
                },
            });
        } else {
            content.push({
                type: 'text',
                text: `[image omitted: unsupported type ${image.mimeType || 'unknown'}]`,
            });
        }
    }
    return content;
}

/** Whether any message carries an inline image part. */
export function messagesHaveImages(messages: LocalAgentMessage[]): boolean {
    return messages.some((m) => Array.isArray(m.content)
        && m.content.some((p) => p.type === 'image_url' && p.image_url?.url));
}

/**
 * Re-encode every inline image in `messages` to `format`, in place.
 *
 * Needed when the data-URI → raw-base64 fallback fires mid-run: a tool result
 * was encoded with the format in force when the tool ran, so without this the
 * retry would re-send the exact payload the server just rejected. Mutating
 * `messages` is safe for the same reason the opener swap is - the images live
 * in the current turn, which compaction never rewrites.
 */
export function reencodeMessageImages(
    messages: LocalAgentMessage[],
    format: ImageUrlFormat,
): void {
    for (let i = 0; i < messages.length; i++) {
        const content = messages[i].content;
        if (!Array.isArray(content)) continue;
        let changed = false;
        const next = content.map((part) => {
            if (part.type !== 'image_url' || !part.image_url?.url) return part;
            const mime = dataUrlMime(part.image_url.url);
            const payload = dataUrlPayload(part.image_url.url);
            if (!payload) return part; // already raw base64, or not a data URL
            // NOTE one-way: a RAW base64 payload carries no media type, so
            // re-wrapping it in a data: URL would need a mime we no longer
            // have. The swap is once-per-run and chat-only (the raw form is
            // valid only in `image_url.url`), so this never happens on the real
            // path; the guard is here so the function degrades to "leave it raw"
            // instead of emitting a `data:;base64,` URL a provider would reject.
            // The estimation dimensions MUST be carried across: dropping them
            // would silently downgrade the retry's context estimate to the
            // length heuristic and under-charge a known-size screenshot.
            changed = true;
            return {
                type: 'image_url' as const,
                image_url: {
                    url: format === 'base64' ? payload : `data:${mime};base64,${payload}`,
                    ...(part.image_url.width !== undefined ? { width: part.image_url.width } : {}),
                    ...(part.image_url.height !== undefined ? { height: part.image_url.height } : {}),
                },
            };
        });
        if (changed) messages[i] = { ...messages[i], content: next };
    }
}
