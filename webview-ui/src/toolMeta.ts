/**
 * Tool icon + label lookup, shared by the transcript pills and the approval
 * card. Extracted from `MessageItem.tsx` so both surfaces resolve a tool name
 * through ONE table — the card used to import the pair back out of the
 * transcript component, which made the extraction circular.
 */
import {
    Bot,
    BookOpen,
    Check,
    CodeXml,
    Copy,
    Cpu,
    FilePen,
    FileText,
    FolderOpen,
    FolderTree,
    GitBranch,
    Globe,
    HelpCircle,
    ListChecks,
    Package,
    PackagePlus,
    Search,
    ShieldCheck,
    SquareTerminal,
    Trash2,
    Wrench,
} from 'lucide-react';
import { t } from './i18n';

export const TOOL_ICONS: Array<{ re: RegExp; icon: typeof Wrench }> = [
    { re: /^update_task_list$/, icon: ListChecks },
    { re: /^ask_user_question$/, icon: HelpCircle },
    { re: /^task$/, icon: Bot },
    { re: /^exit_plan_mode$/, icon: ShieldCheck },
    { re: /^skill$/, icon: BookOpen },
    { re: /terminal|command/, icon: SquareTerminal },
    // Before the generic fallbacks: `process` shares no substring with any
    // other family, so without its own row it rendered as a bare wrench.
    { re: /^process$/, icon: Cpu },
    { re: /grep/, icon: Search },
    { re: /glob/, icon: Search },
    { re: /read_files|file_info/, icon: FileText },
    { re: /read_file/, icon: FileText },
    { re: /list_files|dir/, icon: FolderOpen },
    { re: /directory_tree/, icon: FolderTree },
    { re: /edit|replace|patch/, icon: FilePen },
    // Whole-file writers carry no "edit/replace/patch" substring, so they used
    // to fall through to the generic Wrench - the one edit-family tool that did
    // not read as a file edit.
    { re: /^write_file$|^create_file$/, icon: FilePen },
    { re: /copy_file/, icon: Copy },
    { re: /move_file/, icon: FilePen },
    { re: /delete_file/, icon: Trash2 },
    { re: /definition/, icon: CodeXml },
    { re: /find_/, icon: Search },
    { re: /workspace_symbols/, icon: CodeXml },
    { re: /diagnostics/, icon: Check },
    { re: /git_/, icon: GitBranch },
    { re: /fetch_url/, icon: Globe },
    { re: /web_search/, icon: Globe },
    { re: /test/, icon: ShieldCheck },
    { re: /dependency/, icon: Package },
    { re: /install_/, icon: PackagePlus },
    { re: /mcp__/, icon: FolderOpen },
];

/** Persian labels for the builtin tool pills - shown RTL like the thinking
 *  pill; unknown/external tools fall back to their raw LTR name. */
const TOOL_LABELS: Array<{ re: RegExp; key: Parameters<typeof t>[0] }> = [
    { re: /^run_terminal_command$/, key: 'toolTerminal' },
    { re: /^process$/, key: 'toolProcess' },
    { re: /^ask_user_question$/, key: 'toolAskUserQuestion' },
    { re: /^task$/, key: 'toolTask' },
    { re: /^read_file$/, key: 'toolReadFile' },
    { re: /^read_files$/, key: 'toolReadFiles' },
    { re: /^file_info$/, key: 'toolFileInfo' },
    { re: /^list_files$/, key: 'toolListFiles' },
    { re: /^grep_search$/, key: 'toolGrepSearch' },
    { re: /^glob_search$/, key: 'toolGlobSearch' },
    { re: /^replace_in_file$/, key: 'toolReplaceInFile' },
    { re: /^apply_patch$/, key: 'toolApplyPatch' },
    { re: /^edit_file$/, key: 'toolEditFile' },
    { re: /^write_file$|^create_file$/, key: 'toolWriteFile' },
    { re: /^copy_file$/, key: 'toolCopyFile' },
    { re: /definition$/, key: 'toolDefinitions' },
    { re: /^git_status$/, key: 'toolGitStatus' },
    { re: /^git_diff$/, key: 'toolGitDiff' },
    { re: /^git_log$/, key: 'toolGitLog' },
    { re: /^git_commit$/, key: 'toolGitCommit' },
    { re: /^git_show$/, key: 'toolGitShow' },
    { re: /^git_blame$/, key: 'toolGitBlame' },
    { re: /^git_branch$/, key: 'toolGitBranch' },
    { re: /^git_show_stash$/, key: 'toolGitStash' },
    { re: /^git_checkout$/, key: 'toolGitCheckout' },
    { re: /^git_pull$/, key: 'toolGitPull' },
    { re: /^git_push$/, key: 'toolGitPush' },
    { re: /^git_merge$/, key: 'toolGitMerge' },
    { re: /^fetch_url$/, key: 'toolFetchUrl' },
    { re: /^find_definitions$/, key: 'toolFindDefinitions' },
    { re: /^find_references$/, key: 'toolFindReferences' },
    { re: /^workspace_symbols$/, key: 'toolWorkspaceSymbols' },
    { re: /^get_diagnostics$/, key: 'toolGetDiagnostics' },
    { re: /^directory_tree$/, key: 'toolDirectoryTree' },
    { re: /^run_tests$/, key: 'toolRunTests' },
    { re: /^move_file$/, key: 'toolMoveFile' },
    { re: /^delete_file$/, key: 'toolDeleteFile' },
    { re: /^check_dependencies$/, key: 'toolCheckDependencies' },
    { re: /^install_dependency$/, key: 'toolInstallDependency' },
    { re: /^web_search$/, key: 'toolWebSearch' },
    { re: /^update_task_list$/, key: 'toolUpdateTaskList' },
    { re: /^exit_plan_mode$/, key: 'toolExitPlanMode' },
    { re: /^skill$/, key: 'toolSkill' },
];

export function toolIcon(tool?: string): typeof Wrench {
    if (!tool) return Wrench;
    for (const { re, icon } of TOOL_ICONS) {
        if (re.test(tool)) return icon;
    }
    return Wrench;
}

export function toolLabel(tool?: string): { fa: string; known: boolean } {
    if (!tool) return { fa: t('toolGeneric'), known: false };
    for (const { re, key } of TOOL_LABELS) {
        if (re.test(tool)) return { fa: t(key), known: true };
    }
    // External MCP tools: strip the mcp__<server>__ namespace into a
    // "server · tool" display (still LTR content inside the RTL pill).
    if (tool.startsWith('mcp__')) {
        const rest = tool.slice(5);
        const sep = rest.indexOf('__');
        if (sep > 0) return { fa: `${rest.slice(0, sep)} · ${rest.slice(sep + 2)}`, known: false };
    }
    return { fa: tool, known: false };
}