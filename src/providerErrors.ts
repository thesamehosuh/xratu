/**
 * Provider HTTP error classification.
 *
 * Pure and dependency-free so it can be unit-tested without VS Code. Given a
 * non-OK status and the response body excerpt, decide whether the failure is a
 * geo-block (the provider refuses the user's country/region), an auth failure,
 * or a rate limit - so the host can surface an actionable Persian message
 * instead of raw provider JSON.
 */

export type ProviderErrorKind = 'geoBlocked' | 'auth' | 'rateLimited' | 'other';

/** Stable code carried by an HTTP rejection thrown from the agent runtime. */
export const PROVIDER_HTTP_STATUS_CODE = 'XRATU_HTTP_STATUS';

/**
 * Bodies that mean "your region/country is not served". Providers word this
 * differently; the patterns are deliberately narrow to avoid a false positive
 * on an ordinary 403 (which is usually a permissions problem).
 */
const GEO_BLOCK_RE = new RegExp([
    'not available in your (country|region|location)',
    'unsupported (country|region)',
    'country not supported',
    'not supported in your (country|region)',
    'access denied[^.]{0,80}(country|region|location)',
    'service is not available in your',
    '(country|region)[^.]{0,40}not supported',
].join('|'), 'i');

/** Classify a provider HTTP rejection. */
export function classifyProviderHttpError(status: number, body: string): ProviderErrorKind {
    if (status === 401) return 'auth';
    if (status === 429) return 'rateLimited';
    // 451 is "Unavailable For Legal Reasons" - definitionally a legal/geo
    // block. 403 is ambiguous (often permissions), so it needs wording.
    if (status === 451) return 'geoBlocked';
    if (status === 403 && GEO_BLOCK_RE.test(body)) return 'geoBlocked';
    return 'other';
}

/**
 * Read `{ status, body }` off an error thrown by the agent runtime, or null
 * when it is not a tagged provider HTTP rejection.
 */
export function providerHttpStatus(error: unknown): { status: number; body: string } | null {
    if (!error || typeof error !== 'object') return null;
    const e = error as { code?: unknown; status?: unknown; body?: unknown };
    if (e.code !== PROVIDER_HTTP_STATUS_CODE || typeof e.status !== 'number') return null;
    return { status: e.status, body: typeof e.body === 'string' ? e.body : '' };
}

/** True when the error is a geo-block (see `classifyProviderHttpError`). */
export function isGeoBlockedError(error: unknown): boolean {
    const info = providerHttpStatus(error);
    if (!info) return false;
    return classifyProviderHttpError(info.status, info.body) === 'geoBlocked';
}
