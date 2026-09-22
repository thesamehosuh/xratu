/**
 * Session-scoped snapshot of the project-rules context.
 *
 * PROMPT CACHING: the system prompt is the FIRST cacheable segment of every
 * request (tools + system + messages). Providers reuse the longest
 * byte-identical prefix, so a system prompt that changes between turns makes
 * every message after it a cache miss.
 *
 * Project rules were previously recomputed on EVERY turn from the active
 * editor's directory chain. Switching files that cross a nested AGENTS.md
 * rewrote the system prompt mid-session and dropped the whole conversation to a
 * cold prefix: measured live against OpenCode Go, every turn's first request
 * reported 0 cached tokens and the session aggregate fell under 50%, versus
 * ~95% at turn boundaries with a stable prompt.
 *
 * Rules are therefore resolved ONCE per session (keyed by the workspace root)
 * and replayed byte-for-byte until a new session starts or the workspace
 * changes. Nested AGENTS.md files are picked up on the NEXT session - the same
 * snapshot-at-session-start contract that tool schemas and skills already use.
 */
export class RulesSnapshot {
    private key: string | null = null;
    private value: string | null = null;

    /**
     * Return the rules for `key`, computing them only when the snapshot is
     * empty or the key changed. The compute runs at most once per key, so a
     * mid-session active-file change cannot alter the cached prefix.
     */
    async resolve(key: string, compute: () => Promise<string>): Promise<string> {
        if (this.value !== null && this.key === key) return this.value;
        const value = await compute();
        this.key = key;
        this.value = value;
        return value;
    }

    /** Drop the snapshot so the next resolve recomputes (new session). */
    reset(): void {
        this.key = null;
        this.value = null;
    }
}
