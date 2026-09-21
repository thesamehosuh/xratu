
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

function reasoningSse(reasoningParts: string[], contentParts: string[]): string[] {
    return [
        ...reasoningParts.map((reasoning_content) =>
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content } }] })}\n\n`
        ),
        ...contentParts.map((content) =>
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

async function testCachedTokensParsed() {
    // Cache-hit accounting differs per provider; all three shapes must land.
    const shapes: Array<{ usage: Record<string, unknown>; expected: number }> = [
        { usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 64 } }, expected: 64 },
        { usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cache_read_input_tokens: 32 }, expected: 32 },
        { usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 16 }, expected: 16 },
    ];

    for (const shape of shapes) {
        const originalFetch = globalThis.fetch;
        const frames = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }], usage: shape.usage })}\n\n`,
            'data: [DONE]\n\n',
        ];
        globalThis.fetch = (async () => sse(frames)) as typeof fetch;
        try {
            const events = await collect(
                runLocalAgent(baseRequest(), {
                    execute: async () => ({ output: '' }),
                }, {
                    requestApproval: async () => ({}),
                })
            );
            const usageEvent = events.find((e: any) => e.type === 'usage' && !e.estimated);
            assert.ok(usageEvent, `expected a server usage event for ${JSON.stringify(shape.usage)}`);
            assert.equal(usageEvent.usage.cachedTokens, shape.expected);
        } finally {
            globalThis.fetch = originalFetch;
        }
    }
}

async function testChatCacheWriteTokensParsed() {
    // OpenAI reports cache WRITES alongside reads; both must survive parsing so
    // the host can bill writes at the higher rate.
    const originalFetch = globalThis.fetch;
    const frames = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 64, cache_write_tokens: 12 } } })}\n\n`,
        'data: [DONE]\n\n',
    ];
    globalThis.fetch = (async () => sse(frames)) as typeof fetch;
    try {
        const events = await collect(
            runLocalAgent(baseRequest(), { execute: async () => ({ output: '' }) }, { requestApproval: async () => ({}) })
        );
        const usageEvent = events.find((e: any) => e.type === 'usage' && !e.estimated);
        assert.equal(usageEvent.usage.cachedTokens, 64);
        assert.equal(usageEvent.usage.cacheWriteTokens, 12);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testReasoningStreamsAsCumulativeThinking() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
        sse(reasoningSse(['step one ', 'step two'], ['answer']))) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest(), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        // Reasoning models send chain-of-thought on a separate delta field.
        // The host's `thinking` event is a CUMULATIVE snapshot, so each event
        // must carry the whole block so far - not just the latest delta.
        const thinking = events.filter((e: any) => e.type === 'thinking').map((e: any) => e.value);
        assert.deepEqual(thinking, ['step one ', 'step one step two']);

        // Ordering: reasoning must arrive BEFORE the answer content, not be
        // reordered behind it.
        const kinds = events
            .filter((e: any) => e.type === 'thinking' || e.type === 'chunk')
            .map((e: any) => e.type);
        assert.deepEqual(kinds, ['thinking', 'thinking', 'chunk']);

        // Reasoning must never leak into the assistant's answer text.
        const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.value);
        assert.deepEqual(chunks, ['answer']);
        const final = events.find((e: any) => e.type === 'assistantMessage');
        assert.equal(final.text, 'answer');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testStreamOptionsRejectedRetriesWithout() {
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        call++;
        if (call === 1) {
            // A strict OpenAI-compatible server rejects the non-standard field.
            return {
                ok: false,
                status: 400,
                text: async () => '{"error":"unknown field: stream_options"}',
            } as MockResponse;
        }
        return sse(textSse(['ok']));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest(), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        assert.equal(call, 2, 'must retry exactly once without stream_options');
        assert.ok(requests[0].stream_options, 'first request asks for streamed usage');
        assert.equal(requests[1].stream_options, undefined, 'retry omits stream_options');
        assert.ok(events.some((e: any) => e.type === 'assistantMessage'));
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testNonStreamOptions400DoesNotRetry() {
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
        call++;
        return {
            ok: false,
            status: 400,
            text: async () => '{"error":"model not found"}',
        } as MockResponse;
    }) as typeof fetch;

    try {
        await assert.rejects(
            collect(
                runLocalAgent(baseRequest(), {
                    execute: async () => ({ output: '' }),
                }, {
                    requestApproval: async () => ({}),
                })
            ),
            /400.*model not found/
        );
        assert.equal(call, 1, 'an unrelated 400 must not be retried');
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


async function testContextStatusRidesTheTailNotTheSystemPrompt() {
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

        // The system prompt is the STABLE cacheable prefix: it must not carry
        // the volatile fill-level line (that would break the prefix cache every
        // round). The status rides a trailing message instead.
        const system: string = requests[0].messages[0].content;
        assert.equal(system, 'You are Xratu.', 'system prompt stays byte-stable');
        assert.ok(!system.includes('[Context status:'), 'status line must not be in the system prompt');

        // Chat appends the note to the LAST message (a trailing system message
        // is rejected by strict servers).
        const tail = requests[0].messages[requests[0].messages.length - 1];
        assert.equal(tail.role, 'user', 'the volatile note rides the last message');
        assert.ok(String(tail.content).includes('[Context status:'), `missing status line: ${tail.content}`);
        assert.ok(String(tail.content).includes('of the 8192-token context window'), tail.content);
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testSystemPromptStaysStableAcrossRounds() {
    // Prompt caching is a PREFIX cache: the system prompt must be byte-identical
    // on every round of a turn, or nothing downstream can ever be reused.
    const requests: any[] = [];
    const responses = [
        sse(toolCallSse('read_file', JSON.stringify({ path: 'a.txt' }), 'call-1')),
        sse(textSse(['done'])),
    ];
    let index = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return responses[index++];
    }) as typeof fetch;

    try {
        await collect(
            runLocalAgent(baseRequest({
                contextWindow: 8192,
                systemPrompt: 'You are an AI coding assistant.',
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
                }],
            }), {
                execute: async () => ({ output: 'contents' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        assert.equal(requests.length, 2, 'expected two model rounds');
        // Byte-identical system prompt across rounds.
        assert.equal(
            requests[0].messages[0].content,
            requests[1].messages[0].content,
            'system prompt must not change between rounds',
        );
        assert.ok(!requests[0].messages[0].content.includes('[Context status:'));
        // The volatile note trails each request exactly once, and is NOT stored
        // in the history (round 2 must not carry round 1's note mid-array).
        for (const body of requests) {
            const msgs = body.messages;
            const notes = msgs.filter((m: any) => String(m.content).includes('[Context status:'));
            assert.equal(notes.length, 1, 'exactly one trailing note per request');
            assert.ok(String(msgs[msgs.length - 1].content).includes('[Context status:'), 'note rides the last message');
        }
        assert.ok(!JSON.stringify(requests[1].messages.slice(1, -1)).includes('[Context status:'), 'note must not be stored in history');
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
        // …newest turns survive, and the current user turn is last (the
        // trailing volatile note rides it, never stored in history).
        assert.ok(messages.length < 2 + history.length + 1);
        assert.equal(messages.at(-1)!.role, 'user');
        assert.ok(String(messages.at(-1)!.content).includes('[Context status:'));
        assert.ok(serialized.includes('turn7') && serialized.includes('reply7'));
        assert.ok(!serialized.includes('turn0') && !serialized.includes('turn1'));
        // The host is told about the summary so it can roll it forward.
        assert.ok(events.some((e: any) => e.type === 'compactionSummary'));
        // Post-compaction occupancy rides the trailing note, not the system
        // prompt (which must stay cache-stable).
        assert.ok(String(messages.at(-1)!.content).includes('[Context status:'));
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
        // The current turn's tool result is last, carrying the trailing
        // volatile note; the system prompt stays byte-stable (cacheable).
        assert.equal(round2.at(-1)!.role, 'tool');
        assert.ok(String(round2.at(-1)!.content).includes('[Context status:'));
        assert.ok(!round2[0].content.includes('[Context status:'));
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


async function testRoundBudgetEndsWithWrapupInsteadOfError() {
    const requests: any[] = [];
    const executed: string[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;

    globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        call++;
        if (call <= 2) {
            return sse(toolCallSse('read_file', JSON.stringify({ path: `f${call}.txt` }), `call-${call}`));
        }
        return sse(textSse(['wrap-up ', 'summary']));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                maxRounds: 2,
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                }],
            }), {
                execute: async (toolCall) => {
                    executed.push(toolCall.name);
                    return { output: 'contents' };
                },
            }, {
                requestApproval: async () => ({}),
            })
        );

        // 2 budgeted rounds + 1 wrap-up round; no throw.
        assert.equal(requests.length, 3);
        // The wrap-up keeps the cached prefix INTACT: the same tool
        // definitions and the same system message as every earlier round.
        // Dropping `tools` (or rewriting the system prompt) would change the
        // cached prefix and force a full cache miss at peak context.
        assert.deepEqual(requests[2].tools, requests[0].tools, 'tool definitions stay byte-identical');
        assert.equal(requests[2].tool_choice, 'none', 'tool CALLS are forbidden instead of tools being dropped');
        assert.equal(requests[2].messages[0].content, 'You are Xratu.', 'system prompt must not be rewritten');
        // The nudge rides the volatile tail note, after every cache breakpoint.
        const wrapTail = requests[2].messages[requests[2].messages.length - 1];
        assert.ok(String(wrapTail.content).includes('ROUND LIMIT REACHED'), `nudge missing from tail: ${wrapTail.content}`);
        assert.ok(!requests[2].messages.slice(1, -1).some(
            (m: any) => String(m.content).includes('ROUND LIMIT REACHED')),
            'nudge must not be stored in history');
        // The final answer rides a normal assistantMessage; the turn ends done.
        const final = events.find((e: any) => e.type === 'assistantMessage' && e.text.includes('wrap-up'));
        assert.ok(final);
        assert.deepEqual(final.toolCalls, []);
        assert.equal((events.at(-1) as any).type, 'status');
        assert.equal((events.at(-1) as any).value, 'done');
        // Only the two budgeted rounds executed tools - not the wrap-up.
        assert.deepEqual(executed, ['read_file', 'read_file']);
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testWrapupToolCallIsIgnored() {
    const executed: string[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;

    globalThis.fetch = (async () => {
        call++;
        if (call === 1) {
            return sse(toolCallSse('read_file', JSON.stringify({ path: 'a.txt' }), 'call-1'));
        }
        // The wrap-up round hallucinates a tool call alongside its text.
        return sse([
            ...toolCallSse('read_file', JSON.stringify({ path: 'b.txt' }), 'call-2'),
            ...textSse(['final answer']),
        ]);
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                maxRounds: 1,
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                }],
            }), {
                execute: async () => {
                    executed.push('read_file');
                    return { output: 'contents' };
                },
            }, {
                requestApproval: async () => ({}),
            })
        );

        // The wrap-up tool call was NOT executed and produced no tool events.
        assert.deepEqual(executed, ['read_file']);
        assert.ok(!events.some((e: any) => e.type === 'toolCall' && e.id === 'call-2'));
        assert.ok(!events.some((e: any) => e.type === 'toolResult' && e.id === 'call-2'));
        // Its text still lands as the final message; the turn completes.
        assert.ok(events.some((e: any) => e.type === 'assistantMessage' && e.text === 'final answer'));
        assert.equal((events.at(-1) as any).type, 'status');
        assert.equal((events.at(-1) as any).value, 'done');
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testWrapupRequestFailureStillErrors() {
    const originalFetch = globalThis.fetch;
    let call = 0;

    globalThis.fetch = (async () => {
        call++;
        if (call === 1) {
            return sse(toolCallSse('read_file', JSON.stringify({ path: 'a.txt' }), 'call-1'));
        }
        return {
            ok: false,
            status: 503,
            text: async () => 'server unavailable',
        } as MockResponse;
    }) as typeof fetch;

    try {
        await assert.rejects(
            collect(
                runLocalAgent(baseRequest({
                    maxRounds: 1,
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
            ),
            /503.*server unavailable/
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testWrapupWithoutTextEmitsFallback() {
    const executed: string[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;

    globalThis.fetch = (async () => {
        call++;
        if (call === 1) {
            return sse(toolCallSse('read_file', JSON.stringify({ path: 'a.txt' }), 'call-1'));
        }
        // Stubborn model: the wrap-up round returns ONLY a tool call.
        return sse(toolCallSse('read_file', JSON.stringify({ path: 'b.txt' }), 'call-2'));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                maxRounds: 1,
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                }],
            }), {
                execute: async () => {
                    executed.push('read_file');
                    return { output: 'contents' };
                },
            }, {
                requestApproval: async () => ({}),
            })
        );

        // The wrap-up tool call was ignored - only the budgeted round ran.
        assert.deepEqual(executed, ['read_file']);
        // The turn still commits with a visible final message, not blank.
        const final = events.find((e: any) => e.type === 'assistantMessage' && e.text.includes('Round limit reached'));
        assert.ok(final);
        assert.deepEqual(final.toolCalls, []);
        assert.equal((events.at(-1) as any).type, 'status');
        assert.equal((events.at(-1) as any).value, 'done');
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testWrapupReasoningIsForwarded() {
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
        call++;
        if (call === 1) {
            return sse(toolCallSse('read_file', JSON.stringify({ path: 'a.txt' }), 'call-1'));
        }
        // Wrap-up round offers no tools and streams reasoning + final text.
        return sse(reasoningSse(['wrap reasoning'], ['final answer']));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                maxRounds: 1,
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                }],
            }), {
                execute: async () => ({ output: 'contents' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        // The wrap-up path must forward thinking too - it used to parse
        // reasoning and drop it.
        const thinking = events.filter((e: any) => e.type === 'thinking').map((e: any) => e.value);
        assert.deepEqual(thinking, ['wrap reasoning']);
        assert.ok(events.some((e: any) => e.type === 'assistantMessage' && e.text === 'final answer'));
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testWrapupOverflowCompactsAndRetries() {
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;

    globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        call++;
        if (call === 1) {
            return sse(toolCallSse('read_file', JSON.stringify({ path: 'a.txt' }), 'call-1'));
        }
        if (call === 2) {
            // The wrap-up prompt overflows the window - the server rejects
            // before streaming anything, like Ollama/llama.cpp do.
            return {
                ok: false,
                status: 400,
                body: undefined,
                text: async () => 'input length exceeds context length',
            } as MockResponse;
        }
        return sse(textSse(['recovered answer']));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                maxRounds: 1,
                contextWindow: 8192,
                history: [
                    { role: 'user', content: 'old question one' },
                    { role: 'assistant', content: 'old answer one' },
                    { role: 'user', content: 'old question two' },
                    { role: 'assistant', content: 'old answer two' },
                ],
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                }],
            }), {
                execute: async () => ({ output: 'contents' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        // 1 budgeted round + failed wrap-up + successful retry.
        assert.equal(requests.length, 3);
        const serialized = JSON.stringify(requests[2].messages);
        // The retry compacted: oldest pair dropped, truncation marker in.
        assert.ok(requests[2].messages[1].content.includes('Earlier messages in this conversation were removed'));
        assert.ok(!serialized.includes('old question one'));
        // Compaction never touches the current turn.
        assert.ok(serialized.includes('old question two'));
        assert.ok(serialized.includes('contents'));
        // The turn completes normally after the recovered retry.
        assert.ok(events.some((e: any) => e.type === 'assistantMessage' && e.text === 'recovered answer'));
        assert.equal((events.at(-1) as any).type, 'status');
        assert.equal((events.at(-1) as any).value, 'done');
    } finally {
        globalThis.fetch = originalFetch;
    }
}


async function testMessagesApiTextThinkingAndUsage() {
    const calls: Array<{ url: string; body: any; headers: any }> = [];
    const originalFetch = globalThis.fetch;
    const frames = [
        `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 120, output_tokens: 0, cache_read_input_tokens: 40, cache_creation_input_tokens: 8 } } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing ' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'options' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hel' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 2 } })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];
    globalThis.fetch = (async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: init?.headers });
        return sse(frames);
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                apiStyle: 'messages',
                model: 'claude-sonnet-5',
                apiKey: 'sk-test',
                maxTokens: 1024,
                sessionId: 'sess-1',
            }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/messages');
        assert.equal(calls[0].body.max_tokens, 1024, 'max_tokens is required by Messages');
        // System is a top-level BLOCK with an Anthropic cache breakpoint; the
        // volatile status/hint must NOT be in it (that would invalidate the
        // cache every round).
        assert.equal(calls[0].body.system[0].text, 'You are Xratu.', 'system is a top-level block');
        assert.equal(calls[0].body.system[0].cache_control.type, 'ephemeral', 'system is a cache breakpoint');
        assert.equal(calls[0].body.stream, true);
        const headers = calls[0].headers as Headers;
        assert.equal(headers.get('x-api-key'), 'sk-test');
        assert.equal(headers.get('anthropic-version'), '2023-06-01');
        // OpenCode Go requires the stable session id header.
        assert.equal(headers.get('x-opencode-session'), 'sess-1');

        const thinking = events.filter((e: any) => e.type === 'thinking').map((e: any) => e.value);
        assert.deepEqual(thinking, ['weighing ', 'weighing options'], 'thinking is cumulative');
        const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.value);
        assert.deepEqual(chunks, ['hel', 'lo']);
        const usageEvent = events.find((e: any) => e.type === 'usage' && !e.estimated);
        // Anthropic's input_tokens is the UNCACHED input; the total prompt is
        // input + cache_read + cache_creation. 120 + 40 + 8 = 168.
        assert.equal(usageEvent.usage.promptTokens, 168);
        assert.equal(usageEvent.usage.completionTokens, 2);
        assert.equal(usageEvent.usage.cachedTokens, 40);
        assert.equal(usageEvent.usage.cacheWriteTokens, 8, 'cache writes are surfaced for cost');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testMessagesApiToolUse() {
    const calls: Array<{ url: string; body: any }> = [];
    const responses = [
        sse([
            `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-123' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`,
            `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 } })}\n\n`,
        ]),
        sse([
            `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
        ]),
    ];
    let index = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return responses[index++];
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                apiStyle: 'messages',
                model: 'claude-sonnet-5',
                contextWindow: 8192,
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                }],
            }), {
                execute: async () => ({ output: 'contents' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        // Tools are serialized in the Anthropic shape (input_schema).
        assert.equal(calls[0].body.tools[0].name, 'read_file');
        assert.ok(calls[0].body.tools[0].input_schema);
        const call = events.find((e: any) => e.type === 'toolCall');
        assert.equal(call.tool, 'read_file');
        assert.deepEqual(call.args, { path: 'a.txt' });
        // The tool result rides back as a tool_result block in a USER message.
        const secondInput = calls[1].body.messages;
        const toolResult = secondInput.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
            .find((b: any) => b.type === 'tool_result');
        assert.equal(toolResult.tool_use_id, 'toolu_1');
        // The thinking block (with its signature) must be replayed verbatim on
        // the continuation - Anthropic rejects a continued thinking turn that
        // drops it.
        const assistantTurn = secondInput.find((m: any) => m.role === 'assistant');
        const thinkingBlock = assistantTurn.content.find((b: any) => b.type === 'thinking');
        assert.equal(thinkingBlock.thinking, 'weighing');
        assert.equal(thinkingBlock.signature, 'sig-123');
        assert.ok(assistantTurn.content.some((b: any) => b.type === 'tool_use' && b.name === 'read_file'));
        // Order is load-bearing: the thinking block must precede the tool_use.
        const blockTypes = assistantTurn.content.map((b: any) => b.type);
        assert.ok(blockTypes.indexOf('thinking') < blockTypes.indexOf('tool_use'), 'thinking must precede tool_use');

        // History caching: the last STORED block carries a breakpoint so the
        // growing conversation is cached incrementally; the volatile note
        // appended after it is NOT cached.
        const lastTurn = secondInput[secondInput.length - 1];
        const lastBlock = lastTurn.content[lastTurn.content.length - 1];
        assert.ok(String(lastBlock.text).includes('[Context status:'), 'note is the last block');
        assert.equal(lastBlock.cache_control, undefined, 'volatile note must not be cached');
        const storedBlock = lastTurn.content[lastTurn.content.length - 2];
        assert.equal(storedBlock.cache_control.type, 'ephemeral', 'history end is a cache breakpoint');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testResponsesApiTextToolAndUsage() {
    const calls: Array<{ url: string; body: any }> = [];
    const responses = [
        sse([
            `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } })}\n\n`,
            `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'weighing' }], encrypted_content: 'enc-1' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_abc', name: 'read_file', arguments: '' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":"' })}\n\n`,
            `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: 'a.txt"}' })}\n\n`,
            `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_abc', name: 'read_file', arguments: '{"path":"a.txt"}' } })}\n\n`,
        ]),
        sse([
            `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'done' })}\n\n`,
            `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 50, output_tokens: 7, total_tokens: 57, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 6 } } } })}\n\n`,
        ]),
    ];
    let index = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return responses[index++];
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                apiStyle: 'responses',
                model: 'gpt-5.6-luna',
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                }],
            }), {
                execute: async () => ({ output: 'contents' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/responses');
        assert.equal(calls[0].body.instructions, 'You are Xratu.');
        assert.ok(Array.isArray(calls[0].body.input));
        assert.equal(calls[0].body.tools[0].type, 'function');
        assert.equal(calls[0].body.tools[0].name, 'read_file');

        const call = events.find((e: any) => e.type === 'toolCall');
        assert.equal(call.tool, 'read_file');
        assert.deepEqual(call.args, { path: 'a.txt' });

        // The tool result goes back as a function_call_output item.
        const output = calls[1].body.input.find((item: any) => item.type === 'function_call_output');
        assert.equal(output.call_id, 'call_abc');
        // The reasoning item (with its encrypted payload) is replayed so the
        // continuation keeps its reasoning state.
        const reasoningItem = calls[1].body.input.find((item: any) => item.type === 'reasoning');
        assert.equal(reasoningItem.id, 'rs_1');
        assert.equal(reasoningItem.encrypted_content, 'enc-1');
        assert.ok(calls[1].body.input.some((item: any) => item.type === 'function_call' && item.call_id === 'call_abc'));
        // Order is load-bearing: the reasoning item must precede the function call.
        const inputTypes = calls[1].body.input.map((item: any) => item.type);
        assert.ok(inputTypes.indexOf('reasoning') < inputTypes.indexOf('function_call'), 'reasoning must precede function_call');

        const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.value);
        assert.deepEqual(chunks, ['done']);
        const usageEvent = events.find((e: any) => e.type === 'usage' && !e.estimated);
        assert.equal(usageEvent.usage.promptTokens, 50);
        assert.equal(usageEvent.usage.completionTokens, 7);
        assert.equal(usageEvent.usage.cachedTokens, 20);
        assert.equal(usageEvent.usage.cacheWriteTokens, 6, 'Responses cache writes are surfaced');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testToolOutputStreamsWhileRunning() {
    // A long tool (terminal command) can report progress before it returns;
    // those chunks must surface as toolOutput events, in order, before the
    // final toolResult.
    const responses = [
        sse(toolCallSse('run_terminal_command', JSON.stringify({ command: 'echo hi' }), 'call-1')),
        sse(textSse(['done'])),
    ];
    let index = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => responses[index++]) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                tools: [{ name: 'run_terminal_command', description: 'run', inputSchema: { type: 'object' } }],
            }), {
                execute: async (_call: any, onOutput?: (chunk: string) => void) => {
                    onOutput?.('line 1\n');
                    onOutput?.('line 2\n');
                    return { output: 'line 1\nline 2\n' };
                },
            }, {
                requestApproval: async () => ({}),
            })
        );

        const outputs = events.filter((e: any) => e.type === 'toolOutput').map((e: any) => e.value);
        assert.deepEqual(outputs, ['line 1\n', 'line 2\n']);
        const firstOutput = events.findIndex((e: any) => e.type === 'toolOutput');
        const resultIdx = events.findIndex((e: any) => e.type === 'toolResult');
        assert.ok(firstOutput >= 0 && firstOutput < resultIdx, 'toolOutput precedes toolResult');
        const result = events.find((e: any) => e.type === 'toolResult');
        assert.equal(result.output, 'line 1\nline 2\n');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testGoogleApiTextToolAndUsage() {
    const calls: Array<{ url: string; body: any; headers: any }> = [];
    const responses = [
        sse([
            `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }] } }] })}\n\n`,
            `data: ${JSON.stringify({ usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 4, totalTokenCount: 34, cachedContentTokenCount: 12 } })}\n\n`,
        ]),
        sse([
            `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] } }] })}\n\n`,
        ]),
    ];
    let index = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: init?.headers });
        return responses[index++];
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                apiStyle: 'google',
                model: 'gemini-3.8-flash',
                apiKey: 'g-key',
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                }],
            }), {
                execute: async () => ({ output: 'contents' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        assert.equal(
            calls[0].url,
            'http://127.0.0.1:11434/v1/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
        );
        assert.equal(calls[0].body.systemInstruction.parts[0].text, 'You are Xratu.');
        assert.equal(calls[0].body.tools[0].functionDeclarations[0].name, 'read_file');
        assert.equal((calls[0].headers as Headers).get('x-goog-api-key'), 'g-key');

        const call = events.find((e: any) => e.type === 'toolCall');
        assert.equal(call.tool, 'read_file');
        assert.deepEqual(call.args, { path: 'a.txt' });

        // The tool result comes back as a functionResponse matched by NAME.
        const responsePart = calls[1].body.contents
            .flatMap((c: any) => c.parts)
            .find((p: any) => p.functionResponse);
        assert.equal(responsePart.functionResponse.name, 'read_file');

        const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.value);
        assert.deepEqual(chunks, ['done']);
        const usageEvent = events.find((e: any) => e.type === 'usage' && !e.estimated);
        assert.equal(usageEvent.usage.promptTokens, 30);
        assert.equal(usageEvent.usage.cachedTokens, 12);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function deadConnection(): TypeError {
    // Exactly the shape undici produces when the response body dies mid-stream.
    return new TypeError('terminated', {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
}

async function testTransientStreamDropRetriesOnce() {
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        call++;
        if (call === 1) {
            // The connection dies before any SSE frame arrives.
            throw deadConnection();
        }
        return sse(textSse(['recovered']));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest(), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        assert.equal(call, 2, 'a transient pre-output drop retries exactly once');
        const retrying = events.find((e: any) => e.type === 'retrying');
        assert.ok(retrying, 'a retrying event drives the countdown UI');
        assert.equal(retrying.attempt, 1);
        assert.equal(retrying.maxAttempts, 4);
        assert.ok(retrying.nextRetryInMs > 0);
        assert.ok(events.some((e: any) => e.type === 'attempting'), 'the countdown is cleared before re-dialing');

        const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.value);
        assert.deepEqual(chunks, ['recovered']);
        assert.ok(events.some((e: any) => e.type === 'assistantMessage' && e.text === 'recovered'));
        // The retry re-sends the identical request shape.
        assert.equal(requests[1].stream, true);
        assert.deepEqual(requests[1].messages, requests[0].messages);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testNoRetryAfterOutputFlowed() {
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
        call++;
        const encoder = new TextEncoder();
        let reads = 0;
        return {
            ok: true,
            status: 200,
            body: new ReadableStream<Uint8Array>({
                pull(controller) {
                    reads++;
                    if (reads === 1) {
                        controller.enqueue(encoder.encode(
                            `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`,
                        ));
                        return;
                    }
                    // The socket dies AFTER content already reached the user.
                    controller.error(deadConnection());
                },
            }),
            text: async () => '',
        } as MockResponse;
    }) as typeof fetch;

    try {
        await assert.rejects(
            collect(
                runLocalAgent(baseRequest(), {
                    execute: async () => ({ output: '' }),
                }, {
                    requestApproval: async () => ({}),
                })
            ),
            // The error surfaces with its cause, not the bare word "terminated".
            /terminated.*other side closed/,
        );
        assert.equal(call, 1, 'mid-content drops are never retried (would duplicate streamed text)');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testWrapupRetriesTransientDrop() {
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
        call++;
        if (call === 1) {
            return sse(toolCallSse('read_file', JSON.stringify({ path: 'a.txt' }), 'call-1'));
        }
        if (call === 2) {
            // The wrap-up - which runs after all the work is done - drops.
            throw deadConnection();
        }
        return sse(textSse(['final answer']));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                maxRounds: 1,
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                }],
            }), {
                execute: async () => ({ output: 'contents' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        assert.equal(call, 3, 'the wrap-up retries a transient drop before giving up');
        assert.ok(events.some((e: any) => e.type === 'assistantMessage' && e.text === 'final answer'));
        assert.equal((events.at(-1) as any).type, 'status');
        assert.equal((events.at(-1) as any).value, 'done');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testCancelDuringRetryBackoffIsAbortError() {
    const originalFetch = globalThis.fetch;
    // Every attempt dies with a transient transport error.
    globalThis.fetch = (async () => { throw deadConnection(); }) as typeof fetch;
    const controller = new AbortController();
    // Cancel lands during the ~1s backoff, not during a fetch.
    const timer = setTimeout(() => controller.abort(), 200);

    try {
        await assert.rejects(
            collect(
                runLocalAgent(baseRequest({ signal: controller.signal }), {
                    execute: async () => ({ output: '' }),
                }, {
                    requestApproval: async () => ({}),
                })
            ),
            (err: any) => err?.name === 'AbortError',
            'a cancel during retry backoff surfaces as an AbortError, not a network error',
        );
    } finally {
        clearTimeout(timer);
        globalThis.fetch = originalFetch;
    }
}

async function testMessagesThinkingBudget() {
    const calls: any[] = [];
    const originalFetch = globalThis.fetch;
    const frames = [
        `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];
    globalThis.fetch = (async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return sse(frames);
    }) as typeof fetch;

    try {
        await collect(
            runLocalAgent(baseRequest({
                apiStyle: 'messages',
                model: 'claude-sonnet-5',
                apiKey: 'sk-test',
                reasoningEffort: 'high',
                maxTokens: 4096,
                temperature: 0.7,
                contextWindow: 200000,
            }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        assert.equal(calls[0].thinking.type, 'enabled', 'thinking block is sent');
        assert.equal(calls[0].thinking.budget_tokens, 24576, 'high level budget');
        assert.ok(calls[0].max_tokens > calls[0].thinking.budget_tokens, 'max_tokens must exceed the budget');
        assert.equal(calls[0].temperature, undefined, 'temperature is dropped when thinking is enabled');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testMessagesThinkingRejectedRetriesWithout() {
    const calls: any[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)));
        call++;
        if (call === 1) {
            return {
                ok: false,
                status: 400,
                text: async () => '{"error":"thinking is not supported for this model"}',
            } as MockResponse;
        }
        return sse([
            `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
        ]);
    }) as typeof fetch;

    try {
        await collect(
            runLocalAgent(baseRequest({
                apiStyle: 'messages',
                model: 'claude-sonnet-5',
                apiKey: 'sk-test',
                reasoningEffort: 'high',
                maxTokens: 2048,
                temperature: 0.3,
            }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        assert.equal(call, 2, 'retries once without thinking');
        assert.ok(calls[0].thinking, 'first request enables thinking');
        assert.equal(calls[1].thinking, undefined, 'retry drops the thinking block');
        // Dropping thinking must also undo the thinking-specific mutations:
        // the temperature it suppressed comes back, and the raised cap resets.
        assert.equal(calls[1].temperature, 0.3, 'temperature restored on retry');
        assert.equal(calls[1].max_tokens, 2048, 'explicit cap restored on retry');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testMaxOutputLimitLowersDerivedCap() {
    const calls: any[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return sse(textSse(['ok']));
    }) as typeof fetch;

    try {
        await collect(
            runLocalAgent(baseRequest({ contextWindow: 200000, maxOutputLimit: 2048 }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );
        // Without the limit the derived cap would be 16384.
        assert.equal(calls[0].max_tokens, 2048, 'provider max output lowers the derived cap');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testExplicitMaxTokensBeatsOutputLimit() {
    const calls: any[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return sse(textSse(['ok']));
    }) as typeof fetch;

    try {
        await collect(
            runLocalAgent(baseRequest({ contextWindow: 200000, maxTokens: 512, maxOutputLimit: 2048 }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );
        assert.equal(calls[0].max_tokens, 512, 'an explicit caller cap wins over the provider limit');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testChatReasoningEffortRejectedRetriesWithout() {
    const calls: any[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)));
        call++;
        if (call === 1) {
            return {
                ok: false,
                status: 400,
                text: async () => '{"error":"reasoning_effort is not supported by this model"}',
            } as MockResponse;
        }
        return sse(textSse(['ok']));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({ reasoningEffort: 'medium' }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        assert.equal(call, 2, 'retries once without reasoning_effort');
        assert.equal(calls[0].reasoning_effort, 'medium');
        assert.equal(calls[1].reasoning_effort, undefined);
        assert.ok(events.some((e: any) => e.type === 'assistantMessage'));
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testGoogleThinkingConfig() {
    const calls: any[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return sse([
            `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] })}\n\n`,
        ]);
    }) as typeof fetch;

    try {
        await collect(
            runLocalAgent(baseRequest({
                apiStyle: 'google',
                model: 'gemini-3.8-flash',
                apiKey: 'g-key',
                reasoningEffort: 'medium',
                contextWindow: 128000,
            }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        const config = calls[0].generationConfig;
        assert.equal(config.thinkingConfig.thinkingBudget, 8192, 'medium budget forwarded');
        assert.equal(config.thinkingConfig.includeThoughts, true, 'thoughts requested');
        assert.ok(config.maxOutputTokens > config.thinkingConfig.thinkingBudget, 'output cap clears the budget');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testGoogleThinkingRejectedRestoresCap() {
    const calls: any[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)));
        call++;
        if (call === 1) {
            return {
                ok: false,
                status: 400,
                text: async () => '{"error":"thinkingConfig is not supported by this model"}',
            } as MockResponse;
        }
        return sse([
            `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] })}\n\n`,
        ]);
    }) as typeof fetch;

    try {
        await collect(
            runLocalAgent(baseRequest({
                apiStyle: 'google',
                model: 'gemini-3.8-flash',
                apiKey: 'g-key',
                reasoningEffort: 'high',
                contextWindow: 200000,
            }), {
                execute: async () => ({ output: '' }),
            }, {
                requestApproval: async () => ({}),
            })
        );

        // derived cap is 16384; high budget 24576 raises it to 28672.
        assert.equal(calls[0].generationConfig.thinkingConfig.thinkingBudget, 24576);
        assert.equal(calls[0].generationConfig.maxOutputTokens, 28672, 'cap raised for the budget');
        assert.equal(calls[1].generationConfig.thinkingConfig, undefined, 'thinkingConfig dropped');
        assert.equal(calls[1].generationConfig.maxOutputTokens, 16384, 'cap restored after drop');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testPromptCacheKeyRoutesOpenAiHosts() {
    // Rationale: OpenAI routes a request to a cache machine by hashing the
    // initial tokens plus `prompt_cache_key`; a stable per-conversation key
    // raises the cache hit rate for pre-GPT-5.6 models. It must NOT be sent to
    // arbitrary OpenAI-compatible runtimes (strict servers 400 on it).
    const calls: any[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return sse(textSse(['ok']));
    }) as typeof fetch;

    try {
        await collect(runLocalAgent(baseRequest({
            baseUrl: 'https://opencode.ai/zen/v1',
            model: 'glm-5',
            sessionId: 'sess-42',
        }), { execute: async () => ({ output: '' }) }, { requestApproval: async () => ({}) }));
        assert.equal(calls[0].prompt_cache_key, 'sess-42', 'stable per-session cache key is sent on an OpenAI-family host');
    } finally {
        globalThis.fetch = originalFetch;
    }

    const localCalls: any[] = [];
    globalThis.fetch = (async (_input, init) => {
        localCalls.push(JSON.parse(String(init?.body)));
        return sse(textSse(['ok']));
    }) as typeof fetch;
    try {
        await collect(runLocalAgent(baseRequest({ sessionId: 'sess-42' }), {
            execute: async () => ({ output: '' }),
        }, { requestApproval: async () => ({}) }));
        assert.equal(localCalls[0].prompt_cache_key, undefined, 'no cache key for a generic local runtime');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testPromptCacheKeyRejectedIsDropped() {
    const calls: any[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)));
        if (calls.length === 1) {
            return {
                ok: false,
                status: 400,
                text: async () => '{"error":{"message":"prompt_cache_key is not supported by this deployment"}}',
            } as MockResponse;
        }
        return sse(textSse(['ok']));
    }) as typeof fetch;

    try {
        const events = await collect(runLocalAgent(baseRequest({
            baseUrl: 'https://opencode.ai/zen/v1',
            model: 'glm-5',
            sessionId: 'sess-42',
        }), { execute: async () => ({ output: '' }) }, { requestApproval: async () => ({}) }));

        assert.equal(calls.length, 2, 'exactly one retry without the key');
        assert.equal(calls[0].prompt_cache_key, 'sess-42');
        assert.equal(calls[1].prompt_cache_key, undefined, 'key dropped after a 400 that rejects it');
        assert.ok(events.some((e: any) => e.type === 'assistantMessage'));
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testWrapupPreservesMessagesCacheBreakpoints() {
    // The wrap-up runs at peak context, so its cached prefix (tools + system +
    // history) must stay byte-identical: forbid tool CALLS, never drop the
    // definitions, and carry the nudge in the volatile tail note.
    const calls: any[] = [];
    const responses = [
        sse([
            `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
        ]),
        sse([
            `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })}\n\n`,
            `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'summary' } })}\n\n`,
        ]),
    ];
    let index = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return responses[index++];
    }) as typeof fetch;

    try {
        await collect(runLocalAgent(baseRequest({
            apiStyle: 'messages',
            model: 'claude-sonnet-5',
            maxRounds: 1,
            tools: [{
                name: 'read_file',
                description: 'Read a file',
                inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            }],
        }), { execute: async () => ({ output: 'contents' }) }, { requestApproval: async () => ({}) }));

        assert.equal(calls.length, 2, 'one budgeted round + one wrap-up');
        const wrap = calls[1];
        assert.deepEqual(wrap.tools, calls[0].tools, 'tool definitions stay byte-identical');
        assert.deepEqual(wrap.tool_choice, { type: 'none' }, 'calls forbidden; definitions kept');
        assert.equal(wrap.system[0].cache_control.type, 'ephemeral', 'system cache breakpoint intact');
        assert.equal(wrap.messages[0].content[0].text, calls[0].messages[0].content[0].text, 'history prefix unchanged');
        const lastTurn = wrap.messages[wrap.messages.length - 1];
        const note = lastTurn.content[lastTurn.content.length - 1];
        assert.ok(String(note.text).includes('ROUND LIMIT REACHED'), 'nudge rides the tail note');
        assert.equal(note.cache_control, undefined, 'nudge is never cached');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testWrapupFallsBackWhenToolChoiceRejected() {
    // Gateways without a tool-choice control must still get a tool-free
    // wrap-up: the transport retries with the definitions dropped too.
    const calls: any[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)));
        call++;
        if (call === 1) {
            return sse(toolCallSse('read_file', JSON.stringify({ path: 'a.txt' }), 'call-1'));
        }
        if (call === 2) {
            return {
                ok: false,
                status: 400,
                text: async () => '{"error":"tool_choice is not supported by this gateway"}',
            } as MockResponse;
        }
        return sse(textSse(['fallback answer']));
    }) as typeof fetch;

    try {
        const events = await collect(
            runLocalAgent(baseRequest({
                maxRounds: 1,
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                }],
            }), { execute: async () => ({ output: 'contents' }) }, { requestApproval: async () => ({}) })
        );

        assert.equal(calls.length, 3, 'wrap-up retried without the tool-choice control');
        assert.equal(calls[1].tool_choice, 'none');
        assert.equal(calls[2].tool_choice, undefined, 'tool_choice dropped');
        assert.equal(calls[2].tools, undefined, 'definitions dropped as the fallback');
        assert.ok(events.some((e: any) => e.type === 'assistantMessage' && e.text === 'fallback answer'));
        assert.equal((events.at(-1) as any).type, 'status');
        assert.equal((events.at(-1) as any).value, 'done');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function main() {
    await testMessagesApiTextThinkingAndUsage();
    await testMessagesApiToolUse();
    await testResponsesApiTextToolAndUsage();
    await testToolOutputStreamsWhileRunning();
    await testGoogleApiTextToolAndUsage();
    await testStreamingDeltas();
    await testStreamOptionsRejectedRetriesWithout();
    await testNonStreamOptions400DoesNotRetry();
    await testTransientStreamDropRetriesOnce();
    await testNoRetryAfterOutputFlowed();
    await testWrapupRetriesTransientDrop();
    await testCancelDuringRetryBackoffIsAbortError();
    await testCachedTokensParsed();
    await testChatCacheWriteTokensParsed();
    await testReasoningStreamsAsCumulativeThinking();
    await testToolCallApprovalAndContinuation();
    await testDeniedToolProducesToolResultAndContinues();
    await testImageIsCurrentTurnOnly();
    await testAttachmentOnlyTurnGetsPlaceholderText();
    await testImageFormatRetryOnLmStudioStyle400();
    await testNon2xxFailsClearly();
    await testFinalAnswerIsEmittedForHistory();
    await testHistoryKeepsRawTurnStructure();
    await testContextStatusRidesTheTailNotTheSystemPrompt();
    await testSystemPromptStaysStableAcrossRounds();
    await testPromptCacheKeyRoutesOpenAiHosts();
    await testPromptCacheKeyRejectedIsDropped();
    await testWrapupPreservesMessagesCacheBreakpoints();
    await testWrapupFallsBackWhenToolChoiceRejected();
    await testProactiveCompactDropsOldTurnsAtStart();
    await testMidRunCompactionFromServerUsage();
    await testSteerJoinsBeforeNextRound();
    await testRoundBudgetEndsWithWrapupInsteadOfError();
    await testWrapupToolCallIsIgnored();
    await testWrapupRequestFailureStillErrors();
    await testWrapupWithoutTextEmitsFallback();
    await testWrapupReasoningIsForwarded();
    await testWrapupOverflowCompactsAndRetries();
    await testMessagesThinkingBudget();
    await testMessagesThinkingRejectedRetriesWithout();
    await testMaxOutputLimitLowersDerivedCap();
    await testExplicitMaxTokensBeatsOutputLimit();
    await testChatReasoningEffortRejectedRetriesWithout();
    await testGoogleThinkingConfig();
    await testGoogleThinkingRejectedRestoresCap();

    console.log('local-agent.test.ts: all tests passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
