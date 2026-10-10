import { useCallback, useEffect, useState } from 'react';
import { SURFACE_PANELS, defaultDockLayout, movePanel, readDockLayout, type DockLocation, type SurfacePanel } from './dockLayout';
import { getWebviewState, patchWebviewState } from './vscode';

export function useDockLayout(agentsAvailable = false, backgroundAvailable = false) {
    const [layout, setLayout] = useState(() => readDockLayout(getWebviewState().surfaceLayout));
    const [wide, setWide] = useState(() => window.matchMedia('(min-width: 860px)').matches);
    const [narrowActive, setNarrowActive] = useState<SurfacePanel>('conversation');
    const [dragging, setDragging] = useState<SurfacePanel | null>(null);
    useEffect(() => {
        const media = window.matchMedia('(min-width: 860px)');
        const sync = () => { setWide(media.matches); setDragging(null); };
        media.addEventListener('change', sync);
        return () => media.removeEventListener('change', sync);
    }, []);
    const activate = useCallback((panel: SurfacePanel) => {
        setNarrowActive(panel);
        setLayout((current) => {
            const next = { ...current, [current.side.includes(panel) ? 'sideActive' : 'mainActive']: panel };
            patchWebviewState({ surfaceLayout: next });
            return next;
        });
    }, []);
    const move = (panel: SurfacePanel, location: DockLocation) => {
        if (!wide) return;
        setLayout((current) => {
            const next = movePanel(current, panel, location);
            patchWebviewState({ surfaceLayout: next });
            return next;
        });
        setDragging(null);
        requestAnimationFrame(() => document.getElementById(`surface-tab-${panel}`)?.focus());
    };
    const reset = () => {
        const next = defaultDockLayout();
        setLayout(next); setNarrowActive('conversation'); setDragging(null);
        patchWebviewState({ surfaceLayout: next });
    };
    const available = (panel: SurfacePanel) => panel === 'agents' ? agentsAvailable : panel === 'background' ? backgroundAvailable : true;
    const mainPanels = layout.main.filter(available);
    const sidePanels = layout.side.filter(available);
    const allPanels = SURFACE_PANELS.filter(available);
    const wanted = wide ? layout.mainActive : narrowActive;
    const mainActive = available(wanted) ? wanted : 'conversation';
    const sideActive = wide ? layout.sideActive && available(layout.sideActive) ? layout.sideActive : sidePanels[0] ?? null : null;
    const position = (panel: SurfacePanel) => `${wide && layout.side.includes(panel) ? 'panel-side' : 'panel-main'}${mainActive !== panel && sideActive !== panel ? ' panel-hidden' : ''}`;
    return { layout, mainPanels, sidePanels, allPanels, wide, mainActive, sideActive, dragging, setDragging, activate, move, reset, position };
}
