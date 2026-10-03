#!/usr/bin/env node
/**
 * INTEGRATION test: a REAL MCP server process, spawned over stdio by the
 * shipping `ExternalMcpManager`, returning a REAL image content block.
 *
 * The other two suites prove the mapping and the wire formats. This one proves
 * the seam: the manager's stdio spawn, the SDK's `callTool`, and the content
 * translation all actually connect, with no stubbing of either side.
 *
 * THE REGRESSION: `callTool` mapped every content block through `c.text ?? ''`.
 * An `image` block has no `text`, so a screenshot came back as `''` - the
 * Playwright MCP entry in `mcpRegistry.ts` looked installed and worked, and
 * `browser_take_screenshot` returned nothing the model could see.
 *
 * Run (after `npx tsc -p . --outDir out`):
 *   node test/test-mcp-image-server.mjs
 */
import { createRequire } from 'module';
import Module from 'module';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            workspace: {
                getConfiguration: () => ({ get: () => undefined, update: async () => undefined }),
                isTrusted: true,
                workspaceFolders: undefined,
            },
            Uri: { file: (p) => ({ fsPath: p, path: p }) },
            window: { withProgress: async (_o, t) => t() },
            env: { appRoot: undefined },
        };
    }
    return origLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const { ExternalMcpManager } = require('../out/externalMcp.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
};

const PNG_1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// The spawned server imports the SDK by BARE specifier, so it must live where
// node can resolve `@modelcontextprotocol/sdk` - i.e. inside the repo, which
// owns node_modules. An OS temp dir cannot resolve it.
const workdir = mkdtempSync(join(repoRoot, '.tmp-mcp-img-'));
const serverPath = join(workdir, 'shot-server.mjs');

/** A genuine MCP server: same SDK the extension talks to, over stdio. */
writeFileSync(serverPath, `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PNG = '${PNG_1x1}';
const server = new Server({ name: 'shot', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'browser_take_screenshot', description: 'Take a screenshot', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
    { name: 'browser_navigate', description: 'Navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
    { name: 'browser_explode', description: 'Malformed error payload', inputSchema: { type: 'object', properties: {} } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'browser_take_screenshot') {
        // The exact block shape Playwright MCP / chrome-devtools MCP return.
        return { content: [
            { type: 'text', text: 'Screenshot of ' + (req.params.arguments?.url ?? 'about:blank') },
            { type: 'image', mimeType: 'image/png', data: PNG },
        ] };
    }
    if (req.params.name === 'browser_explode') {
        // An error result carrying an IMAGE-only entry, which IS accepted by
        // the SDK's CallToolResultSchema. The old text-only mapper turned it
        // into '' and the error surfaced as "Unknown tool error", hiding what
        // the server actually said. (null entries are rejected by that same
        // schema before reaching our mapper - covered in test-mcp-tool-images.)
        return { isError: true, content: [
            { type: 'image', mimeType: 'image/png', data: PNG },
            { type: 'text', text: 'element @e5 not found' },
        ] };
    }
    return { content: [{ type: 'text', text: 'navigated' }] };
});
await server.connect(new StdioServerTransport());
`, 'utf8');

const manager = new ExternalMcpManager(async () => ({
    servers: {
        shot: {
            name: 'shot',
            // `node` + the script: the same stdio path any user-configured
            // server takes (npx, uvx, docker all land here).
            command: process.execPath,
            args: [serverPath],
        },
    },
    sources: { shot: 'global' },
    globalPath: join(workdir, 'mcp.json'),
    workspacePath: null,
    legacyInUse: false,
    shadowedGlobalEntries: {},
}));

try {
    // The tool must be DISCOVERED (this spawns the process and lists tools).
    const tools = await manager.listTools();
    ok('the server spawns and its tools are discovered',
        tools.some((t) => t.name === 'mcp__shot__browser_take_screenshot'),
        JSON.stringify(tools.map((t) => t.name)));
    const shot = tools.find((t) => t.name === 'mcp__shot__browser_take_screenshot');
    eq_ok('the discovered tool keeps its namespaced name', shot?.name, 'mcp__shot__browser_take_screenshot');
    ok('the discovered tool is NOT auto-approved by default', shot?.autoApprove === false, String(shot?.autoApprove));

    // The regression itself: a screenshot must come back as an image.
    // Normalized so the OLD string-returning signature fails as clean FAIL
    // assertions instead of crashing on `.text` of undefined - the failure
    // output is the artifact that matters.
    const call = async (tool, args) => {
        const raw = await manager.callTool(tool, args);
        return typeof raw === 'string' ? { text: raw, images: [] } : raw;
    };
    const result = await call('mcp__shot__browser_take_screenshot', { url: 'https://example.com/checkout' });
    ok('the text half came through', result.text.includes('Screenshot of https://example.com/checkout'), result.text);
    eq_ok('an image came through (THE REGRESSION)', result.images.length, 1);
    eq_ok('the image kept its mime type', result.images[0]?.mimeType, 'image/png');
    eq_ok('the image payload is byte-identical', result.images[0]?.dataBase64, PNG_1x1);

    // A text-only tool on the SAME server must be unaffected.
    const textOnly = await call('mcp__shot__browser_navigate', { url: 'https://example.com' });
    eq_ok('a text-only tool returns no images', textOnly.images.length, 0);
    eq_ok('a text-only tool returns its text', textOnly.text, 'navigated');

    // An unknown tool still errors as text, not as a thrown image.
    const bad = await call('mcp__shot__no_such_tool', {});
    ok('an unknown tool errors as text', typeof bad.text === 'string' && bad.text.length > 0, JSON.stringify(bad));
    eq_ok('an unknown tool returns no images', bad.images.length, 0);

    // A malformed error payload must surface the server's real message. An
    // image-only entry is the shape that actually gets through the SDK's
    // CallToolResultSchema, and the old `c.text ?? ''` mapped it to '' - so the
    // user saw "Unknown tool error" instead of the server's actual failure.
    const exploded = await call('mcp__shot__browser_explode', {});
    ok('an error payload with an image entry surfaces the real message',
        /element @e5 not found/.test(exploded.text), exploded.text);
    ok('it does not degrade to a generic call error',
        !/MCP Call Error/.test(exploded.text), exploded.text);
    ok('it is labelled as a server error',
        /Error from MCP server/.test(exploded.text), exploded.text);
    eq_ok('an error payload returns no images', exploded.images.length, 0);

    // An unreachable server must fail as text, never crash.
    const unreachable = await call('mcp__missing__tool', {});
    ok('a missing server errors as text', /no MCP server configured/.test(unreachable.text), unreachable.text);
} finally {
    await manager.stopAll();
    rmSync(workdir, { recursive: true, force: true });
}

function eq_ok(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(name, a === e, `(got ${a}, want ${e})`);
}

console.log(failed === 0
    ? '\nall MCP image integration tests passed'
    : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);