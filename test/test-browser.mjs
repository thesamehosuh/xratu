import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { browserUrl, browserViewport, browserPoint } = require('../out/browserPolicy.js');
const { BrowserController } = require('../out/browserController.js');
const { setOfflineMode } = require('../out/networkPolicy.js');

test('browser navigation accepts local servers and rejects executable/credential URLs', () => {
    assert.equal(browserUrl('localhost:5173/a'), 'http://localhost:5173/a');
    assert.equal(browserUrl('127.0.0.1:3000'), 'http://127.0.0.1:3000/');
    assert.equal(browserUrl('example.com'), 'https://example.com/');
    assert.equal(browserUrl('http://[::1]:3000'), 'http://[::1]:3000/');
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test', 'ftp://example.com', 'https://key:secret@example.com', '', null, 'http://']) assert.throws(() => browserUrl(url));
    assert.equal(browserUrl('localhost:3000', true), 'http://localhost:3000/');
    assert.throws(() => browserUrl('https://example.com', true));
});

test('viewport and pointer validation bound the browser work surface', () => {
    assert.deepEqual(browserViewport(390, 844), { width: 390, height: 844 });
    for (const [width, height] of [[0, 800], [1280, Infinity], [2561, 800], ['1280', 800], [1280.5, 800]]) assert.throws(() => browserViewport(width, height));
    assert.deepEqual(browserPoint(10, 20, { width: 390, height: 844 }), { x: 10, y: 20 });
    for (const [x, y] of [[-1, 0], [390, 0], [0, NaN], [Infinity, 0]]) assert.throws(() => browserPoint(x, y, { width: 390, height: 844 }));
});

function fakeBrowser() {
    const page = new EventEmitter(); const browser = new EventEmitter(); const cdp = new EventEmitter();
    const calls = []; const routes = []; const sockets = [];
    let url = 'about:blank'; let closed = false;
    Object.assign(page, {
        isClosed: () => closed, setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
        url: () => url, title: async () => 'Test page', mainFrame: () => page,
        goto: async target => { calls.push(['goto', target]); url = target; page.emit('framenavigated', page); },
        screenshot: async () => Buffer.from('frame'), setViewportSize: async size => calls.push(['viewport', size]),
        keyboard: { press: async key => calls.push(['press', key]), insertText: async text => calls.push(['type', text]) },
        mouse: { click: async (x, y) => calls.push(['click', x, y]), move: async (x, y) => calls.push(['move', x, y]), wheel: async (x, y) => calls.push(['wheel', x, y]) },
        locator: () => ({ ariaSnapshot: async () => '- button "Save"', innerText: async () => 'Save', click: async () => {}, fill: async () => {} }),
        evaluate: async () => ({ ok: true }),
    });
    const context = new EventEmitter();
    Object.assign(context, { newPage: async () => page, newCDPSession: async () => cdp,
        route: async (_, callback) => routes.push(callback), routeWebSocket: async (_, callback) => sockets.push(callback) });
    cdp.send = async (name, args) => calls.push([name, args]);
    Object.assign(browser, { newContext: async () => context, close: async () => { closed = true; calls.push(['close']); browser.emit('disconnected'); } });
    return { browser, page, context, cdp, calls, routes, sockets };
}

test('session changes revoke queued and in-flight launches', async () => {
    const fake = fakeBrowser(); let resolveLaunch; const started = new Promise(resolve => { resolveLaunch = resolve; });
    const controller = new BrowserController({ emit() {}, executablePath: () => '', launch: () => started });
    controller.setSession('first'); const oldId = controller.getState().browserId;
    const pending = controller.command('first', oldId, { action: 'open', url: 'http://localhost:3000' });
    await new Promise(resolve => setImmediate(resolve));
    controller.setSession('second'); resolveLaunch(fake.browser);
    await assert.rejects(pending, /expired/);
    assert.equal(controller.getState().sessionId, 'second');
    assert.equal(controller.getState().status, 'closed');
    assert.ok(fake.calls.some(([name]) => name === 'close'));
    await assert.rejects(controller.command('first', oldId, { action: 'press', key: 'Enter' }), /expired/);
    controller.dispose();
});

test('a late resize cannot change the next chat viewport', async () => {
    const fake = fakeBrowser(); let complete;
    const controller = new BrowserController({ emit() {}, executablePath: () => '', launch: async () => fake.browser });
    controller.setSession('first'); const id = controller.getState().browserId;
    await controller.command('first', id, { action: 'open', url: 'http://localhost:3000' });
    fake.page.setViewportSize = () => new Promise(resolve => { complete = resolve; });
    const pending = controller.command('first', id, { action: 'resize', width: 390, height: 844 });
    await new Promise(resolve => setImmediate(resolve));
    controller.setSession('second'); complete();
    await assert.rejects(pending, /expired/);
    assert.equal(controller.getState().sessionId, 'second');
    assert.deepEqual(controller.getState().viewport, { width: 1280, height: 800 });
    assert.equal(controller.getState().status, 'closed'); controller.dispose();
});

test('shared tools, streaming backpressure, cancellation, and offline subresources', async () => {
    const fake = fakeBrowser(); const events = [];
    const controller = new BrowserController({ emit: event => events.push(event), executablePath: () => '', launch: async () => fake.browser });
    controller.setSession('chat'); const id = controller.getState().browserId;
    assert.equal((await controller.tool('chat', 'browser_snapshot', {})).isError, true);
    assert.equal(fake.calls.length, 0, 'inspection must not launch a browser');
    await controller.setVisible('chat', id, true);
    await controller.command('chat', id, { action: 'open', url: 'http://localhost:3000' });
    assert.equal(controller.getState().status, 'ready');
    const frames = () => events.filter(event => event.type === 'browserFrame');
    assert.equal(frames().length, 1);
    fake.cdp.emit('Page.screencastFrame', { sessionId: 1, data: 'latest' });
    fake.cdp.emit('Page.screencastFrame', { sessionId: 2, data: 'newest' });
    assert.equal(frames().length, 1, 'a slow webview cannot accumulate frames');
    controller.ack('chat', id, frames()[0].frame.frameId);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(frames().at(-1).frame.data, 'newest', 'the last repaint must survive throttling');
    await controller.command('chat', id, { action: 'resize', width: 390, height: 844 });
    assert.ok(fake.calls.some(([name]) => name === 'Page.stopScreencast'));
    fake.cdp.emit('Page.screencastFrame', { sessionId: 4, data: 'wrong size', metadata: { deviceWidth: 1280, deviceHeight: 800 } });
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.notEqual(frames().at(-1).frame.data, 'wrong size');
    assert.equal(frames().at(-1).frame.width, 390);
    await controller.command('chat', id, { action: 'resize', width: 390, height: 844, mode: 'fill' });
    await Promise.all([
        controller.command('chat', id, { action: 'resize', width: 1600, height: 900 }),
        controller.command('chat', id, { action: 'resize', width: 420, height: 700, mode: 'fill', expectedMode: 'fill' }),
    ]);
    assert.equal(controller.getState().viewport.width, 1600, 'stale fit measurements cannot undo an explicit fixed viewport');
    await controller.command('chat', id, { action: 'resize', width: 420, height: 700, mode: 'fill' });
    assert.equal(controller.getState().viewport.width, 420, 'explicitly selecting Fit still works');
    const largeFrame = 'a'.repeat(5 * 1024 * 1024);
    controller.sendFrame(largeFrame);
    controller.ack('chat', id, frames().at(-1).frame.frameId);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(frames().at(-1).frame.data.length, largeFrame.length, 'large supported-viewport frames fit the forwarding budget');
    controller.sendFrame('a'.repeat(13 * 1024 * 1024));
    assert.equal(controller.latestFrame, null, 'the larger IPC budget remains bounded');
    const snapshot = await controller.tool('chat', 'browser_snapshot', {});
    assert.match(snapshot.output, /button/);
    const screenshot = await controller.tool('chat', 'browser_screenshot', {});
    assert.equal(screenshot.images[0].mimeType, 'image/png');
    assert.equal((await controller.tool('chat', 'browser_evaluate', { expression: '({ok:true})' })).isError, undefined);
    await controller.command('chat', id, { action: 'type', text: 'سلام' });
    assert.ok(fake.calls.some(([name, text]) => name === 'type' && text === 'سلام'));
    await assert.rejects(controller.command('chat', id, { action: 'scroll', x: 1, y: 1, deltaX: 0, deltaY: Infinity }));
    setOfflineMode(true);
    const outcome = [];
    for (const url of ['https://example.com/api', 'http://localhost:3000/api', 'file:///private']) {
        await fake.routes[0]({ request: () => ({ url: () => url }), abort: async () => outcome.push('blocked'), continue: async () => outcome.push('allowed') });
    }
    assert.deepEqual(outcome, ['blocked', 'allowed', 'blocked']);
    fake.sockets[0]({ url: () => 'wss://example.com/ws', close: () => outcome.push('socket blocked'), connectToServer: () => outcome.push('socket allowed') });
    assert.equal(outcome.at(-1), 'socket blocked'); setOfflineMode(false);
    const abort = new AbortController(); const running = controller.tool('chat', 'browser_evaluate', { expression: 'promise' }, abort.signal);
    abort.abort(); await running;
    assert.equal(controller.getState().status, 'closed');
    assert.ok(fake.calls.some(([name]) => name === 'close'));
    const before = frames().length; fake.cdp.emit('Page.screencastFrame', { sessionId: 3, data: 'stale' });
    assert.equal(frames().length, before); controller.dispose();
});


test('the host preserves its browser through persistence and rejects a replaced chat', async () => {
    const ts = require('typescript');
    const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
    const provider = file.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'XratuChatViewProvider');
    const names = ['_browserSessionId', '_sendBrowserState', '_browserCommand', '_pushSessionState'];
    const members = provider.members.filter(n => n.name && names.includes(n.name.getText(file)));
    assert.equal(members.length, names.length);
    const js = ts.transpileModule(`class TestHost { ${members.map(n => n.getText(file)).join('\n')} }; globalThis.TestHost = TestHost;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const sandbox = { crypto: { randomUUID } };
    vm.runInNewContext(js, sandbox);
    const host = new sandbox.TestHost();
    const fake = fakeBrowser(), messages = [];
    host._browser = new BrowserController({ emit: message => messages.push(message), executablePath: () => '', launch: async () => fake.browser });
    host._view = { webview: { postMessage: message => messages.push(message) } };
    host._pushTaskListState = host._postSessionCost = () => {};
    host._sessionId = host._ephemeralSessionId = host._sessionTitle = null;
    try {
        host._sendBrowserState();
        const before = host._browser.getState();
        await host._browserCommand(before.sessionId, before.browserId, { action: 'open', url: 'http://localhost:3000' });
        host._sessionId = 'persisted-chat';
        host._pushSessionState();
        host._sendBrowserState();
        const persisted = host._browser.getState();
        assert.equal(persisted.sessionId, before.sessionId);
        assert.equal(persisted.browserId, before.browserId);
        assert.equal(persisted.status, 'ready');
        const session = messages.findLast(message => message.type === 'sessionState');
        assert.equal(session.id, 'persisted-chat');
        assert.equal(session.browserSessionId, before.sessionId);
        await host._browserCommand(before.sessionId, before.browserId, { action: 'press', key: 'Enter' });
        assert.ok(fake.calls.some(([name]) => name === 'press'));
        assert.equal(fake.calls.filter(([name]) => name === 'close').length, 0);
        host._ephemeralSessionId = null; host._sessionId = 'different-chat';
        host._pushSessionState();
        assert.equal(host._browser.getState().sessionId, 'different-chat');
        assert.equal(host._browser.getState().status, 'closed');
        const count = fake.calls.length;
        await host._browserCommand(before.sessionId, before.browserId, { action: 'press', key: 'Enter' });
        assert.equal(fake.calls.length, count);
    } finally { host._browser.dispose(); }
});


test('failed or stalled CDP starts release the queue and can be retried', async () => {
    for (const hang of [false, true]) {
        const fake = fakeBrowser();
        const controller = new BrowserController({ emit() {}, executablePath: () => '', launch: async () => fake.browser, protocolTimeoutMs: 20 });
        try {
            controller.setSession('chat');
            const id = controller.getState().browserId;
            await controller.command('chat', id, { action: 'open', url: 'http://localhost:3000' });
            const send = fake.cdp.send;
            fake.cdp.send = method => method === 'Page.startScreencast' ? hang ? new Promise(() => {}) : Promise.reject(new Error('CDP unavailable')) : send(method);
            await assert.rejects(controller.setVisible('chat', id, true), hang ? /timed out/ : /CDP unavailable/);
            fake.cdp.send = send;
            await controller.setVisible('chat', id, true);
            assert.ok(fake.calls.some(([name]) => name === 'Page.startScreencast'));
            fake.cdp.send = method => method === 'Page.stopScreencast' ? new Promise(() => {}) : send(method);
            await controller.setVisible('chat', id, false);
            await controller.command('chat', id, { action: 'press', key: 'Enter' });
            assert.ok(fake.calls.some(([name]) => name === 'press'));
        } finally { controller.dispose(); }
    }
});

test('scrolling defaults to the viewport center and accepts an explicit target', async () => {
    const fake = fakeBrowser();
    const controller = new BrowserController({ emit() {}, executablePath: () => '', launch: async () => fake.browser });
    try {
        controller.setSession('chat');
        await controller.tool('chat', 'browser_open', { url: 'http://localhost:3000' });
        assert.equal((await controller.tool('chat', 'browser_scroll', { deltaY: 200 })).isError, undefined);
        assert.deepEqual(fake.calls.findLast(([name]) => name === 'move'), ['move', 640, 400]);
        assert.equal((await controller.tool('chat', 'browser_scroll', { x: 30, y: 60, deltaY: -200 })).isError, undefined);
        assert.deepEqual(fake.calls.findLast(([name]) => name === 'move'), ['move', 30, 60]);
        const before = fake.calls.length;
        assert.equal((await controller.tool('chat', 'browser_scroll', { x: 1280, y: 60, deltaY: 200 })).isError, true);
        assert.equal(fake.calls.length, before);
    } finally { controller.dispose(); }
});

test('an agent browser-open reveals launch errors and stale opens cannot switch tabs', async () => {
    const events = [];
    const controller = new BrowserController({ emit: event => events.push(event), executablePath: () => '', launch: async () => { throw new Error('Missing browser'); } });
    try {
        controller.setSession('chat');
        assert.equal((await controller.tool('chat', 'browser_open', { url: 'http://localhost:3000' })).isError, true);
        assert.equal(events.filter(event => event.type === 'openBrowser').length, 1);
        assert.equal(controller.getState().status, 'error');
        const shown = events.findIndex(event => event.type === 'openBrowser');
        const failed = events.findIndex(event => event.type === 'browserState' && event.state.status === 'error');
        assert.ok(shown >= 0 && failed > shown);
        await controller.tool('old-chat', 'browser_open', { url: 'http://localhost:3000' });
        assert.equal(events.filter(event => event.type === 'openBrowser').length, 1);
    } finally { controller.dispose(); }
});
