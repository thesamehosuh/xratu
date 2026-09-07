import { useState } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    ChevronLeft,
    ChevronRight,
    Globe,
    Link,
    MessageSquare,
    Trash2,
} from 'lucide-react';
import { getLocale, t } from '../i18n';

interface SettingsPageProps {
    onBack: () => void;
    version?: string | null;
    error?: string | null;
    locale: 'fa' | 'en';
    onSetLocale: (locale: 'fa' | 'en') => void;
    onOpenCredentials?: () => void;
    /** Open the merged capabilities page (MCP servers + Agent Skills). */
    onOpenCapabilities?: () => void;
    onClearHistory?: () => void;
}

export function SettingsPage({
    onBack,
    version,
    error = null,
    locale,
    onSetLocale,
    onOpenCredentials,
    onOpenCapabilities,
    onClearHistory,
}: SettingsPageProps) {
    const [confirmClear, setConfirmClear] = useState(false);

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
                    <h2>{t('settingsTitle')}</h2>
                </div>
            </header>

            <div className="settings-scroll">
                {error && (
                    <div className="settings-status error" role="status">
                        <span className="settings-status-dot" />
                        <span>{error}</span>
                    </div>
                )}

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Link size={15} />
                        </div>
                        <div>
                            <h3>{t('settingsConnections')}</h3>
                            <p>{t('settingsConnectionsDesc')}</p>
                        </div>
                    </div>

                    <button type="button" className="settings-nav-row" onClick={onOpenCredentials}>
                        <div className="settings-nav-main">
                            <strong>{t('settingsCredentials')}</strong>
                            <span>{t('settingsCredentialsDesc')}</span>
                        </div>
                        {getLocale() === 'fa' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                    </button>

                    <button type="button" className="settings-nav-row" onClick={onOpenCapabilities}>
                        <div className="settings-nav-main">
                            <strong>{t('capTitle')}</strong>
                            <span>{t('settingsCapabilitiesDesc')}</span>
                        </div>
                        {getLocale() === 'fa' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                    </button>

                </section>

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <MessageSquare size={15} />
                        </div>
                        <h3>{t('settingsData')}</h3>
                    </div>

                    <div className="settings-nav-row">
                        <div className="settings-nav-main">
                            <strong>{t('settingsLanguage')}</strong>
                            <span>{t('settingsLanguageDesc')}</span>
                        </div>
                        <div className="lang-choice">
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
                        <Globe size={14} />
                    </div>

                    {!confirmClear ? (
                        <button type="button" className="settings-danger-row" onClick={() => setConfirmClear(true)}>
                            <strong>{t('settingsClearHistory')}</strong>
                            <Trash2 size={14} />
                        </button>
                    ) : (
                        <div className="settings-confirm-row danger">
                            <div>
                                <strong>{t('settingsClearConfirm')}</strong>
                                <span>{t('settingsClearConfirmDesc')}</span>
                            </div>
                            <div className="settings-confirm-actions">
                                <button
                                    type="button"
                                    onClick={() => {
                                        onClearHistory?.();
                                        setConfirmClear(false);
                                    }}
                                    className="settings-danger-action"
                                >
                                    {t('settingsDelete')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setConfirmClear(false)}
                                    className="settings-ghost-action"
                                >
                                    {t('editCancel')}
                                </button>
                            </div>
                        </div>
                    )}
                </section>

                {version && (
                    <div className="settings-footer" dir="ltr">
                        Xratu v{version}
                    </div>
                )}
            </div>
        </div>
    );
}
