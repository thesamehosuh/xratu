import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, GitBranch } from 'lucide-react';
import { t } from '../i18n';

interface BranchPickerProps {
    /** Local branches (null until the host answers). */
    branches: string[] | null;
    current: string | null;
    onPick: (branch: string) => void;
    onClose: () => void;
}

/**
 * Branch drop-up for the git status line.
 *
 * It opens ABOVE the composer card in the same popup slot as the @-mention
 * picker and deliberately reuses that popup's markup and styles
 * (`.model-pop` for the anchored box, `.mention-head` / `.mention-list` /
 * `.mention-item` for the rows), so the two pickers cannot drift apart.
 *
 * Fully keyboard driven: the filter field takes focus on open, arrows move,
 * Enter switches, Escape closes.
 */
export function BranchPicker({ branches, current, onPick, onClose }: BranchPickerProps) {
    const [query, setQuery] = useState('');
    const [idx, setIdx] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const popRef = useRef<HTMLDivElement | null>(null);

    const matches = useMemo(() => {
        const list = branches ?? [];
        const q = query.trim().toLowerCase();
        return q ? list.filter((b) => b.toLowerCase().includes(q)) : list;
    }, [branches, query]);

    // Keep the highlight in range as the filter narrows under it.
    useEffect(() => {
        setIdx((i) => Math.min(i, Math.max(0, matches.length - 1)));
    }, [matches.length]);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    // Clicking outside discards the picker (Escape already did). The TRIGGER is
    // excluded: the status line toggles the picker itself, so closing here too
    // would immediately reopen it in the same gesture.
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const target = e.target as Element | null;
            if (!target) return;
            if (popRef.current?.contains(target)) return;
            if (target.closest('.git-status')) return;
            onClose();
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [onClose]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (matches.length === 0) return;
            const delta = e.key === 'ArrowDown' ? 1 : -1;
            setIdx((i) => (i + delta + matches.length) % matches.length);
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const pick = matches[Math.min(idx, matches.length - 1)];
            if (pick) onPick(pick);
        }
    };

    return (
        <div
            ref={popRef}
            className="model-pop mention-pop branch-pop"
            role="listbox"
            aria-label={t('gitBranchesTitle')}
            onKeyDown={onKeyDown}
        >
            <div className="mention-head">
                <GitBranch size={12} aria-hidden="true" />
                <span>{t('gitBranchesTitle')}</span>
                <input
                    ref={inputRef}
                    className="mention-input"
                    dir="ltr"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('gitBranchFilter')}
                    aria-label={t('gitBranchFilter')}
                />
            </div>
            <div className="mention-list">
                {matches.length === 0 && (
                    <p className="model-empty">
                        {branches == null ? t('fileListLoading') : t('gitBranchNoMatch')}
                    </p>
                )}
                {matches.map((branch, i) => (
                    <button
                        key={branch}
                        type="button"
                        role="option"
                        aria-selected={i === idx}
                        className={`mention-item${i === idx ? ' selected' : ''}`}
                        onMouseEnter={() => setIdx(i)}
                        onClick={() => onPick(branch)}
                    >
                        <span className="mention-item-name" dir="ltr">{branch}</span>
                        {branch === current && (
                            <span className="branch-current">
                                <Check size={11} aria-hidden="true" />
                                {t('gitBranchCurrent')}
                            </span>
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
}
