/**
 * Curated registry of vetted MCP servers - the one-click "Add" list in the
 * MCP page. Vendored and offline (a mini Cline marketplace). Display
 * strings ride i18n via nameKey/descKey; only servers
 * the maintainer trusts go in here.
 *
 * `server.autoApprove` prefills tool names that are READ-ONLY by design AND
 * whose scope is fully fixed by the server itself (no caller-supplied
 * paths) - users can clear the list in the edit form. Nothing here mutates
 * a workspace or executes shell commands.
 */

export interface McpRegistryEntry {
    id: string;
    nameKey: string;
    descKey: string;
    docsUrl?: string;
    tags?: string[];
    /** Seeded, enabled on fresh installs; existing config is never overwritten. */
    defaultEnabled?: boolean;
    server: {
        name: string;
        command?: string;
        args?: string[];
        url?: string;
        env?: Record<string, string>;
        autoApprove?: string[];
        connectTimeoutMs?: number;
    };
}

export const MCP_REGISTRY: McpRegistryEntry[] = [
    {
        id: 'divar',
        nameKey: 'mcpRegDivarName',
        descKey: 'mcpRegDivarDesc',
        docsUrl: 'https://github.com/mmdju/divar-mcp',
        tags: ['iranian'],
        defaultEnabled: true,
        server: {
            name: 'divar',
            url: 'https://divar-mcp.mmdju2.workers.dev/mcp',
        },
    },
    {
        id: 'torob',
        nameKey: 'mcpRegTorobName',
        descKey: 'mcpRegTorobDesc',
        docsUrl: 'https://github.com/mmdju/torob-mcp',
        tags: ['iranian'],
        defaultEnabled: true,
        server: {
            name: 'torob',
            connectTimeoutMs: 120_000,
            command: 'npx',
            // Pin the installer too: npm 12's Git prepare path rejects its
            // own allow-scripts argument before this server can build.
            args: ['-y', 'npm@11.6.2', 'exec', '--yes',
                '--package=github:mmdju/torob-mcp#b8ffdca4110e8f35f9f617be57fa8cf9916aa968', '--', 'torob-mcp'],
        },
    },
    {
        id: 'digikala',
        nameKey: 'mcpRegDigikalaName',
        descKey: 'mcpRegDigikalaDesc',
        docsUrl: 'https://github.com/sepehr071/digikala-mcp',
        tags: ['iranian'],
        defaultEnabled: true,
        server: {
            name: 'digikala',
            command: 'uvx',
            args: ['digikala-mcp==0.3.0'],
        },
    },
    {
        id: 'context7',
        nameKey: 'mcpRegContext7Name',
        descKey: 'mcpRegContext7Desc',
        docsUrl: 'https://github.com/upstash/context7',
        server: {
            name: 'context7',
            command: 'npx',
            args: ['-y', '@upstash/context7-mcp'],
            autoApprove: ['resolve-library-id', 'get-library-docs'],
        },
    },
    {
        id: 'ddg-search',
        defaultEnabled: true,
        nameKey: 'mcpRegDdgName',
        descKey: 'mcpRegDdgDesc',
        docsUrl: 'https://github.com/nickclyde/duckduckgo-mcp-server',
        server: {
            name: 'ddg-search',
            command: 'uvx',
            // Version-pinned: this entry is also the first-run default seed
            // (McpConfigStore.seedDefaults), so the executed package must
            // not float.
            args: ['duckduckgo-mcp-server==0.7.0'],
            autoApprove: ['search', 'fetch_content'],
        },
    },
    {
        id: 'sequential-thinking',
        nameKey: 'mcpRegSeqThinkName',
        descKey: 'mcpRegSeqThinkDesc',
        docsUrl: 'https://github.com/modelcontextprotocol/servers',
        server: {
            name: 'sequential-thinking',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
            autoApprove: ['sequentialthinking'],
        },
    },
    {
        id: 'fetch',
        nameKey: 'mcpRegFetchName',
        descKey: 'mcpRegFetchDesc',
        docsUrl: 'https://github.com/modelcontextprotocol/servers',
        server: {
            name: 'fetch',
            command: 'uvx',
            args: ['mcp-server-fetch'],
            autoApprove: ['fetch'],
        },
    },
    {
        id: 'time',
        nameKey: 'mcpRegTimeName',
        descKey: 'mcpRegTimeDesc',
        docsUrl: 'https://github.com/modelcontextprotocol/servers',
        server: {
            name: 'time',
            command: 'uvx',
            args: ['mcp-server-time'],
            autoApprove: ['get_current_time', 'convert_time'],
        },
    },
    {
        id: 'playwright',
        nameKey: 'mcpRegPlaywrightName',
        descKey: 'mcpRegPlaywrightDesc',
        docsUrl: 'https://github.com/microsoft/playwright-mcp',
        server: {
            name: 'playwright',
            command: 'npx',
            args: ['-y', '@playwright/mcp@latest'],
        },
    },
    {
        id: 'git',
        nameKey: 'mcpRegGitName',
        descKey: 'mcpRegGitDesc',
        docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
        server: {
            name: 'git',
            command: 'uvx',
            args: ['mcp-server-git'],
            // NO autoApprove: git tools accept a caller-supplied repo_path
            // when --repository is not pinned, so auto-approving reads would
            // let a chat inspect ANY local repository unreviewed.
        },
    },
    {
        id: 'github',
        nameKey: 'mcpRegGithubName',
        descKey: 'mcpRegGithubDesc',
        docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
        server: {
            name: 'github',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            // No env placeholder: the token is set in the edit form's env
            // editor. (MCP env/headers live in mcp.json by design - see
            // mcpConfig.ts; VS Code secret-storage routing for MCP
            // credentials is a tracked follow-up.)
        },
    },
    {
        id: 'memory',
        nameKey: 'mcpRegMemoryName',
        descKey: 'mcpRegMemoryDesc',
        docsUrl: 'https://github.com/modelcontextprotocol/servers',
        server: {
            name: 'memory',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-memory'],
        },
    },
];
