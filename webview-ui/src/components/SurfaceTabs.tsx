import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Bot, CodeXml, GitPullRequest, Globe, List, MessageSquare, MoreHorizontal, PanelRight, PanelsTopLeft, RotateCcw, SquareTerminal } from 'lucide-react';
import { SURFACE_PANELS, type DockLocation, type SurfacePanel } from '../dockLayout';
import { getLocale, t } from '../i18n';

export const PANEL_DRAG_TYPE = 'application/x-xratu-panel';
const labels = { conversation: 'surfaceConversation', changes: 'surfaceChanges', activity: 'surfaceActivity', agents: 'surfaceAgentRuns', background: 'surfaceBackground', browser: 'surfaceBrowser', pullRequests: 'prTitle' } as const;
interface Props {
    location: DockLocation;
    panels: SurfacePanel[];
    active: SurfacePanel | null;
    wide: boolean;
    count: number;
    agentCount?: number;
    backgroundCount?: number;
    dragging: SurfacePanel | null;
    onDrag: (panel: SurfacePanel | null) => void;
    onActivate: (panel: SurfacePanel) => void;
    onMove: (panel: SurfacePanel, to: DockLocation, before?: SurfacePanel) => void;
    onReset: () => void;
    onOpen?: (panel: SurfacePanel, location: DockLocation) => void;
}

export function SurfaceTabs({ location, panels, active, wide, count, agentCount = 0, backgroundCount = 0, dragging, onDrag, onActivate, onMove, onReset, onOpen }: Props) {
    const [menu, setMenu] = useState<SurfacePanel | 'open' | null>(null);
    const root = useRef<HTMLElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const pointer = useRef<{ panel: SurfacePanel; x: number; y: number; moved: boolean } | null>(null);
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
            const before = nav ? target?.closest<HTMLElement>('[data-panel]')?.dataset.panel as SurfacePanel | undefined : undefined;
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
    useEffect(() => {
        setOver(false); setMenu(null);
    }, [dragging, wide]);
    useEffect(() => {
        if (!menu) return;
        root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
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
            const before = (event.target as Element).closest<HTMLElement>('[data-panel]')?.dataset.panel as SurfacePanel | undefined;
            if (SURFACE_PANELS.includes(panel as SurfacePanel) && panel === dragging) onMove(panel as SurfacePanel, location, before);
            setOver(false); onDrag(null);
        }}
        onKeyDown={(event) => {
            if (menu) {
                const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); trigger.current?.focus(); }
                else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement);
                    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
                } else if (event.key === 'Tab') setMenu(null);
                return;
            }
            if (!(event.target as HTMLElement).matches('[role="tab"]')) return;
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault(); if (wide) setMenu((event.target as HTMLElement).dataset.panel as SurfacePanel); return;
            }
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
            const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
            const forward = event.key === (getLocale() === 'fa' ? 'ArrowLeft' : 'ArrowRight');
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (forward ? 1 : -1) + tabs.length) % tabs.length;
            event.preventDefault(); tabs[next]?.click(); tabs[next]?.focus();
        }}>
        <div className="dock-tab-list" role="tablist">
            {panels.map((panel) => {
                const Icon = panel === 'conversation' ? MessageSquare : panel === 'changes' ? CodeXml : panel === 'agents' ? Bot : panel === 'background' ? SquareTerminal : panel === 'browser' ? Globe : panel === 'pullRequests' ? GitPullRequest : List;
                return <button type="button" key={panel} data-panel={panel} id={`surface-tab-${panel}`} className={`surface-tab ${panel}${active === panel ? ' active' : ''}`} role="tab" aria-selected={active === panel} tabIndex={active === panel ? 0 : -1} aria-controls={`surface-panel-${panel}`} draggable={wide}
                    onPointerDown={event => {
                        if (!wide || event.button !== 0) return;
                        // Pointer dragging also works inside VS Code's embedded webview,
                        // where native HTML drag delivery can be intercepted by the host.
                        event.preventDefault(); event.currentTarget.focus();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        suppressClick.current = false;
                        pointer.current = { panel, x: event.clientX, y: event.clientY, moved: false };
                    }}
                    onDragStart={(event) => { event.dataTransfer.setData(PANEL_DRAG_TYPE, panel); event.dataTransfer.setData('text/plain', panel); event.dataTransfer.effectAllowed = 'move'; onDrag(panel); }}
                    onDragEnd={() => onDrag(null)} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onActivate(panel); }}
                    onContextMenu={(event) => { if (wide) { event.preventDefault(); setMenu(panel); } }}>
                    <Icon size={13} /><span>{t(labels[panel])}</span>{panel === 'background' && backgroundCount > 0 && <span className="tab-count" dir="ltr">{backgroundCount}</span>}{panel === 'agents' && agentCount > 0 && <span className="tab-count" dir="ltr">{agentCount}</span>}{panel === 'changes' && count > 0 && <span className="tab-count" dir="ltr">{count}</span>}
                </button>;
            })}
        </div>
        {panels.length === 0 && <span className="dock-drop-label">{location === 'side' ? <PanelRight size={14} /> : <PanelsTopLeft size={14} />}<span>{t(location === 'side' ? 'surfaceDropSidebar' : 'surfaceDropMain')}</span></span>}
        <button ref={trigger} type="button" className="icon-btn dock-layout-button" aria-label={t('surfacePanelLayout')} title={t('surfacePanelLayout')} aria-haspopup="menu" aria-expanded={!!menu} onClick={() => setMenu(menu ? null : 'open')}><MoreHorizontal size={15} /></button>
        {menu && <div className="dock-layout-menu" role="menu" aria-label={t('surfacePanelLayout')}>
            {wide && menu !== 'open' && <button type="button" role="menuitem" onClick={() => { onMove(menu, destination); setMenu(null); }}>{destination === 'side' ? <PanelRight size={14} /> : <PanelsTopLeft size={14} />}<span>{t(destination === 'side' ? 'surfaceMoveSidebar' : 'surfaceMoveMain')}</span></button>}
            {onOpen && SURFACE_PANELS.flatMap(panel => (wide ? ['main', 'side'] as const : ['main'] as const).map(to => <button type="button" role="menuitem" key={`${panel}-${to}`} onClick={() => { onOpen(panel, to); setMenu(null); }}><span>{t(labels[panel])}</span><span>{t(to === 'main' ? 'surfaceMainTabs' : 'surfaceSidebarTabs')}</span></button>))}
            <button type="button" role="menuitem" onClick={() => { onReset(); setMenu(null); requestAnimationFrame(() => document.getElementById('surface-tab-conversation')?.focus()); }}><RotateCcw size={14} /><span>{t('surfaceResetLayout')}</span></button>
        </div>}
    </nav>;
}
