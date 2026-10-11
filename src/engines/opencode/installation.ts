// Managed staging and version checks adapted from T3 Code's CodexInstallation.
// See THIRD_PARTY_NOTICES.txt. OpenCode assets come from its official npm releases.
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import crossSpawn from 'cross-spawn';
import * as tar from 'tar';
import { killTree } from '../../tooling/processTree';
import { proxyFetch } from '../../proxyFetch';
import { OPENCODE_RELEASES, OPENCODE_VERSION } from './releases';

export function checkOpenCode(binary: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const child = crossSpawn(binary, ['--version'], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const abort = () => { void killTree(child.pid); finish(new Error('OpenCode version check cancelled')); };
        const timer = setTimeout(() => { void killTree(child.pid); finish(new Error('OpenCode version check timed out')); }, 15_000);
        const finish = (error?: Error) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (error) reject(error);
            else {
                const version = output.match(/(?:opencode\s+v?)?(\d+\.\d+\.\d+)/i)?.[1];
                if (version) resolve(version);
                else reject(new Error('OpenCode did not return a version'));
            }
        };
        child.stdout?.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-4096); });
        child.stderr?.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-4096); });
        child.on('error', finish);
        child.on('close', (code) => finish(code === 0 ? undefined : new Error(output.trim() || `OpenCode exited with code ${code}`)));
        signal?.addEventListener('abort', abort, { once: true });
    });
}

export function releaseTarget(platform = process.platform, arch = process.arch, musl = false): string {
    const os = platform === 'win32' ? 'windows' : platform;
    const target = `${os}-${arch}${arch === 'x64' ? '-baseline' : ''}${os === 'linux' && musl ? '-musl' : ''}`;
    if (!OPENCODE_RELEASES[target]) throw new Error(`OpenCode has no supported release for ${platform}/${arch}`);
    return target;
}

export class OpenCodeInstallation {
    constructor(private readonly root: string) {}
    private binary(version: string): string { return path.join(this.root, version, process.platform === 'win32' ? 'opencode.exe' : 'opencode'); }
    async managedBinary(): Promise<string | undefined> {
        try {
            const version = (await fs.readFile(path.join(this.root, 'active'), 'utf8')).trim();
            if (!/^2\.\d+\.\d+$/.test(version)) return undefined;
            const binary = this.binary(version);
            await fs.access(binary);
            return binary;
        } catch { return undefined; }
    }
    async install(signal: AbortSignal, progress: (downloaded: number, total?: number) => void, dispatcher?: unknown): Promise<string> {
        const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
        const release = OPENCODE_RELEASES[releaseTarget(process.platform, process.arch, process.platform === 'linux' && !report?.header?.glibcVersionRuntime)];
        await fs.mkdir(this.root, { recursive: true });
        const staging = path.join(this.root, `.staging-${randomUUID()}`);
        await fs.mkdir(staging);
        const archive = path.join(staging, 'release.tgz');
        try {
            const response = await proxyFetch(release.tarball, { signal, dispatcher });
            if (!response.ok || !response.body) throw new Error(`OpenCode download failed: HTTP ${response.status}`);
            const total = Number(response.headers.get('content-length')) || undefined;
            const digest = createHash('sha512');
            const file = await fs.open(archive, 'wx');
            let downloaded = 0;
            try {
                for await (const data of response.body as unknown as AsyncIterable<Uint8Array>) {
                    signal.throwIfAborted();
                    downloaded += data.byteLength;
                    if (downloaded > 500 * 1024 * 1024) throw new Error('OpenCode release exceeds download limit');
                    digest.update(data);
                    await file.writeFile(data);
                    progress(downloaded, total);
                }
            } finally { await file.close(); }
            const expected = Buffer.from(release.integrity.slice('sha512-'.length), 'base64');
            const actual = digest.digest();
            if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('OpenCode release integrity check failed');
            const executable = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
            const extracted = path.join(staging, 'extracted');
            await fs.mkdir(extracted);
            await tar.x({ file: archive, cwd: extracted, strict: true, filter: (entryPath, entry) => {
                const parts = entryPath.replace(/\\/g, '/').split('/');
                return 'type' in entry && entry.type === 'File' && parts.length === 3 && parts[0] === 'package' && parts[1] === 'bin' && parts[2] === executable;
            } });
            signal.throwIfAborted();
            const candidate = path.join(extracted, 'package', 'bin', executable);
            await fs.chmod(candidate, 0o755);
            if (await checkOpenCode(candidate, signal) !== OPENCODE_VERSION) throw new Error('OpenCode release version does not match');
            const destination = path.join(this.root, OPENCODE_VERSION);
            await fs.mkdir(destination, { recursive: true });
            const binary = this.binary(OPENCODE_VERSION);
            // Never overwrite a running managed binary (Windows locks it).
            try { await fs.access(binary); } catch { await fs.rename(candidate, binary); }
            if (await checkOpenCode(binary, signal) !== OPENCODE_VERSION) throw new Error('Managed OpenCode version does not match');
            const pointer = path.join(this.root, `.active-${randomUUID()}`);
            await fs.writeFile(pointer, OPENCODE_VERSION, { flag: 'wx' });
            await fs.rename(pointer, path.join(this.root, 'active'));
            return binary;
        } finally { await fs.rm(staging, { recursive: true, force: true }); }
    }
}
