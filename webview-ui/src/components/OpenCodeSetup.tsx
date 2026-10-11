import { Download, RefreshCw } from 'lucide-react';
import { t, tOrRaw } from '../i18n';
import type { EngineSetupState, ToExtensionMessage } from '../types';

/** The installer is the same action in onboarding and engine settings. */
export function OpenCodeSetup({ state, send }: { state: EngineSetupState | null; send: (message: ToExtensionMessage) => void }) {
    const phase = state?.phase ?? 'checking';
    const locked = !!state?.busy || phase === 'installing' || phase === 'checking';
    const total = state?.totalBytes;
    return <div className="setup-install">
        {phase === 'checking' && <span className="setup-status" role="status"><RefreshCw size={14} className="spinning" />{t('engineChecking')}</span>}
        {['missing', 'unsupported', 'failed'].includes(phase) && <>
            <span className="setup-muted">{t(phase === 'unsupported' ? 'engineUpgradeHint' : 'setupInstallHint')}</span>
            <button type="button" className="primary-btn" disabled={locked} onClick={() => send({ type: 'engineInstall' })}><Download size={14} />{t('engineInstall')}</button>
        </>}
        {phase === 'installing' && <>
            <div className="setup-status" role="status"><RefreshCw size={14} className="spinning" />{t('engineInstalling')}<span className="setup-muted" dir="ltr">{((state?.downloadedBytes ?? 0) / 1024 / 1024).toFixed(1)}{total ? ` / ${(total / 1024 / 1024).toFixed(1)}` : ''} MB</span></div>
            <progress aria-label={t('engineInstalling')} value={total ? state?.downloadedBytes ?? 0 : undefined} max={total ?? 1} />
            <button type="button" className="ghost-btn small" onClick={() => send({ type: 'engineInstallCancel' })}>{t('engineCancel')}</button>
        </>}
        {state?.errorKey && <p className="setup-error" role="alert">{tOrRaw(state.errorKey)}</p>}
        {state?.detail && <details className="setup-detail"><summary>{t('engineDetails')}</summary><pre dir="auto">{state.detail}</pre></details>}
    </div>;
}
