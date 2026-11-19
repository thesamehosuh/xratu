/** Recognize host-owned result envelopes after parent history is committed. */
export function committedChildResults(rows: Array<{role: string; content?: string; hostChildReport?: boolean; tool_call_id?: string; tool_calls?: Array<{id?: unknown; function?: {name?: unknown}}>}>): string[] {
    const calls = new Map<string, string>();
    const receipts = new Set<string>();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const accept = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const result = value as Record<string, unknown>;
        if (typeof result.id === 'string' && uuid.test(result.id) && result.executionId === result.id
            && typeof result.sessionId === 'string' && typeof result.text === 'string') receipts.add(result.id);
    };
    for (const row of rows) {
        if (row.role === 'user' && row.hostChildReport === true && row.content?.startsWith('{')) {
            try {
                const report = JSON.parse(row.content) as {type?: unknown; result_id?: unknown; report?: unknown};
                if (report.type === 'child_result' && typeof report.result_id === 'string' && uuid.test(report.result_id)
                    && typeof report.report === 'string') receipts.add(report.result_id);
            } catch { /* Ordinary user text is not a handoff receipt. */ }
        }
        for (const call of row.tool_calls ?? []) {
            if (typeof call?.id === 'string' && typeof call.function?.name === 'string') calls.set(call.id, call.function.name);
        }
        if (row.role !== 'tool') continue;
        const tool = calls.get(row.tool_call_id ?? '');
        if (tool === 'task') {
            // Only the runner's trailing receipt, never UUIDs quoted in a report.
            const receipt = /\n\[child_result: ([0-9a-f-]{36})\]$/.exec(row.content ?? '');
            if (receipt && uuid.test(receipt[1])) receipts.add(receipt[1]);
        } else if (tool === 'inspect_agents' || tool === 'wait_agents') {
            try {
                const sessions: unknown = JSON.parse(row.content ?? '');
                if (!Array.isArray(sessions)) continue;
                for (const session of sessions) {
                    if (!session || typeof session !== 'object') continue;
                    if (tool === 'inspect_agents') accept(session.latestResult);
                    else if (Array.isArray(session.results)) session.results.forEach(accept);
                }
            } catch { /* Failed tools do not carry result acknowledgements. */ }
        }
    }
    return [...receipts];
}
