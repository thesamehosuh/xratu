import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, FileTerminal, Folder, Hash, Square, SquareTerminal, X } from 'lucide-react';
import type { BackgroundJobView } from '../types';
import { formatFullTimestamp } from '../datetime';
import { t, tf } from '../i18n';
import { postMessage } from '../vscode';

export function backgroundStatus(job: BackgroundJobView) {
    return job.running ? 'running' : job.status === 'killed' ? 'stopped' : job.status === 'failed' || (job.exitCode != null && job.exitCode !== 0) ? 'failed' : 'done';
}
function Status({ job }: { job: BackgroundJobView }) {
    const status = backgroundStatus(job);
    return <span className={`background-status ${status}`} title={t(({ running:'bgTaskRunning', stopped:'bgStopped', failed:'bgTaskFailed', done:'bgTaskDone' } as const)[status])}>
        {status === 'running' ? <span className="background-pulse" /> : status === 'done' ? <Check size={12} /> : status === 'stopped' ? <Square size={10} /> : <X size={12} />}
    </span>;
}
function Uptime({ job }: { job: BackgroundJobView }) {
    const [now, setNow] = useState(Date.now);
    const basis = useRef({ seconds: job.uptimeSeconds, time: Date.now() });
    if (basis.current.seconds !== job.uptimeSeconds) basis.current = { seconds: job.uptimeSeconds, time: Date.now() };
    useEffect(() => {
        if (!job.running) return;
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, [job.running]);
    const seconds = Math.max(0, job.running && job.startedAt ? Math.floor((now - job.startedAt) / 1_000) : job.uptimeSeconds + (job.running ? Math.floor(Math.max(0, now - basis.current.time) / 1_000) : 0));
    return <span className="bg-job-up" dir="ltr" title={job.startedAt ? formatFullTimestamp(job.startedAt) : undefined}>{seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`}</span>;
}
function TaskLog({ job, visible }: { job: BackgroundJobView; visible: boolean }) {
    const pane = useRef<HTMLPreElement>(null);
    const pinned = useRef(true);
    const [following, setFollowing] = useState(true);
    const follow = useCallback(() => { if (visible && pinned.current && pane.current) pane.current.scrollTop = pane.current.scrollHeight; }, [visible]);
    useLayoutEffect(follow, [follow, job.output]);
    useEffect(() => {
        if (!pane.current) return;
        const observer = new ResizeObserver(follow);
        observer.observe(pane.current);
        return () => observer.disconnect();
    }, [follow]);
    const status = backgroundStatus(job);
    return <section className={`background-task-detail${visible ? '' : ' panel-hidden'}`} aria-hidden={!visible || undefined}>
        <header className="background-task-head">
            <div className="background-task-heading"><SquareTerminal size={15} /><strong className="background-command" dir="ltr">{job.command}</strong>
                <button type="button" className="bg-job-copy" title={t('bgCopyCmd')} aria-label={t('bgCopyCmd')} onClick={() => postMessage({type:'copyToClipboard',value:job.command})}><Copy size={13} /></button>
            </div>
            <div className="background-task-meta"><Status job={job} /><span>{t(({ running:'bgTaskRunning', stopped:'bgStopped', failed:'bgTaskFailed', done:'bgTaskDone' } as const)[status])}</span><Uptime job={job} />
                {job.exitCode != null && <span className={`background-exit${job.exitCode !== 0 ? ' failed' : ''}`} dir="ltr">{tf('surfaceExitCode',{code:String(job.exitCode)})}</span>}
            </div>
            <details className="background-task-info"><summary><ChevronDown size={11} />{t('bgTaskDetails')}</summary>
                <div><Hash size={12} /><code dir="ltr">{job.jobId}</code>{job.pid != null && <code dir="ltr">PID {job.pid}</code>}</div>
                {job.cwd && <div><Folder size={12} /><code dir="ltr">{job.cwd}</code></div>}
            </details>
        </header>
        <div className="background-log-bar"><FileTerminal size={12} /><span>{t('termStdout')}</span>
            <button type="button" className={`background-follow${following ? ' active' : ''}`} aria-pressed={following} title={t('bgFollowOutput')} aria-label={t('bgFollowOutput')} onClick={() => { pinned.current = !following; setFollowing(!following); if (pinned.current) follow(); }}><ChevronDown size={12} /></button>
            <button type="button" className="bg-job-copy" disabled={!job.output} title={t('bgCopyOutput')} aria-label={t('bgCopyOutput')} onClick={() => postMessage({type:'copyToClipboard',value:job.output ?? ''})}><Copy size={12} /></button>
        </div>
        {job.detached && job.output && <div className="background-output-note">{t('bgOutputDetached')}</div>}
        {job.output ? <pre ref={pane} className="background-output" dir="ltr" onScroll={() => { const el = pane.current; if (el && visible) { const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24; pinned.current = atBottom; setFollowing(atBottom); } }}>{job.output}</pre>
            : <div className="background-output-empty"><FileTerminal size={22} /><span>{t(job.detached ? 'bgOutputDetached' : job.running ? 'bgOutputWaiting' : 'bgNoOutput')}</span></div>}
    </section>;
}

/** Live processes and recent results; movable independently of the composer. */
export function BackgroundTasksPanel({ jobs, onStop, visible, panelClass }: { jobs: BackgroundJobView[]; onStop: (jobId: string) => void; visible: boolean; panelClass: string }) {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selected = jobs.find(job => job.jobId === selectedId) ?? jobs.find(job => job.running) ?? jobs[0];
    const running = jobs.filter(job => job.running);
    const [opened, setOpened] = useState<string[]>([]);
    const selectedKey = selected?.jobId;
    useEffect(() => {
        if (selectedKey && visible) setOpened(current => current.includes(selectedKey) ? current : [...current.slice(-7), selectedKey]);
    }, [selectedKey, visible]);
    const mounted = new Set([...opened, ...(visible && selectedKey ? [selectedKey] : [])]);
    return <div className={`background-pane bg-jobs ${panelClass}`} id="surface-panel-background" role="tabpanel" aria-labelledby="surface-tab-background" aria-hidden={!visible || undefined}>
        <div className="background-layout"><nav className="background-task-list" aria-label={t('surfaceBackground')}>
            <header><span className="bg-jobs-title">{t('bgTasksTitle')}</span>{running.length > 1 && <button type="button" className="bg-jobs-stopall" title={t('bgStopAllTitle')} onClick={() => running.forEach(job => onStop(job.jobId))}><Square size={10} />{t('bgStopAll')}</button>}</header>
            <div className="background-task-items">{jobs.map(job => <div className={`bg-job background-task${job.jobId === selected?.jobId ? ' selected' : ''}`} key={job.jobId}>
                <button type="button" className="background-task-select" aria-pressed={job.jobId === selected?.jobId} onClick={() => setSelectedId(job.jobId)}><Status job={job} /><code className="bg-job-cmd" dir="ltr" title={job.command}>{job.command}</code><Uptime job={job} /></button>
                {job.running && <button type="button" className="bg-job-stop" title={t('bgStopTitle')} aria-label={t('bgStop')} onClick={() => onStop(job.jobId)}><Square size={11} /></button>}
            </div>)}</div>
        </nav><div className="background-task-view">{jobs.filter(job => mounted.has(job.jobId)).map(job => <TaskLog key={job.jobId} job={job} visible={visible && job.jobId === selected?.jobId} />)}</div></div>
    </div>;
}
