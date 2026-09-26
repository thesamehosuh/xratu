#!/usr/bin/env node
/**
 * Transient-network retry tests (flaky-connection hardening).
 *
 * Covers the helpers in src/local/localAgent.ts that decide whether a dropped
 * model stream is worth retrying and how long to back off first:
 *  - isTransientNetworkError recognizes the real undici/Node shapes:
 *    TypeError('terminated') with the socket cause buried in `cause`, plain
 *    ECONNRESET/ETIMEDOUT, deep cause chains, and XRATU's own deadline error.
 *  - A user AbortError vetoes the match (a cancel must NEVER be retried) -
 *    including when it sits inside the cause chain of a `terminated` error.
 *  - Misconfiguration (ECONNREFUSED / ENOTFOUND) is NOT retried, and neither
 *    is a context-overflow or a plain application error.
 *  - networkRetryDelayMs doubles from the base, applies +0-25% jitter, and
 *    never exceeds the cap.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-network-retry.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    isTransientNetworkError,
    isOfflineNetworkError,
    shouldResumeStream,
    networkRetryDelayMs,
    TRANSPORT_TIMEOUT_CODE,
    NETWORK_MAX_RETRIES,
    NETWORK_MAX_RESUMES,
    OFFLINE_MAX_RETRIES,
    NETWORK_RETRY_BASE_DELAY_MS,
    NETWORK_RETRY_MAX_DELAY_MS,
} = require('../out/local/localAgent.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const checkTrue = (name, actual) => check(name, !!actual, true);
const checkFalse = (name, actual) => check(name, !!actual, false);

const typeError = (message, options) => new TypeError(message, options);
const coded = (code, message = 'boom') => Object.assign(new Error(message), { code });
const abortError = (message = 'The operation was aborted') =>
    Object.assign(new Error(message), { name: 'AbortError' });

// --- realistic undici shapes -------------------------------------------------

// The exact shape Node's fetch produces when the response body dies mid-stream
// (reproduced against a server that destroys its socket).
checkTrue(
    'terminated + SocketError/UND_ERR_SOCKET',
    isTransientNetworkError(typeError('terminated', {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    })),
);
checkTrue('bare terminated TypeError', isTransientNetworkError(typeError('terminated')));
checkTrue(
    'fetch failed + ECONNRESET',
    isTransientNetworkError(typeError('fetch failed', { cause: coded('ECONNRESET') })),
);
checkTrue('WebKit "failed to fetch"', isTransientNetworkError(typeError('failed to fetch')));
checkTrue('ETIMEDOUT', isTransientNetworkError(coded('ETIMEDOUT')));
checkTrue('EPIPE', isTransientNetworkError(coded('EPIPE')));
checkTrue('EAI_AGAIN (temporary DNS)', isTransientNetworkError(coded('EAI_AGAIN')));
checkTrue('bare UND_ERR_BODY_TIMEOUT code', isTransientNetworkError(coded('UND_ERR_BODY_TIMEOUT')));
checkTrue(
    'deep cause chain (fetch → agent → socket)',
    isTransientNetworkError({ cause: { cause: { cause: coded('EPIPE') } } }),
);
checkTrue(
    'XRATU deadline error is decisive',
    isTransientNetworkError(Object.assign(new Error('Model stream stalled (no data for 120s).'), {
        code: TRANSPORT_TIMEOUT_CODE,
        cause: abortError(),
    })),
);

// --- the abort veto: a cancel must never be retried --------------------------
checkFalse('AbortError', isTransientNetworkError(abortError()));
checkFalse(
    'terminated caused by AbortError (user cancel mid-stream)',
    isTransientNetworkError(typeError('terminated', { cause: abortError() })),
);
checkFalse('ResponseAborted', isTransientNetworkError(Object.assign(new Error('x'), { name: 'ResponseAborted' })));
checkFalse(
    'AbortError above a socket code still vetoes',
    isTransientNetworkError(Object.assign(new Error('aborted'), {
        name: 'AbortError',
        cause: coded('UND_ERR_SOCKET', 'other side closed'),
    })),
);

// --- things that must NOT be retried ----------------------------------------
checkFalse('ECONNREFUSED (server not started)', isTransientNetworkError(coded('ECONNREFUSED')));
checkFalse('ENOTFOUND (wrong URL / blocked host)', isTransientNetworkError(coded('ENOTFOUND')));
checkFalse('plain application error', isTransientNetworkError(new Error('nope')));
checkFalse('HTTP 503 message', isTransientNetworkError(new Error('Model request failed (503): server unavailable')));
checkFalse(
    'context overflow',
    isTransientNetworkError(new Error("This model's maximum context length is 8192 tokens.")),
);
checkFalse('non-object', isTransientNetworkError('terminated'));
checkFalse('null', isTransientNetworkError(null));

// --- backoff schedule --------------------------------------------------------
check('constant max retries', NETWORK_MAX_RETRIES, 3);
check('base delay', NETWORK_RETRY_BASE_DELAY_MS, 1000);
check('attempt 1 (no jitter)', networkRetryDelayMs(1, 0), 1000);
check('attempt 2 (no jitter)', networkRetryDelayMs(2, 0), 2000);
check('attempt 3 (no jitter)', networkRetryDelayMs(3, 0), 4000);
checkTrue('attempt 1 jitter only increases', networkRetryDelayMs(1, 1) > 1000);
checkTrue('jitter stays within +25%', networkRetryDelayMs(1, 1) <= 1250);
checkTrue('large attempt is capped', networkRetryDelayMs(30, 1) <= NETWORK_RETRY_MAX_DELAY_MS);
checkTrue('delay is an integer', Number.isInteger(networkRetryDelayMs(2, 0.37)));

// --- offline (DNS / route) classification ------------------------------------
checkTrue('EAI_AGAIN is offline', isOfflineNetworkError(coded('EAI_AGAIN')));
checkTrue('ENETUNREACH is offline', isOfflineNetworkError(coded('ENETUNREACH')));
checkTrue('ENETDOWN is offline', isOfflineNetworkError(coded('ENETDOWN')));
checkTrue('EHOSTUNREACH is offline', isOfflineNetworkError(coded('EHOSTUNREACH')));
checkTrue(
    'offline code buried in the cause chain',
    isOfflineNetworkError(typeError('fetch failed', { cause: coded('EAI_AGAIN') })),
);
checkFalse('socket reset is not offline', isOfflineNetworkError(coded('ECONNRESET')));
checkFalse('ENOTFOUND (bad host) is not offline', isOfflineNetworkError(coded('ENOTFOUND')));
checkFalse('ECONNREFUSED is not offline', isOfflineNetworkError(coded('ECONNREFUSED')));
checkFalse('abort vetoes offline', isOfflineNetworkError(Object.assign(new Error('x'), { name: 'AbortError' })));
checkFalse('offline behind an abort in the chain is vetoed', isOfflineNetworkError(
    typeError('terminated', { cause: Object.assign(coded('EAI_AGAIN'), { name: 'AbortError' }) }),
));
check('offline retry budget exceeds the normal one', OFFLINE_MAX_RETRIES > NETWORK_MAX_RETRIES, true);
check('offline max retries', OFFLINE_MAX_RETRIES, 8);

// --- mid-stream resume policy -------------------------------------------------
const resumeBase = { emittedOutput: true, sawToolCall: false, transient: true, aborted: false, resumesUsed: 0, deadlineMs: 1000, now: 0 };
const resume = (over) => shouldResumeStream({ ...resumeBase, ...over });
checkTrue('resumes a cut stream that had emitted text', resume({}));
checkFalse('does not resume before any text', resume({ emittedOutput: false }));
checkFalse('does not resume after a tool-call delta', resume({ sawToolCall: true }));
checkFalse('does not resume a non-transient error', resume({ transient: false }));
checkFalse('does not resume a cancel', resume({ aborted: true }));
checkFalse('stops after the resume cap', resume({ resumesUsed: NETWORK_MAX_RESUMES }));
checkTrue('last allowed resume', resume({ resumesUsed: NETWORK_MAX_RESUMES - 1 }));
checkFalse('does not resume past the deadline', resume({ now: 1000 }));
checkFalse('empty-string text is not a resume', resume({ emittedOutput: false }));
check('resume cap', NETWORK_MAX_RESUMES, 2);
// An offline link gets the larger resume budget (the round deadline still caps it).
checkTrue(
    'offline resumes use the offline cap',
    resume({ resumesUsed: NETWORK_MAX_RESUMES, maxResumes: OFFLINE_MAX_RETRIES }),
);
checkFalse(
    'offline resumes still stop at their cap',
    resume({ resumesUsed: OFFLINE_MAX_RETRIES, maxResumes: OFFLINE_MAX_RETRIES }),
);

console.log(failed === 0 ? '\nnetwork-retry tests: all passed' : `\nnetwork-retry tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
