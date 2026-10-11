// Adapted from T3 Code's OpenCode2Server lifecycle (MIT; see notices).
import { randomBytes } from 'crypto';
import type { ChildProcess } from 'child_process';
import crossSpawn from 'cross-spawn';
import { OpenCode, type OpenCodeClient } from '@opencode/client';
import { killTree } from '../../tooling/processTree';

export interface OpenCodeConnection { client: OpenCodeClient; baseUrl: string; headers: Record<string, string> }
export class OpenCodeServer {
    private child?: ChildProcess;
    private connection?: Promise<OpenCodeConnection>;
    constructor(readonly binary: string, private readonly env: NodeJS.ProcessEnv = process.env) {}
    connect(): Promise<OpenCodeConnection> {
        return this.connection ??= this.start().catch((error) => { this.connection = undefined; throw error; });
    }
    private start(): Promise<OpenCodeConnection> {
        return new Promise((resolve, reject) => {
            const password = randomBytes(32).toString('hex');
            const env = { ...this.env, OPENCODE_PASSWORD: password };
            delete (env as NodeJS.ProcessEnv).OPENCODE_SERVER_PASSWORD;
            const child = crossSpawn(this.binary, ['serve', '--hostname=127.0.0.1', '--port=0'], { env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
            this.child = child;
            let output = '';
            let settled = false;
            const timer = setTimeout(() => { fail(new Error('OpenCode server startup timed out')); }, 45_000);
            const fail = (error: Error) => {
                clearTimeout(timer);
                if (!settled) { settled = true; reject(error); void killTree(child.pid); }
            };
            const read = (data: Buffer) => {
                output = (output + data.toString()).slice(-8192);
                const url = output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
                if (!url || settled) return;
                settled = true;
                clearTimeout(timer);
                const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
                resolve({ baseUrl: url, headers, client: OpenCode.make({ baseUrl: url, headers }) });
            };
            child.stdout?.on('data', read);
            child.stderr?.on('data', read);
            child.on('error', fail);
            child.on('close', (code) => { this.connection = undefined; if (this.child === child) this.child = undefined; fail(new Error(`OpenCode server exited (${code}): ${output.trim()}`)); });
        });
    }
    async dispose(): Promise<void> {
        const child = this.child;
        this.child = undefined;
        this.connection = undefined;
        await killTree(child?.pid);
    }
}
