import { createHash, randomBytes } from 'crypto';
import { createServer, type Server as HttpServer } from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AggregatedTool, ExternalMcpManager } from '../../externalMcp';
import { isNativePlanTool } from './services';
import { readResearchEvidence, type ResearchEvidence } from '../../web/types';
import { abortable } from '../../oauth/refreshLock';

export interface NativeMcpContext { sessionID: string; plan: boolean; rootSessionID?: string; rootSignal?: AbortSignal }
export interface NativeMcpSource {
    listTools: ExternalMcpManager['listTools'];
    callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, context: NativeMcpContext): ReturnType<ExternalMcpManager['callTool']>;
}
const normalize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Share existing Xratu connections, including proxy routing and all transports.
 *  Only the random loopback token crosses into OpenCode; server credentials do not. */
export class OpenCodeMcpBridge {
    readonly name = `xratu_${randomBytes(8).toString('hex')}`;
    private readonly token = randomBytes(32).toString('hex');
    private server?: HttpServer;
    private connection?: Promise<{ url: string; headers: Record<string, string> }>;
    private wireTools = new Map<string, AggregatedTool>();
    private readonly sessions = new Map<string, { plan: boolean; signal: AbortSignal; rootSessionID?: string; rootSignal?: AbortSignal }>();
    private readonly researchResults: Array<{ sessionID: string; text: string; research: ResearchEvidence }> = [];
    takeResearch(sessionID: string, text: string): ResearchEvidence | undefined {
        const index = this.researchResults.findIndex(item => item.sessionID === sessionID && item.text === text);
        return index < 0 ? undefined : this.researchResults.splice(index, 1)[0].research;
    }
    hasResearch(): boolean { return [...this.wireTools.values()].some(tool => tool.serverName === 'xratu' && tool.name === 'web_search'); }
    private readonly transports = new Set<Server>();
    constructor(private readonly source: NativeMcpSource) {}

    setTools(tools: AggregatedTool[]): void {
        const wireTools = new Map<string, AggregatedTool>();
        for (const tool of tools) {
            // Keep native/provider names within 64 characters and distinct after
            // OpenCode normalization, even for punctuation in configured server names.
            const normalized = normalize(tool.name);
            const name = normalized === tool.name && tool.name.length <= 41 ? tool.name
                : `${normalized.slice(0, 24)}_${createHash('sha256').update(tool.name).digest('hex').slice(0, 16)}`;
            if (wireTools.has(name)) throw new Error('Duplicate Xratu MCP tool name');
            wireTools.set(name, tool);
        }
        this.wireTools = wireTools;
    }
    toolNames(): Map<string, string> { return new Map([...this.wireTools].map(([name, tool]) => [`${this.name}_${name}`, tool.name])); }
    trustedActions(): string[] { return [...this.wireTools].filter(([, tool]) => tool.autoApprove).map(([name]) => `${this.name}_${name}`); }
    planActions(): string[] { return [...this.wireTools].filter(([, tool]) => this.planSafe(tool)).map(([name]) => `${this.name}_${name}`); }
    private planSafe(tool: AggregatedTool): boolean {
        return tool.serverName === 'xratu' && tool.originalName === tool.name && isNativePlanTool(tool.name);
    }
    activate(sessionID: string, plan: boolean, signal: AbortSignal, rootSessionID?: string, rootSignal?: AbortSignal): void { this.sessions.set(sessionID, { plan, signal, rootSessionID, rootSignal }); }
    deactivate(sessionID: string): void { this.sessions.delete(sessionID); for (let i = this.researchResults.length - 1; i >= 0; i--) if (this.researchResults[i].sessionID === sessionID) this.researchResults.splice(i, 1); }

    connect(): Promise<{ url: string; headers: Record<string, string> }> {
        return this.connection ??= this.listen().catch((error) => { this.connection = undefined; throw error; });
    }
    private async listen() {
        const server = createServer((request, response) => {
            // Reject browser origins as well as unauthenticated local callers.
            if (request.headers.authorization !== `Bearer ${this.token}` || request.headers.origin) { response.writeHead(403).end(); return; }
            if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
            if (request.method !== 'POST') { response.writeHead(405).end(); return; }
            const mcp = new Server({ name: 'xratu', version: '1.0.0' }, { capabilities: { tools: {} } });
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
            this.transports.add(mcp);
            response.on('close', () => { this.transports.delete(mcp); void mcp.close().catch(() => undefined); });
            mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...this.wireTools].map(([name, tool]) => ({ name, description: `${tool.name}: ${tool.description}`, inputSchema: { ...tool.inputSchema, type: 'object' as const } })) }));
            mcp.setRequestHandler(CallToolRequestSchema, async (call) => {
                const sessionID = call.params._meta?.['ai.opencode/sessionID'];
                const session = typeof sessionID === 'string' ? this.sessions.get(sessionID) : undefined;
                const tool = this.wireTools.get(call.params.name);
                const parentControl = tool?.serverName === 'xratu' && ['task', 'update_task_list', 'exit_plan_mode', 'ask_user_question'].includes(tool.originalName);
                if (!session || session.signal.aborted || !tool || (session.rootSessionID && parentControl) || (session.plan && !this.planSafe(tool))) {
                    return { isError: true, content: [{ type: 'text', text: 'Xratu MCP call is not allowed in this session.' }] };
                }
                const result = await abortable(this.source.callTool(tool.name, call.params.arguments ?? {}, session.signal, { sessionID: sessionID as string, plan: session.plan, ...(session.rootSessionID ? { rootSessionID: session.rootSessionID } : {}), ...(session.rootSignal ? { rootSignal: session.rootSignal } : {}) }), session.signal);
                const research = readResearchEvidence(result.research);
                if (research) { this.researchResults.push({ sessionID: sessionID as string, text: result.text, research }); if (this.researchResults.length > 64) this.researchResults.shift(); }
                return { isError: result.isError === true, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}), content: [
                    ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
                    ...result.images.map((image) => ({ type: 'image' as const, mimeType: image.mimeType, data: image.dataBase64 })),
                ] };
            });
            void (async () => {
                const chunks: Buffer[] = [];
                let bytes = 0;
                for await (const chunk of request) {
                    bytes += chunk.length;
                    if (bytes > 4 * 1024 * 1024) { response.writeHead(413).end(); return; }
                    chunks.push(chunk);
                }
                let body: unknown;
                try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                catch { response.writeHead(400).end(); return; }
                await mcp.connect(transport);
                await transport.handleRequest(request, response, body);
            })().catch(() => {
                if (!response.headersSent) response.writeHead(500).end();
                else response.end();
            });
        });
        this.server = server;
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Xratu MCP bridge did not bind a TCP port');
        return { url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: `Bearer ${this.token}` } };
    }
    async dispose(): Promise<void> {
        this.sessions.clear();
        await Promise.allSettled([...this.transports].map((transport) => transport.close()));
        this.transports.clear();
        const server = this.server;
        this.server = undefined;
        this.connection = undefined;
        if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
}
