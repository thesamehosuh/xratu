/**
 * Live MCP marketplace - pure parsing / normalization layer.
 *
 * Catalogs are REMOTE and therefore untrusted: whatever lands here becomes a
 * spawnable command in the user's mcp.json. So this layer never invents
 * authority - it carries only install metadata a catalog explicitly declares,
 * caps every field, drops secret-looking values, and labels guesses as
 * `detected` so the UI forces a review before the config is written.
 *
 * Supported shapes:
 *   - `cline`    https://cline.github.io/marketplace/catalog.json
 *                ({ entries: [{ type, install: { args: [name, '--', cmd…] } }] })
 *                Interop: same catalog Cline itself consumes.
 *   - `official` https://registry.modelcontextprotocol.io/v0/servers
 *                (packages/remotes with npm/pypi/oci identifiers)
 *   - `xratu`    a self-hosted mirror: { servers: [{ server: { command|url } }] }
 *   - `curated`  the vendored list in mcpRegistry.ts (offline fallback)
 *
 * Dependency-free and side-effect-free: the network/disk/settings glue lives
 * in `mcpMarketplaceClient.ts`, so everything here is unit-testable.
 */

import { MCP_REGISTRY, type McpRegistryEntry } from './mcpRegistry';

/** Catalog URLs shipped as the default sources. */
export const CLINE_CATALOG_URL = 'https://cline.github.io/marketplace/catalog.json';
export const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';

/** Which catalog an entry came from. `curated` is the vendored offline list. */
export type MarketplaceSource = 'official' | 'cline' | 'remote' | 'curated';

/** How much the install block can be trusted. */
export type InstallConfidence = 'registry' | 'curated' | 'detected' | 'none';

export interface MarketplaceEnvVar {
    name: string;
    description?: string;
    /** Docs/token-creation URL - where the user goes to get the value. */
    url?: string;
    secret?: boolean;
    required?: boolean;
}

export interface MarketplaceStdioInstall {
    kind: 'stdio';
    command: string;
    args: string[];
    /** Non-secret defaults only - catalogs never carry credentials. */
    env?: Record<string, string>;
    envVars?: MarketplaceEnvVar[];
    runtime: 'node' | 'python' | 'docker' | 'binary';
}

export interface MarketplaceRemoteInstall {
    kind: 'remote';
    type: 'streamableHttp' | 'sse';
    url: string;
    /** Credentials the server expects (usually an auth header). Remote
     *  entries carry these too - a token cannot be guessed from a URL, so
     *  such an entry is routed to the editor instead of a direct add. */
    envVars?: MarketplaceEnvVar[];
}

export type MarketplaceInstall = MarketplaceStdioInstall | MarketplaceRemoteInstall;

export interface MarketplaceEntry {
    /** Stable identity (`source:key`) - survives re-fetches of the catalog. */
    id: string;
    source: MarketplaceSource;
    /** Suggested key in mcp.json (the UI unique-ifies it on add). */
    serverName: string;
    name: string;
    /** i18n keys for vendored curated entries - their text lives in i18n. */
    nameKey?: string;
    descKey?: string;
    /** One-line summary (catalog `tagline`). */
    tagline?: string;
    description: string;
    author?: string;
    authorUrl?: string;
    version?: string;
    category?: string;
    tags: string[];
    homepageUrl?: string;
    repoUrl?: string;
    stars?: number;
    downloads?: number;
    /** Catalog says a user-supplied credential is needed. */
    requiresApiKey?: boolean;
    /** Vouched for by the catalog publisher. */
    verified?: boolean;
    /** Catalog's editor pick. */
    recommended?: boolean;
    install: MarketplaceInstall | null;
    installConfidence: InstallConfidence;
}

export interface MarketplaceCacheFile {
    version: number;
    fetchedAt: number;
    sources: string[];
    entries: MarketplaceEntry[];
    /** Catalog-published tag labels (id → human label). */
    tagLabels?: Record<string, string>;
}

export const MARKETPLACE_CACHE_VERSION = 1;

/** Hard caps on catalog-controlled strings: a hostile catalog must not be
 *  able to balloon the webview payload or smuggle control characters. */
export const MARKETPLACE_LIMITS = {
    name: 120,
    tagline: 160,
    description: 400,
    author: 60,
    category: 40,
    version: 32,
    tags: 12,
    tag: 24,
    args: 20,
    arg: 200,
    env: 12,
    envVarName: 64,
    envVarDescription: 200,
    serverName: 40,
    /** Entries kept per catalog (defensive upper bound). */
    entries: 800,
} as const;

/** Strip control characters, collapse whitespace, trim, and truncate. */
export function cleanText(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    const stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (stripped.length <= max) return stripped;
    return stripped.slice(0, max - 1).trimEnd() + '\u2026';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string');
}

function asFiniteNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return undefined;
}

/** Keep only http(s) URLs - a catalog must not push `javascript:`/`file:`
 *  links into the UI. */
export function safeHttpUrl(value: unknown): string | undefined {
    const raw = asString(value).trim();
    if (!raw) return undefined;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
        return parsed.toString();
    } catch {
        return undefined;
    }
}

/** Slug for an mcp.json key: `[a-z0-9-]`, no leading/trailing dash. */
export function slugifyServerName(value: string, max = MARKETPLACE_LIMITS.serverName): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, max)
        .replace(/-+$/g, '');
}

const GENERIC_PATH_SEGMENTS = new Set(['mcp', 'sse', 'http', 'server', 'stdio', 'api', 'v1', 'latest']);

/** Best-effort config key for an entry. Prefers the package/command name (what
 *  the user actually runs) over the catalog's reverse-DNS id. */
export function deriveServerName(candidates: Array<string | undefined>): string {
    for (const candidate of candidates) {
        const raw = asString(candidate).trim();
        if (!raw) continue;
        const segment = raw.split('/').filter(Boolean).pop() ?? raw;
        const source = GENERIC_PATH_SEGMENTS.has(segment.toLowerCase()) ? raw : segment;
        const slug = slugifyServerName(source);
        // A generic slug (`mcp`, `server`, `@scope/mcp`) names nothing useful -
        // fall through to the next candidate instead of keying the config `mcp`.
        if (slug.length >= 3 && !GENERIC_PATH_SEGMENTS.has(slug)) return slug;
    }
    return 'mcp-server';
}

/** Strip an npm scope and version suffix: `@scope/pkg@1.2.3` → `pkg`. */
function packageBaseName(identifier: string): string {
    const withoutVersion = identifier.replace(/@[^@/]+$/, '');
    const parts = withoutVersion.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? withoutVersion;
}

function runtimeForCommand(command: string): MarketplaceStdioInstall['runtime'] {
    const base = command.split(/[\\/]/).pop()?.toLowerCase() ?? command.toLowerCase();
    if (base === 'npx' || base === 'npx.cmd' || base === 'node' || base === 'npm') return 'node';
    if (base === 'uvx' || base === 'uv' || base === 'python' || base === 'python3') return 'python';
    if (base === 'docker' || base === 'podman') return 'docker';
    return 'binary';
}

// ---------------------------------------------------------------------------
// Install derivation
// ---------------------------------------------------------------------------

function parseEnvVars(value: unknown): MarketplaceEnvVar[] {
    if (!Array.isArray(value)) return [];
    const out: MarketplaceEnvVar[] = [];
    for (const raw of value) {
        const record = asRecord(raw);
        if (!record) continue;
        const name = cleanText(record.name, MARKETPLACE_LIMITS.envVarName);
        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        out.push({
            name,
            description: cleanText(record.description, MARKETPLACE_LIMITS.envVarDescription) || undefined,
            url: safeHttpUrl(record.url),
            secret: record.isSecret === true || record.secret === true || undefined,
            required: record.isRequired === true || record.required === true || undefined,
        });
        if (out.length >= MARKETPLACE_LIMITS.env) break;
    }
    return out;
}

interface PackageShape {
    registryType?: unknown;
    identifier?: unknown;
    version?: unknown;
    environmentVariables?: unknown;
}

/** Official-registry package block → a runnable command. Only well-known
 *  registries are mapped; anything else stays non-installable rather than
 *  guessing. */
export function packageToInstall(pkg: PackageShape): MarketplaceStdioInstall | null {
    const identifier = cleanText(pkg.identifier, 120);
    if (!identifier) return null;
    const version = cleanText(pkg.version, MARKETPLACE_LIMITS.version);
    const registryType = cleanText(pkg.registryType, 24).toLowerCase();
    const envVars = parseEnvVars(pkg.environmentVariables);
    const base = envVars.length ? { envVars } : {};

    if (registryType === 'npm') {
        const spec = version && !/^@[^/]+\/[^@]+@/.test(identifier) && !identifier.includes('@', 1)
            ? `${identifier}@${version}`
            : identifier;
        return { kind: 'stdio', command: 'npx', args: ['-y', spec], runtime: 'node', ...base };
    }
    if (registryType === 'pypi') {
        const spec = version ? `${identifier}==${version}` : identifier;
        return { kind: 'stdio', command: 'uvx', args: [spec], runtime: 'python', ...base };
    }
    if (registryType === 'oci' || registryType === 'docker') {
        const image = version && !/:[^/]+$/.test(identifier) ? `${identifier}:${version}` : identifier;
        return { kind: 'stdio', command: 'docker', args: ['run', '-i', '--rm', image], runtime: 'docker', ...base };
    }
    return null;
}

function remoteToInstall(remote: Record<string, unknown>): MarketplaceRemoteInstall | null {
    const url = safeHttpUrl(remote.url);
    if (!url) return null;
    const type = cleanText(remote.type, 32).toLowerCase();
    return { kind: 'remote', type: type === 'sse' ? 'sse' : 'streamableHttp', url };
}

/** A raw mcp.json-shaped server block (command/args/env or url/type). */
export function serverToInstall(server: Record<string, unknown>): MarketplaceInstall | null {
    const url = safeHttpUrl(server.url);
    if (url) {
        const type = cleanText(server.type, 32).toLowerCase();
        return { kind: 'remote', type: type === 'sse' ? 'sse' : 'streamableHttp', url };
    }
    const command = cleanText(server.command, MARKETPLACE_LIMITS.arg);
    if (!command) return null;
    const args = asStringArray(server.args).map((a) => cleanText(a, MARKETPLACE_LIMITS.arg)).filter(Boolean);
    const envRecord = asRecord(server.env);
    const env: Record<string, string> = {};
    if (envRecord) {
        for (const [key, value] of Object.entries(envRecord).slice(0, MARKETPLACE_LIMITS.env)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
            env[key] = cleanText(value, MARKETPLACE_LIMITS.arg);
        }
    }
    return {
        kind: 'stdio',
        command,
        args: args.slice(0, MARKETPLACE_LIMITS.args),
        env: Object.keys(env).length ? env : undefined,
        runtime: runtimeForCommand(command),
    };
}

/** True when the entry needs a credential the user must supply. */
function installNeedsSecret(install: MarketplaceInstall | null): boolean {
    if (!install || install.kind !== 'stdio') return false;
    return !!install.envVars?.some((v) => v.secret && v.required);
}

// ---------------------------------------------------------------------------
// Cline catalog (interop: the catalog Cline itself consumes)
// ---------------------------------------------------------------------------

/**
 * Cline's published catalog encodes install instructions as CLI args:
 *   stdio   [name, '--', command, ...args]        (npx / uvx / node / docker)
 *   remote  [name, '--transport', 'http'|'sse', url]
 * plus optional `--header 'Name: value'` pairs and an `env` list that points
 * at where the user gets the credential.
 *
 * `--header` values are DROPPED, never carried: a catalog-supplied header is
 * either a placeholder (we keep just the referenced env var name) or an
 * actual secret that has no business in a marketplace entry.
 */
export function parseClineInstallArgs(args: unknown): {
    install: MarketplaceInstall | null;
    envVars: MarketplaceEnvVar[];
    headerNames: string[];
} {
    const argv = asStringArray(args).map((a) => cleanText(a, MARKETPLACE_LIMITS.arg)).filter(Boolean);
    const envVars: MarketplaceEnvVar[] = [];
    const headerNames: string[] = [];
    if (argv.length < 2) return { install: null, envVars, headerNames };

    const rest: string[] = [];
    let transport: string | null = null;
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--transport') {
            transport = (argv[i + 1] ?? '').toLowerCase();
            i++;
            continue;
        }
        if (arg.startsWith('--transport=')) {
            transport = arg.slice('--transport='.length).toLowerCase();
            continue;
        }
        if (arg === '--header') {
            collectHeader(argv[i + 1] ?? '', headerNames, envVars);
            i++;
            continue;
        }
        if (arg.startsWith('--header=')) {
            collectHeader(arg.slice('--header='.length), headerNames, envVars);
            continue;
        }
        rest.push(arg);
    }

    if (transport && transport !== 'stdio') {
        const url = safeHttpUrl(rest.find((arg) => /^https?:\/\//i.test(arg)));
        if (!url) return { install: null, envVars, headerNames };
        return {
            install: { kind: 'remote', type: transport === 'sse' ? 'sse' : 'streamableHttp', url },
            envVars,
            headerNames,
        };
    }

    // stdio: the separator is optional in practice, so accept both
    // `name -- npx -y pkg` and `name npx -y pkg`.
    const commandIndex = rest[0] === '--' ? 1 : 0;
    const command = rest[commandIndex];
    if (!command) return { install: null, envVars, headerNames };
    const commandArgs = rest.slice(commandIndex + 1);
    if (commandArgs[0] === '--') commandArgs.shift();
    return {
        install: {
            kind: 'stdio',
            command,
            args: commandArgs.slice(0, MARKETPLACE_LIMITS.args),
            runtime: runtimeForCommand(command),
        },
        envVars,
        headerNames,
    };
}

const ENV_PLACEHOLDER_RE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;

/** Record a header's NAME (and any env var it references) - never its value. */
function collectHeader(raw: string, headerNames: string[], envVars: MarketplaceEnvVar[]): void {
    const name = cleanText(raw.split(':')[0], MARKETPLACE_LIMITS.envVarName);
    if (name && /^[A-Za-z0-9-]+$/.test(name) && !headerNames.includes(name)) headerNames.push(name);
    for (const match of raw.matchAll(ENV_PLACEHOLDER_RE)) {
        const envName = match[1];
        if (envVars.some((v) => v.name === envName)) continue;
        if (envVars.length >= MARKETPLACE_LIMITS.env) break;
        envVars.push({ name: envName, secret: true, required: true });
    }
}

/**
 * Cline catalog (`cline.github.io/marketplace/catalog.json`):
 * `{ entries: [{ id, type: 'mcp'|'skill'|'plugin', name, tagline, description,
 *   author: { name, url }, tags, verified, featured, repo, homepage,
 *   install: { command, args, env } }] }`.
 *
 * Only `type === 'mcp'` entries become MCP servers; the same catalog also
 * carries skills, which a future skills marketplace can reuse this parser for.
 */
/**
 * The catalog's own pipeline writes generated copy that addresses ITS client
 * ("Connect Cline to X", "… installable through Cline"). 115 of its 203
 * entries ship that boilerplate, so rendering it verbatim puts another
 * product's name all over our list - and it reads as a reskin.
 *
 * The rewrite is deliberately NARROW: only those generated, client-addressed
 * shapes are substituted. Occurrences that describe a REAL integration with
 * that product ("notifications when a Cline run completes", "Cline SDK
 * reference docs", "Cline CLI provider setup") stay VERBATIM - rewriting them
 * would misrepresent what the server actually does.
 *
 * Safe by construction for this catalog: no occurrence anywhere in it sits
 * inside a code fence or an install command (checked across all 203 entries),
 * so no instruction can be corrupted - and we render our OWN derived install
 * command, never the catalog's.
 */
export function neutralizeClientCopy(text: string, clientName = 'Xratu'): string {
    if (!text) return text;
    return text
        // The inner swap needs `i` too: the outer match is case-insensitive, so
        // a lowercase "connect cline to X" would match and then fail to swap
        // (caught by the lowercase-variant test). Casing of the surrounding
        // sentence is preserved either way - only the name is replaced.
        .replace(/\bConnect Cline to\b/gi, (m) => m.replace(/Cline/i, clientName))
        .replace(/\binstallable through Cline\b/gi, (m) => m.replace(/Cline/i, clientName));
}

/**
 * The catalog's own tag vocabulary: a top-level `tags: [{ id, label }]` array
 * mapping the ids entries carry to human labels ("data" → "Data & Analytics").
 *
 * We localize the vocabulary we know ourselves and fall back to these labels
 * for ids we have never seen, so a catalog can introduce a tag without waiting
 * for a translation (and a tag is never displayed as a bare id).
 */
export function parseCatalogTagLabels(payload: unknown): Record<string, string> {
    const root = asRecord(payload);
    const rows = Array.isArray(root?.tags) ? (root?.tags as unknown[]) : [];
    const out: Record<string, string> = {};
    for (const raw of rows) {
        const record = asRecord(raw);
        if (!record) continue;
        const id = cleanText(record.id, MARKETPLACE_LIMITS.tag).toLowerCase();
        const label = cleanText(record.label, 60);
        if (!id || !label) continue;
        out[id] = label;
        if (Object.keys(out).length >= 64) break;
    }
    return out;
}

export function parseClineCatalog(payload: unknown, type = 'mcp'): MarketplaceEntry[] {
    const root = asRecord(payload);
    const rows = Array.isArray(root?.entries) ? (root?.entries as unknown[]) : [];
    const out: MarketplaceEntry[] = [];
    for (const raw of rows) {
        const row = asRecord(raw);
        if (!row) continue;
        if (cleanText(row.type, 16) !== type) continue;
        const id = cleanText(row.id, MARKETPLACE_LIMITS.name);
        const name = cleanText(row.name, MARKETPLACE_LIMITS.name);
        if (!id && !name) continue;

        const installRecord = asRecord(row.install);
        const parsed = installRecord ? parseClineInstallArgs(installRecord.args) : { install: null, envVars: [], headerNames: [] };
        const declaredEnv = installRecord ? parseEnvVars(installRecord.env) : [];
        // Declared env entries win (they carry docs URLs); placeholders found
        // in headers are merged in so the requirement is never lost.
        const envVars = mergeEnvVars(declaredEnv, parsed.envVars);
        const authorRecord = asRecord(row.author);
        const author = authorRecord ? cleanText(authorRecord.name, MARKETPLACE_LIMITS.author) : cleanText(row.author, MARKETPLACE_LIMITS.author);
        const authorUrl = authorRecord ? safeHttpUrl(authorRecord.url) : undefined;
        const install = parsed.install;
        const needsCredential = envVars.some((v) => v.required) || parsed.headerNames.length > 0;

        out.push({
            id: `cline:${id || slugifyServerName(name)}`,
            source: 'cline',
            serverName: deriveServerName([parsed.install && parsed.install.kind === 'stdio' ? packageBaseName(parsed.install.args[parsed.install.args.length - 1] ?? '') : '', id, name]),
            name: name || id,
            tagline: neutralizeClientCopy(cleanText(row.tagline, MARKETPLACE_LIMITS.tagline)) || undefined,
            description: neutralizeClientCopy(cleanText(row.description, MARKETPLACE_LIMITS.description)),
            author: author || undefined,
            authorUrl,
            category: cleanText(row.category, MARKETPLACE_LIMITS.category) || undefined,
            tags: cleanTags(row.tags),
            repoUrl: safeHttpUrl(row.repo),
            homepageUrl: safeHttpUrl(row.homepage) ?? safeHttpUrl(row.repo),
            requiresApiKey: needsCredential || undefined,
            verified: row.verified === true || undefined,
            recommended: row.featured === true || undefined,
            install: install ? { ...install, ...(envVars.length ? { envVars } : {}) } : null,
            installConfidence: install ? 'registry' : 'none',
        });
        if (out.length >= MARKETPLACE_LIMITS.entries) break;
    }
    return out;
}

function mergeEnvVars(declared: MarketplaceEnvVar[], referenced: MarketplaceEnvVar[]): MarketplaceEnvVar[] {
    const out = [...declared];
    for (const item of referenced) {
        if (out.some((v) => v.name === item.name)) continue;
        out.push(item);
    }
    return out.slice(0, MARKETPLACE_LIMITS.env);
}

// ---------------------------------------------------------------------------
// Official MCP registry
// ---------------------------------------------------------------------------

/**
 * Official MCP registry (`registry.modelcontextprotocol.io/v0/servers`):
 * `{ servers: [{ server: { name, title, description, version, packages,
 * remotes, repository, websiteUrl }, _meta }], metadata }`.
 */
export function parseOfficialRegistry(payload: unknown): MarketplaceEntry[] {
    const root = asRecord(payload);
    const rows = Array.isArray(root?.servers) ? (root?.servers as unknown[]) : [];
    const byName = new Map<string, MarketplaceEntry>();

    for (const raw of rows) {
        const row = asRecord(raw);
        const server = asRecord(row?.server) ?? row;
        if (!server) continue;
        const catalogName = cleanText(server.name, MARKETPLACE_LIMITS.name);
        if (!catalogName) continue;

        const packages = Array.isArray(server.packages) ? (server.packages as PackageShape[]) : [];
        let install: MarketplaceInstall | null = null;
        let installServerName: string | undefined;
        for (const pkg of packages) {
            const candidate = packageToInstall(pkg);
            if (candidate) {
                install = candidate;
                installServerName = packageBaseName(cleanText(pkg.identifier, 120));
                break;
            }
        }
        if (!install) {
            const remotes = Array.isArray(server.remotes) ? (server.remotes as unknown[]) : [];
            for (const remote of remotes) {
                const record = asRecord(remote);
                if (!record) continue;
                const candidate = remoteToInstall(record);
                if (candidate) {
                    install = candidate;
                    break;
                }
            }
        }

        const repository = asRecord(server.repository);
        const entry: MarketplaceEntry = {
            id: `official:${catalogName}`,
            source: 'official',
            serverName: deriveServerName([installServerName, catalogName]),
            name: cleanText(server.title, MARKETPLACE_LIMITS.name) || catalogName,
            description: cleanText(server.description, MARKETPLACE_LIMITS.description),
            version: cleanText(server.version, MARKETPLACE_LIMITS.version) || undefined,
            tags: [],
            repoUrl: safeHttpUrl(repository?.url),
            homepageUrl: safeHttpUrl(server.websiteUrl),
            requiresApiKey: installNeedsSecret(install) || undefined,
            install,
            installConfidence: install ? 'registry' : 'none',
        };

        // The registry lists every published version - keep the newest per
        // server name so the list is not flooded with duplicates.
        const previous = byName.get(catalogName);
        if (!previous || preferOfficialEntry(entry, previous, row)) byName.set(catalogName, entry);
    }

    return [...byName.values()];
}

/** `isLatest` wins; otherwise a higher version string wins. */
function preferOfficialEntry(
    next: MarketplaceEntry,
    previous: MarketplaceEntry,
    nextRow: Record<string, unknown> | null,
): boolean {
    const meta = asRecord(asRecord(nextRow?._meta)?.['io.modelcontextprotocol.registry/official']);
    if (meta?.isLatest === true) return true;
    const nextVersion = next.version ?? '';
    const previousVersion = previous.version ?? '';
    if (!nextVersion) return false;
    if (!previousVersion) return true;
    return compareVersions(nextVersion, previousVersion) > 0;
}

/** Loose numeric version compare (`1.10.0` > `1.9.2`). */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(/[.+-]/).map((p) => Number.parseInt(p, 10));
    const pb = b.split(/[.+-]/).map((p) => Number.parseInt(p, 10));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = Number.isFinite(pa[i]) ? pa[i] : 0;
        const y = Number.isFinite(pb[i]) ? pb[i] : 0;
        if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Xratu-shaped catalog (self-hosted mirror)
// ---------------------------------------------------------------------------

/**
 * `{ servers: [{ id, name, description, category, tags, homepageUrl, repoUrl,
 *   server: { command, args, env } | { url, type } }] }` (a bare array works
 * too). Its install block is authoritative - this is the shape a self-hosted
 * mirror of the curated list would publish.
 */
export function parseXratuCatalog(payload: unknown): MarketplaceEntry[] {
    const root = asRecord(payload);
    const rows = Array.isArray(payload)
        ? payload
        : (Array.isArray(root?.servers) ? (root?.servers as unknown[]) : []);
    const out: MarketplaceEntry[] = [];
    for (const raw of rows) {
        const row = asRecord(raw);
        if (!row) continue;
        const name = cleanText(row.name, MARKETPLACE_LIMITS.name);
        const server = asRecord(row.server);
        if (!name || !server) continue;
        const install = serverToInstall(server);
        out.push({
            id: `remote:${cleanText(row.id, 80) || slugifyServerName(name)}`,
            source: 'remote',
            serverName: deriveServerName([cleanText(server.name, 80), name]),
            name,
            tagline: cleanText(row.tagline, MARKETPLACE_LIMITS.tagline) || undefined,
            description: cleanText(row.description, MARKETPLACE_LIMITS.description),
            author: cleanText(row.author, MARKETPLACE_LIMITS.author) || undefined,
            category: cleanText(row.category, MARKETPLACE_LIMITS.category) || undefined,
            tags: cleanTags(row.tags),
            repoUrl: safeHttpUrl(row.repoUrl),
            homepageUrl: safeHttpUrl(row.homepageUrl) ?? safeHttpUrl(row.docsUrl),
            requiresApiKey: row.requiresApiKey === true || installNeedsSecret(install) || undefined,
            verified: row.verified === true || undefined,
            recommended: row.featured === true || row.recommended === true || undefined,
            install,
            installConfidence: install ? 'registry' : 'none',
        });
        if (out.length >= MARKETPLACE_LIMITS.entries) break;
    }
    return out;
}

function cleanTags(value: unknown): string[] {
    return asStringArray(value)
        .map((tag) => cleanText(tag, MARKETPLACE_LIMITS.tag).toLowerCase())
        .filter(Boolean)
        .slice(0, MARKETPLACE_LIMITS.tags);
}

// ---------------------------------------------------------------------------
// Shape detection / dispatch
// ---------------------------------------------------------------------------

export type MarketplaceShape = 'cline' | 'official' | 'xratu' | 'unknown';

/** Sniff a catalog payload before parsing it. */
export function detectPayloadShape(payload: unknown): MarketplaceShape {
    const record = asRecord(payload);
    if (record && Array.isArray(record.entries)) {
        const first = asRecord((record.entries as unknown[])[0]);
        if (first && (typeof first.type === 'string' || asRecord(first.install))) return 'cline';
        return 'unknown';
    }
    if (record && Array.isArray(record.servers)) {
        const first = asRecord((record.servers as unknown[])[0]);
        const inner = first ? asRecord(first.server) : null;
        // Both shapes nest a `server` object; the xratu one carries a raw
        // mcp.json block (command/url), the registry one carries packages.
        if (inner && ('command' in inner || 'url' in inner)) return 'xratu';
        if (inner) return 'official';
        return 'xratu';
    }
    if (Array.isArray(payload)) {
        const first = asRecord(payload[0]);
        if (first && asRecord(first.server)) return 'xratu';
        return 'unknown';
    }
    return 'unknown';
}

/** Parse any supported catalog payload. Unknown shapes yield `[]` (never a
 *  throw) so one broken source cannot take the whole marketplace down. */
export function parseMarketplacePayload(payload: unknown): MarketplaceEntry[] {
    try {
        switch (detectPayloadShape(payload)) {
            case 'cline':
                return parseClineCatalog(payload);
            case 'official':
                return parseOfficialRegistry(payload);
            case 'xratu':
                return parseXratuCatalog(payload);
            default:
                return [];
        }
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Curated (vendored) list
// ---------------------------------------------------------------------------

/** Turn the vendored curated registry into marketplace entries. Their display
 *  text stays in i18n via nameKey/descKey. */
export function curatedMarketplaceEntries(registry: McpRegistryEntry[] = MCP_REGISTRY): MarketplaceEntry[] {
    return registry.map((item) => {
        const install = serverToInstall(item.server as unknown as Record<string, unknown>);
        return {
            id: `curated:${item.id}`,
            source: 'curated' as const,
            serverName: deriveServerName([item.server.name, item.id]),
            name: item.server.name,
            nameKey: item.nameKey,
            descKey: item.descKey,
            description: '',
            tags: [],
            homepageUrl: safeHttpUrl(item.docsUrl),
            install,
            installConfidence: install ? ('curated' as const) : ('none' as const),
        };
    });
}

// ---------------------------------------------------------------------------
// Merge / search
// ---------------------------------------------------------------------------

/** Higher wins when two catalogs describe the same server. The curated list is
 *  vetted and localized, so it outranks a remote duplicate. */
function confidenceRank(entry: MarketplaceEntry): number {
    switch (entry.installConfidence) {
        case 'curated': return 4;
        case 'registry': return 3;
        case 'detected': return 2;
        default: return 1;
    }
}

/** Identity keys used to collapse duplicates across catalogs. */
export function entryIdentity(entry: MarketplaceEntry): string[] {
    const keys: string[] = [];
    if (entry.install) {
        keys.push(entry.install.kind === 'remote'
            ? `url:${entry.install.url.toLowerCase().replace(/\/+$/, '')}`
            : `cmd:${entry.install.command.toLowerCase()} ${entry.install.args.join(' ').toLowerCase()}`);
    }
    if (entry.repoUrl) keys.push(`repo:${entry.repoUrl.toLowerCase().replace(/\/+$/, '')}`);
    keys.push(`name:${entry.name.toLowerCase().replace(/\s+/g, ' ').trim()}`);
    return keys;
}

/** Merge catalogs in priority order (first group wins ties). */
export function mergeMarketplaceEntries(groups: MarketplaceEntry[][]): MarketplaceEntry[] {
    const seen = new Map<string, MarketplaceEntry>();
    const out: MarketplaceEntry[] = [];
    for (const group of groups) {
        for (const entry of group) {
            const keys = entryIdentity(entry);
            const existingKey = keys.find((key) => seen.has(key));
            if (existingKey) {
                const existing = seen.get(existingKey) as MarketplaceEntry;
                if (confidenceRank(entry) > confidenceRank(existing)) {
                    const index = out.indexOf(existing);
                    if (index >= 0) out[index] = entry;
                    for (const key of keys) seen.set(key, entry);
                }
                continue;
            }
            for (const key of keys) seen.set(key, entry);
            out.push(entry);
        }
    }
    return out.slice(0, MARKETPLACE_LIMITS.entries * 2);
}

/**
 * Tokenized AND search over the loaded catalog. Ranking is deliberately
 * simple and deterministic: name hits beat tags, tags beat author, author
 * beats description; installability and popularity only break ties.
 */
export function searchMarketplaceEntries(entries: MarketplaceEntry[], query: string): MarketplaceEntry[] {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return entries;

    const scored: Array<{ entry: MarketplaceEntry; score: number }> = [];
    for (const entry of entries) {
        const name = `${entry.name} ${entry.serverName}`.toLowerCase();
        const tags = entry.tags.join(' ').toLowerCase();
        const author = (entry.author ?? '').toLowerCase();
        const description = `${entry.tagline ?? ''} ${entry.description}`.toLowerCase();
        let score = 0;
        let matchedAll = true;
        for (const token of tokens) {
            if (name.startsWith(token)) score += 6;
            else if (name.includes(token)) score += 4;
            else if (tags.includes(token)) score += 3;
            else if (author.includes(token)) score += 2;
            else if (description.includes(token)) score += 1;
            else { matchedAll = false; break; }
        }
        if (!matchedAll) continue;
        if (entry.recommended) score += 1;
        if (entry.install) score += 1;
        scored.push({ entry, score });
    }

    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const popularity = popularityOf(b.entry) - popularityOf(a.entry);
        if (popularity !== 0) return popularity;
        return a.entry.name.localeCompare(b.entry.name);
    });
    return scored.map((s) => s.entry);
}

function popularityOf(entry: MarketplaceEntry): number {
    return (entry.stars ?? 0) + Math.round((entry.downloads ?? 0) / 100);
}

/** Categories present in a catalog, most common first. */
export function collectCategories(entries: MarketplaceEntry[]): string[] {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        if (!entry.category) continue;
        counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/** Tags present in a catalog, most common first (drives the filter chips). */
export function collectTags(entries: MarketplaceEntry[], max = 16): string[] {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .slice(0, max)
        .map(([tag]) => tag);
}

// ---------------------------------------------------------------------------
// README-based install detection (opt-in, always reviewed)
// ---------------------------------------------------------------------------

const NPM_CMD_RE = /\bnpx\s+(?:-y|--yes|--package\s+\S+)*\s*((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)/gi;
const UVX_CMD_RE = /\buvx\s+(?:--from\s+)?([a-z0-9][\w.-]*)/gi;
const DOCKER_CMD_RE = /\bdocker\s+run\s+([^\n`"'|;&]+)/gi;
const REMOTE_URL_RE = /\bhttps?:\/\/[^\s"'`)\]<>]+(?:\/mcp|\/sse)\b/gi;

/** Doc placeholders (`your-package`, `my-server`) - never a real command. */
const PLACEHOLDER_PREFIX_RE = /^(your|my|example|sample|dummy|fake|placeholder|foo|bar|baz|test)[-_.].*$/;

/** Bare words that appear in prose commands but name nothing runnable. */
const PLACEHOLDER_EXACT_RE = /^(pkg|package|name|server|mcp|path|url|uri|command|identifier|tool|project|repo|repository|install|npx|uvx|docker|node|python|npm|pip|run|start|build|dev|latest|version|test|foo|bar|baz)$/;

/** Placeholders and doc noise that must never become a command. */
export function isPlaceholderToken(value: string): boolean {
    const token = value.toLowerCase();
    if (token.length < 2 || token.length > 120) return true;
    if (/[<>{}[\]$*]/.test(value)) return true;
    return PLACEHOLDER_EXACT_RE.test(token) || PLACEHOLDER_PREFIX_RE.test(token);
}

interface CommandCandidate {
    install: MarketplaceInstall;
    count: number;
    index: number;
}

/**
 * Best-effort extraction of a runnable MCP server from a README. Used only
 * when the user explicitly asks for it, and the result is always surfaced as
 * `detected` so it is reviewed before anything is written to mcp.json.
 */
export function detectInstallFromReadme(readme: string): MarketplaceInstall | null {
    if (!readme || readme.length < 8) return null;
    const text = readme.slice(0, 200_000);
    const candidates = new Map<string, CommandCandidate>();
    const push = (key: string, install: MarketplaceInstall, index: number) => {
        const existing = candidates.get(key);
        if (existing) existing.count += 1;
        else candidates.set(key, { install, count: 1, index });
    };

    for (const match of text.matchAll(NPM_CMD_RE)) {
        const spec = match[1];
        if (isPlaceholderToken(spec)) continue;
        push(`npm:${spec.toLowerCase()}`, { kind: 'stdio', command: 'npx', args: ['-y', spec], runtime: 'node' }, match.index ?? 0);
    }
    for (const match of text.matchAll(UVX_CMD_RE)) {
        const spec = match[1];
        if (isPlaceholderToken(spec)) continue;
        push(`pypi:${spec.toLowerCase()}`, { kind: 'stdio', command: 'uvx', args: [spec], runtime: 'python' }, match.index ?? 0);
    }
    for (const match of text.matchAll(DOCKER_CMD_RE)) {
        const image = dockerImageFrom(match[1]);
        if (!image) continue;
        push(`docker:${image.toLowerCase()}`, { kind: 'stdio', command: 'docker', args: ['run', '-i', '--rm', image], runtime: 'docker' }, match.index ?? 0);
    }
    for (const match of text.matchAll(REMOTE_URL_RE)) {
        const url = safeHttpUrl(match[0]);
        if (!url) continue;
        push(`url:${url.toLowerCase()}`, { kind: 'remote', type: /\/sse$/i.test(url) ? 'sse' : 'streamableHttp', url }, match.index ?? 0);
    }

    const ranked = [...candidates.values()].sort((a, b) => (b.count - a.count) || (a.index - b.index));
    return ranked.length ? ranked[0].install : null;
}

/** Pull the image name out of `docker run` args, dropping flags (and any
 *  `-e SECRET=...` pair - a README must not hand us credentials). */
export function dockerImageFrom(argsText: string): string | null {
    const tokens = argsText.split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.startsWith('-')) {
            // Flags that consume a value: skip the value too.
            if (/^(-e|--env|-v|--volume|-p|--publish|--name|-w|--workdir|--network)$/.test(token)) i += 1;
            continue;
        }
        if (isPlaceholderToken(token)) continue;
        if (/^[a-z0-9][\w./-]*(:[a-z0-9][\w.-]*)?$/i.test(token)) return token;
    }
    return null;
}
