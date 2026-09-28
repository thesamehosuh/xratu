// Canonical system prompt for the local agent runtime. Hand-maintained. Keep
// it free of audience and product-name directives: the ONE declared exception
// is the reply-language block below - it is a first-class input
// (`replyLanguage`), byte-stable like every other prompt input, not ad-hoc
// text.
export const LOCAL_SYSTEM_PROMPT = "You are an AI coding assistant.\nWarm and clear like a senior classmate. No emojis.\nAfter changing code, say briefly what changed (1-2 sentences) - never repeat the edited code and never mention internal tool names.\nBefore claiming victory, quickly verify your changes (re-read the edited file or run the relevant check) so your summary reflects reality.\nFor multi-step work you may maintain a visible checklist with `update_task_list` (complete list every call, exactly one item in_progress while executing) so the user can follow progress - useful for plan mode AND for any non-trivial execution you choose to track.";

/** Reply-language directives. Exported so the prompt-cache suite can assert
 *  the exact bytes. `auto` adds NOTHING to the prompt (byte-identical to the
 *  legacy prompt), because modern models already follow the user's message
 *  language - the explicit blocks exist to make it deterministic and to keep
 *  technical terms untranslated (the #1 failure mode of weaker/local models). */
export const REPLY_LANGUAGE_FA =
    "Language: reply to the user in Persian (Farsi). Keep code, identifiers, file paths, " +
    "commands, git commit messages, and technical terms (API, endpoint, commit, runtime, cache, " +
    "branch, token) in English - never translate them into invented Persian; only a settled " +
    "transliteration is fine where it is natural (کلید API). Git commit messages are ALWAYS English.";
export const REPLY_LANGUAGE_EN = "Language: reply to the user in English.";

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
 * turns), so they may rebuild the prompt then. `replyLanguage` is a user
 * setting read every turn - it is constant in practice, and flipping it once
 * costs one prefix miss like any other prompt change.
 */
export interface LocalSystemPromptInputs {
    /** Frozen project-rules snapshot (AGENTS.md chain). */
    rulesContext: string;
    /** Rolling compaction summary, or null. */
    sessionSummary: string | null;
    planMode: boolean;
    /** Count of oldest turns evicted from the model ledger. */
    evictedUserTurns: number;
    /** Explicit reply language; omitted/`auto` adds no language block. */
    replyLanguage?: 'fa' | 'en' | 'auto';
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
        "- `task` delegates a self-contained subtask to a subagent (fresh context; only its final report returns). Prefer it for codebase-wide research, project tours and independent multi-step subtasks - especially when the search may span many files; do small lookups and work that needs this conversation inline.",
    ];
    if (inputs.replyLanguage === 'fa') {
        parts.push("", REPLY_LANGUAGE_FA);
    } else if (inputs.replyLanguage === 'en') {
        parts.push("", REPLY_LANGUAGE_EN);
    }
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

/**
 * System prompt for a delegated subagent run. The agent file's body (the
 * profile's identity/instructions) leads; the operational notes state the
 * delegation contract the tool description promises the parent: only the
 * final report comes back, the prompt must be self-contained, and questions
 * asked mid-run are never answered. Same cache-stability rules as the parent
 * prompt apply (frozen rulesContext, no per-round content).
 */
export interface SubagentSystemPromptInputs {
    /** The agent profile body (system prompt of the child). */
    agentPrompt: string;
    /** Frozen project-rules snapshot (AGENTS.md chain). */
    rulesContext: string;
    planMode: boolean;
}

export function buildSubagentSystemPrompt(inputs: SubagentSystemPromptInputs): string {
    const parts: string[] = [
        inputs.agentPrompt,
        '',
        "Operational notes for subagent mode:",
        "- You are a delegated subagent inside a larger session. The parent agent - not the user - receives your FINAL MESSAGE, and only that message: your intermediate tool calls and reasoning stay private to you.",
        "- You have NO access to the parent conversation. Everything you need must be in the task you were given; if a detail is missing, make a reasonable assumption and state it in your report.",
        "- Do not ask questions and do not wait for input - work to a conclusion on your own.",
        "- Use local tools (read_file, edit_file, grep_search, etc.) for workspace inspection and changes; web_search and fetch_url access the web directly from this machine.",
        "- Finish with a complete, self-contained report: what you did or found (with file references), and anything the parent must know.",
    ];
    if (inputs.planMode) {
        parts.push(
            "",
            "PLAN MODE (READ-ONLY): mutating tools are unavailable. Report findings and a proposed plan; do not attempt to change anything.",
        );
    }
    if (inputs.rulesContext) {
        parts.push("", "Project Rules (from AGENTS.md):", inputs.rulesContext);
    }
    return parts.join('\n');
}
