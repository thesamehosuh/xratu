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

/** Sum per-message costs. A session runs against one provider, so the last
 *  currency seen wins (mixing USD and Toman in one total would be a lie). */
export function sumCosts(costs: Array<Cost | null | undefined>): Cost | null {
    let amount = 0;
    let currency: 'USD' | 'IRT' = 'USD';
    let any = false;
    for (const cost of costs) {
        if (!cost || !Number.isFinite(cost.amount)) continue;
        amount += cost.amount;
        currency = cost.currency;
        any = true;
    }
    return any ? { amount, currency } : null;
}
