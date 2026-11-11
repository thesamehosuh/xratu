import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const pricing = require('../out/pricing.js');
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const cls = file.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'XratuChatViewProvider');
const names = ['_costFor', '_localCostFor', '_setCostCurrencyFor', '_addUsage', '_handleLocalAgentEvent', '_addSessionUsage', '_postSessionCost', '_sessionCostForRun'];
const sandbox = { ...pricing, baseUrlHost: require('../out/providerIdentity.js').baseUrlHost };
vm.runInNewContext(ts.transpileModule(`class Host { ${cls.members.filter(node => names.includes(node.name?.getText(file))).map(node => node.getText(file)).join('\n')} }; globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
const host = new sandbox.Host(), records = [], messages = [];
Object.assign(host, { _sessionId: 'session', _localRunActive: true, _runModel: 'parent', _selectedModel: 'picker', _runBaseUrl: 'https://provider.test/v1',
    _runNativeProvider: null, _runSubscription: false, _runCostCurrency: 'USD', _sessionCost: { USD: 0, IRT: 0 }, _localTurnUsage: null,
    _localTurnCost: { USD: 0, IRT: 0 }, _localTurnCostKnown: true, _sessionUsage: { input: 0, output: 0, cached: 0 }, _sessionUsageByHost: {},
    _modelPriceOverrides: () => ({ parent: { input: 10, output: 20 }, child: { input: 1, output: 2 }, picker: { input: 100, output: 200 } }),
    _priceLookupFor: () => ({ host: 'provider.test', iranian: false }), _scheduleLocalPartialPersist: () => {},
    _recordUsage: async entry => { records.push(entry); }, _view: { webview: { postMessage: message => messages.push(message) } } });
const usage = (input, output) => ({ promptTokens: input, completionTokens: output, totalTokens: input + output });
const parent = usage(1_000_000, 1_000_000);
host._handleLocalAgentEvent({ type: 'usage', usage: parent }, {});
host._handleLocalAgentEvent({ type: 'usage', usage: usage(2_000_000, 1_000_000), model: 'child', source: 'subagent' }, {});
host._handleLocalAgentEvent({ type: 'usage', usage: usage(100_000, 100_000), model: 'parent', source: 'compaction' }, {});
assert.deepEqual(records.map(entry => entry.model), ['parent', 'child', 'parent']);
assert.deepEqual(records.map(entry => entry.amount), [30, 4, 3]);
assert.equal(host._sessionCost.USD, 37);
assert.equal(host._localCostFor(host._localTurnUsage).amount, 37, 'mixed-model turn cost is the sum of actual per-model charges');
assert.equal(host._localCurrentUsage, parent, 'child and summary requests must not replace the parent context meter');
assert.equal(messages.filter(message => message.type === 'usage').length, 1);
assert.equal(host._sessionUsage.input, 3_100_000);
assert.equal(host._sessionUsage.output, 2_100_000);
host._setCostCurrencyFor('https://other-provider.test/v1');
assert.equal(host._runBaseUrl, 'https://provider.test/v1', 'changing the picker cannot retarget an active run billing identity');
host._handleLocalAgentEvent({ type: 'usage', usage: usage(10, 10), model: 'unpriced-child', source: 'subagent' }, {});
assert.equal(host._localCostFor(host._localTurnUsage), null, 'unknown child pricing cannot be presented as a complete turn total');
console.log('usage-provenance: captured model, per-child rates, summary spend, context isolation and unknown pricing passed');
