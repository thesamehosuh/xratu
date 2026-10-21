import type { LocalToolDefinition } from '../local/localTypes';

export const DOWNLOAD_MUTATIONS = new Set(['start_download', 'control_download']);
const route = { type: 'string', enum: ['auto', 'proxy', 'direct'], description: 'auto honors Xratu proxy/bypass settings (default); proxy forces the configured proxy and fails if absent; direct bypasses it. Read the native-downloads skill for route selection.' };
export const DOWNLOAD_TOOLS: LocalToolDefinition[] = [
    {
        name: 'start_download', requiresApproval: true,
        description: 'Download a public HTTP(S) file to a NEW workspace path in the background. Returns an ID immediately; retries and progress need no model polling. Survives chat changes; reload leaves it interrupted for control_download resume. Use this instead of curl/wget. Read the native-downloads skill for proxy routing. No installation required.',
        inputSchema: { type: 'object', properties: {
            url: { type: 'string', description: 'Public HTTP(S) URL; signed query strings are supported. No embedded credentials.' },
            path: { type: 'string', description: 'New workspace-relative destination. Existing files are never overwritten.' },
            route,
            sha256: { type: 'string', description: 'Expected SHA-256 digest, if published by the source.' },
            max_bytes: { type: 'integer', minimum: 1, maximum: 1099511627776, description: 'Disk/network budget (default 20 GiB, maximum 1 TiB).' },
        }, required: ['url', 'path'], additionalProperties: false },
    },
    {
        name: 'control_download', requiresApproval: true,
        description: 'Pause, resume/recover, or cancel a managed download by ID. Resume preserves validated partial bytes; restart explicitly discards them if the source changed or cannot safely resume. Cancel removes only the partial file. Optional route changes or a refreshed signed URL apply on resume/restart. All controls are agent-facing.',
        inputSchema: { type: 'object', properties: {
            id: { type: 'string' }, action: { type: 'string', enum: ['pause', 'resume', 'restart', 'cancel'] }, route,
            url: { type: 'string', description: 'Replacement public URL for resume/restart, e.g. a refreshed signed link for the same file.' },
        }, required: ['id', 'action'], additionalProperties: false },
    },
    {
        name: 'list_downloads', requiresApproval: false,
        description: 'Read compact status of managed workspace downloads, including route, bytes, speed, retry time and errors. No file contents or secret URLs. Check when needed; progress is already visible in the Downloads tab and never wakes the model.',
        inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Optional single download ID.' } }, additionalProperties: false },
    },
];
