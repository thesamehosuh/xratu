import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { requestStreamingCompletion } = require('../out/local/wireAdapters.js');
const originalFetch = globalThis.fetch;
const request = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiStyle: 'responses', systemPrompt: 'S', tools: [] };
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' };
const added = { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } };
async function read(events, options = {}, messages = [{ role: 'user', content: 'Read the file' }]) {
    let body;
    globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }); };
    const deltas = [];
    const result = await requestStreamingCompletion({ ...request, ...options }, messages, '', value => deltas.push(value));
    return { result, deltas, body };
}
try {
    for (const finalization of [
        [{ type: 'response.function_call_arguments.done', item_id: call.id, output_index: 0, arguments: call.arguments }, { type: 'response.completed', response: {} }],
        [{ type: 'response.output_item.done', output_index: 0, item: call }, { type: 'response.completed', response: {} }],
        [{ type: 'response.completed', response: { output: [call] } }],
    ]) {
        const { result } = await read([added, { type: 'response.function_call_arguments.delta', item_id: call.id, delta: '{"path":' }, ...finalization]);
        assert.deepEqual(result.toolCalls[0].arguments, { path: 'README.md' });
        assert.equal(result.toolCalls[0].argumentsJson, call.arguments);
        assert.equal(result.providerBlocks[0].arguments, call.arguments, 'execution and replay use the same finalized arguments');
    }
    const completedOnly = await read([{ type: 'response.completed', response: { output: [call] } }]);
    assert.equal(completedOnly.result.toolCalls.length, 1, 'completed output can recover a coalesced tool call');
    await assert.rejects(read([added, { type: 'response.function_call_arguments.delta', item_id: call.id, delta: call.arguments }]), /without response.completed/, 'an unfinished Responses stream cannot authorize tool execution');
    const cancelledCall = await read([added, { type: 'response.completed', response: { output: [] } }]);
    assert.equal(cancelledCall.result.toolCalls.length, 0, 'a partial call omitted from completed output must not execute');
    for (const content of [[{ type: 'output_text', text: 'Final text' }], [{ type: 'refusal', refusal: 'Cannot complete this request' }]]) {
        const { result, deltas } = await read([{ type: 'response.completed', response: { output: [{ type: 'message', content }] } }]);
        const expected = content[0].text ?? content[0].refusal;
        assert.equal(result.text, expected); assert.equal(deltas.join(''), expected);
    }
    const chatEvents = [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }];
    const direct = await read(chatEvents, { apiStyle: 'chat', baseUrl: 'https://api.openai.com/v1', maxTokens: 321 });
    assert.equal(direct.body.max_completion_tokens, 321);
    assert.equal(direct.body.max_tokens, undefined);
    const bodies = [];
    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body); bodies.push(body);
        return body.max_tokens != null
            ? new Response('Unsupported parameter: max_tokens; use max_completion_tokens', { status: 400 })
            : new Response(chatEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    };
    await requestStreamingCompletion({ ...request, apiStyle: 'chat', maxTokens: 321 }, [{ role: 'user', content: 'Hi' }], '', () => {});
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].max_completion_tokens, 321, 'a gateway cap alias preserves the explicit budget');

    const foreign = {
        responses: [{ type: 'reasoning', encrypted_content: 'FOREIGN_REASONING' }],
        messages: [{ type: 'thinking', thinking: 'FOREIGN_REASONING', signature: 'signature' }],
        google: [{ text: 'FOREIGN_REASONING', thoughtSignature: 'signature' }],
    };
    for (const style of ['messages', 'responses', 'google']) for (const source of Object.keys(foreign)) {
        if (style === source) continue;
        const events = style === 'messages' ? [{ type: 'message_stop' }] : style === 'responses'
            ? [{ type: 'response.completed', response: { output: [] } }]
            : [{ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }];
        const { body } = await read(events, { apiStyle: style }, [{ role: 'user', content: 'Earlier request' }, {
            role: 'assistant', content: 'Portable answer', providerBlocks: foreign[source],
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: call.arguments } }],
        }, { role: 'tool', tool_call_id: 'call_1', content: 'File output' }, { role: 'user', content: 'Continue' }]);
        assert.ok(!JSON.stringify(body).includes('FOREIGN_REASONING'), `${source} carriers must not reach the ${style} API`);
        assert.ok(JSON.stringify(body).includes('Portable answer'));
        assert.ok(JSON.stringify(body).includes('File output'));
    }
    const googlePart = { functionCall: { id: 'native-google-id', name: 'read_file', args: { path: 'README.md' } }, thoughtSignature: 'native-signature' };
    const google = await read([{ candidates: [{ content: { parts: [googlePart] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 100, totalTokenCount: 113 } }], { apiStyle: 'google' });
    assert.equal(google.result.usage.completionTokens, 103, 'Google thought tokens count as output tokens');
    assert.equal(google.result.toolCalls[0].id, 'native-google-id');
    const googleReply = await read([{ candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] }], { apiStyle: 'google' }, [
        { role: 'user', content: 'Read' }, { role: 'assistant', content: '', providerBlocks: [googlePart],
            tool_calls: [{ id: 'native-google-id', type: 'function', function: { name: 'read_file', arguments: call.arguments } }] },
        { role: 'tool', tool_call_id: 'native-google-id', content: 'File output' },
    ]);
    const reply = googleReply.body.contents.flatMap(content => content.parts).find(part => part.functionResponse).functionResponse;
    assert.equal(reply.id, 'native-google-id', 'function responses preserve provider-issued call identity');
    console.log('wire-protocols: finalized calls, budget aliases, foreign carriers, Google reasoning usage and native call IDs passed');
} finally { globalThis.fetch = originalFetch; }
