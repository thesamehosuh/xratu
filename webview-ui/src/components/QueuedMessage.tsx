import { Clock3, Paperclip, Pencil, X } from 'lucide-react';
import { t } from '../i18n';
import type { AttachmentMeta } from '../types';

export function QueuedMessage({ value, attachments, busy, dispatching, active, native, onEdit, onCancel, onSendNow }: {
    value: string;
    attachments: AttachmentMeta[];
    busy: boolean;
    active: boolean;
    dispatching: boolean;
    native: boolean;
    onEdit: () => void;
    onCancel: () => void;
    onSendNow: () => void;
}) {
    return <article className="queued-message" aria-busy={busy || undefined}>
        <div className="queued-message-head">
            <span className="queued-message-status" title={t(native ? 'steerQueuedNativeTitle' : 'steerQueuedTitle')}>
                <Clock3 size={13} aria-hidden="true" /><span>{t(dispatching ? 'steerSending' : 'steerQueued')}</span>
            </span>
            <div className="queued-message-actions">
                <button type="button" className="queued-steer-now" disabled={busy || active}
                    title={t(native ? 'steerNowNativeTitle' : 'steerNowTitle')} onClick={onSendNow}>{t('steerNow')}</button>
                <button type="button" className="queued-message-action" disabled={busy || active}
                    aria-label={t('steerEditQueued')} title={t('steerEditQueued')} onClick={onEdit}><Pencil size={14} /></button>
                <button type="button" className="queued-message-action" disabled={busy}
                    aria-label={t('steerCancelQueued')} title={t('steerCancelQueued')} onClick={onCancel}><X size={16} /></button>
            </div>
        </div>
        {attachments.length > 0 && <div className="message-attachments" aria-label={t('attachmentsLabel')}>
            {attachments.map((attachment, index) => attachment.previewDataUrl
                ? <figure className="message-attachment-image" key={index}>
                    <img src={attachment.previewDataUrl} alt={attachment.name} />
                    <figcaption><span dir="auto">{attachment.name}</span></figcaption>
                </figure>
                : <div className="message-attachment-file" key={index}>
                    <span className="message-attachment-file-icon"><Paperclip size={12} aria-hidden="true" /></span>
                    <span dir="auto">{attachment.name}</span>
                </div>)}
        </div>}
        {value && <div className="msg-content queued-message-text" dir="auto">{value}</div>}
    </article>;
}
