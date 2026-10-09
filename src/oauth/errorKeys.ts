/**
 * OAuth protocol failure code -> webview i18n key.
 *
 * Host errors cross to the webview as KEYS, never as text (AGENTS.md), so the
 * protocol vocabulary has to be mapped to the localized catalog somewhere
 * testable. Pure, so the mapping cannot drift from the codes the flows throw
 * without a suite noticing.
 *
 * Unknown codes map to the generic failure key rather than leaking raw
 * provider/IdP prose into the UI.
 */
import { OAuthCancelledError, OAuthFlowError, OAuthReauthRequiredError } from './types';

const CODE_KEYS: Record<string, string> = {
    // Callback / authorize rejections
    access_denied: 'oauthAccessDenied',
    missing_entitlement: 'oauthMissingEntitlement',
    state_mismatch: 'oauthStateMismatch',
    // Transport
    ports_busy: 'oauthPortsBusy',
    no_ports: 'oauthPortsBusy',
    timeout: 'oauthTimeout',
    cancelled: 'oauthCancelled',
    // Device flow
    device_unavailable: 'oauthDeviceUnavailable',
    expired_token: 'oauthDeviceExpired',
    // Terminal credential states
    reauth_required: 'oauthReauthRequired',
    not_implemented: 'oauthUnavailable',
    // Protocol-level
    bad_response: 'oauthFailed',
    plan_permission_missing: 'oauthPlanPermissionMissing',
};

export const OAUTH_GENERIC_ERROR_KEY = 'oauthFailed';

/** Key for an error thrown by a login flow. `OAuthCancelledError` is a quiet
 *  reset, not a failure - the webview shows it as a neutral "cancelled". */
export function oauthErrorValueKey(error: unknown): string {
    if (error instanceof Error && error.name === 'TimeoutError') return 'oauthTimeout';
    if (error instanceof OAuthCancelledError) return 'oauthCancelled';
    if (error instanceof OAuthReauthRequiredError) return CODE_KEYS.reauth_required;
    if (error instanceof OAuthFlowError) return CODE_KEYS[error.code] ?? OAUTH_GENERIC_ERROR_KEY;
    return OAUTH_GENERIC_ERROR_KEY;
}

/** Every key this module can emit - the i18n suite asserts each exists in
 *  BOTH locales, so a new protocol code cannot ship untranslated. */
export function oauthErrorKeys(): string[] {
    return [...new Set([...Object.values(CODE_KEYS), OAUTH_GENERIC_ERROR_KEY, 'oauthCancelled', 'oauthReauthRequired'])];
}