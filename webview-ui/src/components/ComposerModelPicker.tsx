import { Activity, Check, Eye, Gift, RefreshCw, Search, Star, TriangleAlert, Wrench } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { modelFavoriteKey } from '../../../src/modelPicker';
import { PROVIDER_LABELS } from '../../../src/providerIdentity';
import { getLocale, t, tf, tOrRaw } from '../i18n';
import type { FromExtensionMessage, ModelCapability, ModelFavorite, ModelPingState, SavedCredential } from '../types';
import { ProviderIcon } from './ProviderIcon';

type Scope = 'favorites' | 'free' | 'models' | `provider:${string}`;
type ProviderModels = Extract<FromExtensionMessage, { type: 'providerModels' }>;

export interface ComposerModelPickerConnections {
    pickerCredentials?: SavedCredential[];
    activePickerCredential?: string | null;
    providerModels?: ProviderModels | null;
    selectingModel?: boolean;
    modelSelectionError?: string;
    modelFavorites?: ModelFavorite[];
    onBrowseProvider?: (credentialId: string, refresh?: boolean) => void;
    onToggleModelFavorite?: (favorite: ModelFavorite, enabled: boolean) => void;
}

function nativeProviderLabel(id: string): string {
    return Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, id) ? PROVIDER_LABELS[id] : id;
}

/** Separator-insensitive matching, including model IDs and display names. */
function normalizeQuery(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/g, '');
}

interface Row {
    model: string;
    label: string;
    provider?: string;
    providerLabel?: string;
    capability?: ModelCapability;
    window?: number;
}

interface Props extends ComposerModelPickerConnections {
    popupRef: Ref<HTMLDivElement>;
    engine: 'xratu' | 'opencode';
    models: string[];
    names?: Record<string, string>;
    capabilities?: Record<string, ModelCapability>;
    windows?: Record<string, number>;
    selected?: string | null;
    pings?: Record<string, ModelPingState>;
    refreshing?: boolean;
    selectionDisabled?: boolean;
    onSelect?: (model: string, provider?: string) => void;
    onRefresh?: () => void;
    onPing?: (model: string) => void;
    formatWindow: (value: number) => string;
    footer?: ReactNode;
}

export function ComposerModelPicker({
    popupRef, engine, models, names, capabilities, windows, selected, pings, refreshing,
    selectionDisabled, onSelect, onRefresh, onPing, formatWindow, footer,
    pickerCredentials = [], activePickerCredential, providerModels, selectingModel,
    modelSelectionError, modelFavorites = [], onBrowseProvider, onToggleModelFavorite,
}: Props) {
    const listId = useId();
    const native = engine === 'opencode';
    const activeProvider = native ? capabilities?.[selected ?? '']?.provider : activePickerCredential;
    const [scope, setScope] = useState<Scope>('favorites');
    const [query, setQuery] = useState('');
    const [activeRow, setActiveRow] = useState<string>();
    const codexCredential = pickerCredentials.find(item => item.providerId === 'chatgpt-codex' && item.id === activePickerCredential)
        ?? pickerCredentials.find(item => item.providerId === 'chatgpt-codex');
    const providers = native
        ? Array.from(new Set(models.flatMap(model => capabilities?.[model]?.provider ?? []))).map(id => ({ id, brandId: id, label: nativeProviderLabel(id) }))
        : pickerCredentials.filter(item => item.providerId !== 'chatgpt-codex' || item.id === codexCredential?.id)
            .map(({ id, providerId, label }) => ({ id, brandId: providerId, label: providerId === 'chatgpt-codex' ? 'Codex'
                : /[\w.+%-]+@[\w.-]+\.[a-z]{2,}/i.test(label) ? nativeProviderLabel(providerId) : label }));
    const byProvider = new Map(providers.map(provider => [provider.id, provider.label]));
    const brands = new Map(providers.map(provider => [provider.id, provider.brandId]));
    // A provider might arrive after opening the picker, or disappear on refresh.
    const visibleScope = scope === 'models' && activeProvider ? `provider:${activeProvider}`
        : scope.startsWith('provider:') && !byProvider.has(scope.slice(9)) ? 'models' : scope;
    const provider = visibleScope.startsWith('provider:') ? visibleScope.slice(9) : undefined;
    const inactive = !native && provider !== undefined && provider !== activePickerCredential;
    const response = inactive && providerModels?.credentialId === provider ? providerModels : null;
    const catalog = response?.catalog;
    const loading = inactive && !catalog && !response?.errorKey;
    const favorites = new Set(modelFavorites.map(modelFavoriteKey));
    const primaryRows: Row[] = models.map(model => {
        const id = native ? capabilities?.[model]?.provider : activePickerCredential ?? undefined;
        return { model, label: names?.[model] ?? model, provider: id, providerLabel: id ? byProvider.get(id) : undefined,
            capability: capabilities?.[model], window: windows?.[model] };
    });
    const favoriteRows = (): Row[] => {
        const available = new Map(primaryRows.filter(row => row.provider !== undefined)
            .map(row => [modelFavoriteKey({ engine, provider: row.provider!, model: row.model }), row]));
        return modelFavorites.flatMap(favorite => {
            if (favorite.engine !== engine) return [];
            const row = available.get(modelFavoriteKey(favorite));
            if (row) return [row];
            const label = native ? nativeProviderLabel(favorite.provider) : byProvider.get(favorite.provider);
            return !label ? [] :
                [{ model: favorite.model, label: favorite.label || favorite.model, provider: favorite.provider, providerLabel: label }];
        });
    };
    const rows: Row[] = visibleScope === 'favorites' ? favoriteRows()
        : visibleScope === 'free' ? primaryRows.filter(row => row.capability?.free === true)
        : inactive ? (catalog?.models ?? []).map(model => ({ model, provider, providerLabel: byProvider.get(provider),
            label: catalog?.displayNames[model] ?? model, capability: catalog?.capabilities[model], window: catalog?.contextWindows[model] }))
        : provider && native ? primaryRows.filter(row => row.provider === provider) : primaryRows;
    const needle = normalizeQuery(query);
    const filtered = rows.filter(row => !needle || [row.model, row.label, row.providerLabel ?? ''].some(value => normalizeQuery(value).includes(needle)));
    const rowKey = (row: Row) => modelFavoriteKey({ engine, provider: row.provider ?? '', model: row.model });
    const current = (row: Row) => row.model === selected && (native || row.provider === (activePickerCredential ?? undefined));
    const options = filtered.map((row, index) => ({ row, id: `${listId}-${index}`, key: rowKey(row) }));
    const highlighted = options.findIndex(option => option.key === activeRow);
    const choose = (row: Row) => {
        if (!selectingModel && !(selectionDisabled && !native && row.provider)) onSelect?.(row.model, native ? undefined : row.provider);
    };

    function browse(next: Scope) {
        setScope(next);
        setQuery('');
        setActiveRow(undefined);
        const id = next.startsWith('provider:') ? next.slice(9) : undefined;
        if (!native && id && id !== activePickerCredential) onBrowseProvider?.(id);
    }

    function navigate(event: KeyboardEvent<HTMLInputElement>) {
        if (event.nativeEvent.isComposing || !options.length) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            choose(options[highlighted < 0 ? 0 : highlighted].row);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const index = highlighted < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
                : (highlighted + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            setActiveRow(options[index].key);
            document.getElementById(options[index].id)?.scrollIntoView({ block: 'nearest' });
        }
    }

    return <div className="model-pop composer-model-picker" ref={popupRef} role="group" aria-label={t('pickModel')}>
        <div className="model-picker-body">
            <div className="model-picker-rail" role="group" aria-label={t('providersTitle')}>
                <button type="button" className="model-picker-scope" aria-pressed={visibleScope === 'favorites'} onClick={() => browse('favorites')}>
                    <Star size={14} aria-hidden="true" /><span>{t('modelFavorites')}</span>
                </button>
                {native && <button type="button" className="model-picker-scope" aria-pressed={visibleScope === 'free'} onClick={() => browse('free')}>
                    <Gift size={14} aria-hidden="true" /><span>{t('modelFreeList')}</span>
                </button>}
                {providers.map(item => <button key={item.id} type="button" className="model-picker-scope"
                    aria-pressed={provider === item.id} onClick={() => browse(`provider:${item.id}`)} title={item.label}>
                    <ProviderIcon id={item.brandId} label={item.label} /><span dir="auto">{item.label}</span>
                </button>)}
            </div>
            <div className="model-picker-catalog">
                <div className="model-pop-head">
                    <div className="model-search">
                        <Search size={13} aria-hidden="true" />
                        <input type="text" role="combobox" aria-autocomplete="list" aria-controls={listId} aria-expanded="true"
                            aria-activedescendant={options[highlighted]?.id} dir={query ? 'auto' : getLocale() === 'fa' ? 'rtl' : 'ltr'}
                            placeholder={t('searchModel')} value={query} autoFocus aria-label={t('searchModelAria')}
                            onKeyDown={navigate} onChange={event => { setQuery(event.target.value); setActiveRow(undefined); }} />
                    </div>
                    <button type="button" className="ghost-btn small" disabled={inactive ? loading : refreshing}
                        aria-busy={(inactive ? loading : refreshing) || undefined} aria-label={t('refreshModels')} title={t('refreshTitle')}
                        onClick={() => inactive ? onBrowseProvider?.(provider, true) : onRefresh?.()}>
                        <RefreshCw size={13} className={(inactive ? loading : refreshing) ? 'spinning' : undefined} />
                    </button>
                </div>
                {(modelSelectionError || response?.errorKey) && <p className="model-empty" role="status">{tOrRaw(modelSelectionError ?? response?.errorKey ?? '')}</p>}
                <div className="model-list" id={listId} role="listbox" aria-busy={loading || selectingModel || undefined} aria-label={t('modelListAria')}>
                    {!response?.errorKey && !options.length && <p className="model-empty" role="status">
                        {t(loading ? 'modelPickerLoading' : visibleScope === 'favorites' && !query ? 'modelNoFavorites' : 'noModels')}
                    </p>}
                    {options.map(({ row, key, id }, index) => {
                        const favorite = row.provider ? { engine, provider: row.provider, model: row.model, label: row.label } : null;
                        const starred = favorites.has(key);
                        const isCodex = !!row.provider && brands.get(row.provider) === 'chatgpt-codex';
                        const ping = pings?.[row.model];
                        const pingText = ping && t(`modelPing${ping.status === 'rateLimited' ? 'Limited' : ping.status === 'available' ? 'Available' : ping.status === 'checking' ? 'Checking' : 'Failed'}`);
                        const PingIcon = ping?.status === 'checking' ? RefreshCw : ping?.status === 'available' ? Check : ping ? TriangleAlert : Activity;
                        return <div className="model-row" key={key} dir="ltr" role="presentation" data-highlighted={highlighted === index || undefined}>
                            <button id={id} type="button" role="option" aria-selected={current(row)} className={`model-item${current(row) ? ' selected' : ''}`}
                                disabled={selectingModel || (selectionDisabled && !native && !!row.provider)} onClick={() => choose(row)}>
                                <span className="model-item-label" title={!isCodex && row.window ? `${row.model} · ${t('modelWindowTitle')} ${formatWindow(row.window)}` : row.model}>
                                    <span className="model-item-name">{row.label}</span>
                                    {visibleScope === 'favorites' && row.providerLabel && <span className="model-provider provider-brand-label" title={row.providerLabel}>
                                        <ProviderIcon id={row.provider ? (brands.get(row.provider) ?? (native ? row.provider : undefined)) : undefined} label={row.providerLabel} />
                                        <span className="provider-brand-text" dir="auto">{row.providerLabel}</span>
                                    </span>}
                                </span>
                                <span className="model-badges">
                                    {!isCodex && row.window ? <span className="model-badge" title={t('modelWindowTitle')} aria-label={t('modelWindowTitle')}>{formatWindow(row.window)}</span> : null}
                                    {!isCodex && row.capability?.vision && <span className="model-badge" title={t('modelVisionBadge')} aria-label={t('modelVisionBadge')}><Eye size={11} /></span>}
                                    {row.capability?.noTools && <span className="model-badge" title={t('modelNoToolsBadge')} aria-label={t('modelNoToolsBadge')}><Wrench size={11} /></span>}
                                </span>
                                <Check size={13} className="model-check" visibility={current(row) ? undefined : 'hidden'} aria-hidden="true" />
                            </button>
                            {row.capability?.free === true && onPing && <button type="button" className={`model-ping ${ping?.status ?? ''}`}
                                disabled={ping?.status === 'checking'} onClick={() => onPing(row.model)}
                                aria-label={tf('modelPingAction', { model: row.label })} aria-description={pingText}
                                title={[t('modelPing'), pingText, ping?.checkedAt && new Date(ping.checkedAt).toLocaleTimeString(getLocale()), ping?.detail && tOrRaw(ping.detail)].filter(Boolean).join(' · ')}>
                                <PingIcon size={12} className={ping?.status === 'checking' ? 'spinning' : undefined} />
                                {ping && ping.status !== 'checking' && <span dir="auto">{pingText}</span>}
                            </button>}
                            {favorite && onToggleModelFavorite && <button type="button" className="model-favorite" aria-pressed={starred}
                                aria-label={tf('modelFavoriteAction', { model: row.label })}
                                title={t(starred ? 'modelUnfavorite' : 'modelFavorite')}
                                onClick={() => onToggleModelFavorite(favorite, !starred)}>
                                <Star size={14} fill={starred ? 'currentColor' : 'none'} aria-hidden="true" />
                            </button>}
                        </div>;
                    })}
                </div>
            </div>
        </div>
        {footer}
    </div>;
}
