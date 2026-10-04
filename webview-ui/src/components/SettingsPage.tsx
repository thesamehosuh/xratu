import { useState } from 'react';
import {
    Activity,
    ArrowLeft,
    ArrowRight,
    ChevronLeft,
    ChevronRight,
    Globe,
    Languages,
    Link,
    MessageSquare,
    Trash2,
} from 'lucide-react';
import { getLocale, t } from '../i18n';
import { prefOn, TRANSCRIPT_ROWS, type TranscriptPrefs } from '../transcriptPrefs';

interface SettingsPageProps {
    onBack: () => void;
    version?: string | null;
    error?: string | null;
    locale: 'fa' | 'en';
    onSetLocale: (locale: 'fa' | 'en') => void;
    /** Agent reply language ('auto' = follow the user's message language). */
    replyLanguage?: 'fa' | 'en' | 'auto';
    onSetReplyLanguage?: (language: 'fa' | 'en' | 'auto') => void;
    /** Host-persisted auto-expand prefs (diffs / commands / thinking);
     *  `onSetTranscriptPref` round-trips through the host, which echoes the
     *  merged blob back - the switch never renders ahead of it. */
    transcriptPrefs?: TranscriptPrefs;
    onSetTranscriptPref?: (id: string, enabled: boolean) => void;
    onOpenCredentials?: () => void;
    /** Open the merged capabilities page (MCP servers + Agent Skills). */
    onOpenCapabilities?: () => void;
    /** Open the dedicated usage page. */
    onOpenUsage?: () => void;
    /** Open the proxy page (routing, local proxy detection, per-MCP policy). */
    onOpenProxy?: () => void;
    /** Live resolution summary shown on the proxy row (e.g. a proxy URL). */
    proxySummary?: string | null;
    onClearHistory?: () => void;
}

export function SettingsPage({
    onBack,
    version,
    error = null,
    locale,
    onSetLocale,
    replyLanguage = 'auto',
    onSetReplyLanguage,
    transcriptPrefs,
    onSetTranscriptPref,
    onOpenCredentials,
    onOpenCapabilities,
    onOpenUsage,
    onOpenProxy,
    proxySummary = null,
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
                        <h3>{t('settingsConnections')}</h3>
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

                    <button type="button" className="settings-nav-row" onClick={onOpenUsage}>
                        <div className="settings-nav-main">
                            <strong>{t('settingsUsage')}</strong>
                            <span>{t('settingsUsageDesc')}</span>
                        </div>
                        {getLocale() === 'fa' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                    </button>

                </section>

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Globe size={15} />
                        </div>
                        <h3>{t('proxyPageTitle')}</h3>
                    </div>

                    <button type="button" className="settings-nav-row" onClick={onOpenProxy}>
                        <div className="settings-nav-main">
                            <strong>{t('settingsProxy')}</strong>
                            <span dir="auto">
                                {proxySummary
                                    ? `${t('proxyStatusTitle')}: ${proxySummary}`
                                    : t('settingsProxyDesc')}
                            </span>
                        </div>
                        {getLocale() === 'fa' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                    </button>
                </section>

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Activity size={15} />
                        </div>
                        <h3>{t('settingsTranscript')}</h3>
                    </div>

                    {TRANSCRIPT_ROWS.map(({ id, labelKey, descKey }) => {
                        const on = prefOn(transcriptPrefs, id);
                        const label = t(labelKey);
                        return (
                            <div className="settings-nav-row" key={id}>
                                <div className="settings-nav-main">
                                    <strong>{label}</strong>
                                    <span>{t(descKey)}</span>
                                </div>
                                <button
                                    type="button"
                                    className={`mcp-switch${on ? ' on' : ''}`}
                                    role="switch"
                                    aria-checked={on}
                                    aria-label={label}
                                    title={label}
                                    onClick={() => onSetTranscriptPref?.(id, !on)}
                                >
                                    <span className="mcp-switch-knob" />
                                </button>
                            </div>
                        );
                    })}
                </section>

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Languages size={15} />
                        </div>
                        <h3>{t('settingsLocale')}</h3>
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

                    <div className="settings-nav-row">
                        <div className="settings-nav-main">
                            <strong>{t('settingsReplyLanguage')}</strong>
                            <span>{t('settingsReplyLanguageDesc')}</span>
                        </div>
                        <div className="lang-choice">
                            <button
                                type="button"
                                className={replyLanguage === 'fa' ? 'lang-chip active' : 'lang-chip'}
                                onClick={() => onSetReplyLanguage?.('fa')}
                            >
                                فارسی
                            </button>
                            <button
                                type="button"
                                className={replyLanguage === 'en' ? 'lang-chip active' : 'lang-chip'}
                                onClick={() => onSetReplyLanguage?.('en')}
                            >
                                English
                            </button>
                            <button
                                type="button"
                                className={replyLanguage === 'auto' ? 'lang-chip active' : 'lang-chip'}
                                onClick={() => onSetReplyLanguage?.('auto')}
                            >
                                {t('settingsReplyAuto')}
                            </button>
                        </div>
                        <MessageSquare size={14} />
                    </div>

                </section>

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Trash2 size={15} />
                        </div>
                        <h3>{t('settingsDanger')}</h3>
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
