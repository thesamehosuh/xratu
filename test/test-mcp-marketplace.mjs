#!/usr/bin/env node
/**
 * MCP marketplace parsing tests - the pure half of the live marketplace.
 *
 * Catalogs are REMOTE and untrusted, and whatever they say ends up as a
 * spawnable command in the user's mcp.json. This suite pins that contract:
 * Cline-catalog install args (stdio / --transport http|sse / dropped header
 * values), official-registry package mapping (npm / pypi / oci), field caps,
 * duplicate collapsing, ranking, and the README detection heuristics.
 *
 * Fixtures are trimmed copies of the real payloads:
 *   https://cline.github.io/marketplace/catalog.json
 *   https://registry.modelcontextprotocol.io/v0/servers
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-mcp-marketplace.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    cleanText,
    slugifyServerName,
    deriveServerName,
    safeHttpUrl,
    compareVersions,
    packageToInstall,
    parseClineInstallArgs,
    parseClineCatalog,
    parseCatalogTagLabels,
    neutralizeClientCopy,
    parseOfficialRegistry,
    parseXratuCatalog,
    parseMarketplacePayload,
    detectPayloadShape,
    curatedMarketplaceEntries,
    mergeMarketplaceEntries,
    searchMarketplaceEntries,
    collectCategories,
    collectTags,
    detectInstallFromReadme,
    dockerImageFrom,
    MARKETPLACE_LIMITS,
} = require('../out/mcpMarketplace.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

// --- fixtures -------------------------------------------------------------

const clineCatalog = {
    version: 1,
    generatedAt: '2026-09-18T20:15:28.359Z',
    counts: { total: 6, mcps: 5, plugins: 0, skills: 1 },
    tags: [{ id: 'data', label: 'Data', count: 2 }],
    entries: [
        {
            id: 'aikido',
            type: 'mcp',
            name: 'Aikido',
            tagline: 'Security scanning for your code',
            description: 'Connect Cline to Aikido through this MCP server.',
            author: { name: 'Aikido Security', url: 'https://aikido.dev' },
            tags: ['security', 'Software'],
            verified: false,
            featured: true,
            repo: 'https://github.com/AikidoSec/aikido-claude-plugin',
            homepage: 'https://help.aikido.dev/ide-plugins/aikido-mcp',
            install: { args: ['aikido', '--', 'npx', '-y', '@aikidosec/mcp@1.0.9'] },
        },
        {
            id: 'airtable',
            type: 'mcp',
            name: 'Airtable',
            tagline: 'Manage data in Airtable bases',
            description: 'Manage data in Airtable bases.',
            author: { name: 'Airtable' },
            tags: ['data'],
            verified: true,
            featured: false,
            repo: 'https://github.com/Airtable/airtable-mcp-cli',
            install: {
                args: ['airtable', '--transport', 'http', 'https://mcp.airtable.com/mcp'],
                env: [{ name: 'AIRTABLE_TOKEN', required: true, description: 'Airtable personal access token', url: 'https://airtable.com/create/tokens' }],
            },
        },
        {
            id: 'header-server',
            type: 'mcp',
            name: 'Header Server',
            description: 'remote server behind an auth header',
            install: { args: ['header-server', '--transport', 'sse', 'https://example.com/sse', '--header', 'Authorization: Bearer ${MY_TOKEN}'] },
        },
        {
            id: 'evil',
            type: 'mcp',
            name: 'Evil',
            description: 'unsafe url',
            install: { args: ['evil', '--transport', 'http', 'javascript:alert(1)'] },
        },
        { id: 'no-args', type: 'mcp', name: 'No Args', description: 'nothing to run', install: { args: [] } },
        { id: 'my-skill', type: 'skill', name: 'A Skill', description: 'not an mcp server', install: { args: ['cline/skills', '--skill', 'my-skill'] } },
    ],
};

const officialPayload = {
    metadata: { count: 5 },
    servers: [
        {
            server: {
                name: 'ai.adeu/adeu',
                description: 'Deal sourcing agent\u0000 with a very long tail',
                version: '1.5.2',
                packages: [{ registryType: 'pypi', identifier: 'adeu', version: '1.5.2' }],
                repository: { url: 'https://github.com/dealfluence/adeu' },
            },
            _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: false } },
        },
        {
            server: {
                name: 'ai.adeu/adeu',
                title: 'Adeu',
                description: 'Deal sourcing agent',
                version: '1.7.1',
                packages: [
                    {
                        registryType: 'npm',
                        identifier: '@adeu/mcp-server',
                        version: '1.7.1',
                        environmentVariables: [
                            { name: 'ADTEST_API_KEY', description: 'developer key', isRequired: true, isSecret: true },
                            { name: 'bad name!', description: 'ignored' },
                        ],
                    },
                    { registryType: 'pypi', identifier: 'adeu' },
                ],
                repository: { url: 'https://github.com/dealfluence/adeu' },
            },
            _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } },
        },
        {
            server: {
                name: 'ac.inference.sh/mcp',
                title: 'inference.sh',
                description: 'Run 150+ AI apps',
                version: '2.0.0',
                remotes: [
                    { type: 'streamable-http', url: 'https://api.inference.sh/mcp' },
                    { type: 'sse', url: 'javascript:alert(1)' },
                ],
            },
        },
        {
            server: {
                name: 'io.example/oci-only',
                description: 'container only',
                packages: [{ registryType: 'oci', identifier: 'ghcr.io/example/mcp', version: '1.0.0' }],
            },
        },
        {
            server: {
                name: 'io.example/nuget-only',
                description: 'unsupported runtime',
                packages: [{ registryType: 'nuget', identifier: 'Example.Mcp' }],
            },
        },
        { server: { name: '', description: 'no name' } },
    ],
};

// --- shape detection ------------------------------------------------------

check('shape: cline catalog', detectPayloadShape(clineCatalog), 'cline');
check('shape: official', detectPayloadShape(officialPayload), 'official');
check('shape: xratu', detectPayloadShape({ servers: [{ name: 'a', server: { command: 'npx' } }] }), 'xratu');
check('shape: unknown object', detectPayloadShape({ hello: 1 }), 'unknown');
check('shape: unknown array', detectPayloadShape([{ hello: 1 }]), 'unknown');
check('shape: garbage never throws', parseMarketplacePayload('nope'), []);

// --- cline catalog --------------------------------------------------------

const cline = parseClineCatalog(clineCatalog);
check('cline: only mcp entries', cline.length, 5);
check('cline: skill entries excluded', cline.some((e) => e.id.includes('my-skill')), false);
check('cline: skill parser reuses the shape', parseClineCatalog(clineCatalog, 'skill').length, 1);

const aikido = cline.find((e) => e.id === 'cline:aikido');
check('cline: stdio install', aikido.install, { kind: 'stdio', command: 'npx', args: ['-y', '@aikidosec/mcp@1.0.9'], runtime: 'node' });
check('cline: server name from id, not the generic package', aikido.serverName, 'aikido');
check('cline: author object flattened', [aikido.author, aikido.authorUrl], ['Aikido Security', 'https://aikido.dev/']);
check('cline: featured becomes recommended', aikido.recommended, true);
check('cline: verified false stays undefined', aikido.verified, undefined);
check('cline: tags lowercased', aikido.tags, ['security', 'software']);
check('cline: tagline kept', aikido.tagline, 'Security scanning for your code');
check('cline: repo + homepage kept', [aikido.repoUrl, aikido.homepageUrl], ['https://github.com/AikidoSec/aikido-claude-plugin', 'https://help.aikido.dev/ide-plugins/aikido-mcp']);

const airtable = cline.find((e) => e.id === 'cline:airtable');
check('cline: remote install', airtable.install, {
    kind: 'remote',
    type: 'streamableHttp',
    url: 'https://mcp.airtable.com/mcp',
    envVars: [{ name: 'AIRTABLE_TOKEN', description: 'Airtable personal access token', url: 'https://airtable.com/create/tokens', required: true }],
});
check('cline: required env marks api key', airtable.requiresApiKey, true);
check('cline: verified true kept', airtable.verified, true);

const headerServer = cline.find((e) => e.id === 'cline:header-server');
check('cline: sse transport', headerServer.install, {
    kind: 'remote',
    type: 'sse',
    url: 'https://example.com/sse',
    envVars: [{ name: 'MY_TOKEN', secret: true, required: true }],
});
check('cline: header VALUE never carried', JSON.stringify(cline).includes('Bearer'), false);
check('cline: header placeholder becomes env var', headerServer.requiresApiKey, true);

check('cline: unsafe remote url dropped', cline.find((e) => e.id === 'cline:evil').install, null);
check('cline: unsafe entry not installable', cline.find((e) => e.id === 'cline:evil').installConfidence, 'none');
check('cline: empty args not installable', cline.find((e) => e.id === 'cline:no-args').install, null);
check('cline: non-catalog payload', parseClineCatalog({ entries: 'nope' }), []);

// --- cline install-arg convention ----------------------------------------

check('args: stdio with separator', parseClineInstallArgs(['srv', '--', 'uvx', 'pkg@latest']).install, { kind: 'stdio', command: 'uvx', args: ['pkg@latest'], runtime: 'python' });
check('args: stdio without separator', parseClineInstallArgs(['srv', 'npx', '-y', 'pkg']).install, { kind: 'stdio', command: 'npx', args: ['-y', 'pkg'], runtime: 'node' });
check('args: docker runtime', parseClineInstallArgs(['srv', '--', 'docker', 'run', '-i', '--rm', 'img']).install, { kind: 'stdio', command: 'docker', args: ['run', '-i', '--rm', 'img'], runtime: 'docker' });
check('args: http transport', parseClineInstallArgs(['srv', '--transport', 'http', 'https://x.example/mcp']).install, { kind: 'remote', type: 'streamableHttp', url: 'https://x.example/mcp' });
check('args: transport= form', parseClineInstallArgs(['srv', '--transport=sse', 'https://x.example/sse']).install, { kind: 'remote', type: 'sse', url: 'https://x.example/sse' });
check('args: remote without url', parseClineInstallArgs(['srv', '--transport', 'http', 'nope']).install, null);
check('args: header names collected', parseClineInstallArgs(['srv', '--transport', 'http', 'https://x.example/mcp', '--header', 'X-API-Key: $KEY']).headerNames, ['X-API-Key']);
check('args: no args', parseClineInstallArgs([]).install, null);
check('args: non-array', parseClineInstallArgs('nope').install, null);

// --- official registry ----------------------------------------------------

const official = parseOfficialRegistry(officialPayload);
const adeu = official.find((e) => e.name === 'Adeu');
check('official: version dedupe keeps one row', official.filter((e) => e.name === 'Adeu').length, 1);
check('official: isLatest version wins', adeu.version, '1.7.1');
check('official: npm package mapped', adeu.install, {
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@adeu/mcp-server@1.7.1'],
    runtime: 'node',
    envVars: [{ name: 'ADTEST_API_KEY', description: 'developer key', secret: true, required: true }],
});
check('official: secret env marks api key', adeu.requiresApiKey, true);
check('official: control chars stripped', official.every((e) => !/[\u0000-\u001f]/.test(e.description)), true);
check('official: repo url kept', adeu.repoUrl, 'https://github.com/dealfluence/adeu');

const inference = official.find((e) => e.name === 'inference.sh');
check('official: remote fallback', inference.install, { kind: 'remote', type: 'streamableHttp', url: 'https://api.inference.sh/mcp' });
check('official: javascript url dropped', official.some((e) => JSON.stringify(e).includes('javascript:')), false);
check('official: reverse-dns generic segment keeps full id', inference.serverName, 'ac-inference-sh-mcp');

const oci = official.find((e) => e.description === 'container only');
check('official: oci to docker run with tag', oci.install, { kind: 'stdio', command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/example/mcp:1.0.0'], runtime: 'docker' });
const nuget = official.find((e) => e.description === 'unsupported runtime');
check('official: unsupported registry not installable', nuget.install, null);
check('official: unsupported registry confidence', nuget.installConfidence, 'none');
check('official: nameless row skipped', official.some((e) => e.description === 'no name'), false);
check('official: entry count (version dedupe applied)', official.length, 4);
check('official: ids namespaced', official.every((e) => e.id.startsWith('official:')), true);
check('official: null payload', parseOfficialRegistry(null), []);

check('package: pypi version pin', packageToInstall({ registryType: 'pypi', identifier: 'adeu', version: '1.5.2' }), { kind: 'stdio', command: 'uvx', args: ['adeu==1.5.2'], runtime: 'python' });
check('package: npm without version', packageToInstall({ registryType: 'npm', identifier: 'foo-mcp' }), { kind: 'stdio', command: 'npx', args: ['-y', 'foo-mcp'], runtime: 'node' });
check('package: npm identifier already versioned', packageToInstall({ registryType: 'npm', identifier: 'foo-mcp@2.0.0' }).args, ['-y', 'foo-mcp@2.0.0']);
check('package: unknown registry', packageToInstall({ registryType: 'mcpb', identifier: 'x' }), null);
check('package: no identifier', packageToInstall({ registryType: 'npm' }), null);

// --- generated catalog copy: no borrowed client branding -------------------
// The catalog's pipeline writes copy addressed to ITS client ("Connect Cline to
// X" x115, "installable through Cline" x80 of 203 entries), which put another
// product's name on every row of our list. The rewrite must stay NARROW:
// entries that genuinely integrate with that product keep their wording.
check(
    'parsed boilerplate is re-addressed to our client',
    cline.find((e) => e.id === 'cline:aikido').description,
    'Connect Xratu to Aikido through this MCP server.',
);
check('generated tagline shape is re-addressed', neutralizeClientCopy('Connect Cline to AWS IaC'), 'Connect Xratu to AWS IaC');
check(
    'generated installable-through shape is re-addressed',
    neutralizeClientCopy('Manage Airtable bases. This official Airtable MCP integration is installable through Cline.'),
    'Manage Airtable bases. This official Airtable MCP integration is installable through Xratu.',
);
check('lowercase variant is handled', neutralizeClientCopy('connect cline to X'), 'connect Xratu to X');
check('title-case variant is handled', neutralizeClientCopy('Installable Through Cline.'), 'Installable Through Xratu.');

// Copy that describes a REAL integration must survive verbatim - rewriting it
// would misrepresent what the server does. These are the catalog's own
// non-boilerplate strings; they sit on plugin/skill entries, so a future skills
// marketplace will surface them and must keep them intact.
for (const real of [
    'macOS notifications when a Cline run completes',
    'Speaks completed Cline replies with ElevenLabs text to speech',
    'Exa-backed web search as a Cline tool',
    'Cline SDK reference docs for AI coding assistants',
    'Troubleshoot AWS Bedrock auth, regions, model access, and Cline CLI provider setup',
]) {
    check(`semantic mention preserved (${real.slice(0, 28)}...)`, neutralizeClientCopy(real), real);
}

check(
    'a command inside copy is never rewritten',
    neutralizeClientCopy('Install with:\n\n```bash\ncline mcp install foo -- npx -y foo\n```'),
    'Install with:\n\n```bash\ncline mcp install foo -- npx -y foo\n```',
);
check('copy with no mention is untouched', neutralizeClientCopy('Query your Postgres database.'), 'Query your Postgres database.');
check('substitution is idempotent', neutralizeClientCopy(neutralizeClientCopy('Connect Cline to AWS')), 'Connect Xratu to AWS');
check('empty input is safe', neutralizeClientCopy(''), '');
check('the client name is configurable', neutralizeClientCopy('Connect Cline to X', 'Other'), 'Connect Other to X');

// --- catalog tag vocabulary ------------------------------------------------
// Tags are shown as localized labels in the UI; the catalog's own `tags`
// array is the fallback for ids this build has no translation for, so a tag is
// never rendered as a bare id.
check('tags: id maps to the catalog label', parseCatalogTagLabels(clineCatalog), { data: 'Data' });
check('tags: ids are lowercased', parseCatalogTagLabels({ tags: [{ id: 'Data', label: 'Data & Analytics' }] }), { data: 'Data & Analytics' });
check('tags: junk rows are skipped', parseCatalogTagLabels({ tags: [{ id: 'ok', label: 'OK' }, { label: 'no id' }, { id: 'no-label' }, null, 'nope'] }), { ok: 'OK' });
check('tags: non-object payload', parseCatalogTagLabels('nope'), {});
check('tags: missing array', parseCatalogTagLabels({ entries: [] }), {});
check('tags: label capped at 64 entries', Object.keys(parseCatalogTagLabels({
    tags: Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, label: `L${i}` })),
})).length, 64);

// --- xratu catalog (self-hosted mirror) -----------------------------------

const xratu = parseXratuCatalog({
    servers: [
        {
            id: 'foo',
            name: 'Foo Server',
            description: 'does foo',
            category: 'developer-tools',
            tags: ['Foo', 'bar'],
            repoUrl: 'https://github.com/example/foo',
            server: { name: 'foo-server', command: 'npx', args: ['-y', 'foo-mcp'], env: { FOO_KEY: 'abc', 'bad key': 'x' } },
        },
        { id: 'remote', name: 'Remote Server', server: { url: 'https://example.com/mcp', type: 'streamableHttp' } },
        { name: 'no server block' },
    ],
});
check('xratu: stdio install from server block', xratu[0].install, { kind: 'stdio', command: 'npx', args: ['-y', 'foo-mcp'], env: { FOO_KEY: 'abc' }, runtime: 'node' });
check('xratu: invalid env key dropped', Object.keys(xratu[0].install.env), ['FOO_KEY']);
check('xratu: remote install', xratu[1].install, { kind: 'remote', type: 'streamableHttp', url: 'https://example.com/mcp' });
check('xratu: rows without a server block skipped', xratu.length, 2);
check('xratu: source label', xratu[0].source, 'remote');
check('xratu: bare array accepted', parseXratuCatalog([{ name: 'A', server: { command: 'uvx', args: ['x'] } }]).length, 1);

// --- curated list ---------------------------------------------------------

const curated = curatedMarketplaceEntries();
check('curated: vendored entries converted', curated.length >= 9, true);
const ddg = curated.find((e) => e.id === 'curated:ddg-search');
check('curated: pinned uvx args survive', ddg.install, { kind: 'stdio', command: 'uvx', args: ['duckduckgo-mcp-server==0.7.0'], runtime: 'python' });
check('curated: i18n keys preserved', [ddg.nameKey, ddg.descKey], ['mcpRegDdgName', 'mcpRegDdgDesc']);
check('curated: confidence curated', ddg.installConfidence, 'curated');
check('curated: docs url kept', curated.find((e) => e.id === 'curated:context7').homepageUrl, 'https://github.com/upstash/context7');

// --- merge ----------------------------------------------------------------

const merged = mergeMarketplaceEntries([curated, official]);
check('merge: unrelated rows all survive', merged.length, curated.length + official.length);

// A registry row that mirrors a curated entry (same pinned command) must not
// create a second row - the vetted, localized curated one stays.
const collision = mergeMarketplaceEntries([
    curated,
    [{
        id: 'official:ddg',
        source: 'official',
        serverName: 'duckduckgo-mcp-server',
        name: 'DuckDuckGo Search',
        description: '',
        tags: [],
        install: { kind: 'stdio', command: 'uvx', args: ['duckduckgo-mcp-server==0.7.0'], runtime: 'python' },
        installConfidence: 'registry',
    }],
]);
check('merge: identical pinned command collapsed', collision.length, curated.length);
check('merge: curated row wins the collision', collision.find((e) => e.serverName === 'ddg-search').source, 'curated');
check('merge: curated row kept its i18n keys', collision.find((e) => e.serverName === 'ddg-search').nameKey, 'mcpRegDdgName');

const upgraded = mergeMarketplaceEntries([
    [{ id: 'a', source: 'cline', serverName: 'x', name: 'X', description: '', tags: [], repoUrl: 'https://github.com/a/b', install: null, installConfidence: 'none' }],
    [{ id: 'b', source: 'official', serverName: 'x', name: 'X other', description: '', tags: [], repoUrl: 'https://github.com/a/b/', install: { kind: 'stdio', command: 'npx', args: ['-y', 'x'], runtime: 'node' }, installConfidence: 'registry' }],
]);
check('merge: repo url dedupe', upgraded.length, 1);
check('merge: higher confidence replaces lower', upgraded[0].installConfidence, 'registry');

// --- search / filters -----------------------------------------------------

const catalog = [
    { id: '1', source: 'official', serverName: 'postgres', name: 'Postgres MCP', description: 'query databases', tags: ['sql'], install: null, installConfidence: 'none', stars: 5 },
    { id: '2', source: 'official', serverName: 'files', name: 'Filesystem', description: 'read local files', tags: ['files', 'postgres'], install: null, installConfidence: 'none' },
    { id: '3', source: 'official', serverName: 'search', name: 'Web Search', description: 'search the web', tags: [], install: null, installConfidence: 'none', downloads: 900000 },
];
check('search: empty query returns everything', searchMarketplaceEntries(catalog, '').length, 3);
check('search: name hit ranks above tag hit', searchMarketplaceEntries(catalog, 'postgres').map((e) => e.id), ['1', '2']);
check('search: every token must match', searchMarketplaceEntries(catalog, 'postgres zebra').length, 0);
check('search: description match works', searchMarketplaceEntries(catalog, 'databases').map((e) => e.id), ['1']);
check('search: case insensitive', searchMarketplaceEntries(catalog, 'WEB').map((e) => e.id), ['3']);
check('search: popularity breaks ties', searchMarketplaceEntries(catalog, 'e').map((e) => e.id)[0], '3');
check('search: serverName is searchable', searchMarketplaceEntries(catalog, 'files').map((e) => e.id), ['2']);
check('categories: most common first', collectCategories([...catalog, { ...catalog[0], id: '4', category: 'db' }, { ...catalog[0], id: '5', category: 'db' }]), ['db']);
check('tags: counted and ordered', collectTags([{ ...catalog[0], tags: ['a', 'b'] }, { ...catalog[1], tags: ['b'] }]), ['b', 'a']);
check('tags: capped', collectTags(Array.from({ length: 40 }, (_, i) => ({ ...catalog[0], id: `t${i}`, tags: [`tag${i}`] }))).length, 16);

// --- README detection -----------------------------------------------------

check('readme: npx -y package', detectInstallFromReadme('Run it:\n\n```bash\nnpx -y @modelcontextprotocol/server-filesystem /tmp\n```'), { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], runtime: 'node' });
check('readme: uvx package', detectInstallFromReadme('## Quick start\n\n```sh\nuvx mcp-server-fetch\n```'), { kind: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], runtime: 'python' });
check('readme: docker keeps image only', detectInstallFromReadme('docker run -i --rm -e API_KEY=secret ghcr.io/example/mcp'), { kind: 'stdio', command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/example/mcp'], runtime: 'docker' });
check('readme: remote url', detectInstallFromReadme('Add this URL: https://mcp.postman.com/minimal/mcp to your host'), { kind: 'remote', type: 'streamableHttp', url: 'https://mcp.postman.com/minimal/mcp' });
check('readme: sse url', detectInstallFromReadme('endpoint: https://example.com/sse'), { kind: 'remote', type: 'sse', url: 'https://example.com/sse' });
check('readme: placeholders rejected', detectInstallFromReadme('npx -y <your-package>\nnpx -y my-server'), null);
check('readme: env-prefixed command detected', detectInstallFromReadme('FOO=1 npx -y real-mcp'), { kind: 'stdio', command: 'npx', args: ['-y', 'real-mcp'], runtime: 'node' });
check('readme: most frequent command wins', detectInstallFromReadme('npx -y rare-pkg\nnpx -y common-pkg\nnpx -y common-pkg').args, ['-y', 'common-pkg']);
check('readme: empty input', detectInstallFromReadme(''), null);
check('readme: nothing runnable', detectInstallFromReadme('# Just docs\n\nnothing here'), null);
check('readme: javascript url rejected', detectInstallFromReadme('javascript:alert(1)/mcp'), null);
check('docker: flags with values skipped', dockerImageFrom('-i --rm --name foo -v /tmp:/data ghcr.io/a/b:1.2'), 'ghcr.io/a/b:1.2');
check('docker: placeholder image rejected', dockerImageFrom('-i --rm your-image'), null);

// --- helpers and caps -----------------------------------------------------

check('cleanText: collapses and trims', cleanText('  a\n\t b  ', 40), 'a b');
check('cleanText: truncates with ellipsis', cleanText('x'.repeat(20), 10), 'xxxxxxxxx\u2026');
check('cleanText: non-string', cleanText(null, 10), '');
check('slugify: strips junk', slugifyServerName('@Scope/My Server!'), 'scope-my-server');
check('slugify: no trailing dash', slugifyServerName('abc-'), 'abc');
check('slugify: caps length', slugifyServerName('a'.repeat(80)).length, MARKETPLACE_LIMITS.serverName);
check('deriveServerName: generic segment falls back to full id', deriveServerName(['ac.inference.sh/mcp']), 'ac-inference-sh-mcp');
check('deriveServerName: generic package skipped', deriveServerName(['mcp', 'real-id']), 'real-id');
check('deriveServerName: package segment wins', deriveServerName(['@scope/pkg', 'ai.x/y']), 'pkg');
check('deriveServerName: nothing usable', deriveServerName([undefined, '']), 'mcp-server');
check('safeHttpUrl: rejects non-http', safeHttpUrl('file:///etc/passwd'), undefined);
check('safeHttpUrl: normalizes', safeHttpUrl('  https://example.com/a  '), 'https://example.com/a');
check('compareVersions', [compareVersions('1.10.0', '1.9.2'), compareVersions('1.0.0', '1.0.0'), compareVersions('0.9', '1.0')], [1, 0, -1]);
check('long description truncated', parseClineCatalog({ entries: [{ id: 'a', type: 'mcp', name: 'B', description: 'd'.repeat(1000) }] })[0].description.length <= MARKETPLACE_LIMITS.description, true);
check('entry cap enforced', parseClineCatalog({ entries: Array.from({ length: 1200 }, (_, i) => ({ id: `s${i}`, type: 'mcp', name: `S${i}` })) }).length, MARKETPLACE_LIMITS.entries);

console.log(failed === 0 ? '\nmcp-marketplace tests: all passed' : `\nmcp-marketplace tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
