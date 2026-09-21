import { useMemo, useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, Coins, Info, Plus, Tag, Trash2 } from 'lucide-react';
import { getLocale, t } from '../i18n';
import { formatCost } from '../cost';
import { formatCalendarDate } from '../datetime';
import type { DailyUsage, ModelPricingView, ProviderUsageView, UsageTotals } from '../types';

type RangeKey = '7d' | '30d' | 'all';

interface PricingState {
    providers: ProviderUsageView[];
    usage: { input: number; output: number; cached: number };
    costs: Array<{ amount: number; currency: 'USD' | 'IRT' }>;
    models: ModelPricingView[];
    history: DailyUsage[];
    allTime: UsageTotals;
}

interface PricingPageProps {
    state: PricingState | null;
    onBack: () => void;
    onSaveModel: (id: string, input: number, output: number, cachedInput: number | null, currency: 'USD' | 'IRT') => void;
    onRemoveModel: (id: string) => void;
}

const RANGES: Array<{ key: RangeKey; days: number | null }> = [
    { key: '7d', days: 7 },
    { key: '30d', days: 30 },
    { key: 'all', days: null },
];

/** Token counts read as numbers, so they always render LTR with separators. */
function formatTokens(value: number): string {
    const locale = getLocale() === 'fa' ? 'fa-IR' : 'en-US';
    return Math.max(0, Math.round(value)).toLocaleString(locale);
}

/** A day bucket's key parsed as LOCAL midnight (never UTC). */
function dayTimestamp(key: string): number {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1).getTime();
}

function totalTokens(day: { input: number; output: number; cached: number }): number {
    return day.input + day.output + day.cached;
}

function UsageStat({ label, value }: { label: string; value: string }) {
    return (
        <div className="usage-stat">
            <span className="usage-stat-label">{label}</span>
            <span className="usage-stat-value" dir="ltr">{value}</span>
        </div>
    );
}

/** Cost chips for a bucket's USD/IRT spend (either may be absent). */
function CostLine({ usd, irt }: { usd: number; irt: number }) {
    const parts = [
        formatCost({ amount: usd, currency: 'USD' }),
        formatCost({ amount: irt, currency: 'IRT' }),
    ].filter((v): v is string => v != null);
    return <>{parts.length ? parts.join(' · ') : '—'}</>;
}

/**
 * Daily bar chart. Bars are individually focusable buttons with a full
 * accessible label, rather than one `role="img"` SVG: `role="img"` makes every
 * descendant presentational, which would hide the per-day detail from screen
 * readers (MDN). Hover AND keyboard focus both open the tooltip.
 */
function UsageChart({ days }: { days: DailyUsage[] }) {
    const [active, setActive] = useState<number | null>(null);
    const max = Math.max(1, ...days.map(totalTokens));
    const activeDay = active != null ? days[active] : null;

    return (
        <div className="usage-chart" dir="ltr">
            <div className="usage-bars" role="group" aria-label={t('usageChartAria')}>
                {days.map((day, i) => {
                    const total = totalTokens(day);
                    const height = total > 0 ? Math.max(4, Math.round((total / max) * 100)) : 0;
                    const label = [
                        formatCalendarDate(dayTimestamp(day.day)),
                        `${t('usageInput')} ${formatTokens(day.input)}`,
                        `${t('usageOutput')} ${formatTokens(day.output)}`,
                        `${t('usageCached')} ${formatTokens(day.cached)}`,
                    ].join(' · ');
                    return (
                        <button
                            key={day.day}
                            type="button"
                            className={`usage-bar-slot${active === i ? ' active' : ''}`}
                            aria-label={label}
                            onMouseEnter={() => setActive(i)}
                            onMouseLeave={() => setActive((cur) => (cur === i ? null : cur))}
                            onFocus={() => setActive(i)}
                            onBlur={() => setActive((cur) => (cur === i ? null : cur))}
                        >
                            <span className="usage-bar" style={{ height: `${height}%` }} aria-hidden="true" />
                        </button>
                    );
                })}
            </div>
            {/* The detail sits in flow rather than as a floating tooltip: at
                sidebar width a floating card would clip at the edges. */}
            <div className="usage-inspect" role="status" aria-live="polite">
                {activeDay ? (
                    <>
                        <strong>{formatCalendarDate(dayTimestamp(activeDay.day))}</strong>
                        <span className="usage-inspect-nums" dir="ltr">
                            <span><i>{t('usageInput')}</i>{formatTokens(activeDay.input)}</span>
                            <span><i>{t('usageOutput')}</i>{formatTokens(activeDay.output)}</span>
                            <span><i>{t('usageCached')}</i>{formatTokens(activeDay.cached)}</span>
                            <span><i>{t('usageCost')}</i><CostLine usd={activeDay.USD} irt={activeDay.IRT} /></span>
                        </span>
                    </>
                ) : (
                    <span className="usage-inspect-hint">{t('usageHoverHint')}</span>
                )}
            </div>
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
    const [range, setRange] = useState<RangeKey>('7d');
    const usage = state?.usage ?? { input: 0, output: 0, cached: 0 };
    const costs = state?.costs ?? [];
    const providers = state?.providers ?? [];
    const history = state?.history ?? [];
    const allTime = state?.allTime;

    const shownDays = useMemo(() => {
        const config = RANGES.find((r) => r.key === range);
        return config?.days ? history.slice(-config.days) : history;
    }, [history, range]);

    const rangeTotals = useMemo(
        () => shownDays.reduce(
            (acc, day) => ({
                input: acc.input + day.input,
                output: acc.output + day.output,
                cached: acc.cached + day.cached,
                USD: acc.USD + day.USD,
                IRT: acc.IRT + day.IRT,
            }),
            { input: 0, output: 0, cached: 0, USD: 0, IRT: 0 },
        ),
        [shownDays],
    );

    const hasUsage = usage.input > 0 || usage.output > 0 || usage.cached > 0;
    const hasRangeUsage = totalTokens(rangeTotals) > 0;

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
                            <Activity size={15} />
                        </div>
                        <div>
                            <h3>{t('usageHistoryTitle')}</h3>
                            <p>{t('usageHistoryDesc')}</p>
                        </div>
                    </div>

                    <div className="settings-card-body">
                        <div className="usage-ranges" role="tablist" aria-label={t('usageHistoryTitle')}>
                            {RANGES.map((r) => (
                                <button
                                    key={r.key}
                                    type="button"
                                    role="tab"
                                    aria-selected={range === r.key}
                                    className={`usage-range${range === r.key ? ' active' : ''}`}
                                    onClick={() => setRange(r.key)}
                                >
                                    {t(r.key === '7d' ? 'usageRange7' : r.key === '30d' ? 'usageRange30' : 'usageRangeAll')}
                                </button>
                            ))}
                        </div>

                        {hasRangeUsage ? (
                            <UsageChart days={shownDays} />
                        ) : (
                            <p className="usage-empty">{t('usageChartEmpty')}</p>
                        )}

                        <div className="usage-stats">
                            <UsageStat label={t('usageInput')} value={formatTokens(rangeTotals.input)} />
                            <UsageStat label={t('usageOutput')} value={formatTokens(rangeTotals.output)} />
                            <UsageStat label={t('usageCached')} value={formatTokens(rangeTotals.cached)} />
                            <UsageStat
                                label={t('usageCost')}
                                value={rangeTotals.USD > 0 || rangeTotals.IRT > 0
                                    ? [formatCost({ amount: rangeTotals.USD, currency: 'USD' }), formatCost({ amount: rangeTotals.IRT, currency: 'IRT' })]
                                        .filter((v): v is string => v != null)
                                        .join(' · ')
                                    : '—'}
                            />
                        </div>

                        {allTime && (
                            <p className="usage-alltime" dir="auto">
                                {t('usageAllTime')}: {formatTokens(totalTokens(allTime))} {t('usageTokens')}
                                {(allTime.USD > 0 || allTime.IRT > 0) && (
                                    <> · <CostLine usd={allTime.USD} irt={allTime.IRT} /></>
                                )}
                            </p>
                        )}
                    </div>
                </section>

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
