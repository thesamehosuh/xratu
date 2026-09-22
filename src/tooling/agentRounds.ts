/**
 * Agent-loop round budget resolution - `xratu.maxAgentRounds`.
 *
 * A "round" is one agent-loop iteration within a SINGLE turn: model request
 * -> tool calls -> results -> repeat.
 *
 * The default is UNLIMITED, because a fixed cap is not how a coding agent
 * should terminate. The loop already has a correct natural stop: when the
 * model returns no tool calls it yields its final answer and returns (see the
 * `!finalResult.toolCalls.length` branch in localAgent.ts). The post-loop
 * wrap-up path is therefore only reachable when a COUNT exhausted the budget
 * - so with no cap it simply never fires.
 *
 * This used to be unconfigurable in a way that made long workflows
 * impossible: extension.ts passed a hardcoded `maxRounds: 25` and the runtime
 * then clamped it with `Math.min(..., 32)`. There was no setting to raise, and
 * the clamp would have silently discarded one. A long task was cut off
 * mid-work by the wrap-up nudge with no way to extend it.
 *
 * The cap is still available for anyone who wants a hard stop (a runaway
 * model on a metered API, unsupervised YOLO runs), but it is opt-in: unset,
 * zero, or negative all mean "no limit".
 *
 * Kept free of the `vscode` import so it can be unit-tested in plain node
 * (see test/test-agent-rounds.mjs).
 */

/** Sentinel meaning "no cap": run until the model stops calling tools. */
export const AGENT_ROUNDS_UNLIMITED = Infinity;

/** The loop's default - unlimited. */
export const AGENT_ROUNDS_DEFAULT = AGENT_ROUNDS_UNLIMITED;

/** Smallest meaningful finite cap; a positive value is floored here. */
export const AGENT_ROUNDS_MIN = 1;

/**
 * Resolve a raw `xratu.maxAgentRounds` value into a round count.
 *
 * - absent, unusable, non-finite, zero or negative -> UNLIMITED
 * - a positive number -> that many rounds (floored, at least 1)
 *
 * There is deliberately NO upper clamp: the value is the user's explicit
 * choice, and clamping it is what silently broke long runs before. Never
 * throws - a malformed setting must not take down a run.
 */
export function resolveAgentRounds(raw: unknown): number {
    const parsed = typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : Number.NaN;
    // NaN (absent/garbage), Infinity/-Infinity: no usable finite budget.
    if (!Number.isFinite(parsed)) return AGENT_ROUNDS_UNLIMITED;
    // 0 and negatives are the documented "no limit" spellings, not errors.
    if (parsed <= 0) return AGENT_ROUNDS_UNLIMITED;
    return Math.max(AGENT_ROUNDS_MIN, Math.floor(parsed));
}
