import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { Search, X } from 'lucide-react';
import { ActivityTimeline, type ActivityFilter } from './MessageItem';
import { t } from '../i18n';
import { Dropdown } from './Dropdown';
import { transcriptOptions } from '../transcriptPrefs';

/** Follow new activity until the reader scrolls away; docking retains that choice. */
export function ActivityPanel({ visible, panelClass, sessionKey, ...props }: ComponentProps<typeof ActivityTimeline> & { visible: boolean; panelClass: string; sessionKey?: string | null }) {
    const pane = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    const [filter, setFilter] = useState<ActivityFilter>('all');
    const [search, setSearch] = useState('');
    const options = transcriptOptions(props.transcriptPrefs);
    const follow = useCallback(() => {
        const element = pane.current;
        if (visible && options.followActivity && pinned.current && element) element.scrollTop = element.scrollHeight;
    }, [visible, options.followActivity]);

    useLayoutEffect(() => {
        pinned.current = true;
        setFilter('all'); setSearch('');
    }, [sessionKey]);

    useLayoutEffect(() => { follow(); }, [follow, props.messages]);
    useLayoutEffect(() => {
        if (!pane.current || !content.current) return;
        const observer = new ResizeObserver(follow);
        observer.observe(pane.current);
        observer.observe(content.current);
        return () => observer.disconnect();
    }, [follow]);

    const hasActiveFilter = filter !== 'all' || Boolean(search.trim());

    return <div ref={pane} className={`activity-pane ${panelClass}`} id="surface-panel-activity" role="tabpanel" aria-labelledby="surface-tab-activity" aria-hidden={!visible || undefined}
        onScroll={() => {
            const element = pane.current;
            if (visible && element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}>
        <div className="activity-filters">
            <div className="activity-search-box">
                <Search size={13} className="activity-search-icon" aria-hidden="true" />
                <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('txSearchActivity')} aria-label={t('txSearchActivity')} />
                {search && (
                    <button type="button" className="activity-search-clear" onClick={() => setSearch('')} aria-label={t('mcpMarketClearSearch')} title={t('mcpMarketClearSearch')}>
                        <X size={12} />
                    </button>
                )}
            </div>
            <Dropdown label={t('txFilterActivity')} value={filter} onChange={value => setFilter(value as ActivityFilter)}
                options={[{ value: 'all', label: t('txFilterAll') }, { value: 'tools', label: t('txFilterTools') }, { value: 'commands', label: t('miniCommands') }, { value: 'thinking', label: t('miniThinking') }, { value: 'failures', label: t('txFilterFailures') }]} />
        </div>
        <div ref={content}>
            <ActivityTimeline
                {...props}
                filter={filter}
                search={search}
                onResetFilter={hasActiveFilter ? () => { setFilter('all'); setSearch(''); } : undefined}
            />
        </div>
    </div>;
}

