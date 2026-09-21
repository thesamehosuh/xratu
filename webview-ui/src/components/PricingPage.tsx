import { useState } from 'react';
import { ArrowLeft, ArrowRight, BadgeDollarSign, Coins, Plus, Trash2 } from 'lucide-react';
import { getLocale, t } from '../i18n';
import type { ModelPricingView, ProviderPricingView } from '../types';

interface PricingState {
    providers: ProviderPricingView[];
    models: ModelPricingView[];
    fallbackRate: number;
}

interface PricingPageProps {
    state: PricingState | null;
    onBack: () => void;
    onSaveProvider: (host: string, tomanPerUsd: number | null, markupPercent: number | null) => void;
    onRemoveProvider: (host: string) => void;
    onSaveModel: (id: string, input: number, output: number, cachedInput: number | null, currency: 'USD' | 'IRT') => void;
    onRemoveModel: (id: string) => void;
    onSetFallback: (tomanPerUsd: number) => void;
}

function ProviderRateRow({
    provider,
    onSave,
    onRemove,
}: {
    provider: ProviderPricingView;
    onSave: PricingPageProps['onSaveProvider'];
    onRemove: PricingPageProps['onRemoveProvider'];
}) {
    const [rate, setRate] = useState(provider.tomanPerUsd != null ? String(provider.tomanPerUsd) : '');
    const [markup, setMarkup] = useState(provider.markupPercent != null ? String(provider.markupPercent) : '');
    const [dirty, setDirty] = useState(false);
    const parsedRate = rate.trim() === '' ? null : Number(rate);
    const parsedMarkup = markup.trim() === '' ? null : Number(markup);
    const canSave = rate.trim() === '' || (Number.isFinite(parsedRate as number) && (parsedRate as number) > 0);

    return (
        <div className="pricing-row">
            <div className="pricing-row-head">
                <span className="pricing-row-label" dir="ltr">{provider.label}</span>
                <span className="pricing-row-host" dir="ltr">{provider.host}</span>
                {provider.iranian && <span className="pricing-badge">{t('pricingIranianBadge')}</span>}
            </div>
            <div className="pricing-row-fields">
                <label className="pricing-field">
                    <span>{t('pricingRateLabel')}</span>
                    <input
                        type="number"
                        dir="ltr"
                        min="0"
                        inputMode="numeric"
                        value={rate}
                        placeholder={t('pricingRatePlaceholder')}
                        onChange={(e) => { setRate(e.target.value); setDirty(true); }}
                    />
                </label>
                <label className="pricing-field">
                    <span>{t('pricingMarkupLabel')}</span>
                    <input
                        type="number"
                        dir="ltr"
                        min="0"
                        inputMode="numeric"
                        value={markup}
                        placeholder="0"
                        onChange={(e) => { setMarkup(e.target.value); setDirty(true); }}
                    />
                </label>
                <div className="pricing-row-actions">
                    <button
                        type="button"
                        className="settings-ghost-action"
                        disabled={!canSave || !dirty}
                        onClick={() => { onSave(provider.host, parsedRate, parsedMarkup); setDirty(false); }}
                    >
                        {t('pricingSave')}
                    </button>
                    {provider.tomanPerUsd != null && (
                        <button
                            type="button"
                            className="settings-ghost-action danger"
                            onClick={() => { setRate(''); setMarkup(''); onRemove(provider.host); }}
                        >
                            {t('pricingClear')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

function ModelRow({ model, onRemove }: { model: ModelPricingView; onRemove: (id: string) => void }) {
    return (
        <div className="pricing-row compact">
            <div className="pricing-row-head">
                <span className="pricing-row-label" dir="ltr">{model.id}</span>
                <span className="pricing-row-host" dir="ltr">
                    {model.input} / {model.output}
                    {model.cachedInput != null ? ` / ${model.cachedInput}` : ''} {model.currency}
                </span>
            </div>
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
    const valid = id.trim() !== ''
        && Number.isFinite(inputValue) && inputValue >= 0
        && Number.isFinite(outputValue) && outputValue >= 0
        && (cachedValue == null || (Number.isFinite(cachedValue) && cachedValue >= 0));

    const submit = () => {
        if (!valid) return;
        onSave(id.trim(), inputValue, outputValue, cachedValue, currency);
        setId(''); setInput(''); setOutput(''); setCached('');
    };

    return (
        <div className="pricing-add">
            <label className="pricing-field grow">
                <span>{t('pricingModelId')}</span>
                <input type="text" dir="ltr" value={id} placeholder="gpt-4o" onChange={(e) => setId(e.target.value)} />
            </label>
            <label className="pricing-field">
                <span>{t('pricingModelInput')}</span>
                <input type="number" dir="ltr" min="0" value={input} onChange={(e) => setInput(e.target.value)} />
            </label>
            <label className="pricing-field">
                <span>{t('pricingModelOutput')}</span>
                <input type="number" dir="ltr" min="0" value={output} onChange={(e) => setOutput(e.target.value)} />
            </label>
            <label className="pricing-field">
                <span>{t('pricingModelCached')}</span>
                <input type="number" dir="ltr" min="0" value={cached} onChange={(e) => setCached(e.target.value)} />
            </label>
            <label className="pricing-field">
                <span>{t('pricingModelCurrency')}</span>
                <select dir="ltr" value={currency} onChange={(e) => setCurrency(e.target.value === 'IRT' ? 'IRT' : 'USD')}>
                    <option value="USD">{t('pricingCurrencyUsd')}</option>
                    <option value="IRT">{t('pricingCurrencyIrt')}</option>
                </select>
            </label>
            <button type="button" className="settings-ghost-action" disabled={!valid} onClick={submit}>
                <Plus size={13} aria-hidden="true" />
                {t('pricingAddModel')}
            </button>
        </div>
    );
}

export function PricingPage({
    state,
    onBack,
    onSaveProvider,
    onRemoveProvider,
    onSaveModel,
    onRemoveModel,
    onSetFallback,
}: PricingPageProps) {
    const [fallback, setFallback] = useState('');
    const [fallbackDirty, setFallbackDirty] = useState(false);
    const fallbackValue = fallback.trim() === '' ? 0 : Number(fallback);
    const fallbackValid = Number.isFinite(fallbackValue) && (fallbackValue as number) >= 0;

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
                    <p>{t('pricingDesc')}</p>
                </div>
            </header>

            <div className="settings-scroll">
                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Coins size={15} />
                        </div>
                        <div>
                            <h3>{t('pricingProvidersTitle')}</h3>
                            <p>{t('pricingProvidersDesc')}</p>
                        </div>
                    </div>
                    <div className="settings-card-body">
                        {state?.providers.length ? state.providers.map((p) => (
                            <ProviderRateRow
                                key={p.host}
                                provider={p}
                                onSave={onSaveProvider}
                                onRemove={onRemoveProvider}
                            />
                        )) : (
                            <p className="pricing-empty">{t('pricingNoProviders')}</p>
                        )}
                    </div>
                </section>

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <BadgeDollarSign size={15} />
                        </div>
                        <div>
                            <h3>{t('pricingFallbackTitle')}</h3>
                            <p>{t('pricingFallbackDesc')}</p>
                        </div>
                    </div>
                    <div className="settings-card-body pricing-add">
                        <label className="pricing-field grow">
                            <span>{t('pricingFallbackLabel')}</span>
                            <input
                                type="number"
                                dir="ltr"
                                min="0"
                                inputMode="numeric"
                                value={fallback}
                                placeholder={state?.fallbackRate ? String(state.fallbackRate) : ''}
                                onChange={(e) => { setFallback(e.target.value); setFallbackDirty(true); }}
                            />
                        </label>
                        <button
                            type="button"
                            className="settings-ghost-action"
                            disabled={!fallbackValid || !fallbackDirty}
                            onClick={() => { onSetFallback(Number(fallbackValue) || 0); setFallbackDirty(false); }}
                        >
                            {t('pricingSave')}
                        </button>
                    </div>
                </section>

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Plus size={15} />
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
                            <p className="pricing-empty">{t('pricingEmptyModels')}</p>
                        )}
                        <AddModelForm onSave={onSaveModel} />
                    </div>
                </section>
            </div>
        </div>
    );
}
