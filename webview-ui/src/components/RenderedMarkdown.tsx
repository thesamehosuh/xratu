import { useCallback, useRef } from 'react';
import type { MouseEvent } from 'react';
import { postMessage } from '../vscode';
import { t } from '../i18n';

const CHECK_ICON = '<svg class="check-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

/* Word-wave pacing for streamed output (mirrors StreamingText in
   MessageItem): words of one flush fade in 22ms apart, a flush unfolding in
   well under the host's 100ms live tick. */
const TOKEN_DELAY_MS = 22;
const TOKEN_WAVE_CAP_MS = 360;
const TOKEN_FADE_MS = 240;

/** One word's entrance, remembered across flushes so React's wholesale
 *  innerHTML reset cannot interrupt it. */
interface WordAnim {
    delayMs: number;
    at: number;
}

/** Wrap words past the previous text baseline in .stream-tok so each flush of
 *  streamed markdown fades in word by word instead of landing as a blob.
 *
 *  The host re-renders the segment's markdown wholesale every ~100ms tick
 *  (extension.ts `_flushLiveDisplay`) and React resets this container's
 *  innerHTML whenever the html string changes - so the wrap is baked into the
 *  html STRING (parsed with DOMParser, never touching the live DOM) and a
 *  word that is still fading when the next flush lands is re-wrapped with a
 *  NEGATIVE animation-delay that resumes its fade where it left off, instead
 *  of popping to full opacity or re-fading from zero.
 *
 *  `seen: null` is the baseline pass: the raw-text phase has already faded
 *  those words in, so they are measured but never wrapped. Returns the new
 *  baseline (total text length). */
function wrapStreamedHtml(
    html: string,
    anims: Map<number, WordAnim>,
    seen: number | null
): { html: string; seen: number } {
    // renderToString (webview unit tests) has no DOM - stream wrapping is a
    // browser-side nicety; the raw html is always correct.
    if (typeof DOMParser === 'undefined') return { html, seen: seen ?? 0 };
    const doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}</body>`, 'text/html');
    const body = doc.body;
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes: Array<{ node: Text; base: number }> = [];
    let total = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const node = n as Text;
        nodes.push({ node, base: total });
        total += node.data.length;
    }
    if (seen === null) return { html: body.innerHTML, seen: total };
    const now = Date.now();
    let wave = 0;
    for (const { node, base } of nodes) {
        // Controls own their markup (the code-copy button swaps its own
        // innerHTML) - never restructure their text.
        if (node.parentElement?.closest('button')) continue;
        const parts = node.data.split(/(\s+)/);
        const frag: Node[] = [];
        let pos = base;
        let changed = false;
        for (const part of parts) {
            const start = pos;
            pos += part.length;
            if (!part) continue;
            const isWord = !/^\s+$/.test(part);
            const prev = isWord ? anims.get(start) : undefined;
            const age = prev ? now - prev.at : Infinity;
            const span = () => {
                const s = doc.createElement('span');
                s.className = 'stream-tok';
                s.textContent = part;
                return s;
            };
            if (prev && age < prev.delayMs + TOKEN_FADE_MS) {
                // Still fading when the last flush reset the container -
                // resume that exact fade partway through.
                const s = span();
                s.style.animationDelay = `${prev.delayMs - age}ms`;
                frag.push(s);
                changed = true;
            } else if (isWord && start >= seen) {
                const delayMs = Math.min(wave++ * TOKEN_DELAY_MS, TOKEN_WAVE_CAP_MS);
                anims.set(start, { delayMs, at: now });
                const s = span();
                s.style.animationDelay = `${delayMs}ms`;
                frag.push(s);
                changed = true;
            } else {
                frag.push(doc.createTextNode(part));
            }
        }
        if (changed) node.replaceWith(...frag);
    }
    // Settled words never need resuming again - keep the map bounded.
    for (const [key, anim] of anims) {
        if (now - anim.at > anim.delayMs + TOKEN_FADE_MS + 200) anims.delete(key);
    }
    return { html: body.innerHTML, seen: total };
}

interface RenderedMarkdownProps {
    html: string;
    streaming?: boolean;
    /** Announce streamed changes to screen readers. Only set for ASSISTANT
     *  text - tool output must not be announced as if it were the answer. */
    live?: boolean;
}

export function RenderedMarkdown({ html, streaming = false, live = false }: RenderedMarkdownProps) {
    const seenRef = useRef<number | null>(null);
    const animsRef = useRef(new Map<number, WordAnim>());
    const cacheRef = useRef<{ src: string; out: string } | null>(null);

    // The wrap is derived from the source html string only: an unchanged
    // string must return the identical output or React would reset the
    // container and interrupt in-flight word fades for no reason.
    let rendered = html;
    if (streaming) {
        if (cacheRef.current?.src !== html) {
            const wrapped = wrapStreamedHtml(html, animsRef.current, seenRef.current);
            seenRef.current = wrapped.seen;
            cacheRef.current = { src: html, out: wrapped.html };
        }
        rendered = cacheRef.current.out;
    } else if (seenRef.current !== null || cacheRef.current) {
        seenRef.current = null;
        cacheRef.current = null;
        animsRef.current.clear();
    }

    const handleClick = useCallback(async (event: MouseEvent<HTMLDivElement>) => {
        const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.code-copy');
        if (!target) return;

        const block = target.closest('.code-block');
        const code = block?.querySelector('pre code')?.textContent
            ?? block?.querySelector('pre')?.textContent
            ?? '';

        const copyText = () => {
            target.innerHTML = t('copyCode');
        };

        try {
            postMessage({ type: 'copyToClipboard', value: code });
            target.innerHTML = CHECK_ICON;
            target.classList.add('copied');
            window.setTimeout(() => {
                copyText();
                target.classList.remove('copied');
            }, 1400);
        } catch {
            window.setTimeout(copyText, 1400);
        }
    }, []);

    return (
        <div
            className={`msg-content${streaming ? ' streaming' : ''}`}
            onClick={handleClick}
            aria-live={live ? 'polite' : undefined}
            aria-atomic={live ? 'false' : undefined}
            dangerouslySetInnerHTML={{ __html: rendered }}
        />
    );
}
