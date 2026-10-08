/**
 * OAuth provider plumbing - shared types and control-flow errors.
 *
 * Pure and VS Code-free so the whole module is unit-testable with plain node
 * (test/test-oauth-*.mjs run against out/oauth/*.js). Phase 1 registers NO
 * providers: nothing here executes until a handler is registered and wired
 * into the credential layer.
 *
 * Design references (see OAUTH-RESEARCH):
 *  - Handler shape follows Cline's ProviderAuthHandler (flat functions beat
 *    the class interface nothing ended up implementing).
 *  - The structured flow event follows goose's DEVICE_CODE_ANNOUNCE: the
 *    provider emits data, the presentation layer decides how to render it
 *    (webview, toast, stderr). This is what keeps OAuth off the hardcoded-
 *    English path - a handler never formats a user-facing string.
 */

/** One stored token set. `expiresAt` of 0 means "unknown - refresh on next
 *  use" (never guess a validity window for an opaque token). */
export interface OAuthTokenSet {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number; // epoch ms; 0 = unknown
    accountId?: string; // ChatGPT-Account-Id, Copilot tenant, etc.
    /** Human-readable account ("Plus - you@example.com") when the IdP
     *  discloses one. Display metadata only - never sent as a credential. */
    accountLabel?: string;
    scopes?: string[];
    tokenType?: string;
}

/**
 * Structured progress out of a login flow. The surface (webview / native
 * toast / CLI) renders these through the i18n system; handlers MUST NOT smuggle
 * pre-formatted user-facing prose into them - raw URLs and codes only.
 */
export type OAuthFlowEvent =
    | { type: 'browser-url'; url: string }
    | {
          type: 'device-code';
          userCode: string;
          verificationUri: string;
          verificationUriComplete?: string;
          expiresIn: number; // seconds
      };

export interface OAuthLoginContext {
    /** Injected so token traffic goes through proxyFetch at wiring time and
     *  stays mockable in tests. */
    fetch: typeof fetch;
    /** Opens the system browser. Injected (vscode.env.openExternal at wiring
     *  time, recorded in tests). */
    openExternal?: (url: string) => void | Promise<void>;
    onEvent?: (event: OAuthFlowEvent) => void;
    signal?: AbortSignal;
}

/**
 * Result of a provider refresh attempt - the four-way matrix every serious
 * implementation converges on:
 *
 *   refreshed        -> persist the new token set
 *   keep             -> TRANSIENT failure but the access token is still valid:
 *                       serve it, change nothing
 *   reauth           -> PERMANENT rejection (invalid_grant & friends): the
 *                       caller clears the stored tokens and asks for sign-in
 *   (throw)          -> transient failure AND the token is expired, or a
 *                       structural failure. Credentials stay in storage.
 *
 * The cell everyone gets wrong is keep-vs-throw: mapping a transient network
 * failure to `reauth` logs the user out on every network blip (the single
 * worst OAuth bug in the competitor survey - Roo and opencode both ship it).
 */
export type OAuthRefreshResult =
    | { kind: 'refreshed'; tokens: OAuthTokenSet }
    | { kind: 'keep'; tokens: OAuthTokenSet }
    | { kind: 'reauth' };

export interface OAuthProviderHandler {
    providerId: string;
    /** Key the token set is stored under. Two provider ids may share one
     *  storageKey to share one token set (Cline's cline/cline-pass case). */
    storageKey: string;
    /** Canonical endpoint the tokens are for - OAuth providers have fixed
     *  base URLs the user must not be able to mistype. */
    canonicalBaseUrl: string;
    /** API dialect this provider's base URL speaks. OAuth providers are NOT
     *  OpenAI-compatible by default: the ChatGPT Codex backend serves the
     *  Responses API only, so the credential must carry the style instead of
     *  the request path guessing from the host. */
    apiStyle?: 'chat' | 'messages' | 'responses' | 'google';
    /** Provider-specific request headers for a resolved token set (the
     *  ChatGPT-Account-Id routing header, an `originator`, ...). Kept on the
     *  handler so a base-URL heuristic never has to know provider trivia. */
    headers?(tokens: OAuthTokenSet): Record<string, string>;
    /** Run a full login flow and return fresh tokens. Throws
     *  OAuthCancelledError when the user aborts, OAuthFlowError otherwise. */
    login(ctx: OAuthLoginContext): Promise<OAuthTokenSet>;
    /** Refresh per the matrix above. `refreshWithTokenEndpoint` in
     *  tokenEndpoint.ts implements it for any RFC 6749 section 6 endpoint. */
    refresh(tokens: OAuthTokenSet, ctx: OAuthLoginContext): Promise<OAuthRefreshResult>;
    /** Server-side revocation (RFC 7009) for sign-out. Best-effort by
     *  contract: the caller clears local credentials even if this throws. */
    revoke?(tokens: OAuthTokenSet, ctx: OAuthLoginContext): Promise<void>;
}

/** Base flow failure. `code` is an OAuth/RFC error code where one exists
 *  ('access_denied', 'expired_token', 'timeout', ...) so the surface can map
 *  it to an i18n key instead of matching on English prose. */
export class OAuthFlowError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'OAuthFlowError';
        this.code = code;
    }
}

/** The stored refresh token was permanently rejected - credentials are dead
 *  and the user must sign in again. Distinct from OAuthFlowError so a catch
 *  can route to the re-auth surface, never to a retry loop. */
export class OAuthReauthRequiredError extends Error {
    readonly providerId: string;
    constructor(providerId: string, message?: string) {
        super(message ?? `OAuth credentials for ${providerId} were rejected - sign in again`);
        this.name = 'OAuthReauthRequiredError';
        this.providerId = providerId;
    }
}

/** The user (or a cancel button) aborted the flow. NOT an error worth
 *  surfacing beyond a quiet state reset. */
export class OAuthCancelledError extends Error {
    constructor(message = 'OAuth flow cancelled') {
        super(message);
        this.name = 'OAuthCancelledError';
    }
}
