import { useEffect, useState } from 'react';
import type { DownloadView, DownloadError } from '../../src/downloads/types';
import type { FromExtensionMessage } from './types';
import { postMessage } from './vscode';

/** Workspace-scoped display state; no download mutations cross the webview. */
export function useDownloads() {
    const [state, setState] = useState<{ downloads: DownloadView[]; error?: DownloadError }>({ downloads: [] });
    useEffect(() => {
        const receive = (event: MessageEvent<FromExtensionMessage>) => {
            if (event.data.type === 'downloadsState') setState({ downloads: event.data.downloads, error: event.data.error });
        };
        window.addEventListener('message', receive);
        postMessage({ type: 'downloadsGetState' });
        return () => window.removeEventListener('message', receive);
    }, []);
    return state;
}
