import type { CSSProperties } from 'react';

export interface AppearancePrefs {
    scheme: 'editor' | 'dark';
    accent: 'teal' | 'blue' | 'violet' | 'amber' | 'rose' | 'neutral' | 'white' | 'graphite' | 'custom';
    customAccent: string;
    saturation: number;
    darkContrast: number;
    lightContrast: number;
    font: 'interface' | 'editor';
    interfaceSize: 12 | 14 | 16 | 18;
    textSize: 12 | 14 | 16 | 18;
    codeSize: 12 | 13.5 | 14 | 16;
    width: 'compact' | 'standard' | 'wide';
    density: 'comfortable' | 'compact';
    motion: 'system' | 'reduced';
}

export const DEFAULT_APPEARANCE: AppearancePrefs = {
    scheme: 'editor', accent: 'teal', customAccent: '#82dbc5', saturation: 100, darkContrast: 0, lightContrast: 0,
    font: 'interface', interfaceSize: 14, textSize: 14, codeSize: 13.5,
    width: 'standard', density: 'comfortable', motion: 'system',
};

export const ACCENTS = {
    teal: { dark: '#82dbc5', strong: '#9ce5d3', ink: '#082c24', light: '#007f70', label: 'appearanceTeal' },
    blue: { dark: '#93baff', strong: '#bad0ff', ink: '#10213d', light: '#285bce', label: 'appearanceBlue' },
    violet: { dark: '#bda7ff', strong: '#d4c4ff', ink: '#24153f', light: '#7444c4', label: 'appearanceViolet' },
    amber: { dark: '#e7bf72', strong: '#f5d598', ink: '#322305', light: '#945d00', label: 'appearanceAmber' },
    rose: { dark: '#f3a5bd', strong: '#ffc1d2', ink: '#3a1422', light: '#b53760', label: 'appearanceRose' },
    neutral: { dark: '#c4c9d2', strong: '#dce0e7', ink: '#20242b', light: '#5d6672', label: 'appearanceNeutral' },
    white: { dark: '#eeeeee', strong: '#ffffff', ink: '#171717', light: '#3f3f3f', label: 'appearanceWhite' },
    graphite: { dark: '#a0a0a0', strong: '#c2c2c2', ink: '#171717', light: '#626262', label: 'appearanceGraphite' },
} as const;

function bounded(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;
}

function rgb(hex: string): number[] { return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255); }
function hex(channels: number[]): string { return '#' + channels.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join(''); }
function luminance(color: string): number { const c = rgb(color).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; }
function contrast(a: string, b: string): number { const x = luminance(a), y = luminance(b); return (Math.max(x,y) + .05) / (Math.min(x,y) + .05); }
function mix(color: string, target: string, amount: number): string { const end = rgb(target); return hex(rgb(color).map((c,i) => c * (1 - amount) + end[i] * amount)); }
function readable(color: string, canvas: string, target: string): string {
    for (let step = 0; step <= 100; step++) {
        const candidate = mix(color, target, step / 100);
        if (contrast(candidate, canvas) >= 4.5) return candidate;
    }
    return target;
}
function saturate(color: string, percent: number): string {
    if (percent === 100) return color;
    const c = rgb(color), max = Math.max(...c), min = Math.min(...c), light = (max + min) / 2;
    if (max === min) return color;
    const delta = max - min;
    const saturation = Math.min(1, delta / (1 - Math.abs(2 * light - 1)) * percent / 100);
    let hue = max === c[0] ? (c[1] - c[2]) / delta : max === c[1] ? (c[2] - c[0]) / delta + 2 : (c[0] - c[1]) / delta + 4;
    hue = (hue / 6 + 1) % 1;
    const chroma = (1 - Math.abs(2 * light - 1)) * saturation, x = chroma * (1 - Math.abs(hue * 6 % 2 - 1)), m = light - chroma / 2;
    const channels = hue < 1/6 ? [chroma,x,0] : hue < 2/6 ? [x,chroma,0] : hue < 3/6 ? [0,chroma,x] : hue < 4/6 ? [0,x,chroma] : hue < 5/6 ? [x,0,chroma] : [chroma,0,x];
    return hex(channels.map(value => value + m));
}

/** Keep accent text and filled action labels readable, including custom colors. */
export function accentPalette(prefs: AppearancePrefs): { dark: string; strong: string; light: string; ink: string } {
    if (prefs.accent !== 'custom' && prefs.saturation === 100) return ACCENTS[prefs.accent];
    const source = prefs.accent === 'custom' ? prefs.customAccent : ACCENTS[prefs.accent].dark;
    const dark = readable(saturate(source, prefs.saturation), '#181818', '#ffffff');
    const light = readable(saturate(prefs.accent === 'custom' ? source : ACCENTS[prefs.accent].light, prefs.saturation), '#ffffff', '#000000');
    const ink = contrast(dark, '#111111') >= contrast(dark, '#ffffff') ? '#111111' : '#ffffff';
    const strong = readable(mix(dark, '#ffffff', .15), ink, ink === '#111111' ? '#ffffff' : '#000000');
    return { dark, strong, light, ink };
}

/** Persisted webview state is untrusted; only closed choices become CSS. */
export function readAppearance(value: unknown): AppearancePrefs {
    const saved = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<AppearancePrefs> : {};
    return {
        scheme: saved.scheme === 'dark' ? 'dark' : 'editor',
        accent: saved.accent === 'custom' || typeof saved.accent === 'string' && Object.prototype.hasOwnProperty.call(ACCENTS, saved.accent) ? saved.accent : 'teal',
        customAccent: typeof saved.customAccent === 'string' && /^#[0-9a-f]{6}$/i.test(saved.customAccent) ? saved.customAccent.toLowerCase() : DEFAULT_APPEARANCE.customAccent,
        saturation: bounded(saved.saturation, 0, 150, 100),
        darkContrast: bounded(saved.darkContrast, 0, 100, 0),
        lightContrast: bounded(saved.lightContrast, 0, 100, 0),
        font: saved.font === 'editor' ? 'editor' : 'interface',
        interfaceSize: saved.interfaceSize === 12 || saved.interfaceSize === 16 || saved.interfaceSize === 18 ? saved.interfaceSize : 14,
        textSize: saved.textSize === 12 || saved.textSize === 16 || saved.textSize === 18 ? saved.textSize : 14,
        codeSize: saved.codeSize === 12 || saved.codeSize === 14 || saved.codeSize === 16 ? saved.codeSize : 13.5,
        width: saved.width === 'compact' || saved.width === 'wide' ? saved.width : 'standard',
        density: saved.density === 'compact' ? 'compact' : 'comfortable',
        motion: saved.motion === 'reduced' ? 'reduced' : 'system',
    };
}

export function appearanceStyle(prefs: AppearancePrefs, themeOnly = false): CSSProperties {
    const accent = accentPalette(prefs);
    return {
        '--appearance-dark-contrast': `${prefs.darkContrast}%`,
        '--appearance-light-contrast': `${prefs.lightContrast}%`,
        '--interface-size': `${prefs.interfaceSize}px`,
        '--xratu-fs-base': `${prefs.interfaceSize}px`,
        '--xratu-fs-md': `${prefs.interfaceSize}px`,
        '--xratu-fs-sm': `${Math.max(11, prefs.interfaceSize - 1)}px`,
        '--xratu-fs-xs': `${Math.max(10, prefs.interfaceSize - 2)}px`,
        '--xratu-fs-lg': `${prefs.interfaceSize + 2}px`,
        '--appearance-accent-dark': accent.dark,
        '--appearance-accent-strong': accent.strong,
        '--appearance-accent-ink': accent.ink,
        '--appearance-accent-light': accent.light,
        '--xratu-font-ui': prefs.font === 'editor' ? 'var(--vscode-editor-font-family, monospace), \"Xratu UI\"' : undefined,
        ...(!themeOnly ? {
        '--xratu-fs-prose': `${prefs.textSize}px`,
        '--xratu-fs-code': `${prefs.codeSize}px`,
        '--conversation-width': `${{ compact: 560, standard: 700, wide: 900 }[prefs.width]}px`,
        '--conversation-font': prefs.font === 'editor' ? 'var(--vscode-editor-font-family, monospace), Vazirmatn' : 'var(--xratu-font-ui)',
        } : {}),
    } as CSSProperties;
}
