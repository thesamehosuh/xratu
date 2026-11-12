/** Application-level validation for model SSE data. Unknown event types and
 *  fields remain forward-compatible; known fields cannot silently lose calls. */
export type ModelStreamErrorKey = 'modelStreamInvalid' | 'modelStreamIncomplete' | 'modelStreamTooLarge';

export class ModelStreamError extends Error {
    constructor(message: string, readonly valueKey: ModelStreamErrorKey = 'modelStreamInvalid') {
        super(message);
        this.name = 'ModelStreamError';
    }
}

/** Host-generated errors are localized even when optional provider-error
 *  explanations are disabled. Raw provider messages still use that setting. */
export function modelStreamErrorMessage(error: unknown): { type: 'error'; valueKey: ModelStreamErrorKey } | undefined {
    return error instanceof ModelStreamError ? { type: 'error', valueKey: error.valueKey } : undefined;
}

type Json = Record<string, unknown>;
function invalid(field: string): never {
    throw new ModelStreamError(`Model returned an invalid stream event (${field}); the batch was not executed.`);
}
function object(value: unknown, field: string): Json {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
    return value as Json;
}
function array(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value)) invalid(field);
    return value;
}
function text(value: unknown, field: string, nonempty = false): string {
    if (typeof value !== 'string' || (nonempty && !value)) invalid(field);
    return value;
}
function optionalText(value: unknown, field: string): void {
    if (value != null) text(value, field);
}
function optionalObject(value: unknown, field: string): void {
    if (value != null) object(value, field);
}
export function streamIndex(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('output/block index');
    return value;
}

function responseItem(value: unknown, final: boolean): void {
    const item = object(value, 'response item');
    text(item.type, 'response item type', true);
    if (item.id !== undefined) text(item.id, 'response item identity', true);
    if (item.type === 'function_call') {
        text(item.id ?? item.call_id, 'tool call identity', true);
        if (item.call_id !== undefined) text(item.call_id, 'tool call identity', true);
        text(item.name, 'tool name', true);
        if (final || item.arguments !== undefined) text(item.arguments, 'tool arguments');
    } else if (item.type === 'message' && item.content !== undefined) {
        for (const raw of array(item.content, 'message content')) {
            const block = object(raw, 'message content block');
            if (block.type === 'output_text') text(block.text, 'output text');
            if (block.type === 'refusal') text(block.refusal, 'refusal text');
        }
    }
}

export function validateStreamEvent(style: 'chat' | 'messages' | 'responses' | 'google', value: unknown): void {
    const event = object(value, 'event');
    optionalObject(event.error, 'error');
    if (style === 'chat') {
        if (!('choices' in event) && !('usage' in event) && !event.error) invalid('Chat envelope');
        optionalObject(event.usage, 'usage');
        if (event.choices !== undefined) for (const raw of array(event.choices, 'choices')) {
            const choice = object(raw, 'choice');
            if (choice.index !== undefined) streamIndex(choice.index);
            optionalText(choice.finish_reason, 'finish reason');
            if (choice.delta == null) {
                if (!choice.finish_reason) invalid('choice delta');
                continue;
            }
            const delta = object(choice.delta, 'choice delta');
            for (const key of ['content', 'reasoning_content', 'reasoning']) optionalText(delta[key], key);
            if (delta.tool_calls !== undefined) for (const rawCall of array(delta.tool_calls, 'tool_calls')) {
                const call = object(rawCall, 'tool call');
                if (call.index !== undefined) streamIndex(call.index);
                if (call.id !== undefined) text(call.id, 'tool call identity', true);
                if (call.function !== undefined) {
                    const fn = object(call.function, 'tool function');
                    optionalText(fn.name, 'tool name');
                    if (fn.arguments !== undefined && typeof fn.arguments !== 'string') object(fn.arguments, 'tool arguments');
                }
            }
        }
        return;
    }
    if (style === 'messages') {
        text(event.type, 'Messages event type', true);
        if (event.type === 'message_start') optionalObject(object(event.message, 'message').usage, 'message usage');
        if (event.type === 'content_block_start') {
            streamIndex(event.index);
            const block = object(event.content_block, 'content block');
            text(block.type, 'content block type', true);
            if (block.type === 'tool_use') {
                text(block.id, 'tool call identity', true);
                text(block.name, 'tool name', true);
                if (block.input !== undefined) object(block.input, 'initial tool input');
            }
        }
        if (event.type === 'content_block_delta') {
            streamIndex(event.index);
            const delta = object(event.delta, 'content block delta');
            text(delta.type, 'delta type', true);
            const fields: Record<string, string> = { text_delta: 'text', thinking_delta: 'thinking', signature_delta: 'signature', input_json_delta: 'partial_json' };
            const field = fields[String(delta.type)];
            if (field) text(delta[field], field);
        }
        if (event.type === 'content_block_stop') streamIndex(event.index);
        if (event.type === 'message_delta') {
            if (event.delta === undefined && event.usage === undefined) invalid('message delta');
            optionalObject(event.delta, 'message delta');
            optionalObject(event.usage, 'message usage');
            if (event.delta) optionalText(object(event.delta, 'message delta').stop_reason, 'stop reason');
        }
        return;
    }
    if (style === 'responses') {
        text(event.type, 'Responses event type', true);
        if (event.output_index !== undefined) streamIndex(event.output_index);
        if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
            streamIndex(event.output_index);
            responseItem(event.item, event.type === 'response.output_item.done');
        }
        if (['response.output_text.delta', 'response.refusal.delta', 'response.reasoning_summary_text.delta', 'response.reasoning_text.delta', 'response.function_call_arguments.delta'].includes(String(event.type))) text(event.delta, 'response delta');
        if (event.type === 'response.function_call_arguments.delta' || event.type === 'response.function_call_arguments.done') {
            text(event.item_id, 'argument item identity', true);
            if (event.type.endsWith('.done')) text(event.arguments, 'final tool arguments');
        }
        if (event.type === 'response.completed') {
            const response = object(event.response, 'completed response');
            if (response.status !== undefined && response.status !== 'completed') invalid('completed response status');
            optionalObject(response.usage, 'response usage');
            if (response.output !== undefined) for (const item of array(response.output, 'completed output')) responseItem(item, true);
        }
        return;
    }
    if (!('candidates' in event) && !('usageMetadata' in event) && !('promptFeedback' in event) && !event.error) invalid('Google envelope');
    optionalObject(event.usageMetadata, 'usage metadata');
    optionalObject(event.promptFeedback, 'prompt feedback');
    if (event.candidates !== undefined) for (const raw of array(event.candidates, 'candidates')) {
        const candidate = object(raw, 'candidate');
        if (candidate.index !== undefined) streamIndex(candidate.index);
        optionalText(candidate.finishReason, 'finish reason');
        if (candidate.content != null) {
            const content = object(candidate.content, 'candidate content');
            for (const rawPart of array(content.parts, 'candidate parts')) {
                const part = object(rawPart, 'candidate part');
                if (part.text !== undefined) text(part.text, 'part text');
                if (part.thought !== undefined && typeof part.thought !== 'boolean') invalid('thought flag');
                if (part.text && part.functionCall !== undefined) invalid('conflicting Google part fields');
                if (part.functionCall !== undefined) {
                    const call = object(part.functionCall, 'function call');
                    text(call.name, 'tool name', true);
                    if (call.id !== undefined) text(call.id, 'tool call identity', true);
                    if (call.args !== undefined) object(call.args, 'tool arguments');
                }
            }
        }
    }
}
