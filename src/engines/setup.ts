export type SetupEngine = 'xratu' | 'opencode';
export type SetupPath = 'free' | 'provider' | 'local';
export type ModelAvailability = 'checking' | 'available' | 'rateLimited' | 'failed';

export interface SetupModel {
    id: string;
    name: string;
    provider: string;
    free?: boolean;
    tools?: boolean;
    availability?: ModelAvailability;
    checkedAt?: number;
    detail?: string;
}

export interface RuntimeSetupState {
    requestId: string;
    engine: SetupEngine;
    path: SetupPath;
    phase: 'checking' | 'install' | 'workspace' | 'offline' | 'connect' | 'model' | 'ready' | 'attention';
    credentialId?: string;
    providerName?: string;
    models: SetupModel[];
    errorKey?: string;
    detail?: string;
    busy?: boolean;
}

/** Setup ownership is separate from which engine a conversation runs. */
export const ENGINE_SETUP = {
    xratu: { label: 'engineXratu', auth: 'xratu', configuration: 'xratu', offline: true, subagents: true },
    opencode: { label: 'engineOpenCode', auth: 'native', configuration: 'native', offline: false, subagents: false },
} as const;

// Adapted from T3 Code's providerReadiness.logic.ts (MIT; THIRD_PARTY_NOTICES).
// Installation, authentication, and a usable catalog are independent evidence.
export function setupPhase(input: {
    engine: SetupEngine;
    installed?: boolean;
    hasWorkspace: boolean;
    offline: boolean;
    hasCredential: boolean;
    models?: readonly SetupModel[];
    freeOnly: boolean;
}): RuntimeSetupState['phase'] {
    if (input.offline && !ENGINE_SETUP[input.engine].offline) return 'offline';
    if (input.engine === 'opencode' && !input.installed) return 'install';
    if (input.engine === 'opencode' && !input.hasWorkspace) return 'workspace';
    if (input.engine === 'xratu' && !input.hasCredential) return 'connect';
    if (!input.models) return 'checking';
    if (!input.models.length) return 'model';
    if (!input.freeOnly) return 'ready';
    if (input.models.some((model) => model.free && model.availability === 'available')) return 'ready';
    return input.models.some((model) => model.availability === 'checking') ? 'model' : 'attention';
}

export function canStartSetup(state: RuntimeSetupState, modelId: string, now = Date.now()): boolean {
    if (state.busy || state.phase !== 'ready') return false;
    const model = state.models.find((entry) => entry.id === modelId);
    if (!model) return false;
    return state.path !== 'free' || (model.free === true && model.availability === 'available'
        && model.checkedAt !== undefined && now - model.checkedAt >= 0 && now - model.checkedAt < 60_000);
}
