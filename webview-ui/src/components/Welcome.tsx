import { useEffect, useState, useRef, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, ExternalLink, FolderOpen, KeyRound, Laptop, RefreshCw, Sparkles } from 'lucide-react';
import brandMark from '../../../assets/brand/logo-outline.svg';
import { canStartSetup } from '../../../src/engines/setup';
import { t, tOrRaw } from '../i18n';
import type { DiscoveredLocalRuntime, EngineSetupState, LocalModelOperation, RuntimeSetupState, SetupPath, ToExtensionMessage } from '../types';
import { LocalModelManager } from './LocalModelManager';
import { OpenCodeSetup } from './OpenCodeSetup';
import { SetupModelPicker } from './SetupModelPicker';
import './onboarding.css';

interface WelcomeProps {
    path: SetupPath | null;
    state: RuntimeSetupState | null;
    engineState: EngineSetupState | null;
    canBack: boolean;
    localRuntimes: DiscoveredLocalRuntime[];
    localModelsScanning: boolean;
    localScanError: string | null;
    localModelOperation: LocalModelOperation | null;
    offline: boolean;
    locale: 'fa' | 'en';
    credentials: ReactNode;
    onSetLocale: (locale: 'fa' | 'en') => void;
    onChoose: (path: SetupPath | null) => void;
    onBack: () => void;
    onRetry: () => void;
    onConnectRuntime: (runtime: DiscoveredLocalRuntime) => void;
    onRescan: () => void;
    send: (message: ToExtensionMessage) => void;
}

const PATHS = [
    { id: 'free', label: 'setupStartFree', hint: 'setupFreeHint', icon: Sparkles },
    { id: 'provider', label: 'setupUseProvider', hint: 'setupProviderHint', icon: KeyRound },
    { id: 'local', label: 'setupRunLocal', hint: 'setupLocalHint', icon: Laptop },
] as const;

export function Welcome(props: WelcomeProps) {
    const { path, state, engineState, send, locale } = props;
    const [selected, setSelected] = useState('');
    const [editingConnection, setEditingConnection] = useState(false);
    const [starting, setStarting] = useState(false);
    const [, tick] = useState(0);
    const Back = locale === 'fa' ? ArrowRight : ArrowLeft;
    useEffect(() => { props.onRescan(); }, [props.onRescan]);
    useEffect(() => { setSelected(''); setStarting(false); setEditingConnection(false); }, [path, state?.requestId]);
    useEffect(() => {
        if (!state) return;
        setSelected((previous) => {
            if (state.models.some((model) => model.id === previous && (path !== 'free' || model.availability === 'available'))) return previous;
            return state.models.find((model) => path !== 'free' || model.availability === 'available')?.id ?? '';
        });
        if (state.errorKey || state.phase === 'attention') setStarting(false);
    }, [state, path]);
    useEffect(() => {
        if (path !== 'free' || !state?.models.some((model) => model.availability === 'available')) return;
        const timer = setInterval(() => tick((value) => value + 1), 5000);
        return () => clearInterval(timer);
    }, [path, state]);
    const hasModels = !!state?.models.length;
    const stage = !path ? 0 : hasModels && !editingConnection ? 2 : 1;
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [path, stage]);
    const ready = !!state && canStartSetup(state, selected) && !starting;
    return <main className="onboarding">
        <div className="setup-shell">
            <header className="setup-top">
                <span className="setup-brand"><img src={brandMark} alt="" /><span dir="ltr">Xratu</span></span>
                <div className="lang-choice" role="group" aria-label={t('settingsLanguage')}>
                    <button type="button" className={locale === 'fa' ? 'lang-chip active' : 'lang-chip'} onClick={() => props.onSetLocale('fa')}>فارسی</button>
                    <button type="button" className={locale === 'en' ? 'lang-chip active' : 'lang-chip'} onClick={() => props.onSetLocale('en')}>English</button>
                </div>
            </header>
            <ol className="setup-steps" aria-label={t('setupProgress')}>
                {(['setupChoose', 'setupConnect', 'setupChat'] as const).map((key, index) => <li key={key} className={stage === index ? 'current' : stage > index ? 'done' : ''} aria-current={stage === index ? 'step' : undefined}><span aria-hidden="true" dir="ltr">{stage > index ? <Check size={10} /> : index + 1}</span>{t(key)}</li>)}
            </ol>
            <div className="setup-heading">
                <h1 ref={heading} tabIndex={-1}>{t(!path ? 'setupHeading' : stage === 2 ? 'setupChooseModel' : path === 'free' ? 'setupOpenCodeHeading' : path === 'local' ? 'setupLocalHeading' : 'setupProviderHeading')}</h1>
                {!path && <p>{t('setupSubheading')}</p>}
            </div>
            {!path ? <div className="setup-paths">
                {PATHS.map(({ id, label, hint, icon: Icon }) => <button key={id} type="button" className={`setup-path${id === 'free' ? ' recommended' : ''}`} onClick={() => props.onChoose(id)}>
                    <span className="setup-path-icon"><Icon size={19} /></span>
                    <span className="setup-path-copy"><strong>{t(label)}{id === 'free' && <span className="setup-recommended">{t('setupRecommended')}</span>}</strong><span>{t(hint)}</span></span>
                    <ChevronRight size={15} className={locale === 'fa' ? 'rtl-flip' : undefined} />
                </button>)}
            </div> : <section className="setup-body" aria-busy={starting || state?.phase === 'checking'}>
                {!(path === 'local' && !hasModels) && <div className="setup-context"><span dir="ltr">{path === 'free' ? 'OpenCode 2' : 'Xratu'}</span>{state?.providerName && <span dir="auto">{state.providerName}</span>}<button type="button" className="ghost-btn small" aria-label={t('setupCheckAgain')} title={t('setupCheckAgain')} onClick={props.onRetry} disabled={starting || state?.phase === 'checking' || engineState?.phase === 'installing'}><RefreshCw size={13} className={state?.phase === 'checking' ? 'spinning' : undefined} /></button></div>}
                {path !== 'local' && (!state || state.phase === 'checking') && <div className="setup-status" role="status"><RefreshCw size={14} className="spinning" />{t('setupChecking')}</div>}
                {path === 'free' && state?.phase === 'install' && <OpenCodeSetup state={engineState} send={send} />}
                {state?.phase === 'workspace' && <button type="button" className="primary-btn" onClick={() => send({ type: 'setupOpenFolder' })}><FolderOpen size={14} />{t('setupOpenFolder')}</button>}
                {state?.phase === 'offline' && <div className="setup-recovery"><p>{t('engineOfflineUnsupported')}</p><button type="button" className="primary-btn" onClick={() => { send({ type: 'setOfflineMode', enabled: false }); }}>{t('setupGoOnline')}</button><button type="button" className="ghost-btn" onClick={() => props.onChoose('local')}>{t('setupRunLocal')}</button></div>}
                {state?.busy && <p className="setup-muted" role="status">{t('engineBusyHint')}</p>}
                {state?.errorKey && <p className="setup-error" role="alert">{tOrRaw(state.errorKey)}</p>}
                {state?.detail && <details className="setup-detail"><summary>{t('engineDetails')}</summary><pre dir="auto">{state.detail}</pre></details>}
                {hasModels && !editingConnection && <>
                    <SetupModelPicker models={state!.models} selected={selected} freeOnly={path === 'free'} onSelect={setSelected} />
                    {path === 'free' && state?.phase === 'attention' && <p className="setup-muted" role="status">{t('setupFreeUnavailable')}</p>}
                    <button type="button" className="primary-btn setup-start" disabled={!ready} onClick={() => { if (!state || !canStartSetup(state, selected)) return; setStarting(true); send({ type: 'setupComplete', requestId: state.requestId, model: selected }); }}>
                        {starting ? <RefreshCw size={14} className="spinning" /> : locale === 'fa' ? <ArrowLeft size={14} /> : <ArrowRight size={14} />}{t('setupStartChat')}
                    </button>
                    {path === 'free' && <span className="setup-muted setup-footnote">{t('setupAvailabilityHint')}</span>}
                    {path !== 'free' && <button type="button" className="ghost-btn small" onClick={() => setEditingConnection(true)}>{t('setupChangeConnection')}</button>}
                </>}
                {!hasModels && state?.phase === 'model' && <p className="setup-muted" role="status">{t(path === 'free' ? 'setupNoFreeModels' : 'setupNoModels')}</p>}
                {path === 'provider' && (editingConnection || !hasModels && !!state && state.phase !== 'checking') && props.credentials}
                {path === 'local' && (!hasModels || editingConnection) && <div className="setup-local">
                    <div className="setup-local-head"><span>{t(!state || state.phase === 'checking' || props.localModelsScanning ? 'setupChecking' : props.localRuntimes.length ? 'setupDetected' : 'setupLocalNotFound')}</span><button type="button" className="ghost-btn small" onClick={props.onRescan} disabled={props.localModelsScanning} aria-label={t('credLocalRescan')}><RefreshCw size={13} className={props.localModelsScanning ? 'spinning' : undefined} /></button></div>
                    {props.localScanError && <p className="setup-error" role="alert">{t('credScanFailed')}</p>}
                    {props.localRuntimes.map((runtime) => <div key={runtime.id} className="setup-runtime">
                        <div className="setup-runtime-head"><Laptop size={15} /><strong dir="ltr">{runtime.name}</strong><span className="setup-muted">{runtime.modelCount ? `${runtime.modelCount}` : t('setupNoModels')}</span><button type="button" className="secondary-btn" disabled={!runtime.modelCount || starting} onClick={() => props.onConnectRuntime(runtime)}>{t('credConnect')}</button></div>
                        <span className="setup-runtime-url" dir="ltr">{runtime.baseUrl}</span>
                        {!runtime.modelCount && runtime.runtime === 'ollama' && <LocalModelManager runtime={runtime} operation={props.localModelOperation} offline={props.offline} onManage={(action, baseUrl, model) => send({ type: 'manageLocalModel', action, baseUrl, model })} />}
                        {!runtime.modelCount && runtime.runtime !== 'ollama' && <p className="setup-muted">{t('setupLoadLocalModel')}</p>}
                    </div>)}
                    <div className="setup-runtime-links">{(['ollama', 'lmstudio', 'vllm', 'llama.cpp'] as const).map((runtime) => <button type="button" className="ghost-btn small" key={runtime} onClick={() => send({ type: 'setupOpenRuntime', runtime })}><span dir="ltr">{runtime === 'lmstudio' ? 'LM Studio' : runtime === 'ollama' ? 'Ollama' : runtime === 'vllm' ? 'vLLM' : runtime}</span><ExternalLink size={12} /></button>)}</div>
                    <details className="setup-detail"><summary>{t('setupCustomEndpoint')}</summary>{props.credentials}</details>
                </div>}
            </section>}
            <footer className="setup-footer">
                {(path || props.canBack) && <button type="button" className="ghost-btn small" onClick={() => path ? props.onChoose(null) : props.onBack()} disabled={starting}><Back size={13} />{t(path ? 'setupOtherWay' : 'surfaceBack')}</button>}
                {stage === 2 && <span>{t('setupApprovalHint')}</span>}
            </footer>
        </div>
    </main>;
}
