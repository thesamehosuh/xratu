/**
 * One in-flight project-rules read per scope. Every completed resolve is
 * refreshed on the next turn, so edits, additions and removals take effect
 * without restarting the chat. Unchanged file contents still produce an
 * identical system prompt; rules are held fixed within each agent run.
 */
export class RulesSnapshot {
    private generation = 0;
    private inflightKey: string | null = null;
    private inflight: Promise<string> | null = null;

    async resolve(key: string, compute: () => Promise<string>): Promise<string> {
        if (this.inflight !== null && this.inflightKey === key) return this.inflight;
        const generation = ++this.generation;
        const read = compute();
        this.inflightKey = key;
        this.inflight = read;
        try {
            return await read;
        } finally {
            // An old read cannot clear a newer workspace/session's read.
            if (generation === this.generation) {
                this.inflight = null;
                this.inflightKey = null;
            }
        }
    }

    /** A new session must not coalesce with a previous session's pending read. */
    reset(): void {
        this.generation++;
        this.inflightKey = null;
        this.inflight = null;
    }
}
