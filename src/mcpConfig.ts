/**
 * MCP server configuration store for Project Xratu.
 *
 * Server config lives in dedicated JSON files (Cline-compatible
 * { "mcpServers": {...} } shape), NOT in VS Code settings:
 *   - global:  <globalStorage>/mcp.json   (every workspace)
 *   - workspace: <workspaceRoot>/.xratu/mcp.json (overrides global per key)
 *
 * The legacy `xratu.mcpServers` setting is read as a fallback ONLY when both
 * files are absent/empty - no write-back, no migration prompt.
 *
 * SECURITY: workspace files can carry auth headers; they may contain secrets
 * and must never be committed (`.xratu/` belongs in .gitignore). Header
 * values are never logged.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { MCP_REGISTRY } from './mcpRegistry';

export type McpTransportType = 'stdio' | 'websocket' | 'streamableHttp' | 'sse';

export interface ExternalServerConfig {
    /** Command to spawn (stdio transport). */
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    /** Remote server URL (websocket / streamableHttp / sse transports). */
    url?: string;
    /** Transport selection. Default: url → streamableHttp, command → stdio. */
    type?: McpTransportType;
    /** Extra HTTP headers for streamableHttp / sse (auth tokens live here). */
    headers?: Record<string, string>;
    /** Disabled servers are shown in the UI but never connected. */
    disabled?: boolean;
    /** Per-server proxy routing: 'auto' (default, follow the global chain),
     *  'proxy' (force through the proxy even past no_proxy), 'direct'
     *  (bypass the proxy entirely). Remote transports only. */
    proxy?: import('./proxy').ProxyRouteMode;
    /** Tool names the user trusts enough to skip the approval gate. */
    autoApprove?: string[];
    /** Per-call timeout in ms (default 30000; 0 disables the timeout). */
    timeoutMs?: number;
    /** Startup/handshake budget, capped at 120000 ms. */
    connectTimeoutMs?: number;
}

export type McpConfigSource = 'global' | 'workspace' | 'legacy';

export interface LoadedMcpConfig {
    /** Merged server map (workspace wins per key over global). */
    servers: Record<string, ExternalServerConfig>;
    /** Where each server entry came from. */
    sources: Record<string, McpConfigSource>;
    globalPath: string;
    workspacePath: string | null;
    /** True when any legacy `xratu.mcpServers` entries are in effect. */
    legacyInUse: boolean;
    /** Global-file entries INVISIBLE to the UI: a global entry whose name is
     *  overridden by a same-name workspace entry wins no row of its own.
     *  Page saves rebuild the global file from the UI's rows alone, so
     *  callers must re-attach these or a save silently deletes them. */
    shadowedGlobalEntries: Record<string, ExternalServerConfig>;
}

export type McpSaveTarget = 'global' | 'workspace';

function readServerFile(filePath: string): Record<string, ExternalServerConfig> | null {
    if (!fs.existsSync(filePath)) return null;
    try {
        // Windows editors (Notepad) often write a UTF-8 BOM - strip it or
        // JSON.parse throws and the whole config silently degrades.
        const text = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
        const raw = JSON.parse(text);
        const servers = raw && typeof raw === 'object'
            ? (raw.mcpServers && typeof raw.mcpServers === 'object' ? raw.mcpServers : raw)
            : null;
        return servers && typeof servers === 'object' ? servers : {};
    } catch (e) {
        console.error(`xratu: failed to parse MCP config ${filePath}:`, e);
        return {};
    }
}

export class McpConfigStore {
    private seedPending: Promise<void> | null = null;
    constructor(private readonly context: vscode.ExtensionContext) {}

    get globalPath(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'mcp.json');
    }

    get workspacePath(): string | null {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return root ? path.join(root, '.xratu', 'mcp.json') : null;
    }

    async load(): Promise<LoadedMcpConfig> {
        await this.seedPending;
        const servers: Record<string, ExternalServerConfig> = {};
        const sources: Record<string, McpConfigSource> = {};
        const wsPath = this.workspacePath;
        // SECURITY: a workspace's .xratu/mcp.json can spawn arbitrary stdio
        // commands and attach auth headers. Only honor it in TRUSTED
        // workspaces (VS Code restricted mode keeps it out of the merged
        // config - global servers still load).
        const workspaceTrusted = vscode.workspace.isTrusted !== false;
        const globalEntries = readServerFile(this.globalPath) ?? {};
        const workspaceEntries = wsPath && workspaceTrusted ? readServerFile(wsPath) ?? {} : {};
        for (const [name, cfg] of Object.entries(globalEntries)) {
            if (cfg && typeof cfg === 'object') {
                servers[name] = cfg;
                sources[name] = 'global';
            }
        }
        for (const [name, cfg] of Object.entries(workspaceEntries)) {
            if (cfg && typeof cfg === 'object') {
                servers[name] = cfg;
                sources[name] = 'workspace';
            }
        }
        // A global entry overridden by a same-name workspace entry loses its
        // row entirely (the map is keyed by name) - track it so file saves
        // can re-attach it instead of silently deleting it.
        const shadowedGlobalEntries: Record<string, ExternalServerConfig> = {};
        for (const [name, cfg] of Object.entries(globalEntries)) {
            if (cfg && typeof cfg === 'object' && workspaceEntries[name] && typeof workspaceEntries[name] === 'object') {
                shadowedGlobalEntries[name] = cfg;
            }
        }

        let legacyInUse = false;
        if (Object.keys(servers).length === 0 && vscode.workspace.isTrusted !== false) {
            // Back-compat fallback: both files empty/absent → the legacy
            // setting still works (read-only). As soon as either file has
            // content, the setting is ignored. Skipped in untrusted
            // workspaces (the setting is declared restricted in the
            // manifest; this read-side gate mirrors the file gate above).
            const raw = vscode.workspace.getConfiguration('xratu').get<Record<string, ExternalServerConfig>>('mcpServers');
            if (raw && typeof raw === 'object') {
                for (const [name, cfg] of Object.entries(raw)) {
                    if (cfg && typeof cfg === 'object') {
                        servers[name] = cfg;
                        sources[name] = 'legacy';
                        legacyInUse = true;
                    }
                }
            }
        }

        return {
            servers,
            sources,
            globalPath: this.globalPath,
            workspacePath: wsPath,
            legacyInUse,
            shadowedGlobalEntries,
        };
    }

    /** First-run default: ship with the default-enabled curated servers
     *  active out of the box (no API keys, read-only tools). Seeds the global
     *  config file
     *  only when it does not exist yet - exclusive create, never clobbers an
     *  existing or concurrently created file. An emptied-but-present file is
     *  a user decision and is respected. Upgrades whose servers still live
     *  in the legacy `xratu.mcpServers` setting are skipped too: a seeded
     *  file would make load() ignore that fallback and silently drop the
     *  user's existing servers. */
    seedDefaults(): Promise<void> {
        if (this.seedPending) return this.seedPending;
        const pending = this.seedDefaultsNow().finally(() => { if (this.seedPending === pending) this.seedPending = null; });
        this.seedPending = pending;
        return pending;
    }

    private async seedDefaultsNow(): Promise<void> {
        if (fs.existsSync(this.globalPath)) return;
        if (vscode.workspace.isTrusted === false) return;
        const legacy = vscode.workspace.getConfiguration('xratu').get<Record<string, ExternalServerConfig>>('mcpServers');
        if (legacy && typeof legacy === 'object' && Object.keys(legacy).length > 0) return;
        const servers: Record<string, ExternalServerConfig> = {};
        for (const entry of MCP_REGISTRY) {
            if (!entry.defaultEnabled) continue;
            const { name, ...config } = entry.server;
            servers[name] = config;
        }
        await fs.promises.mkdir(path.dirname(this.globalPath), { recursive: true });
        const temporary = path.join(path.dirname(this.globalPath), `mcp-${randomUUID()}.tmp`);
        try {
            await fs.promises.writeFile(temporary, JSON.stringify({ mcpServers: servers }, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
            // A same-directory hard link publishes complete bytes atomically,
            // and refuses an existing config on Windows and POSIX alike.
            await fs.promises.link(temporary, this.globalPath);
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
        } finally {
            await fs.promises.rm(temporary, { force: true });
        }
    }

    /** Write one target file. The other file is left untouched - a save to
     *  global never clobbers workspace overrides. */
    async save(target: McpSaveTarget, servers: Record<string, ExternalServerConfig>): Promise<void> {
        await this.seedPending;
        const filePath = target === 'global' ? this.globalPath : this.workspacePath;
        if (!filePath) throw new Error('No workspace folder open - cannot save the workspace MCP config.');
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, JSON.stringify({ mcpServers: servers }, null, 2) + '\n', 'utf-8');
    }
}
