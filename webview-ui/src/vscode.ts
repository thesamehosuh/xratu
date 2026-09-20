// The VS Code webview API is exposed as a global `acquireVsCodeApi`, not an
// importable module.  We declare a minimal shape here so the bundle has no
// runtime dependency on a `vscode` package.
import type { ToExtensionMessage } from './types';

interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;
try {
    api = acquireVsCodeApi();
} catch {
    api = undefined;
}

/** Post a typed host message - the protocol union is the single source of
 *  truth, so a typo or missing field is a compile error, not a silent no-op. */
export function postMessage(message: ToExtensionMessage): void {
    api?.postMessage(message);
}
