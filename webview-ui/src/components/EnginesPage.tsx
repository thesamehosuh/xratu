import { useEffect, useState } from 'react';
import { Check, FolderCheck, KeyRound, Laptop, RefreshCw, Settings2, Sparkles, SquareTerminal, Trash2, Wrench } from 'lucide-react';
import brandMark from '../../../assets/brand/logo-outline.svg';
import { OpenCodeSetup } from './OpenCodeSetup';
import { t } from '../i18n';
import type { EngineSetupState, ToExtensionMessage } from '../types';
import './enginesPage.css';

export function EnginesPage({ state, send }: { state: EngineSetupState | null; send: (message: ToExtensionMessage) => void }) {
    const [customPath, setCustomPath] = useState(state?.customPath ?? '');
    const [confirmRemove, setConfirmRemove] = useState(false);
    useEffect(() => { setCustomPath(state?.customPath ?? ''); }, [state?.customPath]);
    useEffect(() => { setConfirmRemove(false); }, [state?.phase, state?.binaryPath]);
    const phase = state?.phase ?? 'checking';
    const locked = !!state?.busy || phase === 'installing' || phase === 'removing' || phase === 'checking';
    const statusKey = { checking: 'engineChecking', missing: 'engineMissing', unsupported: 'engineUnsupported', ready: 'engineReady', installing: 'engineInstalling', removing: 'engineRemoving', failed: 'engineFailed' } as const;
    return <section className="settings-page engines-page">
        <header className="settings-head"><h2>{t('enginesTitle')}</h2><button type="button" className="icon-btn" aria-label={t('surfaceRefresh')} disabled={locked} onClick={() => send({ type: 'enginesGetState' })}><RefreshCw size={14} className={phase === 'checking' ? 'spinning' : undefined} /></button></header>
        <div className="settings-scroll engines-content">
            <section className={`settings-card engine-card${state?.active === 'xratu' ? ' selected' : ''}`}>
                <div className="engine-heading"><span className="engine-mark xratu" aria-hidden="true"><img src={brandMark} alt="" /></span><h3 dir="ltr">{t('engineXratu')}</h3>{state?.active === 'xratu' && <span className="engine-active" title={t('engineActive')} aria-label={t('engineActive')}><Check size={12} /><span>{t('engineActive')}</span></span>}</div>
                <div className="engine-features"><span><KeyRound size={12} /><span>{t('engineByok')}</span></span><span><Laptop size={12} /><span>{t('engineLocal')}</span></span></div>
                <div className="engine-footer"><span className="engine-built-in">{t('engineBuiltIn')}</span>{state?.active !== 'xratu' && <button type="button" className="secondary-btn" disabled={locked} onClick={() => send({ type: 'engineSelect', engine: 'xratu' })}>{t('engineUse')}</button>}</div>
            </section>
            <section className={`settings-card engine-card${state?.active === 'opencode' ? ' selected' : ''}`}>
                <div className="engine-heading"><span className="engine-mark" aria-hidden="true"><SquareTerminal /></span><h3 dir="ltr">{t('engineOpenCode')}</h3>{state?.version && <code className="engine-version" dir="ltr">{state.version}</code>}{state?.active === 'opencode' && <span className="engine-active" title={t('engineActive')} aria-label={t('engineActive')}><Check size={12} /><span>{t('engineActive')}</span></span>}</div>
                <div className="engine-features"><span className="engine-free"><Sparkles size={12} /><span>{t('engineFreeModels')}</span></span><span><Wrench size={12} /><span>{t('engineNativeTools')}</span></span></div>
                <div className="engine-footer">
                <div className={`engine-status ${phase}`} role="status"><span className="engine-status-dot" aria-hidden="true" /><span>{t(statusKey[phase])}</span></div>
                {phase === 'ready' && state?.active !== 'opencode' && <button type="button" className="primary-btn" disabled={locked} onClick={() => send({ type: 'engineSelect', engine: 'opencode' })}>{t('engineUse')}</button>}
                </div>
                {phase !== 'ready' && <OpenCodeSetup state={state} send={send} />}
                {state?.installedByXratu && <div className="engine-maintenance">
                    {state.updateAvailable && <p>{t('engineUpdateHint')}</p>}
                    <div className="engine-maintenance-actions">
                        <button type="button" className="secondary-btn" disabled={locked || !state.updateAvailable} onClick={() => send({ type: 'engineInstall' })}>{state.updateAvailable ? <RefreshCw size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}<span>{t(state.updateAvailable ? 'engineUpdate' : 'engineUpToDate')}</span></button>
                        <button type="button" className="icon-btn" aria-label={t('engineRemove')} title={t('engineRemove')} disabled={locked} onClick={() => setConfirmRemove(true)}><Trash2 size={14} /></button>
                    </div>
                    {confirmRemove && <div className="engine-remove-confirm" role="group" aria-label={t('engineRemove')}>
                        <p>{t('engineRemoveHint')}</p>
                        <div className="engine-maintenance-actions"><button type="button" className="secondary-btn" disabled={locked} onClick={() => { setConfirmRemove(false); send({ type: 'engineRemove' }); }}>{t('engineRemoveConfirm')}</button><button type="button" className="secondary-btn" disabled={locked} onClick={() => setConfirmRemove(false)}>{t('editCancel')}</button></div>
                    </div>}
                </div>}
                <div className="engine-controls"><details className="engine-details"><summary><Settings2 size={12} aria-hidden="true" /><span>{t('engineSetup')}</span></summary>
                    {state?.binaryPath && <p className="engine-path" dir="ltr">{state.binaryPath}</p>}
                    {phase === 'ready' && <div className="engine-install-source"><FolderCheck size={12} aria-hidden="true" /><span>{t(state?.installedByXratu ? 'engineManaged' : 'engineExternal')}</span></div>}
                    <label htmlFor="engine-path">{t('engineCustomPath')}</label><input id="engine-path" dir="ltr" value={customPath} disabled={locked} placeholder={t('enginePathHint')} onChange={(event) => setCustomPath(event.target.value)} /><button type="button" className="secondary-btn" disabled={locked} onClick={() => send({ type: 'engineSetPath', path: customPath })}>{t('engineSavePath')}</button>
                </details></div>
            </section>
            {state?.busy && <p role="status">{t('engineBusyHint')}</p>}
        </div>
    </section>;
}
