/**
 * Cost formatting for the webview. Prices come from the host already resolved
 * in their own currency (USD normally, Toman for Iranian/gateway providers),
 * so this only formats and sums. Currencies are never converted.
 */

export interface Cost {
    amount: number;
    currency: 'USD' | 'IRT';
}

/** Human cost string, or null when there is nothing worth showing. */
export function formatCost(cost: Cost | null | undefined): string | null {
    if (!cost || !Number.isFinite(cost.amount) || cost.amount <= 0) return null;
    if (cost.currency === 'IRT') {
        const toman = Math.round(cost.amount);
        // Below half a Toman there is nothing to show.
        return toman > 0 ? `${toman.toLocaleString('fa-IR')} تومان` : null;
    }
    const usd = cost.amount;
    // Anything that would render as $0.0000 is effectively nothing - showing
    // it reads as a real (zero) charge.
    if (usd < 0.00005) return null;
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    if (usd < 1) return `$${usd.toFixed(3)}`;
    return `$${usd.toFixed(2)}`;
}

// NOTE: the session total is NOT summed here from message costs - it is
// host-owned and monotonic (a rewind/checkpoint restore must not refund
// already-spent tokens). See the `sessionCost` message.
