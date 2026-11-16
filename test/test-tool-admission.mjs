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
    // Text-only completion is a delivery boundary too (not just tool rounds).
    // Instant steering aborts only the provider request, discards partial tool
    // arguments, and keeps the parent/children cancellation signal untouched.
    for (const instant of [false, true]) {
        const bodies = [], queued = [], events = [], parent = new AbortController();
        let interrupt;
        globalThis.fetch = async (_url, init) => {
            bodies.push(JSON.parse(init.body));
            if (bodies.length > 1) return new Response('data: {"choices":[{"delta":{"content":"Corrected"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
            return new Response(new ReadableStream({ start(controller) {
                const delta = { content: 'Old answer', ...(instant ? { tool_calls: [{ index: 0, id: 'partial', function: { name: 'task', arguments: '{' } }] } : {}) };
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
                if (instant) init.signal.addEventListener('abort', () => controller.error(new DOMException('Interrupted', 'AbortError')), { once: true });
                else { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); }
            } }), { headers: { 'content-type': 'text/event-stream' } });
        };
        for await (const event of runLocalAgent({
            baseUrl: 'http://127.0.0.1:11434/v1', apiKey: null, model: 'test', systemPrompt: 'test', userText: 'Original',
            tools: [], maxRounds: 3, signal: parent.signal,
        }, { execute: async () => { throw Error('Partial tool must never execute'); } }, { requestApproval: async () => ({}) }, {
            drain: () => queued.splice(0), setInterrupt: callback => { interrupt = callback; },
        })) {
            events.push(event);
            if (event.type === 'chunk' && event.value === 'Old answer') {
                queued.push({ text: 'Change direction', steerId: 'late-final' });
                if (instant) { assert.equal(typeof interrupt, 'function'); interrupt(); }
            }
        }
        assert.equal(bodies.length, 2);
        assert.equal(parent.signal.aborted, false, 'steering does not cancel parent or children');
        assert.equal(interrupt, undefined, 'request interrupt registration is cleaned up');
        assert.equal(events.filter(event => event.type === 'steer').length, 1);
        assert.equal(events.some(event => event.type === 'toolCall'), false);
        assert.ok(bodies[1].messages.some(message => message.role === 'assistant' && message.content === 'Old answer'));
        assert.ok(bodies[1].messages.some(message => message.role === 'user' && message.content.includes('Change direction')));
        assert.ok(!JSON.stringify(bodies[1]).includes('partial'), 'no dangling tool carrier is replayed');
    }
    for (const parallel of [false, true]) {
        for (const name of ['mcp__remote__mutate', 'write_file', 'task']) {
            const result = await scenario(name, [{ name: 'read_file', description: '', inputSchema: {} }], { parallel });
            assert.deepEqual(result.executed, [], `${name} absent from run tools must not execute (${parallel ? 'parallel' : 'serial'})`);
            assert.ok(result.events.some(e => e.type === 'toolResult' && e.isError));
        }
        const definitions = [{ name: 'edit_file', description: '', inputSchema: {}, requiresApproval: true }];
        const denied = await scenario('write_file', definitions, { parallel });
        assert.deepEqual(denied.approved, [], 'unavailable old names never request permission');
        assert.deepEqual(denied.executed, []);
        const allowed = await scenario('write_file', definitions, { parallel, allow: true });
        assert.deepEqual(allowed.executed, [], 'unavailable names cannot execute even when approvals are granted');
        assert.equal(allowed.bodies[1].messages.find(m => m.tool_calls)?.tool_calls[0].function.name, 'write_file', 'provider replay retains the original spelling');
    }
    console.log('tool-admission: serial/parallel allowlists, alias approvals and provider replay passed');
} finally { globalThis.fetch = originalFetch; }
