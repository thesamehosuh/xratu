/**
 * Tool-image rendering SSR tests (replaces 7 slow browser loads in
 * test/e2e/tool-images.spec.ts with millisecond SSR markup assertions).
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MessageItem, ActivityTimeline } from '../src/components/MessageItem';
import { ToolImages } from '../src/components/ToolImages';
import { setLocale } from '../src/i18n';
import type { ChatMessage, Step } from '../src/types';

type ToolImage = NonNullable<Step['images']>[number];

const PNG_1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA_URL = `data:image/png;base64,${PNG_1x1}`;

function makeStep(images?: ToolImage[]): Step {
    return {
        id: 's1',
        kind: 'toolCall',
        tool: 'mcp__playwright__browser_take_screenshot',
        text: JSON.stringify({ url: 'https://example.com' }),
        result: 'Screenshot captured.',
        callId: 'call1',
        ...(images ? { images } : {}),
    };
}

function messageWithStep(step: Step, status: ChatMessage['status'] = 'streaming'): ChatMessage {
    return {
        id: 'm1',
        role: 'assistant',
        text: 'The page shows a checkout form.',
        status,
        createdAt: 1,
        steps: [step],
    };
}

// 1. ToolImages renders data URL, LTR gallery & figcaption in both locales, and MessageItem wires it.
for (const locale of ['en', 'fa'] as const) {
    setLocale(locale);
    const step = makeStep([{ mimeType: 'image/png', dataUrl: DATA_URL, caption: 'https://example.com/checkout' }]);
    const directHtml = renderToString(createElement(ToolImages, { call: step }));
    assert.ok(directHtml.includes(`src="${DATA_URL}"`), `${locale}: renders image data URL`);
    assert.ok(directHtml.includes('<figcaption dir="ltr">https://example.com/checkout</figcaption>'), `${locale}: URL caption stays LTR`);
    assert.ok(directHtml.includes('class="tool-images" dir="ltr"'), `${locale}: image gallery stays LTR`);

    const msgHtml = renderToString(createElement(MessageItem, {
        message: messageWithStep(step, 'done'),
        activityOnly: true,
        busy: false,
        transcriptPrefs: { expand: { mcp: true } },
    }));
    assert.ok(msgHtml.includes(`src="${DATA_URL}"`), `${locale}: MessageItem renders tool image when expanded`);
    assert.ok(!msgHtml.includes('class="step-status spinner"'), `${locale}: completed tool call has no spinner`);
}

// 2. Rendered images are capped at 4 and the remainder count is stated.
setLocale('en');
{
    const seven: ToolImage[] = Array.from({ length: 7 }, (_, i) => ({
        mimeType: 'image/png',
        dataUrl: DATA_URL,
        caption: `shot ${i + 1}`,
    }));
    const html = renderToString(createElement(ToolImages, { call: makeStep(seven) }));
    const imgCount = (html.match(/<img\b/g) ?? []).length;
    assert.equal(imgCount, 4, 'caps rendered images at 4');
    assert.match(html, /tool-images-more[^>]*>[^<]*3/, 'states 3 remaining images');
}

// 3. Captionless image still renders non-empty alt text and no figcaption.
setLocale('fa');
{
    const html = renderToString(createElement(ToolImages, { call: makeStep([{ mimeType: 'image/png', dataUrl: DATA_URL }]) }));
    assert.equal((html.match(/<img\b/g) ?? []).length, 1);
    assert.match(html, /<img[^>]+alt="[^"]+"/, 'captionless image carries non-empty alt');
    assert.ok(!html.includes('<figcaption'), 'captionless image omits figcaption');
}

// 4. Text-only tool result renders no .tool-images block in ToolImages, MessageItem, or ActivityTimeline.
setLocale('en');
{
    const step: Step = {
        id: 's2',
        kind: 'toolCall',
        tool: 'read_file',
        text: JSON.stringify({ path: 'a.ts' }),
        result: 'file body',
        callId: 'call2',
    };
    assert.equal(renderToString(createElement(ToolImages, { call: step })), '', 'text-only step returns empty markup');
    const textOnly = messageWithStep(step, 'done');
    const msgHtml = renderToString(createElement(MessageItem, { message: textOnly, busy: false }));
    assert.ok(!msgHtml.includes('tool-images'), 'text-only message renders no image block');
    const actHtml = renderToString(createElement(ActivityTimeline, { messages: [textOnly], busy: false }));
    assert.ok(!actHtml.includes('tool-images'), 'text-only activity renders no image block');
}

console.log('tool-images: all assertions passed');
