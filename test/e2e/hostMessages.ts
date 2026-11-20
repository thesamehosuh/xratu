import type { Page } from '@playwright/test';

export function postHostMessageAndWait(page: Page, message: Record<string, unknown>): Promise<void> {
    return page.evaluate((msg) => new Promise<void>((resolve) => {
        const onMessage = (event: MessageEvent) => {
            if (event.source !== window || event.data?.type !== msg.type || event.data?.requestId !== msg.requestId) return;
            window.removeEventListener('message', onMessage);
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        };
        window.addEventListener('message', onMessage);
        window.postMessage(msg, '*');
    }), message);
}
