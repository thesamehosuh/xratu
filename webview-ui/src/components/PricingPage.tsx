import { useState } from 'react';
import { ArrowLeft, ArrowRight, Coins, Info, Plus, Tag, Trash2 } from 'lucide-react';
import { getLocale, t } from '../i18n';
import { formatCost } from '../cost';
import type { ModelPricingView, ProviderUsageView } from '../types';

interface PricingState {
    providers: ProviderUsageView[];
    usage: { input: number; output: number; cached: number };
    costs: Array<{ amount: number; currency: 'USD' | 'IRT' }>;
    models: ModelPricingView[];
}

interface PricingPageProps {
    state: PricingState | null;
    onBack: () => void;
    onSaveModel: (id: string, input: number, output: number, cachedInput: number | null, currency: 'USD' | 'IRT') => void;
    onRemoveModel: (id: string) => void;
}

/** Token counts read as numbers, so they always render LTR with separators. */
function formatTokens(value: number): string {
    const locale = getLocale() === 'fa' ? 'fa-IR' : 'en-US';
    return Math.max(0, Math.round(value)).toLocaleString(locale);
}

function UsageStat({ label, value }: { label: string; value: string }) {
    return (
        <div className="usage-stat">
            <span className="usage-stat-label">{label}</span>
            <span className="usage-stat-value" dir="ltr">{value}</span>
        </div>
    );
}

function ModelRow({ model, onRemove }: { model: ModelPricingView; onRemove: (id: string) => void }) {
    return (
        <div className="pricing-row">
            <div className="pricing-row-head">
                <strong className="pricing-row-label" dir="ltr">{model.id}</strong>
                <span className="pricing-badge currency" dir="ltr">{model.currency}</span>
            </div>
            <span className="pricing-row-rate" dir="ltr">
                {t('pricingModelInput')} {model.input} · {t('pricingModelOutput')} {model.output}
                {model.cachedInput != null ? ` · ${t('pricingModelCached')} ${model.cachedInput}` : ''}
            </span>
            <button
                type="button"
                className="icon-btn"
                aria-label={t('pricingRemove')}
                title={t('pricingRemove')}
                onClick={() => onRemove(model.id)}
            >
                <Trash2 size={13} />
            </button>
        </div>
    );
}

function AddModelForm({ onSave }: { onSave: PricingPageProps['onSaveModel'] }) {
    const [id, setId] = useState('');
    const [input, setInput] = useState('');
    const [output, setOutput] = useState('');
    const [cached, setCached] = useState('');
    const [currency, setCurrency] = useState<'USD' | 'IRT'>('USD');

    const inputValue = Number(input);
    const outputValue = Number(output);
    const cachedValue = cached.trim() === '' ? null : Number(cached);
    // Blank input/output must NOT silently become 0: both rates are required.
    const valid = id.trim() !== ''
        && input.trim() !== '' && Number.isFinite(inputValue) && inputValue >= 0
        && output.trim() !== '' && Number.isFinite(outputValue) && outputValue >= 0
        && (cachedValue == null || (Number.isFinite(cachedValue) && cachedValue >= 0));

    const submit = () => {
        if (!valid) return;
        onSave(id.trim(), inputValue, outputValue, cachedValue, currency);
        setId(''); setInput(''); setOutput(''); setCached('');
    };

    return (
        <div className="pricing-add">
            <label className="mcp-field pricing-add-id">
                <span className="mcp-field-label">{t('pricingModelId')}</span>
                <input
                    type="text"
                    dir="ltr"
                    value={id}
                    placeholder="gpt-4o"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setId(e.target.value)}
                />
            </label>
            <label className="mcp-field">
                <span className="mcp-field-label">{t('pricingModelInput')}</span>
                <input type="number" dir="ltr" min="0" inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value)} />
            </label>
            <label className="mcp-field">
                <span className="mcp-field-label">{t('pricingModelOutput')}</span>
                <input type="number" dir="ltr" min="0" inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} />
            </label>
            <label className="mcp-field">
                <span className="mcp-field-label">{t('pricingModelCached')}</span>
                <input type="number" dir="ltr" min="0" inputMode="decimal" value={cached} onChange={(e) => setCached(e.target.value)} />
            </label>
            <label className="mcp-field">
                <span className="mcp-field-label">{t('pricingModelCurrency')}</span>
                <select dir="ltr" value={currency} onChange={(e) => setCurrency(e.target.value === 'IRT' ? 'IRT' : 'USD')}>
                    <option value="USD">{t('pricingCurrencyUsd')}</option>
                    <option value="IRT">{t('pricingCurrencyIrt')}</option>
                </select>
            </label>
            <button type="button" className="settings-primary-action" disabled={!valid} onClick={submit}>
                <Plus size={13} aria-hidden="true" />
                {t('pricingAddModel')}
            </button>
        </div>
    );
}

export function PricingPage({ state, onBack, onSaveModel, onRemoveModel }: PricingPageProps) {
    const usage = state?.usage ?? { input: 0, output: 0, cached: 0 };
    const costs = state?.costs ?? [];
    const providers = state?.providers ?? [];
    const hasUsage = usage.input > 0 || usage.output > 0 || usage.cached > 0;

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
                    <h2>{t('pricingTitle')}</h2>
                </div>
            </header>

            <div className="settings-scroll">
                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Coins size={15} />
                        </div>
                        <div>
                            <h3>{t('usageTitle')}</h3>
                            <p>{t('usageDesc')}</p>
                        </div>
                    </div>

                    <div className="settings-card-body">
                        <div className="usage-stats">
                            <UsageStat label={t('usageInput')} value={formatTokens(usage.input)} />
                            <UsageStat label={t('usageOutput')} value={formatTokens(usage.output)} />
                            <UsageStat label={t('usageCached')} value={formatTokens(usage.cached)} />
                            <UsageStat
                                label={t('usageCost')}
                                value={costs.length
                                    ? costs.map((c) => formatCost(c) ?? '—').join(' · ')
                                    : '—'}
                            />
                        </div>

                        {providers.length > 0 && (
                            <div className="usage-providers">
                                {providers.map((p) => (
                                    <div className="usage-provider" key={p.host}>
                                        <div className="usage-provider-main">
                                            <strong dir="ltr">{p.label}</strong>
                                            <span className="usage-provider-host" dir="ltr">{p.host}</span>
                                            {p.iranian && <span className="pricing-badge">{t('pricingIranianBadge')}</span>}
                                        </div>
                                        <div className="usage-provider-tokens" dir="ltr">
                                            <span><i>{t('usageInput')}</i>{formatTokens(p.input)}</span>
                                            <span><i>{t('usageOutput')}</i>{formatTokens(p.output)}</span>
                                            {p.cached > 0 && <span><i>{t('usageCached')}</i>{formatTokens(p.cached)}</span>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {!hasUsage && <p className="usage-empty">{t('usageEmpty')}</p>}
                    </div>
                </section>

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Tag size={15} />
                        </div>
                        <div>
                            <h3>{t('pricingModelsTitle')}</h3>
                            <p>{t('pricingModelsDesc')}</p>
                        </div>
                    </div>

                    <div className="settings-card-body">
                        {state?.models.length ? state.models.map((m) => (
                            <ModelRow key={m.id} model={m} onRemove={onRemoveModel} />
                        )) : (
                            <p className="usage-empty">{t('pricingEmptyModels')}</p>
                        )}
                        <AddModelForm onSave={onSaveModel} />
                    </div>
                </section>

                {/* Fine print lives at the footer, like the MCP/Skills page. */}
                <div className="mcp-hint foot" role="note">
                    <Info size={12} aria-hidden="true" />
                    <span>{t('pricingDesc')}</span>
                </div>
            </div>
        </div>
    );
}
