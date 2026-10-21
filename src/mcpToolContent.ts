import { MAX_TOOL_IMAGE_BYTES, base64ByteLength, isProviderSafeImageMime } from './local/imageFormat';
import type { LocalToolImage } from './local/localTypes';
import type { ExternalToolResult } from './externalMcp';

/** One MCP content block, as loosely as the wire allows. */
interface McpContentBlock {
    type: string;
    text?: string;
    mimeType?: string;
    data?: string;
    resource?: { mimeType?: string; blob?: string; uri?: string };
}

/**
 * Aggregate ceiling on ONE tool call's images. The per-image cap bounds a
 * single block; nothing bounded the COUNT, so a server (or a bug) returning
 * 50 max-size images got all 50 mapped - measured at 533 MB of base64 before
 * any downstream context bound ran.
 */
export const MAX_TOOL_IMAGES_PER_CALL = 20;
/** Aggregate ceiling on one call's decoded image bytes. */
export const MAX_TOOL_IMAGE_TOTAL_BYTES = 24 * 1024 * 1024;

/**
 * Map an MCP `CallToolResult.content` array onto `{text, images}`.
 *
 * Three block shapes carry a picture:
 *   - `{type:'image', mimeType, data}` - the standard image block;
 *   - `{type:'resource', resource:{mimeType, blob}}` - an embedded binary
 *     resource (some servers use this for screenshots instead);
 *   - `{type:'text'}` with a bare data URL - tolerated, since a server that
 *     mislabels the block type should still show the user its picture.
 *
 * Three independent limits, each with its own refusal note, so the model is
 * never left believing it saw something it did not: a per-image size cap, an
 * aggregate byte/count cap, and a provider-safe media-type allowlist. Images
 * are DROPPED, never truncated - a truncated image is a corrupt image, which
 * is worse than an honest note.
 */
export function mapMcpToolContent(
    content: unknown,
    toolName = 'tool',
): ExternalToolResult {
    if (!Array.isArray(content)) return { text: '', images: [] };
    const images: LocalToolImage[] = [];
    const texts: string[] = [];
    let totalBytes = 0;
    for (const raw of content) {
        const block = (raw ?? {}) as McpContentBlock;
        const note = (text: string) => texts.push(`[${toolName}: ${text}]`);
        if (block.type === 'image' || (block.type === 'text' && looksLikeDataUrl(block.text))) {
            // Type-check before use: these fields come off the wire from a
            // third-party server, and a non-string here would throw inside tool
            // dispatch (losing the whole call) instead of degrading one image.
            const mimeType = typeof block.mimeType === 'string' && block.mimeType
                ? block.mimeType
                : dataUrlMime(block.text);
            const data = typeof block.data === 'string' && block.data
                ? block.data
                : dataUrlPayload(block.text);
            if (!data) {
                note('image block carried no data and was skipped');
                continue;
            }
            if (!isProviderSafeImageMime(mimeType)) {
                note(`image of unsupported type ${mimeType || 'unknown'} was not forwarded`);
                continue;
            }
            const bytes = base64ByteLength(data);
            if (bytes > MAX_TOOL_IMAGE_BYTES) {
                note(`image of ${(bytes / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_TOOL_IMAGE_BYTES / 1024 / 1024} MB limit and was omitted`);
                continue;
            }
            if (images.length >= MAX_TOOL_IMAGES_PER_CALL) {
                note(`only the first ${MAX_TOOL_IMAGES_PER_CALL} images of this result were kept`);
                continue;
            }
            if (totalBytes + bytes > MAX_TOOL_IMAGE_TOTAL_BYTES) {
                note(`the remaining images exceed the ${MAX_TOOL_IMAGE_TOTAL_BYTES / 1024 / 1024} MB per-result total and were omitted`);
                continue;
            }
            totalBytes += bytes;
            images.push({ mimeType, dataBase64: data });
            continue;
        }
        if (block.type === 'resource' && typeof block.resource?.blob === 'string' && block.resource.blob) {
            const mimeType = typeof block.resource.mimeType === 'string' ? block.resource.mimeType : '';
            if (!isProviderSafeImageMime(mimeType)) {
                note(`embedded resource of unsupported type ${mimeType || 'unknown'} was not forwarded`);
                continue;
            }
            const bytes = base64ByteLength(block.resource.blob);
            if (bytes > MAX_TOOL_IMAGE_BYTES) {
                note(`embedded resource of ${(bytes / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_TOOL_IMAGE_BYTES / 1024 / 1024} MB limit and was omitted`);
                continue;
            }
            if (images.length >= MAX_TOOL_IMAGES_PER_CALL) {
                note(`only the first ${MAX_TOOL_IMAGES_PER_CALL} images of this result were kept`);
                continue;
            }
            if (totalBytes + bytes > MAX_TOOL_IMAGE_TOTAL_BYTES) {
                note(`the remaining images exceed the ${MAX_TOOL_IMAGE_TOTAL_BYTES / 1024 / 1024} MB per-result total and were omitted`);
                continue;
            }
            totalBytes += bytes;
            images.push({ mimeType, dataBase64: block.resource.blob });
            continue;
        }
        if (typeof block.text === 'string' && block.text) texts.push(block.text);
    }
    return { text: texts.join('\n'), images };
}

function looksLikeDataUrl(text: string | undefined): text is string {
    return typeof text === 'string' && /^data:image\//i.test(text.trim());
}

function dataUrlMime(text: string | undefined): string {
    const m = /^data:([^;,]+)[;,]/i.exec((text ?? '').trim());
    return m ? m[1].toLowerCase() : '';
}

function dataUrlPayload(text: string | undefined): string {
    const t = (text ?? '').trim();
    const comma = t.indexOf(',');
    if (comma < 0) return '';
    return /;base64/i.test(t.slice(0, comma)) ? t.slice(comma + 1).trim() : '';
}

/** Structured-only MCP tools still need useful model text. Keep a bounded JSON
 * copy independently; neither remote object graphs nor control fields are trusted. */
export function boundedStructuredContent(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    let remaining = 48_000;
    let nodes = 0;
    const visit = (item: unknown, depth: number): unknown => {
        if (++nodes > 1000 || depth > 8 || remaining <= 0) return '[truncated]';
        if (typeof item === 'string') { const result = item.slice(0, Math.min(remaining, 8000)); remaining -= result.length; return result; }
        if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
        if (Array.isArray(item)) return item.slice(0, 100).map(child => visit(child, depth + 1));
        if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, 100).map(([key, child]) => [key.slice(0, 100), visit(child, depth + 1)]));
        return null;
    };
    return visit(value, 0) as Record<string, unknown>;
}
export function mapMcpToolResult(result: Record<string, unknown>, toolName: string): ExternalToolResult {
    const mapped = mapMcpToolContent(result.content, toolName);
    const structuredContent = boundedStructuredContent(result.structuredContent);
    return { ...mapped, ...(!mapped.text && structuredContent ? { text: JSON.stringify(structuredContent) } : {}), ...(structuredContent ? { structuredContent } : {}) };
}
