import { FileDiff, FileText, MessageSquarePlus, SquareTerminal } from 'lucide-react';
import type { ReviewChange, Step } from '../types';
import { t, tf } from '../i18n';

/** Only host terminal results with an explicit exit status become check rows. */
export function completedCommands(steps: Step[]): Array<{ id: string; command: string; exit: string }> {
    return steps.flatMap((step) => {
        if (step.kind !== 'toolCall' || step.tool !== 'run_terminal_command' || step.background) return [];
        const exit = step.result?.match(/(?:^|\n)Exit code: (-?\d+)(?:\r?\n|$)/)?.[1];
        if (exit === undefined) return [];
        try {
            const args = JSON.parse(step.text) as { command?: unknown };
            return typeof args.command === 'string' ? [{ id: step.id, command: args.command, exit }] : [];
        } catch { return []; }
    });
}

export function CompletedOutcome({ steps, sha, files, onReview, onAskReview }: {
    steps: Step[];
    sha: string;
    files?: ReviewChange[];
    onReview?: (sha: string, path?: string) => void;
    onAskReview?: (text: string) => void;
}) {
    const commands = completedCommands(steps);
    return <div className="turn-outcome">
        {!!commands.length && <div className="outcome-checks">{commands.map((item) => <div className={`outcome-check${item.exit !== '0' ? ' failed' : ''}`} key={item.id}>
            <SquareTerminal size={12} /><code dir="ltr" title={item.command}>{item.command}</code><span dir="ltr">{tf('surfaceExitCode', { code: item.exit })}</span>
        </div>)}</div>}
        <div className="outcome-actions">
            {onReview && <button type="button" className="outcome-review" onClick={() => onReview(sha)}><FileDiff size={13} />{t('surfaceReview')}{!!files?.length && <span dir="ltr">{files.length}</span>}</button>}
            {onAskReview && <button type="button" onClick={() => onAskReview(files?.length ? tf('surfaceAskReviewPrompt', { files: files.map((file) => file.path).join(', ') }) : t('surfaceAskTurnReviewPrompt'))}><MessageSquarePlus size={13} />{t('surfaceAskReview')}</button>}
        </div>
        {!!files?.length && <div className="outcome-files">{files.slice(0, 5).map((file) => <button type="button" key={file.path} onClick={() => onReview?.(sha, file.path)}><FileText size={11} /><code dir="ltr">{file.path}</code><span dir="ltr" className="review-stat">{file.untracked ? t('surfaceNewFile') : file.binary ? t('surfaceBinary') : <>+{file.added} <span className="minus">−{file.removed}</span></>}</span></button>)}{files.length > 5 && <button type="button" className="outcome-more" onClick={() => onReview?.(sha)}>{tf('surfaceMoreFiles', { count: String(files.length - 5) })}</button>}</div>}
    </div>;
}
