import { useState } from 'react';
import {
    Activity,
    BookOpen,
    ArrowLeft,
    ArrowRight,
    Globe,
    Languages,
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
    offline?: boolean;
    errorExplanations?: boolean;
    onSetOffline?: (enabled: boolean) => void;
    onSetErrorExplanations?: (enabled: boolean) => void;
    onOfflineHelp?: () => void;
    onClearHistory?: () => void;
}

function PreferenceHelp({ text }: { text: string }) {
    return <span className="preference-help" role="img" tabIndex={0} title={text} aria-label={text}>?</span>;
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
    onClearHistory,
    offline = false, errorExplanations = true, onSetOffline, onSetErrorExplanations, onOfflineHelp,
}: SettingsPageProps) {
    const [confirmClear, setConfirmClear] = useState(false);

    return (
        <div className="settings-page preferences-page">
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
                    <div className="settings-nav-row">
                        <div className="settings-nav-main">
                            <strong>{t('offlineMode')}</strong>
                            <PreferenceHelp text={t('offlineModeDesc')} />
                        </div>
                        <button className="ghost-btn small" aria-label={t('offlineHelp')} title={t('offlineHelp')} onClick={onOfflineHelp}><BookOpen size={13} /></button>
                        <button type="button" className={`mcp-switch${offline ? ' on' : ''}`} role="switch"
                            aria-checked={offline} aria-label={t('offlineMode')} onClick={() => onSetOffline?.(!offline)}><span className="mcp-switch-knob" /></button>
                    </div>
                </section>

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Activity size={15} />
                        </div>
                        <h3>{t('miniExpansion')}</h3>
                    </div>

                    {TRANSCRIPT_ROWS.map(({ id, descKey }) => {
                        const on = prefOn(transcriptPrefs, id);
                        const label = t(id === 'edit' ? 'miniFiles' : id === 'terminal' ? 'miniCommands' : 'miniThinking');
                        return (
                            <div className="settings-nav-row" key={id}>
                                <div className="settings-nav-main">
                                    <strong>{label}</strong>
                                    <PreferenceHelp text={t(descKey)} />
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
                        <h3>{t('miniAppearance')}</h3>
                    </div>

                    <div className="settings-nav-row">
                        <div className="settings-nav-main">
                            <strong>{t('miniLanguage')}</strong>
                            <PreferenceHelp text={t('settingsLanguageDesc')} />
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
                            <PreferenceHelp text={t('settingsReplyLanguageDesc')} />
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
                    <div className="settings-nav-row">
                        <div className="settings-nav-main">
                            <strong>{t('errorExplanations')}</strong>
                            <PreferenceHelp text={t('errorExplanationsDesc')} />
                        </div>
                        <button type="button" className={`mcp-switch${errorExplanations ? ' on' : ''}`} role="switch"
                            aria-checked={errorExplanations} aria-label={t('errorExplanations')} onClick={() => onSetErrorExplanations?.(!errorExplanations)}><span className="mcp-switch-knob" /></button>
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
                                <PreferenceHelp text={t('settingsClearConfirmDesc')} />
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
