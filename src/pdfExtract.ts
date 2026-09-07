// PDF text extraction for composer attachments (host-side, Node runtime).
//
// WHY HOST-SIDE: the local agent runtime never touches the cloud backend, so
// extraction must live in the extension for BOTH paths to benefit. Extracted
// text is re-packaged as a text/plain attachment and flows through the exact
// same fenced-block pipeline as text files - cloud and local, one code path.
// The backend keeps rejecting application/pdf (fail-closed) so a client that
// bypasses the host can never ship raw PDF bytes to a model.
//
// Engine: pdfjs-dist legacy build (pinned 4.x - v5/v6 hard-require DOMMatrix
// at module load, which does not exist in the Node extension host). Only the
// TEXT layer is extracted; scanned/image-only PDFs yield no text and fail
// with a clear message (vision-based page rendering is a future path).

import * as path from 'path';
import { pathToFileURL } from 'url';

/** Aligned with the backend's ATTACHMENT_TEXT_MAX_CHARS so an extracted PDF
 *  passes backend re-validation without a second truncation marker. */
const PDF_TEXT_MAX_CHARS = 24_000;
/** Hard page cap: a 1000-page PDF must not freeze the extension host. */
const PDF_MAX_PAGES = 60;

export interface ExtractableAttachment {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    dataBase64: string;
}

export interface PdfExtractionResult {
    text: string;
    pages: number;
    /** True when the document has a page count beyond the cap. */
    truncatedByPages: boolean;
}

type MinimalPdfjs = {
    GlobalWorkerOptions: { workerSrc: string };
    getDocument(src: Record<string, unknown>): { promise: Promise<any> };
};

let workerConfigured = false;

async function loadPdfjs(): Promise<MinimalPdfjs> {
    // Dynamic import keeps the (heavy) parser out of every cold start.
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as MinimalPdfjs;
    if (!workerConfigured) {
        // esbuild.js copies the worker next to dist/extension.js; the fake
        // worker loader resolves relative to the bundle location. It loads
        // the file with a dynamic ESM import(), which on Windows REQUIRES a
        // file:// URL - a raw C:\...\pdf.worker.min.mjs path throws
        // ERR_UNSUPPORTED_ESM_URL_SCHEME.
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(__dirname, 'pdf.worker.min.mjs')).href;
        workerConfigured = true;
    }
    return pdfjs;
}

export async function extractPdfText(data: Uint8Array): Promise<PdfExtractionResult> {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({
        data,
        isEvalSupported: false,
        disableFontFace: true,
        useWorkerFetch: false,
    }).promise;

    const pageCount: number = doc.numPages;
    const pageLimit = Math.min(pageCount, PDF_MAX_PAGES);
    let text = '';
    for (let i = 1; i <= pageLimit; i++) {
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

    if (text.length > PDF_TEXT_MAX_CHARS) {
        text = text.slice(0, PDF_TEXT_MAX_CHARS)
            + `\n… [PDF truncated, ${PDF_TEXT_MAX_CHARS} character cap reached]`;
    }

    return { text, pages: pageCount, truncatedByPages: pageCount > PDF_MAX_PAGES };
}

/**
 * Convert PDF attachments into text/plain attachments carrying the extracted,
 * page-marked text. Other attachments pass through untouched.
 * Returns the transformed list, or an error string (user-facing, Persian -
 * host error strings are Persian by convention) when extraction fails.
 */
export async function extractPdfAttachments(
    attachments: ExtractableAttachment[]
): Promise<{ attachments: ExtractableAttachment[]; error?: { key: string; params?: Record<string, string> } }> {
    if (!attachments.some((a) => a.mimeType === 'application/pdf')) {
        return { attachments };
    }
    const out: ExtractableAttachment[] = [];
    for (const a of attachments) {
        if (a.mimeType !== 'application/pdf') {
            out.push(a);
            continue;
        }
        let result: PdfExtractionResult;
        try {
            const bytes = new Uint8Array(Buffer.from(a.dataBase64, 'base64'));
            result = await extractPdfText(bytes);
        } catch {
            return {
                attachments,
                error: { key: 'pdfExtractFailed', params: { name: a.name } },
            };
        }
        if (!result.text.trim()) {
            return {
                attachments,
                error: { key: 'pdfNoTextLayer', params: { name: a.name } },
            };
        }
        let payload = result.text;
        if (result.truncatedByPages) {
            payload += `\n\n[PDF had ${result.pages} pages; first ${PDF_MAX_PAGES} included]`;
        }
        const block = `[Attached PDF: ${a.name} (${result.pages} page(s)) - text layer extracted]\n\n${payload}`;
        out.push({
            id: a.id,
            name: a.name,
            // Re-labeled text/plain: flows through the standard text-attachment
            // pipeline (backend fenced block / local userText block).
            mimeType: 'text/plain',
            size: Buffer.byteLength(block, 'utf8'),
            dataBase64: Buffer.from(block, 'utf8').toString('base64'),
        });
    }
    return { attachments: out };
}
