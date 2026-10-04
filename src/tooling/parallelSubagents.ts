/**
 * Concurrent-subagent resolution - `xratu.maxParallelSubagents`.
 *
 * When the model emits several `task` calls in one assistant message, those
 * delegations run concurrently (localAgent.ts `parallelTools`). Each one is a
 * FULL nested agent loop with its own context window, round budget and token
 * spend, so "N calls in one message" used to mean "N loops at once" with no
 * bound at all - one turn could fan out into a dozen 50-round loops and the
 * user learns about it from the bill. Competitors cap it too (codex: 4-6
 * concurrent threads; hermes-agent: 3).
 *
 * Exceeding the cap is not an error: the extra calls start in waves as slots
 * free up, in the order the model emitted them. Nothing is dropped and the
 * model sees every result.
 *
 * Kept free of the `vscode` import so it can be unit-tested in plain node
 * (see test/test-parallel-subagents.mjs).
 */

/** How many delegations run at once when the setting is unset. Deliberately
 *  small: a wave is a real cost multiplier, and the model's own batching
 *  habit is usually 2-4 anyway. */
export const PARALLEL_SUBAGENTS_DEFAULT = 4;

/** Never run zero at once (that would deadlock a round) and never run more
 *  than this, whatever the setting says: past ~8 the user's provider is being
 *  hit from that many loops at the same instant and providers start throttling
 *  or dropping streams. */
export const PARALLEL_SUBAGENTS_MIN = 1;
export const PARALLEL_SUBAGENTS_MAX = 8;

/**
 * Resolve a raw `xratu.maxParallelSubagents` value into a wave size.
 *
 * - absent, unusable, non-finite, zero or negative -> the default
 * - a positive number -> that many at a time (floored, clamped to 1..8)
 *
 * Never throws: a malformed setting must not take down a run.
 */
export function resolveParallelSubagents(raw: unknown): number {
    const parsed = typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return PARALLEL_SUBAGENTS_DEFAULT;
    return Math.min(PARALLEL_SUBAGENTS_MAX, Math.max(PARALLEL_SUBAGENTS_MIN, Math.floor(parsed)));
}