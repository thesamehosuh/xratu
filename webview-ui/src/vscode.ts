// The VS Code webview API is exposed as a global `acquireVsCodeApi`, not an
// importable module.  We declare a minimal shape here so the bundle has no
// runtime dependency on a `vscode` package.

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

export function postMessage(message: unknown): void {
    api?.postMessage(message);
}
