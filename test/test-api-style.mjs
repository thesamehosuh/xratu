#!/usr/bin/env node
/**
 * API-style routing tests.
 *
 * OpenCode Zen/Go serve most models over OpenAI chat/completions but route
 * some families to the Anthropic Messages API (/messages) or the OpenAI
 * Responses API (/responses) on the SAME base URL. The model id decides; the
 * base URL alone cannot. Everywhere else must stay `chat` (e.g. OpenRouter
 * serves Claude over /chat/completions).
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-api-style.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { resolveApiStyle, isOpenCodeHost } = require('../out/local/apiStyle.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const ZEN = 'https://opencode.ai/zen/v1';
const GO = 'https://opencode.ai/zen/go/v1';

check('opencode host detected', isOpenCodeHost(ZEN), true);
check('opencode subdomain detected', isOpenCodeHost('https://api.opencode.ai/zen/v1'), true);
check('non-opencode host', isOpenCodeHost('https://openrouter.ai/api/v1'), false);
// An explicit port must not defeat the host match.
check('opencode host with port', isOpenCodeHost('https://opencode.ai:8443/zen/v1'), true);
check('messages with explicit port', resolveApiStyle('https://opencode.ai:8443/zen/go/v1', 'claude-sonnet-5'), 'messages');

// Messages families
for (const model of ['claude-sonnet-5', 'claude-opus-4-8', 'qwen3.8-flash', 'qwen3.7-max', 'minimax-m3', 'minimax-m2.7']) {
    check(`messages: ${model}`, resolveApiStyle(GO, model), 'messages');
}

// Responses families
for (const model of ['gpt-5.6-luna', 'gpt-6-astra', 'grok-4.6', 'muse-spark-1.3-contributor']) {
    check(`responses: ${model}`, resolveApiStyle(GO, model), 'responses');
}

// chat/completions families
for (const model of ['glm-5.3', 'glm-5.3-flash', 'kimi-k3', 'kimi-k2.7-code', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'mimo-v2.5', 'mimo-v2.5-pro', 'longcat-2.0', 'hy3', 'big-pickle', 'ling-3.0-flash-fin-free', 'nemotron-3.5-lightning-free']) {
    check(`chat: ${model}`, resolveApiStyle(GO, model), 'chat');
}

// Same routing on Zen
check('zen claude -> messages', resolveApiStyle(ZEN, 'claude-fable-5-1'), 'messages');
check('zen gpt -> responses', resolveApiStyle(ZEN, 'gpt-5.5'), 'responses');
check('zen glm -> chat', resolveApiStyle(ZEN, 'glm-5.3'), 'chat');

// Non-OpenCode hosts never switch API, even for the same model ids
check('openrouter claude stays chat', resolveApiStyle('https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4.5'), 'chat');
check('anthropic-native base stays chat', resolveApiStyle('https://api.anthropic.com/v1', 'claude-sonnet-5'), 'chat');
check('local runtime stays chat', resolveApiStyle('http://127.0.0.1:11434/v1', 'qwen3:8b'), 'chat');

// Case-insensitive model id
check('model id case-insensitive', resolveApiStyle(GO, 'Claude-Sonnet-5'), 'messages');

console.log(failed === 0 ? '\napi-style: all tests passed' : `\napi-style: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
