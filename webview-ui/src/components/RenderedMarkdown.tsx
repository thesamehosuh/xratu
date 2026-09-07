import { useCallback } from 'react';
import type { MouseEvent } from 'react';
import { postMessage } from '../vscode';
import { t } from '../i18n';

const CHECK_ICON = '<svg class="check-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

interface RenderedMarkdownProps {
    html: string;
    streaming?: boolean;
}

export function RenderedMarkdown({ html, streaming = false }: RenderedMarkdownProps) {
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
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}
