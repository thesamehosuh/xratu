import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const require = createRequire(import.meta.url);
const load = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
    return load.call(this, request, parent, isMain);
};
const { getLocalToolDefinitions, createLocalToolExecutor } = require('../out/mcp.js');
const { OpenCodeMcpBridge } = require('../out/engines/opencode/mcpBridge.js');
const { PULL_REQUEST_TOOLS, PULL_REQUEST_MUTATIONS, PULL_REQUEST_AGENT_INSTRUCTIONS } = require('../out/pullRequests/tools.js');
const { buildLocalSystemPrompt, buildSubagentSystemPrompt } = require('../out/systemPrompt.js');
const { filterToolsForSubagent } = require('../out/subagents.js');
const { setOfflineMode } = require('../out/networkPolicy.js');
Module._load = load;

const names = options => new Set(getLocalToolDefinitions(options).map(tool => tool.name));
const prompt = planMode => buildLocalSystemPrompt({ rulesContext: '', sessionSummary: null, planMode, evictedUserTurns: 0, replyLanguage: 'en' });
assert.ok(prompt(false).includes(PULL_REQUEST_AGENT_INSTRUCTIONS));
assert.ok(!prompt(true).includes(PULL_REQUEST_AGENT_INSTRUCTIONS));
assert.ok(!buildSubagentSystemPrompt({ agentPrompt: 'Review', rulesContext: '', planMode: false }).includes(PULL_REQUEST_AGENT_INSTRUCTIONS));
const watchTool = PULL_REQUEST_TOOLS.find(tool => tool.name === 'watch_pull_request');
assert.ok(PULL_REQUEST_AGENT_INSTRUCTIONS.includes('unwatch_pull_request only when the PR task is finished or the user asks you to stop'));
assert.ok(!PULL_REQUEST_AGENT_INSTRUCTIONS.includes('Before handing the work back, call unwatch_pull_request.'));
assert.ok(!watchTool.description.includes('Stop watching before handing work back.'));
for (const tool of PULL_REQUEST_TOOLS) assert.ok(names({}).has(tool.name));
for (const name of PULL_REQUEST_MUTATIONS) {
    assert.equal(names({ plan: true }).has(name), false);
    assert.equal(filterToolsForSubagent([{ name }], { tools: [name] }).length, 0);
}
assert.ok(names({ plan: true }).has('list_thread_pull_requests'));
assert.ok(names({ plan: true }).has('get_pull_request'));
try {
    setOfflineMode(true);
    assert.equal(names({}).has('watch_pull_request'), false);
    assert.equal(names({}).has('get_pull_request'), false);
    assert.ok(names({}).has('list_thread_pull_requests'));
} finally { setOfflineMode(false); }
let calls = 0;
const execute = async () => { calls++; return { output: 'PR metadata' }; };
for (const guard of [{ nested: true }, { plan: true }]) {
    const executor = createLocalToolExecutor('', async () => {}, undefined, undefined, undefined, undefined, { ...guard, pullRequests: execute });
    for (const name of PULL_REQUEST_MUTATIONS) {
        const result = await executor.execute({ name, id: name, arguments: {}, argumentsJson: '{}' });
        assert.equal(result.isError, true);
    }
    assert.equal(calls, 0);
}
const executor = createLocalToolExecutor('', async () => {}, undefined, undefined, undefined, undefined, { nested: true, pullRequests: execute });
assert.equal((await executor.execute({ name: 'list_thread_pull_requests', id: 'read', arguments: {}, argumentsJson: '{}' })).output, 'PR metadata');
assert.equal(calls, 1);
console.log('ok built-in tools, plan/offline filtering, and structural child restrictions');

const aggregated = PULL_REQUEST_TOOLS.map(tool => ({ ...tool, originalName: tool.name, serverName: 'xratu', autoApprove: true }));
const nativeCalls = [];
const bridge = new OpenCodeMcpBridge({ listTools: async () => aggregated, callTool: async (name, args) => { nativeCalls.push({ name, args }); return { text: 'Session PR state', images: [] }; } });
bridge.setTools(aggregated);
const controller = new AbortController();
bridge.activate('native-a', false, controller.signal);
const client = new Client({ name: 'pr-tools-test', version: '1.0.0' });
try {
    const connection = await bridge.connect();
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }));
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), PULL_REQUEST_TOOLS.map(tool => tool.name));
    const input = { name: 'watch_pull_request', arguments: { url: 'https://github.com/example/repo/pull/42' }, _meta: { 'ai.opencode/sessionID': 'native-a' } };
    const result = await client.callTool(input);
    assert.notEqual(result.isError, true);
    assert.equal(nativeCalls.length, 1);
    assert.deepEqual(nativeCalls[0], { name: 'watch_pull_request', args: input.arguments });
    assert.equal((await client.callTool({ ...input, _meta: { 'ai.opencode/sessionID': 'wrong-session' } })).isError, true);
    bridge.activate('native-a', true, controller.signal);
    assert.equal((await client.callTool(input)).isError, true);
    bridge.activate('native-a', false, controller.signal);
    controller.abort();
    assert.equal((await client.callTool(input)).isError, true);
    assert.equal(nativeCalls.length, 1);
    console.log('ok OpenCode reaches the same PR tools through a real authenticated MCP connection; wrong, plan, and aborted sessions cannot execute');
} finally { await client.close(); await bridge.dispose(); }
