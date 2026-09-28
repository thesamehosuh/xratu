import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Room for a popup anchored to `el`, bounded by the clipping ancestors (a
 * card hides its overflow) and the viewport. A popup must fit, flip, or
 * shrink - never be cut in half.
 */
export function popupSpace(el: HTMLElement): { above: number; below: number } {
    const rect = el.getBoundingClientRect();
    const clip = el.closest('.settings-card')?.getBoundingClientRect();
    const scroll = el.closest('.settings-scroll')?.getBoundingClientRect();
    const top = Math.max(clip?.top ?? 0, scroll?.top ?? 0, 0);
    const bottom = Math.min(
        clip?.bottom ?? window.innerHeight,
        scroll?.bottom ?? window.innerHeight,
        window.innerHeight,
    );
    return {
        above: Math.max(0, rect.top - 4 - top),
        below: Math.max(0, bottom - (rect.bottom + 4)),
    };
}

/** Below/above the anchor, whichever has more room, plus the height cap that
 *  keeps the popup inside the card. A pathologically tight card falls back to
 *  the full height rather than a one-row sliver. */
export function popupPlacement(el: HTMLElement, maxHeight: number): { up: boolean; cap: number | undefined } {
    const { above, below } = popupSpace(el);
    const up = above > below;
    const space = up ? above : below;
    return { up, cap: space < 64 ? undefined : Math.min(maxHeight, space) };
}

/**
 * The app's shared dropdown (used by the Usage and Proxy pages). A native
 * <select> cannot match the UI: its popup list is drawn by the OS (light on
 * dark hosts, unstyleable) and it paints the focus ring on plain mouse
 * clicks. This is the app's own trigger + listbox with the usual tokens,
 * RTL-safe placement and keyboard handling.
 */
export function Dropdown({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
}) {
    const [open, setOpen] = useState(false);
    /** Cards clip their overflow: flip and shrink the list to fit inside. */
    const [placement, setPlacement] = useState<{ up: boolean; cap: number | undefined }>({ up: false, cap: undefined });
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const current = options.find((o) => o.value === value) ?? options[0];

    useLayoutEffect(() => {
        if (!open || !triggerRef.current) return;
        setPlacement(popupPlacement(triggerRef.current, 190));
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [open]);

    // Opening lands focus on the current option, so arrows and Enter work.
    useEffect(() => {
        if (!open) return;
        const items = listRef.current?.querySelectorAll<HTMLElement>('.dropdown-option');
        if (!items?.length) return;
        const selected = [...items].find((el) => el.getAttribute('aria-selected') === 'true');
        (selected ?? items[0]).focus();
    }, [open]);

    const focusOption = (index: number) => {
        const items = listRef.current?.querySelectorAll<HTMLElement>('.dropdown-option');
        if (!items?.length) return;
        items[Math.min(items.length - 1, Math.max(0, index))]?.focus();
    };

    const step = (delta: 1 | -1) => {
        const items = [...(listRef.current?.querySelectorAll<HTMLElement>('.dropdown-option') ?? [])];
        focusOption(items.indexOf(document.activeElement as HTMLElement) + delta);
    };

    const pick = (next: string) => {
        onChange(next);
        setOpen(false);
        triggerRef.current?.focus();
    };

    return (
        <div className="dropdown" ref={rootRef}>
            <button
                ref={triggerRef}
                type="button"
                className="dropdown-trigger"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={label}
                onClick={() => setOpen((wasOpen) => !wasOpen)}
                onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        setOpen(true);
                    }
                }}
            >
                <span className="dropdown-value" dir="auto">{current?.label ?? ''}</span>
                <ChevronDown size={12} className="dropdown-caret" aria-hidden="true" />
            </button>
            {open && (
                <div
                    ref={listRef}
                    className={`dropdown-list${placement.up ? ' up' : ''}`}
                    role="listbox"
                    aria-label={label}
                    style={placement.cap != null ? { maxHeight: `${placement.cap}px` } : undefined}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            setOpen(false);
                            triggerRef.current?.focus();
                        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                            e.preventDefault();
                            step(e.key === 'ArrowDown' ? 1 : -1);
                        } else if (e.key === 'Home' || e.key === 'End') {
                            e.preventDefault();
                            focusOption(e.key === 'Home' ? 0 : Number.MAX_SAFE_INTEGER);
                        } else if (e.key === 'Tab') {
                            setOpen(false);
                        }
                    }}
                >
                    {options.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            role="option"
                            className="dropdown-option"
                            aria-selected={option.value === value}
                            onClick={() => pick(option.value)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
