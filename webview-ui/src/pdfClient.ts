// Client-side PDF processing for composer attachments (webview runtime).
//
// The webview is the ONE processing point for PDFs: it has a canvas (the
// Node extension host does not) and pdfjs-dist is already a dependency.  A
// text PDF is re-packaged as a text/plain attachment - identical to the
// host-side extraction pipeline (extension/src/pdfExtract.ts, which remains
// as a fail-closed safety net for anything that slips past us).  A SCANNED
// (image-only) PDF - previously a hard error - now renders its first pages
// to JPEG images so vision models can actually read it.

const PDF_TEXT_MAX_CHARS = 24_000;
const PDF_TEXT_MAX_PAGES = 60;
export const PDF_SCAN_MAX_PAGES = 5;
/** Rendered scan pages target this width (px) before JPEG encoding. */
const PDF_SCAN_TARGET_WIDTH = 1200;
/** Canvas height ceiling: a crafted extremely-tall single page would else
 *  allocate a huge RGBA buffer BEFORE any per-attachment size check runs. */
const PDF_SCAN_MAX_HEIGHT = 4000;

type MinimalPdfjs = {
    getDocument(src: Record<string, unknown>): { promise: Promise<any> };
};

let pdfjsPromise: Promise<MinimalPdfjs> | null = null;

async function loadPdfjs(): Promise<MinimalPdfjs> {
    if (!pdfjsPromise) {
        pdfjsPromise = (async () => {
            const pdfjs = (await import('pdfjs-dist/build/pdf.mjs')) as unknown as MinimalPdfjs;
            // Main-thread fake worker: pdfjs reads globalThis.pdfjsWorker
            // (PDFWorker.#mainThreadWorkerMessageHandler) and skips Worker
            // creation entirely - no CSP worker-src needed.  The worker
            // module only EXPORTS the handler, so register it ourselves.
            const worker = await import('pdfjs-dist/build/pdf.worker.mjs');
            (globalThis as Record<string, unknown>).pdfjsWorker = worker;
            return pdfjs;
        })();
    }
    return pdfjsPromise;
}

function base64ToBytes(dataBase64: string): Uint8Array {
    return Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
}

async function canvasToBase64(canvas: HTMLCanvasElement): Promise<string> {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('jpeg encode failed');
    const out = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < out.length; i += 0x8000) {
        binary += String.fromCharCode(...out.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

export type PdfProcessing =
    | { kind: 'text'; text: string }
    | { kind: 'scan'; pages: { page: number; dataBase64: string }[]; pageCount: number };

export async function processPdf(dataBase64: string): Promise<PdfProcessing> {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({
        data: base64ToBytes(dataBase64),
        isEvalSupported: false,
        disableFontFace: true,
    }).promise;

    // 1) Text layer first - the cheapest and most token-efficient path.
    let text = '';
    const textLimit = Math.min(doc.numPages, PDF_TEXT_MAX_PAGES);
    for (let i = 1; i <= textLimit; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
            .map((item: unknown) => {
                const str = (item as { str?: unknown })?.str;
                return typeof str === 'string' ? str : '';
            })
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        page.cleanup();
        if (pageText) {
            text += (text ? '\n\n' : '') + `--- Page ${i} ---\n` + pageText;
        }
        if (text.length > PDF_TEXT_MAX_CHARS) break;
    }
    if (text.trim()) {
        const truncated = text.length > PDF_TEXT_MAX_CHARS;
        return { kind: 'text', text: text.slice(0, PDF_TEXT_MAX_CHARS) + (truncated ? '\n… [PDF truncated, character cap reached]' : '') };
    }

    // 2) Image-only PDF: render pages for the vision model.
    const pages: { page: number; dataBase64: string }[] = [];
    const scanLimit = Math.min(doc.numPages, PDF_SCAN_MAX_PAGES);
    for (let i = 1; i <= scanLimit; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(
            2,
            Math.max(1, PDF_SCAN_TARGET_WIDTH / base.width),
            Math.max(1, PDF_SCAN_MAX_HEIGHT / base.height)
        );
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas unavailable');
        await page.render({ canvasContext: ctx, viewport }).promise;
        pages.push({ page: i, dataBase64: await canvasToBase64(canvas) });
        page.cleanup();
    }
    return { kind: 'scan', pages, pageCount: doc.numPages };
}
