import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, FileDiff, FileText, MessageSquarePlus, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import type { FromExtensionMessage, ReviewChange, ReviewFile } from '../types';
import { t, tf, tOrRaw } from '../i18n';
import { postMessage } from '../vscode';
import { ReviewDiff } from './ReviewDiff';

export function ChangesPanel({ sha, initialPath, busy, sessionKey, onFeedback, onCount, onFiles }: {
    sha: string | null;
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
            if (message.type === 'changesState' && message.requestId === listRequest.current) {
                window.clearTimeout(listTimer.current);
                setLoading(false);
                setErrorKey(message.errorKey ?? null);
                setFiles(message.files);
                setSelected((current) => message.files.some((item) => item.path === current) ? current : message.files.find((item) => item.path === initialPath)?.path ?? message.files[0]?.path ?? null);
                onCount(message.files.length);
                onFiles(message.files);
            } else if (message.type === 'changeFileState' && message.requestId === fileRequest.current) {
                window.clearTimeout(fileTimer.current);
                setFileLoading(false);
                loadedFile.current = message.file ?? null;
                setFile(message.file ?? null);
                setFileError(message.errorKey ?? null);
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [onCount, onFiles, initialPath]);

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
        postMessage({ type: 'changesGetState', sha, requestId: listRequest.current });
        listTimer.current = window.setTimeout(() => { setLoading(false); setErrorKey('surfaceChangesFailed'); }, 45_000);
        return () => window.clearTimeout(listTimer.current);
    }, [sha, busy, revision, sessionKey, id]);

    useEffect(() => {
        fileRequest.current = `${id}-file-${++sequence.current}`;
        const retained = loadedFile.current?.path === selected ? loadedFile.current : null;
        setFile(retained); setFileError(null);
        if (!sha || !selected) { setFileLoading(false); return; }
        setFileLoading(!retained);
        postMessage({ type: 'changeFileGet', sha, path: selected, requestId: fileRequest.current });
        fileTimer.current = window.setTimeout(() => { setFileLoading(false); setFileError('surfaceChangesFailed'); }, 45_000);
        return () => window.clearTimeout(fileTimer.current);
    }, [sha, selected, files, sessionKey, id]);

    useEffect(() => {
        let timer: number | undefined;
        const changed = (event: MessageEvent<FromExtensionMessage>) => {
            if (event.data.type !== 'toolResult' && event.data.type !== 'backgroundJobs') return;
            if (event.data.type === 'toolResult' && !['apply_patch', 'edit_file', 'replace_in_file', 'write_file', 'delete_file', 'move_file', 'copy_file', 'git_commit', 'git_branch', 'git_checkout', 'git_pull', 'git_push', 'git_merge', 'install_dependency', 'run_tests', 'run_terminal_command', 'process', 'task'].includes(event.data.tool) && !event.data.tool.startsWith('mcp__')) return;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => setRevision((value) => value + 1), 500);
        };
        window.addEventListener('message', changed);
        return () => { window.removeEventListener('message', changed); window.clearTimeout(timer); };
    }, [sessionKey]);

    const totals = useMemo(() => files.reduce((sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }), { added: 0, removed: 0 }), [files]);
    const fingerprint = file?.kind === 'text' ? `${file.before}\0${file.after}` : '';
    const isReviewed = !!selected && !!fingerprint && reviewed.get(selected) === fingerprint;
    const openFile = () => { if (sha && selected) postMessage({ type: 'changeFileOpen', sha, path: selected }); };
    const sendFeedback = () => {
        if (!comment.trim() || !selected) return;
        onFeedback(`${selected}\n${comment.trim()}`); setComment('');
    };
    return <section className="changes-review" aria-label={t('surfaceChanges')}>
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
