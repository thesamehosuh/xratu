import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    Check,
    Copy,
    Eye,
    EyeOff,
    Laptop,
    Link,
    Lock,
    LogOut,
    Pencil,
    Plus,
    RefreshCw,
    Search,
    Server,
    Trash2,
    UserRound,
    X,
} from 'lucide-react';
import type {
    DiscoveredLocalRuntime,
    OAuthHostState,
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
    /** Host-owned OAuth status: registered providers, connected accounts, and
     *  what an in-flight flow is waiting for. The page renders; the HOST runs
     *  the flow (it owns the browser launch, the loopback socket, the abort). */
    oauthState?: OAuthHostState | null;
    onOAuthSignIn: (providerId: string, method: 'browser' | 'device', credentialId?: string) => void;
    onOAuthCopy: (value: string, requestId: 'oauth-device-code' | 'oauth-browser-url') => void;
    copyResult?: { ok: boolean; seq: number; requestId: string } | null;
    onOAuthCancelSignIn: () => void;
    onOAuthManualCode: (code: string) => void;
    onOAuthSignOut: (credentialId: string) => void;
    onBack: () => void;
}

interface Preset {
    id: string;
    label: string;
    /** i18n key overriding `label` (resolved at render so locale flips apply). */
    labelKey?: StringKey;
    group: 'popular' | 'iranian' | 'other' | 'local';
    baseUrl: string;
    hint?: string;
    /** i18n key overriding `hint`. */
    hintKey?: StringKey;
    docs?: string;
}

const PRESETS: Preset[] = [
    { id: 'openai', label: 'OpenAI', group: 'popular', baseUrl: 'https://api.openai.com/v1' },
    { id: 'openrouter', label: 'OpenRouter', group: 'popular', baseUrl: 'https://openrouter.ai/api/v1' },
    { id: 'opencode', label: 'OpenCode Zen', group: 'popular', baseUrl: 'https://opencode.ai/zen/v1' },
    { id: 'opencode-go', label: 'OpenCode Go', group: 'popular', baseUrl: 'https://opencode.ai/zen/go/v1', hintKey: 'opencodeGoHint' },
    { id: 'deepseek', label: 'DeepSeek', group: 'popular', baseUrl: 'https://api.deepseek.com' },
    { id: 'mistral', label: 'Mistral', group: 'popular', baseUrl: 'https://api.mistral.ai/v1' },
    { id: 'groq', label: 'Groq', group: 'other', baseUrl: 'https://api.groq.com/openai/v1' },
    // Iranian providers - no VPN required, rial payment.
    // Kaya and Avalai expose a shared, documented OpenAI-compatible base URL.
    { id: 'kayaai', label: 'Kaya AI', group: 'iranian', baseUrl: 'https://kayaai.ir/api', hintKey: 'kayaHint' },
    { id: 'avalai', label: 'Avalai', group: 'iranian', baseUrl: 'https://api.avalai.ir/v1', hintKey: 'credIranianHint' },
    // GapGPT (گپ جی پی تی) publishes a shared OpenAI-compatible endpoint
    // (api.gapgpt.app/v1 verified: OpenAI error envelope, ArvanCloud-hosted),
    // Persian docs, rial payment.
    { id: 'gapgpt', label: 'GapGPT', group: 'iranian', baseUrl: 'https://api.gapgpt.app/v1', hintKey: 'credIranianHint' },
    // Metis, Liara, ArvanCloud and Navaan do NOT expose a shared base URL:
    // Metis routes through per-provider wrappers (no stable OpenAI base we can
    // verify), and Liara hands each AI service its own `baseUrl` containing an
    // account id (see docs.liara.ir/ai). Leave the URL EMPTY so the user pastes
    // the one from their dashboard instead of shipping a route that would 404.
    // Selecting these clears the previous endpoint (see `pick`).
    { id: 'metis', label: 'Metis AI', group: 'iranian', baseUrl: '', hintKey: 'credIranianUrlHint' },
    { id: 'liara', label: 'Liara AI', group: 'iranian', baseUrl: '', hintKey: 'credIranianUrlHint' },
    { id: 'arvan', label: 'ArvanCloud AI', group: 'iranian', baseUrl: '', hintKey: 'credIranianUrlHint' },
    { id: 'navaan', label: 'Navaan', group: 'iranian', baseUrl: '', hintKey: 'credIranianUrlHint' },
    { id: 'xai', label: 'xAI', group: 'other', baseUrl: 'https://api.x.ai/v1' },
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
    { id: 'google', label: 'Google Gemini', group: 'other', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
    { id: 'ollama', label: 'Ollama', group: 'local', baseUrl: 'http://localhost:11434/v1', hintKey: 'credLocal' },
    { id: 'lmstudio', label: 'LM Studio', group: 'local', baseUrl: 'http://localhost:1234/v1', hintKey: 'credLocal' },
    { id: 'vllm', label: 'vLLM', group: 'local', baseUrl: 'http://localhost:8000/v1', hintKey: 'credLocal' },
    { id: 'custom', label: 'Custom', labelKey: 'customPreset', group: 'other', baseUrl: '', hintKey: 'credOpenAICompatible' },
];

const POPULAR = PRESETS.filter((p) => p.group === 'popular');
const IRANIAN = PRESETS.filter((p) => p.group === 'iranian');

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
    oauthState,
    onOAuthSignIn,
    onOAuthCopy,
    copyResult,
    onOAuthCancelSignIn,
    onOAuthManualCode,
    onOAuthSignOut,
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
    const [oauthCode, setOauthCode] = useState('');
    const [oauthCopied, setOauthCopied] = useState<string | null>(null);
    useEffect(() => {
        setOauthCopied(copyResult?.ok ? copyResult.requestId : null);
        if (!copyResult?.ok) return;
        const timer = setTimeout(() => setOauthCopied(null), 1500);
        return () => clearTimeout(timer);
    }, [copyResult]);
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
        // Switching provider: take the preset's URL - including EMPTY, so a
        // user-specific provider (no shared base URL) clears the previous
        // endpoint instead of silently carrying it over. Re-clicking the
        // ALREADY selected provider must not wipe a URL the user typed.
        if (id === presetId) return;
        setPresetId(id);
        const preset = PRESETS.find((p) => p.id === id);
        setUrl(preset?.baseUrl ?? '');
    };

    const askDelete = (id: string) => {
        if (deletingId === id) {
            setDeletingId(null);
            if (savedCredentials.find((c) => c.id === id)?.oauth) onOAuthSignOut(id);
            else onDeleteCredential(id);
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

    /** Sign in with a subscription instead of holding an API key. Four states
     *  are rendered explicitly - signed out, waiting (browser), waiting for a
     *  device code, signed in - because collapsing "your session expired, sign
     *  in again" into "signed out" is what every competitor does and it costs
     *  the user their whole history of context. */
    const renderOauthSection = () => {
        const providers = oauthState?.providers ?? [];
        if (!providers.length) return null;
        const inProgress = oauthState?.inProgress ?? null;

        return renderSection(
            <Lock size={15} />,
            t('credOAuthTitle'),
            t('credOAuthDesc'),
            <div className="cred-oauth-list">
                {providers.map((provider) => {
                    const accounts = oauthState?.accounts?.filter((a) => a.providerId === provider.providerId) ?? [];
                    const registrations = oauthState?.registrations?.filter((r) => r.providerId === provider.providerId
                        && !accounts.some((a) => a.credentialId === r.credentialId)) ?? [];
                    const busy = inProgress?.providerId === provider.providerId;
                    return (
                        <div key={provider.providerId} className={`cred-oauth-row${accounts.length ? ' connected' : ''}${busy ? ' busy' : ''}`}>
                            <div className="cred-oauth-header">
                                <div className="cred-oauth-copy">
                                    <span className="cred-oauth-name" dir="ltr">{provider.label}</span>
                                </div>
                                <div className="cred-oauth-actions">
                                    {!busy && accounts.length > 0 && <button type="button" className="ghost-btn cred-oauth-action"
                                        disabled={!!inProgress} onClick={() => onOAuthSignIn(provider.providerId, 'browser')}>
                                        <Plus size={13} />
                                        {t('credOAuthAddAccount')}
                                    </button>}
                                    {!busy && accounts.length === 0 && (
                                        <>
                                            <button
                                                type="button"
                                                className="primary-btn cred-oauth-action"
                                                onClick={() => onOAuthSignIn(provider.providerId, 'browser')}
                                                disabled={!!inProgress}
                                            >
                                                <Link size={13} />
                                                {t('credOAuthSignIn')}
                                            </button>
                                            {provider.methods?.includes('device') && <button
                                                type="button"
                                                className="ghost-btn cred-oauth-action"
                                                onClick={() => onOAuthSignIn(provider.providerId, 'device')}
                                                disabled={!!inProgress}
                                            >
                                                {t('credOAuthSignInDevice')}
                                            </button>}
                                        </>
                                    )}
                                    {busy && (
                                        <button
                                            type="button"
                                            className="ghost-btn cred-oauth-action"
                                            onClick={onOAuthCancelSignIn}
                                        >
                                            {t('credOAuthCancel')}
                                        </button>
                                    )}
                                </div>
                            </div>

                            {accounts.length > 0 && <div className="cred-oauth-accounts">
                                {accounts.map((account) => (
                                    <div className={`cred-oauth-account-card${account.active ? ' active' : ''}`} key={account.credentialId}>
                                        <div className="cred-oauth-account-head">
                                            <span className="cred-oauth-avatar" aria-hidden="true"><UserRound size={15} /></span>
                                            <span className="cred-oauth-account" title={account.accountLabel}>
                                                <bdi dir="auto">{account.accountLabel || t('credOAuthAccount')}</bdi>
                                            </span>
                                            {account.active && <span className="cred-oauth-active"><Check size={11} />{t('credActive')}</span>}
                                            <button type="button" className="ghost-btn small cred-oauth-signout" disabled={!!inProgress}
                                                aria-label={t('credOAuthSignOut')} title={t('credOAuthSignOut')}
                                                onClick={() => onOAuthSignOut(account.credentialId)}><LogOut size={14} /></button>
                                        </div>
                                        {account.planEnabled === false && <div className="cred-oauth-hint">{t('oauthPlanPermissionMissing')}</div>}
                                        {!account.active && <div className="cred-oauth-account-actions">
                                            <button type="button" className="ghost-btn cred-oauth-action"
                                                disabled={!!inProgress || selectingId === account.credentialId}
                                                onClick={() => { setSelectingId(account.credentialId); onSelectCredential(account.credentialId); }}>
                                                {selectingId === account.credentialId && <RefreshCw size={12} className="spinning" />}
                                                {t('credOAuthUseAccount')}
                                            </button>
                                        </div>}
                                    </div>
                                ))}
                            </div>}

                            {busy && inProgress?.method === 'browser' && (
                                <div className="cred-oauth-wait">
                                    <span className="cred-oauth-status"><RefreshCw size={13} className="spinning" />{t('credOAuthWaiting')}</span>
                                    {oauthState?.authorizeUrl && <>
                                        <div className="cred-oauth-actions">
                                            <a className="primary-btn cred-oauth-action" href={oauthState.authorizeUrl}
                                                target="_blank" rel="noreferrer">{t('credOAuthOpenBrowser')}</a>
                                            <button type="button" className="ghost-btn cred-oauth-action"
                                                onClick={() => onOAuthCopy(oauthState.authorizeUrl!, 'oauth-browser-url')}>
                                                {oauthCopied === 'oauth-browser-url' ? <Check size={13} /> : <Copy size={13} />}
                                                {oauthCopied === 'oauth-browser-url' ? t('credOAuthCopied') : t('credOAuthCopyLink')}
                                            </button>
                                        </div>
                                        <input className="cred-oauth-url" type="text" dir="ltr" readOnly
                                            value={oauthState.authorizeUrl} aria-label={t('credOAuthSignInLink')}
                                            onFocus={(e) => e.currentTarget.select()} />
                                    </>}
                                </div>
                            )}

                            {busy && inProgress?.method === 'device' && (
                                <div className="cred-oauth-device">
                                    <span className="cred-oauth-status">
                                        {!oauthState?.deviceCode && <RefreshCw size={13} className="spinning" />}
                                        {t(oauthState?.deviceCode ? 'credOAuthWaitingDevice' : 'credOAuthGettingDeviceCode')}
                                    </span>
                                    {oauthState?.deviceCode && <>
                                        <code className="cred-oauth-code" dir="ltr">{oauthState.deviceCode.userCode}</code>
                                        <div className="cred-oauth-actions">
                                            <button
                                                type="button"
                                                className="ghost-btn cred-oauth-action"
                                                onClick={() => onOAuthCopy(oauthState.deviceCode!.userCode, 'oauth-device-code')}
                                            >
                                                {oauthCopied === 'oauth-device-code' ? <Check size={13} /> : <Copy size={13} />}
                                                {oauthCopied === 'oauth-device-code' ? t('credOAuthCopied') : t('credOAuthCopyCode')}
                                            </button>
                                            <a
                                                className="primary-btn cred-oauth-action"
                                                href={oauthState.deviceCode.verificationUri}
                                                target="_blank"
                                                rel="noreferrer"
                                            >
                                                {t('credOAuthOpenPage')}
                                            </a>
                                        </div>
                                    </>}
                                </div>
                            )}

                            {copyResult?.ok === false && <div className="cred-oauth-error" role="alert">{t('oauthCopyFailed')}</div>}
                            {!busy && registrations.length > 0 && <details className="cred-oauth-remembered">
                                <summary>{t('credOAuthPreviousAccounts')}</summary>
                                <div className="cred-oauth-remembered-list">
                                    {registrations.map((r) => (
                                        <div className="cred-oauth-registration" key={r.credentialId}>
                                            <span dir="auto" title={r.label}>{r.label || t('credOAuthAccount')}</span>
                                            <div className="cred-oauth-actions">
                                                <button type="button" className="ghost-btn cred-oauth-action" disabled={!!inProgress}
                                                    onClick={() => onOAuthSignIn(provider.providerId, 'browser', r.credentialId)}>{t('credOAuthReconnect')}</button>
                                                {savedCredentials.some((c) => c.id === r.credentialId) && <button type="button"
                                                    className="ghost-btn cred-oauth-action" disabled={!!inProgress}
                                                    onClick={() => onOAuthSignOut(r.credentialId)}>{t('credOAuthSignOut')}</button>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </details>}
                            {/* The host classifies every flow failure into an i18n key
                                and posts it here; without this the card would fail
                                silently and the user would blame the browser. */}
                            {busy && oauthState?.error?.valueKey && (
                                <div className="cred-oauth-error" role="alert">
                                    {tf(oauthState.error.valueKey as StringKey)}
                                </div>
                            )}
                            {!inProgress && oauthState?.error?.valueKey && (
                                <div className="cred-oauth-error" role="alert">
                                    {tf(oauthState.error.valueKey as StringKey)}
                                </div>
                            )}

                            {/* Manual paste: the always-works escape hatch when the
                                loopback callback cannot complete. */}
                            {busy && inProgress?.method === 'browser' && (
                                <details className="cred-oauth-manual" open={oauthState?.error?.valueKey === 'oauthPortsBusy' ? true : undefined}>
                                    <summary>{t('credOAuthManualTitle')}</summary>
                                    <div className="cred-oauth-manual-body">
                                        <span className="cred-oauth-hint">{t('credOAuthManualDesc')}</span>
                                        <div className="cred-oauth-manual-row">
                                            <input
                                                type="text"
                                                dir="ltr"
                                                value={oauthCode}
                                                onChange={(e) => setOauthCode(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' && oauthCode.trim()) {
                                                        onOAuthManualCode(oauthCode.trim());
                                                        setOauthCode('');
                                                    }
                                                }}
                                                placeholder={t('credOAuthManualPlaceholder')}
                                                aria-label={t('credOAuthManualPlaceholder')}
                                                autoComplete="off"
                                                spellCheck={false}
                                            />
                                            <button
                                                type="button"
                                                className="primary-btn cred-oauth-action"
                                                disabled={!oauthCode.trim()}
                                                onClick={() => {
                                                    onOAuthManualCode(oauthCode.trim());
                                                    setOauthCode('');
                                                }}
                                            >
                                                {t('credOAuthManualSubmit')}
                                            </button>
                                        </div>
                                    </div>
                                </details>
                            )}
                        </div>
                    );
                })}
            </div>,
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
                    dir="ltr"
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
        <>
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

            {/* Both texts (label + hint) sit ABOVE the chips: the group must
                not be sandwiched between them. */}
            <div className="cred-provider-section">
                <span className="cred-provider-section-label">{t('credIranian')}</span>
                <span className="cred-provider-section-hint">{t('credIranianHint')}</span>
                <div className="cred-providers-inline" role="radiogroup" aria-label={t('credIranian')}>
                    {IRANIAN.map((p) => (
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
            </div>

            {/* Inherit the card's RTL: the hint is a Persian sentence and must
                read right-to-left. Only the Latin brand name is isolated. */}
            <div className="cred-form-provider">
                <ProviderMark provider={selectedPreset} />
                {/* No dir="ltr": it would make text-align:start resolve
                    LEFT. Inheriting RTL keeps the label right-aligned
                    while bidi still renders the Latin brand name LTR. */}
                <strong>{presetLabel(selectedPreset)}</strong>
                <span>{presetHint(selectedPreset) ?? t('credOpenAICompatible')}</span>
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
        </>
    );

    /** Every saved connection listed at page level. */
    const renderSavedList = () => {
        const credentials = savedCredentials.filter((c) => !c.oauth || (!oauthState?.accounts?.some((a) => a.credentialId === c.id)
            && !oauthState?.registrations?.some((r) => r.credentialId === c.id)));
        if (credentials.length === 0) return null;
        return (
            <>
                <div className="cred-divider" role="separator">
                    <span>{t('credSavedHeading')}</span>
                </div>
                <div className="cred-saved-list">
                    {credentials.map((credential) => {
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
                                                {/* Preset label (localized for the generic
                                                    "custom" preset); credential.label is a
                                                    host-generated English fallback only. */}
                                                {presetLabel(preset) || credential.label}
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
                                        {!credential.oauth && (
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
                                        )}
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

            {renderOauthSection()}

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
