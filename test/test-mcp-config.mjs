#!/usr/bin/env node
// Run after `npx tsc -p . --outDir out`.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, Module } from 'node:module';

const require = createRequire(import.meta.url);
let legacy;
const workspace = {
    isTrusted: true,
    getConfiguration: () => ({ get: () => legacy }),
};
const originalLoad = Module._load;
Module._load = function (name, ...args) {
    if (name === 'vscode') return { workspace };
    return originalLoad.call(this, name, ...args);
};
const { McpConfigStore } = require('../out/mcpConfig.js');
Module._load = originalLoad;

const root = await mkdtemp(join(tmpdir(), 'xratu-mcp-config-'));
try {
    const store = new McpConfigStore({ globalStorageUri: { fsPath: root } });
    // Concurrent activation must create one complete file, never clobber it.
    await Promise.all([store.seedDefaults(), store.seedDefaults()]);
    const raw = await readFile(store.globalPath, 'utf8');
    const { mcpServers } = JSON.parse(raw);
    assert.deepEqual(Object.keys(mcpServers).sort(), ['ddg-search', 'digikala', 'divar', 'torob']);
    for (const name of ['digikala', 'torob', 'divar']) {
        assert.notEqual(mcpServers[name].disabled, true);
        assert.equal(mcpServers[name].autoApprove, undefined);
    }
    const loaded = await store.load();
    assert.deepEqual(loaded.servers, mcpServers);
    await store.seedDefaults();
    assert.equal(await readFile(store.globalPath, 'utf8'), raw);

    // An empty file, a disabled server, and a removed default are user choices.
    for (const content of ['{"mcpServers":{}}', '{"mcpServers":{"divar":{"disabled":true,"url":"https://example.com/mcp"}}}']) {
        await writeFile(store.globalPath, content);
        await store.seedDefaults();
        assert.equal(await readFile(store.globalPath, 'utf8'), content);
    }
    await rm(store.globalPath);
    legacy = { custom: { command: 'node', args: ['custom.js'] } };
    await store.seedDefaults();
    await assert.rejects(readFile(store.globalPath), { code: 'ENOENT' });
    assert.deepEqual((await store.load()).servers, legacy);
    legacy = undefined;
    workspace.isTrusted = false;
    await store.seedDefaults();
    await assert.rejects(readFile(store.globalPath), { code: 'ENOENT' });
    workspace.isTrusted = true;
    await store.seedDefaults();
    assert.equal(Object.keys((await store.load()).servers).length, 4);
    console.log('mcp-config: enabled defaults, concurrent seed, user choices, legacy and trust gates passed');
} finally {
    await rm(root, { recursive: true, force: true });
}
