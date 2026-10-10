import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { searchMatches, webResults } from '../toolPresentation';
import { Check, ExternalLink, ChevronDown, Copy, FileText, Search, SquareTerminal, X } from 'lucide-react';
import type { Step } from '../types';
import { t, tf } from '../i18n';
import { postMessage } from '../vscode';
import { toolFamily } from '../transcriptPrefs';
import { escapeHtml, extToLang } from '../diffText';
import { useHighlightedCode } from '../highlight';

export function toolArgs(text: string): Record<string, unknown> {
    try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
export function parseCommandOutput(text: string) {
    const exit = text.match(/(?:^|\n)Exit code: (.+?)(?:\n|$)/)?.[1]?.trim();
    const cleaned = text.replace(/(?:^|\n)Exit code: .+?(?:\n|$)/, '\n');
    const start = cleaned.indexOf('STDOUT:\n');
    if (start < 0) return { stdout: /^OUTPUT:\r?\n/.test(cleaned.trimStart()) ? cleaned.trimStart().replace(/^OUTPUT:\r?\n/, '').replace(/\n+$/, '') : text, stderr: '', exit };
    if (cleaned.slice(0, start).trim()) return { stdout: text, stderr: '', exit };
    const body = cleaned.slice(start + 8);
    const split = body.indexOf('STDERR:\n');
    const strip = (s: string) => s.trim() === '(empty)' ? '' : s.replace(/\n+$/, '');
    return { stdout: strip(split < 0 ? body : body.slice(0, split)), stderr: split < 0 ? '' : strip(body.slice(split + 8)), exit };
}

function CopyOutput({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1_400); return () => clearTimeout(timer); }, [copied]);
    return <button type="button" className="icon-btn detail-copy" title={t(copied ? 'copiedMsg' : 'copyCode')} aria-label={t(copied ? 'copiedMsg' : 'copyCode')}
        onClick={() => { postMessage({ type: 'copyToClipboard', value: text }); setCopied(true); }}>{copied ? <Check size={12} /> : <Copy size={12} />}</button>;
}

function SourceOutput({ text, path, start = 1 }: { text: string; path: string; start?: number }) {
    const [expanded, setExpanded] = useState(false);
    const raw = useMemo(() => text.split('\n'), [text]);
    const shown = expanded ? raw.slice(0, 2_000) : raw.slice(0, 80);
    const highlighted = useHighlightedCode(shown.join('\n'), extToLang(path));
    return <><div className="detail-output-bar"><span>{t('agentOutput')}</span><CopyOutput text={text} /></div><div className="detail-source" dir="ltr">{shown.map((line, index) => <div className="detail-source-line" key={index}>
        <span className="detail-line-number" aria-hidden="true">{start + index}</span><code dangerouslySetInnerHTML={{ __html: highlighted[index] ?? (escapeHtml(line) || '&nbsp;') }} />
    </div>)}</div>{raw.length > shown.length && (expanded ? <p className="detail-limit">{t('toolOutputLimited')}</p> : <button type="button" className="detail-more" onClick={() => setExpanded(true)}>{tf('diffMoreLines', { count: String(raw.length - shown.length) })}</button>)}</>;
}

function TerminalOutput({ text, done }: { text: string; done: boolean }) {
    const output = useMemo(() => parseCommandOutput(text), [text]);
    const [channel, setChannel] = useState<'stdout' | 'stderr'>(() => !output.stdout && output.stderr ? 'stderr' : 'stdout');
    useEffect(() => { if (!output.stdout && output.stderr) setChannel('stderr'); }, [output.stdout, output.stderr]);
    const selected = channel === 'stderr' && output.stderr ? output.stderr : output.stdout;
    const ref = useRef<HTMLPreElement>(null);
    const pinned = useRef(true);
    useEffect(() => { if (!done && pinned.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text, done]);
    return <div className="detail-terminal">
        <div className="detail-output-bar">
            <div className="detail-channels" role="group" aria-label={t('agentOutput')}>
                <button type="button" className={channel === 'stdout' ? 'active' : ''} aria-pressed={channel === 'stdout'} onClick={() => setChannel('stdout')}>{t('termStdout')}</button>
                {output.stderr && <button type="button" className={channel === 'stderr' ? 'active error' : 'error'} aria-pressed={channel === 'stderr'} onClick={() => setChannel('stderr')}>{t('termStderr')}</button>}
            </div>
            {output.exit && <span className={`detail-exit${output.exit === '0' ? '' : ' error'}`} dir="ltr">{output.exit === '0' ? <Check size={11} /> : <X size={11} />}{t('termExitCode')} {output.exit}</span>}
            <CopyOutput text={selected} />
        </div>
        {selected ? <pre ref={ref} dir="ltr" className={channel === 'stderr' ? 'detail-output error' : 'detail-output'} onScroll={() => { const el = ref.current; if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>{selected}</pre>
            : <div className="detail-empty">{done ? t('toolNoOutput') : <><span className="spinner" aria-hidden="true" />{t('toolRunning')}</>}</div>}
    </div>;
}

function SearchOutput({ text }: { text: string }) {
    const groups = useMemo(() => searchMatches(text), [text]);
    const [expanded, setExpanded] = useState(false);
    if (!groups) return <RawOutput text={text} />;
    const shown = expanded ? groups : groups.slice(0, 12);
    return <div className="detail-search"><div className="detail-output-bar"><span>{groups.reduce((n, group) => n + group.lines.length, 0)} {t('toolMatches')}</span><CopyOutput text={text} /></div>
        {shown.map(group => <section className="detail-match-group" key={group.path}><div className="detail-match-file"><FileText size={11} /><code dir="ltr">{group.path}</code><span dir="ltr">{group.lines.length}</span></div>
            <div className="detail-match-lines" dir="ltr">{group.lines.slice(0, expanded ? 500 : 12).map((line, index) => <div key={index}><span className="detail-line-number">{line.number}</span><code>{line.text}</code></div>)}</div>
        </section>)}
        {!expanded && (groups.length > 12 || groups.some(group => group.lines.length > 12)) && <button type="button" className="detail-more" onClick={() => setExpanded(true)}>{t('toolShowAll')}</button>}
        {expanded && groups.some(group => group.lines.length > 500) && <p className="detail-limit">{t('toolOutputShortened')}</p>}
    </div>;
}
function RawOutput({ text, auto = false }: { text: string; auto?: boolean }) {
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Plain provider output is kept verbatim. */ }
    return <div className="detail-result"><div className="detail-output-bar"><span>{t('agentOutput')}</span><CopyOutput text={text} /></div><pre className="detail-output" dir={auto ? 'auto' : 'ltr'}>{pretty}</pre></div>;
}
function WebOutput({ text }: { text: string }) {
    const results = useMemo(() => webResults(text), [text]);
    if (!results) return <RawOutput text={text} auto />;
    return <div className="detail-web-results">{results.map((result, index) => <article key={index}>
        <a href={result.url} target="_blank" rel="noopener noreferrer" dir="auto">{result.title}<ExternalLink size={11} /></a>
        <code dir="ltr">{new URL(result.url).hostname}</code><p dir="auto">{result.snippet}</p>
    </article>)}</div>;
}

/** The useful artifact first; complete arguments stay available on demand. */
export function ToolDetails({ call, result, children }: { call: Step; result?: Step; children?: ReactNode }) {
    const args = useMemo(() => toolArgs(call.text), [call.text]);
    const family = toolFamily(call.tool);
    const done = !call.background && (call.backgroundOutcome !== undefined || call.result !== undefined || !!result || !!call.interrupted);
    const text = call.backgroundOutcome?.output ?? (call.background ? call.live ?? call.result ?? '' : result ? result.text || result.result || '' : call.result ?? call.live ?? '');
    const path = typeof args.path === 'string' ? args.path : '';
    const subject = [args.command, args.pattern, args.query, args.url, args.path, args.name].find(v => typeof v === 'string') as string | undefined;
    const Icon = family === 'terminal' ? SquareTerminal : family === 'search' ? Search : FileText;
    const readHeader = family === 'read' && call.tool === 'read_file' ? text.match(/^\[.+? - lines (\d+)-(\d+) of (\d+)\]\n/) : null;
    const source = readHeader ? text.slice(readHeader[0].length) : text;
    return <div className={`tool-detail ${family}`}>
        {!children && subject && <div className="detail-subject"><Icon size={12} aria-hidden="true" /><code dir="ltr">{subject}</code><CopyOutput text={subject} /></div>}
        {!children && family === 'read' && path && readHeader && <div className="detail-range" dir="ltr">{readHeader[1]}–{readHeader[2]} / {readHeader[3]}</div>}
        {children ?? (family === 'terminal' ? <TerminalOutput text={text} done={done} /> : family === 'read' && path && text && !/^Error:/.test(text) ? <SourceOutput text={source} path={path} start={Number(readHeader?.[1] ?? args.start_line) || 1} /> : text ? family === 'search' && call.tool === 'grep_search' ? <SearchOutput text={text} /> : family === 'web' && call.tool === 'web_search' ? <WebOutput text={text} /> : <RawOutput text={text} auto={family === 'web'} /> : <div className="detail-empty">{done ? t('toolNoOutput') : <><span className="spinner" aria-hidden="true" />{t('toolRunning')}</>}</div>)}
        {call.backgroundOutcome?.status === 'killed' && <div className="detail-interrupted">{t('bgStopped')}</div>}
        {call.interrupted && <div className="detail-interrupted">{t('toolInterrupted')}</div>}
        {call.text && call.text !== '{}' && <details className="detail-arguments"><summary><ChevronDown size={11} />{t('toolArguments')}</summary><div className="detail-output-bar"><span dir="ltr">{call.tool}</span><CopyOutput text={call.text} /></div><pre className="detail-output" dir="ltr">{Object.keys(args).length ? JSON.stringify(args, null, 2) : call.text}</pre></details>}
    </div>;
}
