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

/**
 * Sum per-message costs in ONE currency - the currency of the most recent
 * cost. Amounts in another currency are skipped rather than added blindly
 * (USD + Toman would be meaningless, and the webview has no exchange rate).
 * A session normally runs against a single provider, so this only matters if
 * the user switches between an Iranian and a non-Iranian provider mid-chat.
 */
export function sumCosts(costs: Array<Cost | null | undefined>): Cost | null {
    const valid = costs.filter((c): c is Cost => !!c && Number.isFinite(c.amount));
    if (!valid.length) return null;
    const currency = valid[valid.length - 1].currency;
    let amount = 0;
    for (const cost of valid) {
        if (cost.currency === currency) amount += cost.amount;
    }
    return { amount, currency };
}
