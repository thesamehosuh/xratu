import { useCallback, useEffect, useState } from 'react';
import { defaultDockLayout, movePanel, readDockLayout, type DockLocation, type SurfacePanel } from './dockLayout';
import { getWebviewState, patchWebviewState } from './vscode';

export function useDockLayout() {
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
    const mainActive = wide ? layout.mainActive : narrowActive;
    const sideActive = wide ? layout.sideActive : null;
    const position = (panel: SurfacePanel) => `${wide && layout.side.includes(panel) ? 'panel-side' : 'panel-main'}${mainActive !== panel && sideActive !== panel ? ' panel-hidden' : ''}`;
    return { layout, wide, mainActive, sideActive, dragging, setDragging, activate, move, reset, position };
}
