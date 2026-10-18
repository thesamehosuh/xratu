import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { Bot, ChevronLeft, ChevronRight, CodeXml, FilePlus2, GitPullRequest, Globe, List, MessageSquare, MoreHorizontal, PanelRight, PanelsTopLeft, Plus, RotateCcw, SquareTerminal, X } from 'lucide-react';
import { isNewTab, isSurfaceTab, type DockLocation, type SurfaceTab } from '../dockLayout';
import { getLocale, t, tf } from '../i18n';

export const PANEL_DRAG_TYPE = 'application/x-xratu-panel';
export const PANEL_LABELS = { conversation: 'surfaceConversation', changes: 'surfaceChanges', activity: 'surfaceActivity', agents: 'surfaceAgentRuns', background: 'surfaceBackground', browser: 'surfaceBrowser', pullRequests: 'prTitle' } as const;
export const PANEL_ICONS = { conversation: MessageSquare, changes: CodeXml, activity: List, agents: Bot, background: SquareTerminal, browser: Globe, pullRequests: GitPullRequest };
export const tabLabel = (tab: SurfaceTab) => t(isNewTab(tab) ? 'surfaceNewTab' : PANEL_LABELS[tab]);
interface Props {
    location: DockLocation;
    panels: SurfaceTab[];
    active: SurfaceTab | null;
    wide: boolean;
    count: number;
    agentCount?: number;
    backgroundCount?: number;
    dragging: SurfaceTab | null;
    onDrag: (panel: SurfaceTab | null) => void;
    onActivate: (panel: SurfaceTab) => void;
    onMove: (panel: SurfaceTab, to: DockLocation, before?: SurfaceTab) => void;
    onReset: () => void;
    onAdd: (location: DockLocation) => void;
    onClose: (tabs: SurfaceTab[]) => void;
    onReopen: () => void;
    canAdd: boolean;
    canReopen: boolean;
}

export function SurfaceTabs({ location, panels, active, wide, count, agentCount = 0, backgroundCount = 0, dragging, onDrag, onActivate, onMove, onReset, onAdd, onClose, onReopen, canAdd, canReopen }: Props) {
    const locale = getLocale();
    const [menu, setMenu] = useState<SurfaceTab | null>(null);
    const root = useRef<HTMLElement>(null);
    const tabList = useRef<HTMLDivElement>(null);
    const [scroll, setScroll] = useState({ start: false, end: false });
    const trigger = useRef<HTMLButtonElement>(null);
    const returnFocus = useRef<HTMLElement | null>(null);
    const pointer = useRef<{ panel: SurfaceTab; x: number; y: number; moved: boolean } | null>(null);
    const suppressClick = useRef(false);
    useEffect(() => {
        const move = (event: PointerEvent) => {
            const gesture = pointer.current;
            if (!gesture) return;
            if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
            gesture.moved = true; suppressClick.current = true;
            onDrag(gesture.panel);
        };
        const finish = (event: PointerEvent) => {
            const gesture = pointer.current;
            pointer.current = null;
            if (!gesture?.moved) return;
            const target = document.elementFromPoint(event.clientX, event.clientY);
            const nav = target?.closest<HTMLElement>('.dock-tabs');
            const to = nav?.classList.contains('side') || target?.closest('.panel-side,.dock-sidebar') ? 'side' : target?.closest('.work-surface') ? 'main' : null;
            const before = nav ? target?.closest<HTMLElement>('[data-panel]')?.dataset.panel as SurfaceTab | undefined : undefined;
            if (to) onMove(gesture.panel, to, before);
            onDrag(null);
        };
        const cancel = () => { pointer.current = null; onDrag(null); };
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', cancel);
        window.addEventListener('blur', cancel);
        window.addEventListener('keydown', key);
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', finish);
            window.removeEventListener('pointercancel', cancel);
            window.removeEventListener('blur', cancel);
            window.removeEventListener('keydown', key);
        };
    }, [onDrag, onMove]);
    const [over, setOver] = useState(false);
    const destination = location === 'main' ? 'side' : 'main';
    const overflowing = scroll.start || scroll.end;
    const Back = locale === 'fa' ? ChevronRight : ChevronLeft;
    const Forward = locale === 'fa' ? ChevronLeft : ChevronRight;
    const scrollTabs = (forward: boolean) => {
        const list = tabList.current;
        if (list) list.scrollBy(Math.max(100, list.clientWidth * 0.7) * (forward ? 1 : -1) * (locale === 'fa' ? -1 : 1), 0);
    };
    useLayoutEffect(() => {
        const list = tabList.current;
        if (!list) return;
        const measure = () => {
            const maximum = list.scrollWidth - list.clientWidth;
            // Chromium reports negative scrollLeft in RTL; distance is logical.
            const distance = Math.abs(list.scrollLeft);
            const start = maximum > 1 && distance > 1;
            const end = maximum > 1 && distance < maximum - 1;
            setScroll(current => current.start === start && current.end === end ? current : { start, end });
        };
        const wheel = (event: WheelEvent) => {
            if (event.ctrlKey || list.scrollWidth <= list.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
            event.preventDefault();
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientWidth : 1;
            list.scrollBy(event.deltaY * unit * (locale === 'fa' ? -1 : 1), 0);
        };
        measure();
        const observer = new ResizeObserver(() => {
            measure();
            document.getElementById(`surface-tab-${active}`)?.closest('.dock-tab')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
        observer.observe(list);
        list.addEventListener('scroll', measure);
        list.addEventListener('wheel', wheel, { passive: false });
        return () => { observer.disconnect(); list.removeEventListener('scroll', measure); list.removeEventListener('wheel', wheel); };
    }, [active, locale, panels.length]);
    useEffect(() => {
        const frame = requestAnimationFrame(() => document.getElementById(`surface-tab-${active}`)?.closest('.dock-tab')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
        setMenu(null);
        return () => cancelAnimationFrame(frame);
    }, [active, wide, locale, panels.length, overflowing]);
    useEffect(() => {
        setOver(false); setMenu(null);
    }, [dragging, wide]);
    useEffect(() => {
        if (!menu) return;
        root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
        const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setMenu(null); };
        document.addEventListener('pointerdown', outside);
        return () => document.removeEventListener('pointerdown', outside);
    }, [menu]);
    const accepts = (event: DragEvent) => wide && dragging !== null && event.dataTransfer.types.includes(PANEL_DRAG_TYPE);
    return <nav ref={root} className={`surface-tabs dock-tabs ${location}${over ? ' drop-over' : ''}`} aria-label={t(location === 'main' ? 'surfaceMainTabs' : 'surfaceSidebarTabs')}
        onDragOver={(event) => {
            if (!accepts(event)) return;
            event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(true);
        }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); }}
        onDrop={(event) => {
            if (!accepts(event)) return;
            event.preventDefault(); event.stopPropagation(); const panel = event.dataTransfer.getData(PANEL_DRAG_TYPE);
            const before = (event.target as Element).closest<HTMLElement>('[data-panel]')?.dataset.panel as SurfaceTab | undefined;
            if (isSurfaceTab(panel) && panel === dragging) onMove(panel, location, before);
            setOver(false); onDrag(null);
        }}
        onKeyDown={(event) => {
            if (menu) {
                const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); (returnFocus.current ?? trigger.current)?.focus(); }
                else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement);
                    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
                } else if (event.key === 'Tab') setMenu(null);
                return;
            }
            if (!(event.target as HTMLElement).matches('[role="tab"]')) return;
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault(); returnFocus.current = event.target as HTMLElement; setMenu((event.target as HTMLElement).dataset.panel as SurfaceTab); return;
            }
            if (event.key === 'Delete' && (event.target as HTMLElement).dataset.panel !== 'conversation') { event.preventDefault(); onClose([(event.target as HTMLElement).dataset.panel as SurfaceTab]); return; }
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
            const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
            const forward = event.key === (getLocale() === 'fa' ? 'ArrowLeft' : 'ArrowRight');
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (forward ? 1 : -1) + tabs.length) % tabs.length;
            event.preventDefault(); tabs[next]?.click(); tabs[next]?.focus();
        }}>
        {overflowing && <button type="button" className="icon-btn dock-scroll-button" aria-label={t('surfaceScrollTabsBack')} title={t('surfaceScrollTabsBack')} disabled={!scroll.start} onClick={() => scrollTabs(false)}><Back size={14} /></button>}
        <div ref={tabList} className="dock-tab-list" role="tablist">
            {panels.map((panel) => {
                const Icon = isNewTab(panel) ? FilePlus2 : PANEL_ICONS[panel];
                return <div key={panel} className={`dock-tab${active === panel ? ' active' : ''}`} data-panel={panel}
                    // Windows starts autoscroll on mousedown, before auxclick can close the tab.
                    onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
                    onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose([panel]); } }}>
                <button type="button" data-panel={panel} id={`surface-tab-${panel}`} title={tabLabel(panel)} className={`surface-tab ${isNewTab(panel) ? 'new-tab' : panel}${active === panel ? ' active' : ''}`} role="tab" aria-selected={active === panel} tabIndex={active === panel ? 0 : -1} aria-controls={`surface-panel-${panel}`} draggable={wide && panel !== 'conversation'}
                    onPointerDown={event => {
                        if (event.button !== 0) return;
                        suppressClick.current = false;
                        if (!wide || panel === 'conversation') return;
                        // Pointer dragging also works inside VS Code's embedded webview,
                        // where native HTML drag delivery can be intercepted by the host.
                        event.preventDefault(); event.currentTarget.focus();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        pointer.current = { panel, x: event.clientX, y: event.clientY, moved: false };
                    }}
                    onDragStart={(event) => { event.dataTransfer.setData(PANEL_DRAG_TYPE, panel); event.dataTransfer.setData('text/plain', panel); event.dataTransfer.effectAllowed = 'move'; onDrag(panel); }}
                    onDragEnd={() => onDrag(null)} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onActivate(panel); }}
                    onContextMenu={(event) => { event.preventDefault(); returnFocus.current = event.currentTarget; setMenu(panel); }}>
                    <Icon size={13} /><span>{tabLabel(panel)}</span>{panel === 'background' && backgroundCount > 0 && <span className="tab-count" dir="ltr">{backgroundCount}</span>}{panel === 'agents' && agentCount > 0 && <span className="tab-count" dir="ltr">{agentCount}</span>}{panel === 'changes' && count > 0 && <span className="tab-count" dir="ltr">{count}</span>}
                </button>
                {panel !== 'conversation' && <button type="button" tabIndex={-1} className="dock-tab-close" aria-label={tf('surfaceCloseNamedTab', { tab: tabLabel(panel) })} title={t('surfaceCloseTab')} onClick={() => onClose([panel])}><X size={12} /></button>}
                </div>;
            })}
        </div>
        {overflowing && <button type="button" className="icon-btn dock-scroll-button" aria-label={t('surfaceScrollTabsForward')} title={t('surfaceScrollTabsForward')} disabled={!scroll.end} onClick={() => scrollTabs(true)}><Forward size={14} /></button>}
        {panels.length === 0 && <span className="dock-drop-label">{location === 'side' ? <PanelRight size={14} /> : <PanelsTopLeft size={14} />}<span>{t(location === 'side' ? 'surfaceDropSidebar' : 'surfaceDropMain')}</span></span>}
        <div className="dock-tab-actions">
        <button type="button" className="icon-btn dock-add-button" aria-label={t('surfaceAddTab')} title={t('surfaceAddTab')} disabled={!canAdd} onClick={() => onAdd(location)}><Plus size={15} /></button>
        <button ref={trigger} type="button" className="icon-btn dock-layout-button" aria-label={active ? tf('surfaceTabActions', { tab: tabLabel(active) }) : t('surfacePanelLayout')} title={active ? tf('surfaceTabActions', { tab: tabLabel(active) }) : t('surfacePanelLayout')} aria-haspopup="menu" aria-expanded={!!menu} disabled={!active} onClick={() => { returnFocus.current = trigger.current; setMenu(menu ? null : active); }}><MoreHorizontal size={15} /></button>
        </div>
        {menu && <div className="dock-layout-menu" role="menu" aria-label={tf('surfaceTabActions', { tab: tabLabel(menu) })}>
            <div className="dock-menu-title">{tabLabel(menu)}</div>
            {wide && menu !== 'conversation' && <button type="button" role="menuitem" onClick={() => { onMove(menu, destination); setMenu(null); }}>{destination === 'side' ? <PanelRight size={14} /> : <PanelsTopLeft size={14} />}<span>{t(destination === 'side' ? 'surfaceMoveSidebar' : 'surfaceMoveMain')}</span></button>}
            {menu !== 'conversation' && <button type="button" role="menuitem" onClick={() => { onClose([menu]); setMenu(null); }}><X size={14} /><span>{t('surfaceCloseTab')}</span></button>}
            <button type="button" role="menuitem" disabled={!panels.some(panel => panel !== menu && panel !== 'conversation')} onClick={() => { onClose(panels.filter(panel => panel !== menu)); onActivate(menu); setMenu(null); }}><span>{t('surfaceCloseOtherTabs')}</span></button>
            <div className="dock-menu-separator" role="separator" />
            <button type="button" role="menuitem" disabled={!canReopen} onClick={() => { onReopen(); setMenu(null); }}><span>{t('surfaceReopenTab')}</span></button>
            <button type="button" role="menuitem" onClick={() => { onReset(); setMenu(null); requestAnimationFrame(() => document.getElementById('surface-tab-conversation')?.focus()); }}><RotateCcw size={14} /><span>{t('surfaceResetLayout')}</span></button>
        </div>}
    </nav>;
}
