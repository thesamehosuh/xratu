import type { LocalToolDefinition } from '../local/localTypes';

export const ARCHIVE_MUTATIONS = new Set(['extract_archive']);
const source = { type: 'string', description: 'Existing workspace-relative regular file.' };
const sha256 = { type: 'string', description: 'Optional expected publisher SHA-256 (64 hexadecimal characters). A mismatch fails before extraction.' };
const limits = {
    max_bytes: { type: 'integer', minimum: 1, maximum: 21474836480, description: 'Maximum expanded file bytes (default 1 GiB, maximum 20 GiB).' },
    max_entries: { type: 'integer', minimum: 1, maximum: 10000, description: 'Maximum archive entries and output paths, including directories (default/maximum 10000).' },
};
export const ARCHIVE_TOOLS: LocalToolDefinition[] = [
    {
        name: 'verify_file', requiresApproval: false,
        description: 'Stream a workspace file through SHA-256 without shell commands. Return its digest and size; optionally compare an expected publisher digest. Computing a digest alone does not authenticate a file. Read-only and available offline.',
        inputSchema: { type: 'object', properties: {
            path: source, sha256,
            max_bytes: { type: 'integer', minimum: 1, maximum: 1099511627776, description: 'Maximum input bytes (default 20 GiB, maximum 1 TiB).' },
        }, required: ['path'], additionalProperties: false },
    },
    {
        name: 'inspect_archive', requiresApproval: false,
        description: 'Read ZIP, TAR or TAR.GZ/TGZ contents without writing files or shell commands. Validate portable paths, entry types and expansion limits. Return totals and the first 200 entries; ZIP inspection checks metadata, not file CRCs. Input is limited to 20 GiB. Read-only and available offline.',
        inputSchema: { type: 'object', properties: { path: source, ...limits }, required: ['path'], additionalProperties: false },
    },
    {
        name: 'extract_archive', requiresApproval: true,
        description: 'Extract ZIP, TAR or TAR.GZ/TGZ into a NEW workspace directory whose parent already exists. Never overwrite files. Reject links, special files, escaping/Windows-unsafe paths, case/Unicode collisions, and excessive expansion. Check ZIP CRCs; optionally check publisher SHA-256 before writing. Remove owned output on failure/cancellation. Preserve only ordinary executable bits, never ownership or special permissions. Input is limited to 20 GiB. Does not execute or install anything; available offline.',
        inputSchema: { type: 'object', properties: {
            path: source, destination: { type: 'string', description: 'New workspace-relative directory; its parent must already exist.' }, sha256, ...limits,
        }, required: ['path', 'destination'], additionalProperties: false },
    },
];
