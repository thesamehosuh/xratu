/**
 * Credential-endpoint guards. Pure functions (no VS Code imports) so the
 * security-relevant hostname parsing can be unit-tested directly
 * (test/test-endpoint-guard.mjs).
 *
 * isLikelyLocalUrl drives two decisions:
 *  - the credential form's key-optional rule (on-machine runtimes usually
 *    need no API key), and
 *  - the cleartext-HTTP allowlist in insecureRemoteHttpError: an API key
 *    must never travel unencrypted to a NON-local endpoint.
 * It therefore parses the URL and matches exact loopback hosts and true
 * RFC1918 ranges only - substring/prefix checks would let
 * `http://localhost.attacker.example` or `http://172.200.1.1` (outside
 * 172.16/12) pose as local.
 */

export function isLikelyLocalUrl(baseUrl: string): boolean {
    try {
        const u = new URL(baseUrl.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        // WHATWG URL keeps IPv6 brackets in hostname - strip them.
        const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (host === 'localhost' || host.endsWith('.localhost')) return true;
        const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
        if (v4) {
            const octets = v4.slice(1).map(Number);
            if (octets.some((n) => n > 255)) return false;
            const [a, b] = octets;
            if (a === 127) return true; // full IPv4 loopback range
            if (a === 10) return true; // 10/8
            if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
            if (a === 192 && b === 168) return true; // 192.168/16
            return false;
        }
        return host === '::1';
    } catch {
        return false;
    }
}

/** Error key when a credential would leak its API key over remote cleartext
 *  HTTP; null when the combination is acceptable. Local/LAN endpoints keep
 *  their unencrypted-HTTP allowance, and keyless URLs are never blocked. */
export function insecureRemoteHttpError(baseUrl: string, apiKey: string | null | undefined): string | null {
    if (!apiKey) return null;
    if (!/^http:\/\//i.test(baseUrl.trim())) return null;
    if (isLikelyLocalUrl(baseUrl)) return null;
    return 'insecureEndpointHttp';
}

/** Policy for external MCP HTTP/SSE transports: null when the combination is
 *  acceptable, otherwise a rejection reason. Remote cleartext http: endpoints
 *  must not carry credential headers - mcp.json is hand-editable, so the
 *  UI-level check alone cannot be trusted. Local/LAN endpoints (and any
 *  header-less server) keep working. Callers pass only http(s) URLs. */
export function mcpCleartextHeadersError(url: string, headerCount: number): string | null {
    try {
        const u = new URL(url.trim());
        if (u.protocol === 'https:') return null;
        if (headerCount === 0) return null;
        if (isLikelyLocalUrl(url)) return null;
        return `credential headers require https: for remote endpoints (${u.protocol}//${u.host})`;
    } catch {
        return 'invalid URL';
    }
}
