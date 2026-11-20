#!/usr/bin/env node
/**
 * Allowlist HTML sanitizer regression suite (`src/sanitizeHtml.ts`).
 *
 * Imports the real compiled `out/sanitizeHtml.js` module directly (never an
 * inline copy) so any drift in `ALLOWED_TAGS`, `ALLOWED_ATTRS`, `sanitizeStyle`,
 * `escapeHtml`, or `TOKEN_RE` fails this suite immediately.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-sanitizer.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _sanitizeHtml, escapeHtml } = require('../out/sanitizeHtml.js');

// ---------------------------------------------------------------------------
// 1. escapeHtml
// ---------------------------------------------------------------------------
assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;', 'escapes all 5 HTML metacharacters');
assert.equal(escapeHtml('plain text 123'), 'plain text 123', 'leaves safe text unchanged');

// ---------------------------------------------------------------------------
// 2. Basic & empty inputs
// ---------------------------------------------------------------------------
assert.equal(_sanitizeHtml(''), '', 'empty input returns empty string');
assert.equal(_sanitizeHtml('Hello, world!'), 'Hello, world!', 'plain text preserved');

// ---------------------------------------------------------------------------
// 3. Forbidden tags stripped (never survive as HTML tags)
// ---------------------------------------------------------------------------
const forbiddenCases = [
    ['script', '<script>alert(1)</script>', '<script'],
    ['uppercase SCRIPT', '<SCRIPT>alert(1)</SCRIPT>', '<script'],
    ['mixed-case ScRiPt', '<ScRiPt>alert(1)</ScRiPt>', '<script'],
    ['script with attrs', '<script type="text/javascript" src="evil.js"></script>', '<script'],
    ['iframe', '<iframe src="https://evil.com"></iframe>', '<iframe'],
    ['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>', '<iframe'],
    ['object', '<object data="evil.swf"></object>', '<object'],
    ['embed', '<embed src="evil.swf">', '<embed'],
    ['form', '<form action="https://evil.com"><input name="x"></form>', '<form'],
    ['input', '<input type="text" onfocus="alert(1)" autofocus>', '<input'],
    ['textarea', '<textarea onfocus="alert(1)"></textarea>', '<textarea'],
    ['select', '<select><option>a</option></select>', '<select'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', '<meta'],
    ['base href', '<base href="https://evil.com/">', '<base'],
    ['link stylesheet', '<link rel="stylesheet" href="https://evil.com/x.css">', '<link'],
    ['style tag', '<style>body { background: url(javascript:alert(1)) }</style>', '<style'],
    ['math', '<math><mtext></mtext></math>', '<math'],
    ['template', '<template><script>alert(1)</script></template>', '<template'],
    ['canvas', '<canvas width="100" height="100"></canvas>', '<canvas'],
    ['video', '<video><source onerror="alert(1)"></video>', '<video'],
    ['audio', '<audio src="x" onerror="alert(1)"></audio>', '<audio'],
    ['source', '<source src="x" onerror="alert(1)">', '<source'],
    ['head/body/html/title', '<html><head><title>x</title></head><body><p>ok</p></body></html>', '<body'],
    ['applet/frame/marquee', '<applet></applet><frameset><frame></frameset><marquee>hi</marquee>', '<marquee'],
];

for (const [label, input, needle] of forbiddenCases) {
    const out = _sanitizeHtml(input);
    assert.ok(!out.toLowerCase().includes(needle), `${label}: tag must be stripped (got: ${out})`);
}

// ---------------------------------------------------------------------------
// 4. Event handlers & data-* attributes stripped on allowed tags
// ---------------------------------------------------------------------------
const attrStripCases = [
    ['img onerror', '<img src="local.png" onerror="alert(1)">', 'onerror'],
    ['a onclick', '<a href="https://example.com" onclick="alert(1)">x</a>', 'onclick'],
    ['div onmouseover', '<div onmouseover="alert(1)">hover</div>', 'onmouseover'],
    ['mixed-case OnClIcK', '<p OnClIcK="alert(1)">x</p>', 'onclick'],
    ['unquoted onload', '<img src="a.png" onload=alert(1)>', 'onload'],
    ['single-quoted onfocus', "<a href='#x' onfocus='alert(1)'>x</a>", 'onfocus'],
    ['button onclick', '<button type="button" onclick="alert(1)">Copy</button>', 'onclick'],
    ['svg onload', '<svg viewBox="0 0 16 16" onload="alert(1)"><path d="M0 0" onclick="alert(1)"/></svg>', 'onload'],
    ['svg path onclick', '<svg viewBox="0 0 16 16"><path d="M0 0" onclick="alert(1)"/></svg>', 'onclick'],
    ['data-* attribute', '<div data-secret="1" data-x="2" class="ok">hi</div>', 'data-'],
    ['disallowed id/tabindex', '<p id="x" tabindex="0">hi</p>', 'tabindex'],
];

for (const [label, input, forbidden] of attrStripCases) {
    const out = _sanitizeHtml(input);
    assert.ok(!out.toLowerCase().includes(forbidden), `${label}: must strip ${forbidden} (got: ${out})`);
}

// ---------------------------------------------------------------------------
// 5. URI protocol validation (javascript:, data:, remote img anti-beacon, `>` in quoted attrs)
// ---------------------------------------------------------------------------
const uriStripCases = [
    ['javascript: href', '<a href="javascript:alert(1)">click</a>', 'href='],
    ['mixed-case JaVaScRiPt:', '<a href="JaVaScRiPt:alert(1)">click</a>', 'href='],
    ['leading-space javascript:', '<a href="  javascript:alert(1)">click</a>', 'href='],
    ['unquoted javascript:', '<a href=javascript:alert(1)>click</a>', 'href='],
    ['data:text/html href', '<a href="data:text/html,hello">click</a>', 'href='],
    ['data: with embedded > (TOKEN_RE regression)', '<a href="data:text/html,<script>alert(1)</script>">click</a>', 'href='],
    ['single-quoted data: with embedded >', "<a href='data:text/html,<script>alert(1)</script>'>click</a>", 'href='],
    ['javascript: with embedded >', '<a href="javascript:if(a>b)alert(1)">click</a>', 'href='],
    ['data: img src', '<img src="data:image/svg+xml,<svg onload=alert(1)>">', 'src='],
    ['remote https img beacon blocked', '<img src="https://tracker.example/pixel.png" alt="pic">', 'src='],
    ['remote http img beacon blocked', '<img src="http://tracker.example/pixel.png" alt="pic">', 'src='],
];

for (const [label, input, forbidden] of uriStripCases) {
    const out = _sanitizeHtml(input);
    assert.ok(!out.toLowerCase().includes(forbidden), `${label}: must strip ${forbidden} (got: ${out})`);
    assert.ok(!out.toLowerCase().includes('data:text/html'), `${label}: must not leak data: URI (got: ${out})`);
    assert.ok(!out.toLowerCase().includes('javascript:'), `${label}: must not leak javascript: URI (got: ${out})`);
}

// Safe links & relative images are preserved.
{
    const link = _sanitizeHtml('<a href="https://example.com/docs" title="Docs" rel="noopener">Docs</a>');
    assert.equal(link, '<a href="https://example.com/docs" title="Docs" rel="noopener">Docs</a>');

    const anchor = _sanitizeHtml('<a href="#section-1">Jump</a>');
    assert.equal(anchor, '<a href="#section-1">Jump</a>');

    const relImg = _sanitizeHtml('<img src="assets/icon.png" alt="Icon" width="24" height="24" />');
    assert.equal(relImg, '<img src="assets/icon.png" alt="Icon" width="24" height="24" />');
}

// ---------------------------------------------------------------------------
// 6. Inline style allowlist (`sanitizeStyle`: Shiki hex color/background-color ONLY on pre/span)
// ---------------------------------------------------------------------------
{
    const shikiSpan = _sanitizeHtml('<span style="color:#ff00aa; background-color: #1e1e1e">tok</span>');
    assert.equal(shikiSpan, '<span style="color:#ff00aa; background-color: #1e1e1e">tok</span>');

    const shikiPre = _sanitizeHtml('<pre class="shiki" style="background-color:#24292e;color:#e1e4e8"><code>x</code></pre>');
    assert.equal(shikiPre, '<pre class="shiki" style="background-color:#24292e; color:#e1e4e8"><code>x</code></pre>');

    const mixedStyle = _sanitizeHtml('<span style="color:#fff; position:fixed; background-image:url(https://evil.com); background-color:#000000">x</span>');
    assert.equal(mixedStyle, '<span style="color:#fff; background-color:#000000">x</span>', 'keeps only hex color/background-color declarations');

    const maliciousStyle = _sanitizeHtml('<span style="background:url(javascript:alert(1)); expression(alert(1))">x</span>');
    assert.equal(maliciousStyle, '<span>x</span>', 'drops style attr completely when no safe declarations remain');

    const nonHexColor = _sanitizeHtml('<span style="color:red; background-color:rgb(0,0,0)">x</span>');
    assert.equal(nonHexColor, '<span>x</span>', 'rejects non-hex color values');

    const styleOnDiv = _sanitizeHtml('<div style="color:#fff" class="box">x</div>');
    assert.equal(styleOnDiv, '<div class="box">x</div>', 'style is disallowed outside pre/span');
}

// ---------------------------------------------------------------------------
// 7. Legitimate UI & Markdown markup preserved (including button + copy-icon SVG)
// ---------------------------------------------------------------------------
{
    const copyBtn = '<button type="button" class="copy-btn" title="Copy" aria-label="Copy code">'
        + '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
        + '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />'
        + '<path d="M4 16V4h12" />'
        + '</svg></button>';
    assert.equal(_sanitizeHtml(copyBtn), copyBtn, 'preserves allowed copy button and SVG icon markup');

    const table = '<table><thead><tr><th scope="col">A</th></tr></thead><tbody><tr><td colspan="2" align="left">1</td></tr></tbody></table>';
    assert.equal(_sanitizeHtml(table), table, 'preserves tables and allowed cell attributes');

    const markdown = '<h2>Title</h2><p><strong>Bold</strong> and <em>italic</em> with <code class="lang-ts">x</code></p><blockquote><p>q</p></blockquote><hr />';
    assert.equal(_sanitizeHtml(markdown), markdown, 'preserves standard markdown HTML');
}

// ---------------------------------------------------------------------------
// 8. HTML comments and unknown tags stripped
// ---------------------------------------------------------------------------
assert.equal(_sanitizeHtml('before<!-- <script>alert(1)</script> -->after'), 'beforeafter', 'strips HTML comments');
assert.equal(_sanitizeHtml('<custom-widget foo="bar">keep text</custom-widget>'), 'keep text', 'strips unknown tags while keeping inner text');

console.log('sanitizer: all assertions passed');
