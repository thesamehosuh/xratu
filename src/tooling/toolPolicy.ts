import { BROWSER_TOOL_DEFINITIONS, BROWSER_MUTATING_TOOLS } from '../browserPolicy';
import { DOWNLOAD_TOOLS, DOWNLOAD_MUTATIONS } from '../downloads/tools';
import { ARCHIVE_TOOLS, ARCHIVE_MUTATIONS } from '../archives/tools';
import { PULL_REQUEST_TOOLS, PULL_REQUEST_MUTATIONS } from '../pullRequests/tools';

/** First-party model capabilities. Removed tools cannot execute through stale
 * sessions or the native bridge. External MCP tools keep their own approval gate. */
export const TOOL_POLICY: Record<string, { effect: 'read' | 'write' | 'execute' | 'session'; plan: boolean }> = {
    read_file: { effect: 'read', plan: true },
    write_file: { effect: 'write', plan: false },
    edit_file: { effect: 'write', plan: false },
    grep_search: { effect: 'read', plan: true },
    glob_search: { effect: 'read', plan: true },
    list_files: { effect: 'read', plan: true },
    view_image: { effect: 'read', plan: true },
    run_terminal_command: { effect: 'execute', plan: false },
    process_input: { effect: 'execute', plan: false },
    process: { effect: 'session', plan: false },
    get_diagnostics: { effect: 'read', plan: true },
    find_definitions: { effect: 'read', plan: true },
    find_references: { effect: 'read', plan: true },
    symbols: { effect: 'read', plan: true },
    ask_user_question: { effect: 'session', plan: true },
    ask_session_question: { effect: 'session', plan: true },
    update_task_list: { effect: 'session', plan: true },
    exit_plan_mode: { effect: 'session', plan: true },
    skill: { effect: 'read', plan: true },
    task: { effect: 'execute', plan: false },
    spawn_agent: { effect: 'session', plan: false },
    send_agent: { effect: 'session', plan: false },
    inspect_agents: { effect: 'session', plan: false },
    wait_agents: { effect: 'session', plan: false },
    stop_agent: { effect: 'session', plan: false },

    web_search: { effect: 'read', plan: true },
    fetch_url: { effect: 'read', plan: true },
};
for (const [definitions, mutations] of [
    [BROWSER_TOOL_DEFINITIONS, BROWSER_MUTATING_TOOLS],
    [DOWNLOAD_TOOLS, DOWNLOAD_MUTATIONS],
    [ARCHIVE_TOOLS, ARCHIVE_MUTATIONS],
    [PULL_REQUEST_TOOLS, PULL_REQUEST_MUTATIONS],
] as const) {
    for (const tool of definitions) TOOL_POLICY[tool.name] = { effect: mutations.has(tool.name) ? 'write' : 'read', plan: !mutations.has(tool.name) };
}
export function isAvailableTool(name: string, plan: boolean): boolean {
    const policy = TOOL_POLICY[name];
    return Object.hasOwn(TOOL_POLICY, name) && !!policy && (!plan || policy.plan) && (name !== 'exit_plan_mode' || plan);
}
