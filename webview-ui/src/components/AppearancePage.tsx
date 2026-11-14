import { Check, Plus, RotateCcw } from 'lucide-react';
import { useRef } from 'react';
import { getLocale, t } from '../i18n';
import { ACCENTS, appearanceStyle, DEFAULT_APPEARANCE, type AppearancePrefs } from '../appearance';
import { Dropdown } from './Dropdown';

export function AppearancePage({ onTheme, prefs, onChange }: { onTheme: () => void; prefs: AppearancePrefs; onChange: (prefs: AppearancePrefs) => void }) {
    const set = <K extends keyof AppearancePrefs>(key: K, value: AppearancePrefs[K]) => onChange({ ...prefs, [key]: value });
    const numberOptions = (values: number[]) => values.map(value => ({ value: String(value), label: `${value} px` }));
    const customColor = useRef<HTMLInputElement>(null);
    const accents = Object.entries(ACCENTS) as Array<[keyof typeof ACCENTS, typeof ACCENTS[keyof typeof ACCENTS]]>;
    const choices = [...accents.map(([value]) => value), 'custom'] as AppearancePrefs['accent'][];
    const slider = (key: 'saturation' | 'darkContrast' | 'lightContrast', label: Parameters<typeof t>[0], max: number) => <div className="settings-nav-row appearance-control"><label className="settings-nav-main" htmlFor={`appearance-${key}`}><strong>{t(label)}</strong></label><div className="appearance-range"><input id={`appearance-${key}`} type="range" min={0} max={max} step={1} value={prefs[key]} onChange={event => set(key, Number(event.target.value))} /><output dir="ltr" htmlFor={`appearance-${key}`}>{prefs[key]}%</output></div></div>;
    return <section className="settings-page preferences-page appearance-page">
        <header className="settings-head"><h2>{t('appearanceTitle')}</h2><button type="button" className="settings-ghost-action appearance-reset" disabled={Object.keys(DEFAULT_APPEARANCE).every(key => prefs[key as keyof AppearancePrefs] === DEFAULT_APPEARANCE[key as keyof AppearancePrefs])} onClick={() => onChange({ ...DEFAULT_APPEARANCE })}><RotateCcw size={13} /><span>{t('appearanceReset')}</span></button></header>
        <div className="settings-scroll">
            <section className="settings-card preference-section"><div className="settings-section-head"><h3>{t('appearanceTheme')}</h3></div><div className="preference-group">
                <div className="settings-nav-row appearance-control"><label className="settings-nav-main" htmlFor="appearance-scheme"><strong>{t('appearanceScheme')}</strong></label><Dropdown id="appearance-scheme" label={t('appearanceScheme')} value={prefs.scheme} options={[{ value: 'editor', label: t('appearanceFollowEditor') }, { value: 'dark', label: t('appearanceDark') }]} onChange={value => set('scheme', value as AppearancePrefs['scheme'])} /></div>
                <div className="settings-nav-row appearance-control appearance-accent-row"><div className="settings-nav-main"><strong>{t('appearanceAccent')}</strong></div><div id="appearance-accent" className="appearance-accent-options" role="radiogroup" aria-label={t('appearanceAccent')} onKeyDown={event => {
                    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const index = choices.indexOf(prefs.accent);
                    const forward = event.key === 'ArrowDown' || event.key === (getLocale() === 'fa' ? 'ArrowLeft' : 'ArrowRight');
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (forward ? 1 : -1) + choices.length) % choices.length;
                    set('accent', choices[next]);
                    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
                }}>{accents.map(([value, accent]) => <button key={value} type="button" className="appearance-swatch" role="radio" aria-checked={prefs.accent === value} aria-label={t(accent.label)} title={t(accent.label)} tabIndex={prefs.accent === value ? 0 : -1} style={{ backgroundColor: accent.dark, color: accent.ink }} onClick={() => set('accent', value)}>{prefs.accent === value && <Check size={13} aria-hidden="true" />}</button>)}<button type="button" className="appearance-swatch appearance-custom-swatch" role="radio" aria-checked={prefs.accent === 'custom'} aria-label={t('appearanceCustomAccent')} title={t('appearanceCustomAccent')} tabIndex={prefs.accent === 'custom' ? 0 : -1} onClick={() => { set('accent', 'custom'); customColor.current?.click(); }}><Plus size={13} aria-hidden="true" /></button><input ref={customColor} tabIndex={-1} type="color" className="appearance-color-input" aria-label={t('appearanceCustomColor')} value={prefs.customAccent} onChange={event => onChange({ ...prefs, accent:'custom', customAccent:event.target.value })} /></div></div>
                {slider('saturation', 'appearanceSaturation', 150)}
                {slider('darkContrast', 'appearanceDarkContrast', 100)}
                {slider('lightContrast', 'appearanceLightContrast', 100)}
                {prefs.scheme === 'editor' && <div className="settings-nav-row appearance-theme"><span className="settings-nav-main"><strong>{t('appearanceEditorTheme')}</strong></span><button type="button" className="settings-ghost-action" onClick={onTheme}>{t('appearanceChooseTheme')}</button></div>}
            </div></section>
            <section className="settings-card preference-section"><div className="settings-section-head"><h3>{t('appearanceTypography')}</h3></div><div className="preference-group appearance-controls">
                <div className="settings-nav-row appearance-control"><label className="settings-nav-main" htmlFor="appearance-font"><strong>{t('appearanceFont')}</strong></label><Dropdown id="appearance-font" label={t('appearanceFont')} value={prefs.font} options={[{ value: 'interface', label: t('appearanceInterfaceFont') }, { value: 'editor', label: t('appearanceEditorFont') }]} onChange={value => set('font', value as AppearancePrefs['font'])} /></div>
                <div className="settings-nav-row appearance-control"><label className="settings-nav-main" htmlFor="appearance-interface-size"><strong>{t('appearanceInterfaceSize')}</strong></label><Dropdown id="appearance-interface-size" label={t('appearanceInterfaceSize')} value={String(prefs.interfaceSize)} options={numberOptions([12, 14, 16, 18])} onChange={value => set('interfaceSize', Number(value) as AppearancePrefs['interfaceSize'])} /></div>
                <div className="settings-nav-row appearance-control"><label className="settings-nav-main" htmlFor="appearance-text-size"><strong>{t('appearanceTextSize')}</strong></label><Dropdown id="appearance-text-size" label={t('appearanceTextSize')} value={String(prefs.textSize)} options={numberOptions([12, 14, 16, 18])} onChange={value => set('textSize', Number(value) as AppearancePrefs['textSize'])} /></div>
                <div className="settings-nav-row appearance-control"><label className="settings-nav-main" htmlFor="appearance-code-size"><strong>{t('appearanceCodeSize')}</strong></label><Dropdown id="appearance-code-size" label={t('appearanceCodeSize')} value={String(prefs.codeSize)} options={numberOptions([12, 13.5, 14, 16])} onChange={value => set('codeSize', Number(value) as AppearancePrefs['codeSize'])} /></div>
            </div></section>
            <section className="settings-card preference-section"><div className="settings-section-head"><h3>{t('appearanceLayout')}</h3></div><div className="preference-group appearance-controls">
                <div className="settings-nav-row appearance-control"><label className="settings-nav-main" htmlFor="appearance-width"><strong>{t('appearanceWidth')}</strong></label><Dropdown id="appearance-width" label={t('appearanceWidth')} value={prefs.width} options={[{ value: 'compact', label: t('appearanceNarrow') }, { value: 'standard', label: t('appearanceStandard') }, { value: 'wide', label: t('appearanceWide') }]} onChange={value => set('width', value as AppearancePrefs['width'])} /></div>
                <div className="settings-nav-row appearance-control"><label className="settings-nav-main" htmlFor="appearance-density"><strong>{t('appearanceDensity')}</strong></label><Dropdown id="appearance-density" label={t('appearanceDensity')} value={prefs.density} options={[{ value: 'comfortable', label: t('appearanceComfortable') }, { value: 'compact', label: t('appearanceCompact') }]} onChange={value => set('density', value as AppearancePrefs['density'])} /></div>
                <div className="settings-nav-row appearance-control"><label className="settings-nav-main" htmlFor="appearance-motion"><strong>{t('appearanceMotion')}</strong></label><Dropdown id="appearance-motion" label={t('appearanceMotion')} value={prefs.motion} options={[{ value: 'system', label: t('appearanceSystemMotion') }, { value: 'reduced', label: t('appearanceReducedMotion') }]} onChange={value => set('motion', value as AppearancePrefs['motion'])} /></div>
            </div></section>
            <section className="settings-card preference-section appearance-preview-section"><div className="settings-section-head"><h3>{t('appearancePreview')}</h3></div><div className={`appearance-preview ${prefs.density}`} style={appearanceStyle(prefs)}>
                <div className="appearance-preview-user" dir="auto">{t('appearancePreviewPrompt')}</div>
                <div className="appearance-preview-reply" dir="auto">{t('appearancePreviewReply')}</div>
                <pre dir="ltr"><code><span>const</span> project = <span>'xratu'</span>;</code></pre>
            </div></section>
        </div>
    </section>;
}
