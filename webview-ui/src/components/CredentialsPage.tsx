import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    Check,
    Eye,
    EyeOff,
    Laptop,
    Link,
    Lock,
    Pencil,
    RefreshCw,
    Search,
    Server,
    Trash2,
    X,
} from 'lucide-react';
import type {
    DiscoveredLocalRuntime,
    SavedCredential,
} from '../types';
import { getLocale, t, tf } from '../i18n';
import type { StringKey } from '../i18n';

interface CredentialsPageProps {
    reason?: string | null;
    error?: string | null;
    currentUrl?: string | null;
    activeCredentialId?: string | null;
    /** Provider preselected on entry (from the setup chips' target:
     *  'byok' → remote provider, 'local' → Ollama). */
    initialOpenCard?: 'byok' | 'local' | null;
    savedCredentials: SavedCredential[];
    localRuntimes: DiscoveredLocalRuntime[];
    localModelsScanning: boolean;
    /** Host-reported discovery failure - distinct from "nothing found". */
    localScanError?: string | null;
    onRetryFetch?: () => void;
    modelsRefreshing?: boolean;
    onSave: (baseUrl: string, apiKey: string) => void;
    onSelectCredential: (id: string) => void;
    onDeleteCredential: (id: string) => void;
    onUpdateCredential: (id: string, apiKey: string) => void;
    onDiscoverLocalModels: () => void;
    onSaveLocalRuntime: (baseUrl: string, apiKey: string | null) => void;
    onBack: () => void;
}

interface Preset {
    id: string;
    label: string;
    /** i18n key overriding `label` (resolved at render so locale flips apply). */
    labelKey?: StringKey;
    group: 'popular' | 'other' | 'local';
    baseUrl: string;
    hint?: string;
    /** i18n key overriding `hint`. */
    hintKey?: StringKey;
    docs?: string;
}

const PRESETS: Preset[] = [
    { id: 'openai', label: 'OpenAI', group: 'popular', baseUrl: 'https://api.openai.com/v1' },
    { id: 'google', label: 'Google Gemini', group: 'popular', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
    { id: 'openrouter', label: 'OpenRouter', group: 'popular', baseUrl: 'https://openrouter.ai/api/v1' },
    { id: 'xai', label: 'xAI', group: 'popular', baseUrl: 'https://api.x.ai/v1' },
    { id: 'groq', label: 'Groq', group: 'popular', baseUrl: 'https://api.groq.com/openai/v1' },
    { id: 'deepseek', label: 'DeepSeek', group: 'popular', baseUrl: 'https://api.deepseek.com' },
    { id: 'mistral', label: 'Mistral', group: 'popular', baseUrl: 'https://api.mistral.ai/v1' },
    { id: 'perplexity', label: 'Perplexity', group: 'other', baseUrl: 'https://api.perplexity.ai' },
    { id: 'cohere', label: 'Cohere', group: 'other', baseUrl: 'https://api.cohere.com/compatibility/v1' },
    { id: 'together', label: 'Together AI', group: 'other', baseUrl: 'https://api.together.xyz/v1' },
    { id: 'fireworks', label: 'Fireworks AI', group: 'other', baseUrl: 'https://api.fireworks.ai/inference/v1' },
    { id: 'cerebras', label: 'Cerebras', group: 'other', baseUrl: 'https://api.cerebras.ai/v1' },
    { id: 'nvidia', label: 'NVIDIA NIM', group: 'other', baseUrl: 'https://integrate.api.nvidia.com/v1' },
    { id: 'huggingface', label: 'Hugging Face', group: 'other', baseUrl: 'https://router.huggingface.co/v1' },
    { id: 'sambanova', label: 'SambaNova', group: 'other', baseUrl: 'https://api.sambanova.ai/v1' },
    { id: 'moonshot', label: 'Moonshot AI', group: 'other', baseUrl: 'https://api.moonshot.cn/v1' },
    { id: 'zai', label: 'Z.AI', group: 'other', baseUrl: 'https://api.z.ai/api/paas/v4' },
    { id: 'opencode', label: 'OpenCode Zen', group: 'other', baseUrl: 'https://opencode.ai/zen/v1' },
    { id: 'ollama', label: 'Ollama', group: 'local', baseUrl: 'http://localhost:11434/v1', hintKey: 'credLocal' },
    { id: 'lmstudio', label: 'LM Studio', group: 'local', baseUrl: 'http://localhost:1234/v1', hintKey: 'credLocal' },
    { id: 'vllm', label: 'vLLM', group: 'local', baseUrl: 'http://localhost:8000/v1', hintKey: 'credLocal' },
    { id: 'custom', label: 'Custom', labelKey: 'customPreset', group: 'other', baseUrl: '', hintKey: 'credOpenAICompatible' },
];

const POPULAR = PRESETS.filter((p) => p.group === 'popular');

/** Display label/hint, honoring the i18n key overrides. */
function presetLabel(p: Preset): string {
    return p.labelKey ? t(p.labelKey) : p.label;
}
function presetHint(p: Preset): string | undefined {
    return p.hintKey ? t(p.hintKey) : p.hint;
}

function normalizeUrl(url: string) {
    return url.trim().replace(/\/+$/, '');
}

function presetForUrl(url: string | null | undefined): Preset | undefined {
    const normalized = normalizeUrl(url ?? '');
    return PRESETS.find((p) => p.baseUrl && normalizeUrl(p.baseUrl) === normalized);
}

/** Mirrors the host's `_isLikelyLocalUrl` closely enough to decide whether
 *  an API key is optional BEFORE the save round-trip. */
function isLocalishUrl(url: string): boolean {
    const v = url.trim().toLowerCase();
    return v.includes('localhost') ||
        v.includes('127.0.0.1') ||
        v.includes('[::1]') ||
        v.startsWith('http://192.168.') ||
        v.startsWith('http://10.') ||
        /^http:\/\/172\.(1[6-9]|2\d|3[01])\./.test(v);
}

function ProviderMark({ provider }: { provider: Preset }) {
    const Icon = provider.group === 'local' ? Laptop : Server;
    return (
        <span className={`provider-mark provider-mark-${provider.group}`} aria-hidden="true">
            <Icon size={15} />
        </span>
    );
}

export function CredentialsPage({
    reason,
    error,
    currentUrl,
    activeCredentialId,
    initialOpenCard = null,
    savedCredentials,
    localRuntimes,
    localModelsScanning,
    localScanError = null,
    onRetryFetch,
    modelsRefreshing,
    onSave,
    onSelectCredential,
    onDeleteCredential,
    onUpdateCredential,
    onDiscoverLocalModels,
    onSaveLocalRuntime,
    onBack,
}: CredentialsPageProps) {
    /** Entry-point target wins over any currentUrl echo: the setup chips
     *  ask for a specific provider kind (remote vs local). */
    const requestedPresetId =
        initialOpenCard === 'local' ? 'ollama' :
        initialOpenCard === 'byok' ? 'openai' : null;
    const detected = useMemo(() => presetForUrl(currentUrl) ?? null, [currentUrl]);
    const initialPreset = requestedPresetId
        ? PRESETS.find((p) => p.id === requestedPresetId)!
        : detected ?? PRESETS.find((p) => p.id === 'openai')!;
    const [presetId, setPresetId] = useState<string>(initialPreset.id);
    const [url, setUrl] = useState<string>(detected?.baseUrl ?? currentUrl ?? initialPreset.baseUrl);
    const [apiKey, setApiKey] = useState('');
    const [showApiKey, setShowApiKey] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [providerQuery, setProviderQuery] = useState('');
    const [providerOpen, setProviderOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editKey, setEditKey] = useState('');
    /** Runtime id (or 'manual' for the custom-URL form) currently connecting -
     *  drives the per-row busy spinner. */
    const [connecting, setConnecting] = useState<string | null>(null);
    /** Saved-credential id currently being switched to (spinner until the
     *  host echoes the new active credential or errors). */
    const [selectingId, setSelectingId] = useState<string | null>(null);
    const providerBoxRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const preset = requestedPresetId
            ? PRESETS.find((p) => p.id === requestedPresetId)!
            : detected ?? (currentUrl ? PRESETS.find((p) => p.id === 'custom')! : PRESETS.find((p) => p.id === 'openai')!);
        setPresetId(preset.id);
        // A requested preset also owns the URL - a 'local' entry over a
        // remote currentUrl must land on the local endpoint, not keep the
        // remote URL with the key marked optional. Otherwise the echoed
        // URL wins: a custom endpoint with no preset match must survive
        // the sync instead of being blanked by the custom preset's empty
        // baseUrl.
        setUrl(requestedPresetId ? preset.baseUrl : (detected?.baseUrl ?? currentUrl ?? preset.baseUrl));
        setApiKey('');
        setShowApiKey(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUrl, detected]);

    useEffect(() => {
        onDiscoverLocalModels();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The host acknowledges a local connect OR a credential switch by
    // refreshing savedCredentials (active flag moved) - or by posting an
    // error. Either response ends the busy states.
    useEffect(() => {
        setConnecting(null);
        setSelectingId(null);
    }, [savedCredentials, error]);

    // Close the provider dropdown on outside click.
    useEffect(() => {
        if (!providerOpen) return;
        const onDocClick = (e: MouseEvent) => {
            if (providerBoxRef.current && !providerBoxRef.current.contains(e.target as Node)) {
                setProviderOpen(false);
            }
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, [providerOpen]);

    const active = savedCredentials.find((c) => c.id === activeCredentialId) ?? savedCredentials.find((c) => c.active);
    const selectedPreset = PRESETS.find((p) => p.id === presetId) ?? PRESETS.find((p) => p.id === 'openai')!;
    const keyOptional = selectedPreset.group === 'local' || isLocalishUrl(url);
    const canSave = url.trim().length > 0 && (apiKey.trim().length > 0 || keyOptional);

    const pick = (id: string) => {
        setPresetId(id);
        const preset = PRESETS.find((p) => p.id === id);
        if (preset?.baseUrl) setUrl(preset.baseUrl);
    };

    const askDelete = (id: string) => {
        if (deletingId === id) {
            setDeletingId(null);
            onDeleteCredential(id);
            return;
        }
        setDeletingId(id);
    };

    const filteredProviderOptions = useMemo(() => {
        const q = providerQuery.trim().toLowerCase();
        if (!q) return PRESETS;
        return PRESETS.filter((p) =>
            presetLabel(p).toLowerCase().includes(q) ||
            p.baseUrl.toLowerCase().includes(q) ||
            presetHint(p)?.toLowerCase().includes(q)
        );
    }, [providerQuery]);

    /** A discovered runtime row: connect button with busy spinner, and a
     *  connected pill once this runtime's URL is the active credential. */
    const renderRuntimeRow = (rt: DiscoveredLocalRuntime) => {
        const connected = !!active && normalizeUrl(active.baseUrl) === normalizeUrl(rt.baseUrl);
        const busy = connecting === rt.id;
        return (
            <div key={rt.id} className="cred-local-runtime">
                <div className="cred-local-runtime-info">
                    <span className="cred-local-runtime-name">
                        <Laptop size={12} />
                        {rt.name}
                    </span>
                    <span className="cred-local-runtime-meta" dir="ltr">
                        {rt.baseUrl} · {rt.modelCount} {t('credLocalModelsCount')}
                    </span>
                </div>
                {connected ? (
                    <span className="cred-local-connected">
                        <Check size={12} />
                        {t('credActive')}
                    </span>
                ) : (
                    <button
                        type="button"
                        className="cred-local-connect"
                        disabled={busy}
                        onClick={() => {
                            setConnecting(rt.id);
                            onSaveLocalRuntime(rt.baseUrl, null);
                        }}
                    >
                        {busy ? <RefreshCw size={12} className="spinning" /> : <Check size={12} />}
                        {busy ? t('credConnecting') : t('credConnect')}
                    </button>
                )}
            </div>
        );
    };

    const renderSection = (icon: ReactNode, title: string, desc: string, body: ReactNode) => (
        <section className="cred-card open">
            <div className="cred-card-head static">
                <span className="cred-card-icon" aria-hidden="true">{icon}</span>
                <span className="cred-card-copy">
                    <strong>{title}</strong>
                    <span>{desc}</span>
                </span>
            </div>
            <div className="cred-card-body">{body}</div>
        </section>
    );

    const renderProviderCombobox = () => (
        <div className="cred-provider-box" ref={providerBoxRef}>
            <div className="cred-search-wrap combobox">
                <Search size={13} aria-hidden="true" />
                <input
                    type="text"
                    role="combobox"
                    aria-expanded={providerOpen}
                    aria-controls="cred-provider-listbox"
                    aria-autocomplete="list"
                    value={providerQuery}
                    onChange={(e) => {
                        setProviderQuery(e.target.value);
                        setProviderOpen(true);
                    }}
                    onFocus={() => setProviderOpen(true)}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') setProviderOpen(false);
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            const first = filteredProviderOptions[0];
                            if (providerQuery.trim() && first) {
                                pick(first.id);
                                setProviderQuery('');
                                setProviderOpen(false);
                            }
                        }
                    }}
                    placeholder={t('credSearchProviders')}
                    aria-label={t('credSearchProviders')}
                    spellCheck={false}
                />
            </div>
            {providerOpen && (
                <div className="cred-provider-menu" role="listbox" id="cred-provider-listbox" aria-label={t('credSelectProvider')}>
                    {filteredProviderOptions.length === 0 && (
                        <button
                            type="button"
                            role="option"
                            aria-selected={presetId === 'custom'}
                            className={`cred-provider-option${presetId === 'custom' ? ' selected' : ''}`}
                            onClick={() => {
                                pick('custom');
                                setProviderQuery('');
                                setProviderOpen(false);
                            }}
                        >
                            <ProviderMark provider={PRESETS.find((p) => p.id === 'custom')!} />
                            <span className="cred-provider-option-label">{presetLabel(PRESETS.find((p) => p.id === 'custom')!)}</span>
                            <span className="cred-provider-option-hint">{presetHint(PRESETS.find((p) => p.id === 'custom')!)}</span>
                        </button>
                    )}
                    {filteredProviderOptions.map((p) => (
                        <button
                            key={p.id}
                            type="button"
                            role="option"
                            aria-selected={presetId === p.id}
                            className={`cred-provider-option${presetId === p.id ? ' selected' : ''}`}
                            onClick={() => {
                                pick(p.id);
                                setProviderQuery('');
                                setProviderOpen(false);
                            }}
                        >
                            <ProviderMark provider={p} />
                            <span className="cred-provider-option-label">{presetLabel(p)}</span>
                            {p.baseUrl && <span className="cred-provider-option-hint" dir="ltr">{p.baseUrl}</span>}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    const renderProviderForm = () => (
        <div className="cred-form">
            {renderProviderCombobox()}

            <div className="cred-providers-inline" role="radiogroup" aria-label={t('credPopular')}>
                {POPULAR.slice(0, 4).map((p) => (
                    <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={presetId === p.id}
                        className={`prov-card-inline${presetId === p.id ? ' selected' : ''}`}
                        onClick={() => pick(p.id)}
                    >
                        <span className="prov-label">{presetLabel(p)}</span>
                    </button>
                ))}
            </div>

            <div className="cred-form-provider" dir="ltr">
                <ProviderMark provider={selectedPreset} />
                <div>
                    <strong dir="ltr">{presetLabel(selectedPreset)}</strong>
                    <span>{presetHint(selectedPreset) ?? t('credOpenAICompatible')}</span>
                </div>
            </div>

            <label className="cred-field">
                <span>{t('credUrlLabel')}</span>
                <input
                    type="text"
                    dir="ltr"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    autoComplete="off"
                    spellCheck={false}
                />
            </label>

            <label className="cred-field">
                <span>{t('credKeyLabel')}{keyOptional && <em className="cred-key-optional"> ({t('credKeyOptional')})</em>}</span>
                <div className="cred-secret">
                    <input
                        type={showApiKey ? 'text' : 'password'}
                        dir="ltr"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={keyOptional ? t('credKeyOptionalPlaceholder') : t('credKeyPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <button
                        type="button"
                        className="cred-secret-toggle"
                        onClick={() => setShowApiKey((v) => !v)}
                        aria-label={showApiKey ? t('hidePassword') : t('showPassword')}
                        title={showApiKey ? t('hidePassword') : t('showPassword')}
                    >
                        {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                </div>
            </label>

            <div className="cred-form-actions">
                <button
                    type="button"
                    className="cred-save"
                    disabled={!canSave}
                    onClick={() => {
                        onSave(url.trim(), apiKey.trim());
                        setApiKey('');
                        setShowApiKey(false);
                    }}
                >
                    <Link size={14} />
                    {t('credConnect')}
                </button>
            </div>

            <p className="cred-security-hint">
                <Lock size={11} />
                <span>{t('credSecurityHint')}</span>
            </p>
        </div>
    );

    /** Every saved connection listed at page level. */
    const renderSavedList = () => {
        if (savedCredentials.length === 0) return null;
        return (
            <>
                <div className="cred-divider" role="separator">
                    <span>{t('credSavedHeading')}</span>
                </div>
                <div className="cred-saved-list">
                    {savedCredentials.map((credential) => {
                        const preset = PRESETS.find((p) => p.id === credential.providerId) ?? presetForUrl(credential.baseUrl) ?? PRESETS.find((p) => p.id === 'custom')!;
                        const isActive = credential.id === active?.id;
                        const editing = editingId === credential.id;
                        return (
                            <div key={credential.id} className={`saved-credential${isActive ? ' active' : ''}`} dir="ltr">
                                {editing ? (
                                    <div className="saved-edit-row">
                                        <ProviderMark provider={preset} />
                                        <input
                                            type="password"
                                            dir="ltr"
                                            value={editKey}
                                            onChange={(e) => setEditKey(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && editKey.trim()) {
                                                    onUpdateCredential(credential.id, editKey.trim());
                                                    setEditingId(null);
                                                    setEditKey('');
                                                }
                                                if (e.key === 'Escape') {
                                                    setEditingId(null);
                                                    setEditKey('');
                                                }
                                            }}
                                            placeholder={t('credEditKeyPlaceholder')}
                                            aria-label={t('credEditKeyPlaceholder')}
                                            autoComplete="off"
                                            autoFocus
                                            spellCheck={false}
                                        />
                                        <button
                                            type="button"
                                            className="saved-edit-btn save"
                                            disabled={!editKey.trim()}
                                            aria-label={t('credSaveKey')}
                                            title={t('credSaveKey')}
                                            onClick={() => {
                                                onUpdateCredential(credential.id, editKey.trim());
                                                setEditingId(null);
                                                setEditKey('');
                                            }}
                                        >
                                            <Check size={13} />
                                        </button>
                                        <button
                                            type="button"
                                            className="saved-edit-btn cancel"
                                            aria-label={t('editCancel')}
                                            title={t('editCancel')}
                                            onClick={() => {
                                                setEditingId(null);
                                                setEditKey('');
                                            }}
                                        >
                                            <X size={13} />
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className="saved-credential-main"
                                        disabled={selectingId === credential.id}
                                        onClick={() => {
                                            setDeletingId(null);
                                            setSelectingId(credential.id);
                                            onSelectCredential(credential.id);
                                        }}
                                        aria-pressed={isActive}
                                    >
                                        <ProviderMark provider={preset} />
                                        <span className="saved-credential-copy">
                                            <span className="saved-credential-name" dir="ltr">
                                                {credential.label || presetLabel(preset)}
                                            </span>
                                            <span className="saved-credential-meta" dir="ltr">
                                                {credential.baseUrl} · {credential.maskedKey}
                                            </span>
                                        </span>
                                        {isActive ? (
                                            <span className="saved-active">
                                                <Check size={12} />
                                                {t('credActive')}
                                            </span>
                                        ) : selectingId === credential.id ? (
                                            <span className="saved-switching">
                                                <RefreshCw size={12} className="spinning" />
                                            </span>
                                        ) : null}
                                    </button>
                                )}
                                {!editing && (
                                    <span className="saved-credential-actions">
                                        <button
                                            type="button"
                                            className="saved-edit"
                                            aria-label={t('credEditKey')}
                                            title={t('credEditKey')}
                                            aria-expanded={editing}
                                            onClick={() => {
                                                setEditingId(credential.id);
                                                setEditKey('');
                                            }}
                                        >
                                            <Pencil size={13} />
                                        </button>
                                        <button
                                            type="button"
                                            className={`saved-delete${deletingId === credential.id ? ' confirm' : ''}`}
                                            onClick={() => askDelete(credential.id)}
                                            aria-label={deletingId === credential.id ? t('credDeleteConfirm') : t('credDelete')}
                                            title={deletingId === credential.id ? t('credDeleteConfirm') : t('credDelete')}
                                        >
                                            {deletingId === credential.id ? <Check size={13} /> : <Trash2 size={13} />}
                                        </button>
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            </>
        );
    };

    const renderDiscoveredList = () => (
        <div className="cred-local-panel">
            <div className="cred-local-body">
                {!localModelsScanning && localRuntimes.length === 0 && (
                    <div className="cred-local-empty">
                        {localScanError ? (
                            <>
                                <span>{t('credScanFailed')}</span>
                                <span className="cred-scan-error-detail" dir="ltr">{localScanError}</span>
                            </>
                        ) : (
                            <span>{t('credLocalEmpty')}</span>
                        )}
                        <button type="button" className="ghost-btn small" onClick={onDiscoverLocalModels}>
                            <RefreshCw size={12} />
                            {t('credLocalRetry')}
                        </button>
                    </div>
                )}

                {localRuntimes.map(renderRuntimeRow)}
            </div>
        </div>
    );

    return (
        <div className="cred-page">
            <header className="cred-head">
                <button type="button" className="ghost-btn small" onClick={onBack} aria-label={t('credBack')} title={t('credBack')}>
                    {getLocale() === 'fa' ? <ArrowRight size={14} /> : <ArrowLeft size={14} />}
                </button>
                <div className="cred-head-copy">
                    <h2>{t('credHeading')}</h2>
                </div>
            </header>

            {(reason || error) && (
                <div className={`cred-notice${error ? ' err' : ''}`} role={error ? 'alert' : 'status'}>
                    <div className="cred-notice-row">
                        <div className="cred-notice-title">
                            <Link size={13} />
                            <span>{error ? t('credSetupError') : t('credWhy')}</span>
                        </div>
                        {error && onRetryFetch && (
                            <button
                                type="button"
                                className="cred-notice-retry"
                                onClick={onRetryFetch}
                                disabled={modelsRefreshing}
                            >
                                <RefreshCw size={12} className={modelsRefreshing ? 'spinning' : undefined} />
                                {t('credRetry')}
                            </button>
                        )}
                    </div>
                    {!error && reason && <div className="cred-notice-body">{reason}</div>}
                </div>
            )}

            {renderSection(
                <Link size={15} />,
                t('credAddProviderTitle'),
                t('credAddProviderDesc'),
                renderProviderForm()
            )}

            <section className={`cred-card${localRuntimes.length > 0 ? ' open' : ''}`}>
                <div className="cred-card-head static">
                    <span className="cred-card-icon" aria-hidden="true"><Laptop size={15} /></span>
                    <span className="cred-card-copy">
                        <strong>{t('credLocalDiscovered')}</strong>
                        <span>{localRuntimes.length > 0 ? tf('credDetectedCount', { count: String(localRuntimes.length) }) : t('credLocalDiscoveredDesc')}</span>
                    </span>
                    <span className="cred-card-side">
                        <button
                            type="button"
                            className="ghost-btn small"
                            onClick={onDiscoverLocalModels}
                            aria-label={t('credLocalRescan')}
                            title={t('credLocalRescan')}
                            disabled={localModelsScanning}
                        >
                            <RefreshCw size={13} className={localModelsScanning ? 'spinning' : undefined} />
                        </button>
                    </span>
                </div>
                {/* Body always mounted: its own states cover scanning,
                    discovered rows, empty result and scan failure. */}
                <div className="cred-card-body">{renderDiscoveredList()}</div>
            </section>

            {renderSavedList()}
        </div>
    );
}
