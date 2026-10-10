/** Only recognize complete known shapes. Everything else keeps its raw output. */
export function searchMatches(text: string): Array<{ path: string; lines: Array<{ number: number; text: string }> }> | null {
    const groups = new Map<string, Array<{ number: number; text: string }>>();
    const lines = text.trim().split(/\r?\n/);
    if (!text.trim()) return null;
    for (const line of lines) {
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (!match) return null;
        const path = match[1];
        const group = groups.get(path) ?? [];
        group.push({ number: Number(match[2]), text: match[3] }); groups.set(path, group);
    }
    return [...groups].map(([path, lines]) => ({ path, lines }));
}

export function webResults(text: string): Array<{ title: string; url: string; snippet: string }> | null {
    const source = text.trim();
    const pattern = /^\d+\. (.+)\r?\n\s+(https?:\/\/[^\s]+)\r?\n([\s\S]*?)(?=^\d+\. |(?![\s\S]))/gm;
    const results = [];
    let through = 0;
    for (const match of source.matchAll(pattern)) {
        if (source.slice(through, match.index).trim()) return null;
        try { new URL(match[2]); } catch { return null; }
        results.push({ title: match[1], url: match[2], snippet: match[3].trim() });
        through = match.index! + match[0].length;
    }
    return results.length && !source.slice(through).trim() ? results : null;
}
