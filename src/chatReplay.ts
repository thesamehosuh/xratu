import type { HistoryMessage } from './chatViewTypes';

/** Steers are stored as user rows for rewind indexing and as ordered events.
 * Replay them at the event boundary, without also rendering the ledger copy.
 * Match the complete contiguous suffix so legacy/malformed rows aren't lost.
 */
export function displayHistoryForReplay(history: HistoryMessage[]): HistoryMessage[] {
    const skipped = new Set<number>();
    const rows = history.map((row, index) => {
        if (row.role !== 'assistant' || !row.events) return row;
        const steers = row.events.filter(event => event.type === 'steer_user');
        if (!steers.length) return row;
        const start = index - steers.length;
        if (start < 0 || !steers.every((event, offset) => {
            const user = history[start + offset];
            return user.role === 'user' && !user.cp && !user.hidden && user.content === event.text;
        })) return { ...row, events: row.events.filter(event => event.type !== 'steer_user') };
        for (let i = start; i < index; i++) skipped.add(i);
        return row;
    });
    return rows.filter((_, index) => !skipped.has(index));
}
