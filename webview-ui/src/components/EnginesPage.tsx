import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, KeyRound, RefreshCw, SquareTerminal, Trash2 } from 'lucide-react';
import brandMark from '../../../assets/brand/logo-outline.svg';
import { OpenCodeSetup } from './OpenCodeSetup';
import { getLocale, t } from '../i18n';
import type { SetupEngine } from '../../../src/engines/setup';
import type { ConnectionStatus, EngineSetupState, ToExtensionMessage } from '../types';
import './enginesPage.css';

export function EnginesPage({ state, send, onConfigure, model, plan, provider, connection }: {
    provider: string | null; connection: ConnectionStatus; model: string | null; plan: boolean;
    onConfigure: (engine: SetupEngine) => void; state: EngineSetupState | null; send: (message: ToExtensionMessage) => void;
}) {
    const [customPath, setCustomPath] = useState(state?.customPath ?? '');
    const [confirmRemove, setConfirmRemove] = useState(false);
    useEffect(() => { setCustomPath(state?.customPath ?? ''); }, [state?.customPath]);
    useEffect(() => { setConfirmRemove(false); }, [state?.phase, state?.binaryPath]);
    const phase = state?.phase ?? 'checking';
    const locked = !!state?.busy || phase === 'installing' || phase === 'removing' || phase === 'checking';
    const statusKey = { checking: 'engineChecking', missing: 'engineMissing', unsupported: 'engineUnsupported', ready: 'engineReady', installing: 'engineInstalling', removing: 'engineRemoving', failed: 'engineFailed' } as const;
    const SwitchArrow = getLocale() === 'fa' ? ArrowLeft : ArrowRight;
    const switchButton = (engine: SetupEngine) => <button type="button" className="engine-action" disabled={locked} title={t('engineUse')} onClick={() => send({ type: 'engineSelect', engine })}><SwitchArrow size={14} /><span>{t('engineSwitch')}</span></button>;
    return <section className="settings-page engines-page">
        <header className="settings-head"><h2>{t('enginesTitle')}</h2><button type="button" className="engine-action" disabled={locked} onClick={() => send({ type: 'enginesGetState' })}><RefreshCw size={15} className={phase === 'checking' ? 'spinning' : undefined} /><span>{t('engineCheckInstallation')}</span></button></header>
        <div className="settings-scroll engines-content"><div className="inventory-split"><div className="engine-main">
            <section className={`engine-card${state?.active === 'xratu' ? ' selected' : ''}`}>
                <div className="engine-heading"><span className="xratu-brand-mark" style={{ maskImage: `url("${brandMark}")` }} aria-hidden="true" /><h3 dir="ltr">{t('engineXratu')}</h3>{state?.active === 'xratu' && <span className="engine-active"><Check size={11} /><span>{t('engineActive')}</span></span>}</div>
                <div className="engine-features"><span>{t('engineBuiltIn')}</span><span>{t('engineByok')}</span><span>{t('engineLocal')}</span></div>
                <div className="engine-facts">
                    <div className="kv"><span>{t('miniProvider')}</span><span dir="ltr">{provider || '—'}</span></div>
                    <div className="kv"><span>{t('surfaceModel')}</span><span dir="ltr">{state?.active === 'xratu' ? model || '—' : '—'}</span></div>
                    <div className="kv"><span>{t('proxyCardConnection')}</span><span>{state?.active === 'xratu' ? t(connection === 'connected' ? 'surfaceReady' : 'surfaceDisconnected') : '—'}</span></div>
                </div>
                <div className="engine-footer">{state?.active !== 'xratu' && switchButton('xratu')}<button type="button" className="engine-action" data-configure-engine="xratu" onClick={() => onConfigure('xratu')}><KeyRound size={14} /><span>{t('engineManageProviders')}</span></button></div>
            </section>
            <section className={`engine-card${state?.active === 'opencode' ? ' selected' : ''}`}>
                <div className="engine-heading"><SquareTerminal size={22} /><h3 dir="ltr">{t('engineOpenCode')}</h3><span className={`engine-status ${phase}`} role="status">{t(phase === 'ready' && state?.active === 'opencode' ? 'engineActive' : statusKey[phase])}</span></div>
                <div className="engine-features"><span>{t('engineNative')}</span><span>{t('engineFreeModels')}</span></div>
                <div className="engine-facts"><div className="kv"><span>{t('engineBinary')}</span><code dir="ltr">{state?.binaryPath || state?.customPath || '—'}</code></div><div className="kv"><span>{t('engineAuthentication')}</span><span>{t('engineManagedAuthentication')}</span></div></div>
                {phase === 'ready' ? <div className="engine-footer">{state?.active !== 'opencode' && switchButton('opencode')}<button type="button" className="engine-action" data-configure-engine="opencode" disabled={locked} onClick={() => onConfigure('opencode')}>{t('surfaceConfigure')}</button></div> : <OpenCodeSetup state={state} send={send} />}
            </section>
            {state?.busy && <p role="status">{t('engineBusyHint')}</p>}
        </div><aside className="inventory-inspector engine-inspector">
            <h3>{t('surfaceCurrentConversation')}</h3>
            <div className="kv"><span>{t('setupSelectEngine')}</span><span>{t(state?.active === 'opencode' ? 'engineOpenCode' : 'engineXratu')}</span></div>
            <div className="kv"><span>{t('surfaceModel')}</span><span dir="ltr">{model || '—'}</span></div>
            <div className="kv"><span>{t('surfaceModeControl')}</span><span>{t(plan ? 'surfacePlan' : 'surfaceBuild')}</span></div>
            <section className="engine-installation"><h3>{t('engineInstallation')}</h3>
                <label htmlFor="engine-path">{t('engineBinary')}</label><input id="engine-path" dir="ltr" value={customPath} disabled={locked} placeholder={state?.binaryPath || 'opencode'} onChange={event => setCustomPath(event.target.value)} />
                <div className="engine-install-actions"><button type="button" className="engine-action" disabled={locked} title={t('engineSavePath')} onClick={() => send({ type: 'engineSetPath', path: customPath })}>{t('engineVerifyPath')}</button>{state?.installedByXratu && <button type="button" className="engine-action" disabled={locked} onClick={() => send({ type: 'engineInstall' })}>{t(state.updateAvailable ? 'engineUpdate' : 'engineReinstall')}</button>}</div>
            </section>
            {state?.installedByXratu && <details className="engine-maintenance"><summary>{t('engineMaintenance')}</summary>
                {state.version && <code className="engine-version" dir="ltr">{state.version}</code>}
                <div className="engine-install-source"><span>{t('engineManaged')}</span>{!state.updateAvailable && <span>{t('engineUpToDate')}</span>}</div>
                <button type="button" className="engine-action" aria-label={t('engineRemove')} disabled={locked} onClick={() => setConfirmRemove(true)}><Trash2 size={13} /><span>{t('engineRemove')}</span></button>
                {confirmRemove && <div className="engine-remove-confirm" role="group" aria-label={t('engineRemove')}><p>{t('engineRemoveHint')}</p><div className="engine-install-actions"><button type="button" className="engine-action" disabled={locked} onClick={() => { setConfirmRemove(false); send({ type: 'engineRemove' }); }}>{t('engineRemoveConfirm')}</button><button type="button" className="engine-action" disabled={locked} onClick={() => setConfirmRemove(false)}>{t('editCancel')}</button></div></div>}
            </details>}
        </aside></div></div>
    </section>;
}
