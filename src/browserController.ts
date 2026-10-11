import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { browserPoint, browserUrl, browserViewport } from './browserPolicy';
import type { BrowserCommand, BrowserFrame, BrowserState } from './browserTypes';
import { isLoopbackUrl, isOfflineMode } from './networkPolicy';
import type { LocalToolResult } from './local/localTypes';

type BrowserEvent = { type: 'browserState'; state: BrowserState } | { type: 'browserFrame'; frame: BrowserFrame } | { type: 'openBrowser' };
interface Options {
    emit: (event: BrowserEvent) => void;
    executablePath: () => string;
    /** Tests can supply a real, already-launched browser without changing production sandboxing. */
    launch?: () => Promise<Browser>;
    protocolTimeoutMs?: number;
}
const MAX_DIAGNOSTICS = 100;
const TIMEOUT = 15_000;
const boundedString = (value: unknown, max = 8192): string => {
    if (typeof value !== 'string' || value.length > max) throw new Error('Invalid browser argument.');
    return value;
};

/** One isolated page per active chat. No debug server, exposed port, or personal profile. */
export class BrowserController {
    private state: BrowserState = this.emptyState('');
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private cdp: CDPSession | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private visible = false;
    private streaming = false;
    private frameSequence = 0;
    private pendingFrame: { id: number; sent: number } | null = null;
    private lastFrame = 0;
    private latestFrame: string | null = null;
    private frameTimer: ReturnType<typeof setTimeout> | undefined;
    private diagnostics: Array<{ kind: string; text: string }> = [];
    private disposed = false;

    constructor(private readonly options: Options) {}

    private emptyState(sessionId: string): BrowserState {
        return { sessionId, browserId: randomUUID(), status: 'closed', url: '', title: '', loading: false, viewport: { width: 1280, height: 800 }, viewportMode: 'fill' };
    }

    getState(): BrowserState { return { ...this.state, viewport: { ...this.state.viewport } }; }
    publish(): void { this.options.emit({ type: 'browserState', state: this.getState() }); }

    setSession(sessionId: string): void {
        if (sessionId === this.state.sessionId) return;
        this.close();
        this.state = this.emptyState(sessionId);
        this.visible = false;
        this.publish();
    }

    /** Detach synchronously: a late launch/operation can never adopt a new chat. */
    close(): void {
        const browser = this.browser;
        this.browser = null; this.context = null; this.page = null; this.cdp = null;
        this.streaming = false; this.pendingFrame = null; this.diagnostics = [];
        this.latestFrame = null; clearTimeout(this.frameTimer); this.frameTimer = undefined;
        this.state = this.emptyState(this.state.sessionId);
        this.publish();
        void browser?.close().catch(() => undefined);
    }

    dispose(): void { this.disposed = true; this.close(); }

    private current(sessionId: string, browserId?: string): void {
        if (this.disposed || sessionId !== this.state.sessionId || (browserId && browserId !== this.state.browserId)) throw new Error('This browser operation belongs to an expired chat or browser.');
    }

    private enqueue<T>(sessionId: string, browserId: string | undefined, fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(async () => { this.current(sessionId, browserId); return fn(); });
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async launch(): Promise<Browser> {
        if (this.options.launch) return this.options.launch();
        const executablePath = this.options.executablePath().trim();
        if (executablePath) {
            if (!isAbsolute(executablePath) || !existsSync(executablePath)) throw new Error('The configured browser executable must be an existing absolute path.');
            return chromium.launch({ executablePath, headless: true, chromiumSandbox: true, timeout: TIMEOUT });
        }
        // Playwright resolves branded browser locations on Windows/macOS/Linux.
        for (const channel of process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge']) {
            try { return await chromium.launch({ channel, headless: true, chromiumSandbox: true, timeout: TIMEOUT }); }
            catch (error) {
                // Only a missing install warrants trying another browser. Never mask sandbox errors.
                if (!/executable doesn't exist|distribution.*not found/i.test(String(error))) throw error;
            }
        }
        const systemChromium = process.platform === 'linux' ? ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync) : undefined;
        const installedChromium = systemChromium ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined);
        if (installedChromium) return chromium.launch({ executablePath: installedChromium, headless: true, chromiumSandbox: true, timeout: TIMEOUT });
        throw new Error('Install Chrome or Edge, or set xratu.browserExecutablePath to your Chromium executable.');
    }

    private async ensurePage(sessionId: string): Promise<Page> {
        if (this.page && !this.page.isClosed()) return this.page;
        const browserId = this.state.browserId;
        this.state = { ...this.state, status: 'starting', errorKey: undefined, errorDetail: undefined };
        this.publish();
        let launched: Browser | null = null;
        try {
            launched = await this.launch();
            this.current(sessionId, browserId);
            const context = await launched.newContext({ viewport: this.state.viewport, acceptDownloads: false, serviceWorkers: 'block' });
            await context.route('**/*', async route => {
                const url = route.request().url();
                if (!/^https?:/i.test(url) || (isOfflineMode() && !isLoopbackUrl(url))) await route.abort('blockedbyclient');
                else await route.continue();
            });
            await context.routeWebSocket('**/*', socket => {
                const url = new URL(socket.url());
                url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
                if (isOfflineMode() && !isLoopbackUrl(url)) socket.close();
                else socket.connectToServer();
            });
            const page = await context.newPage();
            page.setDefaultTimeout(TIMEOUT);
            page.setDefaultNavigationTimeout(TIMEOUT);
            this.current(sessionId, browserId);
            const cdp = await context.newCDPSession(page);
            this.current(sessionId, browserId);
            this.browser = launched; this.context = context; this.page = page; this.cdp = cdp;
            const active = () => this.page === page && this.state.browserId === browserId;
            const diagnostic = (kind: string, text: string) => {
                if (!active()) return;
                this.diagnostics.push({ kind, text: text.slice(0, 2000) });
                this.diagnostics.splice(0, Math.max(0, this.diagnostics.length - MAX_DIAGNOSTICS));
            };
            page.on('console', msg => diagnostic(msg.type(), msg.text()));
            page.on('pageerror', error => diagnostic('pageerror', error.message));
            page.on('requestfailed', req => diagnostic('network', `${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`));
            page.on('response', response => { if (response.status() >= 400) diagnostic('network', `${response.status()} ${response.url()}`); });
            page.on('dialog', dialog => { diagnostic('dialog', dialog.message()); void dialog.dismiss().catch(() => undefined); });
            page.on('download', download => { void download.cancel().catch(() => undefined); diagnostic('download', 'Downloads are not supported in this browser.'); });
            // Keep the first version single-page, including links that use target=_blank.
            context.on('page', popup => {
                if (popup === page) return;
                void popup.close().catch(() => undefined);
                diagnostic('popup', 'A popup was blocked. Navigate its URL in this browser instead.');
            });
            page.on('framenavigated', frame => {
                if (!active() || frame !== page.mainFrame()) return;
                this.state = { ...this.state, url: page.url(), loading: true };
                this.publish();
            });
            const loaded = () => { if (active()) void this.refresh(page); };
            page.on('domcontentloaded', loaded); page.on('load', loaded);
            page.on('close', () => { if (active()) this.close(); });
            launched.on('disconnected', () => { if (active()) this.close(); });
            cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number; metadata?: { deviceWidth: number; deviceHeight: number } }) => {
                // Chromium must always be acknowledged. At most one webview frame is outstanding.
                void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
                if (!active() || !this.visible || !this.streaming) return;
                if (frame.metadata && (frame.metadata.deviceWidth !== this.state.viewport.width || frame.metadata.deviceHeight !== this.state.viewport.height)) return;
                this.sendFrame(frame.data);
            });
            this.state = { ...this.state, status: 'ready', url: page.url() };
            this.publish();
            await this.stream();
            this.current(sessionId, browserId);
            return page;
        } catch (error) {
            await launched?.close().catch(() => undefined);
            if (this.state.browserId === browserId) {
                this.browser = null; this.context = null; this.page = null; this.cdp = null;
                this.state = { ...this.state, status: 'error', loading: false, errorKey: 'browserStartFailed', errorDetail: String(error) };
                this.publish();
            }
            throw error;
        }
    }

    private async refresh(page: Page): Promise<void> {
        const title = await page.title().catch(() => '');
        if (page !== this.page) return;
        this.state = { ...this.state, url: page.url(), title: title.slice(0, 512), loading: false };
        this.publish();
    }

    private sendFrame(data: string): void {
        if (data.length > 4 * 1024 * 1024) return;
        this.latestFrame = data;
        this.flushFrame();
    }

    private flushFrame(): void {
        clearTimeout(this.frameTimer); this.frameTimer = undefined;
        if (!this.visible || !this.latestFrame) return;
        const delay = Math.max(0, 100 - (Date.now() - this.lastFrame), this.pendingFrame ? 1000 - (Date.now() - this.pendingFrame.sent) : 0);
        if (delay > 0) { this.frameTimer = setTimeout(() => this.flushFrame(), delay); return; }
        const data = this.latestFrame; this.latestFrame = null;
        const frameId = ++this.frameSequence;
        this.pendingFrame = { id: frameId, sent: Date.now() }; this.lastFrame = Date.now();
        this.options.emit({ type: 'browserFrame', frame: { sessionId: this.state.sessionId, browserId: this.state.browserId, frameId, data, ...this.state.viewport } });
    }

    ack(sessionId: string, browserId: string, frameId: number): void {
        if (sessionId === this.state.sessionId && browserId === this.state.browserId && this.pendingFrame?.id === frameId) { this.pendingFrame = null; this.flushFrame(); }
    }

    setVisible(sessionId: string, browserId: string, visible: boolean): Promise<void> {
        return this.enqueue(sessionId, browserId, async () => { this.visible = visible; await this.stream(); });
    }

    private async protocolCommand(operation: Promise<unknown>): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([operation, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Browser screencast timed out.')), this.options.protocolTimeoutMs ?? TIMEOUT);
            })]);
        } finally { clearTimeout(timer); }
    }

    private async stream(): Promise<void> {
        const cdp = this.cdp, page = this.page;
        if (!cdp || !page) return;
        if (this.visible && !this.streaming) {
            this.streaming = true;
            try {
                await this.protocolCommand(cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 1280 }));
                if (cdp !== this.cdp || page !== this.page) return;
                // An idle page may not emit a screencast frame until it changes.
                this.pendingFrame = null;
                const still = await page.screenshot({ type: 'jpeg', quality: 70, timeout: TIMEOUT }).catch(() => null);
                if (still && page === this.page && this.visible) this.sendFrame(still.toString('base64'));
            } catch (error) {
                if (cdp === this.cdp) {
                    this.streaming = false; this.pendingFrame = null; this.latestFrame = null;
                    clearTimeout(this.frameTimer); this.frameTimer = undefined;
                }
                throw error;
            }
        } else if (!this.visible && this.streaming) {
            this.streaming = false; this.pendingFrame = null;
            this.latestFrame = null; clearTimeout(this.frameTimer); this.frameTimer = undefined;
            await this.protocolCommand(cdp.send('Page.stopScreencast')).catch(() => undefined);
        }
    }

    command(sessionId: string, browserId: string, command: BrowserCommand): Promise<void> {
        // Close must interrupt a launch/navigation rather than waiting behind it.
        if (command.action === 'close') {
            try { this.current(sessionId, browserId); this.close(); return Promise.resolve(); }
            catch (error) { return Promise.reject(error); }
        }
        return this.enqueue(sessionId, browserId, async () => {
            if (command.action === 'open' || command.action === 'navigate') {
                const url = browserUrl(command.url, isOfflineMode());
                const page = await this.ensurePage(sessionId);
                this.current(sessionId, browserId);
                this.state = { ...this.state, loading: true }; this.publish();
                try { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
                finally { await this.refresh(page); }
                return;
            }
            const page = this.requirePage();
            switch (command.action) {
                case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); break;
                case 'forward': await page.goForward({ waitUntil: 'domcontentloaded' }); break;
                case 'reload': await page.reload({ waitUntil: 'domcontentloaded' }); break;
                case 'resize': {
                    const viewport = browserViewport(command.width, command.height);
                    if (command.mode !== undefined && !['fill', 'fixed'].includes(command.mode)) throw new Error('Invalid viewport mode.');
                    // Chromium can retain a screencast surface at its previous size.
                    // Restart it and seed a still so an idle resized page cannot remain stale.
                    if (this.streaming && this.cdp) {
                        this.streaming = false;
                        await this.protocolCommand(this.cdp.send('Page.stopScreencast')).catch(() => undefined);
                    }
                    this.current(sessionId, browserId);
                    this.pendingFrame = null; this.latestFrame = null;
                    clearTimeout(this.frameTimer); this.frameTimer = undefined;
                    await page.setViewportSize(viewport);
                    this.current(sessionId, browserId);
                    this.state = { ...this.state, viewport, viewportMode: command.mode ?? 'fixed' }; this.publish();
                    await this.stream(); break;
                }
                case 'click': { const point = browserPoint(command.x, command.y, this.state.viewport); await page.mouse.click(point.x, point.y); break; }
                case 'press': await page.keyboard.press(boundedString(command.key, 128)); break;
                case 'type': await page.keyboard.insertText(boundedString(command.text, 16000)); break;
                case 'scroll': {
                    const point = browserPoint(command.x, command.y, this.state.viewport);
                    const deltaX = this.delta(command.deltaX), deltaY = this.delta(command.deltaY);
                    await page.mouse.move(point.x, point.y); await page.mouse.wheel(deltaX, deltaY); break;
                }
                default: throw new Error('Unknown browser command.');
            }
            await this.refresh(page);
        });
    }

    private delta(value: unknown): number {
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 10000) throw new Error('Invalid scroll distance.');
        return value;
    }

    private requirePage(): Page {
        if (!this.page || this.page.isClosed()) throw new Error('Open the browser first with browser_open.');
        return this.page;
    }

    async tool(sessionId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<LocalToolResult> {
        const browserId = this.state.browserId;
        const checkAbort = () => { if (signal?.aborted) throw new Error('Browser operation cancelled.'); };
        // Closing the owned context interrupts Playwright waits and page JavaScript on cancellation.
        const cancel = () => { if (this.state.browserId === browserId) this.close(); };
        try {
            checkAbort(); signal?.addEventListener('abort', cancel, { once: true });
            if (name === 'browser_status') { this.current(sessionId); return { output: JSON.stringify(this.getState()) }; }
            if (['browser_open', 'browser_navigate', 'browser_close', 'browser_resize', 'browser_press', 'browser_scroll'].includes(name)) {
                let command: BrowserCommand;
                if (name === 'browser_open' || name === 'browser_navigate') command = { action: 'navigate', url: boundedString(args.url) };
                else if (name === 'browser_resize') command = { action: 'resize', ...browserViewport(args.width, args.height) };
                else if (name === 'browser_press') command = { action: 'press', key: boundedString(args.key, 128) };
                else if (name === 'browser_scroll') command = { action: 'scroll', ...browserPoint(args.x ?? this.state.viewport.width / 2, args.y ?? this.state.viewport.height / 2, this.state.viewport), deltaX: this.delta(args.deltaX ?? 0), deltaY: this.delta(args.deltaY) };
                else command = { action: 'close' };
                this.current(sessionId, browserId);
                if (name === 'browser_open') this.options.emit({ type: 'openBrowser' });
                await this.command(sessionId, browserId, command);
                checkAbort();
                if (name !== 'browser_close') this.current(sessionId, browserId);
                return { output: JSON.stringify(this.getState()) };
            }
            return await this.enqueue(sessionId, browserId, async () => {
                checkAbort(); const page = this.requirePage();
                if (name === 'browser_snapshot') {
                    const tree = await page.locator('body').ariaSnapshot({ timeout: TIMEOUT });
                    const text = await page.locator('body').innerText({ timeout: TIMEOUT });
                    return { output: JSON.stringify({ url: page.url(), title: await page.title(), viewport: this.state.viewport, accessibilityTree: tree.slice(0, 20000), visibleText: text.slice(0, 12000), diagnostics: this.diagnostics,
                        locatorHint: 'Use role=button[name="Exact name"] or role=textbox[name="Label"]. Locators are strict; inspect again after navigation.' }) };
                }
                if (name === 'browser_screenshot') {
                    const data = await page.screenshot({ type: 'png', timeout: TIMEOUT });
                    return { output: JSON.stringify({ url: page.url(), ...this.state.viewport }), images: [{ mimeType: 'image/png', dataBase64: data.toString('base64'), ...this.state.viewport }] };
                }
                if (name === 'browser_click') {
                    if (args.locator !== undefined) await page.locator(boundedString(args.locator)).click();
                    else { const point = browserPoint(args.x, args.y, this.state.viewport); await page.mouse.click(point.x, point.y); }
                } else if (name === 'browser_type') {
                    await page.locator(boundedString(args.locator)).fill(boundedString(args.text, 16000));
                } else if (name === 'browser_evaluate') {
                    const expression = boundedString(args.expression, 32000);
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    let result: unknown;
                    try {
                        result = await Promise.race([
                            page.evaluate(expression),
                            new Promise<never>((_, reject) => {
                                timer = setTimeout(() => { cancel(); reject(new Error('Browser evaluation timed out.')); }, TIMEOUT);
                                timer.unref();
                            }),
                        ]);
                    } finally { clearTimeout(timer); }
                    const output = JSON.stringify(result) ?? 'null';
                    return { output: output.length > 64000 ? output.slice(0, 64000) + '\n[truncated]' : output };
                } else throw new Error('Unknown browser tool.');
                checkAbort(); await this.refresh(page);
                return { output: JSON.stringify(this.getState()) };
            });
        } catch (error) { return { output: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true }; }
        finally { signal?.removeEventListener('abort', cancel); }
    }
}
