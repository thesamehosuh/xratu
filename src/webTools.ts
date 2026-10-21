/**
 * Compatibility entry point and public URL guard for automatic research.
 *
 * These tools execute in the extension host for built-in and bridged agents. Behavior, limits, and error strings are part of the contract the
 * model sees.
 */
import * as dns from 'dns';
import { isIPv4 } from 'net';
import { isProxyConfigured } from './proxyDispatcher';

import { executeResearch } from './web/service';
import { getWebToolConfig } from './web/config';
export { getWebToolConfig } from './web/config';
export type { WebToolConfig } from './web/types';
import type { WebToolConfig, ResearchResult } from './web/types';

/**
 * Expand an IPv6 address to its 8 16-bit groups. Handles `::` compression and
 * embedded dotted-quad tails (`::ffff:127.0.0.1`), which dns.lookup can return
 * verbatim for IPv4-mapped literals. Returns null for anything unparseable.
 */
function expandIpv6(addr: string): number[] | null {
    let s = addr.toLowerCase();
    const embedded = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (embedded) {
        const o = embedded[2].split('.').map(Number);
        if (o.length !== 4 || o.some((p) => p > 255)) return null;
        s = embedded[1] + (((o[0] << 8) | o[1]).toString(16)) + ':' + (((o[2] << 8) | o[3]).toString(16));
    }
    const dbl = s.split('::');
    if (dbl.length > 2) return null;
    const head = dbl[0] ? dbl[0].split(':') : [];
    const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
    const groups: string[] = dbl.length === 2
        ? [...head, ...new Array(8 - head.length - tail.length).fill('0'), ...tail]
        : head;
    if (dbl.length === 2 && groups.length !== 8) return null;
    if (dbl.length === 1 && groups.length !== 8) return null;
    const nums: number[] = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        nums.push(parseInt(g, 16));
    }
    return nums;
}

function embeddedIpv4(groups: number[]): string | null {
    // IPv4-mapped ::ffff:0:0/96, deprecated IPv4-compatible ::/96, and
    // NAT64 64:ff9b::/96 all place a real IPv4 address in the low 32 bits -
    // the address must be judged by the IPv4 rules, not the prefix text.
    const zeroTo4 = groups.slice(0, 5).every((g) => g === 0);
    const mappedOrCompat = zeroTo4 && (groups[5] === 0xffff || groups[5] === 0);
    const nat64 = groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
    if (!mappedOrCompat && !nat64) return null;
    const [h, l] = [groups[6], groups[7]];
    return `${(h >> 8) & 0xff}.${h & 0xff}.${(l >> 8) & 0xff}.${l & 0xff}`;
}

/**
 * 198.18.0.0/15 (RFC 2544 benchmark range) is DELIBERATELY not forbidden. It
 * is not routable on the public internet; its only real-world appearance is
 * fake-IP DNS from proxy-tunnel clients (Clash Verge, sing-box TUN mode) -
 * common on the censored networks this product targets. There the fetch is
 * transparently intercepted by the tunnel and succeeds; refusing it would
 * break every major site.
 */
function isForbiddenAddress(ip: string): boolean {
    const addr = ip.includes('/') ? ip.split('/')[0] : ip;
    if (isIPv4(addr)) {
        const [a, b] = addr.split('.').map(Number);
        if (a === 198 && (b === 18 || b === 19)) return false;
        return (
            a === 10 || a === 127 || a === 0 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            (a === 100 && b >= 64 && b <= 127) ||
            a >= 224
        );
    }
    const groups = expandIpv6(addr);
    // Unparseable input is refused - never allowed.
    if (!groups) return true;
    const g0 = groups[0];
    if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
    if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((g0 & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
    // :: (unspecified) and ::1 (loopback) fall out of the embedded-IPv4
    // branch as 0.0.0.0 / 0.0.0.1 - both forbidden there.
    const v4 = embeddedIpv4(groups);
    if (v4) return isForbiddenAddress(v4);
    return false;
}

export async function validatePublicUrl(url: string, proxyConfigured = isProxyConfigured(url)): Promise<string> {
    let parsed: URL;
    try {
        parsed = new URL(url.trim());
    } catch {
        throw new Error('Invalid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http:// and https:// URLs are allowed');
    }
    if (parsed.username || parsed.password) {
        throw new Error('URLs with embedded credentials are not allowed');
    }
    // `URL.hostname` keeps the brackets on an IPv6 literal, and dns.lookup
    // cannot resolve the bracketed form - strip them so literals are judged as
    // literals (and stop failing closed as "Host could not be resolved").
    const host = parsed.hostname.replace(/\.+$/, '').toLowerCase();
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

    if (isIPv4(bare) || expandIpv6(bare)) {
        // An IP literal needs NO name resolution, so the "the proxy resolves it
        // for us" argument that lets hostnames skip the blocklist does not
        // apply. Validating these unconditionally is what keeps the guard
        // meaningful for the audience this product actually serves: with a
        // Clash/sing-box system proxy configured (source: 'system'), the old
        // `if (!isProxyConfigured(url))` skipped the ENTIRE check, so
        // fetch_url reached 169.254.169.254 (cloud metadata), 127.0.0.1:9229
        // (Chrome DevTools) and the local Ollama - un-approved, in plan mode.
        if (isForbiddenAddress(bare)) {
            throw new Error(`Refusing non-public destination: ${bare}`);
        }
    } else if (!proxyConfigured) {
        let infos: dns.LookupAddress[];
        try {
            infos = await dns.promises.lookup(host, { all: true });
        } catch {
            throw new Error(`Host could not be resolved: ${host}`);
        }
        if (infos.length === 0) {
            throw new Error(`Host could not be resolved: ${host}`);
        }
        for (const info of infos) {
            if (isForbiddenAddress(info.address)) {
                throw new Error(`Refusing non-public destination: ${host} (${info.address})`);
            }
        }
    }
    return parsed.toString();
}

/** Compatibility entry point used by all built-in and bridged research tools. */
export async function executeWebTool(
    name: string,
    args: Record<string, unknown>,
    config?: WebToolConfig,
    signal?: AbortSignal,
): Promise<ResearchResult> {
    return executeResearch(name, args, config ?? await getWebToolConfig(), validatePublicUrl, signal);
}
