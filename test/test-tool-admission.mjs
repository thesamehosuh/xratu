import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runLocalAgent } = require('../out/local/localAgent.js');
const originalFetch = globalThis.fetch;
async function scenario(name, definitions, { parallel = false, allow = false } = {}) {
    const executed = [], approved = [], bodies = [], events = [];
    globalThis.fetch = async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        const delta = bodies.length === 1
            ? { tool_calls: [{ index: 0, id: 'call-1', function: { name, arguments: '{}' } }] }
            : { content: 'Done' };
        return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    for await (const event of runLocalAgent({
        baseUrl: 'http://127.0.0.1:11434/v1', apiKey: null, model: 'test',
        systemPrompt: 'test', userText: 'test', tools: definitions, maxRounds: 3,
        ...(parallel ? { parallelTools: [name] } : {}),
    }, { execute: async call => { executed.push(call.name); return { output: 'executed' }; } }, {
        requestApproval: async (_id, calls) => { approved.push(...calls.map(c => c.name)); return Object.fromEntries(calls.map(c => [c.id, allow])); },
    })) events.push(event);
    return { executed, approved, bodies, events };
}
try {
    for (const parallel of [false, true]) {
        for (const name of ['mcp__remote__mutate', 'write_file', 'task']) {
            const result = await scenario(name, [{ name: 'read_file', description: '', inputSchema: {} }], { parallel });
            assert.deepEqual(result.executed, [], `${name} absent from run tools must not execute (${parallel ? 'parallel' : 'serial'})`);
            assert.ok(result.events.some(e => e.type === 'toolResult' && e.isError));
        }
        const definitions = [{ name: 'edit_file', description: '', inputSchema: {}, requiresApproval: true }];
        const denied = await scenario('write_file', definitions, { parallel });
        assert.deepEqual(denied.approved, ['edit_file'], 'an alias must request the canonical permission');
        assert.deepEqual(denied.executed, []);
        const allowed = await scenario('write_file', definitions, { parallel, allow: true });
        assert.deepEqual(allowed.executed, ['edit_file']);
        assert.equal(allowed.bodies[1].messages.find(m => m.tool_calls)?.tool_calls[0].function.name, 'write_file', 'provider replay retains the original spelling');
    }
    console.log('tool-admission: serial/parallel allowlists, alias approvals and provider replay passed');
} finally { globalThis.fetch = originalFetch; }
