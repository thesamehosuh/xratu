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

/**
 * OAuth token-endpoint rejection classification: is this a PERMANENT
 * credential rejection (refresh token revoked/expired/reused) rather than a
 * transient failure? This is the distinction that decides "log the user out"
 * vs "keep the session" in the refresh matrix - getting it wrong in the
 * lenient direction logs users out on every network blip, and getting it
 * wrong in the strict direction retries a dead credential forever.
 *
 * The status gate (400/401/403) matches Cline/Roo. The body check is
 * STRICTER than theirs on purpose: they substring-match the raw body, which
 * lets an intercepting proxy's injected HTML error page (a real thing on
 * sanctioned-network OAuth endpoints, not a hypothetical) forge a logout by
 * containing the word "revoked". A structured error code is required; a bare
 * substring is only trusted on a small, exactly-400 (the RFC status) body.
 */
const INVALID_GRANT_CODE_RE = /^(invalid_grant|invalid_token|token_revoked|revoked|expired_token)$/i;
const INVALID_GRANT_SUBSTR_RE = /invalid_grant|invalid_token|token_revoked|expired_token/i;
/** Substring fallback is refused past this size - an injected page is big. */
const INVALID_GRANT_SUBSTR_MAX = 4096;

function oauthErrorCode(body: string): string | null {
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
        try {
            const err = (JSON.parse(trimmed) as { error?: unknown })?.error;
            return typeof err === 'string' ? err : null;
        } catch {
            return null;
        }
    }
    const m = /(?:^|&)error=([^&]*)/.exec(trimmed);
    return m ? m[1] : null;
}

export function isInvalidGrantError(status: number, body: string): boolean {
    if (status !== 400 && status !== 401 && status !== 403) return false;
    const code = oauthErrorCode(body);
    if (code !== null) return INVALID_GRANT_CODE_RE.test(code);
    if (status === 400 && body.length <= INVALID_GRANT_SUBSTR_MAX) {
        return INVALID_GRANT_SUBSTR_RE.test(body);
    }
    return false;
}
