import { Check, Download, FileDown, Pause, RefreshCw, X } from 'lucide-react';
import type { DownloadError, DownloadStatus, DownloadView } from '../../../src/downloads/types';
import { formatClockTime, formatDuration } from '../datetime';
import { getLocale, t, tf } from '../i18n';

const labels = {
    queued: 'downloadQueued', downloading: 'downloadDownloading', retrying: 'downloadRetrying', verifying: 'downloadVerifying',
    paused: 'downloadPaused', interrupted: 'downloadInterrupted', completed: 'downloadCompleted', failed: 'downloadFailed', cancelled: 'downloadCancelled',
} as const satisfies Record<DownloadStatus, string>;

export function formatDownloadBytes(bytes: number): string {
    const unit = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
    return `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: unit ? 1 : 0 }).format(bytes / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`;
}

/** Status only. Download controls belong to agents. */
export function DownloadsPanel({ downloads, error, visible, panelClass }: { downloads: DownloadView[]; error?: DownloadError; visible: boolean; panelClass: string }) {
    return <section className={`downloads-pane ${panelClass}`} id="surface-panel-downloads" role="tabpanel" aria-labelledby="surface-tab-downloads" aria-hidden={!visible || undefined}>
        {error && <p className="download-error" role="status">{t(error)}</p>}
        {downloads.length === 0 ? <div className="surface-empty-state" role="status">
            <div className="surface-empty-icon" aria-hidden="true"><Download size={22} /></div>
            <strong>{t('downloadEmpty')}</strong>
        </div> : <div className="downloads-content">
            <div className="download-list">{downloads.map(r => {
                const percent = r.total !== null && r.total > 0 ? Math.min(100, Math.floor(r.received / r.total * 100)) : r.status === 'completed' ? 100 : undefined;
                const Icon = r.status === 'completed' ? Check : r.status === 'paused' || r.status === 'interrupted' ? Pause : r.status === 'retrying' ? RefreshCw : r.status === 'failed' || r.status === 'cancelled' ? X : FileDown;
                const route = t(({ auto: 'downloadRouteAuto', proxy: 'downloadRouteProxy', direct: 'downloadRouteDirect' } as const)[r.effectiveRoute ?? r.route]);
                const statusDetails = [t(labels[r.status]), r.error && t(r.error), r.httpStatus && `HTTP ${r.httpStatus}`, r.status === 'retrying' && r.retryAt && tf('downloadRetryAt', { time: formatClockTime(r.retryAt) })].filter(Boolean).join('\n');
                return <article className={`download-row download-${r.status}`} key={r.id}>
                    <div className="download-title"><Icon size={16} aria-hidden="true" /><strong dir="ltr" title={[r.path, r.source, route].join('\n')}>{r.path.split(/[\\/]/).at(-1)}</strong><span className="download-status" title={statusDetails} aria-label={statusDetails}>{t(labels[r.status])}</span></div>
                    <div className="download-progress" role="progressbar" aria-label={r.path} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${formatDownloadBytes(r.received)}${r.total !== null ? ` / ${formatDownloadBytes(r.total)}` : ''}`}>
                        <span style={{ inlineSize: `${percent ?? 0}%` }} />
                    </div>
                    <div className="download-metrics"><span dir="ltr">{formatDownloadBytes(r.received)}{r.total !== null && ` / ${formatDownloadBytes(r.total)}`}</span>
                        {r.status === 'downloading' && r.bytesPerSecond > 0 && <span className="download-speed"><bdi dir="ltr">{formatDownloadBytes(r.bytesPerSecond)}</bdi><span>{t('downloadPerSecond')}</span>{r.total !== null && <bdi dir="ltr">{formatDuration(Math.ceil((r.total - r.received) / r.bytesPerSecond))}</bdi>}</span>}
                        {percent !== undefined && <span dir="ltr">{new Intl.NumberFormat(getLocale()).format(percent)}%</span>}
                    </div>
                </article>;
            })}</div>
        </div>}
    </section>;
}
