/**
 * Deterministic context-window management for the local agent: token
 * estimation, the proactive/forced compaction trim, tool-result elision and
 * bounding, and the context hints. Model-free by construction - the
 * summarizing path lives in compaction.ts. Split out of localAgent.ts
 * (which re-exports the public names below); VS Code-free.
 */

import { base64ByteLength } from './imageFormat';
import type { LocalAgentMessage, LocalToolDefinition } from './localTypes';

export function estimateMessageTokens(message: LocalAgentMessage): number {
    // Image parts must NOT go through JSON.stringify: a 300 KB screenshot is
    // ~400 KB of base64 text, which at 3 chars/token estimates as ~130k tokens
    // against a real cost of ~1.1k. That single mis-estimate triggers compaction
    // on nearly every run that takes a screenshot. Images get a tile estimate;
    // only the TEXT parts are counted by length.
    let content: string;
    let imageTokens = 0;
    if (typeof message.content === 'string') {
        content = message.content;
    } else if (Array.isArray(message.content)) {
        const texts: string[] = [];
        for (const part of message.content) {
            if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
            else if (part.type === 'image_url' && part.image_url?.url) {
                imageTokens += estimateImageTokens({
                    url: part.image_url.url,
                    width: part.image_url.width,
                    height: part.image_url.height,
                });
            }
        }
        content = texts.join('');
    } else {
        content = '';
    }
    const calls = message.tool_calls ? JSON.stringify(message.tool_calls) : '';
    // Provider-native reasoning blocks are RESENT on the continuation, so
    // their tokens count too - otherwise a reasoning-heavy turn is
    // under-counted and the continuation overflows without compaction.
    const provider = message.providerBlocks ? JSON.stringify(message.providerBlocks) : '';
    // Chat Completions re-sends captured reasoning the same way, so it counts
    // too - otherwise a thinking-heavy turn is under-counted and the
    // continuation overflows without compaction noticing.
    const reasoning = message.reasoningContent ?? '';
    // ~3 chars/token. This errs HIGH (over-budget) - the safe direction, so
    // the model sees slightly more usage than reality and never overruns.
    return Math.ceil((content.length + calls.length + provider.length + reasoning.length) / 3)
        + imageTokens;
}

/** Flat estimate when an image's pixel size is unknown (an MCP server). */
const IMAGE_TOKENS_FLAT_ESTIMATE = 1_100;
/** Low-detail base cost, which every image pays before its tiles. */
const IMAGE_TOKENS_BASE = 85;
/** OpenAI high-detail tiles are 512x512. */
const IMAGE_TILE_PX = 512;
/** OpenAI high-detail resizes the shortest side to this. */
const IMAGE_SHORT_SIDE_PX = 768;
/** ...and then caps the longest side at this. */
const IMAGE_LONG_SIDE_PX = 2048;
/** Per-tile cost at high detail. */
const IMAGE_TOKENS_PER_TILE = 1100;

/**
 * OpenAI's high-detail dimension normalization: shortest side to 768, then
 * longest side down to 2048, then tile at 512.
 *
 * The resize steps are not optional detail. Tiling the RAW dimensions
 * over-counts a square (4096x4096 -> 64 tiles -> 70k tokens against a real
 * 4,485, which would compact away the context for nothing) and, worse,
 * UNDER-counts a tall page: a 1280x6000 full-page screenshot tiles to 3x12 =
 * 40k naively, but after normalization the long side caps at 2048 and the
 * real cost is 83k. Under-counting is the direction that overflows the
 * window, and a tall capture is exactly what a browser tool produces.
 */
function normalizeImageDimensions(width: number, height: number): { w: number; h: number } {
    // Both steps are a single proportional scale, which is both simpler and
    // impossible to get backwards the way per-side arithmetic can be.
    let s = IMAGE_SHORT_SIDE_PX / Math.min(width, height);
    let w = Math.round(width * s);
    let h = Math.round(height * s);
    const longest = Math.max(w, h);
    if (longest > IMAGE_LONG_SIDE_PX) {
        s = IMAGE_LONG_SIDE_PX / longest;
        w = Math.round(w * s);
        h = Math.round(h * s);
    }
    return { w: Math.max(1, w), h: Math.max(1, h) };
}

/**
 * Rough token cost of an inline image.
 *
 * With known dimensions this is OpenAI's actual high-detail formula, so a
 * producer that knows its own output size (a browser screenshot knows its
 * viewport) gets a real number instead of a guess - which is why
 * `LocalToolImage` carries `width`/`height`.
 *
 * MCP servers do not report a size, so those fall back to the payload length:
 * under ~15 KB of base64 is a small icon (low-detail cost), anything bigger is
 * treated as a full screenshot. That branch deliberately errs HIGH - an
 * under-count means no compaction before a real overflow, an over-count only
 * costs an early one.
 */
export function estimateImageTokens(image: {
    url?: string;
    width?: number;
    height?: number;
    dataBase64?: string;
}): number {
    const { width, height } = image;
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
        const { w, h } = normalizeImageDimensions(width, height);
        const tiles = Math.ceil(w / IMAGE_TILE_PX) * Math.ceil(h / IMAGE_TILE_PX);
        return IMAGE_TOKENS_BASE + tiles * IMAGE_TOKENS_PER_TILE;
    }
    const payload = image.url ?? image.dataBase64 ?? '';
    const bytes = base64ByteLength(payload.includes(',') ? payload.slice(payload.indexOf(',') + 1) : payload);
    if (bytes <= 0) return IMAGE_TOKENS_FLAT_ESTIMATE;
    return bytes < 20_000 ? 200 : IMAGE_TOKENS_FLAT_ESTIMATE;
}


export function estimateRunTokens(messages: LocalAgentMessage[]): number {
    return messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
}

/** Rough token cost of the tool schemas shipped with every request - the
 *  message-content estimate misses these entirely, and on 4k–8k models the
 *  ~40 built-in + web tools can be 1.5k–3k tokens, enough to push a prompt
 *  over the window while the estimate still reads "room to spare". */
export function estimateToolTokens(tools: LocalToolDefinition[]): number {
    let chars = 0;
    for (const tool of tools) {
        chars += tool.name.length
            + (tool.description?.length ?? 0)
            + JSON.stringify(tool.inputSchema).length;
    }
    // Same ~3 chars/token as estimateMessageTokens.
    return Math.ceil(chars / 3);
}

// --- Context-window auto-compaction ---
// Local models often run 4k–16k windows, so compaction must trigger
// PROACTIVELY: once a request would fill >= 90% of the window, oldest turns
// are dropped until occupancy is back near 60% - keeping headroom below the
// hint thresholds instead of scraping the ceiling every turn.
export const AUTO_COMPACT_RATIO = 0.9;
const AUTO_COMPACT_TARGET_RATIO = 0.6;
// Hard memory ceiling for the pre-request pass, matching `boundHistory`'s 72%
// budget. The pre-request compaction gates at min(user threshold, this), so it
// fires at least as early as the old mechanical trim did - but WITH a summary.
// `boundHistory` ran BEFORE compaction, so the turns it ate were already gone
// by the time the summarizer could preserve them: a silent, permanent loss.
export const HISTORY_BOUND_RATIO = 0.72;

export const HISTORY_TRUNCATION_MARKER =
    '[Earlier messages in this conversation were removed to fit the context window. '
    + 'Continue seamlessly; do not mention this.]';

export function contextStatusLine(usedTokens: number, windowTokens?: number | null): string {
    if (!windowTokens || windowTokens <= 0) return '';
    const pct = Math.min(100, Math.round((usedTokens / windowTokens) * 100));
    return `\n\n[Context status: ${pct}% of the ${windowTokens}-token context window is in use (${usedTokens}/${windowTokens} tokens).]`;
}

export function contextHint(
    usedTokens: number,
    windowTokens?: number | null,
    compactRatio: number = AUTO_COMPACT_RATIO,
): string {
    if (!windowTokens || windowTokens <= 0) return '';
    const ratio = usedTokens / windowTokens;
    if (ratio > compactRatio) {
        return '\n\n⚠ CONTEXT CRITICAL: the context window is nearly exhausted and older turns may have been removed. Keep responses minimal, avoid re-reading files, and prefer precise edits.';
    }
    if (ratio > 0.7) {
        return "\n\n⚠ CONTEXT FULL: You are running out of context space. Keep responses concise. Avoid reading files you don't need.";
    }
    if (ratio > 0.5) {
        return '\n\n⚠ Context is getting full. Keep tool output and responses lean to save tokens.';
    }
    return '';
}

/**
 * Proactive auto-compact for the local loop. When the assembled messages
 * fill >= AUTO_COMPACT_RATIO of the model's window, oldest COMPLETE turns
 * are dropped (cuts land on user-message boundaries, so an assistant turn
 * is never separated from its tool results) until occupancy is back near
 * AUTO_COMPACT_TARGET_RATIO, leaving a truncation marker so the model knows
 * history was removed. `usedTokens` (server-reported prompt tokens) seeds
 * the occupancy when available - estimates miss tool schemas and always
 * undercount. Mutates `messages` in place; returns the dropped turns so the
 * caller can summarize them (empty when nothing was dropped).
 *
 * `force` is the server-confirmed-overflow recovery mode: the estimate just
 * proved wrong, so the ratio gate is bypassed and at least one complete
 * turn is always dropped (even past the target) - otherwise a single huge
 * turn or an under-counting estimate would make recovery a no-op that just
 * rethrows the overflow.
 */
export function compactMessages(
    messages: LocalAgentMessage[],
    windowTokens?: number | null,
    usedTokens?: number,
    toolTokens = 0,
    force = false,
    ratio: number = AUTO_COMPACT_RATIO,
    /** Index of the CURRENT TURN's opening user message. Nothing at or after
     *  it is dropped, and its tool results are never elided. Callers that use
     *  STEERING must pass it: a steer is a user row appended AFTER the turn
     *  opener, so the default (the last user row) would protect the steer and
     *  let compaction drop the user's actual request. Defaults to the last
     *  user row, which is correct when no steering occurred. */
    protectFromIndex?: number,
): LocalAgentMessage[] {
    // Proactive compaction keeps its 4k-window floor; forced recovery (the
    // server just rejected the prompt as too long) runs on ANY real window.
    if (!windowTokens || windowTokens < 1 || messages.length < 4) return [];
    // Include tool-schema overhead in the occupancy so the mechanical trim
    // fires on small windows where schemas are a large fraction of the prompt.
    let total = (usedTokens ?? estimateRunTokens(messages)) + toolTokens;
    // `ratio` is the caller's threshold (default AUTO_COMPACT_RATIO, settable
    // per run). Cline makes this user-configurable for good reason: the right
    // point to compact is a policy choice, not a constant - compacting early
    // costs cache hits and a summarizer call, compacting late risks overflow.
    if (!force && (windowTokens < 4096 || total < windowTokens * ratio)) return [];
    // The estimated prompt size that triggered this call. On a FORCED recovery
    // the server just REJECTED a prompt at least this big (the estimator is a
    // lower bound), so the configured window is demonstrably larger than the
    // model's real limit - and targeting a fraction of THIS, rather than of the
    // window, is what clears the real limit in one pass.
    const observed = total;

    // The current turn opens at `protectFromIndex` when the caller knows it
    // (steering-safe), else at the last user row. Everything from there on -
    // the user's request, assistant tool calls, tool results - stays intact.
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { lastUser = i; break; }
    }
    const turnStart = protectFromIndex != null && protectFromIndex > 1 ? protectFromIndex : lastUser;
    if (turnStart <= 1) return [];

    // Forced recovery targets a fraction of the OBSERVED size, not of the
    // configured window.
    //
    // Regression (measured from the usage ledger): with an override larger than
    // the model's real limit - 1M configured for a 128k model - the
    // window-relative target sat far ABOVE the failing prompt, so recovery
    // dropped exactly ONE turn, re-overflowed on the next request, and dropped
    // another. The user sees a sawtooth (129k -> 99k -> 58k) and loses turns
    // repeatedly, when one decisive trim would have cleared the real limit.
    // Basing the target on what actually failed does that in a single pass.
    const basis = force ? observed : windowTokens;
    const target = Math.max(2048, Math.floor(basis * AUTO_COMPACT_TARGET_RATIO));

    // CHEAP TIER, tried before anything is dropped or summarized: elide stale
    // tool output. It is model-free, costs nothing, and loses far less than
    // dropping a turn (which discards the user's request and the model's
    // reasoning along with the tool output). When it reclaims enough on its
    // own, return [] - no turns dropped and no summarizer call, which is the
    // difference between a gentle trim and an expensive, lossy one.
    //
    // The forced path deliberately does NOT take the early return: there the
    // estimate just proved unreliable (the server rejected the prompt), so a
    // turn is still dropped to guarantee progress. Elision simply means less
    // has to go.
    // `turnStart` bounds elision to the droppable history: the current turn
    // (from `turnStart` on) must stay intact, exactly as the turn loop below
    // guarantees for whole-turn drops.
    const beforeElision = estimateRunTokens(messages);
    if (elideOldToolResults(messages, TOOL_RESULT_ELISION_KEEP, turnStart)) {
        // Reclaim is measurable only in ESTIMATE units, so subtract it from
        // `total` rather than re-deriving `total` from the estimate. The old
        // formula subtracted `observed - estimate(messages) - toolTokens`,
        // which algebraically RESETS total to `estimate(messages) + toolTokens`
        // whenever `usedTokens` was supplied - silently discarding the
        // server-reported occupancy exactly when it matters most (the estimate
        // undercounts dense content, which is why `usedTokens` was passed).
        // Keeping `total`'s units is what makes the cheap tier safe to run
        // before the turn-drop loop on the mid-run, server-confirmed path.
        const reclaimed = Math.max(0, beforeElision - estimateRunTokens(messages));
        total = Math.max(0, total - reclaimed);
        if (!force && total <= target) return [];
    }
    let start = 1;
    while (start < turnStart && (total > target || (force && start === 1))) {
        let end = start + 1;
        while (end < turnStart && messages[end].role !== 'user') end++;
        const groupCost = estimateRunTokens(messages.slice(start, end));
        if (!force && total - groupCost < target) break;
        total -= groupCost;
        start = end;
    }
    if (start <= 1) return [];
    // splice(1, start-1) removes indices 1..start-1; the slice must cover
    // exactly the same range so the summarizer sees every dropped message.
    const dropped = messages.slice(1, start);
    messages.splice(1, start - 1, { role: 'user', content: HISTORY_TRUNCATION_MARKER });
    return dropped;
}

/** ~chars per token used by every estimator in this file. */
const TOOL_RESULT_CHARS_PER_TOKEN = 3;
/** Per-result ceiling as a fraction of the window. */
const TOOL_RESULT_MAX_RATIO = 0.4;
/** Total current-turn tool-output budget as a fraction of the window. */
const TOOL_RESULT_TOTAL_RATIO = 0.5;
/** Never clip a result below this many chars - a clipped stub stays useful. */
const TOOL_RESULT_MIN_CHARS = 800;
/** Last-resort replacement when even the floor cannot fit the budget. */
const TOOL_RESULT_OMISSION = '[tool output omitted to fit the context window]';

/** Tool results kept intact by the cheap elision tier (see below). */
export const TOOL_RESULT_ELISION_KEEP = 5;
/** Replacement for an elided tool result. Says how to recover the content. */
export const TOOL_RESULT_ELISION_MARKER =
    '[older tool result elided to reclaim context - re-run the tool if you need this output again]';

/**
 * CHEAP TIER of context reclamation: elide all but the most recent tool results.
 *
 * Modelled on Claude Code's micro-compaction, which is model-free and targets
 * tool output because that is the primary source of context bloat. It is
 * strictly gentler than what it replaces: dropping a whole turn loses the
 * user's request, the model's reasoning AND the tool output, while this loses
 * only stale tool output - and the model is told how to recover it.
 *
 * Deliberately model-free and free, so it can run BEFORE the expensive
 * summarization path. When it reclaims enough, the run skips both the turn
 * drops and the summarizer call entirely (see `compactMessages`).
 *
 * `beforeIndex` (the caller passes the CURRENT TURN's first index, `lastUser`)
 * bounds elision to turns that compaction may touch at all: a single user turn
 * can call more than `keepLast` tools, and eliding those mid-turn would strip
 * results the model is actively reasoning over - exactly what `compactMessages`
 * guarantees it will not do.
 *
 * A row is only replaced when the marker is genuinely SMALLER: a short result
 * ('ok') can be shorter than the marker, and growing it would raise occupancy
 * while the caller subtracts a zero reclaim, leaving its running estimate
 * stale and its target unmet.
 *
 * Mutates `messages`; returns the estimated tokens reclaimed.
 */
export function elideOldToolResults(
    messages: LocalAgentMessage[],
    keepLast = TOOL_RESULT_ELISION_KEEP,
    beforeIndex = messages.length,
): number {
    const limit = Math.min(beforeIndex, messages.length);
    const idxs: number[] = [];
    for (let i = 1; i < limit; i++) {
        // Multimodal tool results count too - a screenshot is usually the
        // LARGEST thing in the turn, and this is the cheap tier that runs
        // before any summarization.
        if (messages[i].role === 'tool' && typeof messages[i].content !== 'undefined') idxs.push(i);
    }
    if (idxs.length <= keepLast) return 0;
    const before = estimateRunTokens(messages);
    for (const i of idxs.slice(0, idxs.length - keepLast)) {
        const current = messages[i].content;
        if (typeof current === 'string' && current === TOOL_RESULT_ELISION_MARKER) continue;
        // Only replace when the marker is genuinely SMALLER, or we would RAISE
        // occupancy while the caller subtracts a zero reclaim (see the note on
        // this function).
        if (contentChars(current) <= TOOL_RESULT_ELISION_MARKER.length) continue;
        messages[i] = { ...messages[i], content: TOOL_RESULT_ELISION_MARKER };
    }
    return Math.max(0, before - estimateRunTokens(messages));
}

/**
 * Bound tool results to a window-relative budget.
 *
 * `compactMessages` only drops COMPLETE turns before the last user message, so
 * a single huge tool output (terminal results are capped at 200k chars,
 * expansion tools at 120k) can overflow a small window on its own and make
 * forced overflow recovery a no-op. Every tool result in the assembled
 * messages is bounded instead - including results that a STEERING message has
 * pushed behind the last user message, and large results kept from recent
 * turns. The most recent results (what the model is about to reason over) are
 * preserved longest.
 *
 * Three passes: a hard per-result cap, then oldest-first shrinking toward the
 * floor, then oldest-first omission. The final pass guarantees the aggregate
 * budget is met even when many results or large tool schemas would otherwise
 * defeat the floor. Accounting uses the ACTUAL returned length (the clip
 * marker is extra), so the tracked total matches what is sent.
 *
 * Mutates `messages`; returns true when anything changed.
 */
export function boundToolResults(
    messages: LocalAgentMessage[],
    windowTokens?: number | null,
    toolTokens = 0,
): boolean {
    if (!windowTokens || windowTokens < 1024) return false;

    // Index every tool message, NOT just the string-content ones: a tool result
    // carrying an image has ARRAY content, and skipping those would let an
    // arbitrarily large multimodal result bypass both caps entirely.
    const idxs: number[] = [];
    for (let i = 1; i < messages.length; i++) {
        if (messages[i].role === 'tool' && typeof messages[i].content !== 'undefined') idxs.push(i);
    }
    if (!idxs.length) return false;

    const windowChars = windowTokens * TOOL_RESULT_CHARS_PER_TOKEN;
    const perResultCap = Math.max(TOOL_RESULT_MIN_CHARS, Math.floor(windowChars * TOOL_RESULT_MAX_RATIO));
    // Tool SCHEMAS also consume the window - subtract them from the budget
    // (they may consume it entirely; the omission pass still enforces this).
    const totalBudget = Math.max(
        0,
        Math.floor(windowChars * TOOL_RESULT_TOTAL_RATIO) - toolTokens * TOOL_RESULT_CHARS_PER_TOKEN,
    );

    let changed = false;
    let total = 0;

    // Pass 1: per-result cap.
    for (const i of idxs) {
        if (contentChars(messages[i].content) > perResultCap) {
            messages[i] = { ...messages[i], content: clipToolContent(messages[i].content, perResultCap) };
            changed = true;
        }
        total += contentChars(messages[i].content);
    }
    if (total <= totalBudget) return changed;

    // Pass 2: shrink the OLDEST results toward the floor.
    for (const i of idxs) {
        if (total <= totalBudget) break;
        const text = contentText(messages[i].content);
        if (text.length <= TOOL_RESULT_MIN_CHARS) continue;
        const target = Math.max(TOOL_RESULT_MIN_CHARS, text.length - (total - totalBudget));
        if (target >= text.length) continue;
        const before = contentChars(messages[i].content);
        messages[i] = { ...messages[i], content: clipToolContent(messages[i].content, target) };
        total -= before - contentChars(messages[i].content);
        changed = true;
    }

    // Pass 3: the floor is not enough (many results / schema-heavy window) -
    // omit the OLDEST results outright so the budget is always enforced.
    // Keyed on the whole message's weight, not just its text: an image still
    // riding along (because its text alone was under the floor) has to be
    // reclaimable too, or a run of screenshot-only results is unshrinkable.
    for (const i of idxs) {
        if (total <= totalBudget) break;
        const before = contentChars(messages[i].content);
        if (before <= TOOL_RESULT_OMISSION.length) continue;
        messages[i] = { ...messages[i], content: TOOL_RESULT_OMISSION };
        total -= before - TOOL_RESULT_OMISSION.length;
        changed = true;
    }
    return changed;
}

/** The TEXT of a tool message regardless of whether images ride along. */
function contentText(content: LocalAgentMessage['content']): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => (p as { text: string }).text)
        .join('\n');
}

/**
 * Budget weight of a tool message. Images count at their base64 length so a
 * screenshot cannot hide from the budget - a 1 MB image is ~1.3 MB of wire
 * string and roughly two orders of magnitude more tokens than its text.
 */
function contentChars(content: LocalAgentMessage['content']): number {
    if (typeof content === 'string') return content.length;
    if (!Array.isArray(content)) return 0;
    let n = 0;
    for (const part of content) {
        if (part.type === 'text') n += (part.text ?? '').length;
        else if (part.type === 'image_url') n += (part.image_url?.url ?? '').length;
    }
    return n;
}

/**
 * Clip a tool message to `allowance` chars, dropping its IMAGES first (they
 * are the bulk and the text is what the model reasons over) and clipping the
 * text to what remains. Never leaves the model believing an image is still
 * there: the drop is recorded in the text it will read.
 */
function clipToolContent(content: LocalAgentMessage['content'], allowance: number): LocalAgentMessage['content'] {
    if (typeof content === 'string') return clipForSummary(content, allowance);
    if (!Array.isArray(content)) return content;
    const images = content.filter((p) => p.type === 'image_url');
    if (!images.length) return clipForSummary(contentText(content), allowance);
    const notice = `[${images.length} image(s) omitted to reclaim context - re-run the tool if you need to see them again]`;
    const text = contentText(content);
    const room = Math.max(0, allowance - notice.length);
    return [notice, clipForSummary(text, room)].join('\n');
}

export function clipForSummary(text: string, allowance: number): string {
    if (text.length <= allowance) return text;
    if (allowance <= 200) return text.slice(0, allowance) + '...';
    const head = Math.floor(allowance * 0.6);
    const tail = allowance - head;
    return text.slice(0, head) + '\n[...clipped...]\n' + text.slice(-tail);
}
