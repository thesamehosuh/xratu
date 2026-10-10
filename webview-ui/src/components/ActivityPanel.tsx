import { useCallback, useLayoutEffect, useRef, type ComponentProps } from 'react';
import { ActivityTimeline } from './MessageItem';

/** Follow new activity until the reader scrolls away; docking retains that choice. */
export function ActivityPanel({ visible, panelClass, ...props }: ComponentProps<typeof ActivityTimeline> & { visible: boolean; panelClass: string }) {
    const pane = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    const follow = useCallback(() => {
        const element = pane.current;
        if (visible && pinned.current && element) element.scrollTop = element.scrollHeight;
    }, [visible]);

    useLayoutEffect(() => { follow(); }, [follow, props.messages]);
    useLayoutEffect(() => {
        if (!pane.current || !content.current) return;
        const observer = new ResizeObserver(follow);
        observer.observe(pane.current);
        observer.observe(content.current);
        return () => observer.disconnect();
    }, [follow]);

    return <div ref={pane} className={`activity-pane ${panelClass}`} id="surface-panel-activity" role="tabpanel" aria-labelledby="surface-tab-activity" aria-hidden={!visible || undefined}
        onScroll={() => {
            const element = pane.current;
            if (visible && element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}>
        <div ref={content}><ActivityTimeline {...props} /></div>
    </div>;
}
