/** Placement belongs to the work surface; panel contents keep their own state. */
export const SURFACE_PANELS = ['conversation', 'changes', 'activity', 'agents', 'background', 'downloads', 'browser', 'pullRequests'] as const;
export type SurfacePanel = typeof SURFACE_PANELS[number];
export type NewTab = `new-${string}`;
export type SurfaceTab = SurfacePanel | NewTab;
export function isNewTab(value: unknown): value is NewTab {
    return typeof value === 'string' && /^new-[a-zA-Z0-9-]{1,64}$/.test(value);
}
export function isSurfaceTab(value: unknown): value is SurfaceTab {
    return SURFACE_PANELS.includes(value as SurfacePanel) || isNewTab(value);
}
export type DockLocation = 'main' | 'side';
export interface DockLayout {
    version: 4;
    main: SurfaceTab[];
    side: SurfaceTab[];
    mainActive: SurfaceTab | null;
    sideActive: SurfaceTab | null;
}

export function defaultDockLayout(): DockLayout {
    return { version: 4, main: ['conversation', 'activity', 'agents', 'background', 'downloads', 'pullRequests'], side: ['changes', 'browser'], mainActive: 'conversation', sideActive: 'changes' };
}

export function readDockLayout(value: unknown): DockLayout {
    if (!value || typeof value !== 'object') return defaultDockLayout();
    const candidate = value as Partial<Omit<DockLayout, 'version'>> & { version?: number };
    if (![1, 2, 3, 4].includes(candidate.version ?? 0) || !Array.isArray(candidate.main) || !Array.isArray(candidate.side)) return defaultDockLayout();
    const all = [...candidate.main, ...candidate.side];
    // v3+ preserve closed tabs; v4 adds Downloads once on upgrade.
    if (all.length > 40 || !all.includes('conversation') || new Set(all).size !== all.length || all.some(id => !isSurfaceTab(id)) || ((candidate.version ?? 0) < 3 && !['changes', 'activity'].every(id => all.includes(id as SurfacePanel)))) return defaultDockLayout();
    const main = candidate.main.filter(panel => candidate.version !== 1 || panel !== 'pullRequests');
    const side: SurfaceTab[] = candidate.side.filter(panel => panel !== 'conversation');
    if (!main.includes('conversation')) main.unshift('conversation');
    if ((candidate.version ?? 0) < 3) {
        main.push(...SURFACE_PANELS.filter(panel => panel !== 'pullRequests' && !all.includes(panel)));
        if (!all.includes('pullRequests') || (candidate.version === 1 && candidate.main.includes('pullRequests'))) side.push('pullRequests');
    }
    if (candidate.version === 3 && !all.includes('downloads')) main.push('downloads');
    return {
        version: 4, main, side,
        mainActive: main.includes(candidate.mainActive!) ? candidate.mainActive! : main[0] ?? null,
        sideActive: side.includes(candidate.sideActive!) ? candidate.sideActive! : side[0] ?? null,
    };
}

export function movePanel(layout: DockLayout, panel: SurfaceTab, to: DockLocation, before?: SurfaceTab): DockLayout {
    if (panel === 'conversation' && to === 'side') return layout;
    if (before === panel || (layout[to].includes(panel) && !before)) return layout;
    const main = layout.main.filter((id) => id !== panel);
    const side = layout.side.filter((id) => id !== panel);
    const destination = to === 'main' ? main : side;
    const index = before ? destination.indexOf(before) : -1;
    destination.splice(index < 0 ? destination.length : index, 0, panel);
    return {
        version: 4, main, side,
        mainActive: to === 'main' ? panel : layout.mainActive && main.includes(layout.mainActive) ? layout.mainActive : main[0] ?? null,
        sideActive: to === 'side' ? panel : side.includes(layout.sideActive!) ? layout.sideActive : side[0] ?? null,
    };
}

/** Closing a view never changes its contents or the underlying running work. */
export function closeTabs(layout: DockLayout, tabs: SurfaceTab[], visible: SurfaceTab[]): DockLayout {
    const removed = new Set<SurfaceTab>(tabs.filter(tab => tab !== 'conversation'));
    const next = { ...layout, main: layout.main.filter(tab => !removed.has(tab)), side: layout.side.filter(tab => !removed.has(tab)) };
    for (const location of ['main', 'side'] as const) {
        const key = location === 'main' ? 'mainActive' : 'sideActive';
        const current = layout[key];
        if (!current || !removed.has(current)) continue;
        const index = layout[location].indexOf(current);
        const available = layout[location].filter(tab => visible.includes(tab) && !removed.has(tab));
        next[key] = available.find(tab => layout[location].indexOf(tab) >= index) ?? available.at(-1) ?? null;
    }
    return next;
}
