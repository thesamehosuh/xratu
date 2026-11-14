import { useEffect, useLayoutEffect, useRef } from 'react';
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
    // Confirms can block the host, so show the oldest actionable notification
    // first while retaining the ordinary queue for later display.
    const item = notifications.find((notification) => notification.actions?.length) ?? notifications[0];
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const close = useRef<HTMLButtonElement>(null);
    const previousFocus = useRef<HTMLElement | null>(null);
    const recoverFocus = useRef(false);
    const focusWithin = useRef(false);

    useLayoutEffect(() => {
        if (recoverFocus.current) {
            // Do not override another component that has already moved focus.
            if (document.activeElement === document.body) {
                if (close.current) close.current.focus();
                else {
                    if (previousFocus.current?.isConnected) previousFocus.current.focus();
                    const app = document.activeElement === document.body ? document.querySelector<HTMLElement>('.app') : null;
                    if (app) {
                        app.setAttribute('tabindex', '-1');
                        app.focus();
                    }
                }
            }
            recoverFocus.current = false;
        }
        return () => {
            recoverFocus.current = focusWithin.current;
            focusWithin.current = false;
        };
    }, [item?.id]);

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
        <div
            key={item.id}
            className={`notif notif-${item.kind}`}
            role="alert"
            onFocus={(event) => {
                if (!recoverFocus.current && !event.currentTarget.contains(event.relatedTarget)) {
                    previousFocus.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
                }
                focusWithin.current = true;
            }}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) focusWithin.current = false;
            }}
        >
            <div className="notif-icon">
                <Icon size={14} />
            </div>
            <div className="notif-copy">{tf(item.valueKey, item.params)}</div>
            {item.actions && item.actions.length > 0 && <div className="notif-actions">
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
            </div>}
            <button
                ref={close}
                type="button"
                className="notif-close"
                aria-label={t('notifDismiss')}
                title={t('notifDismiss')}
                onClick={() => onDismiss(item.id, null)}
            >
                <X size={13} />
            </button>
        </div>
    );
}
