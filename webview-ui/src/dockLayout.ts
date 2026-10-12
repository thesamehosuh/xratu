/** Placement belongs to the work surface; panel contents keep their own state. */
export const SURFACE_PANELS = ['conversation', 'changes', 'activity', 'agents', 'background', 'browser'] as const;
export type SurfacePanel = typeof SURFACE_PANELS[number];
export type DockLocation = 'main' | 'side';
export interface DockLayout {
    version: 1;
    main: SurfacePanel[];
    side: SurfacePanel[];
    mainActive: SurfacePanel | null;
    sideActive: SurfacePanel | null;
}

export function defaultDockLayout(): DockLayout {
    return { version: 1, main: ['conversation', 'activity', 'agents', 'background', 'browser'], side: ['changes'], mainActive: 'conversation', sideActive: 'changes' };
}

export function readDockLayout(value: unknown): DockLayout {
    if (!value || typeof value !== 'object') return defaultDockLayout();
    const candidate = value as Partial<DockLayout>;
    if (candidate.version !== 1 || !Array.isArray(candidate.main) || !Array.isArray(candidate.side)) return defaultDockLayout();
    const all = [...candidate.main, ...candidate.side];
    // Reject partial, duplicate or unknown placements; older layouts gain new panels.
    if (all.length < 3 || all.length > SURFACE_PANELS.length || !['conversation', 'changes', 'activity'].every(id => all.includes(id as SurfacePanel)) || new Set(all).size !== all.length || all.some((id) => !SURFACE_PANELS.includes(id))) return defaultDockLayout();
    const main = [...candidate.main, ...SURFACE_PANELS.filter(panel => !all.includes(panel))];
    return {
        version: 1, main, side: [...candidate.side],
        mainActive: main.includes(candidate.mainActive!) ? candidate.mainActive! : main[0] ?? null,
        sideActive: candidate.side.includes(candidate.sideActive!) ? candidate.sideActive! : candidate.side[0] ?? null,
    };
}

export function movePanel(layout: DockLayout, panel: SurfacePanel, to: DockLocation, before?: SurfacePanel): DockLayout {
    if (before === panel || (layout[to].includes(panel) && !before)) return layout;
    const main = layout.main.filter((id) => id !== panel);
    const side = layout.side.filter((id) => id !== panel);
    const destination = to === 'main' ? main : side;
    const index = before ? destination.indexOf(before) : -1;
    destination.splice(index < 0 ? destination.length : index, 0, panel);
    return {
        version: 1, main, side,
        mainActive: to === 'main' ? panel : layout.mainActive && main.includes(layout.mainActive) ? layout.mainActive : main[0] ?? null,
        sideActive: to === 'side' ? panel : side.includes(layout.sideActive!) ? layout.sideActive : side[0] ?? null,
    };
}
