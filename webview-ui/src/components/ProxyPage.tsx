import { useEffect, useMemo, useState } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    Check,
    Globe,
    Info,
    PlugZap,
    Radar,
    Server,
    X,
} from 'lucide-react';
import { getLocale, t, tf } from '../i18n';
import { Dropdown } from './Dropdown';
import type {
    McpServerView,
    ProxyCandidateView,
    ProxyRouteMode,
    ProxyStateView,
} from '../types';

interface ProxyPageProps {
    onBack: () => void;
    /** Live host resolution + stored settings (null until the first echo). */
    state: ProxyStateView | null;
    /** Scan results; null = not scanned yet in this session. */
    candidates: ProxyCandidateView[] | null;
    detecting: boolean;
    testing: boolean;
    testResult: { ok: boolean; detail?: string; detailKey?: string; params?: Record<string, string> } | null;
    /** MCP servers for per-server routing overrides. */
    servers: McpServerView[];
    onGetState: () => void;
    onSave: (mode: 'auto' | 'custom' | 'off', proxyUrl: string, noProxy: string) => void;
    onDetect: () => void;
    onTest: () => void;
    onSetServerProxy: (name: string, mode: ProxyRouteMode) => void;
    onSetAllProxies: (mode: ProxyRouteMode) => void;
}

type Scheme = 'http' | 'https' | 'socks5';

interface ServerDraft {
    scheme: Scheme;
    host: string;
    port: string;
}

/** `http://127.0.0.1:7890` → the three editable fields. Anything the fields
 *  cannot express (auth, path) still round-trips via the raw host+port. */
function splitProxyUrl(url: string): ServerDraft {
    const trimmed = (url ?? '').trim();
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/:]+)(?::(\d+))?/i.exec(trimmed);
    if (!match) {
        return { scheme: 'http', host: trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, ''), port: '' };
    }
    const scheme = (match[1].toLowerCase() === 'https' || match[1].toLowerCase() === 'socks5'
        ? match[1].toLowerCase()
        : 'http') as Scheme;
    return { scheme, host: match[2], port: match[3] ?? '' };
}

function joinProxyUrl(draft: ServerDraft): string {
    const host = draft.host.trim();
    if (!host) return '';
    const port = draft.port.trim();
    return `${draft.scheme}://${host}${port ? `:${port}` : ''}`;
}

const SOURCE_KEYS: Record<ProxyStateView['resolvedSource'], Parameters<typeof t>[0]> = {
    setting: 'proxySourceSetting',
    vscode: 'proxySourceVscode',
    env: 'proxySourceEnv',
    system: 'proxySourceSystem',
    none: 'proxySourceNone',
};

const MODE_TIPS: Record<'auto' | 'custom' | 'off', Parameters<typeof t>[0]> = {
    auto: 'proxyModeAutoTip',
    custom: 'proxyModeCustomTip',
    off: 'proxyModeOffTip',
};

export function ProxyPage({
    onBack,
    state,
    candidates,
    detecting,
    testing,
    testResult,
    servers,
    onGetState,
    onSave,
    onDetect,
    onTest,
    onSetServerProxy,
    onSetAllProxies,
}: ProxyPageProps) {
    const [mode, setMode] = useState<'auto' | 'custom' | 'off'>('auto');
    const [serverDraft, setServerDraft] = useState<ServerDraft>({ scheme: 'http', host: '', port: '' });
    const [noProxy, setNoProxy] = useState('');

    // Host echo is the source of truth - re-sync drafts when it lands.
    useEffect(() => {
        if (!state) return;
        setMode(state.mode);
        setServerDraft(splitProxyUrl(state.proxyUrl));
        setNoProxy(state.noProxy);
    }, [state]);

    useEffect(() => {
        onGetState();
        // One shot on mount: fetch settings AND scan for local proxy clients -
        // the list should be there without a manual rescan on every visit.
        onDetect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const composedUrl = useMemo(() => joinProxyUrl(serverDraft), [serverDraft]);
    const dirty = !!state && (
        mode !== state.mode
        || composedUrl !== (state.proxyUrl ?? '').trim()
        || noProxy.trim() !== (state.noProxy ?? '').trim()
    );
    const socksWarn = serverDraft.scheme === 'socks5';
    /** The save check marks a click, not the idle state - it drops again as
     *  soon as something new is drafted. */
    const [justSaved, setJustSaved] = useState(false);
    useEffect(() => {
        if (dirty) setJustSaved(false);
    }, [dirty]);

    return (
        <div className="settings-page">
            <header className="settings-head">
                <button
                    type="button"
                    className="ghost-btn small"
                    onClick={onBack}
                    aria-label={t('credBack')}
                    title={t('credBack')}
                >
                    {getLocale() === 'fa' ? <ArrowRight size={14} /> : <ArrowLeft size={14} />}
                </button>
                <div className="settings-head-copy">
                    <h2>{t('proxyPageTitle')}</h2>
                </div>
                <button
                    type="button"
                    className="icon-btn"
                    onClick={onTest}
                    disabled={testing}
                    title={t('proxyTest')}
                    aria-label={t('proxyTest')}
                >
                    {testing ? <span className="step-status spinner" /> : <PlugZap size={14} />}
                </button>
            </header>

            <div className="settings-scroll">
                {testResult && (
                    <div className={testResult.ok ? 'proxy-test ok' : 'proxy-test fail'} dir="auto" role="status">
                        {testResult.ok ? <Check size={13} /> : <X size={13} />}
                        <span>
                            {testResult.ok ? t('proxyTestOk') : t('proxyTestFail')}
                            {!testResult.ok && (testResult.detailKey
                                ? ` (${tf(testResult.detailKey, testResult.params)})`
                                : testResult.detail ? ` (${testResult.detail})` : '')}
                        </span>
                    </div>
                )}

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Globe size={15} />
                        </div>
                        <h3>{t('proxyCardConnection')}</h3>
                    </div>

                    <div className="settings-nav-row">
                        <div className="settings-nav-main">
                            <strong>{t('proxyModeLabel')}</strong>
                        </div>
                        <div className="lang-choice">
                            {(['auto', 'custom', 'off'] as const).map((m) => (
                                <button
                                    key={m}
                                    type="button"
                                    className={mode === m ? 'lang-chip active' : 'lang-chip'}
                                    title={t(MODE_TIPS[m])}
                                    onClick={() => setMode(m)}
                                >
                                    {m === 'auto' ? t('proxyModeAuto') : m === 'custom' ? t('proxyModeCustom') : t('proxyModeOff')}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="proxy-field-row">
                        <div className="proxy-field">
                            <span className="proxy-field-label">{t('proxySchemeLabel')}</span>
                            <Dropdown
                                label={t('proxySchemeLabel')}
                                value={serverDraft.scheme}
                                options={[
                                    { value: 'http', label: 'http' },
                                    { value: 'https', label: 'https' },
                                    { value: 'socks5', label: 'socks5' },
                                ]}
                                onChange={(next) => setServerDraft((d) => ({ ...d, scheme: next as Scheme }))}
                            />
                        </div>
                        <div className="proxy-field grow">
                            <label htmlFor="proxy-host">{t('proxyHostLabel')}</label>
                            <input
                                id="proxy-host"
                                dir="ltr"
                                type="text"
                                spellCheck={false}
                                placeholder="127.0.0.1"
                                value={serverDraft.host}
                                onChange={(e) => setServerDraft((d) => ({ ...d, host: e.target.value }))}
                            />
                        </div>
                        <div className="proxy-field">
                            <label htmlFor="proxy-port">{t('proxyPortLabel')}</label>
                            <input
                                id="proxy-port"
                                dir="ltr"
                                type="text"
                                inputMode="numeric"
                                spellCheck={false}
                                placeholder="7890"
                                value={serverDraft.port}
                                onChange={(e) => setServerDraft((d) => ({ ...d, port: e.target.value.replace(/[^\d]/g, '') }))}
                            />
                        </div>
                    </div>
                    {socksWarn && (
                        <div className="proxy-hint warn" dir="auto">{t('proxySocksUnsupported')}</div>
                    )}

                    <div className="proxy-field-row">
                        <div className="proxy-field grow">
                            <label htmlFor="proxy-noproxy">{t('proxyNoProxyLabel')}</label>
                            <input
                                id="proxy-noproxy"
                                dir="ltr"
                                type="text"
                                spellCheck={false}
                                placeholder="localhost,127.0.0.1,.internal"
                                value={noProxy}
                                onChange={(e) => setNoProxy(e.target.value)}
                            />
                        </div>
                    </div>
                    <div className="proxy-hint" dir="auto">{t('proxyNoProxyDesc')}</div>

                    <div className="proxy-save-row">
                        {state && (
                            <div className="proxy-status" dir="auto">
                                <span>{t('proxyStatusTitle')}</span>
                                <strong dir="ltr">{state.resolvedUrl ?? t('proxyStatusDirect')}</strong>
                                <span className="proxy-source-chip">{t(SOURCE_KEYS[state.resolvedSource])}</span>
                            </div>
                        )}
                        <button
                            type="button"
                            className="apply-btn"
                            disabled={!dirty || socksWarn}
                            onClick={() => {
                                setJustSaved(true);
                                onSave(mode, composedUrl, noProxy);
                            }}
                        >
                            {justSaved && !dirty ? <Check size={13} /> : null}
                            {t('proxySave')}
                        </button>
                    </div>
                </section>

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Radar size={15} />
                        </div>
                        <h3>{t('proxyCardDetect')}</h3>
                        <button
                            type="button"
                            className="icon-btn proxy-head-action"
                            onClick={onDetect}
                            disabled={detecting}
                            title={t('proxyScan')}
                            aria-label={t('proxyScan')}
                        >
                            {detecting ? <span className="step-status spinner" /> : <Radar size={14} />}
                        </button>
                    </div>

                    {candidates === null && !detecting && (
                        <div className="proxy-hint" dir="auto">{t('proxyDetectIdle')}</div>
                    )}
                    {candidates !== null && candidates.length === 0 && (
                        <div className="proxy-hint" dir="auto">{t('proxyDetectEmpty')}</div>
                    )}
                    {candidates?.map((c) => (
                        <div key={c.service + (c.ports[0]?.port ?? '')} className="proxy-candidate">
                            <div className="proxy-candidate-main">
                                <div className="proxy-candidate-head">
                                    <strong>{c.service}</strong>
                                    <div className="proxy-port-list" dir="ltr">
                                        {c.ports.map((p) => (
                                            <span
                                                key={p.port}
                                                className={p.usable ? 'proxy-port-chip' : 'proxy-port-chip disabled'}
                                                title={p.url}
                                            >
                                                {p.port} · {p.protocol === 'mixed' ? t('proxyProtoMixed') : p.protocol === 'socks5' ? 'SOCKS5' : 'HTTP'}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            {c.url ? (
                                <button
                                    type="button"
                                    className="apply-btn"
                                    onClick={() => {
                                        const draft = splitProxyUrl(c.url!);
                                        setServerDraft(draft);
                                        setMode('custom');
                                        onSave('custom', c.url!, noProxy);
                                    }}
                                >
                                    {t('proxyUse')}
                                </button>
                            ) : (
                                <span className="proxy-candidate-tag disabled">{t('proxySocksUnsupported')}</span>
                            )}
                        </div>
                    ))}
                    {state?.systemProxy && (
                        <div className="proxy-hint" dir="auto">
                            {t('proxySystemDetected')} <span dir="ltr">{state.systemProxy}</span>
                        </div>
                    )}
                </section>

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Server size={15} />
                        </div>
                        <h3>{t('proxyCardMcp')}</h3>
                    </div>

                    <div className="proxy-mcp-bulk">
                        <span>{t('proxyMcpAll')}</span>
                        <div className="lang-choice">
                            <button type="button" className="lang-chip" onClick={() => onSetAllProxies('auto')}>
                                {t('proxyMcpAuto')}
                            </button>
                            <button type="button" className="lang-chip" onClick={() => onSetAllProxies('proxy')}>
                                {t('proxyMcpProxy')}
                            </button>
                            <button type="button" className="lang-chip" onClick={() => onSetAllProxies('direct')}>
                                {t('proxyMcpDirect')}
                            </button>
                        </div>
                    </div>

                    {servers.length === 0 && (
                        <div className="proxy-hint" dir="auto">{t('proxyMcpEmpty')}</div>
                    )}
                    {servers.map((s) => (
                        <div key={s.name} className="proxy-mcp-row">
                            <div className="proxy-candidate-main">
                                <strong>{s.name}</strong>
                                <span dir="ltr">{s.url ?? s.command ?? ''}</span>
                            </div>
                            <div className="lang-choice">
                                {(['auto', 'proxy', 'direct'] as const).map((m) => (
                                    <button
                                        key={m}
                                        type="button"
                                        className={(s.proxy ?? 'auto') === m ? 'lang-chip active' : 'lang-chip'}
                                        onClick={() => onSetServerProxy(s.name, m)}
                                    >
                                        {m === 'auto' ? t('proxyMcpAuto') : m === 'proxy' ? t('proxyMcpProxy') : t('proxyMcpDirect')}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </section>

                <div className="mcp-hint foot" role="note">
                    <Info size={12} aria-hidden="true" />
                    <span dir="auto">{t('proxyFooterNote')}</span>
                </div>
            </div>
        </div>
    );
}
