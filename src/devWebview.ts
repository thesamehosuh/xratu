/**
 * Dev-loop helpers for the webview: hot-reload against a Vite dev server, and
 * a host→webview message recorder that turns a live session into a replayable
 * tape.
 *
 * Everything here is deliberately FREE of the `vscode` import - same
 * precedent as `tooling/processTree.ts` / `shellPlatform.ts` - so the URL
 * validation and the HTML assembly are unit-testable in plain node
 * (see test/test-dev-webview.mjs).
 *
 * Both features are opt-in through ENVIRONMENT VARIABLES, never through
 * `contributes.configuration`: they are developer-only, a Settings entry
 * would need a `package.nls` pair in both locales, and an env var can only
 * ever be on for someone who exported it themselves.
 */

/** Validated Vite dev-server base, e.g. `http://localhost:5173`. */
export type DevWebviewUrl = string;

/**
 * Validate `XRATU_DEV_WEBVIEW_URL`.
 *
 * Returns null (meaning "run normally from the built bundle") for anything
 * that is absent, unparseable, or not http(s). Rejecting non-http protocols
 * matters: the value is interpolated into a CSP and into script `src`
 * attributes, so `javascript:` or `data:` must never reach that point.
 */
export function parseDevWebviewUrl(raw: string | null | undefined): DevWebviewUrl | null {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) return null;

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // Origin plus any mount path, without a trailing slash, so callers can
    // concatenate `/src/main.tsx` without producing a double slash.
    const base = `${url.origin}${url.pathname}`.replace(/\/$/, '');
    return base;
}

/** `http://` -> `ws://`, `https://` -> `wss://` (the HMR socket). */
export function webSocketUrl(base: DevWebviewUrl): string {
    return base.replace(/^http/, 'ws');
}

export interface DevWebviewHtmlInput {
    /** Contents of `webview-ui/index.html` - the source document Vite serves. */
    sourceHtml: string;
    /** Validated dev-server base from {@link parseDevWebviewUrl}. */
    devUrl: DevWebviewUrl;
    /** Persisted UI locale, baked before first paint (see i18n.ts). */
    locale: string;
    /** CSP nonce for the one inline script this document needs. */
    nonce: string;
}

/**
 * The script tag the source document ships. Dev mode rewrites it to an
 * absolute URL and loads Vite's client alongside it, so the app runs from the
 * dev server INSIDE the webview document - no navigation, and
 * `acquireVsCodeApi` keeps working.
 */
const ENTRY_MARKER = 'src="/src/main.tsx"';

/**
 * Build the dev-mode webview document.
 *
 * Returns null when the source document does not contain the expected entry
 * tag, so the caller can fall back to the built bundle instead of serving a
 * page that silently mounts nothing.
 */
export function buildDevWebviewHtml(input: DevWebviewHtmlInput): string | null {
    const { sourceHtml, devUrl, locale, nonce } = input;
    if (!sourceHtml.includes(ENTRY_MARKER)) return null;

    const ws = webSocketUrl(devUrl);
    // `connect-src` needs the HMR socket; `style-src` needs 'unsafe-inline'
    // because Vite's client injects <style> elements at runtime. Both only
    // ever apply to this developer-only document.
    const csp = [
        "default-src 'none'",
        `script-src ${devUrl} 'nonce-${nonce}'`,
        `style-src ${devUrl} 'unsafe-inline'`,
        `connect-src ${devUrl} ${ws}`,
        `img-src ${devUrl} data:`,
        `font-src ${devUrl} data:`,
        "form-action 'none'",
        "base-uri 'none'",
    ].join('; ');

    const withEntry = sourceHtml.replace(
        ENTRY_MARKER,
        `src="${devUrl}/src/main.tsx"`,
    );
    if (withEntry === sourceHtml) return null;

    // Vite only injects its own client when IT serves the document; here the
    // extension serves it, so HMR has to be requested explicitly, and before
    // the entry module or no change is ever applied.
    const withClient = withEntry.replace(
        `<script type="module" src="${devUrl}/src/main.tsx">`,
        `<script type="module" src="${devUrl}/@vite/client"></script>\n    <script type="module" src="${devUrl}/src/main.tsx">`,
    );
    if (withClient === withEntry) return null;

    const head = [
        `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
        `<script nonce="${nonce}">window.XRATU_LOCALE=${JSON.stringify(locale)};</script>`,
    ].join('\n');

    return withClient.replace(/<head>/i, `<head>\n${head}`);
}

/**
 * Wrap a `webview.postMessage` so every host→webview envelope is appended to
 * a JSONL tape before it is delivered.
 *
 * Generic over the signature so the wrapper is assignable straight back onto
 * `vscode.Webview.postMessage` without a cast.
 *
 * Recording MUST NOT be able to break the channel: an fs error is swallowed
 * and the original call always runs. The wrapper returns whatever the real
 * postMessage returns so callers awaiting it are unaffected.
 */
export function createRecordedPostMessage<M, R>(
    postMessage: (message: M) => R,
    append: (line: string) => void,
): (message: M) => R {
    return (message: M): R => {
        try {
            append(`${JSON.stringify({ at: Date.now(), message })}\n`);
        } catch {
            // A full disk or a bad path must never stop the UI from updating.
        }
        return postMessage(message);
    };
}

/** Parse a tape written by {@link createRecordedPostMessage}. */
export interface TapeEntry {
    at: number;
    message: unknown;
}

export function parseTape(text: string): TapeEntry[] {
    const entries: TapeEntry[] = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed) as TapeEntry;
            if (parsed && typeof parsed.at === 'number' && 'message' in parsed) entries.push(parsed);
        } catch {
            // A truncated final line is normal when reading a live log; skip it.
        }
    }
    return entries;
}
