import { useEffect, useState } from 'react';
import { Check, KeyRound, Laptop, RefreshCw } from 'lucide-react';
import { t } from '../i18n';
import type { DiscoveredLocalRuntime } from '../types';

interface WelcomeProps {
    localRuntimes: DiscoveredLocalRuntime[];
    localModelsScanning: boolean;
    /** Host-reported discovery failure - distinct from "nothing found". */
    localScanError: string | null;
    /** UI language - the welcome screen is the FIRST impression, so the
     *  fa/en flip is offered right here, before any provider setup. */
    locale: 'fa' | 'en';
    onSetLocale: (locale: 'fa' | 'en') => void;
    /** One-click connect to a discovered local runtime. */
    onConnectRuntime: (rt: DiscoveredLocalRuntime) => void;
    /** Open the credentials page (full provider list + custom URL). */
    onOpenCredentials: () => void;
    onRescan: () => void;
}

/** First-run screen: connect a provider and go. BYOK + local runtimes only -
 *  the auto-discovery scan finds Ollama/LM Studio/vLLM/llama.cpp on this
 *  machine so a local user is one click from their first chat. */
export function Welcome({
    localRuntimes,
    localModelsScanning,
    localScanError,
    locale,
    onSetLocale,
    onConnectRuntime,
    onOpenCredentials,
    onRescan,
}: WelcomeProps) {
    /** Runtime id currently connecting - spinner until the host echoes
     *  credentialsSaved (which lands the user in chat) or errors. */
    const [connectingId, setConnectingId] = useState<string | null>(null);

    // Scan for local runtimes on first render - the onboarding beat is
    // "found Ollama on your machine, use it?".
    useEffect(() => {
        onRescan();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // A failed connect leaves the user on this screen - new scan results or
    // a reported scan error mean the attempt did not land in chat, so the
    // button must not stay stuck on its spinner.
    useEffect(() => {
        setConnectingId(null);
    }, [localRuntimes, localScanError]);

    return (
        <main className="welcome">
            <section className="welcome-hero">
                <div className="welcome-mark" aria-hidden="true">
                    <KeyRound size={22} />
                </div>
                <h1>{t('welcomeHeading')}</h1>
                <p className="welcome-sub">{t('welcomeSub')}</p>
                <button type="button" className="primary-btn welcome-cta" onClick={onOpenCredentials}>
                    <KeyRound size={15} />
                    <span>{t('welcomeCta')}</span>
                </button>
                <p className="welcome-privacy">{t('credSecurityHint')}</p>
                <div className="lang-choice welcome-lang" role="group" aria-label={t('settingsLanguage')}>
                    <button
                        type="button"
                        className={locale === 'fa' ? 'lang-chip active' : 'lang-chip'}
                        onClick={() => onSetLocale('fa')}
                    >
                        فارسی
                    </button>
                    <button
                        type="button"
                        className={locale === 'en' ? 'lang-chip active' : 'lang-chip'}
                        onClick={() => onSetLocale('en')}
                    >
                        English
                    </button>
                </div>
            </section>

            <section className="welcome-local">
                <h2>{t('welcomeFoundHeading')}</h2>
                {localModelsScanning && localRuntimes.length === 0 && (
                    <div className="welcome-empty">
                        <span dir="auto">{t('welcomeScanning')}</span>
                        <button
                            type="button"
                            className="ghost-btn small"
                            disabled
                            title={t('credLocalRetry')}
                            aria-label={t('credLocalRetry')}
                        >
                            <RefreshCw size={13} className="spinning" />
                        </button>
                    </div>
                )}
                {localRuntimes.map((rt) => {
                    const busy = connectingId === rt.id;
                    return (
                        <div key={rt.id} className="welcome-runtime">
                            <div className="welcome-runtime-info">
                                <span className="welcome-runtime-name">
                                    <Laptop size={13} />
                                    {rt.name}
                                </span>
                                <span className="welcome-runtime-meta" dir="ltr">
                                    {rt.baseUrl} · {rt.modelCount} {t('credLocalModelsCount')}
                                </span>
                            </div>
                            <button
                                type="button"
                                className="welcome-runtime-connect"
                                disabled={busy}
                                onClick={() => {
                                    setConnectingId(rt.id);
                                    onConnectRuntime(rt);
                                }}
                            >
                                {busy ? <RefreshCw size={12} className="spinning" /> : <Check size={12} />}
                                {busy ? t('credConnecting') : t('credConnect')}
                            </button>
                        </div>
                    );
                })}
                {!localModelsScanning && localRuntimes.length === 0 && (
                    <div className="welcome-empty">
                        <span dir="auto">{localScanError ? t('credScanFailed') : t('welcomeNoneFound')}</span>
                        <button
                            type="button"
                            className="ghost-btn small"
                            title={t('credLocalRetry')}
                            aria-label={t('credLocalRetry')}
                            onClick={onRescan}
                        >
                            <RefreshCw size={13} className={localModelsScanning ? 'spinning' : undefined} />
                        </button>
                    </div>
                )}
            </section>
        </main>
    );
}
