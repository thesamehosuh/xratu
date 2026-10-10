import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

/** A setup panel owns focus and Escape without interrupting the live run. */
export function SidePanel({ label, className, onClose, children }: {
    label: string;
    className: string;
    onClose: () => void;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const close = useRef(onClose);
    useLayoutEffect(() => { close.current = onClose; });
    useEffect(() => {
        const panel = ref.current;
        if (!panel) return;
        const previous = document.activeElement as HTMLElement | null;
        const hidden: Array<[HTMLElement, boolean]> = [];
        let branch: HTMLElement = panel;
        while (branch.parentElement) {
            for (const sibling of branch.parentElement.children) {
                if (sibling !== branch && sibling instanceof HTMLElement) {
                    hidden.push([sibling, sibling.inert]);
                    sibling.inert = true;
                }
            }
            if (branch.parentElement.classList.contains('app')) break;
            branch = branch.parentElement;
        }
        const focusables = () => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href]')]
            .filter((node) => node.getClientRects().length > 0);
        (focusables()[0] ?? panel).focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                if (document.activeElement?.getAttribute('aria-expanded') === 'true') return;
                event.preventDefault();
                event.stopPropagation();
                close.current();
            } else if (event.key === 'Tab') {
                const items = focusables();
                const first = items[0], last = items[items.length - 1];
                if (!first) { event.preventDefault(); panel.focus(); }
                else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
                    event.preventDefault(); last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault(); first.focus();
                }
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            for (const [node, inert] of hidden) node.inert = inert;
            if (previous?.isConnected) previous.focus();
        };
    }, []);
    return (
        <div className="page-drawer-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <div ref={ref} className={className} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
                {children}
            </div>
        </div>
    );
}
