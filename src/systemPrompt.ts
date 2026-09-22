// Canonical system prompt for the local agent runtime. Hand-maintained. Keep
// it locale-agnostic: no audience, language, or product-name directives here.
export const LOCAL_SYSTEM_PROMPT = "You are an AI coding assistant.\nWarm and clear like a senior classmate. No emojis.\nAfter changing code, say briefly what changed (1-2 sentences) - never repeat the edited code and never mention internal tool names.\nBefore claiming victory, quickly verify your changes (re-read the edited file or run the relevant check) so your summary reflects reality.\nFor multi-step work you may maintain a visible checklist with `update_task_list` (complete list every call, exactly one item in_progress while executing) so the user can follow progress - useful for plan mode AND for any non-trivial execution you choose to track.";

/**
 * The inputs that shape the local system prompt.
 *
 * PROMPT CACHING: the system prompt is the FIRST cacheable segment of every
 * request (tools + system + messages). Providers cache the longest
 * byte-identical PREFIX, so a system prompt that changes between turns forces
 * every message after it to be re-sent as a cache miss. `rulesContext` is
 * therefore session-frozen (see `local/rulesSnapshot.ts`) and must be replayed
 * byte-for-byte. The other fields change only on an event that already
 * invalidates the conversation prefix for independent reasons (compaction
 * rewrites history, plan mode changes the toolset, ledger eviction drops
 * turns), so they may rebuild the prompt then.
 */
export interface LocalSystemPromptInputs {
    /** Frozen project-rules snapshot (AGENTS.md chain). */
    rulesContext: string;
    /** Rolling compaction summary, or null. */
    sessionSummary: string | null;
    planMode: boolean;
    /** Count of oldest turns evicted from the model ledger. */
    evictedUserTurns: number;
}

/**
 * Build the local system prompt. Pure and dependency-free so the host and the
 * prompt-cache prefix suite exercise the SAME assembly - a test that rebuilds
 * the prompt its own way cannot catch a stability regression in the real path.
 */
export function buildLocalSystemPrompt(inputs: LocalSystemPromptInputs): string {
    const parts: string[] = [
        LOCAL_SYSTEM_PROMPT,
        "",
        "Operational notes for local mode:",
        "- Attached images are part of the current request only.",
        "- Use local tools (read_file, edit_file, grep_search, etc.) for workspace inspection and changes.",
        "- web_search and fetch_url access the web directly from this machine; if web_search reports no provider configured, rely on fetch_url or answer from your own knowledge.",
    ];
    if (inputs.planMode) {
        // Per-turn plan guidance for the local runtime.
        parts.push(
            "",
            "PLAN MODE (READ-ONLY): mutating tools are unavailable. Draft the implementation plan " +
            "as a task list with update_task_list (one item per verifiable step, every label ONE SHORT " +
            "single sentence ~10 words max, all items pending), then call exit_plan_mode ONCE to end " +
            "plan mode - execution becomes possible in the next turn.",
        );
    }
    if (inputs.rulesContext) {
        parts.push("", "Project Rules (from AGENTS.md):", inputs.rulesContext);
    }
    if (inputs.sessionSummary) {
        parts.push("", "Conversation summary:", inputs.sessionSummary);
    }
    if (inputs.evictedUserTurns > 0) {
        // The model ledger dropped its oldest turns to bound memory; the
        // display ledger still shows them. Say so (as prompt text, never as a
        // synthetic history row - a user row would shift turn indexing).
        parts.push(
            "",
            `Note: ${inputs.evictedUserTurns} older turn(s) were dropped from this session's context to bound memory. ` +
            "If the user refers to earlier work you cannot see, say so and ask them to restate it.",
        );
    }
    return parts.join('\n');
}
