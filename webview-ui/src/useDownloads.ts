import { useEffect, useRef, useState } from 'react';
import type { DownloadAction, DownloadView, DownloadError } from '../../src/downloads/types';
import type { FromExtensionMessage } from './types';
import { postMessage } from './vscode';

/** Session-scoped snapshots and request identities reject delayed updates. */
export function useDownloads() {
    const [state, setState] = useState<{ downloads: DownloadView[]; error?: DownloadError }>({ downloads: [] });
    const session = useRef<string | null>(null);
    const requests = useRef<Record<string, string>>({});
    const [pending, setPending] = useState<Record<string, string>>({});
    const [actionErrors, setActionErrors] = useState<Record<string, 'downloadActionFailed'>>({});
    useEffect(() => {
        const receive = (event: MessageEvent<FromExtensionMessage>) => {
            const msg = event.data;
            if (msg.type === 'sessionState') {
                const id = msg.browserSessionId ?? msg.id;
                if (id !== session.current) {
                    session.current = id;
                    requests.current = {};
                    setPending({}); setActionErrors({}); setState({ downloads: [] });
                    postMessage({ type: 'downloadsGetState' });
                }
            } else if (msg.type === 'downloadsState') {
                if (session.current !== null && session.current !== msg.sessionId) return;
                session.current = msg.sessionId;
                setState({ downloads: msg.downloads, error: msg.error });
            } else if (msg.type === 'downloadActionResult') {
                if (msg.sessionId !== session.current || requests.current[msg.id] !== msg.requestId) return;
                delete requests.current[msg.id];
                setPending({ ...requests.current });
                const errorKey = msg.errorKey;
                if (errorKey) setActionErrors(errors => ({ ...errors, [msg.id]: errorKey }));
            }
        };
        window.addEventListener('message', receive);
        postMessage({ type: 'downloadsGetState' });
        return () => window.removeEventListener('message', receive);
    }, []);
    const onAction = (id: string, action: DownloadAction) => {
        if (!session.current || requests.current[id]) return;
        const requestId = crypto.randomUUID();
        requests.current[id] = requestId;
        setPending({ ...requests.current });
        setActionErrors(errors => { const next = { ...errors }; delete next[id]; return next; });
        postMessage({ type: 'downloadAction', sessionId: session.current, id, action, requestId });
    };
    return { ...state, pending, actionErrors, onAction };
}
