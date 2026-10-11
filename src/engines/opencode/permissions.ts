// Adapted from T3 Code's OpenCode 2 adapter. See THIRD_PARTY_NOTICES.txt.
export interface PermissionRule { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }

export function openCodePermissions(plan: boolean, yolo: boolean): PermissionRule[] {
    if (plan) {
        // Deny by default also covers configured MCP and future native tools.
        return [
            { action: '*', resource: '*', effect: 'deny' },
            ...['read', 'glob', 'grep', 'list', 'lsp', 'skill', 'question', 'websearch', 'webfetch'].map(action => ({ action, resource: '*', effect: 'allow' as const })),
            { action: 'external_directory', resource: '*', effect: 'deny' },
        ];
    }
    if (yolo) return [{ action: '*', resource: '*', effect: 'allow' }, { action: 'subagent', resource: '*', effect: 'deny' }];
    return [
        { action: '*', resource: '*', effect: 'ask' },
        ...['read', 'glob', 'grep', 'list', 'lsp', 'skill', 'question'].map(action => ({ action, resource: '*', effect: 'allow' as const })),
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
        { action: 'read', resource: '*.env.example', effect: 'allow' },
        // Delegation stays interactive until native child approvals are mapped.
        { action: 'subagent', resource: '*', effect: 'deny' },
    ];
}
