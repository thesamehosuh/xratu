/** Opt-in real-runtime check with a deterministic loopback model and research
 * fixture. It uses no hosted model, credentials, or provider search quota.
 * node test/live-native-research.mjs --binary /path/to/opencode */
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module, { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const binaryIndex = process.argv.indexOf('--binary');
const binary = binaryIndex >= 0 ? process.argv[binaryIndex + 1] : undefined;
if (!binary || binary.startsWith('--')) throw new Error('Pass --binary to opt into a real OpenCode runtime.');
const root = await mkdtemp(join(tmpdir(), 'xratu-native-research-'));
const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const tool = body.tools?.find(tool => tool.function?.name.endsWith('_web_search'));
    const hasResult = body.messages?.some(message => message.role === 'tool');
    const delta = tool && !hasResult ? { role: 'assistant', tool_calls: [{ index: 0, id: 'research-1', type: 'function', function: { name: tool.function.name, arguments: '{"query":"fixture documentation"}' } }] } : { role: 'assistant', content: 'Observed fixture evidence.' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    response.end(event(delta) + event({}, delta.tool_calls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const bundle = join(root, 'probe.cjs');
await build({ stdin: { contents: "export { OpenCodeEngine } from './src/engines/opencode/engine';", resolveDir: process.cwd(), loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'] });
const originalLoad = Module._load;
Module._load = function(name, ...args) { if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } }; return originalLoad.call(this, name, ...args); };
const require = createRequire(import.meta.url);
const { OpenCodeEngine } = require(bundle);
const fixture = { url: 'https://example.com/docs', id: 'fixture', title: 'Fixture', excerpts: ['Observed fixture evidence.'], retrievedAt: new Date().toISOString(), route: 'parallel' };
const research = { version: 1, provider: 'parallel', outcome: 'success', freshness: 'unknown', sources: [fixture], warnings: [] };
const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), OPENCODE_CONFIG_DIR: join(root, 'config'), OPENCODE_CONFIG_CONTENT: '{}' };
for (const name of Object.keys(env)) if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(name)) delete env[name];
await writeFile(join(root, 'opencode.json'), JSON.stringify({ providers: { fixture: { package: '@ai-sdk/openai-compatible', settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only' }, models: { fixture: { capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 32000, output: 2000 } } } } } }));
let invoked = 0;
const engine = new OpenCodeEngine(binary, env, undefined, { listTools: async () => [{ name: 'web_search', originalName: 'web_search', serverName: 'xratu', autoApprove: true, description: 'Read-only fixture research', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }], callTool: async (_name, _args, signal) => { signal.throwIfAborted(); invoked++; return { text: 'Observed fixture evidence.', images: [], research }; } }, join(root, 'attachments'));
try {
    for (const plan of [false, true]) {
        const events = [];
        for await (const event of engine.runTurn({ prompt: 'Use the web_search tool once, then finish.', model: 'fixture/fixture', workspace: root, plan, yolo: false, signal: AbortSignal.timeout(30_000) }, { approvals: { requestApproval: async () => { throw new Error('Research must remain read-only.'); } }, questions: { ask: async () => ({ kind: 'dismissed' }) } })) events.push(event);
        const result = events.find(event => event.type === 'toolResult' && event.tool === 'web_search');
        assert.equal(result?.research?.sources[0].url, fixture.url, JSON.stringify(events));
        console.log(`native research ${plan ? 'Plan' : 'Act'}: real MCP invocation and display evidence passed`);
    }
    assert.equal(invoked, 2);
} finally {
    await engine.dispose(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(root, { recursive: true, force: true }); Module._load = originalLoad;
}
