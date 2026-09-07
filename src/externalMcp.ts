/**
 * External MCP server manager for Project Xratu.
 *
 * Users attach their own MCP servers - stdio commands, WebSocket URLs, or
 * remote streamable-HTTP/SSE endpoints (with optional auth headers) - via
 * the dedicated config files managed by McpConfigStore. Their tools are
 * aggregated into the outbound bridge with a namespaced prefix, so the
 * backend agent sees and calls them like built-in tools - while still
 * executing locally, inside the user's machine, gated by the backend's
 * approval system (unless the user opted a tool into auto-approval).
 *
 * Naming convention follows the wider MCP ecosystem:
 *   mcp__<server>__<tool>
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { killTree } from './xratu_mcp_tools';
import { mcpCleartextHeadersError } from './endpointGuard';
import type { ExternalServerConfig, LoadedMcpConfig, McpTransportType } from './mcpConfig';

// The MCP SDK's websocket client transport needs a WebSocket global under
// Node - polyfill it here (the only websocket user since the backend tool
// relay was removed). The `ws` dependency stays for this.
if (typeof global.WebSocket === 'undefined') {
    (global as any).WebSocket = require('ws');
}

export const EXTERNAL_PREFIX = 'mcp__';

/** Default per-call timeout when the server config sets none. */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** Default connection timeout - a dead external server must never wedge the bridge. */
const CONNECT_TIMEOUT_MS = 15_000;

export type ExternalServerState = 'disabled' | 'connected' | 'error' | 'unconfigured';

export interface ExternalServerStatus {
    name: string;
    transport: 'stdio' | 'websocket' | 'streamableHttp' | 'sse' | 'unknown';
    state: ExternalServerState;
    toolCount: number | null;
    lastError: string | null;
    source: 'global' | 'workspace' | 'legacy';
}

export interface AggregatedTool {
    name: string;           // namespaced: mcp__<server>__<tool>
    originalName: string;
    serverName: string;
    description: string;
    inputSchema: Record<string, unknown>;
    /** User trusts this tool - the approval gate is skipped for it. */
    autoApprove: boolean;
}

function resolveTransport(cfg: ExternalServerConfig): McpTransportType | null {
    if (cfg.type) return cfg.type;
    if (cfg.url) return 'streamableHttp';
    if (cfg.command) return 'stdio';
    return null;
}

interface ServerState {
    name: string;
    client: Client;
    /** stdio child pid - lets close paths kill the WHOLE process tree
     *  (on Windows, npx/uvx run through a cmd.exe shim: killing the direct
     *  child orphans the actual node grandchild without taskkill /T). */
    pid?: number;
}

/** Close one external server's client, then make sure its stdio process
 *  tree is gone (a no-op for already-exited processes and for remote
 *  transports without a pid). */
async function closeState(state: ServerState | null | undefined): Promise<void> {
    if (!state) return;
    try {
        await state.client.close();
    } catch { /* already dead */ }
    if (state.pid) killTree(state.pid);
}

export class ExternalMcpManager {
    private _states = new Map<string, Promise<ServerState | null>>();
    private _statuses = new Map<string, ExternalServerStatus>();
    private _stopped = false;

    constructor(private readonly loadConfig: () => Promise<LoadedMcpConfig>) {}

    async stopAll(): Promise<void> {
        this._stopped = true;
        for (const pending of this._states.values()) {
            try {
                const state = await pending;
                await closeState(state);
            } catch { /* already dead */ }
        }
        this._states.clear();
    }

    /** Drop cached clients + status memory so the next call reconnects from
     *  fresh config (used after the MCP page saves and for manual restarts). */
    async reload(): Promise<void> {
        for (const [name, pending] of [...this._states.entries()]) {
            this._states.delete(name);
            try {
                const state = await pending;
                await closeState(state);
            } catch { /* already dead */ }
        }
        this._statuses.clear();
    }

    /** Restart one server: drop its cached client and reconnect eagerly so
     *  the MCP page's status reflects the retry immediately. */
    async restart(name: string): Promise<void> {
        const pending = this._states.get(name);
        this._states.delete(name);
        try {
            const state = await pending;
            await closeState(state);
        } catch { /* already dead */ }
        this._statuses.delete(name);
        const config = await this.loadConfig();
        const cfg = config.servers[name];
        if (cfg && !cfg.disabled) {
            await this.getState(name, cfg, config.sources[name] ?? 'global');
        }
    }

    /** Last-known status per configured server (including disabled ones). */
    async getServerStatuses(): Promise<ExternalServerStatus[]> {
        const config = await this.loadConfig();
        const out: ExternalServerStatus[] = [];
        for (const [name, cfg] of Object.entries(config.servers)) {
            const transport = resolveTransport(cfg) ?? 'unknown';
            const base = this._statuses.get(name);
            const state: ExternalServerState = cfg.disabled
                ? 'disabled'
                : (base?.state === 'connected' ? 'connected' : (base?.state === 'error' ? 'error' : 'unconfigured'));
            out.push({
                name,
                transport,
                state,
                toolCount: state === 'connected' ? base?.toolCount ?? null : null,
                lastError: state === 'error' ? base?.lastError ?? null : null,
                source: config.sources[name] ?? 'global',
            });
        }
        return out;
    }

    private _markStatus(name: string, patch: Partial<ExternalServerStatus>, source: 'global' | 'workspace' | 'legacy'): void {
        const prev = this._statuses.get(name);
        this._statuses.set(name, {
            name,
            transport: patch.transport ?? prev?.transport ?? 'unknown',
            state: patch.state ?? prev?.state ?? 'unconfigured',
            toolCount: patch.toolCount ?? prev?.toolCount ?? null,
            lastError: patch.lastError ?? null,
            source,
        });
    }

    private buildTransport(name: string, cfg: ExternalServerConfig): { transport: unknown; type: McpTransportType } | null {
        const type = resolveTransport(cfg);
        if (!type) {
            console.error(`xratu mcpServers[${name}]: needs either "url" or "command"`);
            return null;
        }
        if (type === 'streamableHttp' || type === 'sse') {
            const url = new URL(cfg.url!);
            const headers = cfg.headers ?? {};
            // Server-side cleartext policy (the UI check is advisory only -
            // mcp.json is hand-editable): remote http: endpoints must not
            // carry credential headers. Local/LAN endpoints keep working.
            const headerCount = Object.keys(headers).length;
            const cleartextError = mcpCleartextHeadersError(cfg.url!, headerCount);
            if (cleartextError) {
                // Throw (not return null) so connect()'s catch records the
                // policy rejection as the server's visible lastError.
                throw new Error(cleartextError);
            }
            // Credential-bearing requests must never follow redirects: the
            // SDK's fetch forwards configured headers to redirect targets,
            // so a 3xx could leak Authorization-style headers cross-origin.
            // Redirects stay allowed for header-less servers (compat).
            const guardedFetch: typeof fetch | undefined = headerCount
                ? ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
                    fetch(input, { ...init, redirect: 'error' }))
                : undefined;
            if (type === 'streamableHttp') {
                return {
                    transport: new StreamableHTTPClientTransport(url, {
                        requestInit: { headers },
                        ...(guardedFetch ? { fetch: guardedFetch } : {}),
                    }),
                    type,
                };
            }
            // SSE: requestInit covers the POST channel; the GET event stream
            // needs the headers smuggled through a custom fetch.
            return {
                transport: new SSEClientTransport(url, {
                    requestInit: { headers },
                    ...(guardedFetch ? { fetch: guardedFetch } : {}),
                    eventSourceInit: {
                        fetch: (input: unknown, init?: Record<string, unknown>) => {
                            // The SDK passes a Web Headers object (already
                            // holding Accept: text/event-stream) - object
                            // spread would DROP it, so merge via Headers.
                            const mergedHeaders = new Headers(init?.headers as HeadersInit);
                            for (const [key, value] of Object.entries(headers)) {
                                mergedHeaders.set(key, value);
                            }
                            return fetch(input as Parameters<typeof fetch>[0], {
                                ...(init as RequestInit),
                                headers: mergedHeaders,
                                ...(guardedFetch ? { redirect: 'error' as const } : {}),
                            });
                        },
                    } as never,
                }),
                type,
            };
        }
        if (type === 'websocket') {
            return { transport: new WebSocketClientTransport(new URL(cfg.url!)), type };
        }
        return {
            transport: new StdioClientTransport({
                command: cfg.command!,
                args: cfg.args ?? [],
                env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
                cwd: cfg.cwd,
            }),
            type,
        };
    }

    private connect(name: string, cfg: ExternalServerConfig, source: 'global' | 'workspace' | 'legacy'): Promise<ServerState | null> {
        const start = (async (): Promise<ServerState | null> => {
            let built: { transport: unknown; type: McpTransportType } | null = null;
            try {
                built = this.buildTransport(name, cfg);
                if (!built) {
                    this._markStatus(name, { state: 'error', transport: 'unknown', lastError: 'missing url/command' }, source);
                    return null;
                }
                const client = new Client({ name: 'xratu-external-bridge', version: '1.0.0' });
                client.onerror = (e) => console.error(`xratu mcpServers[${name}] error:`, e);
                await client.connect(built.transport as never, { timeout: CONNECT_TIMEOUT_MS });
                console.log(`xratu: connected to external MCP server '${name}' (${built.type})`);
                this._markStatus(name, { state: 'connected', transport: built.type }, source);
                return { name, client, pid: (built.transport as { pid?: number | null }).pid ?? undefined };
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error(`xratu: failed to connect external MCP server '${name}':`, e);
                // A failed SSE connect leaves the SDK's internal EventSource
                // scheduling reconnects every few seconds - close the
                // transport so the rejected server goes quiet.
                try { await (built?.transport as { close?: () => Promise<void> } | undefined)?.close?.(); } catch { /* best effort */ }
                this._markStatus(name, { state: 'error', lastError: msg }, source);
                return null;
            }
        })();
        this._states.set(name, start);
        return start;
    }

    private async getState(name: string, cfg: ExternalServerConfig, source: 'global' | 'workspace' | 'legacy'): Promise<ServerState | null> {
        if (this._stopped || cfg.disabled) return null;
        let pending = this._states.get(name);
        if (!pending) {
            pending = this.connect(name, cfg, source);
        }
        const state = await pending;
        if (!state) {
            // Forget the failure so the next call retries (config may be fixed).
            this._states.delete(name);
        }
        return state;
    }

    /** Aggregate tool listings from every enabled server. Failures degrade quietly. */
    async listTools(): Promise<AggregatedTool[]> {
        const config = await this.loadConfig();
        const out: AggregatedTool[] = [];
        for (const [name, cfg] of Object.entries(config.servers)) {
            if (cfg.disabled) continue;
            const source = config.sources[name] ?? 'global';
            const auto = new Set(cfg.autoApprove ?? []);
            try {
                const state = await this.getState(name, cfg, source);
                if (!state) continue;
                const res = await state.client.listTools();
                const tools = res.tools ?? [];
                this._markStatus(name, { state: 'connected', toolCount: tools.length }, source);
                for (const t of tools) {
                    out.push({
                        name: `${EXTERNAL_PREFIX}${name}__${t.name}`,
                        originalName: t.name,
                        serverName: name,
                        description: `[mcp:${name}] ${t.description ?? ''}`.trim(),
                        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
                        autoApprove: auto.has(t.name),
                    });
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error(`xratu: listTools failed for '${name}':`, e);
                this._markStatus(name, { state: 'error', lastError: msg }, source);
            }
        }
        return out;
    }

    /** Route a namespaced call. One transparent reconnect retry on stale clients. */
    async callTool(namespaced: string, args: Record<string, unknown>): Promise<string> {
        const rest = namespaced.startsWith(EXTERNAL_PREFIX)
            ? namespaced.slice(EXTERNAL_PREFIX.length)
            : namespaced;
        const sep = rest.indexOf('__');
        if (sep < 0) {
            return `Error: malformed external tool name '${namespaced}'`;
        }
        const serverName = rest.slice(0, sep);
        const toolName = rest.slice(sep + 2);

        const config = await this.loadConfig();
        const cfg = config.servers[serverName];
        if (!cfg) {
            return `Error: no MCP server configured under name '${serverName}'`;
        }
        if (cfg.disabled) {
            return `Error: MCP server '${serverName}' is disabled`;
        }
        const source = config.sources[serverName] ?? 'global';
        const timeoutMs = cfg.timeoutMs === 0 ? 0 : (cfg.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);

        for (let attempt = 0; attempt < 2; attempt++) {
            const state = await this.getState(serverName, cfg, source);
            if (!state) {
                return `Error: MCP server '${serverName}' is not reachable`;
            }
            try {
                const res = await state.client.callTool(
                    { name: toolName, arguments: args ?? {} },
                    undefined,
                    timeoutMs > 0 ? { timeout: timeoutMs } : undefined,
                );
                const content = res.content as Array<{ type: string; text?: string }> | undefined;
                if (res.isError) {
                    const errText = content?.map((c) => c.text ?? '').join('\n') || 'Unknown tool error';
                    return `Error from MCP server '${serverName}': ${errText}`;
                }
                if (!content || content.length === 0) {
                    return '';
                }
                return content.map((c) => c.text ?? '').join('\n');
            } catch (e) {
                if (attempt === 0) {
                    // Stale connection - drop it so getState reconnects.
                    const pending = this._states.get(serverName);
                    this._states.delete(serverName);
                    try {
                        const s = await pending;
                        await closeState(s);
                    } catch { /* ignore */ }
                    continue;
                }
                const msg = e instanceof Error ? e.message : String(e);
                console.error(`xratu: callTool ${namespaced} failed:`, e);
                this._markStatus(serverName, { state: 'error', lastError: msg }, source);
                return `MCP Call Error (${serverName}/${toolName}): ${msg}`;
            }
        }
        return `Error: MCP server '${serverName}' unreachable`;
    }
}
