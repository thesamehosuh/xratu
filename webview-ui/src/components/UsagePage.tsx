import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    ExternalLink,
    Pencil,
    Plus,
    RefreshCw,
    Tag,
} from 'lucide-react';
import { getLocale, t } from '../i18n';
import { formatCost } from '../cost';
import { formatCalendarDate, localDayTimestamp, shiftLocalDay } from '../datetime';
import { totalTokens, uncachedInput } from '../usageTokens';
import { Dropdown, popupPlacement } from './Dropdown';
import type { ChatGptUsageView, LedgerDay, ModelRateView, OAuthHostState, ProviderUsageView, UsageTotals } from '../types';

type Currency = 'USD' | 'IRT';

interface UsageState {
    providers: ProviderUsageView[];
    rates: ModelRateView[];
    history: LedgerDay[];
    allTime: UsageTotals;
    chatgpt?: ChatGptUsageView;
}

interface UsagePageProps {
    state: UsageState | null;
    oauthState?: OAuthHostState | null;
    onBack: () => void;
    onRefresh?: () => void;
    onSaveModel: (id: string, input: number, output: number, cachedInput: number | null, currency: 'USD' | 'IRT') => void;
    onRemoveModel: (id: string) => void;
}

/** Palette for stacked model segments. Stable per model id (indexed by the
 *  all-time model list) so a color does not move when a filter changes. */
const MODEL_COLORS = [
    '#82dbc5', '#a6bcf4', '#edc68a', '#c586c0', '#d16969',
    '#8dc891', '#d7ba7d', '#569cd6', '#b2675e', '#9d7cd8',
];

const GRID_LINES = 4;

interface MonthGroup {
    label: string;
    days: LedgerDay[];
}

/** A chart axis: a label plus the local day keys it spans. */
interface AxisGroup {
    label: string;
    days: string[];
}

type Granularity = 'week' | 'month';

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

/** Trailing 7-day windows over the recorded days, oldest first. */
function buildWeeks(history: LedgerDay[]): AxisGroup[] {
    if (!history.length) return [];
    const first = history[0].day;
    const groups: AxisGroup[] = [];
    let end = history[history.length - 1].day;
    // Bounded loop: the ledger holds at most ~120 days, so ~18 windows.
    for (let guard = 0; guard < 60; guard++) {
        const start = shiftLocalDay(end, -6);
        const days: string[] = [];
        for (let day = start; day <= end; day = shiftLocalDay(day, 1)) days.push(day);
        groups.push({
            label: `${formatCalendarDate(localDayTimestamp(start))} – ${formatCalendarDate(localDayTimestamp(end))}`,
            days,
        });
        if (start <= first) break;
        end = shiftLocalDay(start, -1);
    }
    return groups.reverse();
}

/** Round an axis maximum up to a readable 1/2/2.5/5 x 10^n step. */
function niceMax(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    const base = 10 ** Math.floor(Math.log10(value));
    const norm = value / base;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * base;
}

/** Axis labels, with the precision the STEP needs: compact notation turns a
 *  sub-cent maximum into a column of identical "$0" ticks. */
function formatAxis(value: number, currency: Currency, step: number): string {
    const digits = step >= 1 ? 1 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4;
    if (currency === 'IRT') {
        if (value <= 0) return getLocale() === 'fa' ? '۰' : '0';
        return new Intl.NumberFormat(getLocale() === 'fa' ? 'fa-IR' : 'en-US', {
            notation: step >= 1000 ? 'compact' : 'standard',
            maximumFractionDigits: digits,
        }).format(value);
    }
    return new Intl.NumberFormat('en-US', {
        notation: step >= 1 ? 'compact' : 'standard',
        maximumFractionDigits: digits,
        style: 'currency',
        currency: 'USD',
    }).format(value);
}

function UsageAmounts({ totals }: { totals: { USD: number; IRT: number } }) {
    const toman = totals.IRT > 0 ? `${formatTokens(totals.IRT)} ${t('costCurrencyIrt')}` : null;
    const amounts = [toman, formatCost({ amount: totals.USD, currency: 'USD' })].filter(Boolean);
    return <span className="usage-amounts">{amounts.length ? amounts.map((amount) => <span dir="ltr" key={amount}>{amount}</span>) : <span dir="ltr">—</span>}</span>;
}

const RATE_SOURCE_LABEL = {
    override: 'rateSourceOverride',
    provider: 'rateSourceProvider',
    gateway: 'rateSourceGateway',
    builtin: 'rateSourceBuiltin',
    unknown: 'rateSourceUnknown',
} as const;

/**
 * One row of the rate sheet: the model's effective rate and where it came
 * from. Editing opens a panel anchored to the row (not an inline expansion),
 * so the sheet keeps its shape while a rate is being corrected.
 */
function RateRow({
    rate,
    showHost,
    onSaveModel,
    onRemoveModel,
}: {
    rate: ModelRateView;
    showHost: boolean;
    onSaveModel: UsagePageProps['onSaveModel'];
    onRemoveModel: (id: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    /** Cards clip their overflow: flip and shrink the panel to fit inside. */
    const [placement, setPlacement] = useState<{ up: boolean; cap: number | undefined }>({ up: false, cap: undefined });
    const rowRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    // An unresolved rate has nothing to prefill - starting empty forces the
    // user to enter real numbers instead of saving a row of zeros.
    const unresolved = rate.source === 'unknown';
    const [input, setInput] = useState(unresolved ? '' : String(rate.input));
    const [output, setOutput] = useState(unresolved ? '' : String(rate.output));
    const [cached, setCached] = useState(unresolved || rate.cachedInput == null ? '' : String(rate.cachedInput));
    const [currency, setCurrency] = useState<Currency>(rate.currency);

    // Re-sync from the host echo, but never while the user is typing.
    useEffect(() => {
        if (editing) return;
        setInput(unresolved ? '' : String(rate.input));
        setOutput(unresolved ? '' : String(rate.output));
        setCached(unresolved || rate.cachedInput == null ? '' : String(rate.cachedInput));
        setCurrency(rate.currency);
    }, [rate.input, rate.output, rate.cachedInput, rate.currency, editing, unresolved]);

    useLayoutEffect(() => {
        if (!editing || !rowRef.current) return;
        setPlacement(popupPlacement(rowRef.current, 400));
    }, [editing]);

    useEffect(() => {
        if (!editing) return;
        const onPointerDown = (e: MouseEvent) => {
            if (!rowRef.current?.contains(e.target as Node)) setEditing(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [editing]);

    useLayoutEffect(() => {
        if (editing) rowRef.current?.querySelector<HTMLInputElement>('.rate-pop input')?.focus();
    }, [editing]);

    const inputValue = Number(input);
    const outputValue = Number(output);
    const cachedValue = cached.trim() === '' ? null : Number(cached);
    const valid = input.trim() !== '' && Number.isFinite(inputValue) && inputValue >= 0
        && output.trim() !== '' && Number.isFinite(outputValue) && outputValue >= 0
        && (cachedValue == null || (Number.isFinite(cachedValue) && cachedValue >= 0));

    const save = () => {
        if (!valid) return;
        onSaveModel(rate.id, inputValue, outputValue, cachedValue, currency);
        setEditing(false);
    };

    const revert = () => {
        onRemoveModel(rate.id);
        setEditing(false);
    };

    return (
        <div className={`rate-row${editing ? ' editing' : ''}`} ref={rowRef}>
            <div className="rate-head">
                <span className="rate-name">
                    <strong dir="ltr">{rate.id}</strong>
                    {showHost && rate.host && <span className="rate-host" dir="ltr">{rate.host}</span>}
                    <span className={`rate-source ${rate.source}`}>{t(RATE_SOURCE_LABEL[rate.source])}</span>
                    <span className="pricing-badge currency" dir="ltr">{rate.currency}</span>
                </span>
                <span className="rate-head-end">
                    <span className="usage-cost rate-spend"><small>{t('usageAllTime')}</small><UsageAmounts totals={rate} /></span>
                    <button
                        type="button"
                        className="icon-btn"
                        aria-label={t('ratesEdit')}
                        aria-expanded={editing}
                        aria-haspopup="dialog"
                        title={t('ratesEdit')}
                        onClick={() => setEditing((wasEditing) => !wasEditing)}
                    >
                        <Pencil size={13} />
                    </button>
                </span>
            </div>

            {rate.source === 'unknown' ? (
                <span className="rate-unknown">{t('ratesUnknownHint')}</span>
            ) : (
                <span className="rate-values" dir="ltr">
                    <span><i>{t('pricingModelInput')}</i><b>{rate.input}</b></span>
                    <span><i>{t('pricingModelOutput')}</i><b>{rate.output}</b></span>
                    {rate.cachedInput != null && (
                        <span><i>{t('pricingModelCached')}</i><b>{rate.cachedInput}</b></span>
                    )}
                </span>
            )}

            {editing && (
                <div
                    ref={panelRef}
                    className={`rate-pop${placement.up ? ' up' : ''}`}
                    role="dialog"
                    aria-label={`${t('ratesEdit')}: ${rate.id}`}
                    style={placement.cap != null ? { maxHeight: `${placement.cap}px` } : undefined}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditing(false);
                        }
                    }}
                >
                    <div className="rate-edit-grid">
                        <NumberField label={t('pricingModelInput')} value={input} onChange={setInput} />
                        <NumberField label={t('pricingModelOutput')} value={output} onChange={setOutput} />
                        <NumberField label={t('pricingModelCached')} value={cached} onChange={setCached} />
                        <div className="mcp-field">
                            <span className="mcp-field-label">{t('pricingModelCurrency')}</span>
                            <Dropdown
                                label={t('pricingModelCurrency')}
                                value={currency}
                                options={[
                                    { value: 'USD', label: t('pricingCurrencyUsd') },
                                    { value: 'IRT', label: t('pricingCurrencyIrt') },
                                ]}
                                onChange={(next) => setCurrency(next === 'IRT' ? 'IRT' : 'USD')}
                            />
                        </div>
                    </div>
                    <div className="rate-edit-actions">
                        {rate.source === 'override' && (
                            <button type="button" className="settings-ghost-action" onClick={revert}>
                                {t('ratesUseBuiltin')}
                            </button>
                        )}
                        <button type="button" className="settings-ghost-action" onClick={() => setEditing(false)}>
                            {t('editCancel')}
                        </button>
                        <button type="button" className="settings-primary-action" disabled={!valid} onClick={save}>
                            {t('ratesSave')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * Price input with our own step buttons: the native number spinners cannot be
 * themed (they render as light UA boxes on dark hosts), so the field is a text
 * input and the steps are drawn from the same color tokens as the rest.
 */
function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
    const step = (direction: 1 | -1) => {
        const current = Number(value);
        const base = value.trim() === '' || !Number.isFinite(current) ? 0 : current;
        // Sub-dollar rates move in cents, larger (dollar/Toman) rates in units.
        const amount = base > 0 && base < 1 ? 0.01 : 1;
        const next = Math.max(0, base + direction * amount);
        onChange(String(Number(next.toFixed(4))));
    };

    return (
        <label className="mcp-field">
            <span className="mcp-field-label">{label}</span>
            <span className="num-field">
                <input
                    type="text"
                    dir="ltr"
                    inputMode="decimal"
                    autoComplete="off"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                />
                <span className="num-steps">
                    <button
                        type="button"
                        className="num-step"
                        aria-label={`${t('pricingStepUp')} ${label}`}
                        title={t('pricingStepUp')}
                        onClick={() => step(1)}
                    >
                        <ChevronUp size={10} aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        className="num-step"
                        aria-label={`${t('pricingStepDown')} ${label}`}
                        title={t('pricingStepDown')}
                        onClick={() => step(-1)}
                    >
                        <ChevronDown size={10} aria-hidden="true" />
                    </button>
                </span>
            </span>
        </label>
    );
}

function AddModelForm({ onSave, onCancel }: { onSave: UsagePageProps['onSaveModel']; onCancel: () => void }) {
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
            <NumberField label={t('pricingModelInput')} value={input} onChange={setInput} />
            <NumberField label={t('pricingModelOutput')} value={output} onChange={setOutput} />
            <NumberField label={t('pricingModelCached')} value={cached} onChange={setCached} />
            <div className="mcp-field">
                <span className="mcp-field-label">{t('pricingModelCurrency')}</span>
                <Dropdown
                    label={t('pricingModelCurrency')}
                    value={currency}
                    options={[
                        { value: 'USD', label: t('pricingCurrencyUsd') },
                        { value: 'IRT', label: t('pricingCurrencyIrt') },
                    ]}
                    onChange={(next) => setCurrency(next === 'IRT' ? 'IRT' : 'USD')}
                />
            </div>
            <div className="rates-form-actions">
                <button type="button" className="settings-ghost-action" onClick={onCancel}>
                    {t('editCancel')}
                </button>
                <button type="button" className="settings-primary-action" disabled={!valid} onClick={submit}>
                    <Plus size={13} aria-hidden="true" />
                    <span>{t('pricingAddModel')}</span>
                </button>
            </div>
        </div>
    );
}

export function UsagePage({ state, oauthState, onBack, onRefresh, onSaveModel, onRemoveModel }: UsagePageProps) {
    const locale = getLocale();
    const history = state?.history ?? [];
    const providers = useMemo(() => state?.providers ?? [], [state?.providers]);
    const rates = state?.rates ?? [];
    const allTime = state?.allTime;
    const plan = state?.chatgpt;
    const accounts = oauthState?.accounts?.filter((account) => account.providerId === 'chatgpt-codex' && account.planEnabled) ?? [];
    const showPlan = accounts.length > 0 || plan?.hasHistory;
    const [adding, setAdding] = useState(false);

    /** Models used through more than one provider: only then is the host worth
     *  showing on the rate row (the same model can resolve to two rates). */
    const multiHostIds = useMemo(() => {
        const hostsById = new Map<string, Set<string>>();
        for (const rate of rates) {
            const hosts = hostsById.get(rate.id) ?? new Set<string>();
            hosts.add(rate.host);
            hostsById.set(rate.id, hosts);
        }
        return new Set([...hostsById.entries()].filter(([, hosts]) => hosts.size > 1).map(([id]) => id));
    }, [rates]);

    // -1 means "latest period" so the initial view is correct even though the
    // data arrives after mount (no effect needed).
    const [granularity, setGranularity] = useState<Granularity>('month');
    const [groupIdx, setGroupIdx] = useState(-1);
    const [modelFilter, setModelFilter] = useState('all');
    const [hostFilter, setHostFilter] = useState('all');
    const [currencyChoice, setCurrencyChoice] = useState<'auto' | Currency>('auto');
    const [viewChoice, setViewChoice] = useState<'tokens' | 'cost' | 'plan' | null>(null);
    const view = viewChoice === 'plan' && !showPlan ? 'tokens' : viewChoice ?? (showPlan && !history.length ? 'plan' : 'tokens');
    const chartMetric = view === 'cost' ? 'cost' : 'tokens';
    const setChartMetric = (metric: 'cost' | 'tokens') => setViewChoice(metric);
    const [breakdown, setBreakdown] = useState<'models' | 'providers'>('models');
    const [activeDay, setActiveDay] = useState<string | null>(null);
    /** Model segment under the cursor - narrows the detail line to that one. */
    const [activeModel, setActiveModel] = useState<string | null>(null);

    const months = useMemo(() => buildMonths(history), [history, locale]);
    const weeks = useMemo(() => buildWeeks(history), [history, locale]);
    const axisGroups = useMemo<AxisGroup[]>(
        () => (granularity === 'week' ? weeks : months.map((m) => ({ label: m.label, days: expandMonth(m) }))),
        [granularity, weeks, months, locale],
    );
    const idx = axisGroups.length
        ? (groupIdx < 0 ? axisGroups.length - 1 : Math.min(groupIdx, axisGroups.length - 1))
        : -1;
    const axis = idx >= 0 ? axisGroups[idx] : null;

    // Filter options come from the WHOLE ledger, not just the visible month.
    const allModels = useMemo(() => {
        const totals = new Map<string, number>();
        for (const day of history) {
            for (const cell of day.cells) {
                totals.set(cell.model, (totals.get(cell.model) ?? 0) + totalTokens(cell));
            }
        }
        return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
    }, [history]);

    const dayCells = useMemo(() => {
        const map = new Map<string, LedgerDay>();
        for (const day of history) map.set(day.day, day);
        return map;
    }, [history]);

    const axisDays = useMemo(() => axis?.days ?? [], [axis]);

    /** Cells of the selected period that pass the model/provider filters. */
    const filteredCells = useMemo(() => {
        const out: Array<{ day: string; cell: LedgerDay['cells'][number] }> = [];
        for (const day of axisDays) {
            for (const cell of dayCells.get(day)?.cells ?? []) {
                if (modelFilter !== 'all' && cell.model !== modelFilter) continue;
                if (hostFilter !== 'all' && cell.host !== hostFilter) continue;
                out.push({ day, cell });
            }
        }
        return out;
    }, [axisDays, dayCells, modelFilter, hostFilter]);

    const periodTotals = useMemo(() => {
        const totals = { USD: 0, IRT: 0, tokens: 0, input: 0, output: 0, cached: 0 };
        for (const { cell } of filteredCells) {
            totals.USD += cell.USD;
            totals.IRT += cell.IRT;
            totals.tokens += totalTokens(cell);
            totals.input += cell.input;
            totals.output += cell.output;
            totals.cached += cell.cached;
        }
        return totals;
    }, [filteredCells]);

    const periodProviders = useMemo(() => {
        const grouped = new Map<string, ProviderUsageView>();
        for (const { cell } of filteredCells) {
            let row = grouped.get(cell.host);
            if (!row) {
                const provider = providers.find((entry) => entry.host === cell.host);
                row = { host: cell.host, label: provider?.label ?? cell.host, iranian: provider?.iranian ?? false, input: 0, output: 0, cached: 0, USD: 0, IRT: 0 };
                grouped.set(cell.host, row);
            }
            for (const key of ['input', 'output', 'cached', 'USD', 'IRT'] as const) row[key] += cell[key];
        }
        return [...grouped.values()].sort((a, b) => totalTokens(b) - totalTokens(a));
    }, [filteredCells, providers]);
    const periodModels = useMemo(() => {
        const rows = new Map<string, UsageTotals>();
        for (const { cell } of filteredCells) {
            const totals = rows.get(cell.model) ?? { input: 0, output: 0, cached: 0, USD: 0, IRT: 0 };
            for (const key of ['input', 'output', 'cached', 'USD', 'IRT'] as const) totals[key] += cell[key];
            rows.set(cell.model, totals);
        }
        return [...rows].sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]));
    }, [filteredCells]);
    const hasFilters = modelFilter !== 'all' || hostFilter !== 'all';
    const clearFilters = () => { setModelFilter('all'); setHostFilter('all'); setActiveDay(null); setActiveModel(null); };

    // Toman is the default when a Toman-billed provider contributed, since that
    // is the money the user actually pays; USD providers fall back to USD.
    const autoCurrency: Currency = periodTotals.IRT > 0 ? 'IRT' : 'USD';
    // A manual choice only sticks while that currency HAS usage in the viewed
    // month. Otherwise stepping to a single-currency month (where the toggle is
    // hidden) would draw an empty chart for a month that really did cost money.
    const currency: Currency = currencyChoice !== 'auto' && periodTotals[currencyChoice] > 0
        ? currencyChoice
        : autoCurrency;
    const bothCurrencies = periodTotals.USD > 0 && periodTotals.IRT > 0;

    /** One stacked column per day of the month, in the active currency. */
    const series = useMemo(() => {
        return axisDays.map((day) => {
            const byModel = new Map<string, number>();
            let total = 0;
            let tokens = 0;
            for (const cell of dayCells.get(day)?.cells ?? []) {
                if (modelFilter !== 'all' && cell.model !== modelFilter) continue;
                if (hostFilter !== 'all' && cell.host !== hostFilter) continue;
                tokens += totalTokens(cell);
                const value = chartMetric === 'tokens' ? totalTokens(cell) : currency === 'IRT' ? cell.IRT : cell.USD;
                if (value <= 0) continue;
                byModel.set(cell.model, (byModel.get(cell.model) ?? 0) + value);
                total += value;
            }
            return { day, byModel, total, tokens };
        });
    }, [axisDays, dayCells, modelFilter, hostFilter, currency, chartMetric]);

    const max = useMemo(() => niceMax(Math.max(0, ...series.map((d) => d.total))), [series]);

    /** Model ids of the visible period, busiest first, with their totals. */
    const legend = useMemo(() => {
        const totals = new Map<string, number>();
        for (const day of series) {
            for (const [model, value] of day.byModel) totals.set(model, (totals.get(model) ?? 0) + value);
        }
        return [...totals.entries()].sort((a, b) => b[1] - a[1]);
    }, [series]);

    const colorFor = (model: string) => MODEL_COLORS[Math.max(0, allModels.indexOf(model)) % MODEL_COLORS.length];

    const active = activeDay ? series.find((d) => d.day === activeDay) ?? null : null;
    const axisTicks = Array.from({ length: GRID_LINES + 1 }, (_, i) => (max * i) / GRID_LINES).reverse();
    const displayedModels = chartMetric === 'cost' ? [...periodModels].sort((a, b) => b[1][currency] - a[1][currency]) : periodModels;
    const chartValue = (value: number) => chartMetric === 'tokens' ? formatTokens(value) : formatCost({ amount: value, currency }) ?? '-';
    const chartCaption = (value: number) => chartMetric === 'tokens'
        ? new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
        : currency === 'USD' ? chartValue(value).replace(/(\.\d{2})0$/, '$1') : formatAxis(value, currency, max / GRID_LINES);

    const summary = view === 'plan' ? plan?.totals : state ? periodTotals : undefined;
    const summaryTotal = summary ? totalTokens(summary) : 0;
    const shares = summary ? [
        { key: 'usageInput' as const, value: uncachedInput(summary.input, summary.cached), className: 'input' },
        { key: 'usageCached' as const, value: Math.min(summary.input, summary.cached), className: 'cached' },
        { key: 'usageOutput' as const, value: summary.output, className: 'output' },
    ] : [];
    return <div className={`settings-page usage-page usage-dashboard${view === 'cost' ? ' cost-view' : ''}`}>
        <header className="settings-head"><button type="button" className="ghost-btn small" onClick={onBack} aria-label={t('credBack')}>{locale === 'fa' ? <ArrowRight size={14} /> : <ArrowLeft size={14} />}</button><h2>{t('usagePageTitle')}</h2><div className="usage-header-actions">{onRefresh && <button type="button" className="icon-btn" aria-label={t('usageRefresh')} title={t('usageRefresh')} onClick={onRefresh}><RefreshCw size={15} /></button>}</div></header>
        <div className="settings-scroll"><div className="usage-dashboard-content">
            <div className="usage-view-tabs" role="group" aria-label={t('usageView')}>
                {(['tokens', 'cost', ...(showPlan ? ['plan'] as const : [])] as const).map(choice => <button type="button" key={choice} className={view === choice ? 'active' : ''} aria-pressed={view === choice} onClick={() => { setViewChoice(choice); setActiveDay(null); setActiveModel(null); }}><span>{t(choice === 'tokens' ? 'usageTokens' : choice === 'cost' ? 'usageCost' : 'usageSubscription')}</span></button>)}
            </div>
            {!state && <p className="usage-loading" role="status">{t('working')}</p>}
            {view === 'plan' ? <div className="usage-plan-heading"><div><h3>{t('usageSubscription')}</h3><span>{t('usageLocalPeriod')}</span></div><a className="usage-manage" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer"><span>{t('usageManage')}</span><ExternalLink size={13} /></a></div> : <div className="usage-filter-toolbar">
                        <div className="cost-toolbar">
                            <div className="cost-granularity" role="group" aria-label={t('costGranularity')}>
                                <button
                                    type="button"
                                    className={`usage-range${granularity === 'week' ? ' active' : ''}`}
                                    aria-pressed={granularity === 'week'}
                                    onClick={() => { setGranularity('week'); setGroupIdx(-1); setActiveDay(null); }}
                                >
                                    {t('costGranularityWeek')}
                                </button>
                                <button
                                    type="button"
                                    className={`usage-range${granularity === 'month' ? ' active' : ''}`}
                                    aria-pressed={granularity === 'month'}
                                    onClick={() => { setGranularity('month'); setGroupIdx(-1); setActiveDay(null); }}
                                >
                                    {t('costGranularityMonth')}
                                </button>
                            </div>
                            <div className="cost-period">
                                <button
                                    type="button"
                                    className="icon-btn"
                                    aria-label={granularity === 'week' ? t('costPrevWeek') : t('costPrevMonth')}
                                    title={granularity === 'week' ? t('costPrevWeek') : t('costPrevMonth')}
                                    disabled={idx <= 0}
                                    onClick={() => setGroupIdx(Math.max(0, idx - 1))}
                                >
                                    {getLocale() === 'fa' ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
                                </button>
                                <span className="cost-period-label">{axis?.label ?? '-'}</span>
                                <button
                                    type="button"
                                    className="icon-btn"
                                    aria-label={granularity === 'week' ? t('costNextWeek') : t('costNextMonth')}
                                    title={granularity === 'week' ? t('costNextWeek') : t('costNextMonth')}
                                    disabled={idx < 0 || idx >= axisGroups.length - 1}
                                    onClick={() => setGroupIdx(Math.min(axisGroups.length - 1, idx + 1))}
                                >
                                    {getLocale() === 'fa' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                                </button>
                            </div>
                        </div>
                <div className="cost-filters"><Dropdown label={t('costAllModels')} value={modelFilter} options={[{ value: 'all', label: t('costAllModels') }, ...allModels.map(model => ({ value: model, label: model }))]} onChange={value => { setModelFilter(value); setActiveDay(null); }} /><Dropdown label={t('costAllProviders')} value={hostFilter} options={[{ value: 'all', label: t('costAllProviders') }, ...providers.map(provider => ({ value: provider.host, label: provider.label }))]} onChange={value => { setHostFilter(value); setActiveDay(null); }} />{hasFilters && <button type="button" className="usage-clear-filters" onClick={clearFilters}>{t('usageClearFilters')}</button>}</div>
            </div>}
            <section className={`usage-summary${view === 'plan' ? ' usage-plan-summary' : ''}`} aria-label={t(view === 'cost' ? 'usageRecordedCost' : 'usageRecordedTokens')}>
                <div className="usage-summary-main"><span>{t(view === 'cost' ? 'usageRecordedCost' : 'usageRecordedTokens')}</span>{view === 'cost' ? <div className="usage-summary-cost"><strong dir="ltr">{state && periodTotals[currency] > 0 ? formatCost({ amount: periodTotals[currency], currency }) : '—'}</strong>{bothCurrencies && <span dir="ltr">{formatCost({ amount: periodTotals[currency === 'USD' ? 'IRT' : 'USD'], currency: currency === 'USD' ? 'IRT' : 'USD' })}</span>}</div> : <strong dir="ltr">{summary ? formatTokens(summaryTotal) : '—'}</strong>}</div>
                <div className="usage-token-breakdown">{shares.map(share => <div key={share.key}><span><i className={share.className} />{t(share.key)}</span><strong className={`usage-${share.className}-total`} dir="ltr">{formatTokens(share.value)}</strong></div>)}</div>
                {summaryTotal > 0 && <div className="usage-token-share" role="img" aria-label={shares.map(share => `${t(share.key)}: ${formatTokens(share.value)}`).join(', ')}>{shares.filter(share => share.value > 0).map(share => <span key={share.key} className={share.className} style={{ flexGrow: share.value }} title={`${t(share.key)}: ${formatTokens(share.value)}`} />)}</div>}
            </section>
            {view === 'plan' ? <section className="usage-subscription-detail">
                {accounts.map(account => <div className="usage-plan-account" key={account.credentialId}><span dir="auto">{account.accountLabel || t('credOAuthConnected')}</span>{account.active && <span className="usage-account-active">{t('credActive')}</span>}</div>)}
                <h3>{t('usageByModel')}</h3><div className="usage-model-list">{plan?.models.map(({ model, tokens }) => <div className="usage-model-row" key={model}><div className="usage-model-name"><strong dir="ltr">{model}</strong><span className="usage-model-track" aria-hidden="true"><span style={{ inlineSize: `${Math.min(100, tokens / Math.max(1, summaryTotal) * 100)}%` }} /></span></div><span className="usage-model-tokens" dir="ltr">{formatTokens(tokens)}</span><span className="usage-model-percent" dir="ltr">{new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US', { style: 'percent', maximumFractionDigits: 0 }).format(tokens / Math.max(1, summaryTotal))}</span></div>)}{!plan?.models.length && <p className="usage-empty">{t('usageEmpty')}</p>}</div><p className="usage-quota-note">{t('usageChatGptHint')}</p>
            </section> : <>
                <section className="usage-activity-chart"><header><h3>{t(chartMetric === 'tokens' ? 'usageTokensOverTime' : 'usageDailySpend')}</h3>{bothCurrencies && chartMetric === 'cost' && <div className="cost-currencies" role="group" aria-label={t('usageCost')}>{(['IRT', 'USD'] as const).map(value => <button type="button" key={value} className={`usage-range${currency === value ? ' active' : ''}`} aria-pressed={currency === value} onClick={() => setCurrencyChoice(value)}>{t(value === 'USD' ? 'costCurrencyUsd' : 'costCurrencyIrt')}</button>)}</div>}</header><div className="usage-chart-body">
                        {legend.length > 0 ? (
                            <>
                                <div className={`cost-chart ${granularity}`} dir="ltr">
                                    <div className="cost-axis" aria-hidden="true">
                                        {axisTicks.map((tick, i) => (
                                            <span key={i}>{chartMetric === 'tokens' ? new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(tick) : formatAxis(tick, currency, max / GRID_LINES)}</span>
                                        ))}
                                    </div>
                                    <div className="cost-plot">
                                        <div className="cost-grid" aria-hidden="true">
                                            {axisTicks.map((_, i) => <span key={i} />)}
                                        </div>
                                        <div className="cost-cols" role="group" aria-label={t(chartMetric === 'tokens' ? 'usageTokenChartAria' : 'costChartAria')}>
                                            {series.map((day) => {
                                                const label = `${formatCalendarDate(localDayTimestamp(day.day))} · ${chartValue(day.total)}`;
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
                                                        {granularity === 'week' && day.total > 0 && <span className="cost-col-total" aria-hidden="true" style={{ bottom: `calc(${(day.total / max) * 100}% + 6px)` }}>{chartCaption(day.total)}</span>}
                                                        <span className="cost-stack" aria-hidden="true">
                                                            {[...day.byModel.entries()].map(([model, value]) => (
                                                                <span
                                                                    key={model}
                                                                    className="cost-seg"
                                                                    style={{ height: `${(value / max) * 100}%`, background: colorFor(model) }}
                                                                    onMouseEnter={() => setActiveModel(model)}
                                                                    onMouseLeave={() => setActiveModel((cur) => (cur === model ? null : cur))}
                                                                />
                                                            ))}
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>

                                <div className="cost-dates" dir="ltr" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${axisDays.length}, minmax(0, 1fr))` }}>
                                    {axisDays.map((day, index) => granularity === 'week' || index === 0 || index === axisDays.length - 1 || index % Math.ceil((axisDays.length - 1) / 5) === 0
                                        ? <span key={day} title={formatCalendarDate(localDayTimestamp(day))} data-short={locale === 'fa' && granularity === 'week' ? new Intl.DateTimeFormat(calendarName(), { weekday: 'narrow' }).format(new Date(localDayTimestamp(day))) : undefined} style={{ gridColumn: index + 1 }}>{new Intl.DateTimeFormat(calendarName(), granularity === 'week' ? { weekday: 'short' } : { day: 'numeric' }).format(new Date(localDayTimestamp(day)))}</span> : null)}
                                </div>

                                <div className="cost-legend">
                                    {legend.map(([model, value]) => (
                                        <span className="cost-legend-item" key={model}>
                                            <span className="cost-swatch" style={{ background: colorFor(model) }} aria-hidden="true" />
                                            <span dir="ltr">{model}</span>
                                            <span className="cost-legend-cost" dir="ltr">{chartValue(value)}</span>
                                        </span>
                                    ))}
                                </div>

                                {/* Hover detail in flow (no box, no extra rule). A
                                    single segment under the cursor narrows the
                                    line to that model instead of the whole day. */}
                                <p className="cost-detail" role="status">
                                    {active ? (() => {
                                        const hovered = activeModel != null ? active.byModel.get(activeModel) : undefined;
                                        return (
                                            <>
                                                <strong>{formatCalendarDate(localDayTimestamp(active.day))}</strong>
                                                {hovered != null && activeModel != null ? (
                                                    <>
                                                        <span>
                                                            <i style={{ background: colorFor(activeModel) }} aria-hidden="true" />
                                                            <span dir="ltr">{activeModel}</span>
                                                        </span>
                                                        <span dir="ltr">{chartValue(hovered)}</span>
                                                    </>
                                                ) : (
                                                    <span dir="ltr">{chartValue(active.total)}</span>
                                                )}
                                            </>
                                        );
                                    })() : <><strong>{t('usageSelectedPeriod')}</strong><span dir="ltr">{chartValue(series.reduce((sum, day) => sum + day.total, 0))}</span></>}
                                </p>
                            </>
                        ) : (
                            <div className="usage-chart-empty">
                                <p className="usage-empty">{t(periodTotals.tokens > 0 ? 'usageNoRecordedCost' : history.length > 0 ? chartMetric === 'tokens' ? 'usageNoPeriodData' : 'costNoData' : 'usageEmpty')}</p>
                                {periodTotals.tokens > 0 && chartMetric === 'cost' && <button type="button" className="settings-ghost-action" onClick={() => setChartMetric('tokens')}>{t('usageViewTokens')}</button>}
                                {hasFilters && <button type="button" className="settings-ghost-action" onClick={clearFilters}>{t('usageClearFilters')}</button>}
                            </div>
                        )}
                </div></section>
                <section className="usage-breakdown"><header><div className="usage-breakdown-tabs" role="group" aria-label={t('usageBreakdown')}>{(['models', 'providers'] as const).map(value => <button type="button" key={value} className={breakdown === value ? 'active' : ''} aria-pressed={breakdown === value} onClick={() => setBreakdown(value)}>{t(value === 'models' ? 'usageByModel' : 'usageByProvider')}</button>)}</div><span>{t(chartMetric === 'cost' ? 'usageCost' : 'usageTokens')}</span></header>
                    {breakdown === 'models' ? <div className="usage-model-list">{displayedModels.map(([model, totals]) => <div className="usage-model-row" key={model}><div className="usage-model-name"><button type="button" dir="ltr" onClick={() => setModelFilter(modelFilter === model ? 'all' : model)} title={t('usageFilterModel')}><i style={{ background: colorFor(model) }} /><strong>{model}</strong></button><span className="usage-model-track" aria-hidden="true"><span style={{ inlineSize: `${Math.min(100, (chartMetric === 'cost' ? totals[currency] / Math.max(Number.EPSILON, periodTotals[currency]) : totalTokens(totals) / Math.max(1, periodTotals.tokens)) * 100)}%`, background: colorFor(model) }} /></span></div><span className="usage-model-tokens" dir="ltr">{formatTokens(totalTokens(totals))}</span><span className="usage-model-cost"><UsageAmounts totals={totals} /></span></div>)}{!periodModels.length && <p className="usage-empty">{t(hasFilters ? 'usageNoProviders' : 'usageEmpty')}</p>}</div> : <div className="usage-provider-list">{periodProviders.map(provider => <div className="usage-model-row prov-row" key={provider.host}><div className="usage-model-name"><strong dir="auto">{provider.label}{provider.iranian && <span className="pricing-badge">{t('pricingIranianBadge')}</span>}</strong><span className="prov-host" dir="ltr">{provider.host}</span></div><span className="usage-model-tokens" dir="ltr">{formatTokens(totalTokens(provider))}</span><span className="usage-model-cost"><UsageAmounts totals={provider} /></span></div>)}{!periodProviders.length && <p className="usage-empty">{t('usageNoProviders')}</p>}</div>}
                </section>
                {allTime && <section className="usage-lifetime" aria-label={t('usageAllTime')}><span>{t('usageAllTime')}</span><span><bdi dir="ltr">{formatTokens(totalTokens(allTime))}</bdi> {t('usageTokens')}</span><UsageAmounts totals={allTime} /></section>}
                <details className="settings-card rate-disclosure"><summary><span><Tag size={13} aria-hidden="true" /><strong>{t('miniPricing')}</strong></span><ChevronDown size={12}/></summary>
                    <div className="settings-section-head">
                        <div className="settings-section-icon" aria-hidden="true">
                            <Tag size={15} />
                        </div>
                        <div>
                            <h3>{t('ratesTitle')}</h3>
                        </div>
                    </div>

                    <div className="settings-card-body">
                        {rates.length > 0 ? rates.map((rate) => (
                            <RateRow
                                key={`${rate.id}@${rate.host}`}
                                rate={rate}
                                showHost={multiHostIds.has(rate.id)}
                                onSaveModel={onSaveModel}
                                onRemoveModel={onRemoveModel}
                            />
                        )) : (
                            <p className="usage-empty">{t('ratesEmpty')}</p>
                        )}

                        {adding ? (
                            <AddModelForm onSave={onSaveModel} onCancel={() => setAdding(false)} />
                        ) : (
                            <button type="button" className="rates-add-toggle" onClick={() => setAdding(true)}>
                                <Plus size={12} aria-hidden="true" />
                                <span>{t('ratesAddToggle')}</span>
                            </button>
                        )}
                    </div>
                </details>
            </>}
        </div></div>
    </div>;
}
