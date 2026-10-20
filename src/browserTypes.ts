/** Shared display protocol. Browser pixels never enter the conversation ledger. */
export interface BrowserState {
    sessionId: string;
    browserId: string;
    status: 'closed' | 'starting' | 'ready' | 'error';
    url: string;
    title: string;
    loading: boolean;
    viewport: { width: number; height: number };
    viewportMode: 'fill' | 'fixed';
    errorKey?: string;
    errorDetail?: string;
}

export type BrowserCommand =
    | { action: 'open' | 'navigate'; url: string }
    | { action: 'back' | 'forward' | 'reload' | 'close' }
    | { action: 'resize'; width: number; height: number; mode?: 'fill' | 'fixed'; expectedMode?: 'fill' | 'fixed' }
    | { action: 'click'; x: number; y: number }
    | { action: 'press'; key: string }
    | { action: 'type'; text: string }
    | { action: 'scroll'; x: number; y: number; deltaX: number; deltaY: number };

export interface BrowserFrame {
    sessionId: string;
    browserId: string;
    frameId: number;
    data: string;
    width: number;
    height: number;
}
