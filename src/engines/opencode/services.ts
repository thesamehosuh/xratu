import { BROWSER_MUTATING_TOOLS, BROWSER_TOOL_DEFINITIONS } from '../../browserPolicy';
import type { LocalToolDefinition } from '../../local/localTypes';
import type { AggregatedTool } from '../../externalMcp';
import { TASK_LIST_TOOL_NAME } from '../../taskList';
import { DOWNLOAD_MUTATIONS, DOWNLOAD_TOOLS } from '../../downloads/tools';

const browserNames = new Set(BROWSER_TOOL_DEFINITIONS.map(tool => tool.name));
const sessionTools = new Set([TASK_LIST_TOOL_NAME, 'exit_plan_mode', 'skill']);

/** Deliberate service allowlist: native file/shell tools and delegation stay native. */
export function isNativeServiceTool(name: string): boolean {
    return browserNames.has(name) || sessionTools.has(name) || DOWNLOAD_TOOLS.some(tool => tool.name === name);
}

export function isNativePlanTool(name: string): boolean {
    return sessionTools.has(name) || name === 'list_downloads' || (browserNames.has(name) && !BROWSER_MUTATING_TOOLS.has(name));
}

export function nativeServiceTools(tools: LocalToolDefinition[]): AggregatedTool[] {
    return tools.filter(tool => isNativeServiceTool(tool.name)).map(tool => ({
        name: tool.name, originalName: tool.name, serverName: 'xratu',
        description: tool.description, inputSchema: tool.inputSchema,
        autoApprove: !tool.requiresApproval && !BROWSER_MUTATING_TOOLS.has(tool.name) && !DOWNLOAD_MUTATIONS.has(tool.name),
    }));
}

/** Display metadata only. Never pass translated arguments back to native execution. */
export function nativeToolDisplayArgs(name: string, input: Record<string, unknown>): Record<string, unknown> {
    if (name === 'task') return { ...input, subagent_type: input.agent, ...(typeof input.sessionID === 'string' ? { task_id: input.sessionID } : {}) };
    if (!['read_file', 'edit_file', 'write_file'].includes(name)) return input;
    return {
        ...input,
        ...(typeof input.path !== 'string' && typeof input.filePath === 'string' ? { path: input.filePath } : {}),
        ...(typeof input.oldString === 'string' ? { old_text: input.oldString } : {}),
        ...(typeof input.newString === 'string' ? { new_text: input.newString } : {}),
    };
}
