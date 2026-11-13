import type { CSSProperties } from 'react';

export interface AppearancePrefs {
    scheme: 'editor' | 'dark';
    accent: 'teal' | 'blue' | 'violet' | 'amber' | 'rose' | 'neutral' | 'white' | 'graphite';
    font: 'interface' | 'editor';
    interfaceSize: 12 | 14 | 16 | 18;
    textSize: 12 | 14 | 16 | 18;
    codeSize: 12 | 13.5 | 14 | 16;
    width: 'compact' | 'standard' | 'wide';
    density: 'comfortable' | 'compact';
    motion: 'system' | 'reduced';
}

export const DEFAULT_APPEARANCE: AppearancePrefs = {
    scheme: 'editor', accent: 'teal',
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

/** Persisted webview state is untrusted; only closed choices become CSS. */
export function readAppearance(value: unknown): AppearancePrefs {
    const saved = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<AppearancePrefs> : {};
    return {
        scheme: saved.scheme === 'dark' ? 'dark' : 'editor',
        accent: typeof saved.accent === 'string' && Object.prototype.hasOwnProperty.call(ACCENTS, saved.accent) ? saved.accent : 'teal',
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
    const accent = ACCENTS[prefs.accent];
    return {
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
