/** Placement belongs to the work surface; panel contents keep their own state. */
export const SURFACE_PANELS = ['conversation', 'changes', 'activity'] as const;
export type SurfacePanel = typeof SURFACE_PANELS[number];
export type DockLocation = 'main' | 'side';
export interface DockLayout {
    version: 1;
    main: SurfacePanel[];
    side: SurfacePanel[];
    mainActive: SurfacePanel;
    sideActive: SurfacePanel | null;
}

export function defaultDockLayout(): DockLayout {
    return { version: 1, main: ['conversation', 'activity'], side: ['changes'], mainActive: 'conversation', sideActive: 'changes' };
}

export function readDockLayout(value: unknown): DockLayout {
    if (!value || typeof value !== 'object') return defaultDockLayout();
    const candidate = value as Partial<DockLayout>;
    if (candidate.version !== 1 || !Array.isArray(candidate.main) || !Array.isArray(candidate.side)) return defaultDockLayout();
    const all = [...candidate.main, ...candidate.side];
    // Reject partial, duplicate, unknown or pinned-conversation placements.
    if (all.length !== SURFACE_PANELS.length || new Set(all).size !== all.length || all.some((id) => !SURFACE_PANELS.includes(id)) || !candidate.main.includes('conversation')) return defaultDockLayout();
    return {
        version: 1, main: [...candidate.main], side: [...candidate.side],
        mainActive: candidate.main.includes(candidate.mainActive!) ? candidate.mainActive! : 'conversation',
        sideActive: candidate.side.includes(candidate.sideActive!) ? candidate.sideActive! : candidate.side[0] ?? null,
    };
}

export function movePanel(layout: DockLayout, panel: SurfacePanel, to: DockLocation): DockLayout {
    if (panel === 'conversation' || layout[to].includes(panel)) return layout;
    const main = layout.main.filter((id) => id !== panel);
    const side = layout.side.filter((id) => id !== panel);
    (to === 'main' ? main : side).push(panel);
    return {
        version: 1, main, side,
        mainActive: to === 'main' ? panel : main.includes(layout.mainActive) ? layout.mainActive : 'conversation',
        sideActive: to === 'side' ? panel : side.includes(layout.sideActive!) ? layout.sideActive : side[0] ?? null,
    };
}
