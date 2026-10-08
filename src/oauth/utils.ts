/**
 * OAuth parsing/expiry helpers. Pure and dependency-free.
 *
 * The load-bearing rules encoded here:
 *
 *  - parseOAuthErrorBody DROPS an oversized body entirely rather than
 *    truncating it (Codex's rule): a truncated prefix can cut a marker in
 *    half and slip a classification past the matcher, so there is no safe
 *    partial read.
 *
 *  - tokenExpiryMs derives expiry explicit-first, then JWT `exp`, then
 *    "unknown". The JWT claim is decoded WITHOUT verifying the signature -
 *    deliberately (opencode's xAI plugin documents the same): the stored
 *    `expiresAt` is best-effort bookkeeping, and the bearer check that
 *    actually matters happens server-side. 0 means "unknown", and unknown
 *    forces a refresh rather than a guess.
 *
 *  - resolveAuthorizationCodeInput is the manual-paste escape hatch: users
 *    paste everything from a bare code to a full redirect URL with the code
 *    buried in query or fragment. This is the always-works fallback when a
 *    loopback server cannot run (SSH, devcontainer, Codespaces).
 */

export interface ParsedOAuthError {
    error: string;
    description?: string;
}

/** Bodies past this size are refused whole - see the header note. */
export const OAUTH_ERROR_BODY_MAX = 8 * 1024;

const FORM_ERROR_RE = /(?:^|&)error=([^&]*)/;
const FORM_DESC_RE = /(?:^|&)error_description=([^&]*)/;

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
        // Percent-encoding mangled in transit (Windows terminals and browsers
        // both mangle non-ASCII) - return it raw rather than fail the parse.
        return value;
    }
}

/**
 * Extract { error, description } from a token/authorize endpoint body.
 * Handles the shapes seen in the wild: JSON with a string `error`, JSON with
 * an object-shaped `error` (some IdPs nest `{ error: { code, message } }`),
 * and bare form-encoded bodies. Returns null when nothing classifiable is
 * present (malformed JSON, empty body, oversized body).
 */
export function parseOAuthErrorBody(body: string): ParsedOAuthError | null {
    if (!body || body.length > OAUTH_ERROR_BODY_MAX) return null;
    const trimmed = body.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('{')) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            return null; // malformed JSON is not a partial-read risk - bail
        }
        if (!parsed || typeof parsed !== 'object') return null;
        const rec = parsed as Record<string, unknown>;
        const err = rec.error;
        if (typeof err === 'string' && err) {
            const desc = rec.error_description;
            return {
                error: err,
                description: typeof desc === 'string' ? desc : undefined,
            };
        }
        if (err && typeof err === 'object') {
            const nested = err as Record<string, unknown>;
            const code = typeof nested.code === 'string' ? nested.code
                : typeof nested.type === 'string' ? nested.type
                : null;
            if (code) {
                const msg = typeof nested.message === 'string' ? nested.message : undefined;
                return { error: code, description: msg };
            }
        }
        return null;
    }

    // Form-encoded: error=invalid_grant&error_description=...
    const m = FORM_ERROR_RE.exec(trimmed);
    if (!m) return null;
    const desc = FORM_DESC_RE.exec(trimmed);
    return {
        error: safeDecode(m[1]),
        description: desc ? safeDecode(desc[1]) : undefined,
    };
}

/** base64url-decode the payload of a JWT and read `exp` (seconds) as epoch
 *  ms. Signature intentionally NOT verified - see the header note. Returns
 *  null for non-JWT input or a missing/invalid exp. */
export function expiryFromJwt(token: string): number | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
        if (!payload || typeof payload !== 'object') return null;
        const exp = (payload as Record<string, unknown>).exp;
        if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return null;
        return exp * 1000;
    } catch {
        return null;
    }
}

/**
 * Derive the expiry of a token set in epoch ms: explicit stored value first,
 * then the access token's JWT `exp`, else 0 ("unknown - refresh on next
 * use"). Stored and re-derived on purpose: the stored value survives opaque
 * tokens, the JWT check catches a stale stored value.
 */
export function tokenExpiryMs(tokens: { accessToken: string; expiresAt?: number }): number {
    if (typeof tokens.expiresAt === 'number' && tokens.expiresAt > 0) return tokens.expiresAt;
    return expiryFromJwt(tokens.accessToken) ?? 0;
}

/** True when the token is expired (or within `skewMs` of expiry). Unknown
 *  expiry counts as expired: never serve a token whose lifetime we cannot
 *  bound. */
export function isTokenExpired(
    tokens: { accessToken: string; expiresAt?: number },
    skewMs: number,
    nowMs = Date.now(),
): boolean {
    const expiry = tokenExpiryMs(tokens);
    if (expiry <= 0) return true;
    return expiry <= nowMs + skewMs;
}

/**
 * Best-effort extraction of an authorization code from whatever the user
 * pasted: a bare code, a full redirect URL (`?code=`), a fragment form
 * (`#code=`), or a code trailed by `#state` / `&state` fragments. Returns
 * null when nothing code-shaped is present. Codes themselves may contain
 * any URL-safe byte, so extraction is anchored on `code=` where present and
 * falls back to the whole trimmed input.
 */
export function resolveAuthorizationCodeInput(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    // Full URL (query or fragment carrying code=).
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const u = new URL(trimmed);
            const fromQuery = u.searchParams.get('code');
            if (fromQuery) return fromQuery;
            const hash = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
            if (hash) {
                const m = /(?:^|&)code=([^&]*)/.exec(hash);
                if (m && m[1]) return safeDecode(m[1]);
            }
            return null;
        } catch {
            return null;
        }
    }

    // Bare "code=..." paste.
    const m = /(?:^|&)code=([^&]*)/.exec(trimmed);
    if (m && m[1]) return safeDecode(m[1]);

    // Bare code, possibly trailed by a `#state` fragment.
    const hashIdx = trimmed.indexOf('#');
    const candidate = (hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx)).trim();
    return candidate || null;
}
