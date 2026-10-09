/**
 * OAuth provider registry - the single place provider handlers live.
 *
 * Follows Cline's provider-auth-registry shape (a flat handler record + a
 * static array + a Map): explicit, typed, greppable, and storage policy
 * (storageKey aliasing) lives HERE rather than inside each provider. Cline
 * also ships a cleaner OO interface that nothing implements - deliberately
 * not repeated.
 *
 * Phase 1 registers no handlers. Registration is a pure data operation, so
 * the registry cannot make the extension behave differently until a provider
 * lands AND the credential layer is wired to look it up.
 */
import type { OAuthProviderHandler } from './types';

const handlers = new Map<string, OAuthProviderHandler>();

/** Register a handler. Duplicate providerIds are a programming error, not a
 *  runtime condition - throwing at registration keeps a bad entry from ever
 *  reaching a user-facing flow. */
export function registerOAuthProvider(handler: OAuthProviderHandler): void {
    if (!handler.providerId || !handler.storageKey) {
        throw new Error('OAuth handler requires providerId and storageKey');
    }
    if (handlers.has(handler.providerId)) {
        throw new Error(`OAuth provider already registered: ${handler.providerId}`);
    }
    handlers.set(handler.providerId, handler);
}

export function getOAuthProvider(providerId: string): OAuthProviderHandler | undefined {
    return handlers.get(providerId);
}

export function listOAuthProviders(): OAuthProviderHandler[] {
    return [...handlers.values()];
}

/** Test-only: wipe registrations so suites cannot leak handlers into each
 *  other. Not exported for production use - there is no runtime unregister. */
export function _resetOAuthRegistryForTests(): void {
    handlers.clear();
}
