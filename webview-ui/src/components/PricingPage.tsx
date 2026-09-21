import { useMemo, useState } from 'react';
import {
    Activity,
    ArrowLeft,
    ArrowRight,
    ChevronLeft,
    ChevronRight,
    Coins,
    Info,
    Plus,
    Tag,
    Trash2,
} from 'lucide-react';
import { getLocale, t } from '../i18n';
import { formatCost } from '../cost';
import { formatCalendarDate, localDayTimestamp, shiftLocalDay } from '../datetime';
import type { LedgerDay, ModelPricingView, ProviderUsageView, UsageTotals } from '../types';

type Currency = 'USD' | 'IRT';

interface PricingState {
    providers: ProviderUsageView[];
    models: ModelPricingView[];
    history: LedgerDay[];
    allTime: UsageTotals;
}

interface PricingPageProps {
    state: PricingState | null;
    onBack: () => void;
    onSaveModel: (id: string, input: number, output: number, cachedInput: number | null, currency: 'USD' | 'IRT') => void;
    onRemoveModel: (id: string) => void;
}

/** Palette for stacked model segments. Stable per model id (indexed by the
 *  all-time model list) so a color does not move when a filter changes. */
const MODEL_COLORS = [
    '#4ec9b0', '#e0a458', '#7aa2f7', '#c586c0', '#d16969',
    '#8dc891', '#d7ba7d', '#569cd6', '#b2675e', '#9d7cd8',
];

const GRID_LINES = 4;

interface MonthGroup {
    label: string;
    days: LedgerDay[];
}

function calendarName(): string {
    return getLocale() === 'fa' ? 'fa-IR-u-ca-persian' : 'en-US';
}

/** Token counts read as numbers, so they always render LTR with separators. */
function formatTokens(value: number): string {
    const locale = getLocale() === 'fa' ? 'fa-IR' : 'en-US';
    return Math.max(0, Math.round(value)).toLocaleString(locale);
}

/** The month a day belongs to, in the LOCALE's calendar (Jalali for fa). */
function monthLabel(dayKey: string): string {
    return new Intl.DateTimeFormat(calendarName(), { month: 'long', year: 'numeric' })
        .format(new Date(localDayTimestamp(dayKey)));
}

/**
 * Group the (chronological) days into calendar months of the ACTIVE locale.
 * Grouping by label changes avoids any Jalali/Gregorian month math: a Jalali
 * month is a different Gregorian span, so a fixed month length would be wrong.
 */
function buildMonths(history: LedgerDay[]): MonthGroup[] {
    const groups: MonthGroup[] = [];
    let current: MonthGroup | null = null;
    for (const day of history) {
        const label = monthLabel(day.day);
        if (!current || current.label !== label) {
            current = { label, days: [] };
            groups.push(current);
        }
        current.days.push(day);
    }
    return groups;
}

/** Every local day of the group's month, so the axis has no gaps. */
function expandMonth(group: MonthGroup): string[] {
    const label = monthLabel(group.days[0].day);
    let first = group.days[0].day;
    let last = group.days[group.days.length - 1].day;
    for (let i = 0; i < 31 && monthLabel(shiftLocalDay(first, -1)) === label; i++) {
        first = shiftLocalDay(first, -1);
    }
    for (let i = 0; i < 31 && monthLabel(shiftLocalDay(last, 1)) === label; i++) {
        last = shiftLocalDay(last, 1);
    }
    const days: string[] = [];
    for (let day = first; day <= last; day = shiftLocalDay(day, 1)) days.push(day);
    return days;
}

/** Round an axis maximum up to a readable 1/2/2.5/5 x 10^n step. */
function niceMax(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    const base = 10 ** Math.floor(Math.log10(value));
    const norm = value / base;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * base;
}

function formatAxis(value: number, currency: Currency): string {
    if (currency === 'IRT') {
        if (value <= 0) return '۰';
        return new Intl.NumberFormat('fa-IR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
    }
    return new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
        style: 'currency',
        currency: 'USD',
    }).format(value);
}

/** A provider's all-time cost, in the currency it actually billed. */
function providerCost(provider: ProviderUsageView): string {
    if (provider.IRT > 0) return formatCost({ amount: provider.IRT, currency: 'IRT' }) ?? '—';
    if (provider.USD > 0) return formatCost({ amount: provider.USD, currency: 'USD' }) ?? '—';
    return '—';
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
    const locale = getLocale();
    const history = state?.history ?? [];
    const providers = state?.providers ?? [];
    const allTime = state?.allTime;

    // -1 means "latest month" so the initial view is correct even though the
    // data arrives after mount (no effect needed).
    const [monthIdx, setMonthIdx] = useState(-1);
    const [modelFilter, setModelFilter] = useState('all');
    const [hostFilter, setHostFilter] = useState('all');
    const [currencyChoice, setCurrencyChoice] = useState<'auto' | Currency>('auto');
    const [activeDay, setActiveDay] = useState<string | null>(null);

    const months = useMemo(() => buildMonths(history), [history, locale]);
    const idx = months.length ? (monthIdx < 0 ? months.length - 1 : Math.min(monthIdx, months.length - 1)) : -1;
    const month = idx >= 0 ? months[idx] : null;

    // Filter options come from the WHOLE ledger, not just the visible month.
    const allModels = useMemo(() => {
        const totals = new Map<string, number>();
        for (const day of history) {
            for (const cell of day.cells) {
                totals.set(cell.model, (totals.get(cell.model) ?? 0) + cell.input + cell.output + cell.cached);
            }
        }
        return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
    }, [history]);

    const dayCells = useMemo(() => {
        const map = new Map<string, LedgerDay>();
        for (const day of history) map.set(day.day, day);
        return map;
    }, [history]);

    const monthDays = useMemo(() => (month ? expandMonth(month) : []), [month, locale]);

    /** Cells of the selected month that pass the model/provider filters. */
    const filteredCells = useMemo(() => {
        const out: Array<{ day: string; cell: LedgerDay['cells'][number] }> = [];
        for (const day of monthDays) {
            for (const cell of dayCells.get(day)?.cells ?? []) {
                if (modelFilter !== 'all' && cell.model !== modelFilter) continue;
                if (hostFilter !== 'all' && cell.host !== hostFilter) continue;
                out.push({ day, cell });
            }
        }
        return out;
    }, [monthDays, dayCells, modelFilter, hostFilter]);

    const monthTotals = useMemo(() => {
        const totals = { USD: 0, IRT: 0, tokens: 0 };
        for (const { cell } of filteredCells) {
            totals.USD += cell.USD;
            totals.IRT += cell.IRT;
            totals.tokens += cell.input + cell.output + cell.cached;
        }
        return totals;
    }, [filteredCells]);

    // Toman is the default when a Toman-billed provider contributed, since that
    // is the money the user actually pays; USD providers fall back to USD.
    const autoCurrency: Currency = monthTotals.IRT > 0 ? 'IRT' : 'USD';
    // A manual choice only sticks while that currency HAS usage in the viewed
    // month. Otherwise stepping to a single-currency month (where the toggle is
    // hidden) would draw an empty chart for a month that really did cost money.
    const currency: Currency = currencyChoice !== 'auto' && monthTotals[currencyChoice] > 0
        ? currencyChoice
        : autoCurrency;
    const bothCurrencies = monthTotals.USD > 0 && monthTotals.IRT > 0;

    /** One stacked column per day of the month, in the active currency. */
    const series = useMemo(() => {
        return monthDays.map((day) => {
            const byModel = new Map<string, number>();
            let total = 0;
            let tokens = 0;
            for (const cell of dayCells.get(day)?.cells ?? []) {
                if (modelFilter !== 'all' && cell.model !== modelFilter) continue;
                if (hostFilter !== 'all' && cell.host !== hostFilter) continue;
                tokens += cell.input + cell.output + cell.cached;
                const value = currency === 'IRT' ? cell.IRT : cell.USD;
                if (value <= 0) continue;
                byModel.set(cell.model, (byModel.get(cell.model) ?? 0) + value);
                total += value;
            }
            return { day, byModel, total, tokens };
        });
    }, [monthDays, dayCells, modelFilter, hostFilter, currency]);

    const max = useMemo(() => niceMax(Math.max(0, ...series.map((d) => d.total))), [series]);

    const legend = useMemo(() => {
        const totals = new Map<string, number>();
        for (const day of series) {
            for (const [model, value] of day.byModel) totals.set(model, (totals.get(model) ?? 0) + value);
        }
        return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
    }, [series]);

    const colorFor = (model: string) => MODEL_COLORS[Math.max(0, allModels.indexOf(model)) % MODEL_COLORS.length];

    const active = activeDay ? series.find((d) => d.day === activeDay) ?? null : null;
    const axisTicks = Array.from({ length: GRID_LINES + 1 }, (_, i) => (max * i) / GRID_LINES).reverse();

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
                            <h3>{t('costChartTitle')}</h3>
                            <p>{t('costChartDesc')}</p>
                        </div>
                    </div>

                    <div className="settings-card-body">
                        <div className="cost-toolbar">
                            <div className="cost-month">
                                <button
                                    type="button"
                                    className="icon-btn"
                                    aria-label={t('costPrevMonth')}
                                    title={t('costPrevMonth')}
                                    disabled={idx <= 0}
                                    onClick={() => setMonthIdx(Math.max(0, idx - 1))}
                                >
                                    {getLocale() === 'fa' ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
                                </button>
                                <span className="cost-month-label">{month?.label ?? '—'}</span>
                                <button
                                    type="button"
                                    className="icon-btn"
                                    aria-label={t('costNextMonth')}
                                    title={t('costNextMonth')}
                                    disabled={idx < 0 || idx >= months.length - 1}
                                    onClick={() => setMonthIdx(Math.min(months.length - 1, idx + 1))}
                                >
                                    {getLocale() === 'fa' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                                </button>
                            </div>
                            <select
                                className="cost-select"
                                aria-label={t('costAllModels')}
                                value={modelFilter}
                                onChange={(e) => { setModelFilter(e.target.value); setActiveDay(null); }}
                            >
                                <option value="all">{t('costAllModels')}</option>
                                {allModels.map((model) => <option key={model} value={model}>{model}</option>)}
                            </select>
                            <select
                                className="cost-select"
                                aria-label={t('costAllProviders')}
                                value={hostFilter}
                                onChange={(e) => { setHostFilter(e.target.value); setActiveDay(null); }}
                            >
                                <option value="all">{t('costAllProviders')}</option>
                                {providers.map((p) => <option key={p.host} value={p.host}>{p.label}</option>)}
                            </select>
                        </div>

                        {bothCurrencies && (
                            <div className="cost-currencies" role="group" aria-label={t('usageCost')}>
                                <button
                                    type="button"
                                    className={`usage-range${currency === 'IRT' ? ' active' : ''}`}
                                    aria-pressed={currency === 'IRT'}
                                    onClick={() => setCurrencyChoice('IRT')}
                                >
                                    {t('costCurrencyIrt')}
                                </button>
                                <button
                                    type="button"
                                    className={`usage-range${currency === 'USD' ? ' active' : ''}`}
                                    aria-pressed={currency === 'USD'}
                                    onClick={() => setCurrencyChoice('USD')}
                                >
                                    {t('costCurrencyUsd')}
                                </button>
                            </div>
                        )}

                        {legend.length > 0 ? (
                            <>
                                <div className="cost-chart" dir="ltr">
                                    <div className="cost-axis" aria-hidden="true">
                                        {axisTicks.map((tick, i) => (
                                            <span key={i}>{formatAxis(tick, currency)}</span>
                                        ))}
                                    </div>
                                    <div className="cost-plot">
                                        <div className="cost-grid" aria-hidden="true">
                                            {axisTicks.map((_, i) => <span key={i} />)}
                                        </div>
                                        <div className="cost-cols" role="group" aria-label={t('costChartAria')}>
                                            {series.map((day) => {
                                                const label = `${formatCalendarDate(localDayTimestamp(day.day))} · ${formatCost({ amount: day.total, currency }) ?? '—'}`;
                                                return (
                                                    <button
                                                        key={day.day}
                                                        type="button"
                                                        className={`cost-col${activeDay === day.day ? ' active' : ''}`}
                                                        aria-label={label}
                                                        onMouseEnter={() => setActiveDay(day.day)}
                                                        onMouseLeave={() => setActiveDay((cur) => (cur === day.day ? null : cur))}
                                                        onFocus={() => setActiveDay(day.day)}
                                                        onBlur={() => setActiveDay((cur) => (cur === day.day ? null : cur))}
                                                    >
                                                        <span className="cost-stack" aria-hidden="true">
                                                            {[...day.byModel.entries()].map(([model, value]) => (
                                                                <span
                                                                    key={model}
                                                                    className="cost-seg"
                                                                    style={{ height: `${(value / max) * 100}%`, background: colorFor(model) }}
                                                                />
                                                            ))}
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>

                                <div className="cost-legend">
                                    {legend.map((model) => (
                                        <span className="cost-legend-item" key={model}>
                                            <span className="cost-swatch" style={{ background: colorFor(model) }} aria-hidden="true" />
                                            <span dir="ltr">{model}</span>
                                        </span>
                                    ))}
                                </div>

                                {/* Hover detail in flow (no box, no extra rule). */}
                                <p className="cost-detail" role="status">
                                    {active ? (
                                        <>
                                            <strong>{formatCalendarDate(localDayTimestamp(active.day))}</strong>
                                            <span dir="ltr">{formatCost({ amount: active.total, currency }) ?? '—'}</span>
                                            {[...active.byModel.entries()].map(([model, value]) => (
                                                <span key={model}>
                                                    <i style={{ background: colorFor(model) }} aria-hidden="true" />
                                                    <span dir="ltr">{model}</span>
                                                    <span dir="ltr">{formatCost({ amount: value, currency }) ?? '—'}</span>
                                                </span>
                                            ))}
                                        </>
                                    ) : (
                                        <span className="cost-detail-hint">{t('costHoverHint')}</span>
                                    )}
                                </p>
                            </>
                        ) : (
                            <p className="usage-empty">{t('costNoData')}</p>
                        )}
                    </div>
                </section>

                <section className="settings-card">
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Coins size={15} />
                        </div>
                        <div>
                            <h3>{t('providersTitle')}</h3>
                            <p>{t('providersDesc')}</p>
                        </div>
                    </div>

                    <div className="settings-card-body">
                        {providers.length > 0 ? providers.map((p) => (
                            <div className="prov-row" key={p.host}>
                                <div className="prov-main">
                                    <strong dir="ltr">{p.label}</strong>
                                    <span className="prov-host" dir="ltr">{p.host}</span>
                                    {p.iranian && <span className="pricing-badge">{t('pricingIranianBadge')}</span>}
                                </div>
                                <span className="prov-cost" dir="ltr">{providerCost(p)}</span>
                                <div className="prov-tokens" dir="ltr">
                                    <span><i>{t('usageInput')}</i>{formatTokens(p.input)}</span>
                                    <span><i>{t('usageOutput')}</i>{formatTokens(p.output)}</span>
                                    {p.cached > 0 && <span><i>{t('usageCached')}</i>{formatTokens(p.cached)}</span>}
                                </div>
                            </div>
                        )) : (
                            <p className="usage-empty">{t('usageEmpty')}</p>
                        )}

                        {allTime && (
                            <p className="usage-alltime">
                                {t('usageAllTime')}: {formatTokens(allTime.input + allTime.output + allTime.cached)} {t('usageTokens')}
                                {(allTime.USD > 0 || allTime.IRT > 0) && (
                                    <> · {[formatCost({ amount: allTime.USD, currency: 'USD' }), formatCost({ amount: allTime.IRT, currency: 'IRT' })]
                                        .filter((v): v is string => v != null)
                                        .join(' · ')}</>
                                )}
                            </p>
                        )}
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
