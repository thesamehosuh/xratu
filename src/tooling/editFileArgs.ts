/**
 * Argument resolution for the `edit_file` whole-file writer.
 *
 * Kept free of the `vscode` import so it can be unit-tested in plain node
 * (see test/test-edit-file-mode.mjs) - `dispatchTool` lives in mcp.ts, which
 * pulls in `vscode` and therefore cannot be required from a bare node suite.
 *
 * Why this is a separate, testable unit: the original inline check was
 *
 *     const mode = ['create', 'overwrite', 'append'].includes(args.mode)
 *         ? args.mode : 'overwrite';
 *
 * so ANY unrecognized value silently became `overwrite`. Weak local models
 * emit plausible-but-wrong arguments all the time (precedent: the task-list
 * tool accepts `task`/`content`/`step` because a live model sent `task`), and
 * a model reaching for a partial edit may send `mode: "replace"`. Instead of
 * an error it got a WHOLE-FILE OVERWRITE of the file it meant to patch.
 * An unknown mode must fail loudly, never fall back to the destructive one.
 */

/** The only accepted modes, in schema order. */
export const EDIT_FILE_MODES = ['overwrite', 'create', 'append'] as const;
export type EditFileMode = (typeof EDIT_FILE_MODES)[number];

/** Documented default when the caller omits `mode` entirely. */
export const EDIT_FILE_DEFAULT_MODE: EditFileMode = 'overwrite';

export type EditModeResolution = { mode: EditFileMode } | { error: string };

/** Tolerate circular/garbage values - never throw while formatting an error. */
function safeStringify(value: unknown): string {
    try {
        const json = JSON.stringify(value);
        if (typeof json === 'string') return json;
    } catch {
        // Fall through to the protected string conversion below.
    }
    try {
        return String(value);
    } catch {
        return '<unprintable>';
    }
}

export type EditContentResolution = { content: string } | { error: string };

/** Marker key placed in the args object when tool-call arguments arrive
 *  unparseable. The old behavior was a silent `{}`, which made EVERY tool
 *  report its first required argument as missing (`new_content is required`)
 *  no matter what the model sent - a resend loop on every large write.
 *  Lives here (not localAgent) so dependency-free consumers can share it. */
export const UNPARSED_ARGS_KEY = '__unparsed_args';

/** Keys weak models send INSTEAD of `new_content`. Precedent: the task-list
 *  tool accepts `task`/`content`/`step` because a live model sent `task` -
 *  a wrong-but-present key must not become "new_content is required". */
export const EDIT_CONTENT_ALIASES = ['content', 'contents', 'text'] as const;

/**
 * Resolve the `new_content` argument.
 *
 * Regression: a call that omitted it reached `preserveEol(previous, undefined)`
 * and died with a raw `TypeError: Cannot read properties of undefined (reading
 * 'replace')` - a crash that names neither the parameter nor the fix, and looks
 * like a harness fault rather than a malformed call. The schema marks
 * `new_content` required, but required keys get dropped constantly, so this has
 * to be a clear refusal.
 *
 * An EMPTY string is VALID: it is how a caller truncates a file (overwrite) or
 * creates an empty one.
 */
export function resolveEditContent(raw: unknown): EditContentResolution {
    if (typeof raw === 'string') return { content: raw };
    if (raw === undefined || raw === null) {
        return {
            error: 'Error: new_content is required and was missing - send the complete file '
                + 'content for mode "overwrite"/"create", or the text to add for "append". '
                + 'To change PART of an existing file, use apply_patch instead of edit_file.',
        };
    }
    return {
        error: `Error: new_content must be a string, got ${safeStringify(raw)} - send the file `
            + 'content as text (the complete content for "overwrite"/"create", the text to add '
            + 'for "append").',
    };
}

/**
 * Resolve the edit content from a full args object: `new_content` first, then
 * the known aliases. A model that sends the file body under `content` gets its
 * write, not a missing-argument error it cannot interpret.
 */
export function resolveEditContentFrom(args: Record<string, unknown>): EditContentResolution {
    if (args && args.new_content !== undefined && args.new_content !== null) {
        return resolveEditContent(args.new_content);
    }
    for (const key of EDIT_CONTENT_ALIASES) {
        const v = args ? args[key] : undefined;
        if (v !== undefined && v !== null) return resolveEditContent(v);
    }
    return resolveEditContent(undefined);
}

/**
 * Resolve a raw `mode` argument.
 *
 * - absent (`undefined`/`null`/`''`) -> the documented default, NOT an error
 * - present and recognized -> that mode
 * - present and unrecognized -> an error string; the caller must abort before
 *   touching the filesystem or taking a checkpoint
 */
export function resolveEditMode(raw: unknown): EditModeResolution {
    if (raw === undefined || raw === null || raw === '') return { mode: EDIT_FILE_DEFAULT_MODE };
    if (typeof raw === 'string' && (EDIT_FILE_MODES as readonly string[]).includes(raw)) {
        return { mode: raw as EditFileMode };
    }
    const shown = typeof raw === 'string' ? `"${raw}"` : safeStringify(raw);
    return {
        error: `Error: unknown mode ${shown} - valid modes are `
            + EDIT_FILE_MODES.map((m) => `"${m}"`).join(', ')
            + ` (omit mode for the default "${EDIT_FILE_DEFAULT_MODE}"; mode "create" fails if the file exists).`
            + ' To change PART of an existing file, use apply_patch instead of edit_file.',
    };
}
