import { useEffect, useState } from 'react';
import { Check, KeyRound, Laptop, RefreshCw, Sparkles, SquareTerminal, Wrench } from 'lucide-react';
import brandMark from '../../../assets/brand/logo-outline.svg';
import { OpenCodeSetup } from './OpenCodeSetup';
import { t } from '../i18n';
import type { EngineSetupState, ToExtensionMessage } from '../types';
import './enginesPage.css';

export function EnginesPage({ state, send }: { state: EngineSetupState | null; send: (message: ToExtensionMessage) => void }) {
    const [customPath, setCustomPath] = useState(state?.customPath ?? '');
    useEffect(() => { setCustomPath(state?.customPath ?? ''); }, [state?.customPath]);
    const phase = state?.phase ?? 'checking';
    const locked = !!state?.busy || phase === 'installing' || phase === 'checking';
    const statusKey = { checking: 'engineChecking', missing: 'engineMissing', unsupported: 'engineUnsupported', ready: 'engineReady', installing: 'engineInstalling', failed: 'engineFailed' } as const;
    return <section className="settings-page engines-page">
        <header className="settings-head"><h2>{t('enginesTitle')}</h2><button type="button" className="icon-btn" aria-label={t('surfaceRefresh')} disabled={locked} onClick={() => send({ type: 'enginesGetState' })}><RefreshCw size={14} className={phase === 'checking' ? 'spinning' : undefined} /></button></header>
        <div className="settings-scroll engines-content">
            <section className={`settings-card engine-card${state?.active === 'xratu' ? ' selected' : ''}`}>
                <div className="engine-heading"><span className="engine-mark xratu" aria-hidden="true"><img src={brandMark} alt="" /></span><h3 dir="ltr">{t('engineXratu')}</h3>{state?.active === 'xratu' && <span className="engine-active" title={t('engineActive')} aria-label={t('engineActive')}><Check size={12} /><span>{t('engineActive')}</span></span>}</div>
                <div className="engine-features"><span><KeyRound size={12} />{t('engineByok')}</span><span><Laptop size={12} />{t('engineLocal')}</span></div>
                <div className="engine-footer"><span className="engine-built-in">{t('engineBuiltIn')}</span>{state?.active !== 'xratu' && <button type="button" className="secondary-btn" disabled={locked} onClick={() => send({ type: 'engineSelect', engine: 'xratu' })}>{t('engineUse')}</button>}</div>
            </section>
            <section className={`settings-card engine-card${state?.active === 'opencode' ? ' selected' : ''}`}>
                <div className="engine-heading"><span className="engine-mark" aria-hidden="true"><SquareTerminal /></span><h3 dir="ltr">{t('engineOpenCode')}</h3>{state?.version && <code className="engine-version" dir="ltr">{state.version}</code>}{state?.active === 'opencode' && <span className="engine-active" title={t('engineActive')} aria-label={t('engineActive')}><Check size={12} /><span>{t('engineActive')}</span></span>}</div>
                <div className="engine-features"><span className="engine-free"><Sparkles size={12} />{t('engineFreeModels')}</span><span><Wrench size={12} />{t('engineNativeTools')}</span></div>
                <div className="engine-footer">
                <div className={`engine-status ${phase}`} role="status"><span className="engine-status-dot" aria-hidden="true" /><span>{t(statusKey[phase])}</span></div>
                {phase === 'ready' && state?.active !== 'opencode' && <button type="button" className="primary-btn" disabled={locked} onClick={() => send({ type: 'engineSelect', engine: 'opencode' })}>{t('engineUse')}</button>}
                </div>
                {phase !== 'ready' && <OpenCodeSetup state={state} send={send} />}
                <div className="engine-controls"><details className="engine-details"><summary>{t('engineSetup')}</summary>
                    {state?.binaryPath && <p className="engine-path" dir="ltr">{state.binaryPath}</p>}
                    <p>{t(phase === 'unsupported' ? 'engineUpgradeHint' : state?.installedByXratu ? 'engineManaged' : phase === 'ready' ? 'engineExternal' : 'engineInstallHint')}</p>
                    <label htmlFor="engine-path">{t('engineCustomPath')}</label><input id="engine-path" dir="ltr" value={customPath} disabled={locked} placeholder={t('enginePathHint')} onChange={(event) => setCustomPath(event.target.value)} /><button type="button" className="secondary-btn" disabled={locked} onClick={() => send({ type: 'engineSetPath', path: customPath })}>{t('engineSavePath')}</button>
                </details>
                <details className="engine-details"><summary>{t('engineAbout')}</summary><p>{t('engineNativeToolsHint')}</p></details></div>
            </section>
            {state?.busy && <p role="status">{t('engineBusyHint')}</p>}
        </div>
    </section>;
}
