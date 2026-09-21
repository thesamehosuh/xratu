import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    Activity,
    ArrowLeft,
    ArrowRight,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Coins,
    Info,
    Pencil,
    Plus,
    Tag,
} from 'lucide-react';
import { getLocale, t } from '../i18n';
import { formatCost } from '../cost';
import { formatCalendarDate, localDayTimestamp, shiftLocalDay } from '../datetime';
import type { LedgerDay, ModelRateView, ProviderUsageView, UsageTotals } from '../types';

type Currency = 'USD' | 'IRT';

interface UsageState {
    providers: ProviderUsageView[];
    rates: ModelRateView[];
    history: LedgerDay[];
    allTime: UsageTotals;
}

interface UsagePageProps {
    state: UsageState | null;
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
        if (value <= 0) return '۰';
        return new Intl.NumberFormat('fa-IR', {
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

/** Usage cost in the currency it was actually billed in (Toman wins when both
 *  ledgers have entries: it is the one a local user reads). */
function usageCost(cost: { USD: number; IRT: number }): string {
    if (cost.IRT > 0) return formatCost({ amount: cost.IRT, currency: 'IRT' }) ?? '-';
    if (cost.USD > 0) return formatCost({ amount: cost.USD, currency: 'USD' }) ?? '-';
    return '-';
}

const RATE_SOURCE_LABEL = {
    override: 'rateSourceOverride',
    provider: 'rateSourceProvider',
    gateway: 'rateSourceGateway',
    builtin: 'rateSourceBuiltin',
    unknown: 'rateSourceUnknown',
} as const;

/** Room for a popup anchored to `el`, bounded by the clipping ancestors (a
 *  card hides its overflow) and the viewport. A popup must fit, flip, or
 *  shrink - never be cut in half. */
function popupSpace(el: HTMLElement): { above: number; below: number } {
    const rect = el.getBoundingClientRect();
    const clip = el.closest('.settings-card')?.getBoundingClientRect();
    const scroll = el.closest('.settings-scroll')?.getBoundingClientRect();
    const top = Math.max(clip?.top ?? 0, scroll?.top ?? 0, 0);
    const bottom = Math.min(
        clip?.bottom ?? window.innerHeight,
        scroll?.bottom ?? window.innerHeight,
        window.innerHeight,
    );
    return {
        above: Math.max(0, rect.top - 4 - top),
        below: Math.max(0, bottom - (rect.bottom + 4)),
    };
}

/** Below/above the anchor, whichever has more room, plus the height cap that
 *  keeps the popup inside the card. A pathologically tight card falls back to
 *  the full height rather than a one-row sliver. */
function popupPlacement(el: HTMLElement, maxHeight: number): { up: boolean; cap: number | undefined } {
    const { above, below } = popupSpace(el);
    const up = above > below;
    const space = up ? above : below;
    return { up, cap: space < 64 ? undefined : Math.min(maxHeight, space) };
}

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
                    <span className="usage-cost" dir="ltr">{usageCost(rate)}</span>
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

/**
 * The page's dropdown. A native <select> cannot match the UI: its popup list
 * is drawn by the OS (light on dark hosts, unstyleable) and it paints the
 * focus ring on plain mouse clicks. This is the app's own trigger + listbox
 * with the usual tokens, RTL-safe placement and keyboard handling.
 */
function Dropdown({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
}) {
    const [open, setOpen] = useState(false);
    /** Cards clip their overflow: flip and shrink the list to fit inside. */
    const [placement, setPlacement] = useState<{ up: boolean; cap: number | undefined }>({ up: false, cap: undefined });
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const current = options.find((o) => o.value === value) ?? options[0];

    useLayoutEffect(() => {
        if (!open || !triggerRef.current) return;
        setPlacement(popupPlacement(triggerRef.current, 190));
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [open]);

    // Opening lands focus on the current option, so arrows and Enter work.
    useEffect(() => {
        if (!open) return;
        const items = listRef.current?.querySelectorAll<HTMLElement>('.dropdown-option');
        if (!items?.length) return;
        const selected = [...items].find((el) => el.getAttribute('aria-selected') === 'true');
        (selected ?? items[0]).focus();
    }, [open]);

    const focusOption = (index: number) => {
        const items = listRef.current?.querySelectorAll<HTMLElement>('.dropdown-option');
        if (!items?.length) return;
        items[Math.min(items.length - 1, Math.max(0, index))]?.focus();
    };

    const step = (delta: 1 | -1) => {
        const items = [...(listRef.current?.querySelectorAll<HTMLElement>('.dropdown-option') ?? [])];
        focusOption(items.indexOf(document.activeElement as HTMLElement) + delta);
    };

    const pick = (next: string) => {
        onChange(next);
        setOpen(false);
        triggerRef.current?.focus();
    };

    return (
        <div className="dropdown" ref={rootRef}>
            <button
                ref={triggerRef}
                type="button"
                className="dropdown-trigger"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={label}
                onClick={() => setOpen((wasOpen) => !wasOpen)}
                onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        setOpen(true);
                    }
                }}
            >
                <span className="dropdown-value" dir="auto">{current?.label ?? ''}</span>
                <ChevronDown size={12} className="dropdown-caret" aria-hidden="true" />
            </button>
            {open && (
                <div
                    ref={listRef}
                    className={`dropdown-list${placement.up ? ' up' : ''}`}
                    role="listbox"
                    aria-label={label}
                    style={placement.cap != null ? { maxHeight: `${placement.cap}px` } : undefined}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            setOpen(false);
                            triggerRef.current?.focus();
                        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                            e.preventDefault();
                            step(e.key === 'ArrowDown' ? 1 : -1);
                        } else if (e.key === 'Home' || e.key === 'End') {
                            e.preventDefault();
                            focusOption(e.key === 'Home' ? 0 : Number.MAX_SAFE_INTEGER);
                        } else if (e.key === 'Tab') {
                            setOpen(false);
                        }
                    }}
                >
                    {options.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            role="option"
                            className="dropdown-option"
                            aria-selected={option.value === value}
                            onClick={() => pick(option.value)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
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
                    {t('pricingAddModel')}
                </button>
            </div>
        </div>
    );
}

export function UsagePage({ state, onBack, onSaveModel, onRemoveModel }: UsagePageProps) {
    const locale = getLocale();
    const history = state?.history ?? [];
    const providers = state?.providers ?? [];
    const rates = state?.rates ?? [];
    const allTime = state?.allTime;
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

    const axisDays = useMemo(() => axis?.days ?? [], [axis]);

    /** Cells of the selected month that pass the model/provider filters. */
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
        return axisDays.map((day) => {
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
    }, [axisDays, dayCells, modelFilter, hostFilter, currency]);

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

    return (
        <div className="settings-page usage-page">
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
                    <h2>{t('usagePageTitle')}</h2>
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

                        <div className="cost-filters">
                            <Dropdown
                                label={t('costAllModels')}
                                value={modelFilter}
                                options={[
                                    { value: 'all', label: t('costAllModels') },
                                    ...allModels.map((model) => ({ value: model, label: model })),
                                ]}
                                onChange={(next) => { setModelFilter(next); setActiveDay(null); }}
                            />
                            <Dropdown
                                label={t('costAllProviders')}
                                value={hostFilter}
                                options={[
                                    { value: 'all', label: t('costAllProviders') },
                                    ...providers.map((p) => ({ value: p.host, label: p.label })),
                                ]}
                                onChange={(next) => { setHostFilter(next); setActiveDay(null); }}
                            />
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
                                            <span key={i}>{formatAxis(tick, currency, max / GRID_LINES)}</span>
                                        ))}
                                    </div>
                                    <div className="cost-plot">
                                        <div className="cost-grid" aria-hidden="true">
                                            {axisTicks.map((_, i) => <span key={i} />)}
                                        </div>
                                        <div className="cost-cols" role="group" aria-label={t('costChartAria')}>
                                            {series.map((day) => {
                                                const label = `${formatCalendarDate(localDayTimestamp(day.day))} · ${formatCost({ amount: day.total, currency }) ?? '-'}`;
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

                                <div className="cost-legend">
                                    {legend.map(([model, value]) => (
                                        <span className="cost-legend-item" key={model}>
                                            <span className="cost-swatch" style={{ background: colorFor(model) }} aria-hidden="true" />
                                            <span dir="ltr">{model}</span>
                                            <span className="cost-legend-cost" dir="ltr">{formatCost({ amount: value, currency }) ?? '-'}</span>
                                        </span>
                                    ))}
                                </div>

                                {/* Hover detail in flow (no box, no extra rule). A
                                    single segment under the cursor narrows the
                                    line to that model instead of the whole day. */}
                                <p className="cost-detail" role="status">
                                    {active && (() => {
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
                                                        <span dir="ltr">{formatCost({ amount: hovered, currency }) ?? '-'}</span>
                                                    </>
                                                ) : (
                                                    <span dir="ltr">{formatCost({ amount: active.total, currency }) ?? '-'}</span>
                                                )}
                                            </>
                                        );
                                    })()}
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
                        {providers.length > 0 ? providers.map((p) => {
                            const tokens = p.input + p.output + p.cached;
                            const share = (value: number) => `${tokens > 0 ? (value / tokens) * 100 : 0}%`;
                            return (
                                <div className="prov-row" key={p.host}>
                                    <div className="prov-head">
                                        <span className="prov-name">
                                            <strong dir="auto">{p.label}</strong>
                                            {p.iranian && <span className="pricing-badge">{t('pricingIranianBadge')}</span>}
                                            <span className="prov-host" dir="ltr">{p.host}</span>
                                        </span>
                                        <span className="usage-cost" dir="ltr">{usageCost(p)}</span>
                                    </div>
                                    {tokens > 0 && (
                                        <span className="prov-bar" dir="ltr" aria-hidden="true">
                                            {p.input > 0 && <span className="in" style={{ width: share(p.input) }} />}
                                            {p.output > 0 && <span className="out" style={{ width: share(p.output) }} />}
                                            {p.cached > 0 && <span className="cached" style={{ width: share(p.cached) }} />}
                                        </span>
                                    )}
                                    <span className="prov-stats" dir="ltr">
                                        <span><i className="in" aria-hidden="true" />{t('usageInput')} <b>{formatTokens(p.input)}</b></span>
                                        <span><i className="out" aria-hidden="true" />{t('usageOutput')} <b>{formatTokens(p.output)}</b></span>
                                        {p.cached > 0 && <span><i className="cached" aria-hidden="true" />{t('usageCached')} <b>{formatTokens(p.cached)}</b></span>}
                                    </span>
                                </div>
                            );
                        }) : (
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
                            <h3>{t('ratesTitle')}</h3>
                            <p>{t('ratesDesc')}</p>
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
                                {t('ratesAddToggle')}
                            </button>
                        )}
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
