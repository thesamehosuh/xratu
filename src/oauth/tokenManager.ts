/**
 * OAuth token manager - resolves a usable access token for a provider,
 * refreshing when needed, without ever letting two refreshes (in this
 * process or across VS Code windows) race a rotating refresh token.
 *
 * Layers, cheapest first:
 *
 *  1. VALIDITY CHECK: a token outside the skew window is served with no I/O.
 *  2. SINGLE-FLIGHT: concurrent in-process resolve() calls collapse onto one
 *     refresh promise (a burst of tool calls at turn start must not fire N
 *     refreshes - the first rotation kills the other N-1).
 *  3. RELOAD-BEFORE-NETWORK under a cross-process directory lock: after
 *     acquiring the lock, re-read the store. If the stored record's refresh
 *     token CHANGED while we waited, another window already rotated it - use
 *     theirs, make no network call (Codex's ReloadedChanged outcome, the
 *     cheapest correct cross-process pattern).
 *  4. STALE-WRITE GUARD: after the refresh network call, re-read once more
 *     before writing. If the record changed mid-flight - the user signed out
 *     in another window, or re-authed - DISCARD our refresh result. Writing
 *     it would resurrect a session the user just ended (only Cline and Codex
 *     get this right; everyone else can resurrect).
 *
 * Storage is behind the OAuthTokenStore interface so the manager stays pure:
 * the wiring layer backs it with SecretStorage (key `xratu.oauthTokens.*`),
 * tests back it with a Map. The manager never touches SecretStorage or the
 * filesystem itself (the lock path is given to it).
 */
import type { OAuthLoginContext, OAuthProviderHandler, OAuthTokenSet } from './types';
import { OAuthReauthRequiredError } from './types';
import { isTokenExpired } from './utils';
import { oauthLockPath, withDirectoryLock } from './refreshLock';

export interface OAuthTokenStore {
    read(storageKey: string): Promise<OAuthTokenSet | null>;
    /** null clears the record (sign-out). */
    write(storageKey: string, tokens: OAuthTokenSet | null): Promise<void>;
}

export interface TokenManagerOptions {
    store: OAuthTokenStore;
    /** Directory the refresh locks live in (e.g. the extension's global
     *  storage dir). Created lazily by the lock itself. */
    lockDir: string;
    /** Proactive-refresh skew: a token expiring within this window is
     *  refreshed BEFORE use, so a long turn does not hit a mid-flight 401.
     *  Default 5 minutes (Codex's window). */
    skewMs?: number;
    lockTimeoutMs?: number;
}

/** Two records are "the same" for guard purposes when the refresh token
 *  matches: a rotation is exactly the event the guards exist to catch, and
 *  the refresh token is the only field whose change implies rotation. A
 *  record that lost its refresh token (edit, corruption) also counts as
 *  changed. */
function sameRecord(a: OAuthTokenSet | null, b: OAuthTokenSet | null): boolean {
    if (a === null || b === null) return a === b;
    return a.refreshToken === b.refreshToken && a.accessToken === b.accessToken;
}

export class OAuthTokenManager {
    private readonly store: OAuthTokenStore;
    private readonly lockDir: string;
    private readonly skewMs: number;
    private readonly lockTimeoutMs?: number;
    private readonly inFlight = new Map<string, Promise<OAuthTokenSet>>();

    constructor(opts: TokenManagerOptions) {
        this.store = opts.store;
        this.lockDir = opts.lockDir;
        this.skewMs = opts.skewMs ?? 5 * 60 * 1000;
        this.lockTimeoutMs = opts.lockTimeoutMs;
    }

    /** Access token for the provider, refreshing when expired-or-nearly. */
    resolve(handler: OAuthProviderHandler, ctx: OAuthLoginContext): Promise<string> {
        return this.resolveInternal(handler, ctx, false).then((r) => r.accessToken);
    }

    /** The WHOLE resolved token set - callers that also need provider header
     *  material (the ChatGPT-Account-Id routing header lives in the account id)
     *  must not re-read the store: that would race the single-flight and see a
     *  pre-refresh record. */
    resolveTokens(handler: OAuthProviderHandler, ctx: OAuthLoginContext): Promise<OAuthTokenSet> {
        return this.resolveInternal(handler, ctx, false);
    }

    /** Access token, refreshing even when the current one looks valid - the
     *  retry-once-on-401 path uses this. */
    forceRefresh(handler: OAuthProviderHandler, ctx: OAuthLoginContext): Promise<string> {
        return this.resolveInternal(handler, ctx, true).then((r) => r.accessToken);
    }

    private resolveInternal(handler: OAuthProviderHandler, ctx: OAuthLoginContext, force: boolean): Promise<OAuthTokenSet> {
        const key = handler.storageKey;
        const existing = this.inFlight.get(key);
        if (existing) return existing;
        const promise = this.doResolve(handler, ctx, force).finally(() => {
            if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
        });
        this.inFlight.set(key, promise);
        return promise;
    }

    private async doResolve(handler: OAuthProviderHandler, ctx: OAuthLoginContext, force: boolean): Promise<OAuthTokenSet> {
        const key = handler.storageKey;
        const snapshot = await this.store.read(key);
        if (!snapshot) throw new OAuthReauthRequiredError(handler.providerId);
        if (!force && !isTokenExpired(snapshot, this.skewMs)) return snapshot;

        const lockPath = oauthLockPath(this.lockDir, key);
        return withDirectoryLock(lockPath, { timeoutMs: this.lockTimeoutMs }, async () => {
            // Layer 3: reload-before-network. Someone may have rotated the
            // token while we waited for the lock; if so, theirs wins and we
            // make no network call at all.
            const current = await this.store.read(key);
            if (!current) throw new OAuthReauthRequiredError(handler.providerId);
            let working = snapshot;
            if (!sameRecord(current, snapshot)) {
                if (!force && !isTokenExpired(current, this.skewMs)) return current;
                working = current; // their record is also expired - refresh THAT
            }
            if (!force && !isTokenExpired(working, this.skewMs)) return working;

            const result = await handler.refresh(working, ctx);

            if (result.kind === 'keep') return result.tokens;

            if (result.kind === 'reauth') {
                // We hold the lock and verified current===working above, so
                // clearing cannot erase a concurrent sign-IN.
                await this.store.write(key, null);
                throw new OAuthReauthRequiredError(handler.providerId);
            }

            // Layer 4: stale-write guard. A sign-out or re-auth that landed
            // while our refresh was in flight must not be overwritten.
            const latest = await this.store.read(key);
            if (!sameRecord(latest, working)) {
                if (latest && !isTokenExpired(latest, this.skewMs)) return latest;
                throw new OAuthReauthRequiredError(handler.providerId);
            }

            await this.store.write(key, result.tokens);
            return result.tokens;
        });
    }
}
