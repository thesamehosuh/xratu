import { FileDiff, FileText, MessageSquarePlus } from 'lucide-react';
import type { ReviewChange } from '../types';
import { t, tf } from '../i18n';

export function CompletedOutcome({ sha, files, onReview, onAskReview }: {
    sha: string;
    files?: ReviewChange[];
    onReview?: (sha: string, path?: string) => void;
    onAskReview?: (text: string) => void;
}) {
    const hasDiff = !!files?.length;
    if (!hasDiff) return null;
    return <div className="turn-outcome">
        {hasDiff && <div className="outcome-actions">
            {onReview && <button type="button" className="outcome-review" onClick={() => onReview(sha)}><FileDiff size={13} />{t('surfaceReview')}{!!files?.length && <span dir="ltr">{files.length}</span>}</button>}
            {onAskReview && <button type="button" onClick={() => onAskReview(files?.length ? tf('surfaceAskReviewPrompt', { files: files.map((file) => file.path).join(', ') }) : t('surfaceAskTurnReviewPrompt'))}><MessageSquarePlus size={13} />{t('surfaceAskReview')}</button>}
        </div>}
        {!!files?.length && <div className="outcome-files">{files.slice(0, 5).map((file) => <button type="button" key={file.path} onClick={() => onReview?.(sha, file.path)}><FileText size={11} /><code dir="ltr">{file.path}</code><span dir="ltr" className="review-stat">{file.untracked ? t('surfaceNewFile') : file.binary ? t('surfaceBinary') : <>+{file.added} <span className="minus">−{file.removed}</span></>}</span></button>)}{files.length > 5 && <button type="button" className="outcome-more" onClick={() => onReview?.(sha)}>{tf('surfaceMoreFiles', { count: String(files.length - 5) })}</button>}</div>}
    </div>;
}
