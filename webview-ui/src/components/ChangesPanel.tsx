import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, CodeXml, History, ExternalLink, MessageSquarePlus, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react';
import type { FromExtensionMessage, ReviewChange, ReviewFile } from '../types';
import { t, tf, tOrRaw } from '../i18n';
import { postMessage } from '../vscode';
import { ReviewDiff } from './ReviewDiff';

export interface ReviewTurn { sha: string; toSha?: string; number: number; userIndex?: number }
const ignoreFiles = () => {};

export function ChangesPanel({ turns = [], selectedNumber = null, onTurnFiles, ...props }: {
    turns?: ReviewTurn[];
    onTurnFiles?: (turn: ReviewTurn, files: ReviewChange[]) => void;
    selectedNumber?: number | null;
    sha: string | null;
    initialPath?: string | null;
    busy: boolean;
    sessionKey: string;
    onFeedback: (text: string) => void;
    onCount: (count: number) => void;
    onFiles: (files: ReviewChange[]) => void;
}) {
    const { sha, onCount, onFiles } = props;
    const [counts, setCounts] = useState<Record<number, number>>({});
    const [displayedNumber, setDisplayedNumber] = useState<number | null>(null);
    const count = useCallback((number: number, value: number) => setCounts(current => current[number] === value ? current : { ...current, [number]: value }), []);
    const reviews = useMemo(() => {
        const entries = turns.filter(turn => !turn.toSha || turn.toSha !== turn.sha);
        if (sha && !entries.some(turn => turn.sha === sha)) entries.push({ sha, number: 0 });
        return entries;
    }, [turns, sha]);
    const incoming = selectedNumber !== null
        ? reviews.find(turn => turn.number === selectedNumber)
        : [...reviews].reverse().find(turn => turn.sha === sha);
    const incomingNumber = incoming?.number ?? null;
    useEffect(() => {
        // A new checkpoint alone must not fold the diff the user is reading.
        if (incomingNumber !== null && counts[incomingNumber] > 0) setDisplayedNumber(incomingNumber);
        if (!sha) onFiles([]);
    }, [incomingNumber, counts, sha, onFiles]);
    const current = reviews.find(turn => turn.number === displayedNumber) ?? incoming;
    const previous = reviews.filter(turn => turn.number !== current?.number).reverse();
    useEffect(() => {
        onCount(reviews.reduce((sum, turn) => sum + (counts[turn.number] ?? 0), 0));
    }, [counts, reviews, onCount]);
    return <div className="changes-history review-scroll">
        {!sha && <ChangeReview {...props} onFiles={ignoreFiles} />}
        {[...(current ? [current] : []), ...previous].map((turn, index) => <ReviewTurnPanel key={`${props.sessionKey}-${turn.number}`} turn={turn}
            current={turn.number === current?.number} incoming={turn.number === incomingNumber} historyHeading={index === 1 && previous.some(item => counts[item.number] > 0)}
            initialPath={turn.number === incomingNumber ? props.initialPath : undefined} busy={props.busy} sessionKey={props.sessionKey} onFeedback={props.onFeedback} onCount={count} onFiles={props.onFiles} onTurnFiles={onTurnFiles} />)}
    </div>;
}

function ReviewTurnPanel({ turn, current, incoming, historyHeading, initialPath, busy, sessionKey, onFeedback, onCount, onFiles, onTurnFiles }: {
    onTurnFiles?: (turn: ReviewTurn, files: ReviewChange[]) => void;
    turn: ReviewTurn; current: boolean; incoming: boolean; historyHeading: boolean; initialPath?: string | null; busy: boolean;
    sessionKey: string; onFeedback: (text: string) => void; onCount: (number: number, count: number) => void; onFiles: (files: ReviewChange[]) => void;
}) {
    const [count, setCount] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const [files, setFiles] = useState<ReviewChange[]>([]);
    useEffect(() => { if (current) setExpanded(false); }, [current]);
    const updateCount = useCallback((value: number) => { setCount(value); onCount(turn.number, value); }, [turn.number, onCount]);
    useEffect(() => { if (incoming) onFiles(files); }, [incoming, files, onFiles]);
    const recordFiles = useCallback((files: ReviewChange[]) => onTurnFiles?.(turn, files), [turn, onTurnFiles]);
    return <>
        {historyHeading && <h3 className="review-history-heading"><History size={14} /><span>{t('surfacePreviousTurns')}</span></h3>}
        <details className={current ? 'review-current' : 'review-turn'} hidden={!current && !count} open={current || expanded} onToggle={event => { if (!current) setExpanded(event.currentTarget.open); }}>
            <summary hidden={current}>
                <ChevronDown className="review-turn-chevron" size={18} />
                <span className="review-turn-title"><span className="review-turn-heading">{tf('surfacePreviousTurn', { number: String(turn.number) })}<span className="review-turn-files">{tf('surfaceTurnFiles', { count: String(count) })}</span></span></span>
                <span className="review-turn-action">{t(expanded ? 'surfaceHideChanges' : 'surfaceShowChanges')}</span>
            </summary>
            <ChangeReview sha={turn.sha} toSha={turn.toSha} initialPath={initialPath} busy={busy} sessionKey={sessionKey} onFeedback={onFeedback} onCount={updateCount} onFiles={setFiles} onSnapshot={recordFiles} expanded={current || expanded} userIndex={turn.userIndex} />
        </details>
    </>;
}

function ChangeReview({ sha, toSha, initialPath, busy, sessionKey, onFeedback, onCount, onFiles, onSnapshot, expanded = true, userIndex }: {
    sha: string | null;
    userIndex?: number;
    toSha?: string;
    expanded?: boolean;
    onSnapshot?: (files: ReviewChange[]) => void;
    initialPath?: string | null;
    busy: boolean;
    sessionKey: string;
    onFeedback: (text: string) => void;
    onCount: (count: number) => void;
    onFiles: (files: ReviewChange[]) => void;
}) {
    const id = useId();
    const sequence = useRef(0);
    const listTimer = useRef<number>();
    const listRequest = useRef('');
    const listLoaded = useRef(false);
    const previousFiles = useRef<ReviewChange[]>([]);
    const [files, setFiles] = useState<ReviewChange[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [opened, setOpened] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [errorKey, setErrorKey] = useState<string | null>(null);
    const [revision, setRevision] = useState(0);
    const [fileRevision, setFileRevision] = useState(0);
    const [visibleFiles, setVisibleFiles] = useState(80);
    const liveBusy = busy && !toSha;
    const refresh = () => { setRevision(value => value + 1); setFileRevision(value => value + 1); };

    useEffect(() => {
        const handler = (event: MessageEvent<FromExtensionMessage>) => {
            const message = event.data;
            if (message.type === 'changesState' && message.requestId === listRequest.current && message.sha === sha) {
                window.clearTimeout(listTimer.current);
                setLoading(false);
                listLoaded.current = true;
                setErrorKey(message.errorKey ?? null);
                setFiles(message.files);
                const previous = new Map(previousFiles.current.map(file => [file.path, file]));
                const changed = message.files.filter(file => {
                    const old = previous.get(file.path);
                    return !old || old.modifiedAt !== file.modifiedAt || old.added !== file.added || old.removed !== file.removed || old.binary !== file.binary || old.untracked !== file.untracked;
                });
                const newest = [...changed].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))[0]?.path;
                const next = !previous.size && initialPath && message.files.some(file => file.path === initialPath) ? initialPath
                    : !toSha && newest ? newest : message.files.some(file => file.path === selected) ? selected : message.files[0]?.path ?? null;
                setSelected(next);
                setOpened(open => {
                    const retained = open.filter(path => message.files.some(file => file.path === path));
                    if (next && (!previous.size || (!toSha && newest) || next !== selected) && !retained.includes(next)) retained.push(next);
                    return retained;
                });
                previousFiles.current = message.files;
                onCount(message.files.length);
                onFiles(message.files);
                onSnapshot?.(message.files);
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [onCount, onFiles, onSnapshot, initialPath, sha, toSha, selected]);

    useEffect(() => {
        setFiles([]); setSelected(null); setOpened([]);
        previousFiles.current = []; listLoaded.current = false;
        listRequest.current = '';
        setVisibleFiles(80);
        onCount(0); onFiles([]);
    }, [sessionKey, sha, onCount, onFiles]);

    useEffect(() => { if (initialPath) { setSelected(initialPath); setOpened(current => current.includes(initialPath) ? current : [...current, initialPath]); } }, [initialPath, sha]);

    useEffect(() => {
        listRequest.current = `${id}-list-${++sequence.current}`;
        if (!sha) { setLoading(false); setErrorKey(null); return; }
        setLoading(!listLoaded.current); setErrorKey(null);
        postMessage({ type: 'changesGetState', sha, toSha, requestId: listRequest.current });
        listTimer.current = window.setTimeout(() => { setLoading(false); setErrorKey('surfaceChangesFailed'); }, 45_000);
        return () => window.clearTimeout(listTimer.current);
    }, [sha, toSha, liveBusy, revision, sessionKey, id]);


    useEffect(() => {
        let timer: number | undefined;
        const changed = (event: MessageEvent<FromExtensionMessage>) => {
            if (event.data.type === 'checkpointRestored' && (event.data.sessionId ?? '') === sessionKey) { refresh(); return; }
            if (toSha) return;
            if (event.data.type !== 'toolResult' && event.data.type !== 'backgroundJobs') return;
            if (event.data.type === 'toolResult' && !['apply_patch', 'edit_file', 'replace_in_file', 'write_file', 'delete_file', 'move_file', 'copy_file', 'git_commit', 'git_branch', 'git_checkout', 'git_pull', 'git_push', 'git_merge', 'install_dependency', 'run_tests', 'run_terminal_command', 'process', 'task'].includes(event.data.tool) && !event.data.tool.startsWith('mcp__')) return;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => setRevision((value) => value + 1), 500);
        };
        window.addEventListener('message', changed);
        return () => { window.removeEventListener('message', changed); window.clearTimeout(timer); };
    }, [sessionKey, toSha]);

    const totals = useMemo(() => files.reduce((sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }), { added: 0, removed: 0 }), [files]);
    return <section className="changes-review" hidden={!expanded} aria-label={t('surfaceChanges')}>
        <div className="review-head"><span>{t('surfaceSinceCheckpoint')}</span>{!!files.length && <span className="review-stat" dir="ltr">+{totals.added} <span className="minus">−{totals.removed}</span></span>}
            {!!files.length && userIndex !== undefined && <button type="button" className="settings-ghost-action review-restore" disabled={busy} onClick={() => { if (sha) postMessage({ type: 'restoreCheckpoint', userIndex, sha }); }} title={t('restoreCheckpointHint')}><RotateCcw size={12} />{t('restoreCheckpoint')}</button>}
            <button type="button" className="icon-btn" onClick={refresh} aria-label={t('surfaceRefresh')} disabled={!sha || loading}><RefreshCw size={12} /></button>
        </div>
        <div className="review-body">
            {errorKey && <div role="alert" className="review-empty"><TriangleAlert size={14} /><span>{tOrRaw(errorKey)}</span><button type="button" onClick={refresh}>{t('surfaceRefresh')}</button></div>}
            {!errorKey && !files.length && (loading ? <p className="review-empty" role="status">{t('working')}</p> : <div className="surface-empty-state" role="status"><span className="surface-empty-icon" aria-hidden="true"><CodeXml size={22} /></span><strong>{t(sha ? 'surfaceNoChanges' : 'surfaceNoChangesTitle')}</strong></div>)}
            {!!files.length && <>
                <div className="review-files">{files.slice(0, visibleFiles).map((change) => <button type="button" key={change.path} className={`review-file${selected === change.path ? ' selected' : ''}`} aria-pressed={opened.includes(change.path)} aria-expanded={opened.includes(change.path)} onClick={() => { setSelected(change.path); setOpened(current => current.includes(change.path) ? current.filter(path => path !== change.path) : [...current, change.path]); }}>
                    <ChevronDown size={12} className={`review-file-chevron${opened.includes(change.path) ? ' open' : ''}`} /><code dir="ltr">{change.path}</code><span className="review-stat" dir="ltr">{change.untracked ? t('surfaceNewFile') : change.binary ? t('surfaceBinary') : <>+{change.added} <span className="minus">−{change.removed}</span></>}</span>
                </button>)}{files.length > visibleFiles && <button type="button" className="review-more" onClick={() => setVisibleFiles((count) => count + 80)}>{tf('surfaceMoreFiles', { count: String(files.length - visibleFiles) })}</button>}</div>
                {sha && files.filter(change => opened.includes(change.path)).map(change => <OpenFileDiff key={`${sessionKey}-${sha}-${change.path}`} sha={sha} toSha={toSha} path={change.path} expanded={expanded} revision={`${fileRevision}:${change.modifiedAt ?? ''}:${change.added}:${change.removed}:${change.binary}:${change.untracked}`} onFeedback={onFeedback} />)}
            </>}
        </div>
    </section>;
}

/** Each open diff owns its request identity; late replies cannot replace a sibling. */
function OpenFileDiff({ sha, toSha, path, expanded, revision, onFeedback }: { sha: string; toSha?: string; path: string; expanded: boolean; revision: string; onFeedback: (text: string) => void }) {
    const id = useId();
    const sequence = useRef(0);
    const [file, setFile] = useState<ReviewFile | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!expanded) return;
        const requestId = `${id}-file-${++sequence.current}`;
        let settled = false;
        setError(null);
        const timer = window.setTimeout(() => { settled = true; setLoading(false); setError('surfaceChangesFailed'); }, 45_000);
        const handler = (event: MessageEvent<FromExtensionMessage>) => {
            const message = event.data;
            if (settled || message.type !== 'changeFileState' || message.requestId !== requestId || message.sha !== sha || (message.file && message.file.path !== path)) return;
            settled = true; window.clearTimeout(timer);
            setFile(message.file ?? null); setLoading(false); setError(message.errorKey ?? null);
        };
        window.addEventListener('message', handler);
        postMessage({ type: 'changeFileGet', sha, toSha, path, requestId });
        return () => { window.clearTimeout(timer); window.removeEventListener('message', handler); };
    }, [sha, toSha, path, expanded, revision, id]);
    return <section className="review-open-file">
        <div className="review-diff-head"><code dir="ltr">{path}</code></div>
        {loading ? <span className="step-status spinner" aria-label={t('working')} /> : error ? <p role="alert">{tOrRaw(error)}</p> : file ? <>
            {file.kind === 'text' && file.hunks ? <ReviewDiff file={file} /> : <p className="review-empty">{t(file.kind === 'binary' ? 'surfaceBinary' : 'surfaceDiffUnavailable')}</p>}
            <div className="review-footer"><button type="button" className="settings-ghost-action" onClick={() => postMessage({ type: 'changeFileOpen', sha, toSha, path })}><ExternalLink size={12} /><span>{t('surfaceOpenEditor')}</span></button>
                <button type="button" className="settings-ghost-action review-ask" onClick={() => onFeedback(tf('surfaceAskReviewPrompt', { files: path }))}><MessageSquarePlus size={12} /><span>{t('surfaceAskReview')}</span></button></div>
        </> : null}
    </section>;
}
