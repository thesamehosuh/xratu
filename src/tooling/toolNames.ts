/**
 * Tool-name resolution for live model drift. Dependency-free (no `vscode`)
 * so plain node can unit-test it.
 *
 * Models call writers by the name their OTHER harness uses (`write_file`)
 * and get a bare "Unknown tool" - a dead end that wastes a turn. Known
 * aliases resolve to the canonical tool; unknown names get the closest
 * canonical name as a suggestion instead of a shrug.
 */

/** Alias -> canonical tool name. Deliberately small: only names that models
 *  actually emit for an existing tool, never fuzzy guesses. */
export const TOOL_NAME_ALIASES: Record<string, string> = {
    write_file: 'edit_file',
    create_file: 'edit_file',
    new_file: 'edit_file',
    save_file: 'edit_file',
    str_replace: 'replace_in_file',
};

/** Resolve a model-supplied tool name against the canonical set.
 *  Returns the canonical name when known/aliased, else the best suggestion
 *  (edit distance <= 3, or a containment hit) for the error message. */
export function resolveToolName(
    name: string,
    known: readonly string[],
): { name: string; aliasedFrom?: string; suggestion?: string } {
    const direct = TOOL_NAME_ALIASES[name];
    if (direct && known.includes(direct)) return { name: direct, aliasedFrom: name };
    if (known.includes(name)) return { name };
    let best: string | null = null;
    let bestScore = Infinity;
    for (const candidate of known) {
        const d = editDistance(name, candidate);
        if (d < bestScore) { bestScore = d; best = candidate; }
    }
    if (best && bestScore <= 3) return { name, suggestion: best };
    for (const candidate of known) {
        if (candidate.includes(name) || name.includes(candidate)) {
            return { name, suggestion: candidate };
        }
    }
    return { name };
}

/** Bounded Levenshtein (early-exits above `max`). */
function editDistance(a: string, b: string, max = 4): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const prev = new Array<number>(b.length + 1);
    const cur = new Array<number>(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        let rowMin = cur[0];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
            if (cur[j] < rowMin) rowMin = cur[j];
        }
        if (rowMin > max) return max + 1;
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}
