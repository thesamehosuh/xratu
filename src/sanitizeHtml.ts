/**
 * Allowlist-based HTML sanitizer for webview content. Replaces the
 * regex-based XSS filter (blocklists are inherently bypassable): only
 * known-safe tag/attribute constructs pass through. Split out of
 * extension.ts, which imports `_sanitizeHtml` for the markdown path;
 * test/test-sanitizer.mjs keeps an inline copy of the logic in sync.
 */

export function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Allowlist-based HTML sanitizer for webview content.
// Replaces the regex-based XSS filter (blocklists are inherently bypassable).
// Uses a tag/attribute allowlist - only known-safe constructs pass through.
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'pre', 'code', 'blockquote',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'a', 'img', 'button', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark',
    'sup', 'sub', 'small', 'details', 'summary',
    'div', 'span', 'abbr', 'kbd', 'samp', 'var',
    'svg', 'path', 'rect', 'polyline', 'line', 'circle',
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
    'a': new Set(['href', 'title', 'rel']),
    'button': new Set(['type', 'title', 'aria-label']),
    'img': new Set(['src', 'alt', 'title', 'width', 'height']),
    'td': new Set(['colspan', 'rowspan', 'align', 'valign']),
    'th': new Set(['colspan', 'rowspan', 'align', 'valign', 'scope']),
    'ol': new Set(['start', 'type', 'reversed']),
    'code': new Set(['class']),   // for shiki language classes
    'pre': new Set(['class', 'style']),   // shiki theme background
    'div': new Set(['class']),    // for shiki wrapper
    'span': new Set(['class', 'style']),  // shiki token colors
    'col': new Set(['span']),
    'abbr': new Set(['title']),
    'svg': new Set(['xmlns', 'width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'class']),
    'path': new Set(['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']),
    'rect': new Set(['width', 'height', 'x', 'y', 'rx', 'ry', 'fill', 'stroke']),
    'polyline': new Set(['points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']),
    'line': new Set(['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width']),
    'circle': new Set(['cx', 'cy', 'r', 'fill', 'stroke']),
    '*': new Set(['class']),      // allow class on all tags
};

const FORBIDDEN_TAGS = new Set([
    'script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea',
    'select', 'link', 'style', 'meta', 'base', 'math',
    'video', 'audio', 'source', 'canvas', 'template', 'head', 'body',
    'html', 'title', 'frame', 'frameset', 'applet', 'marquee',
]);

const EVENT_HANDLER_RE = /^on[a-z]/i;
const DATA_ATTR_RE = /^data-/i;
const JAVASCRIPT_URI_RE = /^\s*javascript\s*:/i;

/**
 * Inline styles are only safe for syntax highlighting: permit exactly the
 * two color properties shiki emits, with hex values, nothing else.
 */
function sanitizeStyle(value: string): string {
    const kept = value
        .split(';')
        .map((decl) => decl.trim())
        .filter((decl) => /^(color|background-color)\s*:\s*#[0-9a-fA-F]{3,8}$/.test(decl));
    return kept.join('; ');
}

export function _sanitizeHtml(html: string): string {
    // Tokenize HTML into tags, text, and comments using a regex that captures
    // opening tags, closing tags, self-closing tags, and comments.
    const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>|([^<]+)/g;

    let result = '';
    let match: RegExpExecArray | null;

    while ((match = TOKEN_RE.exec(html)) !== null) {
        const [full, closeSlash, tagName, attrsRaw, selfClose, textContent] = match;

        // Text content or comment (no tag) - pass through text, strip comments
        // Check before tagName - text/comment matches have undefined tagName
        if (textContent !== undefined) {
            result += textContent;
            continue;
        }
        if (!tagName) { continue; }

        const tag = tagName.toLowerCase();

        // Strip HTML comments (potential attack vector)
        if (full.startsWith('<!--')) {
            continue;
        }

        // Check forbidden tags - strip entirely (including children in the regex)
        if (FORBIDDEN_TAGS.has(tag)) {
            continue;
        }

        // Unknown tags - strip but keep content
        if (!ALLOWED_TAGS.has(tag)) {
            continue;
        }

        // Parse attributes
        const allowedAttrs = new Set<string>([
            ...(ALLOWED_ATTRS[tag] || []),
            ...(ALLOWED_ATTRS['*'] || []),
        ]);

        let safeAttrs = '';
        const ATTR_RE = /([a-zA-Z_][\w\-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
        let attrMatch: RegExpExecArray | null;

        while ((attrMatch = ATTR_RE.exec(attrsRaw)) !== null) {
            const [, attrName, dqVal, sqVal, uqVal] = attrMatch;
            const attrLower = attrName.toLowerCase();
            const attrVal = dqVal ?? sqVal ?? uqVal ?? '';

            // Block event handlers (onmouseover, onclick, etc.)
            if (EVENT_HANDLER_RE.test(attrLower)) continue;

            // Block data-* attributes
            if (DATA_ATTR_RE.test(attrLower)) continue;

            // Check allowlist
            if (!allowedAttrs.has(attrLower)) continue;

            // Validate href/src URIs - block javascript: and data: URIs
            if (attrLower === 'href' || attrLower === 'src') {
                if (JAVASCRIPT_URI_RE.test(attrVal)) continue;
                // Block data: URIs that could contain HTML/JS
                if (/^\s*data\s*:/i.test(attrVal)) continue;
                // Remote images are a tracking beacon vector in offline
                // coding chats - only relative/anchor links survive here,
                // and CSP blocks network loads at the frame level too.
                if (attrLower === 'src' && /^[a-z][a-z0-9+.-]*:\/\//i.test(attrVal)) continue;
            }

            // Style attributes get property-level filtering (shiki colors only)
            if (attrLower === 'style') {
                const cleanStyle = sanitizeStyle(attrVal);
                if (cleanStyle) {
                    safeAttrs += ` ${attrName}="${cleanStyle}"`;
                }
                continue;
            }

            // Reconstruct attribute with original quoting style
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
