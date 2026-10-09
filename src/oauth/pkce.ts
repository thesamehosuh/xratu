/**
 * PKCE (RFC 7636) and OAuth `state` generation on node:crypto.
 *
 * node:crypto rather than Web Crypto: this module only ever runs in the
 * extension host and the node test harness, and the sync API keeps challenge
 * derivation trivially verifiable by hand in tests. No third-party dependency
 * - every competitor hand-rolls this too; the whole thing is ~30 lines.
 */
import { createHash, randomBytes } from 'crypto';

export function base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 verifier: 32 random bytes -> 43 base64url chars (min allowed
 *  length; the 64-byte/86-char variant buys nothing over 256 bits of entropy). */
export function generateVerifier(): string {
    return base64url(randomBytes(32));
}

export function computeChallenge(verifier: string): string {
    return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** CSRF token for the authorize round-trip. 24 bytes -> 32 base64url chars. */
export function generateState(): string {
    return base64url(randomBytes(24));
}
