/**
 * Compaction policy resolution - `xratu.autoCompactThreshold`.
 *
 * Kept free of the `vscode` import so it can be unit-tested in plain node
 * (see test/test-compaction-policy.mjs), following the precedent of
 * `agentRounds.ts` and `pythonWorkspace.ts`.
 *
 * WHY THIS IS A SETTING, NOT A CONSTANT
 *
 * The threshold was hardcoded (`AUTO_COMPACT_RATIO = 0.9`). Every comparable
 * harness treats it as policy instead:
 *
 *   - Cline: auto-compact at 80%, and their spec says the threshold "MUST be
 *     user-configurable".
 *   - Claude Code: tiered compaction driven by the measured fill, with the
 *     auto-compact window exposed to the user.
 *
 * The tradeoff is real and goes both ways, which is exactly why it should not
 * be baked in: compacting EARLY keeps the window comfortable but costs cache
 * hits (compaction rewrites history, invalidating the cached prefix) and a
 * summarizer call. Compacting LATE pays fewer of those but risks hitting the
 * provider's real limit, which is worse - a rejected request mid-turn.
 *
 * The default stays at the previous 0.9 so existing behaviour is unchanged.
 */

/** Fraction of the window at which proactive compaction fires. */
export const COMPACT_RATIO_DEFAULT = 0.9;
/** Never compact before half-full - that would thrash for no benefit. */
export const COMPACT_RATIO_MIN = 0.5;
/**
 * Always leave headroom. The estimator under-counts (no client tokenizer), so
 * 1.0 would mean compacting only after the provider has already rejected.
 */
export const COMPACT_RATIO_MAX = 0.95;

/**
 * Resolve a raw `xratu.autoCompactThreshold` value into a ratio in [MIN, MAX].
 *
 * Accepts a PERCENTAGE (the setting is presented as a percent for readability)
 * or a fraction, so both `90` and `0.9` mean the same thing. Anything
 * unusable - absent, non-numeric, NaN, Infinity, zero or negative - falls back
 * to the default rather than throwing: a malformed setting must not break a
 * run. Values above the range are clamped rather than rejected, so a user who
 * types `100` gets the safest legal value instead of silence.
 */
export function resolveCompactRatio(raw: unknown): number {
    const parsed = typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : Number.NaN;
    if (!Number.isFinite(parsed)) return COMPACT_RATIO_DEFAULT;
    // The setting is presented as a PERCENT, so anything at or above 1 is read
    // as one (90 -> 0.9, 1 -> 0.01). Only sub-1 values are fractions (0.9 ->
    // 0.9), which is unambiguous because "0.9 percent" is not a real intent.
    // Boundary at >= 1 rather than > 1 matters: a bare `1` must mean 1%, not
    // 100% - the field says percent, and 100% would defeat the headroom cap.
    const ratio = parsed >= 1 ? parsed / 100 : parsed;
    if (!Number.isFinite(ratio) || ratio <= 0) return COMPACT_RATIO_DEFAULT;
    return Math.min(COMPACT_RATIO_MAX, Math.max(COMPACT_RATIO_MIN, ratio));
}
