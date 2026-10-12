import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, History, Check, ExternalLink, FileDiff, FileText, MessageSquarePlus, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import type { FromExtensionMessage, ReviewChange, ReviewFile } from '../types';
import { t, tf, tOrRaw } from '../i18n';
import { postMessage } from '../vscode';
import { ReviewDiff } from './ReviewDiff';

export interface ReviewTurn { sha: string; toSha?: string; number: number }
const ignoreFiles = () => {};

export function ChangesPanel({ turns = [], ...props }: {
    turns?: ReviewTurn[];
    sha: string | null;
    initialPath?: string | null;
    busy: boolean;
    sessionKey: string;
    onFeedback: (text: string) => void;
    onCount: (count: number) => void;
    onFiles: (files: ReviewChange[]) => void;
}) {
    const { sha, onCount, onFiles } = props;
    const [counts, setCounts] = useState<Record<string, number>>({});
    const [displayedSha, setDisplayedSha] = useState(sha);
    const count = useCallback((sha: string, value: number) => setCounts(current => current[sha] === value ? current : { ...current, [sha]: value }), []);
    useEffect(() => {
        // A new checkpoint alone must not fold the diff the user is reading.
        if (sha && counts[sha] > 0) setDisplayedSha(sha);
        if (!sha) onFiles([]);
    }, [sha, counts, onFiles]);
    const reviews = turns.filter(turn => !turn.toSha || turn.toSha !== turn.sha);
    if (props.sha && !reviews.some(turn => turn.sha === props.sha)) reviews.push({ sha: props.sha, number: 0 });
    const currentSha = reviews.some(turn => turn.sha === displayedSha) ? displayedSha : props.sha;
    const current = reviews.find(turn => turn.sha === currentSha);
    const previous = reviews.filter(turn => turn.sha !== currentSha).reverse();
    useEffect(() => {
        onCount([...new Set([...turns.map(turn => turn.sha), ...(sha ? [sha] : [])])].reduce((sum, checkpoint) => sum + (counts[checkpoint] ?? 0), 0));
    }, [counts, turns, sha, onCount]);
    return <div className="changes-history review-scroll">
        {!props.sha && <ChangeReview {...props} onFiles={ignoreFiles} />}
        {[...(current ? [current] : []), ...previous].map((turn, index) => <ReviewTurnPanel key={`${props.sessionKey}-${turn.sha}`} turn={turn}
            current={turn.sha === currentSha} incoming={turn.sha === props.sha} historyHeading={index === 1 && previous.some(item => counts[item.sha] > 0)}
            initialPath={turn.sha === props.sha ? props.initialPath : undefined} busy={props.busy} sessionKey={props.sessionKey} onFeedback={props.onFeedback} onCount={count} onFiles={props.onFiles} />)}
    </div>;
}

function ReviewTurnPanel({ turn, current, incoming, historyHeading, initialPath, busy, sessionKey, onFeedback, onCount, onFiles }: {
    turn: ReviewTurn; current: boolean; incoming: boolean; historyHeading: boolean; initialPath?: string | null; busy: boolean;
    sessionKey: string; onFeedback: (text: string) => void; onCount: (sha: string, count: number) => void; onFiles: (files: ReviewChange[]) => void;
}) {
    const [count, setCount] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const [files, setFiles] = useState<ReviewChange[]>([]);
    useEffect(() => { if (current) setExpanded(false); }, [current]);
    const updateCount = useCallback((value: number) => { setCount(value); onCount(turn.sha, value); }, [turn.sha, onCount]);
    useEffect(() => { if (incoming) onFiles(files); }, [incoming, files, onFiles]);
    return <>
        {historyHeading && <h3 className="review-history-heading"><History size={14} />{t('surfacePreviousTurns')}</h3>}
        <details className={current ? 'review-current' : 'review-turn'} hidden={!current && !count} open={current || expanded} onToggle={event => { if (!current) setExpanded(event.currentTarget.open); }}>
            <summary hidden={current}>
                <ChevronDown className="review-turn-chevron" size={18} />
                <span className="review-turn-title"><span className="review-turn-heading">{tf('surfacePreviousTurn', { number: String(turn.number) })}<span className="review-turn-files">{tf('surfaceTurnFiles', { count: String(count) })}</span></span></span>
                <span className="review-turn-action">{t(expanded ? 'surfaceHideChanges' : 'surfaceShowChanges')}</span>
            </summary>
            <ChangeReview sha={turn.sha} toSha={turn.toSha} initialPath={initialPath} busy={!turn.toSha && busy} sessionKey={sessionKey} onFeedback={onFeedback} onCount={updateCount} onFiles={setFiles} expanded={current || expanded} />
        </details>
    </>;
}

function ChangeReview({ sha, toSha, initialPath, busy, sessionKey, onFeedback, onCount, onFiles, expanded = true }: {
    sha: string | null;
    toSha?: string;
    expanded?: boolean;
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
    const fileTimer = useRef<number>();
    const listRequest = useRef('');
    const fileRequest = useRef('');
    const loadedFile = useRef<ReviewFile | null>(null);
    const [files, setFiles] = useState<ReviewChange[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [file, setFile] = useState<ReviewFile | null>(null);
    const [loading, setLoading] = useState(false);
    const [fileLoading, setFileLoading] = useState(false);
    const [errorKey, setErrorKey] = useState<string | null>(null);
    const [fileError, setFileError] = useState<string | null>(null);
    const [reviewed, setReviewed] = useState<Map<string, string>>(() => new Map());
    const [comments, setComments] = useState<Map<string, string>>(() => new Map());
    const comment = selected ? comments.get(selected) ?? '' : '';
    const setComment = (value: string) => { if (selected) setComments((current) => new Map(current).set(selected, value)); };
    const [revision, setRevision] = useState(0);
    const [visibleFiles, setVisibleFiles] = useState(80);
    const refresh = () => setRevision((value) => value + 1);

    useEffect(() => {
        const handler = (event: MessageEvent<FromExtensionMessage>) => {
            const message = event.data;
            if (message.type === 'changesState' && message.requestId === listRequest.current && message.sha === sha) {
                window.clearTimeout(listTimer.current);
                setLoading(false);
                setErrorKey(message.errorKey ?? null);
                setFiles(message.files);
                setSelected((current) => message.files.some((item) => item.path === current) ? current : message.files.find((item) => item.path === initialPath)?.path ?? message.files[0]?.path ?? null);
                onCount(message.files.length);
                onFiles(message.files);
            } else if (message.type === 'changeFileState' && message.requestId === fileRequest.current && message.sha === sha) {
                window.clearTimeout(fileTimer.current);
                setFileLoading(false);
                loadedFile.current = message.file ?? null;
                setFile(message.file ?? null);
                setFileError(message.errorKey ?? null);
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [onCount, onFiles, initialPath, sha]);

    useEffect(() => {
        setReviewed(new Map()); setComments(new Map()); setFiles([]); setSelected(null); setFile(null);
        loadedFile.current = null;
        listRequest.current = ''; fileRequest.current = '';
        setVisibleFiles(80);
        onCount(0); onFiles([]);
    }, [sessionKey, sha, onCount, onFiles]);

    useEffect(() => { if (initialPath) setSelected(initialPath); }, [initialPath, sha]);

    useEffect(() => {
        listRequest.current = `${id}-list-${++sequence.current}`;
        if (!sha) { setLoading(false); setErrorKey(null); return; }
        setLoading(true); setErrorKey(null);
        postMessage({ type: 'changesGetState', sha, toSha, requestId: listRequest.current });
        listTimer.current = window.setTimeout(() => { setLoading(false); setErrorKey('surfaceChangesFailed'); }, 45_000);
        return () => window.clearTimeout(listTimer.current);
    }, [sha, toSha, busy, revision, sessionKey, id]);

    useEffect(() => {
        fileRequest.current = `${id}-file-${++sequence.current}`;
        const retained = loadedFile.current?.path === selected ? loadedFile.current : null;
        setFile(retained); setFileError(null);
        if (!expanded || !sha || !selected) { setFileLoading(false); return; }
        setFileLoading(!retained);
        postMessage({ type: 'changeFileGet', sha, toSha, path: selected, requestId: fileRequest.current });
        fileTimer.current = window.setTimeout(() => { setFileLoading(false); setFileError('surfaceChangesFailed'); }, 45_000);
        return () => window.clearTimeout(fileTimer.current);
    }, [sha, toSha, expanded, selected, files, sessionKey, id]);

    useEffect(() => {
        let timer: number | undefined;
        const changed = (event: MessageEvent<FromExtensionMessage>) => {
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
    const fingerprint = file?.kind === 'text' ? `${file.before}\0${file.after}` : '';
    const isReviewed = !!selected && !!fingerprint && reviewed.get(selected) === fingerprint;
    const openFile = () => { if (sha && selected) postMessage({ type: 'changeFileOpen', sha, toSha, path: selected }); };
    const sendFeedback = () => {
        if (!comment.trim() || !selected) return;
        onFeedback(`${selected}\n${comment.trim()}`); setComment('');
    };
    return <section className="changes-review" hidden={!expanded} aria-label={t('surfaceChanges')}>
        <header className="review-head"><FileDiff size={13} /><h2>{t('surfaceReview')}</h2><span className="review-count" dir="ltr">{files.length}</span>
            <button type="button" className="icon-btn" onClick={refresh} aria-label={t('surfaceRefresh')} disabled={!sha || loading}><RefreshCw size={12} /></button>
        </header>
        <div className="review-body">
            {errorKey && <div role="alert" className="review-empty"><TriangleAlert size={14} />{tOrRaw(errorKey)}<button type="button" onClick={refresh}>{t('surfaceRefresh')}</button></div>}
            {!errorKey && !files.length && <p className="review-empty">{loading ? t('working') : t(sha ? 'surfaceNoChanges' : 'surfaceChangesEmpty')}</p>}
            {!!files.length && <>
                <div className="review-summary"><span>{t('surfaceSinceCheckpoint')}</span><span className="review-stat" dir="ltr">+{totals.added} <span className="minus">−{totals.removed}</span></span></div>
                <div className="review-files">{files.slice(0, visibleFiles).map((change) => <button type="button" key={change.path} className={`review-file${selected === change.path ? ' selected' : ''}`} aria-pressed={selected === change.path} onClick={() => setSelected(change.path)}>
                    <FileText size={12} /><code dir="ltr">{change.path}</code><span className="review-stat" dir="ltr">{change.untracked ? t('surfaceNewFile') : change.binary ? t('surfaceBinary') : <>+{change.added} <span className="minus">−{change.removed}</span></>}</span>
                </button>)}{files.length > visibleFiles && <button type="button" className="review-more" onClick={() => setVisibleFiles((count) => count + 80)}>{tf('surfaceMoreFiles', { count: String(files.length - visibleFiles) })}</button>}</div>
                {fileLoading ? <span className="step-status spinner" aria-label={t('working')} /> : fileError ? <p role="alert">{tOrRaw(fileError)}</p> : file ? <>
                    <div className="review-diff-head"><code dir="ltr">{file.path}</code></div>
                    {file.kind === 'text' && file.hunks ? <ReviewDiff file={file} /> : <p className="review-empty">{t(file.kind === 'binary' ? 'surfaceBinary' : 'surfaceDiffUnavailable')}</p>}
                    <div className="review-footer"><button type="button" className="settings-ghost-action" onClick={openFile}><ExternalLink size={12} />{t('surfaceOpenEditor')}</button>
                        <button type="button" className={`settings-ghost-action${isReviewed ? ' reviewed' : ''}`} disabled={!fingerprint} onClick={() => { if (selected) setReviewed((current) => { const next = new Map(current); if (isReviewed) next.delete(selected); else next.set(selected, fingerprint); return next; }); }}><Check size={12} />{t(isReviewed ? 'surfaceReviewed' : 'surfaceMarkReviewed')}</button></div>
                </> : null}
                <textarea className="review-input" dir="auto" value={comment} onChange={(event) => setComment(event.target.value)} aria-label={t('surfaceReviewComment')} placeholder={t('surfaceReviewComment')} />
                <button type="button" className="settings-ghost-action" onClick={sendFeedback} disabled={!comment.trim()}><Send size={12} />{t('surfaceSendFeedback')}</button>
                <button type="button" className="review-ask" onClick={() => onFeedback(tf('surfaceAskReviewPrompt', { files: files.map((change) => change.path).join(', ') }))}><MessageSquarePlus size={12} />{t('surfaceAskReview')}</button>
            </>}
        </div>
    </section>;
}
