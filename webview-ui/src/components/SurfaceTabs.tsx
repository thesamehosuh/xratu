import { useEffect, useRef, useState, type DragEvent } from 'react';
import { CodeXml, List, MessageSquare, MoreHorizontal, PanelRight, PanelsTopLeft, RotateCcw } from 'lucide-react';
import { SURFACE_PANELS, type DockLocation, type SurfacePanel } from '../dockLayout';
import { getLocale, t } from '../i18n';

export const PANEL_DRAG_TYPE = 'application/x-xratu-panel';
const labels = { conversation: 'surfaceConversation', changes: 'surfaceChanges', activity: 'surfaceActivity' } as const;
interface Props {
    location: DockLocation;
    panels: SurfacePanel[];
    active: SurfacePanel | null;
    wide: boolean;
    count: number;
    dragging: SurfacePanel | null;
    onDrag: (panel: SurfacePanel | null) => void;
    onActivate: (panel: SurfacePanel) => void;
    onMove: (panel: SurfacePanel, to: DockLocation) => void;
    onReset: () => void;
}

export function SurfaceTabs({ location, panels, active, wide, count, dragging, onDrag, onActivate, onMove, onReset }: Props) {
    const [menu, setMenu] = useState<SurfacePanel | null>(null);
    const root = useRef<HTMLElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
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
            if (SURFACE_PANELS.includes(panel as SurfacePanel) && panel === dragging) onMove(panel as SurfacePanel, location);
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
                const Icon = panel === 'conversation' ? MessageSquare : panel === 'changes' ? CodeXml : List;
                return <button type="button" key={panel} data-panel={panel} id={`surface-tab-${panel}`} className={`surface-tab ${panel}${active === panel ? ' active' : ''}`} role="tab" aria-selected={active === panel} tabIndex={active === panel ? 0 : -1} aria-controls={`surface-panel-${panel}`} draggable={wide && panel !== 'conversation'}
                    onDragStart={(event) => { event.dataTransfer.setData(PANEL_DRAG_TYPE, panel); event.dataTransfer.effectAllowed = 'move'; onDrag(panel); }}
                    onDragEnd={() => onDrag(null)} onClick={() => onActivate(panel)}
                    onContextMenu={(event) => { if (wide) { event.preventDefault(); setMenu(panel); } }}>
                    <Icon size={13} /><span>{t(labels[panel])}</span>{panel === 'changes' && count > 0 && <span className="tab-count" dir="ltr">{count}</span>}
                </button>;
            })}
        </div>
        {panels.length === 0 && <span className="dock-drop-label"><PanelRight size={14} />{t('surfaceDropSidebar')}</span>}
        {wide && active && <button ref={trigger} type="button" className="icon-btn dock-layout-button" aria-label={t('surfacePanelLayout')} title={t('surfacePanelLayout')} aria-haspopup="menu" aria-expanded={!!menu} onClick={() => setMenu(menu ? null : active)}><MoreHorizontal size={15} /></button>}
        {menu && <div className="dock-layout-menu" role="menu" aria-label={t('surfacePanelLayout')}>
            {menu !== 'conversation' && <button type="button" role="menuitem" onClick={() => { onMove(menu, destination); setMenu(null); }}>{destination === 'side' ? <PanelRight size={14} /> : <PanelsTopLeft size={14} />}{t(destination === 'side' ? 'surfaceMoveSidebar' : 'surfaceMoveMain')}</button>}
            <button type="button" role="menuitem" onClick={() => { onReset(); setMenu(null); requestAnimationFrame(() => document.getElementById('surface-tab-conversation')?.focus()); }}><RotateCcw size={14} />{t('surfaceResetLayout')}</button>
        </div>}
    </nav>;
}
