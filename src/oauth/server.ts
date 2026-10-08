/**
 * Loopback OAuth callback server. Owns every hard-won transport rule in one
 * place so no provider ever re-implements them (Roo and opencode ship the
 * socket-leak bug precisely because each provider owns its own server):
 *
 *  - Binds 127.0.0.1 EXPLICITLY. A bare `server.listen(port)` binds `::`,
 *    exposing the token-receiving endpoint to the LAN for the duration of the
 *    flow (Roo's bug, oauth.ts:708 - not Linux-only, Windows does it too).
 *
 *  - Iterates candidate ports skipping EADDRINUSE; a stuck previous flow must
 *    not brick sign-in for the whole machine.
 *
 *  - Destroys every tracked socket on settle - but only AFTER the final
 *    response has flushed (`finish`). `server.close()` alone leaves keep-alive
 *    connections SERVED: a browser/fetch connection pool holds a socket to the
 *    fixed callback port open, and a LATER flow's callback can then be
 *    delivered over the pooled socket to this already-settled server (Cline's
 *    closeAllConnections fix; Roo + opencode still have it). Destroying
 *    eagerly would truncate the success page, so the flush ordering matters.
 *    Regression-tested in test-oauth-server.mjs.
 *
 *  - error= params and state mismatches FAIL the flow with a classified
 *    error; they are never silently dropped (Continue's eternal-spinner bug).
 *    A bare hit with no code gets a 400 but the flow stays pending - random
 *    probes must not kill a login.
 *
 *  - Response pages are STATIC strings. Nothing user-controlled is ever
 *    interpolated into the HTML, so there is no markup-injection surface to
 *    sanitize. Callers may pass localized static pages (successHtml /
 *    errorHtml); the defaults are English and wiring-time callers SHOULD pass
 *    ui()-localized pages instead.
 *
 *  - Settling is exactly-once: after success/failure/timeout/cancel, late
 *    callbacks get 410 and can never resolve the flow or persist anything.
 */
import * as http from 'http';
import type { AddressInfo, Socket } from 'net';
import { OAuthCancelledError, OAuthFlowError } from './types';

export interface LoopbackCallbackResult {
    code: string;
    state?: string;
    /** RFC 9207 issuer identifier, when the IdP forwards it. */
    iss?: string;
}

export interface LoopbackServer {
    port: number;
    callbackPath: string;
    /** The exact redirect_uri to register in the authorize request. */
    redirectUri: string;
    waitForCallback(): Promise<LoopbackCallbackResult>;
    /** Abort the flow: waitForCallback rejects with OAuthCancelledError and
     *  the port is released. A late-arriving callback gets 410 and cannot
     *  resolve anything. */
    cancel(): void;
    /** Release the port WITHOUT settling the promise - for flows that were
     *  completed by another channel (manual code paste). */
    dispose(): void;
}

export interface LoopbackServerOptions {
    /** Candidate ports, tried in order; EADDRINUSE skips to the next. */
    candidatePorts: number[];
    callbackPath?: string;
    /** When set, a callback whose state does not match fails the flow. */
    expectedState?: string;
    /** Custom state predicate for IdPs that decorate the returned state.
     *  ChatGPT appends `.onboarding_entrypoint=life_sciences` to a state it
     *  issued (Codex CLI strips it before comparing), so strict equality
     *  would reject a perfectly good sign-in. Compared against the EXPECTED
     *  state; defaults to `received === expectedState`. */
    stateMatches?: (received: string, expected: string) => boolean;
    /** Inactivity deadline for the whole flow. Default 5 minutes. */
    timeoutMs?: number;
    successHtml?: string;
    errorHtml?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_SUCCESS_HTML =
    '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:3em">' +
    '<p>Sign-in complete. You can close this tab and return to VS Code.</p></body></html>';
const DEFAULT_ERROR_HTML =
    '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:3em">' +
    '<p>Sign-in could not be completed. Return to VS Code for details.</p></body></html>';

export async function startLoopbackServer(opts: LoopbackServerOptions): Promise<LoopbackServer> {
    const callbackPath = opts.callbackPath ?? '/callback';
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const successHtml = opts.successHtml ?? DEFAULT_SUCCESS_HTML;
    const errorHtml = opts.errorHtml ?? DEFAULT_ERROR_HTML;
    if (opts.candidatePorts.length === 0) {
        throw new OAuthFlowError('no_ports', 'No candidate callback ports configured');
    }

    let lastError: unknown = null;
    for (const port of opts.candidatePorts) {
        try {
            return await listenOn(port, callbackPath, timeoutMs, opts.expectedState, opts.stateMatches, successHtml, errorHtml);
        } catch (err) {
            lastError = err;
            if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err;
            // EADDRINUSE: something else holds this port - try the next one.
        }
    }
    throw new OAuthFlowError(
        'ports_busy',
        `Every callback port in [${opts.candidatePorts.join(', ')}] is in use`
            + ` (last error: ${(lastError as Error)?.message ?? 'unknown'}).`
            + ' Close the application holding the port, or use the manual code-paste sign-in.',
    );
}

function listenOn(
    port: number,
    callbackPath: string,
    timeoutMs: number,
    expectedState: string | undefined,
    stateMatches: ((received: string, expected: string) => boolean) | undefined,
    successHtml: string,
    errorHtml: string,
): Promise<LoopbackServer> {
    return new Promise((resolveListen, rejectListen) => {
        // Sockets are tracked and destroyed on settle - see the header note
        // on why close() alone is not enough.
        const sockets = new Set<Socket>();
        let settled = false;
        // Armed immediately; `settle` is a hoisted function declaration.
        const timeout = setTimeout(() => {
            settle(undefined, new OAuthFlowError(
                'timeout',
                `No OAuth callback arrived within ${Math.round(timeoutMs / 1000)}s on port ${port}`,
            ));
        }, timeoutMs);
        timeout.unref();

        let resolveFlow!: (r: LoopbackCallbackResult) => void;
        let rejectFlow!: (e: Error) => void;
        const flow = new Promise<LoopbackCallbackResult>((res, rej) => {
            resolveFlow = res;
            rejectFlow = rej;
        });
        // The flow promise is always consumed via waitForCallback(); attach a
        // no-op catch so a settle before anyone waits can never surface as an
        // unhandled rejection.
        flow.catch(() => undefined);

        function settle(result: LoopbackCallbackResult | undefined, error: Error | undefined): void {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close();
            if (error) rejectFlow(error);
            else if (result) resolveFlow(result);
        }

        /** Send the page and settle only once the bytes have flushed - a
         *  socket destroyed mid-write RSTs the connection and the browser
         *  never sees the page (observed in the test suite: ECONNRESET on the
         *  client). The settling response therefore sends Connection: close
         *  and is REMOVED from the destroy set: it closes itself gracefully
         *  after flushing, while the destroy-on-settle still kills the pooled
         *  idle sockets that the keep-alive regression is about. 'close' is
         *  the fallback for a client that disconnects before reading. */
        function respondThen(
            res: http.ServerResponse,
            status: number,
            html: string,
            after?: () => void,
        ): void {
            const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
            if (after) headers['connection'] = 'close';
            res.writeHead(status, headers);
            if (!after) {
                res.end(html);
                return;
            }
            let fired = false;
            const once = () => {
                if (fired) return;
                fired = true;
                sockets.delete(res.socket as Socket);
                after();
            };
            res.on('finish', once);
            res.on('close', once);
            res.end(html);
        }

        const server = http.createServer((req, res) => {
            let url: URL;
            try {
                url = new URL(req.url ?? '/', 'http://127.0.0.1');
            } catch {
                respondThen(res, 400, errorHtml);
                return;
            }
            if (url.pathname !== callbackPath) {
                respondThen(res, 404, errorHtml);
                return;
            }
            if (settled) {
                // Late callback (another tab, a replayed browser request): it
                // must not resolve or overwrite anything.
                respondThen(res, 410, errorHtml);
                return;
            }

            const errorParam = url.searchParams.get('error');
            if (errorParam !== null) {
                const desc = url.searchParams.get('error_description');
                respondThen(res, 400, errorHtml, () => settle(undefined, new OAuthFlowError(
                    errorParam,
                    desc ? `Authorization failed: ${errorParam} - ${desc}` : `Authorization failed: ${errorParam}`,
                )));
                return;
            }

            const code = url.searchParams.get('code');
            if (!code) {
                // Junk probe on the callback path: answer it but keep waiting.
                respondThen(res, 400, errorHtml);
                return;
            }

            const state = url.searchParams.get('state') ?? undefined;
            const stateOk = expectedState === undefined
                ? true
                : state !== undefined
                    && (stateMatches
                        ? stateMatches(state, expectedState)
                        : state === expectedState);
            if (!stateOk) {
                // A real callback carrying the WRONG state is a confused-deputy
                // signal - fail loudly rather than Continue's silent drop.
                respondThen(res, 400, errorHtml, () => settle(
                    undefined,
                    new OAuthFlowError('state_mismatch', 'OAuth state mismatch - possible stale or forged callback'),
                ));
                return;
            }

            const result: LoopbackCallbackResult = {
                code,
                state,
                iss: url.searchParams.get('iss') ?? undefined,
            };
            respondThen(res, 200, successHtml, () => settle(result, undefined));
        });

        server.on('connection', (socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
        });

        server.on('error', (err) => {
            if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE' && !settled) {
                clearTimeout(timeout);
                rejectListen(err);
                return;
            }
            settle(undefined, err as Error);
            // If the error arrived before listen completed, surface it to the
            // starter too - nothing else will.
            rejectListen(err);
        });

        server.listen(port, '127.0.0.1', () => {
            const address = server.address() as AddressInfo;
            resolveListen({
                port: address.port,
                callbackPath,
                redirectUri: `http://127.0.0.1:${address.port}${callbackPath}`,
                waitForCallback: () => flow,
                cancel: () => settle(undefined, new OAuthCancelledError()),
                dispose: () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    for (const socket of sockets) socket.destroy();
                    sockets.clear();
                    server.close();
                    // Never settles the flow promise - the caller has already
                    // completed the flow out of band.
                },
            });
        });
    });
}
