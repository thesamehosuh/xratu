import { BookOpen, Gauge, LoaderCircle } from 'lucide-react';
import { t, tf, tOrRaw } from '../i18n';
import type { ProviderBenchmark, SavedCredential } from '../types';

export function ProviderComparison({ results, credentials, offline, onRun, onGuide }: {
    results: ProviderBenchmark[]; credentials: SavedCredential[]; offline: boolean;
    onRun: () => void; onGuide: () => void;
}) {
    const active = credentials.find((credential) => credential.active);
    let loopback = false;
    try {
        const url = new URL(active?.baseUrl ?? '');
        loopback = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    } catch { /* An absent or invalid active credential cannot run offline. */ }
    return <details className="runtime-guide provider-comparison">
        <summary>{t('benchmarkTitle')}</summary>
        <p>{t('benchmarkHint')}</p>
        <div className="runtime-actions">
            <button className="ghost-btn small" aria-label={t('benchmarkRun')} title={t('benchmarkRun')} onClick={onRun} disabled={(offline && !loopback) || results.some((r) => r.busy)}>
                {results.some((r) => r.busy) ? <LoaderCircle size={14} className="spinning" /> : <Gauge size={14} />}
            </button>
            <button className="ghost-btn small" aria-label={t('providerGuide')} title={t('providerGuide')} onClick={onGuide}><BookOpen size={14} /></button>
        </div>
        {results.length === 0 && <p>{t('benchmarkEmpty')}</p>}
        {results.map((result) => <div className="runtime-model-row" key={`${result.credentialId}:${result.model}`}>
            <strong dir="ltr">{credentials.find((c) => c.id === result.credentialId)?.label ?? result.credentialId} · {result.model}</strong>
            {result.price && <span dir="auto">{tf('benchmarkPrice', { input: String(result.price.input), output: String(result.price.output), currency: result.price.currency ?? 'USD' })}</span>}
            {result.cost && <span dir="auto">{tf('benchmarkCost', { amount: result.cost.amount.toPrecision(3), currency: result.cost.currency })}</span>}
            <span dir="auto">{result.busy ? t('benchmarkBusy') : result.errorKey ? tOrRaw(result.errorKey) : result.error ?? (result.firstTokenMs == null ? t('benchmarkNoToken')
                : tf('benchmarkResult', { first: String(result.firstTokenMs), total: String(result.totalMs) }))}</span>
        </div>)}
    </details>;
}
