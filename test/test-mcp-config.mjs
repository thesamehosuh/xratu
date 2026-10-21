#!/usr/bin/env node
// Run after `npx tsc -p . --outDir out`.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
    assert.deepEqual(Object.keys(mcpServers).sort(), []);
    const { MCP_REGISTRY } = require('../out/mcpRegistry.js');
    for (const entry of MCP_REGISTRY.filter(entry => entry.tags?.includes('iranian'))) {
        assert.equal(entry.defaultEnabled, false, 'Iranian marketplace presets stay visible and opt-in');
        assert.equal(entry.server.autoApprove, undefined);
    }
    assert.equal(MCP_REGISTRY.find(entry => entry.id === 'torob').server.connectTimeoutMs, 120000);
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
    assert.equal(Object.keys((await store.load()).servers).length, 0);
    // The first Servers-page read cannot race ahead of publishing defaults.
    await rm(store.globalPath);
    const originalLink = fs.promises.link;
    let entered;
    let release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    fs.promises.link = async (...args) => { entered(); await gate; return originalLink(...args); };
    try {
        const seeding = store.seedDefaults();
        await started;
        let loadedEarly = false;
        const reading = store.load().then(value => { loadedEarly = true; return value; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(loadedEarly, false);
        release();
        await seeding;
        assert.deepEqual(Object.keys((await reading).servers).sort(), []);
    } finally { release(); fs.promises.link = originalLink; }
    // An interrupted publication must leave no truncated final config.
    await rm(store.globalPath);
    fs.promises.link = async () => { throw Object.assign(new Error('Interrupted publish'), { code: 'EIO' }); };
    try { await assert.rejects(store.seedDefaults(), { code: 'EIO' }); }
    finally { fs.promises.link = originalLink; }
    await assert.rejects(readFile(store.globalPath), { code: 'ENOENT' });
    assert.equal((await fs.promises.readdir(root)).some(name => name.endsWith('.tmp')), false);
    console.log('mcp-config: optional defaults, concurrent seed, user choices, legacy and trust gates passed');
} finally {
    await rm(root, { recursive: true, force: true });
}
