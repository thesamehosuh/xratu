import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
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
        mouse: { click: async (x, y) => calls.push(['click', x, y]), move: async () => {}, wheel: async (x, y) => calls.push(['wheel', x, y]) },
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
