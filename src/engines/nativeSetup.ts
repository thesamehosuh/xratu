/** Display-only native configuration. Never serialize SDK credential values. */
export interface NativeIntegration {
    id: string;
    name: string;
    key: boolean;
    oauth: { id: string; label: string }[];
    connections: { label: string; source: 'credential' | 'env'; needsAuth: boolean }[];
}
export interface NativeSetupState {
    requestId: string;
    phase: 'checking' | 'ready' | 'attention';
    integrations: NativeIntegration[];
    servers: { name: string; status: string }[];
    skills: { name: string; description?: string; path: string }[];
    errorKey?: string;
    busy?: boolean;
    oauth?: { integrationID: string; url: string; instructions: string; mode: 'auto' | 'code' };
}
