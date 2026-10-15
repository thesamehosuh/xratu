import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PullRequestAction } from '../../src/pullRequests/controller';
import type { PullRequestView } from '../../src/pullRequests/types';
import type { FromExtensionMessage } from './types';
import { postMessage } from './vscode';

const empty = (): PullRequestView => ({ links: [], events: [], offline: false });

/** One session-scoped subscription feeds chat, Activity and the details panel. */
export function usePullRequests(sessionId: string | null) {
    const [snapshot, setSnapshot] = useState({ sessionId, state: empty() });
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<{ key: string; detail?: string } | null>(null);
    const id = useId(), sequence = useRef(0), latest = useRef('');
    const timeout = useRef<ReturnType<typeof setTimeout>>();
    const requestId = useCallback(() => {
        latest.current = `${id}-${++sequence.current}`;
        setPending(true); setError(null);
        clearTimeout(timeout.current);
        timeout.current = setTimeout(() => { setPending(false); setError({ key: 'prReadFailed' }); }, 50_000);
        return latest.current;
    }, [id]);
    useEffect(() => {
        setSnapshot({ sessionId, state: empty() }); setError(null);
        const handler = (event: MessageEvent<FromExtensionMessage>) => {
            const message = event.data;
            if (message.type !== 'pullRequestsState' || message.sessionId !== sessionId || (message.requestId && message.requestId !== latest.current)) return;
            setSnapshot({ sessionId, state: message.state });
            if (message.requestId) {
                clearTimeout(timeout.current); setPending(false);
                setError(message.errorKey ? { key: message.errorKey, detail: message.detail } : null);
            } else if (message.errorKey) setError({ key: message.errorKey, detail: message.detail });
        };
        const refresh = () => postMessage({ type: 'pullRequestsGetState', requestId: requestId() });
        window.addEventListener('message', handler);
        window.addEventListener('focus', refresh);
        refresh();
        return () => { window.removeEventListener('message', handler); window.removeEventListener('focus', refresh); clearTimeout(timeout.current); latest.current = ''; };
    }, [sessionId, requestId]);
    const action = (action: PullRequestAction, url?: string) => postMessage({ type: 'pullRequestAction', action, url, sessionId, requestId: requestId(), autoResume: true });
    return { state: snapshot.sessionId === sessionId ? snapshot.state : empty(), pending, error, action };
}
