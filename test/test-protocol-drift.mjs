#!/usr/bin/env node
/**
 * Protocol drift tests: the host and the webview must agree about which
 * messages exist.
 *
 * The two sides live in SEPARATE TypeScript projects - the host tsconfig
 * includes only `src/**` (rootDir `src`, because the node suites resolve
 * `../out/*.js`) and the webview has its own tsconfig - so nothing type-checks
 * the boundary. `webview-ui/src/types.ts` declares the unions; the host posts
 * object literals and switches on `data.type`. Neither side can see the
 * other, which makes a typo on either side a SILENT failure:
 *
 *   webview sends a type the host has no `case` for   -> dropped, no error
 *   host posts a type the webview's union lacks       -> ignored, no error
 *
 * This asserts both directions. It does NOT assert the converse (a declared
 * message nobody sends, or a branch nobody takes) - the union deliberately
 * carries webview-internal messages the host never sends, so those are
 * reported as notes, not failures.
 *
 * Deliberately regex-based rather than AST-based: a miss under-reports (no
 * false green is possible in the direction that matters) and it keeps the
 * suite free of a TypeScript API dependency.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-protocol-drift.mjs
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` (${detail})`}`);
};

/** Every `type: 'x'` declared as a member of a top-level union in types.ts. */
function unionMembers(typesSource, name) {
    const header = `export type ${name} =`;
    const start = typesSource.indexOf(header);
    if (start < 0) throw new Error(`union ${name} not found - types.ts changed shape?`);
    const rest = typesSource.slice(start + header.length);
    // Terminate at the NEXT top-level export rather than at the first `};`.
    // Members are allowed to be multi-line objects whose own closing brace is
    // indented exactly like the alias terminator, so a brace scan would cut
    // the union short and silently drop every member after it.
    const next = rest.search(/\nexport /);
    const body = next < 0 ? rest : rest.slice(0, next);
    const members = new Set();
    for (const m of body.matchAll(/type:\s*'([^']+)'/g)) members.add(m[1]);
    if (members.size === 0) throw new Error(`union ${name} yielded no members`);
    return members;
}

/**
 * Every `case 'x':` in the host's onDidReceiveMessage switch.
 *
 * Scoped by INDENTATION, not by brace counting: string literals inside case
 * bodies routinely contain unbalanced braces, so a naive counter walks out of
 * the switch and swallows later, unrelated `case` statements. The switch's
 * own indentation is the base; its cases sit 4 deeper and its closing brace
 * returns to the base (the router moved to src/webviewRouter.ts, so nothing
 * is hard-coded to one nesting level).
 */
function hostHandledTypes(source) {
    const switchLine = source.indexOf('switch (data.type)');
    if (switchLine < 0) throw new Error('host message switch not found - webviewRouter.ts changed shape?');
    const lineStart = source.lastIndexOf('\n', switchLine) + 1;
    const lines = source.slice(lineStart).split('\n');
    const base = /^( *)/.exec(lines[0])[1].length;
    const closeRe = new RegExp(`^ {${base}}\\}$`);
    const caseRe = new RegExp(`^ {${base + 4}}case '([^']+)':`);
    const handled = new Set();
    for (let i = 1; i < lines.length; i++) {
        if (closeRe.test(lines[i])) break;
        const m = caseRe.exec(lines[i]);
        if (m) handled.add(m[1]);
    }
    if (handled.size === 0) throw new Error('host switch yielded no cases');
    return handled;
}

/** Types the host literally posts to the webview. */
function hostPostedTypes(root) {
    const posted = new Set();
    const files = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const abs = join(dir, entry.name);
            if (entry.isDirectory()) walk(abs);
            else if (entry.name.endsWith('.ts')) files.push(abs);
        }
    };
    walk(root);
    for (const file of files) {
        const source = readFileSync(file, 'utf-8');
        // A window, not a parse: payloads assigned to a variable first are
        // missed (under-report only), and `type:` inside postMessage({ is
        // unambiguously a message envelope.
        for (const m of source.matchAll(/postMessage\(\s*\{[\s\S]{0,600}?\btype:\s*'([^']+)'/g)) {
            posted.add(m[1]);
        }
    }
    return posted;
}

const repo = join(import.meta.dirname, '..');
const typesSource = readFileSync(join(repo, 'webview-ui', 'src', 'types.ts'), 'utf-8');
const hostSource = readFileSync(join(repo, 'src', 'webviewRouter.ts'), 'utf-8');

const fromUnion = unionMembers(typesSource, 'FromExtensionMessage');
const toUnion = unionMembers(typesSource, 'ToExtensionMessage');
const handled = hostHandledTypes(hostSource);
const posted = hostPostedTypes(join(repo, 'src'));

console.log(`from(webview receives)=${fromUnion.size} to(webview sends)=${toUnion.size} hostCases=${handled.size} hostPosted=${posted.size}\n`);

// --- the two failures that are real bugs ---------------------------------
const unhandled = [...toUnion].filter((t) => !handled.has(t)).sort();
ok('every message the webview sends has a host handler',
    unhandled.length === 0,
    `host has no case for: ${unhandled.join(', ')}`);

const undeclared = [...posted].filter((t) => !fromUnion.has(t)).sort();
ok('every message the host posts is declared for the webview',
    undeclared.length === 0,
    `webview union lacks: ${undeclared.join(', ')}`);

// --- informational only ---------------------------------------------------
const hostOnly = [...handled].filter((t) => !toUnion.has(t)).sort();
if (hostOnly.length) {
    console.log(`note: host has cases the webview never declares (dead branches): ${hostOnly.join(', ')}`);
}
const neverPosted = [...fromUnion].filter((t) => !posted.has(t)).sort();
if (neverPosted.length) {
    console.log(`note: declared but never posted (may be webview-internal or built via a variable): ${neverPosted.join(', ')}`);
}

// --- the union must not silently collapse --------------------------------
ok('FromExtensionMessage declares a substantial message set', fromUnion.size >= 20, String(fromUnion.size));
ok('ToExtensionMessage declares a substantial message set', toUnion.size >= 20, String(toUnion.size));
ok('the host handles a substantial message set', handled.size >= 40, String(handled.size));

console.log(failed === 0 ? '\nAll protocol drift tests passed.' : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
