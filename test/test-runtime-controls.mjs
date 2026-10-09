import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function (name, ...args) {
    if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
    return originalLoad.call(this, name, ...args);
};
const policy = require('../out/networkPolicy.js');
const { proxyFetch } = require('../out/proxyFetch.js');
const { manageOllamaModel, ollamaManagementUrl } = require('../out/local/ollamaManagement.js');
const { getLocalToolDefinitions, executeLocalTool } = require('../out/mcp.js');
const { ExternalMcpManager } = require('../out/externalMcp.js');
const originalFetch = globalThis.fetch;
let calls = [];
try {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        assert.equal(policy.isLoopbackUrl(`http://${host}:11434/v1`), true);
        assert.equal(ollamaManagementUrl(`http://${host}:11434/v1`, 'pull'), `http://${host}:11434/api/pull`);
    }
    for (const url of ['http://localhost.evil.test:11434/v1', 'http://127.0.0.1@evil.test:11434/v1',
        'http://192.168.1.2:11434/v1', 'file:///localhost', 'http://user@localhost:11434/v1']) assert.equal(policy.isLoopbackUrl(url), false, url);
    for (const url of ['http://localhost:1234/v1', 'http://localhost:11434/custom', 'http://localhost:11434/v1?host=evil'])
        assert.throws(() => ollamaManagementUrl(url, 'delete'));
    globalThis.fetch = async (input, init) => { calls.push({ input, init }); return new Response('{}'); };
    await proxyFetch('https://example.test/v1');
    const remoteSignal = calls[0].init.signal;
    policy.setOfflineMode(true);
    assert.equal(remoteSignal.aborted, true, 'switch cancels already-open remote requests');
    await assert.rejects(proxyFetch('https://example.test/v1'), /offline/);
    assert.equal(calls.length, 1, 'remote request denied before fetch');
    await proxyFetch('http://localhost:11434/v1', { dispatcher: { proxy: true } });
    assert.equal(calls[1].init.redirect, 'error', 'local redirect cannot escape offline policy');
    assert.equal(calls[1].init.dispatcher, undefined, 'offline loopback requests bypass proxies');
    const names = getLocalToolDefinitions({ external: [{ name: 'mcp__remote__call', inputSchema: {}, description: '' }] }).map((t) => t.name);
    for (const name of ['web_search', 'fetch_url', 'mcp__remote__call']) {
        assert.equal(names.includes(name), false);
        assert.equal((await executeLocalTool('', name, {}, async () => {})).isError, true, 'dispatch denies stale/hallucinated tool');
    }
    let loads = 0;
    const external = new ExternalMcpManager(async () => { loads++; return { servers: {} }; });
    assert.deepEqual(await external.listTools(), []);
    await external.callTool('mcp__remote__call', {});
    assert.equal(loads, 0, 'offline cannot start HTTP, websocket or stdio MCP clients');
    let closed = false;
    let settleConnect;
    external._states.set('connecting', new Promise((resolve) => { settleConnect = resolve; }));
    external._connectingTransports.add({ close: async () => { closed = true; settleConnect(null); } });
    await external.reload();
    assert.equal(closed, true, 'mode change closes transports still waiting for handshake');
    await assert.rejects(manageOllamaModel('http://localhost:11434/v1', 'pull', 'qwen:3b', new AbortController().signal, () => {}), /offline/);
    policy.setOfflineMode(false);
    assert.equal(policy.networkSignal('https://example.test').aborted, false, 'reenabling online uses a fresh signal');

    calls = [];
    const progress = [];
    globalThis.fetch = async (input, init) => {
        calls.push({ input: String(input), init });
        if (String(input).endsWith('/api/version')) return Response.json({ version: '0.6.0' });
        return new Response(new ReadableStream({ start(c) {
            c.enqueue(new TextEncoder().encode('{"status":"downloading","completed":5,"total":10}\r\n{"sta'));
            c.enqueue(new TextEncoder().encode('tus":"success"}'));
            c.close();
        } }));
    };
    await manageOllamaModel('http://localhost:11434/v1', 'pull', 'qwen:3b', new AbortController().signal, (p) => progress.push(p));
    assert.equal(progress[0].completed, 5);
    assert.equal(progress[1].status, 'success', 'CRLF and fragmented final line parsed');
    assert.equal(calls[1].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[1].init.body), { model: 'qwen:3b', stream: true });
    await manageOllamaModel('http://localhost:11434/v1', 'delete', 'qwen:3b', new AbortController().signal, () => {});
    assert.equal(calls.at(-1).init.method, 'DELETE');
    await assert.rejects(manageOllamaModel('http://localhost:11434/v1', 'pull', '../bad', new AbortController().signal, () => {}), /Invalid/);
    for (const body of ['{"error":"disk full"}\n', '{"status":"downloading"}\n', 'x'.repeat(64_001)]) {
        globalThis.fetch = async (url) => String(url).endsWith('/api/version') ? Response.json({ version: '0.6' }) : new Response(body);
        await assert.rejects(manageOllamaModel('http://localhost:11434/v1', 'pull', 'qwen:3b', new AbortController().signal, () => {}));
    }
    globalThis.fetch = async () => Response.json({ wrong: true });
    await assert.rejects(manageOllamaModel('http://localhost:11434/v1', 'delete', 'qwen:3b', new AbortController().signal, () => {}), /not an Ollama/);
    const controller = new AbortController();

    globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/api/version')) return Response.json({ version: '0.6' });
        return new Response(new ReadableStream({ start(c) {
            init.signal.addEventListener('abort', () => c.error(init.signal.reason), { once: true });
            queueMicrotask(() => controller.abort());
        } }));
    };
    await assert.rejects(manageOllamaModel('http://localhost:11434/v1', 'pull', 'qwen:3b', controller.signal, () => {}), { name: 'AbortError' });
    console.log('runtime-controls: network policy, dispatch gates, downloads, deletion and cancellation passed');
} finally {
    policy.setOfflineMode(false);
    globalThis.fetch = originalFetch;
    Module._load = originalLoad;
}
