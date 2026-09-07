// Minimal ambient declarations for pdfjs-dist (the package ships .d.mts
// types that don't resolve under this tsconfig's bundler resolution for
// the .mjs entry points).
declare module 'pdfjs-dist/build/pdf.mjs' {
    export const GlobalWorkerOptions: { workerSrc: string; workerPort: unknown };
    export function getDocument(src: Record<string, unknown>): { promise: Promise<any> };
    export const version: string;
}

declare module 'pdfjs-dist/build/pdf.worker.mjs';
