import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SURFACE_PANELS, closeTabs, defaultDockLayout, isNewTab, isSurfaceTab, movePanel, readDockLayout, type DockLocation, type NewTab, type SurfacePanel, type SurfaceTab } from './dockLayout';
import { getWebviewState, patchWebviewState } from './vscode';

export function useDockLayout(agentsAvailable = false, backgroundAvailable = false, changesAvailable = true, pullRequestsAvailable = false, activityAvailable = true, downloadsAvailable = false, browserAvailable = false) {
    const [opened, setOpened] = useState<Set<SurfacePanel>>(() => {
        const saved = getWebviewState().surfaceOpenedPanels;
        return new Set(Array.isArray(saved) ? saved.filter((panel): panel is SurfacePanel => SURFACE_PANELS.includes(panel)) : []);
    });
    useEffect(() => { patchWebviewState({ surfaceOpenedPanels: [...opened] }); }, [opened]);
    const [layout, setLayout] = useState(() => readDockLayout(getWebviewState().surfaceLayout));
    const layoutRef = useRef(layout);
    layoutRef.current = layout;
    const [wide, setWide] = useState(() => window.matchMedia('(min-width: 860px)').matches);
    const [narrowActive, setNarrowActive] = useState<SurfaceTab>(() => {
        const saved = getWebviewState().surfaceActiveTab;
        return isSurfaceTab(saved) ? saved : 'conversation';
    });
    const [sideOpen, setSideOpen] = useState(() => getWebviewState().surfaceSideOpen === true);
    const [tabsChoice, setTabsChoice] = useState<boolean | null>(() => { const saved = getWebviewState().surfaceTabsVisible; return typeof saved === 'boolean' ? saved : null; });
    useEffect(() => { patchWebviewState({ surfaceTabsVisible: tabsChoice, surfaceSideOpen: sideOpen }); }, [tabsChoice, sideOpen]);
    const [dragging, setDragging] = useState<SurfaceTab | null>(null);
    const [recentlyClosed, setRecentlyClosed] = useState<{ tab: SurfaceTab; location: DockLocation }[]>([]);
    const movedTab = useRef<SurfaceTab | null>(null);
    useEffect(() => { patchWebviewState({ surfaceLayout: layout }); }, [layout]);
    useEffect(() => { patchWebviewState({ surfaceActiveTab: narrowActive }); }, [narrowActive]);
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
    const activate = useCallback((panel: SurfaceTab) => {
        if (!isNewTab(panel)) setOpened(current => new Set(current).add(panel));
        setRecentlyClosed(current => current.filter(item => item.tab !== panel));
        setNarrowActive(panel);
        if (layoutRef.current.side.includes(panel)) setSideOpen(true);
        setLayout((current) => {
            const placed = current.main.includes(panel) || current.side.includes(panel) ? current : movePanel(current, panel, 'main');
            const next = { ...placed, [placed.side.includes(panel) ? 'sideActive' : 'mainActive']: panel };
            patchWebviewState({ surfaceLayout: next });
            return next;
        });
    }, []);
    const open = (panel: SurfacePanel, location: DockLocation, replace?: NewTab) => {
        setOpened(current => new Set(current).add(panel));
        setRecentlyClosed(current => current.filter(item => item.tab !== panel));
        setNarrowActive(panel);
        movedTab.current = panel;
        if (replace && allPanels.includes(panel) ? layout.side.includes(panel) : location === 'side') setSideOpen(true);
        setLayout(current => {
            // A picker selects an existing view without moving or duplicating it.
            const alreadyOpen = allPanels.includes(panel);
            const to = panel === 'conversation' ? 'main' : replace && alreadyOpen ? current.side.includes(panel) ? 'side' : 'main' : location;
            const moved = replace && alreadyOpen ? current : movePanel(current, panel, to, replace);
            const filled = replace ? closeTabs(moved, [replace], [...allPanels, panel]) : moved;
            const next = { ...filled, [to === 'main' ? 'mainActive' : 'sideActive']: panel };
            patchWebviewState({ surfaceLayout: next });
            return next;
        });
    };
    const move = (panel: SurfaceTab, location: DockLocation, before?: SurfaceTab) => {
        if (!wide) return;
        if (layout[location].includes(panel) && !before) { setDragging(null); return; }
        movedTab.current = panel;
        if (location === 'side') setSideOpen(true);
        setLayout((current) => {
            const next = movePanel(current, panel, location, before);
            patchWebviewState({ surfaceLayout: next });
            return next;
        });
        setDragging(null);
    };
    const reset = () => {
        const next = defaultDockLayout();
        setSideOpen(false); setTabsChoice(null);
        setOpened(new Set());
        setRecentlyClosed([]);
        setLayout(next); setNarrowActive('conversation'); setDragging(null);
        patchWebviewState({ surfaceLayout: next });
    };
    // Once activity exposes a panel, changing sessions must not remove it or
    // change the selected layout. Only an explicit close hides it again.
    useEffect(() => {
        const available = [agentsAvailable && 'agents', backgroundAvailable && 'background', changesAvailable && 'changes', pullRequestsAvailable && 'pullRequests', activityAvailable && 'activity', downloadsAvailable && 'downloads', browserAvailable && 'browser'].filter(Boolean) as SurfacePanel[];
        setOpened(current => available.every(panel => current.has(panel)) ? current : new Set([...current, ...available]));
    }, [agentsAvailable, backgroundAvailable, changesAvailable, pullRequestsAvailable, activityAvailable, downloadsAvailable, browserAvailable]);
    const available = (panel: SurfaceTab) => isNewTab(panel) || opened.has(panel) || panel === 'conversation';
    const mainPanels = layout.main.filter(available);
    const sidePanels = layout.side.filter(available);
    const allPanels = [...mainPanels, ...sidePanels];
    const wanted = wide ? layout.mainActive : narrowActive;
    const mainActive = wide ? wanted && mainPanels.includes(wanted) ? wanted : mainPanels[0] ?? null : allPanels.includes(narrowActive) ? narrowActive : 'conversation';
    const sideActive = wide && sideOpen ? layout.sideActive && sidePanels.includes(layout.sideActive) ? layout.sideActive : sidePanels[0] ?? null : null;
    const close = (tabs: SurfaceTab[]) => {
        const closing = tabs.filter(tab => tab !== 'conversation' && allPanels.includes(tab));
        if (!closing.length) return;
        setRecentlyClosed(current => [...current, ...closing.map(tab => ({ tab, location: layout.side.includes(tab) ? 'side' as const : 'main' as const }))].slice(-20));
        const next = closeTabs(layout, closing, allPanels);
        const remaining = allPanels.filter(tab => !closing.includes(tab));
        const nextActive = closing.includes(narrowActive) ? remaining[Math.min(allPanels.indexOf(narrowActive), remaining.length - 1)] ?? 'conversation' : narrowActive;
        setNarrowActive(nextActive);
        movedTab.current = wide ? (layout.side.includes(closing[0]) ? next.sideActive : next.mainActive) ?? 'conversation' : nextActive;
        setLayout(next);
        setDragging(null);
    };
    const canAdd = [...layout.main, ...layout.side].filter(isNewTab).length < 32;
    const [picker, setPicker] = useState<DockLocation | null>(null);
    const add = (location: DockLocation) => setPicker(location);
    const choose = (panel: SurfacePanel) => {
        if (!picker) return;
        setTabsChoice(true);
        // Existing panels retain their placement when selected in the picker.
        const placed = allPanels.includes(panel) ? layout.side.includes(panel) ? 'side' : 'main' : picker;
        open(panel, placed);
        setPicker(null);
    };
    const reopen = () => {
        const last = recentlyClosed.at(-1);
        if (!last || (isNewTab(last.tab) && !canAdd)) return;
        setRecentlyClosed(current => current.slice(0, -1));
        if (!isNewTab(last.tab)) setOpened(current => new Set(current).add(last.tab as SurfacePanel));
        movedTab.current = last.tab;
        if (last.location === 'side') setSideOpen(true);
        setLayout(current => {
            const moved = movePanel(current, last.tab, last.location);
            return { ...moved, [last.location === 'main' ? 'mainActive' : 'sideActive']: last.tab };
        });
        setNarrowActive(last.tab);
    };
    const position = (panel: SurfaceTab) => `${wide && layout.side.includes(panel) ? 'panel-side' : 'panel-main'}${mainActive !== panel && sideActive !== panel ? ' panel-hidden' : ''}`;
    const tabsVisible = tabsChoice ?? allPanels.length > 1;
    return { picker, dismissPicker: () => setPicker(null), choose, tabsVisible, toggleTabs: () => setTabsChoice(!tabsVisible), sideOpen, toggleSide: () => setSideOpen(current => !current), layout, mainPanels, sidePanels, allPanels, wide, mainActive, sideActive, dragging, setDragging, activate, move, open, reset, position, close, add, canAdd, reopen, canReopen: recentlyClosed.length > 0 };
}
