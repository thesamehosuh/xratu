import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { createHash } from 'crypto';
import { extractPdfText } from '../pdfExtract';
import { abortable } from '../oauth/refreshLock';
import { boundedBody, routedFetch } from './transport';
import { ResearchError, publicLink } from './types';

// No script execution, resource loading, or browser is involved in this DOM.
export function htmlToMarkdown(html: string, url: string): { text: string; title?: string } {
    const { document } = parseHTML(html);
    const title = document.querySelector('title')?.textContent?.trim().slice(0, 500);
    document.querySelectorAll('script,style,noscript,svg,nav,footer,header,aside,form,iframe').forEach(node => node.remove());
    const root = document.querySelector('article') ?? document.querySelector('main') ?? document.body ?? document;
    root.querySelectorAll('a').forEach(node => {
        const href = node.getAttribute('href');
        let resolved: string | undefined;
        try { resolved = href ? publicLink(new URL(href, url).href) : undefined; } catch { /* malformed external link */ }
        if (resolved) node.setAttribute('href', resolved); else node.removeAttribute('href');
    });
    const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    converter.remove(['img']);
    converter.addRule('tables', {
        filter: 'table',
        replacement: (_content, node) => {
            const rows = Array.from((node as unknown as Element).querySelectorAll('tr')).map(row =>
                Array.from(row.querySelectorAll('th,td')).map(cell => converter.turndown(cell.innerHTML).replace(/\|/g, '\\|').replace(/\n/g, ' ')));
            if (!rows.length) return '';
            const width = Math.max(...rows.map(row => row.length));
            const format = (row: string[]) => '| ' + Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ') + ' |';
            return '\n\n' + [format(rows[0]), format(Array(width).fill('---')), ...rows.slice(1).map(format)].join('\n') + '\n\n';
        },
    });
    return { text: converter.turndown(root.innerHTML ?? root.textContent ?? ''), title };
}
export interface ReadDocument { url: string; requestedUrl: string; text: string; title?: string; route: string; truncated?: boolean }
export async function readPublicPage(url: string, signal: AbortSignal, validate: (url: string) => Promise<string>): Promise<ReadDocument> {
    let current = url;
    for (let hop = 0; hop <= 4; hop++) {
        current = await abortable(validate(current), signal);
        const response = await abortable(routedFetch(current, { redirect: 'manual', signal, headers: { Accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8, application/pdf;q=0.7', 'User-Agent': 'Xratu/1.0' } }), signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            void response.body?.cancel().catch(() => undefined);
            if (!location) throw new ResearchError('unavailable', 'Redirect has no Location header.');
            current = new URL(location, current).href;
            continue;
        }
        if (!response.ok) {
            void response.body?.cancel().catch(() => undefined);
            throw new ResearchError(response.status === 403 ? 'blocked' : 'unavailable', `HTTP ${response.status} fetching page.`);
        }
        const type = response.headers.get('content-type')?.toLowerCase() ?? '';
        const bytes = await boundedBody(response, signal);
        let text: string;
        let title: string | undefined;
        let truncated = false;
        if (type.includes('application/pdf')) {
            const pdf = await abortable(extractPdfText(bytes, signal), signal);
            text = pdf.text;
            truncated = pdf.truncatedByPages || text.includes('[PDF truncated');
            if (!text.trim()) throw new ResearchError('unsupported', 'PDF has no text layer; use the approved browser to inspect it.');
        } else {
            if (!['text/', 'json', 'xml', 'javascript'].some(value => type.includes(value))) throw new ResearchError('unsupported', `Unsupported content type: ${type || 'unknown'}.`);
            const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? 'utf-8';
            try { text = new TextDecoder(charset).decode(bytes); } catch { text = new TextDecoder().decode(bytes); }
            if (type.includes('html')) ({ text, title } = htmlToMarkdown(text, current));
        }
        if (text.trim().length < 80 || /^(enable javascript|please enable javascript|just a moment)/i.test(text.trim())) throw new ResearchError('blocked', 'Page is empty or requires JavaScript. Try the approved browser when available.');
        return { text, title, url: current, requestedUrl: url, route: 'direct', truncated };
    }
    throw new ResearchError('blocked', 'Too many redirects.');
}

/** Ephemeral, bounded FIFO. Handles expire; never reuse one for a different body. */
export class DocumentStore {
    private documents = new Map<string, { document: ReadDocument; expires: number }>();
    put(document: ReadDocument): string {
        const handle = createHash('sha256').update(document.url + '\0' + document.text).digest('hex').slice(0, 24);
        this.documents.delete(handle);
        this.documents.set(handle, { document: { ...document, text: document.text.slice(0, 500_000), truncated: document.truncated || document.text.length > 500_000 }, expires: Date.now() + 300_000 });
        while (this.documents.size > 8) this.documents.delete(this.documents.keys().next().value!);
        return handle;
    }
    get(handle: string): ReadDocument {
        const entry = this.documents.get(handle);
        if (!entry || entry.expires < Date.now()) { this.documents.delete(handle); throw new ResearchError('unavailable', 'Document handle expired. Fetch the original URL again.'); }
        return entry.document;
    }
    clear(): void { this.documents.clear(); }
}
