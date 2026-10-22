/** Provider cache boundaries are not the same thing as matching JSON bytes.
 * Retain recent lookup boundaries when tool batches or steers move the end of
 * the conversation forward. Status notes themselves are replay carriers. */
import { isOpenCodeHost, supportsPromptCacheKey } from './apiStyle';
import { createHash } from 'crypto';
import { isChatGptSubscriptionHost } from '../providerIdentity';
import type { LocalAgentRequest } from './localTypes';

type Block = Record<string, unknown>;
type Message = Block & { content?: Block[]; output?: string | Block[] };
type CacheState = NonNullable<LocalAgentRequest['promptCacheState']>;
type Boundary = { message: number; block: number; value: Block };

function blocksOf(message?: Message): Block[] {
    const blocks = message?.type === 'function_call_output' ? message.output : message?.content;
    return Array.isArray(blocks) ? blocks : [];
}

/** Preserve the previous WRITE endpoint explicitly, even if several steers
 * or a large tool batch have pushed it outside a provider's lookback window.
 * A content-block boundary survives additions to the same user message.
 * Keep only a hash and indexes; never another copy of tool output. */
function selectBoundaries(messages: Message[], candidates: Boundary[], state: CacheState): Boundary[] {
    const hash = (block: Block): string => createHash('sha256').update(JSON.stringify(block)).digest('hex');
    const previous = state.boundary;
    const block = previous && blocksOf(messages[previous.message])[previous.block];
    const retained = block && hash(block) === previous.hash
        ? { message: previous.message, block: previous.block, value: block } : undefined;
    const selected = candidates.slice(retained ? -2 : -3);
    if (retained && !selected.some(point => point.value === retained.value)) selected.push(retained);
    const latest = candidates[candidates.length - 1];
    state.boundary = latest ? { message: latest.message, block: latest.block, hash: hash(latest.value) } : undefined;
    return selected;
}

/** New Responses cache controls are not part of the generic compatible API.
 * Unknown gateways and older models must keep their existing wire format. */
export function usesResponsesCacheBreakpoints(request: LocalAgentRequest): boolean {
    const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/i.exec(request.model);
    const modern = match && (Number(match[1]) >= 6 || (Number(match[1]) === 5 && Number(match[2]) >= 6));
    return !!modern && !isChatGptSubscriptionHost(request.baseUrl) && !request.promptCacheState?.disabled && (request.subscription === true
        || (supportsPromptCacheKey(request.baseUrl) && !isOpenCodeHost(request.baseUrl)));
}

/** These model families document persisted reasoning. Coding/tool loops need
 * the same rendered reasoning history on continuation, as Codex itself sends.
 * Keep this off arbitrary compatible providers and unsupported older models. */
export function supportsAllTurnsReasoning(request: LocalAgentRequest): boolean {
    return /^gpt-(?:5\.6(?:-|$)|6\.1-sol(?:-|$))/i.test(request.model)
        && (request.subscription === true || isChatGptSubscriptionHost(request.baseUrl)
            || (supportsPromptCacheKey(request.baseUrl) && !isOpenCodeHost(request.baseUrl)));
}

export function usesAllTurnsReasoning(request: LocalAgentRequest): boolean {
    return !request.promptCacheState?.reasoningContextDisabled && supportsAllTurnsReasoning(request);
}

/** At most four writes: instructions plus the last three reusable message
 * endings. A tool batch has ONE ending, regardless of its number of results.
 * Convert all text outputs consistently, so advancing a marker never changes
 * an older result between string and block form. Input objects are wire-owned. */
export function markResponsesCache(input: Message[], instructions: string, state: CacheState): void {
    const candidates: Boundary[] = [];
    for (let i = 0; i < input.length; i++) {
        const item = input[i];
        if (item.type === 'function_call_output') {
            if (typeof item.output === 'string') item.output = [{ type: 'input_text', text: item.output }];
            if (input[i + 1]?.type === 'function_call_output') continue;
            const blocks = item.output;
            if (Array.isArray(blocks) && blocks.length) candidates.push({ message: i, block: blocks.length - 1, value: blocks[blocks.length - 1] });
        } else if (item.role === 'user' && item.content?.length) {
            const last = item.content[item.content.length - 1];
            if (last.type === 'input_text') candidates.push({ message: i, block: item.content.length - 1, value: last });
        }
    }
    for (const point of selectBoundaries(input, candidates, state)) point.value.prompt_cache_breakpoint = { mode: 'explicit' };
    if (instructions) input.unshift({ role: 'developer', content: [{
        type: 'input_text', text: instructions, prompt_cache_breakpoint: { mode: 'explicit' },
    }] });
}

/** Anthropic looks back only 20 blocks from a breakpoint. Keep recent user
 * message endings explicit so a large new batch can still find the old write.
 * The caller owns the arrays; replacing a block must not edit replay carriers. */
export function markMessagesCache(messages: Message[], state: CacheState): void {
    const candidates: Boundary[] = [];
    for (const [i, message] of messages.entries()) {
        if (message.role === 'user' && message.content?.length) {
            const last = message.content.length - 1;
            candidates.push({ message: i, block: last, value: message.content[last] });
        }
    }
    for (const point of selectBoundaries(messages, candidates, state)) {
        messages[point.message].content![point.block] = { ...point.value, cache_control: { type: 'ephemeral' } };
    }
}
