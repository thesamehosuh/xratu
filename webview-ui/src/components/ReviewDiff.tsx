import { useMemo } from 'react';
import type { ReviewFile } from '../types';
import { t } from '../i18n';

const INLINE_LINES = 400;

/** Keep large new files cheap to mount; the editor still receives both full sides. */
export function reviewLines(file: ReviewFile): { rows: Array<{ kind: 'context' | 'add' | 'del' | 'hunk'; number?: number; text: string }>; truncated: boolean } {
    const rows: Array<{ kind: 'context' | 'add' | 'del' | 'hunk'; number?: number; text: string }> = [];
    const before = file.before.split('\n');
    let through = 0;
    const append = (kind: 'context' | 'add' | 'del' | 'hunk', text: string, number?: number) => {
        if (rows.length >= INLINE_LINES) return false;
        rows.push({ kind, text, number }); return true;
    };
    const hunks = file.hunks ?? [];
    for (let h = 0; h < hunks.length; h++) {
        const hunk = hunks[h];
        if (!append('hunk', `@@ −${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`)) return { rows, truncated: true };
        const start = Math.max(through, hunk.oldStart - 4, 0);
        for (let line = start; line < hunk.oldStart - 1; line++) {
            if (!append('context', before[line], line + 1)) return { rows, truncated: true };
        }
        for (let line = 0; line < hunk.removedLines.length; line++) {
            if (!append('del', hunk.removedLines[line], hunk.oldStart + line)) return { rows, truncated: true };
        }
        for (let line = 0; line < hunk.addedLines.length; line++) {
            if (!append('add', hunk.addedLines[line], hunk.newStart + line)) return { rows, truncated: true };
        }
        through = Math.max(0, hunk.oldStart - 1) + hunk.oldCount;
        const end = Math.min(through + 3, before.length, hunks[h + 1] ? hunks[h + 1].oldStart - 1 : before.length);
        for (let line = through; line < end; line++) {
            if (!append('context', before[line], line + 1)) return { rows, truncated: true };
        }
        through = end;
    }
    return { rows, truncated: false };
}

export function ReviewDiff({ file }: { file: ReviewFile }) {
    const { rows, truncated } = useMemo(() => reviewLines(file), [file]);
    return <><div className="review-diff" dir="ltr"><div className="review-hunk">{rows.map((row, index) => row.kind === 'hunk' ? <div className="diff-hunk" key={index}>{row.text}</div> : <div className={`diff-line ${row.kind}`} key={index}>
        <span className="diff-line-no">{row.number}</span><span className="diff-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span><code>{row.text || ' '}</code>
    </div>)}</div></div>{truncated && <p className="review-truncated">{t('surfaceDiffTruncated')}</p>}</>;
}
