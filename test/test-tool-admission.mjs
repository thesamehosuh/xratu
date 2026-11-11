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
        for (const maxRounds of [1, 3]) {
            const bodies = [], queued = [], events = [];
            const correction = { text: 'Stop the old plan. Inspect the replacement target instead.', steerId: 'correction' };
            globalThis.fetch = async (_url, init) => {
                bodies.push(JSON.parse(init.body));
                const delta = bodies.length === 1 ? { tool_calls: ['task', 'read_file'].map((name, index) => ({ index, id: `mixed-${index}`, function: { name, arguments: '{}' } })) } : { content: 'Corrected answer' };
                return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
            };
            for await (const event of runLocalAgent({
                baseUrl: 'http://127.0.0.1:11434/v1', apiKey: null, model: 'test', systemPrompt: 'test', userText: 'Original plan',
                tools: ['task', 'read_file'].map(name => ({ name, description: '', inputSchema: {} })), maxRounds,
                ...(parallel ? { parallelTools: ['task'], parallelToolLimit: 1 } : {}),
            }, { execute: async call => { if (call.name === 'task') queued.push(correction); return { output: 'completed' }; } }, {
                requestApproval: async () => ({}),
            }, { drain: () => queued.splice(0) })) events.push(event);
            const messages = bodies[1].messages;
            const steerIndex = messages.findIndex(message => message.role === 'user' && message.content.includes(correction.text));
            assert.ok(steerIndex >= 0, `correction reaches the very next ${maxRounds === 1 ? 'wrap-up' : 'model'} request (${parallel ? 'parallel' : 'serial'})`);
            assert.equal(messages.slice(0, steerIndex).filter(message => message.role === 'tool').length, 2, 'corrections follow the complete mixed tool batch');
            assert.equal(events.filter(event => event.type === 'steer' && event.steerId === correction.steerId).length, 1, 'corrections are confirmed exactly once');
            assert.equal(queued.length, 0);
        }
    }
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
