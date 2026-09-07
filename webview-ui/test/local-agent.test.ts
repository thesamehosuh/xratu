
import assert from 'node:assert/strict';
import { runLocalAgent, type LocalAgentRequest, type LocalAgentMessage } from '../src/localAgent';

type MockResponse = {
    ok: boolean;
    status: number;
    body: ReadableStream<Uint8Array>;
    text: () => Promise<string>;
    json?: () => Promise<unknown>;
};

function sse(lines: string[]): MockResponse {
    const encoder = new TextEncoder();
    let index = 0;
    return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
            pull(controller) {
                if (index >= lines.length) {
                    controller.close();
                    return;
                }
                controller.enqueue(encoder.encode(lines[index++]));
            },
        }),
        text: async () => '',
    };
}

function toolCallSse(name: string, args: string, id = 'call-1'): string[] {
    const pieces = args.match(/.{1,4}/g) ?? ['{}'];
    const chunks = [
        `data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: pieces[0] } }] } }],
        })}\n\n`,
    ];
    for (const piece of pieces.slice(1)) {
        chunks.push(
            `data: ${JSON.stringify({
                choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }],
            })}\n\n`,
        );
    }
    chunks.push('data: [DONE]\n\n');
    return chunks;
}

function textSse(parts: string[]): string[] {
    return [
        ...parts.map((content) =>
            `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
        ),
        'data: [DONE]\n\n',
    ];
}

function jsonResponse(obj: unknown): MockResponse {
    return {
        ok: true,
        status: 200,
        body: undefined as unknown as ReadableStream<Uint8Array>,
        text: async () => JSON.stringify(obj),
        json: async () => obj,
    } as MockResponse;
}

function baseRequest(overrides: Partial<LocalAgentRequest> = {}): LocalAgentRequest {
    return {
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: null,
        model: 'test-model',
        systemPrompt: 'You are Xratu.',
        userText: 'hello',
        tools: [],
        maxRounds: 4,
        ...overrides,
    };
}

async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
    const result: T[] = [];
    for await (const event of iter) result.push(event);
    return result;
}

async function testStreamingDeltas() {
    const calls: Array<{ url: string; body: any }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return sse(textSse(['hel', 'lo', ' world']));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest(), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        const chunks = events
            .filter((e: any) => e.type === 'chunk')
            .map((e: any) => e.value);

        assert.deepEqual(chunks, ['hel', 'lo', ' world']);
        assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
        assert.equal(calls[0].body.stream, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testToolCallApprovalAndContinuation() {
    const responses = [
        sse(toolCallSse('run_terminal_command', JSON.stringify({ command: 'echo ok' }))),
        sse(textSse(['tool result ', 'received'])),
    ];
    let requestIndex = 0;
    const executed: string[] = [];
    const approvals: string[] = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => responses[requestIndex++]) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                tools: [{
                    name: 'run_terminal_command',
                    description: 'Run terminal command',
                    inputSchema: {
                        type: 'object',
                        properties: { command: { type: 'string' } },
                        required: ['command'],
                    },
                    requiresApproval: true,
                }],
            }), {
                execute: async (call) => {
                    executed.push(call.name);
                    return { output: 'STDOUT:\\nok\\n' };
                },
            }, {
                requestApproval: async (approvalId, calls) => {
                    approvals.push(approvalId);
                    assert.equal(calls.length, 1);
                    assert.equal(calls[0].arguments.command, 'echo ok');
                    return { 'call-1': true };
                },
            })
        );

        assert.deepEqual(executed, ['run_terminal_command']);
        assert.equal(approvals.length, 1);
        assert.ok(events.some((e: any) => e.type === 'needsApproval'));
        assert.ok(events.some((e: any) => e.type === 'toolResult' && e.id === 'call-1'));
        const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.value);
        assert.deepEqual(chunks, ['tool result ', 'received']);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testDeniedToolProducesToolResultAndContinues() {
    const responses = [
        sse(toolCallSse('run_terminal_command', JSON.stringify({ command: 'danger' }))),
        sse(textSse(['not approved'])),
    ];
    let requestIndex = 0;
    let executeCount = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => responses[requestIndex++]) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                tools: [{
                    name: 'run_terminal_command',
                    description: 'Run terminal command',
                    inputSchema: { type: 'object' },
                    requiresApproval: true,
                }],
            }), {
                execute: async () => {
                    executeCount++;
                    return { output: 'should not run' };
                },
            }, {
                requestApproval: async () => ({ 'call-1': false }),
            })
        );

        assert.equal(executeCount, 0);
        assert.ok(events.some((e: any) =>
            e.type === 'toolResult' &&
            e.id === 'call-1' &&
            e.isError === true &&
            /denied/i.test(e.output)
        ));
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testImageIsCurrentTurnOnly() {
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return sse(textSse(['seen']));
    }) as typeof fetch;

    try {
        const image = {
            name: 'shot.png',
            mimeType: 'image/png',
            dataBase64: 'aGVsbG8=',
        };

        await collect(
            runLocalAgent(baseRequest({
                userText: 'What is in this image?',
                attachments: [image],
                history: [{ role: 'user', content: 'older turn' }],
            }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        const messages: LocalAgentMessage[] = requests[0].messages;
        const current = messages[messages.length - 1];

        assert.equal(current.role, 'user');
        assert.ok(Array.isArray(current.content));
        // Current user turn carries the user text and image directly - no
        // synthetic marker parts.
        assert.equal((current.content as any[])[0].text, 'What is in this image?');
        assert.equal((current.content as any[])[1].type, 'image_url');
        assert.equal((current.content as any[])[1].image_url.url, 'data:image/png;base64,aGVsbG8=');

        // History stays as real role-structured turns; no text markers and
        // the image isn't rewritten into persistent history.
        assert.equal(messages[1].role, 'user');
        assert.equal(messages[1].content, 'older turn');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testNon2xxFailsClearly() {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: false,
        status: 503,
        text: async () => 'server unavailable',
    })) as typeof fetch;

    try {
        await assert.rejects(
            collect(
                runLocalAgent(baseRequest(), {
                    execute: async () => ({ output: '' }),
                }, {
                    requestApproval: async () => ({}),
                })
            ),
            /503.*server unavailable/
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testFinalAnswerIsEmittedForHistory() {
    const responses = [
        sse(toolCallSse('read_file', JSON.stringify({ path: 'a.ts' }))),
        sse(textSse(['final ', 'answer'])),
    ];
    let requestIndex = 0;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => responses[requestIndex++]) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: {
                        type: 'object',
                        properties: { path: { type: 'string' } },
                        required: ['path'],
                    },
                }],
            }), {
                execute: async () => ({ output: 'file body' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        const assistantMessages = events.filter((e: any) => e.type === 'assistantMessage');
        assert.equal(assistantMessages.length, 2);
        assert.ok(assistantMessages[0].toolCalls.length === 1);
        assert.equal(assistantMessages[1].text, 'final answer');
        assert.deepEqual(assistantMessages[1].toolCalls, []);
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testHistoryKeepsRawTurnStructure() {
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return sse(textSse(['ok']));
    }) as typeof fetch;

    try {
        await collect(
            runLocalAgent(baseRequest({
                history: [
                    { role: 'user', content: 'hello' },
                    { role: 'assistant', content: 'hi' },
                    { role: 'user', content: 'fix this' },
                    { role: 'assistant', content: 'done' },
                ],
            }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        const messages: LocalAgentMessage[] = requests[0].messages;
        // Each prior turn is its own real user/assistant message - never
        // flattened into one prompt blob or textually delimited.
        assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
        assert.equal(messages[1].content, 'hello');
        assert.equal(messages[2].content, 'hi');
        assert.equal(messages[3].content, 'fix this');
        assert.equal(messages[4].content, 'done');
        assert.equal(messages[5].content, 'hello');
        const serialized = JSON.stringify(messages);
        assert.ok(!serialized.includes('[HISTORICAL'));
        assert.ok(!serialized.includes('[CURRENT USER TURN]'));
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testAttachmentOnlyTurnGetsPlaceholderText() {
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return sse(textSse(['ok']));
    }) as typeof fetch;

    try {
        await collect(
            runLocalAgent(baseRequest({
                userText: '',
                attachments: [{ name: 'shot.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' }],
            }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        const messages: LocalAgentMessage[] = requests[0].messages;
        const current = messages[messages.length - 1];
        assert.equal(current.role, 'user');
        const content = current.content as any[];
        // Empty text must be replaced - some OpenAI-compatible servers reject
        // empty text parts outright.
        assert.equal(content[0].text, 'Describe the attached file(s).');
        assert.equal(content[1].type, 'image_url');
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testImageFormatRetryOnLmStudioStyle400() {
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;

    // First call rejects the OpenAI-standard data: URI exactly like LM Studio;
    // the agent must flip to raw base64 and retry automatically.
    globalThis.fetch = (async (_input, init) => {
        call++;
        requests.push(JSON.parse(String(init?.body)));
        if (call === 1) {
            return {
                ok: false,
                status: 400,
                body: null,
                text: async () => '{"error":"\'url\' field must be a base64 encoded image."}',
            } as unknown as Response;
        }
        return sse(textSse(['ok']));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                userText: 'what is this',
                attachments: [{ name: 'shot.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' }],
            }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        assert.equal(call, 2);
        assert.ok(events.some((e: any) => e.type === 'assistantMessage'));
        const firstUrl = requests[0].messages.at(-1).content[1].image_url.url;
        const secondUrl = requests[1].messages.at(-1).content[1].image_url.url;
        assert.ok(firstUrl.startsWith('data:image/png;base64,'));
        // Retry must carry RAW base64 - no data: prefix.
        assert.equal(secondUrl, 'aGVsbG8=');
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testContextStatusLineInSystemPrompt() {
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return sse(textSse(['ok']));
    }) as typeof fetch;

    try {
        await collect(
            runLocalAgent(baseRequest({ contextWindow: 8192 }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        const system: string = requests[0].messages[0].content;
        // The model always sees how full its window is.
        assert.ok(system.startsWith('You are Xratu.'));
        assert.ok(system.includes('[Context status:'), `missing status line: ${system}`);
        assert.ok(system.includes('of the 8192-token context window'), system);
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testProactiveCompactDropsOldTurnsAtStart() {
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;

    // Kept pairs + a fat system prompt (~2k) cross the 90% line of the 4k
    // window BEFORE the first request is even sent.
    const history: LocalAgentMessage[] = [];
    for (let i = 0; i < 8; i++) {
        history.push({ role: 'user', content: `turn${i} ` + 'A'.repeat(1600) });
        history.push({ role: 'assistant', content: `reply${i} ` + 'B'.repeat(1600) });
    }

    globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        // Non-streaming call = the compaction summarizer, not the chat loop.
        if (body.stream === false) {
            return jsonResponse({
                choices: [{ message: { content: 'Compacted summary: early turns asked about setup.' } }],
            });
        }
        return sse(textSse(['ok']));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                contextWindow: 4096,
                systemPrompt: 'You are Xratu.' + 'S'.repeat(6000),
                history,
            }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        // The summarizer ran on the user's model BEFORE the first request…
        assert.equal(requests[0].stream, false);
        // boundHistory (72% guard) trims the very oldest turns at build
        // time; the PROACTIVE compaction then drops the next pair and the
        // summarizer must see every message it removed.
        assert.ok(JSON.stringify(requests[0].messages).includes('turn6'));
        assert.ok(JSON.stringify(requests[0].messages).includes('reply6'));
        // …and the chat request carries the summary inside the marker.
        const messages: LocalAgentMessage[] = requests[1].messages;
        const serialized = JSON.stringify(messages);
        // Oldest turns replaced by an explicit truncation marker…
        assert.equal(messages[1].role, 'user');
        assert.ok(messages[1].content.includes('Earlier messages in this conversation were removed'));
        assert.ok(messages[1].content.includes('[Summary of the removed turns'));
        assert.ok(messages[1].content.includes('Compacted summary: early turns asked about setup.'));
        // …newest turns survive, and the current turn is last.
        assert.ok(messages.length < 2 + history.length + 1);
        assert.equal(messages.at(-1)!.role, 'user');
        assert.ok(serialized.includes('turn7') && serialized.includes('reply7'));
        assert.ok(!serialized.includes('turn0') && !serialized.includes('turn1'));
        // The host is told about the summary so it can roll it forward.
        assert.ok(events.some((e: any) => e.type === 'compactionSummary'));
        // The system prompt carries the post-compaction occupancy.
        assert.ok(messages[0].content.includes('[Context status:'));
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testMidRunCompactionFromServerUsage() {
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;

    // History estimates stay under the 90% line, but the server REPORTS
    // 7.7k/8k prompt tokens (tool schemas inflate the real request) - the
    // agent must compact mid-turn from ground truth, not estimates.
    const history: LocalAgentMessage[] = [];
    for (let i = 0; i < 4; i++) {
        history.push({ role: 'user', content: `turn${i} ` + 'A'.repeat(4000) });
        history.push({ role: 'assistant', content: `reply${i} ` + 'B'.repeat(4000) });
    }

    globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        // Non-streaming call = the compaction summarizer; it must NOT
        // consume a chat round from the call counter.
        if (body.stream === false) {
            requests.push(body);
            return jsonResponse({
                choices: [{ message: { content: 'Mid-run summary: earlier turns read configs.' } }],
            });
        }
        call++;
        requests.push(body);
        if (call === 1) {
            return sse([
                ...toolCallSse('read_file', JSON.stringify({ path: 'a.py' })),
                `data: ${JSON.stringify({ usage: { prompt_tokens: 7600, completion_tokens: 100 } })}\n\n`,
                'data: [DONE]\n\n',
            ]);
        }
        return sse(textSse(['done']));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                contextWindow: 8192,
                systemPrompt: 'You are Xratu.' + 'S'.repeat(2400),
                history,
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object' },
                }],
            }), {
                execute: async () => ({ output: 'contents' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        assert.ok(events.some((e: any) => e.type === 'assistantMessage'));
        assert.ok(events.some((e: any) => e.type === 'compactionSummary'));
        // The summarizer call sat between the two chat rounds and saw exactly
        // what the mid-run compaction dropped (boundHistory already removed
        // the very oldest turns before round 1).
        assert.equal(requests[1].stream, false);
        assert.ok(JSON.stringify(requests[1].messages).includes('turn2'));
        assert.ok(JSON.stringify(requests[1].messages).includes('reply2'));
        const round2: LocalAgentMessage[] = requests[2].messages;
        const serialized = JSON.stringify(round2);
        // Oldest pairs dropped mid-run; assistant→tool pair of the current
        // turn untouched at the tail.
        assert.ok(round2[1].content.includes('Earlier messages in this conversation were removed'));
        assert.ok(round2[1].content.includes('Mid-run summary: earlier turns read configs.'));
        assert.ok(!serialized.includes('turn0') && !serialized.includes('turn1') && !serialized.includes('turn2'));
        assert.ok(serialized.includes('turn3') && serialized.includes('contents'));
        assert.equal(round2.at(-1)!.role, 'tool');
        // System prompt repainted with the post-compaction fill level.
        assert.ok(round2[0].content.includes('[Context status:'));
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testSteerJoinsBeforeNextRound() {
    const responses = [
        sse(toolCallSse('read_file', JSON.stringify({ path: 'a.txt' }), 'call-1')),
        sse(textSse(['post-steer ', 'reply'])),
    ];
    let requestIndex = 0;
    const requests: Array<{ body: { messages: LocalAgentMessage[] } }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return responses[requestIndex++];
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                }],
            }), {
                execute: async () => ({ output: 'file contents' }),
            }, {
                requestApproval: async () => ({}),
            }, {
                // Queued while round 1 was streaming; must drain at the round
                // boundary - AFTER the tool result, BEFORE round 2's request.
                drain: () => [{ text: 'also check b.txt' }],
            })
        );

        // Steer event lands between the round-1 tool result and round-2 output.
        const steerIdx = events.findIndex((e: any) => e.type === 'steer');
        const toolResultIdx = events.findIndex((e: any) => e.type === 'toolResult');
        assert.ok(steerIdx > toolResultIdx, 'steer must follow the tool result');
        assert.equal((events[steerIdx] as any).text, 'also check b.txt');

        // Round 2 request: steer sits AFTER the tool result, at the tail.
        const round2 = requests[1].body.messages;
        assert.equal(round2.at(-2)!.role, 'tool');
        assert.equal(round2.at(-1)!.role, 'user');
        assert.equal(round2.at(-1)!.content, 'also check b.txt');
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function main() {
    await testStreamingDeltas();
    await testToolCallApprovalAndContinuation();
    await testDeniedToolProducesToolResultAndContinues();
    await testImageIsCurrentTurnOnly();
    await testAttachmentOnlyTurnGetsPlaceholderText();
    await testImageFormatRetryOnLmStudioStyle400();
    await testNon2xxFailsClearly();
    await testFinalAnswerIsEmittedForHistory();
    await testHistoryKeepsRawTurnStructure();
    await testContextStatusLineInSystemPrompt();
    await testProactiveCompactDropsOldTurnsAtStart();
    await testMidRunCompactionFromServerUsage();
    await testSteerJoinsBeforeNextRound();

    console.log('local-agent.test.ts: all tests passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
