// Adapted from T3 Code's OpenCode 2 adapter. See THIRD_PARTY_NOTICES.txt.
export interface PermissionRule { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }

export function openCodePermissions(plan: boolean, _yolo: boolean): PermissionRule[] {
    if (plan) {
        // Deny by default also covers configured MCP and future native tools.
        return [
            { action: '*', resource: '*', effect: 'deny' },
            ...['read', 'glob', 'grep', 'list', 'lsp', 'skill', 'question', 'websearch', 'webfetch'].map(action => ({ action, resource: '*', effect: 'allow' as const })),
            { action: 'external_directory', resource: '*', effect: 'deny' },
        ];
    }
    // Children atomically inherit this session ruleset. Keep mutations asking:
    // the adapter applies YOLO live on each request, so a ruleset must never
    // bake in a blanket allow that outlives the grant.
    return [
        { action: '*', resource: '*', effect: 'ask' },
        ...['read', 'glob', 'grep', 'list', 'lsp', 'skill', 'question'].map(action => ({ action, resource: '*', effect: 'allow' as const })),
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
        { action: 'read', resource: '*.env.example', effect: 'allow' },
        { action: 'subagent', resource: '*', effect: 'ask' },
    ];
}
