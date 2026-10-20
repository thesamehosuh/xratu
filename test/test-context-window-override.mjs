import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const cls = file.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'XratuChatViewProvider');
const names = ['_setContextWindowOverride', '_contextWindowHint', '_modelContextWindowMax'];
const methods = cls.members.filter(node => node.name && names.includes(node.name.getText(file))).map(node => node.getText(file)).join('\n');
const compiled = ts.transpile(`class Subject { ${methods} }; Subject`, { target: ts.ScriptTarget.ES2022 });
const Subject = vm.runInNewContext(compiled, {
    baseUrlHost: () => 'provider', modelsDevModelInfo: () => undefined, providerIdForUrl: () => 'provider',
    cachedModelInfo: () => undefined, knownContextWindow: () => 128000,
});
const subject = new Subject();
let overrides = { coder: 1048576 };
subject._selectedModel = 'coder';
subject._contextWindowOverrides = () => ({ ...overrides });
subject._contextWindowsFor = () => ({ coder: 32768 });
subject._globalState = { update: async (_key, value) => { overrides = JSON.parse(value); } };
assert.equal(subject._contextWindowHint(), 32768, 'oversized saved overrides must be capped at runtime');
await subject._setContextWindowOverride('coder', 1048576);
assert.equal(overrides.coder, 32768, 'new overrides are capped before persistence');
await subject._setContextWindowOverride('coder', 16384);
assert.equal(subject._contextWindowHint(), 16384);
subject._activeEngine = 'opencode'; subject._nativeModelWindows = { coder: 8192 };
assert.equal(subject._contextWindowHint(), 8192, 'native limits also cap saved overrides');
await subject._setContextWindowOverride('coder', null);
assert.equal(subject._contextWindowHint(), 8192);
await subject._setContextWindowOverride('coder', Infinity);
assert.equal(overrides.coder, undefined);
console.log('context-window override caps passed');
