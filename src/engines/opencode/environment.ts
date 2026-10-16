import type { ProxyMode } from '../../proxy';

export function openCodeEnvironment(base: NodeJS.ProcessEnv, proxy?: { mode: ProxyMode; url: string | null; noProxy: string }): NodeJS.ProcessEnv {
    const env = { ...base };
    if (proxy) {
        // Custom/off must not fall back to inherited ALL_PROXY or lowercase vars.
        for (const key of Object.keys(env)) if (['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].includes(key.toUpperCase())) delete env[key];
        if (proxy.url) env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = proxy.url;
    }
    // The CLI and the MCP bridge also communicate over loopback. Always merge
    // both spellings, including when no Xratu proxy was resolved at startup.
    const noProxy = proxy ? proxy.noProxy : [env.NO_PROXY, env.no_proxy].filter(Boolean).join(',');
    env.NO_PROXY = env.no_proxy = ['127.0.0.1', 'localhost', '::1', noProxy].filter(Boolean).join(',');
    return env;
}
