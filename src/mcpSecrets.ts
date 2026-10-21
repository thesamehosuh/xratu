import { createHash } from 'crypto';
import type * as vscode from 'vscode';
import type { ExternalServerConfig } from './mcpConfig';
let storage: vscode.SecretStorage | undefined;
export function configureMcpSecrets(secrets: vscode.SecretStorage): void { storage = secrets; }
const reference = /^\$\{secret:(xratu\.mcp\.[a-f0-9]{64})\}$/;
/** Explicit MCP saves protect header/env values while preserving existing refs. */
export async function protectMcpSecrets(scope: string, servers: Record<string, ExternalServerConfig>): Promise<Record<string, ExternalServerConfig>> {
    if (!storage) throw new Error('MCP secret storage is not configured.');
    const result: Record<string, ExternalServerConfig> = {};
    for (const [server, config] of Object.entries(servers)) {
        const next = { ...config };
        for (const field of ['headers', 'env'] as const) {
            if (!config[field]) continue;
            next[field] = {};
            for (const [name, value] of Object.entries(config[field]!)) {
                if (typeof value !== 'string') throw new Error('MCP header and env values must be strings.');
                if (!value || reference.test(value)) { next[field]![name] = value; continue; }
                const id = 'xratu.mcp.' + createHash('sha256').update(JSON.stringify([scope, server, field, name])).digest('hex');
                await storage.store(id, value);
                next[field]![name] = '${secret:' + id + '}';
            }
        }
        result[server] = next;
    }
    return result;
}
export async function resolveMcpSecrets(config: ExternalServerConfig): Promise<ExternalServerConfig> {
    const result = { ...config };
    for (const field of ['headers', 'env'] as const) {
        if (!config[field]) continue;
        result[field] = {};
        for (const [name, value] of Object.entries(config[field]!)) {
            if (typeof value !== 'string') throw new Error('MCP header and env values must be strings.');
            const match = reference.exec(value);
            if (!match && value.startsWith('${secret:')) throw new Error('Only Xratu MCP secret references are allowed.');
            const resolved = match ? await storage?.get(match[1]) : value;
            if (resolved === undefined) throw new Error('An MCP secret reference is unavailable. Re-enter its value in Servers.');
            result[field]![name] = resolved;
        }
    }
    return result;
}
