/**
 * External MCP server manager for Project Xratu.
 *
 * Users attach their own MCP servers - stdio commands, WebSocket URLs, or
 * remote streamable-HTTP/SSE endpoints (with optional auth headers) - via
 * the dedicated config files managed by McpConfigStore. Their tools are
 * aggregated into the tool set with a namespaced prefix, so the agent sees
 * and calls them like built-in tools - while still executing locally, inside
 * the user's machine, gated by the approval system (unless the user opted a
 * tool into auto-approval).
 *
 * Naming convention follows the wider MCP ecosystem:
 *   mcp__<server>__<tool>
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { killTree, snapshotTree, killPids } from './tooling/processTree';
import { mcpCleartextHeadersError } from './endpointGuard';
import { getProxyDispatcher } from './proxyDispatcher';
import { proxyFetch } from './proxyFetch';
import { normalizeProxyRoute } from './proxy';
import {
    MAX_TOOL_IMAGE_BYTES,
    base64ByteLength,
    isProviderSafeImageMime,
    type LocalToolImage,
} from './local/localAgent';
import type { ExternalServerConfig, LoadedMcpConfig, McpTransportType } from './mcpConfig';

// The MCP SDK's websocket client transport needs a WebSocket global under
// Node - polyfill it here (the only websocket user). The `ws` dependency
// stays for this.
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

/**
 * Result of one external MCP tool call.
 *
 * `images` exists because MCP servers return IMAGE content blocks and the old
 * text-only mapping dropped them: `browser_take_screenshot` on Playwright /
 * chrome-devtools MCP answers with `{type:'image', mimeType, data}`, which
 * mapped to `c.text ?? ''` → an empty string. The model was told a screenshot
 * had been taken and shown nothing.
 */
export interface ExternalToolResult {
    text: string;
    images: LocalToolImage[];
}

function textResult(text: string): ExternalToolResult {
    return { text, images: [] };
}

/** One MCP content block, as loosely as the wire allows. */
interface McpContentBlock {
    type: string;
    text?: string;
    mimeType?: string;
    data?: string;
    resource?: { mimeType?: string; blob?: string; uri?: string };
}

/**
 * Map an MCP `CallToolResult.content` array onto `{text, images}`.
 *
 * Three block shapes carry a picture:
 *   - `{type:'image', mimeType, data}` - the standard image block;
 *   - `{type:'resource', resource:{mimeType, blob}}` - an embedded binary
 *     resource (some servers use this for screenshots instead);
 *   - `{type:'text'}` with a bare data URL - tolerated, since a server that
 *     mislabels the block type should still show the user its picture.
 *
 * Refusals are explicit and per-block: an oversize image and an unsupported
 * media type both become a TEXT note naming the tool, so the model is never
 * left believing it saw something it did not. Dropping a truncated image
 * instead would be worse than admitting it is gone.
 */
export function mapMcpToolContent(
    content: unknown,
    toolName = 'tool',
): ExternalToolResult {
    if (!Array.isArray(content)) return { text: '', images: [] };
    const images: LocalToolImage[] = [];
    const texts: string[] = [];
    for (const raw of content) {
        const block = (raw ?? {}) as McpContentBlock;
        const note = (text: string) => texts.push(`[${toolName}: ${text}]`);
        if (block.type === 'image' || (block.type === 'text' && looksLikeDataUrl(block.text))) {
            // Type-check before use: these fields come off the wire from a
            // third-party server, and a non-string here would throw inside tool
            // dispatch (losing the whole call) instead of degrading one image.
            const mimeType = typeof block.mimeType === 'string' && block.mimeType
                ? block.mimeType
                : dataUrlMime(block.text);
            const data = typeof block.data === 'string' && block.data
                ? block.data
                : dataUrlPayload(block.text);
            if (!data) {
                note('image block carried no data and was skipped');
                continue;
            }
            if (!isProviderSafeImageMime(mimeType)) {
                note(`image of unsupported type ${mimeType || 'unknown'} was not forwarded`);
                continue;
            }
            const bytes = base64ByteLength(data);
            if (bytes > MAX_TOOL_IMAGE_BYTES) {
                note(`image of ${(bytes / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_TOOL_IMAGE_BYTES / 1024 / 1024} MB limit and was omitted`);
                continue;
            }
            images.push({ mimeType, dataBase64: data });
            continue;
        }
        if (block.type === 'resource' && typeof block.resource?.blob === 'string' && block.resource.blob) {
            const mimeType = typeof block.resource.mimeType === 'string' ? block.resource.mimeType : '';
            if (!isProviderSafeImageMime(mimeType)) {
                note(`embedded resource of unsupported type ${mimeType || 'unknown'} was not forwarded`);
                continue;
            }
            const bytes = base64ByteLength(block.resource.blob);
            if (bytes > MAX_TOOL_IMAGE_BYTES) {
                note(`embedded resource of ${(bytes / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_TOOL_IMAGE_BYTES / 1024 / 1024} MB limit and was omitted`);
                continue;
            }
            images.push({ mimeType, dataBase64: block.resource.blob });
            continue;
        }
        if (typeof block.text === 'string' && block.text) texts.push(block.text);
    }
    return { text: texts.join('\n'), images };
}

function looksLikeDataUrl(text: string | undefined): text is string {
    return typeof text === 'string' && /^data:image\//i.test(text.trim());
}

function dataUrlMime(text: string | undefined): string {
    const m = /^data:([^;,]+)[;,]/i.exec((text ?? '').trim());
    return m ? m[1].toLowerCase() : '';
}

function dataUrlPayload(text: string | undefined): string {
    const t = (text ?? '').trim();
    const comma = t.indexOf(',');
    if (comma < 0) return '';
    return /;base64/i.test(t.slice(0, comma)) ? t.slice(comma + 1).trim() : '';
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

/** Close one external server's stdio process tree and client (a no-op for
 *  already-exited processes and for remote transports without a pid).
 *
 *  The real server is a GRANDCHILD when the command is `npx`/`uvx` (a
 *  cmd.exe shim on Windows, a launcher elsewhere), and the SDK's close()
 *  signals only the DIRECT child. The two failure modes must both be avoided:
 *  orphaned servers (they keep running and holding ports/files) and killing a
 *  well-behaved server before it can shut down gracefully (stdin EOF is the
 *  MCP spec's shutdown signal).
 *
 *  - POSIX: snapshot the descendant tree, run the graceful close (stdin EOF,
 *    then SIGTERM/SIGKILL escalation), then reap anything that outlived it.
 *  - Windows: `taskkill /T` can only find the grandchild while the shim is
 *    alive, and close() force-kills the shim, so the tree must be killed
 *    BEFORE close. Windows offers no cheap pre-close snapshot and taskkill
 *    cannot gracefully stop a console app, so a hard kill is the only
 *    reliable orphan-free option here. */
async function closeState(state: ServerState | null | undefined): Promise<void> {
    if (!state) return;
    if (!state.pid) {
        try { await state.client.close(); } catch { /* already dead */ }
        return;
    }
    const tree = snapshotTree(state.pid);
    if (process.platform === 'win32') {
        await killTree(state.pid);
    }
    try {
        await state.client.close();
    } catch { /* already dead */ }
    killPids(tree);
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
            // Every outbound request rides the configured proxy (env, VS Code
            // http.proxy, or the OS system proxy) - the SDK's default fetch
            // would bypass it and time out behind a filtering network.
            // Credential-bearing requests must never follow redirects: the
            // SDK's fetch forwards configured headers to redirect targets,
            // so a 3xx could leak Authorization-style headers cross-origin.
            // Redirects stay allowed for header-less servers (compat).
            const routingFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
                // Per-server routing policy (mcp.json `proxy`): 'direct'
                // bypasses the proxy, 'proxy' forces it even past no_proxy.
                const dispatcher = getProxyDispatcher(url.toString(), normalizeProxyRoute(cfg.proxy));
                const next: RequestInit & { dispatcher?: unknown } = { ...(init ?? {}) };
                if (headerCount) next.redirect = 'error';
                if (dispatcher) next.dispatcher = dispatcher;
                return proxyFetch(input, next as RequestInit & { dispatcher?: unknown });
            };
            if (type === 'streamableHttp') {
                return {
                    transport: new StreamableHTTPClientTransport(url, {
                        requestInit: { headers },
                        fetch: routingFetch,
                    }),
                    type,
                };
            }
            // SSE: requestInit covers the POST channel; the GET event stream
            // needs the headers smuggled through a custom fetch.
            return {
                transport: new SSEClientTransport(url, {
                    requestInit: { headers },
                    fetch: routingFetch,
                    eventSourceInit: {
                        fetch: (input: unknown, init?: Record<string, unknown>) => {
                            // The SDK passes a Web Headers object (already
                            // holding Accept: text/event-stream) - object
                            // spread would DROP it, so merge via Headers.
                            const mergedHeaders = new Headers(init?.headers as HeadersInit);
                            for (const [key, value] of Object.entries(headers)) {
                                mergedHeaders.set(key, value);
                            }
                            return routingFetch(input as Parameters<typeof fetch>[0], {
                                ...(init as RequestInit),
                                headers: mergedHeaders,
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
    async callTool(namespaced: string, args: Record<string, unknown>): Promise<ExternalToolResult> {
        const rest = namespaced.startsWith(EXTERNAL_PREFIX)
            ? namespaced.slice(EXTERNAL_PREFIX.length)
            : namespaced;
        const sep = rest.indexOf('__');
        if (sep < 0) {
            return textResult(`Error: malformed external tool name '${namespaced}'`);
        }
        const serverName = rest.slice(0, sep);
        const toolName = rest.slice(sep + 2);

        const config = await this.loadConfig();
        const cfg = config.servers[serverName];
        if (!cfg) {
            return textResult(`Error: no MCP server configured under name '${serverName}'`);
        }
        if (cfg.disabled) {
            return textResult(`Error: MCP server '${serverName}' is disabled`);
        }
        const source = config.sources[serverName] ?? 'global';
        const timeoutMs = cfg.timeoutMs === 0 ? 0 : (cfg.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);

        for (let attempt = 0; attempt < 2; attempt++) {
            const state = await this.getState(serverName, cfg, source);
            if (!state) {
                return textResult(`Error: MCP server '${serverName}' is not reachable`);
            }
            try {
                const res = await state.client.callTool(
                    { name: toolName, arguments: args ?? {} },
                    undefined,
                    timeoutMs > 0 ? { timeout: timeoutMs } : undefined,
                );
                if (res.isError) {
                    const errText = (res.content as Array<{ type: string; text?: string }> | undefined)
                        ?.map((c) => c.text ?? '').join('\n') || 'Unknown tool error';
                    return textResult(`Error from MCP server '${serverName}': ${errText}`);
                }
                return mapMcpToolContent(res.content, toolName);
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
                return textResult(`MCP Call Error (${serverName}/${toolName}): ${msg}`);
            }
        }
        return textResult(`Error: MCP server '${serverName}' unreachable`);
    }
}
