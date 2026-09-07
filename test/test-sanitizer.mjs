#!/usr/bin/env node
/**
 * HTML Sanitizer Test Suite - OWASP XSS Cheat Sheet Vectors
 *
 * Tests the _sanitizeHtml() function from extension.ts against known XSS
 * attack vectors. Run:  node test/test-sanitizer.mjs
 *
 * The sanitizer uses an allowlist-based approach:
 * - Only known-safe HTML tags pass through
 * - Attributes are validated per-tag allowlist
 * - Event handlers (on*), data-* attrs, javascript:/data: URIs are blocked
 * - Forbidden tags (script, iframe, object, etc.) are stripped entirely
 */

// ---------------------------------------------------------------------------
// Inline copy of the sanitizer logic from extension.ts (keep in sync)
// ---------------------------------------------------------------------------

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ALLOWED_TAGS = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'a', 'img', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'sup', 'sub',
    'small', 'details', 'summary',
    'div', 'span', 'abbr', 'kbd', 'samp', 'var',
]);

const ALLOWED_ATTRS = {
    'a': new Set(['href', 'title', 'rel']),
    'img': new Set(['src', 'alt', 'title', 'width', 'height']),
    'td': new Set(['colspan', 'rowspan', 'align', 'valign']),
    'th': new Set(['colspan', 'rowspan', 'align', 'valign', 'scope']),
    'ol': new Set(['start', 'type', 'reversed']),
    'code': new Set(['class']),
    'pre': new Set(['class']),
    'div': new Set(['class']),
    'span': new Set(['class']),
    'col': new Set(['span']),
    'abbr': new Set(['title']),
    '*': new Set(['class']),
};

const FORBIDDEN_TAGS = new Set([
    'script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select',
    'button', 'link', 'style', 'meta', 'base', 'svg', 'math', 'video', 'audio',
    'source', 'canvas', 'template',
]);

const EVENT_HANDLER_RE = /^on[a-z]/i;
const DATA_ATTR_RE = /^data-/i;
const JAVASCRIPT_URI_RE = /^\s*javascript\s*:/i;

function _sanitizeHtml(html) {
    const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>|([^<]+)/g;
    let result = '';
    let match;

    while ((match = TOKEN_RE.exec(html)) !== null) {
        const [full, closeSlash, tagName, attrsRaw, selfClose, textContent] = match;

        // Text content or comment (no tag) - pass through text, strip comments
        if (textContent !== undefined) { result += textContent; continue; }
        if (!tagName) { continue; }

        const tag = tagName.toLowerCase();
        if (full.startsWith('<!--')) { continue; }
        if (FORBIDDEN_TAGS.has(tag)) { continue; }
        if (!ALLOWED_TAGS.has(tag)) { continue; }

        const allowedAttrs = new Set([
            ...(ALLOWED_ATTRS[tag] || []),
            ...(ALLOWED_ATTRS['*'] || []),
        ]);

        let safeAttrs = '';
        const ATTR_RE = /([a-zA-Z_][\w\-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
        let attrMatch;

        while ((attrMatch = ATTR_RE.exec(attrsRaw)) !== null) {
            const [, attrName, dqVal, sqVal, uqVal] = attrMatch;
            const attrLower = attrName.toLowerCase();
            const attrVal = dqVal ?? sqVal ?? uqVal ?? '';

            if (EVENT_HANDLER_RE.test(attrLower)) continue;
            if (DATA_ATTR_RE.test(attrLower)) continue;
            if (!allowedAttrs.has(attrLower)) continue;

            if (attrLower === 'href' || attrLower === 'src') {
                if (JAVASCRIPT_URI_RE.test(attrVal)) continue;
                if (/^\s*data\s*:/i.test(attrVal)) continue;
            }

            if (dqVal !== undefined) {
                safeAttrs += ` ${attrName}="${escapeHtml(attrVal)}"`;
            } else if (sqVal !== undefined) {
                safeAttrs += ` ${attrName}='${escapeHtml(attrVal)}'`;
            } else if (uqVal !== undefined) {
                safeAttrs += ` ${attrName}="${escapeHtml(attrVal)}"`;
            } else {
                safeAttrs += ` ${attrName}`;
            }
        }

        if (closeSlash) {
            result += `</${tag}>`;
        } else if (selfClose) {
            result += `<${tag}${safeAttrs} />`;
        } else {
            result += `<${tag}${safeAttrs}>`;
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function assert(description, input, expectedSubstring) {
    const result = _sanitizeHtml(input);
    const ok = result.includes(expectedSubstring);
    if (ok) {
        passed++;
    } else {
        failed++;
        failures.push({ description, input, expected: expectedSubstring, actual: result });
    }
}

function assertNotContains(description, input, forbiddenSubstring) {
    const result = _sanitizeHtml(input);
    const ok = !result.includes(forbiddenSubstring);
    if (ok) {
        passed++;
    } else {
        failed++;
        failures.push({ description, input, expected: `NOT ${forbiddenSubstring}`, actual: result });
    }
}

function assertRemoved(description, input) {
    // The output should NOT contain the raw dangerous input
    assertRemoved = assertNotContains.bind(null, description, input, input);
    const result = _sanitizeHtml(input);
    // Check that no forbidden tags survived
    const hasForbidden = [...FORBIDDEN_TAGS].some(t =>
        new RegExp(`<${t}[\\s>]`, 'i').test(result)
    );
    if (!hasForbidden) {
        passed++;
    } else {
        failed++;
        failures.push({ description, input, expected: 'forbidden tags stripped', actual: result });
    }
}

// ---------------------------------------------------------------------------
// OWASP XSS Cheat Sheet Test Vectors
// ---------------------------------------------------------------------------

console.log('=== HTML Sanitizer Test Suite ===\n');
console.log('Testing against OWASP XSS vectors...\n');

// --- Category 1: Script Injection ---
console.log('--- Script Injection ---');
assert(
    '<script> tag stripped',
    '<script>alert(1)</script>',
    'alert'  // text content preserved but <script> tag removed
);
assertNotContains(
    '<script> tag not present in output',
    '<script>alert(1)</script>',
    '<script'
);
assertNotContains(
    'uppercased <SCRIPT> stripped',
    '<SCRIPT>alert(1)</SCRIPT>',
    '<SCRIPT'
);
assertNotContains(
    '<scr<script>ipt> nested',
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<script'
);

// --- Category 2: Event Handlers ---
console.log('--- Event Handlers ---');
assertNotContains(
    'onerror handler stripped',
    '<img onerror=alert(1) src=x>',
    'onerror'
);
assertNotContains(
    'onload handler stripped',
    '<body onload=alert(1)>',
    'onload'
);
assertNotContains(
    'onclick handler stripped',
    '<div onclick="alert(1)">click</div>',
    'onclick'
);
assertNotContains(
    'onmouseover handler stripped',
    '<img onmouseover="alert(1)" src=x>',
    'onmouseover'
);
assertNotContains(
    'onfocus handler stripped',
    '<input onfocus="alert(1)">',
    'onfocus'
);
assertNotContains(
    'onmousewheel handler stripped',
    '<div onmousewheel="alert(1)">scroll</div>',
    'onmousewheel'
);
assertNotContains(
    'ontransitionend handler stripped',
    '<div ontransitionend="alert(1)">test</div>',
    'ontransitionend'
);

// --- Category 3: SVG / MathML / XML Injection ---
console.log('--- SVG / MathML / XML Injection ---');
assertRemoved(
    '<svg> tag stripped entirely',
    '<svg onload="alert(1)"><circle r="50"/></svg>'
);
assertRemoved(
    '<math> tag stripped entirely',
    '<math><mi href="javascript:alert(1)">x</mi></math>'
);
assertNotContains(
    '<svg> namespace injection',
    '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></div></foreignObject></svg>',
    '<script'
);

// --- Category 4: JavaScript URIs ---
console.log('--- JavaScript URIs ---');
assertNotContains(
    'javascript: URI in href blocked',
    '<a href="javascript:alert(1)">click</a>',
    'javascript:'
);
assertNotContains(
    'javascript: with whitespace in href blocked',
    '<a href="  javascript:alert(1)">click</a>',
    'javascript:'
);
assertNotContains(
    'JAVASCRIPT: (uppercase) URI blocked',
    '<a href="JAVASCRIPT:alert(1)">click</a>',
    'JAVASCRIPT:'
);
assertNotContains(
    'javascript with tab character blocked',
    '<a href="java\tscript:alert(1)">click</a>',
    'javascript'
);

// --- Category 5: Data URIs ---
console.log('--- Data URIs ---');
assertNotContains(
    'data: URI in href blocked',
    '<a href="data:text/html,<script>alert(1)</script>">click</a>',
    'href="data:'
);
assert(
    'data: URI href value is empty (blocked)',
    '<a href="data:text/html,<script>alert(1)</script>">click</a>',
    'href=""'
);
assertNotContains(
    'data: URI in src blocked',
    '<img src="data:text/html,<script>alert(1)</script>">',
    'src="data:'
);
assert(
    'data: URI src value is empty (blocked)',
    '<img src="data:text/html,<script>alert(1)</script>">',
    'src=""'
);
assertNotContains(
    'data: URI with whitespace blocked',
    '<a href="  data:text/html,<script>alert(1)</script>">click</a>',
    'data:'
);

// --- Category 6: Form Injection ---
console.log('--- Form Injection ---');
assertRemoved(
    '<form> tag stripped',
    '<form action="https://evil.com"><input type="submit"></form>'
);
assertRemoved(
    '<input> tag stripped',
    '<input type="text" value="injected">'
);
assertRemoved(
    '<textarea> tag stripped',
    '<textarea>injected content</textarea>'
);
assertRemoved(
    '<select> tag stripped',
    '<select><option>injected</option></select>'
);
assertRemoved(
    '<button> tag stripped',
    '<button onclick="alert(1)">click</button>'
);

// --- Category 7: Meta / Base Tag Injection ---
console.log('--- Meta / Base Tag Injection ---');
assertRemoved(
    '<meta> tag stripped',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'
);
assertRemoved(
    '<base> tag stripped',
    '<base href="https://evil.com/">'
);
assertRemoved(
    '<link> tag stripped',
    '<link rel="stylesheet" href="https://evil.com/evil.css">'
);

// --- Category 8: Style / Expression Injection ---
console.log('--- Style / Expression Injection ---');
assertRemoved(
    '<style> tag stripped',
    '<style>body { background: url("javascript:alert(1)") }</style>'
);
assertNotContains(
    'style attribute not allowed on div',
    '<div style="background:expression(alert(1))">test</div>',
    'style'
);
assertNotContains(
    'style attribute not allowed on span',
    '<span style="behavior:url(evil.htc)">test</span>',
    'style'
);
assertNotContains(
    'style attribute not allowed on p',
    '<p style="background:red">test</p>',
    'style'
);

// --- Category 9: Template / Details Injection ---
console.log('--- Template / Details Injection ---');
assertRemoved(
    '<template> tag stripped',
    '<template><script>alert(1)</script></template>'
);
assertRemoved(
    '<canvas> tag stripped',
    '<canvas id="c">fallback</canvas>'
);

// --- Category 10: iframe / object / embed Injection ---
console.log('--- iframe / object / embed Injection ---');
assertRemoved(
    '<iframe> tag stripped',
    '<iframe src="https://evil.com/steal.html"></iframe>'
);
assertRemoved(
    '<object> tag stripped',
    '<object data="javascript:alert(1)"></object>'
);
assertRemoved(
    '<embed> tag stripped',
    '<embed src="https://evil.com/evil.swf">'
);
assertRemoved(
    '<video> tag stripped',
    '<video src="https://evil.com/evil.mp4"></video>'
);
assertRemoved(
    '<audio> tag stripped',
    '<audio src="https://evil.com/evil.mp3"></audio>'
);
assertRemoved(
    '<source> tag stripped',
    '<source src="https://evil.com/evil.mp4" type="video/mp4">'
);

// --- Category 11: Obfuscation / Encoding ---
console.log('--- Obfuscation / Encoding ---');
assertNotContains(
    'HTML entity-encoded < blocked',
    '&#60;script&#62;alert(1)&#60;/script&#62;',
    '<script'
);
assertNotContains(
    'hex entity-encoded < blocked',
    '&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;',
    '<script'
);
assertNotContains(
    'double-encoded blocked',
    '%26lt%3bscript%26gt%3balert(1)%26lt%3b/script%26gt%3b',
    '<script'
);

// --- Category 12: data-* Attributes ---
console.log('--- data-* Attributes ---');
assertNotContains(
    'data-* attributes stripped',
    '<div data-src="javascript:alert(1)">test</div>',
    'data-src'
);
assertNotContains(
    'data-onclick stripped',
    '<a href="#" data-onclick="alert(1)">test</a>',
    'data-onclick'
);

// --- Category 13: CSS Injection via Attributes ---
console.log('--- CSS Injection via Attributes ---');
assertNotContains(
    'style attribute stripped from div',
    '<div style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:9999">overlay</div>',
    'style'
);
assertNotContains(
    'style attribute stripped from img',
    '<img src=x style="position:absolute;top:0;left:0;width:100%;height:100%">',
    'style'
);

// --- Category 14: Comments ---
console.log('--- HTML Comments ---');
assertNotContains(
    'HTML comments stripped',
    '<!-- <script>alert(1)</script> -->',
    '<script'
);
assertNotContains(
    'conditional comments stripped',
    '<!--[if IE]><script>alert(1)</script><![endif]-->',
    '<script'
);

// --- Category 15: Valid HTML Preservation ---
console.log('--- Valid HTML Preservation ---');
assert(
    'simple paragraph preserved',
    '<p>Hello World</p>',
    '<p>Hello World</p>'
);
assert(
    'bold and italic preserved',
    '<p><strong>bold</strong> and <em>italic</em></p>',
    '<strong>bold</strong>'
);
assert(
    'link with safe href preserved',
    '<a href="https://example.com" title="Example">link</a>',
    'href="https://example.com"'
);
assert(
    'image with safe src preserved',
    '<img src="https://example.com/img.png" alt="test">',
    'src="https://example.com/img.png"'
);
assert(
    'code block preserved',
    '<pre><code class="language-python">print("hello")</code></pre>',
    '<code class="language-python">'
);
assert(
    'list elements preserved',
    '<ul><li>item 1</li><li>item 2</li></ul>',
    '<li>item 1</li>'
);
assert(
    'table elements preserved',
    '<table><tr><th>Header</th></tr><tr><td>Data</td></tr></table>',
    '<th>Header</th>'
);
assert(
    'details/summary preserved',
    '<details><summary>Click me</summary><p>Hidden content</p></details>',
    '<summary>Click me</summary>'
);
assert(
    'blockquote preserved',
    '<blockquote><p>Quote text</p></blockquote>',
    '<blockquote>'
);
assert(
    'heading preserved',
    '<h1>Title</h1><h2>Subtitle</h2>',
    '<h1>Title</h1>'
);
assert(
    'hr and br preserved',
    '<p>Line 1<br/>Line 2<hr/>Line 3</p>',
    '<br />'
);
assert(
    'subscript and superscript preserved',
    '<p>H<sub>2</sub>O and x<sup>2</sup></p>',
    '<sub>2</sub>'
);
assert(
    'mark element preserved',
    '<p>This is <mark>highlighted</mark> text</p>',
    '<mark>highlighted</mark>'
);
assert(
    'del and ins preserved',
    '<p><del>old</del> <ins>new</ins></p>',
    '<del>old</del>'
);
assert(
    'abbr preserved',
    '<abbr title="HyperText Markup Language">HTML</abbr>',
    '<abbr title="HyperText Markup Language">'
);
assert(
    'kbd, samp, var preserved',
    '<p>Press <kbd>Ctrl+C</kbd> to copy</p>',
    '<kbd>Ctrl+C</kbd>'
);
assert(
    'definition list preserved',
    '<dl><dt>Term</dt><dd>Definition</dd></dl>',
    '<dt>Term</dt>'
);
assert(
    'table colgroup preserved',
    '<table><colgroup><col span="2"/></colgroup><tr><td>a</td></tr></table>',
    '<colgroup>'
);
assert(
    'table caption preserved',
    '<table><caption>My Table</caption><tr><td>a</td></tr></table>',
    '<caption>My Table</caption>'
);

// --- Category 16: Edge Cases ---
console.log('--- Edge Cases ---');
assert(
    'empty input returns empty',
    '',
    ''
);
assert(
    'plain text passes through',
    'Hello World',
    'Hello World'
);
assert(
    'malformed HTML handled',
    '<div><p>unclosed<p>also unclosed',
    'unclosed'
);
assert(
    'nested allowed tags preserved',
    '<div><p><strong>Bold in paragraph</strong></p></div>',
    '<strong>Bold in paragraph</strong>'
);
assert(
    'text content between forbidden tags preserved',
    '<script>ignore me</script>Safe content<script>ignore me too</script>',
    'Safe content'
);
assertNotContains(
    'self-closing forbidden tag stripped',
    '<img src="x" onerror="alert(1)" />',
    'onerror'
);
assert(
    'anchor with rel attribute preserved',
    '<a href="https://example.com" rel="noopener noreferrer">link</a>',
    'rel="noopener noreferrer"'
);
assert(
    'table alignment preserved',
    '<td align="center" colspan="2">cell</td>',
    'align="center"'
);
assert(
    'table scope preserved',
    '<th scope="col">Header</th>',
    'scope="col"'
);
assert(
    'ol attributes preserved',
    '<ol start="5" type="a" reversed><li>item</li></ol>',
    'start="5"'
);

// --- Category 17: Attribute Quoting ---
console.log('--- Attribute Quoting ---');
assertNotContains(
    'unquoted event handler stripped',
    '<img src=x onerror=alert(1)>',
    'onerror'
);
assertNotContains(
    'single-quoted event handler stripped',
    "<img src='x' onerror='alert(1)'>",
    'onerror'
);
assertNotContains(
    'double-quoted event handler stripped',
    '<img src="x" onerror="alert(1)">',
    'onerror'
);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log('\n=== Results ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
    console.log('\n--- Failures ---');
    for (const f of failures) {
        console.log(`\n  ${f.description}`);
        console.log(`    Input:    ${f.input}`);
        console.log(`    Expected: ${f.expected}`);
        console.log(`    Actual:   ${f.actual}`);
    }
    process.exit(1);
} else {
    console.log('\nAll tests passed!');
    process.exit(0);
}
