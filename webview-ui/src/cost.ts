/**
 * Cost formatting for the webview. Prices come from the host already resolved
 * (USD normally, Toman for Iranian providers when a rate is configured), so
 * this only formats and sums.
 */

export interface Cost {
    amount: number;
    currency: 'USD' | 'IRT';
}

/** Human cost string, or null when there is nothing to show. */
export function formatCost(cost: Cost | null | undefined): string | null {
    if (!cost || !Number.isFinite(cost.amount) || cost.amount <= 0) return null;
    if (cost.currency === 'IRT') {
        return `${Math.round(cost.amount).toLocaleString('fa-IR')} تومان`;
    }
    const usd = cost.amount;
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    if (usd < 1) return `$${usd.toFixed(3)}`;
    return `$${usd.toFixed(2)}`;
}

// NOTE: the session total is NOT summed here from message costs - it is
// host-owned and monotonic (a rewind/checkpoint restore must not refund
// already-spent tokens). See the `sessionCost` message.
