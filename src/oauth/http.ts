import { abortable } from './refreshLock';
import type { OAuthLoginContext } from './types';

/** The deadline covers both headers and the body, alongside user cancellation. */
export async function oauthRequest(ctx: OAuthLoginContext, url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<{ status: number; body: string }> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
    signal.throwIfAborted();
    return abortable((async () => {
        const response = await ctx.fetch(url, { ...init, signal });
        return { status: response.status, body: await response.text() };
    })(), signal);
}
