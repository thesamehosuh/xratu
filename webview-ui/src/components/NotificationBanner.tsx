import { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, X, XCircle } from 'lucide-react';
import type { NotificationItem } from '../types';
import { t, tf, tOrRaw } from '../i18n';

/** Auto-dismiss delay for plain info banners (action banners stay sticky). */
const INFO_TTL_MS = 6000;

/**
 * In-app notification banner - replaces vscode.window toasts so notifications
 * render inside the Xratu panel with our own styling. Info banners auto-hide;
 * warnings/errors persist until dismissed. Banners with actions are confirms:
 * clicking an action (or dismissing) answers the host and resolves its await.
 */
export function NotificationBanner(props: {
    notifications: NotificationItem[];
    onDismiss: (id: string, action: string | null) => void;
}) {
    const { notifications, onDismiss } = props;
    const item = notifications[0];
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (timer.current) clearTimeout(timer.current);
        if (item && item.kind === 'info' && (!item.actions || item.actions.length === 0)) {
            timer.current = setTimeout(() => onDismiss(item.id, null), INFO_TTL_MS);
        }
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, [item, onDismiss]);

    if (!item) return null;

    const Icon = item.kind === 'error' ? XCircle : item.kind === 'warning' ? AlertTriangle : CheckCircle2;

    return (
        <div className={`notif notif-${item.kind}`} role="alert">
            <div className="notif-icon">
                <Icon size={14} />
            </div>
            <div className="notif-copy">{tf(item.valueKey, item.params)}</div>
            <div className="notif-actions">
                {item.actions?.map((a) => (
                    <button
                        key={a}
                        type="button"
                        className="chip-btn notif-action"
                        onClick={() => onDismiss(item.id, a)}
                    >
                        {tOrRaw(a)}
                    </button>
                ))}
                <button
                    type="button"
                    className="notif-close"
                    aria-label={t('notifDismiss')}
                    title={t('notifDismiss')}
                    onClick={() => onDismiss(item.id, null)}
                >
                    <X size={13} />
                </button>
            </div>
        </div>
    );
}
