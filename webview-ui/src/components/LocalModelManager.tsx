import { Check, Download, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { t, tf } from '../i18n';
import type { DiscoveredLocalRuntime, LocalModelOperation } from '../types';

export function LocalModelManager({ runtime, operation, offline, onManage }: {
    runtime: DiscoveredLocalRuntime; operation?: LocalModelOperation | null; offline: boolean;
    onManage: (action: 'pull' | 'delete' | 'cancel', baseUrl: string, model: string) => void;
}) {
    const [model, setModel] = useState('');
    const [confirm, setConfirm] = useState<string | null>(null);
    const current = operation?.baseUrl === runtime.baseUrl ? operation : null;
    const busy = !!operation?.busy;
    const percent = current?.total && Number.isFinite(current.completed)
        ? Math.min(100, Math.max(0, Math.round(100 * (current.completed ?? 0) / current.total))) : null;
    return <details className="runtime-guide local-model-manager">
        <summary>{t('localModelManage')}</summary>
        <p>{t('localModelPullHint')}</p>
        <div className="runtime-actions">
            <input dir="ltr" aria-label={t('localModelName')} placeholder={t('localModelName')} value={model}
                onChange={(event) => setModel(event.target.value)} disabled={busy} />
            <button className="ghost-btn small" aria-label={t('localModelPull')} title={t('localModelPull')} disabled={busy || offline || !model.trim()}
                onClick={() => onManage('pull', runtime.baseUrl, model.trim())}><Download size={14} /></button>
        </div>
        {runtime.models.map((id) => <div className="runtime-model-row" key={id}>
            <span dir="ltr">{id}</span>
            <button className="ghost-btn small" disabled={busy} aria-label={`${t('localModelDelete')} ${id}`} title={t('localModelDelete')}
                onClick={() => setConfirm(id)}><Trash2 size={13} /></button>
            {confirm === id && <div className="runtime-actions" role="group" aria-label={t('localModelDeleteConfirm')}>
                <button className="ghost-btn small" disabled={busy} aria-label={t('localModelDeleteConfirm')} title={t('localModelDeleteConfirm')} onClick={() => { setConfirm(null); onManage('delete', runtime.baseUrl, id); }}><Check size={13} /></button>
                <button className="ghost-btn small" aria-label={t('editCancel')} title={t('editCancel')} onClick={() => setConfirm(null)}><X size={13} /></button>
            </div>}
        </div>)}
        {current && <div role="status" className="runtime-operation">
            <span dir="auto">{current.errorKey ? tf(current.errorKey, { detail: current.detail ?? '' })
                : current.status === 'success' ? t('localModelSuccess') : current.status ?? t('benchmarkBusy')}</span>
            {percent !== null && <progress value={percent} max={100} aria-label={t('localModelPull')} />}
            {current.busy && <button className="ghost-btn small" aria-label={t('localModelCancel')} title={t('localModelCancel')} onClick={() => onManage('cancel', runtime.baseUrl, current.model)}><X size={13} /></button>}
        </div>}
    </details>;
}
