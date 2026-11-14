import { useLayoutEffect, useRef, useState } from 'react';
import { getLocale, t } from '../i18n';
import { getWebviewState, patchWebviewState } from '../vscode';

const MIN = 200, MAX = 360, DEFAULT = 218;
export function NavigationResize() {
    const handle = useRef<HTMLDivElement>(null);
    const drag = useRef<{ x: number; width: number } | null>(null);
    const [width, setWidth] = useState(() => {
        const saved = getWebviewState().navigationWidth;
        return typeof saved === 'number' && Number.isFinite(saved) ? Math.max(MIN, Math.min(MAX, saved)) : DEFAULT;
    });
    useLayoutEffect(() => {
        const app = handle.current?.closest<HTMLElement>('.app');
        app?.style.setProperty('--navigation-desktop-width', `${width}px`);
        patchWebviewState({ navigationWidth: width });
        return () => { app?.style.removeProperty('--navigation-desktop-width'); };
    }, [width]);
    const sign = getLocale() === 'fa' ? -1 : 1;
    const choose = (value: number) => setWidth(Math.round(Math.max(MIN, Math.min(MAX, value))));
    return <div ref={handle} className="navigation-resize" role="separator" tabIndex={0} aria-label={t('surfaceResizeNavigation')} aria-orientation="vertical" aria-valuemin={MIN} aria-valuemax={MAX} aria-valuenow={width}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (drag.current) choose(drag.current.width + (event.clientX - drag.current.x) * sign); }}
        onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
        onLostPointerCapture={() => { drag.current = null; }}
        onDoubleClick={() => choose(DEFAULT)}
        onKeyDown={event => { const value = event.key === 'Home' ? MIN : event.key === 'End' ? MAX : event.key === 'ArrowRight' ? width + 20 * sign : event.key === 'ArrowLeft' ? width - 20 * sign : null; if (value !== null) { event.preventDefault(); choose(value); } }} />;
}
