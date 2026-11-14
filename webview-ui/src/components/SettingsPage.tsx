import { useEffect, useState } from 'react';
import { RotateCcw, BookOpen, ArrowLeft, ArrowRight, Trash2, CircleHelp, Search, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { getLocale, t, type StringKey } from '../i18n';
import { conversationPrefs, prefOn, transcriptOptions, type TranscriptOptions, type TranscriptPrefs } from '../transcriptPrefs';
import { Dropdown } from './Dropdown';
import { SidePanel } from './SidePanel';

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
    return <span className="preference-help" role="img" tabIndex={0} title={text} aria-label={text}><CircleHelp size={12} aria-hidden="true" /></span>;
}

export function SettingsPage({
    nativeEngine = false,
    onBack, onOpenProxy, proxySummary,
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
    const [query, setQuery] = useState('');
    const [advanced, setAdvanced] = useState(false);
    const normalize = (value: string) => value.toLocaleLowerCase().replace(/\u064a/g, 'ی').replace(/\u0643/g, 'ک');
    const terms = normalize(query.trim()).split(/\s+/).filter(Boolean);
    const matches = (...keys: StringKey[]) => {
        const text = normalize(keys.map(key => t(key)).join(' '));
        return terms.every(term => text.includes(term));
    };
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
    function choice<K extends 'detail' | 'reasoning' | 'commands' | 'progress'>(id: K, label: StringKey, choices: readonly [TranscriptOptions[K], StringKey][]) {
        if (!matches('surfaceConversation', label, ...choices.map(([, key]) => key))) return null;
        return <div key={id} className="settings-nav-row conversation-preference">
            <label className="settings-nav-main" htmlFor={`tx-${id}`}><strong id={`tx-${id}-label`}>{t(label)}</strong></label>
            <Dropdown id={`tx-${id}`} label={t(label)} value={String(options[id])}
                options={choices.map(([value, key]) => ({ value: String(value), label: t(key) }))}
                onChange={value => onSetTranscriptOptions?.({ [id]: value })} />
        </div>;
    }
    function toggle(id: 'compactCompleted' | 'followActivity' | 'timestamps' | 'showContextMeter', label: StringKey) {
        if (!matches('surfaceConversation', label)) return null;
        const value = pendingToggles[id] ?? options[id];
        return <div key={id} className="settings-nav-row conversation-preference"><div className="settings-nav-main"><strong>{t(label)}</strong>{id === 'followActivity' && <PreferenceHelp text={t('txFollowActivityDesc')} />}</div><button type="button" className={`mcp-switch${value ? ' on' : ''}`} role="switch" aria-checked={value} aria-label={t(label)} onClick={() => { const next = !value; setPendingToggles((current) => ({ ...current, [id]: next })); onSetTranscriptOptions?.({ [id]: next }); }}><span className="mcp-switch-knob" /></button></div>;
    }

    const languageVisible = matches('miniLanguage', 'settingsLanguage', 'settingsLanguageEnglish', 'settingsLanguagePersian') || matches('miniLanguage', 'settingsReplyLanguage', 'settingsReplyAuto', 'settingsLanguageEnglish', 'settingsLanguagePersian');
    const conversationRows = [
        choice('detail', 'txDetail', [['minimal', 'txMinimal'], ['balanced', 'txBalanced'], ['detailed', 'txDetailed']]),
        choice('reasoning', 'miniThinking', [['activity', 'txActivityOnly'], ['collapsed', 'txCollapsed'], ['expanded', 'txExpanded']]),
        choice('commands', 'miniCommands', [['collapsed', 'txCollapsed'], ['errors', 'txOnFailure'], ['expanded', 'txExpanded']]),
        toggle('followActivity', 'txFollowActivity'),
        toggle('showContextMeter', 'txShowContextMeter'),
    ];
    const advancedRows = [
        matches('surfaceConversation', 'miniFiles', 'txSummary', 'txInline') ? <div key="edit" className="settings-nav-row conversation-preference"><label className="settings-nav-main" htmlFor="tx-diffs"><strong>{t('miniFiles')}</strong></label><Dropdown id="tx-diffs" label={t('miniFiles')} value={prefOn(displayPrefs, 'edit') ? 'inline' : 'summary'} options={[{ value: 'summary', label: t('txSummary') }, { value: 'inline', label: t('txInline') }]} onChange={value => onSetTranscriptPref?.('edit', value === 'inline')} /></div> : null,
        choice('progress', 'txProgress', [['latest', 'txLatest'], ['all', 'txKeepAll']]),
        toggle('compactCompleted', 'txCompactCompleted'),
        toggle('timestamps', 'txTimestamps'),
    ];
    const advancedVisible = advancedRows.some(Boolean);
    const conversationVisible = [...conversationRows, ...advancedRows].some(Boolean);
    const networkVisible = ['offlineMode', 'proxyPageTitle', 'errorExplanations'].some(key => matches('surfaceNetwork', key as StringKey));
    const dataVisible = matches('surfaceLocalData', 'settingsClearHistory');

    return (
        <div className="settings-page preferences-page">
            <header className="settings-head">
                <button type="button" className="ghost-btn small" onClick={onBack} aria-label={t('credBack')} title={t('credBack')}>
                    {getLocale() === 'fa' ? <ArrowRight size={14} /> : <ArrowLeft size={14} />}
                </button>
                <div className="settings-head-copy"><h2>{t('settingsTitle')}</h2></div>
            </header>
            <div className="settings-scroll">
                <div className="preference-search">
                    <Search size={15} aria-hidden="true" />
                    <input type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={t('settingsSearch')} placeholder={t('settingsSearch')} />
                    {query && <button type="button" className="ghost-btn" aria-label={t('settingsClearSearch')} title={t('settingsClearSearch')} onClick={() => setQuery('')}><X size={14} /></button>}
                </div>
                {error && <div className="settings-status error" role="status"><span className="settings-status-dot" /><span>{error}</span></div>}

                {languageVisible && <section className="settings-card preference-section">
                    <div className="settings-section-head"><h3>{t('miniLanguage')}</h3></div>
                    <div className="preference-group">
                        {matches('miniLanguage', 'settingsLanguage', 'settingsLanguageEnglish', 'settingsLanguagePersian') && <div className="settings-nav-row">
                            <label className="settings-nav-main" htmlFor="settings-language"><strong>{t('settingsLanguage')}</strong></label>
                            <Dropdown id="settings-language" label={t('settingsLanguage')} value={locale} options={[{ value: 'en', label: t('settingsLanguageEnglish') }, { value: 'fa', label: t('settingsLanguagePersian') }]} onChange={value => onSetLocale(value as 'en' | 'fa')} />
                        </div>}
                        {matches('miniLanguage', 'settingsReplyLanguage', 'settingsReplyAuto', 'settingsLanguageEnglish', 'settingsLanguagePersian') && <div className="settings-nav-row">
                            <div className="settings-nav-main"><label htmlFor="settings-reply-language"><strong>{t('settingsReplyLanguage')}</strong></label><PreferenceHelp text={t('settingsReplyLanguageDesc')} /></div>
                            <Dropdown id="settings-reply-language" label={t('settingsReplyLanguage')} value={replyLanguage} options={[{ value: 'auto', label: t('settingsReplyAuto') }, { value: 'en', label: t('settingsLanguageEnglish') }, { value: 'fa', label: t('settingsLanguagePersian') }]} onChange={value => onSetReplyLanguage?.(value as 'en' | 'fa' | 'auto')} />
                        </div>}
                    </div>
                </section>}

                {conversationVisible && <section className="settings-card preference-section">
                    <div className="settings-section-head">
                        <h3>{t('surfaceConversation')}</h3>
                        <button type="button" className="settings-ghost-action conversation-reset" aria-label={t('txReset')} title={t('txReset')} onClick={onResetTranscriptPrefs}><RotateCcw size={12} /><span>{t('txResetShort')}</span></button>
                    </div>
                    <div className="preference-group">
                        {conversationRows}
                        {advancedVisible && <details className="conversation-advanced" open={terms.length > 0 || advanced} onToggle={event => { if (!terms.length) setAdvanced(event.currentTarget.open); }}>
                            <summary>{t('txAdvanced')}</summary>
                            {advancedRows}
                        </details>}
                    </div>
                </section>}

                {networkVisible && <section className="settings-card preference-section settings-network">
                    <div className="settings-section-head"><h3>{t('surfaceNetwork')}</h3></div>
                    <div className="preference-group">
                        {matches('surfaceNetwork', 'offlineMode') && <div className="settings-nav-row">
                            <div className="settings-nav-main"><strong>{t('offlineMode')}</strong><PreferenceHelp text={t('offlineModeDesc')} /></div>
                            <button type="button" className="ghost-btn small" aria-label={t('offlineHelp')} title={t('offlineHelp')} onClick={onOfflineHelp}><BookOpen size={13} /></button>
                            <button type="button" className={`mcp-switch${offline ? ' on' : ''}`} role="switch" aria-checked={offline} aria-label={t('offlineMode')} onClick={() => onSetOffline?.(!offline)}><span className="mcp-switch-knob" /></button>
                        </div>}
                        {nativeEngine && offline && matches('surfaceNetwork', 'offlineMode') && <p className="scope-hint">{t('setupNativeOffline')}</p>}
                        {matches('surfaceNetwork', 'errorExplanations') && <div className="settings-nav-row">
                            <div className="settings-nav-main"><strong>{t('errorExplanations')}</strong><PreferenceHelp text={t('errorExplanationsDesc')} /></div>
                            <button type="button" className={`mcp-switch${errorExplanations ? ' on' : ''}`} role="switch" aria-checked={errorExplanations} aria-label={t('errorExplanations')} onClick={() => onSetErrorExplanations?.(!errorExplanations)}><span className="mcp-switch-knob" /></button>
                        </div>}
                        {matches('surfaceNetwork', 'proxyPageTitle') && <button type="button" className="settings-nav-row settings-configure-proxy" onClick={onOpenProxy}>
                            <span className="settings-nav-main"><strong>{t('proxyPageTitle')}</strong></span><span className="preference-proxy-value" dir="ltr">{proxySummary || t('surfaceConfigure')}</span>{getLocale() === 'fa' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                        </button>}
                    </div>
                </section>}

                {dataVisible && <section className="settings-card preference-section">
                    <div className="settings-section-head"><h3>{t('surfaceLocalData')}</h3></div>
                    <div className="preference-group"><div className="settings-nav-row">
                        <div className="settings-nav-main"><strong>{t('surfaceHistory')}</strong></div>
                        <button type="button" className="settings-ghost-action preference-clear-history" onClick={() => setConfirmClear(true)}><Trash2 size={13} /><span>{t('settingsClearHistory')}</span></button>
                    </div></div>
                </section>}
                {!languageVisible && !conversationVisible && !networkVisible && !dataVisible && <p className="preference-no-results" role="status">{t('settingsNoMatches')}</p>}
                {version && !terms.length && <div className="settings-footer" dir="ltr">Xratu v{version}</div>}
            </div>
            {confirmClear && <SidePanel label={t('settingsClearConfirm')} className="history-confirm compact-dialog" onClose={() => setConfirmClear(false)}>
                <header className="drawer-head"><h3>{t('settingsClearConfirm')}</h3><button type="button" className="ghost-btn" aria-label={t('editCancel')} title={t('editCancel')} onClick={() => setConfirmClear(false)}><X size={14} /></button></header>
                <div className="history-confirm-body"><p>{t('settingsClearConfirmDesc')}</p><div className="settings-confirm-actions">
                    <button type="button" className="settings-ghost-action" onClick={() => setConfirmClear(false)}>{t('editCancel')}</button>
                    <button type="button" className="settings-danger-action" onClick={() => { onClearHistory?.(); setConfirmClear(false); }}>{t('settingsDelete')}</button>
                </div></div>
            </SidePanel>}
        </div>
    );
}
