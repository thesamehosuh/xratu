/**
 * Token accounting for the Usage page.
 *
 * The ledger records `input` as the FULL prompt and `cached` as a SUBSET of it
 * (the host's cost math relies on that: it subtracts `cached` to find the
 * uncached tokens). So any display that sums `input + output + cached`
 * double-counts every cache hit, and showing `input` as "Input" overstates the
 * billed input by the whole cache size. These helpers keep the three figures
 * disjoint for the UI.
 */

/** Uncached input = full prompt minus the cached subset (never negative). */
export function uncachedInput(input: number, cached: number): number {
    return Math.max(0, input - cached);
}

/** Disjoint token total: `input` already includes `cached`, so adding `cached`
 *  again would double-count every cache hit. */
export function totalTokens(t: { input: number; output: number }): number {
    return t.input + t.output;
}
