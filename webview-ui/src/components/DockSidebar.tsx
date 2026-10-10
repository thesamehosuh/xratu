import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getLocale, t } from '../i18n';
import { getWebviewState, patchWebviewState } from '../vscode';

const MIN_WIDTH = 260;
const MAX_WIDTH = 600;

export function DockSidebar({ children, active, dragging }: { children: ReactNode; active: boolean; dragging: boolean }) {
    const pane = useRef<HTMLElement>(null);
    const drag = useRef<{ x: number; width: number; sign: number } | null>(null);
    const [preferred, setPreferred] = useState<number | null>(() => {
        const saved = getWebviewState().reviewSidebarWidth;
        return typeof saved === 'number' && Number.isFinite(saved) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, saved)) : null;
    });
    const [width, setWidth] = useState(350);
    const [maximum, setMaximum] = useState(MAX_WIDTH);
    const [resizing, setResizing] = useState(false);

    useEffect(() => {
        const surface = pane.current?.parentElement;
        if (!surface) return;
        const update = () => {
            const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, surface.clientWidth - 360));
            setMaximum(max);
            if (preferred === null) surface.style.removeProperty('--review-width');
            else surface.style.setProperty('--review-width', `${Math.min(max, preferred)}px`);
            setWidth(Math.round(pane.current?.getBoundingClientRect().width ?? 350));
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(surface);
        return () => observer.disconnect();
    }, [preferred, active]);

    const chooseWidth = (next: number) => setPreferred(Math.round(Math.max(MIN_WIDTH, Math.min(maximum, next))));
    const save = (next: number | null) => patchWebviewState({ reviewSidebarWidth: next });

    return <aside ref={pane} className={`dock-sidebar${active ? ' active' : ''}${dragging ? ' drag-target' : ''}${resizing ? ' resizing' : ''}`} aria-label={t('surfaceSidebarTabs')}>
        <div className="review-resize" role="separator" tabIndex={0} aria-label={t('surfaceResizeReview')} aria-orientation="vertical" aria-controls="surface-panel-changes surface-panel-activity surface-panel-agents surface-panel-background" aria-valuemin={MIN_WIDTH} aria-valuemax={maximum} aria-valuenow={width}
            onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault(); event.currentTarget.focus();
                drag.current = { x: event.clientX, width, sign: getLocale() === 'fa' ? 1 : -1 };
                event.currentTarget.setPointerCapture(event.pointerId); setResizing(true);
            }}
            onPointerMove={(event) => {
                if (drag.current) chooseWidth(drag.current.width + (event.clientX - drag.current.x) * drag.current.sign);
            }}
            onPointerUp={(event) => {
                if (!drag.current) return;
                drag.current = null; setResizing(false); save(preferred);
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onLostPointerCapture={() => { drag.current = null; setResizing(false); }}
            onDoubleClick={() => { setPreferred(null); save(null); }}
            onKeyDown={(event) => {
                const sign = getLocale() === 'fa' ? 1 : -1;
                const next = event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maximum : event.key === 'ArrowLeft' ? width - 20 * sign : event.key === 'ArrowRight' ? width + 20 * sign : null;
                if (next === null) return;
                event.preventDefault(); const bounded = Math.max(MIN_WIDTH, Math.min(maximum, next));
                chooseWidth(bounded); save(bounded);
            }}
        />
        {children}
    </aside>;
}
