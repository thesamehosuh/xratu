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

function bounded(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;
}

export function readAppearance(value: unknown): AppearancePrefs {
    const saved = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<AppearancePrefs> : {};
    return {
        scheme: saved.scheme === 'dark' ? 'dark' : 'editor',
        accent: saved.accent === 'custom' || typeof saved.accent === 'string' && ['teal', 'blue', 'violet', 'amber', 'rose', 'neutral', 'white', 'graphite'].includes(saved.accent) ? saved.accent : 'teal',
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

