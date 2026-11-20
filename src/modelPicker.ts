import type { ThinkingLevel } from './local/localTypes';

export interface ModelCapability {
    provider?: string;
    free?: boolean;
    vision?: boolean;
    noTools?: boolean;
    reasoning?: boolean;
    noReasoning?: boolean;
    reasoningLevels?: ThinkingLevel[];
    /** Exact variant IDs advertised by a native engine. */
    variants?: string[];
}

export interface ProviderModelCatalog {
    models: string[];
    displayNames: Record<string, string>;
    contextWindows: Record<string, number>;
    capabilities: Record<string, ModelCapability>;
}

export interface ModelFavorite {
    engine: 'xratu' | 'opencode';
    provider: string;
    model: string;
    label: string;
}

export const MAX_MODEL_FAVORITES = 200;

export function modelFavoriteKey(favorite: Pick<ModelFavorite, 'engine' | 'provider' | 'model'>): string {
    return JSON.stringify([favorite.engine, favorite.provider, favorite.model]);
}

export function readModelFavorite(value: unknown): ModelFavorite | undefined {
    if (!value || typeof value !== 'object') return;
    const { engine, provider, model, label } = value as Partial<ModelFavorite>;
    if (engine !== 'xratu' && engine !== 'opencode') return;
    if (typeof provider !== 'string' || !provider || provider.length > 512 ||
        typeof model !== 'string' || !model || model.length > 1024 ||
        typeof label !== 'string' || label.length > 1024) return;
    return { engine, provider, model, label };
}

export function readModelFavorites(value: unknown): ModelFavorite[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_MODEL_FAVORITES).flatMap(entry => {
        const favorite = readModelFavorite(entry);
        return favorite ? [favorite] : [];
    });
}
