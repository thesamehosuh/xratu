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
    const actions = useRef(new Set<string>());
    const timeout = useRef<ReturnType<typeof setTimeout>>();
    const refreshTimeout = useRef<ReturnType<typeof setTimeout>>();
    const requestId = useCallback((action = false, background = false) => {
        const request = `${id}-${++sequence.current}`;
        if (action) actions.current.add(request);
        else latest.current = request;
        if (background) {
            clearTimeout(refreshTimeout.current);
            refreshTimeout.current = setTimeout(() => {
                if (latest.current === request) { latest.current = ''; setError({ key: 'prReadFailed' }); }
            }, 50_000);
            return request;
        }
        setPending(true); setError(null);
        clearTimeout(timeout.current);
        timeout.current = setTimeout(() => { actions.current.delete(request); setPending(actions.current.size > 0); setError({ key: 'prReadFailed' }); }, 50_000);
        return request;
    }, [id]);
    useEffect(() => {
        setSnapshot({ sessionId, state: empty() }); setError(null);
        const handler = (event: MessageEvent<FromExtensionMessage>) => {
            const message = event.data;
            if (message.type !== 'pullRequestsState' || message.sessionId !== sessionId || (message.requestId && message.requestId !== latest.current && !actions.current.has(message.requestId))) return;
            setSnapshot({ sessionId, state: message.state });
            if (message.requestId) {
                // An action supersedes refreshes that began before it settled.
                if (actions.current.delete(message.requestId) || message.requestId === latest.current) { latest.current = ''; clearTimeout(refreshTimeout.current); }
                if (!actions.current.size) { clearTimeout(timeout.current); setPending(false); }
                setError(message.errorKey ? { key: message.errorKey, detail: message.detail } : null);
            } else if (message.errorKey) setError({ key: message.errorKey, detail: message.detail });
        };
        const refresh = () => {
            if (actions.current.size) return;
            postMessage({ type: 'pullRequestsGetState', requestId: requestId(false, true), refresh: !!sessionId });
        };
        const poll = window.setInterval(() => { if (!document.hidden && !latest.current) refresh(); }, 30_000);
        window.addEventListener('message', handler);
        window.addEventListener('focus', refresh);
        refresh();
        return () => { window.removeEventListener('message', handler); window.removeEventListener('focus', refresh); clearTimeout(timeout.current); window.clearInterval(poll); clearTimeout(refreshTimeout.current); latest.current = ''; actions.current.clear(); };
    }, [sessionId, requestId]);
    const action = (action: PullRequestAction, url?: string) => postMessage({ type: 'pullRequestAction', action, url, sessionId, requestId: requestId(true), autoResume: true });
    return { state: snapshot.sessionId === sessionId ? snapshot.state : empty(), pending, error, action };
}
