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
    /** Monotonic resolve id. A read that started before a newer resolve must
     *  not adopt its (stale) result over the newer key's snapshot. */
    private generation = 0;
    private inflightKey: string | null = null;
    private inflight: Promise<string> | null = null;

    /**
     * Return the rules for `key`, computing them only when the snapshot is
     * empty or the key changed. Concurrent callers for the SAME key share one
     * read, and a read that completes after a newer resolve started is
     * discarded, so the snapshot always reflects the latest key.
     */
    async resolve(key: string, compute: () => Promise<string>): Promise<string> {
        if (this.value !== null && this.key === key) return this.value;
        // Coalesce concurrent callers asking for the SAME key onto one read.
        if (this.inflight !== null && this.inflightKey === key) return this.inflight;

        const generation = ++this.generation;
        const read = compute();
        this.inflightKey = key;
        this.inflight = read;
        try {
            const value = await read;
            // Only adopt when no newer resolve started while we read: a stale
            // completion must not overwrite a newer key's snapshot.
            if (generation === this.generation) {
                this.key = key;
                this.value = value;
            }
            return value;
        } finally {
            // Leave a newer resolve's in-flight read in place.
            if (generation === this.generation) {
                this.inflight = null;
                this.inflightKey = null;
            }
        }
    }

    /** Drop the snapshot so the next resolve recomputes (new session). Any
     *  in-flight read is invalidated so it cannot adopt after the reset. */
    reset(): void {
        this.generation++;
        this.key = null;
        this.value = null;
        this.inflight = null;
        this.inflightKey = null;
    }
}
