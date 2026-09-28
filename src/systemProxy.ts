/**
 * OS system-proxy detection: the proxy Clash/v2rayN set when the user toggles
 * "System Proxy" (i.e. NOT tun mode). Node's fetch never consults these
 * settings, so without this the harness connects directly and dies on
 * `UND_ERR_CONNECT_TIMEOUT` while every other app on the machine works.
 *
 * Pure parsing lives in `proxy.ts` (unit-tested); this module only shells out
 * to the platform's resolver and caches the result briefly. Reads are sync
 * (`getProxyDispatcher` is sync) but bounded: one short-lived query per
 * platform every TTL window, never throwing.
 */
import { execFileSync } from 'child_process';
import { parseWindowsProxyServer, parseScutilProxy, parseGsettingsProxy } from './proxy';

/** How long a resolved system proxy stays valid. Short enough that toggling
 *  Clash on mid-session is picked up without reloading the window, long
 *  enough that no caller ever polls the OS. */
const TTL_MS = 30_000;

let cachedUrl: string | null = null;
let cachedAt = 0;

/** Current OS system proxy URL, or null. Cached for TTL_MS. */
export function getSystemProxyUrl(): string | null {
    const now = Date.now();
    if (now - cachedAt < TTL_MS) return cachedUrl;
    cachedAt = now;
    cachedUrl = readSystemProxyUrl();
    return cachedUrl;
}

function run(command: string, args: string[]): string | null {
    try {
        return execFileSync(command, args, {
            timeout: 800,
            windowsHide: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        return null;
    }
}

function readSystemProxyUrl(): string | null {
    try {
        if (process.platform === 'win32') {
            // WinINET per-user settings - where Clash's "System Proxy" and
            // every Windows proxy toggle write. ProxyEnable must be 1.
            const out = run('reg', [
                'query',
                'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
            ]);
            if (!out) return null;
            const value = (name: string) => {
                const match = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, 'im').exec(out);
                return match ? match[1].trim() : null;
            };
            if ((value('ProxyEnable') ?? '').toLowerCase() !== '0x1') return null;
            const server = value('ProxyServer');
            return server ? parseWindowsProxyServer(server) : null;
        }
        if (process.platform === 'darwin') {
            const out = run('scutil', ['--proxy']);
            return out ? parseScutilProxy(out) : null;
        }
        // Linux: GNOME/KDE store the manual proxy in gsettings. Anything
        // else (env-based tools, TUN) is covered by the env vars above.
        const mode = run('gsettings', ['get', 'org.gnome.system.proxy', 'mode']);
        if (!mode) return null;
        for (const proto of ['https', 'http']) {
            const host = run('gsettings', ['get', `org.gnome.system.proxy.${proto}`, 'host']);
            const port = run('gsettings', ['get', `org.gnome.system.proxy.${proto}`, 'port']);
            const url = parseGsettingsProxy(mode, host ?? '', port ?? '');
            if (url) return url;
        }
        return null;
    } catch {
        return null;
    }
}
