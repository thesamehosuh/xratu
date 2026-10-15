import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SURFACE_PANELS, defaultDockLayout, movePanel, readDockLayout, type DockLocation, type SurfacePanel } from './dockLayout';
import { getWebviewState, patchWebviewState } from './vscode';

export function useDockLayout(agentsAvailable = false, backgroundAvailable = false, changesAvailable = true, pullRequestsAvailable = false) {
    const [layout, setLayout] = useState(() => readDockLayout(getWebviewState().surfaceLayout));
    const [wide, setWide] = useState(() => window.matchMedia('(min-width: 860px)').matches);
    const [narrowActive, setNarrowActive] = useState<SurfacePanel>('conversation');
    const [dragging, setDragging] = useState<SurfacePanel | null>(null);
    const movedTab = useRef<SurfacePanel | null>(null);
    useLayoutEffect(() => {
        if (!movedTab.current) return;
        document.getElementById(`surface-tab-${movedTab.current}`)?.focus();
        movedTab.current = null;
    }, [layout]);
    useEffect(() => {
        // A moved tab can be removed from its old nav before dragend bubbles.
        const finish = () => setDragging(null);
        const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(); };
        window.addEventListener('dragend', finish, true);
        window.addEventListener('drop', finish);
        window.addEventListener('blur', finish);
        window.addEventListener('keydown', cancel);
        return () => {
            window.removeEventListener('dragend', finish, true);
            window.removeEventListener('drop', finish);
            window.removeEventListener('blur', finish);
            window.removeEventListener('keydown', cancel);
        };
    }, []);
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
    const move = (panel: SurfacePanel, location: DockLocation, before?: SurfacePanel) => {
        if (!wide) return;
        if (layout[location].includes(panel) && !before) { setDragging(null); return; }
        movedTab.current = panel;
        setLayout((current) => {
            const next = movePanel(current, panel, location, before);
            patchWebviewState({ surfaceLayout: next });
            return next;
        });
        setDragging(null);
    };
    const reset = () => {
        const next = defaultDockLayout();
        setLayout(next); setNarrowActive('conversation'); setDragging(null);
        patchWebviewState({ surfaceLayout: next });
    };
    const available = (panel: SurfacePanel) => panel === 'changes' ? changesAvailable : panel === 'agents' ? agentsAvailable : panel === 'background' ? backgroundAvailable : panel === 'pullRequests' ? pullRequestsAvailable : true;
    const mainPanels = layout.main.filter(available);
    const sidePanels = layout.side.filter(available);
    const allPanels = SURFACE_PANELS.filter(available);
    const wanted = wide ? layout.mainActive : narrowActive;
    const mainActive = wide ? wanted && mainPanels.includes(wanted) ? wanted : mainPanels[0] ?? null : available(narrowActive) ? narrowActive : 'conversation';
    const sideActive = wide ? layout.sideActive && available(layout.sideActive) ? layout.sideActive : sidePanels[0] ?? null : null;
    const position = (panel: SurfacePanel) => `${wide && layout.side.includes(panel) ? 'panel-side' : 'panel-main'}${mainActive !== panel && sideActive !== panel ? ' panel-hidden' : ''}`;
    return { layout, mainPanels, sidePanels, allPanels, wide, mainActive, sideActive, dragging, setDragging, activate, move, reset, position };
}
