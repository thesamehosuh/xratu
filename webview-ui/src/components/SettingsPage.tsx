import { useEffect, useState } from 'react';
import {
    Activity,
    RotateCcw,
    BookOpen,
    ArrowLeft,
    ArrowRight,
    Globe,
    Languages,
    MessageSquare,
    Trash2,
} from 'lucide-react';
import { getLocale, t, type StringKey } from '../i18n';
import { conversationPrefs, prefOn, transcriptOptions, type TranscriptOptions, type TranscriptPrefs } from '../transcriptPrefs';
import { Dropdown } from './Dropdown';

interface SettingsPageProps {
    nativeEngine?: boolean;
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
    onSetTranscriptOptions?: (options: Partial<TranscriptOptions>) => void;
    onResetTranscriptPrefs?: () => void;
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
    nativeEngine = false,
    onBack,
    version,
    error = null,
    locale,
    onSetLocale,
    replyLanguage = 'auto',
    onSetReplyLanguage,
    transcriptPrefs,
    onSetTranscriptPref,
    onSetTranscriptOptions,
    onResetTranscriptPrefs,
    onClearHistory,
    offline = false, errorExplanations = true, onSetOffline, onSetErrorExplanations, onOfflineHelp,
}: SettingsPageProps) {
    const [confirmClear, setConfirmClear] = useState(false);
    const options = transcriptOptions(transcriptPrefs);
    // The switch follows the host echo, so two clicks before that echo would
    // send the same `true` twice. Track the requested value until it lands.
    const [pendingToggles, setPendingToggles] = useState<Record<string, boolean>>({});
    useEffect(() => {
        const settled = transcriptOptions(transcriptPrefs);
        setPendingToggles((current) => {
            const unanswered = Object.entries(current).filter(([id, value]) => settled[id as keyof typeof settled] !== value);
            if (unanswered.length === Object.keys(current).length) return current;
            return Object.fromEntries(unanswered);
        });
    }, [transcriptPrefs]);
    const displayPrefs = conversationPrefs(transcriptPrefs);
    function choice<K extends 'detail' | 'reasoning' | 'commands' | 'progress'>(id: K, label: StringKey, description: StringKey, choices: readonly [TranscriptOptions[K], StringKey][]) {
        return <div className="settings-nav-row conversation-preference">
            <label className="settings-nav-main" htmlFor={`tx-${id}`}><strong id={`tx-${id}-label`}>{t(label)}</strong><span id={`tx-${id}-hint`} className="preference-description">{t(description)}</span></label>
            <Dropdown id={`tx-${id}`} label={t(label)} describedBy={`tx-${id}-hint`} value={String(options[id])}
                options={choices.map(([value, key]) => ({ value: String(value), label: t(key) }))}
                onChange={value => onSetTranscriptOptions?.({ [id]: value })} />
        </div>;
    }
    function toggle(id: 'compactCompleted' | 'followActivity' | 'timestamps' | 'showContextMeter', label: StringKey, description: StringKey) {
        const value = pendingToggles[id] ?? options[id];
        return <div className="settings-nav-row conversation-preference"><div className="settings-nav-main"><strong>{t(label)}</strong><span className="preference-description" id={`tx-${id}-hint`}>{t(description)}</span></div><button type="button" className={`mcp-switch${value ? ' on' : ''}`} role="switch" aria-checked={value} aria-label={t(label)} aria-describedby={`tx-${id}-hint`} onClick={() => { const next = !value; setPendingToggles((current) => ({ ...current, [id]: next })); onSetTranscriptOptions?.({ [id]: next }); }}><span className="mcp-switch-knob" /></button></div>;
    }

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

                {nativeEngine && offline && <p className="scope-hint">{t('setupNativeOffline')}</p>}
                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Activity size={15} />
                        </div>
                        <h3>{t('surfaceConversation')}</h3>
                        <button type="button" className="settings-ghost-action conversation-reset" aria-label={t('txReset')} title={t('txReset')} onClick={onResetTranscriptPrefs}><RotateCcw size={12} /><span>{t('txResetShort')}</span></button>
                    </div>
                    {choice('detail', 'txDetail', 'txDetailDesc', [['minimal', 'txMinimal'], ['balanced', 'txBalanced'], ['detailed', 'txDetailed']])}
                    {toggle('showContextMeter', 'txShowContextMeter', 'txShowContextMeterDesc')}
                    <details className="conversation-advanced"><summary>{t('txAdvanced')}</summary>
                        {choice('reasoning', 'miniThinking', 'txReasoningDesc', [['activity', 'txActivityOnly'], ['collapsed', 'txCollapsed'], ['expanded', 'txExpanded']])}
                        <div className="settings-nav-row conversation-preference"><label className="settings-nav-main" htmlFor="tx-diffs"><strong id="tx-diffs-label">{t('miniFiles')}</strong><span className="preference-description" id="tx-diffs-hint">{t('txDiffsDesc')}</span></label><Dropdown id="tx-diffs" label={t('miniFiles')} describedBy="tx-diffs-hint" value={prefOn(displayPrefs, 'edit') ? 'inline' : 'summary'} options={[{ value: 'summary', label: t('txSummary') }, { value: 'inline', label: t('txInline') }]} onChange={value => onSetTranscriptPref?.('edit', value === 'inline')} /></div>
                        {choice('commands', 'miniCommands', 'txCommandsDesc', [['collapsed', 'txCollapsed'], ['errors', 'txOnFailure'], ['expanded', 'txExpanded']])}
                        {choice('progress', 'txProgress', 'txProgressDesc', [['latest', 'txLatest'], ['all', 'txKeepAll']])}
                        {toggle('compactCompleted', 'txCompactCompleted', 'txCompactCompletedDesc')}
                        {toggle('followActivity', 'txFollowActivity', 'txFollowActivityDesc')}
                        {toggle('timestamps', 'txTimestamps', 'txTimestampsDesc')}
                    </details>
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
