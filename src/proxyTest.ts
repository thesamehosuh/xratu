/**
 * Planning + result-shaping for the Proxy page's connection test (pure - the
 * network probes live in extension.ts). The rules exist because of two false
 * greens the naive probe produced:
 *   1. A target that matches no_proxy (a localhost model runtime!) answers
 *      WITHOUT the proxy and "proved" a dead proxy works.
 *   2. A dead proxy produced only generic timeouts on random endpoints, never
 *      the one fact the user needs: the proxy itself is unreachable.
 * So when a proxy is configured, every target is FORCED through it, local
 *  targets are excluded, and the caller TCP-probes the proxy before any
 *  fetch. Failures carry i18n KEYS + params (never baked English).
 */
import { isHttpProxy, isSocksProxy } from './proxy';

/** Diverse captive-portal endpoints - any HTTP answer below 500 proves the
 *  route works. Diverse on purpose: single fixed hosts (Google's
 *  generate_204) are unreachable in some regions even through a healthy
 *  proxy, which made the old probe time out for a working route. */
export const PROXY_TEST_ENDPOINTS: readonly string[] = [
    'https://www.msftconnecttest.com/connecttest.txt',
    'https://detectportal.firefox.com/success.txt',
    'https://cp.cloudflare.com/generate_204',
    'https://www.gstatic.com/generate_204',
];

export interface ProxyTestTarget {
    url: string;
    /** true = must ride the proxy (the 'proxy' routing override). */
    throughProxy: boolean;
}

export interface ProxyTestPlan {
    targets: ProxyTestTarget[];
    /** i18n key set when the test cannot mean anything (bad scheme). */
    blockedKey?: string;
}

/** Decide what to probe and how. `providerUrl` is the active model provider
 *  (the route that matters most), `providerIsLocal` marks on-machine
 *  runtimes which prove nothing about the proxy. */
export function planProxyTest(options: {
    proxyUrl: string | null;
    providerUrl: string | null;
    providerIsLocal: boolean;
}): ProxyTestPlan {
    const proxyUrl = (options.proxyUrl ?? '').trim();
    if (proxyUrl) {
        if (isSocksProxy(proxyUrl)) {
            return { targets: [], blockedKey: 'proxySocksUnsupported' };
        }
        if (!isHttpProxy(proxyUrl)) {
            return { targets: [], blockedKey: 'proxyDetailBadScheme' };
        }
        const targets: ProxyTestTarget[] = [];
        if (options.providerUrl && !options.providerIsLocal) {
            targets.push({ url: options.providerUrl, throughProxy: true });
        }
        for (const url of PROXY_TEST_ENDPOINTS) {
            targets.push({ url, throughProxy: true });
        }
        return { targets };
    }
    // No proxy configured: the "route" IS direct - probe as-is, and a local
    // provider is a legitimate answer here.
    const targets: ProxyTestTarget[] = [];
    if (options.providerUrl) {
        targets.push({ url: options.providerUrl, throughProxy: false });
    }
    for (const url of PROXY_TEST_ENDPOINTS) {
        targets.push({ url, throughProxy: false });
    }
    return { targets };
}

export interface ProxyTestOutcome {
    ok: boolean;
    /** i18n key describing the failure (or the HTTP answer). */
    detailKey: string;
    params?: Record<string, string>;
}

export interface ProxyTestResult {
    ok: boolean;
    detailKey?: string;
    params?: Record<string, string>;
}

/** Fold probe outcomes into the page's verdict. Any success wins; on failure
 *  prefer a concrete reason (HTTP status, proxy error) over the generic
 *  timeout so the report explains WHY the route failed. */
export function summarizeProxyTest(outcomes: readonly ProxyTestOutcome[]): ProxyTestResult {
    if (outcomes.some((o) => o.ok)) return { ok: true };
    const concrete = outcomes.find((o) => o.detailKey !== 'proxyDetailTimeout');
    const chosen = concrete ?? outcomes[0];
    return chosen
        ? { ok: false, detailKey: chosen.detailKey, ...(chosen.params ? { params: chosen.params } : {}) }
        : { ok: false, detailKey: 'proxyDetailNoResponse' };
}
