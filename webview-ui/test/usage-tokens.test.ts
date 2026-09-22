import assert from 'node:assert/strict';
import { totalTokens, uncachedInput } from '../src/usageTokens';

// The ledger stores `input` as the FULL prompt and `cached` as a subset of it.
// The real all-time numbers from an OpenCode Go / deepseek-v4.1-flash ledger:
const input = 7_490_709;
const output = 139_861;
const cached = 6_984_576;

// Regression: the Usage page used to show `input` as "Input" and sum
// input + output + cached, so the cache hits were counted twice and the billed
// input looked ~15x larger than it is.
assert.equal(uncachedInput(input, cached), 506_133, 'Input must be the uncached prompt');
assert.equal(totalTokens({ input, output }), 7_630_570, 'total must not re-add cached');
assert.notEqual(totalTokens({ input, output }), input + output + cached, 'total must not double-count cached');

// Guard rails.
assert.equal(uncachedInput(100, 0), 100, 'no cache -> all input is uncached');
assert.equal(uncachedInput(100, 100), 0, 'fully cached -> no uncached input');
assert.equal(uncachedInput(10, 999), 0, 'a cached count above input must not go negative');
assert.equal(totalTokens({ input: 0, output: 0 }), 0);

console.log('usage-tokens.test.ts: all tests passed');
