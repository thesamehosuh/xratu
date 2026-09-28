/** Pure logic for the `ask_user_question` decision-card tool: argument
 *  normalization/validation and the model-facing result text. Extracted from
 *  `mcp.ts` so the host test suite can pin the heuristics (the same pattern as
 *  `tooling/editFileArgs.ts`); the interactive wait itself lives host-side
 *  (extension.ts `UserQuestionGate` implementation). */

export const USER_QUESTION_TOOL_NAME = 'ask_user_question';

export interface UserQuestionOption {
    label: string;
    description: string;
    recommended: boolean;
}

export interface UserQuestion {
    header: string;
    question: string;
    options: UserQuestionOption[];
}

/** How the user answered. `dismissed` = the card was closed without a pick -
 *  the model must continue with best judgment rather than re-ask. */
export type UserQuestionOutcome =
    | { kind: 'selected'; label: string; description: string }
    | { kind: 'custom'; text: string }
    | { kind: 'dismissed' };

/** Host-side bridge to the decision card in the webview. The implementation
 *  correlates by id, awaits the user, and rejects with an `AbortError` when
 *  the run is cancelled while the card is open. */
export interface UserQuestionGate {
    ask(question: UserQuestion): Promise<UserQuestionOutcome>;
}

/** Prompt-level bounds: models overrun these regularly and an oversized card
 *  is unreadable in a 420px sidebar. Truncated, never rejected. */
const HEADER_MAX = 40;
const QUESTION_MAX = 2000;
const LABEL_MAX = 80;
const DESCRIPTION_MAX = 300;

/** Competing agents tell the model to mark the pick by suffixing the label
 *  with "(Recommended)" (opencode/codex convention). Honor that: strip the
 *  suffix so the card never shows it AND promote it to the structured flag
 *  the UI renders as a badge. */
const RECOMMENDED_SUFFIX_RE = /\s*[(\[]\s*recommended\s*[)\]]\s*$/i;

function text(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, max);
}

function truthy(value: unknown): boolean {
    return value === true || value === 'true' || value === 1;
}

export type UserQuestionParse =
    | { ok: true; value: UserQuestion }
    | { ok: false; error: string };

/** Normalize raw tool arguments into a renderable question. Tolerant on
 *  cosmetics (missing header/description, extra options) and strict only on
 *  what the card cannot exist without: a question and 2+ labeled options. */
export function parseUserQuestionArgs(args: Record<string, unknown>): UserQuestionParse {
    const question = text(args.question, QUESTION_MAX);
    if (!question) {
        return { ok: false, error: 'Missing required argument: question' };
    }
    const rawOptions = Array.isArray(args.options) ? args.options : [];
    const options: UserQuestionOption[] = [];
    for (const raw of rawOptions) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as Record<string, unknown>;
        let label = text(entry.label, LABEL_MAX + 24);
        if (!label) continue;
        const suffixRecommended = RECOMMENDED_SUFFIX_RE.test(label);
        if (suffixRecommended) label = label.replace(RECOMMENDED_SUFFIX_RE, '').trim();
        options.push({
            label: label.slice(0, LABEL_MAX),
            description: text(entry.description, DESCRIPTION_MAX),
            recommended: suffixRecommended || truthy(entry.recommended),
        });
        if (options.length >= 6) break;
    }
    if (options.length < 2) {
        return {
            ok: false,
            error: `${USER_QUESTION_TOOL_NAME} requires at least 2 options with a non-empty label`,
        };
    }
    // Several recommended flags is a model slip: the FIRST one wins so the
    // card shows exactly one badge.
    let seenRecommended = false;
    for (const option of options) {
        if (!option.recommended) continue;
        if (seenRecommended) option.recommended = false;
        else seenRecommended = true;
    }
    return {
        ok: true,
        value: {
            header: text(args.header, HEADER_MAX),
            question,
            options,
        },
    };
}

/** Model-facing tool result. Unambiguous about which option was picked (the
 *  label maps back onto the model's own option list) and about a dismissal,
 *  which is NOT an error: the model continues with best judgment. */
export function formatUserQuestionResult(outcome: UserQuestionOutcome): string {
    if (outcome.kind === 'selected') {
        return `The user selected the option: "${outcome.label}"`
            + (outcome.description ? `\n\n${outcome.description}` : '');
    }
    if (outcome.kind === 'custom') {
        return `The user provided a custom answer:\n${outcome.text}`;
    }
    return 'The user dismissed the question without selecting an option. Continue with your best judgment and do not ask again.';
}
