/**
 * Approval card — the gate that decides whether mutating tools run.
 *
 * Extracted from `MessageItem.tsx` (it lived inside a 2,989-line component
 * alongside the whole transcript) and REDESIGNED in the same change, from
 * static prototypes reviewed as screenshots at 420px in both locales.
 *
 * The shape is a code-review ledger, not a dialog:
 *
 *  - no card. No border box, no radius, no shadow, no nested chrome. Hairline
 *    rules group the block and the transcript around it stays flat, matching
 *    every other transcript surface (tool pills, job rows, diffs).
 *  - ONE verdict row carries the icon, the count-led title, the ledger and the
 *    two verdict buttons.
 *  - the file table is dense: one mono line per item, directory dimmed and
 *    basename bright IN THE SAME RUN, tabular +N -N right-aligned so the
 *    numbers form a column.
 *  - "Allow this session" is not a verdict for this batch, so it is demoted to
 *    a quiet link on the footer line.
 *
 * The behaviour contract is unchanged and is a security boundary (see
 * AGENTS.md): `onDecide(approval_id, decisions, sessionApprove?)` keeps its
 * signature and call sites, `preDenied` items stay visible and stay excluded
 * from the approve path, `approvable.length === 0` still disables both approve
 * buttons, `submitting` still blocks a double submit and clears when the
 * resolution lands, and the terminal/non-terminal copy split is preserved.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Clock, ShieldCheck, X } from 'lucide-react';
import type { ApprovalItem, ApprovalPayload } from '../types';
import { t, tf } from '../i18n';
import { toolIcon, toolLabel } from '../toolMeta';
import { useHighlightedCode } from '../highlight';
import { escapeHtml, extToLang, parseDiffLines, splitPath } from '../diffText';

function changeSummary(item: ApprovalItem): string {
    const args = item.args && typeof item.args === 'object' ? item.args as Record<string, unknown> : {};
    const tool = item.tool_name.toLowerCase();
    const path = typeof args.path === 'string' ? args.path : '';
    if (/delete_file|remove_file/.test(tool)) return t('approvalDeleteFile');
    if (/create_file|write_file/.test(tool)) return t('approvalCreateFile');
    if (/edit|replace|patch/.test(tool)) return t('approvalModifyFile');
    if (/terminal|command|shell/.test(tool)) return t('approvalRunCommand');
    if (path) return t('approvalModifyFile');
    return toolLabel(item.tool_name).fa;
}

/** Directory + basename in one LTR mono run. The directory is the shrinkable
 *  half, so a long path ellipsizes there and the name being approved survives. */
function ApprovalPath({ file }: { file: string }) {
    const { dir, base } = splitPath(file);
    return (
        <span className="approval-path" dir="ltr">
            {dir && <span className="dir">{dir}</span>}
            <span className="base">{base}</span>
        </span>
    );
}

function ApprovalDiffView({ diff }: { diff: NonNullable<ApprovalItem['diff']> }) {
    const parsed = useMemo(() => parseDiffLines(diff.lines), [diff.lines]);
    const newCode = useMemo(
        () => parsed.filter((l) => l.kind !== 'del').map((l) => l.text).join('\n'),
        [parsed]
    );
    const highlighted = useHighlightedCode(newCode, extToLang(diff.file));
    let hiIdx = 0;
    return (
        <div className="approval-diff-wrap" dir="ltr">
            <table className="approval-diff" role="img" aria-label={`${diff.file}: +${diff.added} -${diff.removed}`}>
                <tbody>
                    {parsed.map((line, i) => {
                        const hi = line.kind !== 'del' ? highlighted[hiIdx++] : '';
                        return (
                            <tr key={i} className={`diff-row diff-${line.kind}`}>
                                <td className="diff-no">{line.oldNo ?? ''}</td>
                                <td className="diff-no">{line.newNo ?? ''}</td>
                                <td className="diff-mark">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</td>
                                {/* When shiki highlighting is absent (unmapped
                                    extension, pre-async first render, or on
                                    any failure) the raw file text must be
                                    ESCAPED - it is model-controlled and
                                    dangerouslySetInnerHTML would otherwise
                                    inject it verbatim. */}
                                <td
                                    className="diff-code"
                                    dangerouslySetInnerHTML={{ __html: hi || escapeHtml(line.text) || '&nbsp;' }}
                                />
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

function ApprovalActionPreview({ item }: { item: ApprovalItem }) {
    const args = item.args && typeof item.args === 'object' ? item.args as Record<string, unknown> : {};
    const command = typeof args.command === 'string'
        ? args.command
        : typeof args.cmd === 'string'
            ? args.cmd
            : null;
    const path = typeof args.path === 'string' ? args.path : null;

    return (
        <div className="approval-action-preview" dir="ltr">
            <div className="approval-action-label">{changeSummary(item)}</div>
            {path && <code className="approval-action-path">{path}</code>}
            {command && <pre>{command}</pre>}
            {!path && !command && (
                <pre>{JSON.stringify(args, null, 2).slice(0, 900)}</pre>
            )}
        </div>
    );
}

export function ApprovalCard({
    payload,
    onDecide,
}: {
    payload: ApprovalPayload;
    onDecide?: (id: string, d: Record<string, boolean>, sessionApprove?: boolean) => void;
}) {
    const preDenied = payload.preDenied ?? {};
    const approvable = payload.approvals.filter((a) => preDenied[a.tool_call_id] !== false);
    const resolution = payload.resolution;
    const [submitting, setSubmitting] = useState(false);
    /* A REF, not the state, gates the second decision. `submitting` only flips
     * on the next render, so two activations in one tick (a fast double-click,
     * Enter twice on a focused button) both read the stale `false` and post two
     * decisions. The state still drives the disabled state and the spinner;
     * this is the synchronous guard the gate actually needs. */
    const decidedRef = useRef(false);

    useEffect(() => {
        if (resolution) {
            decidedRef.current = false;
            setSubmitting(false);
        }
    }, [resolution]);

    const decide = (approve: boolean, sessionApprove = false) => {
        if (decidedRef.current || resolution) return;
        decidedRef.current = true;
        setSubmitting(true);
        const decisions: Record<string, boolean> = { ...preDenied };
        for (const a of payload.approvals) {
            decisions[a.tool_call_id] = approve && preDenied[a.tool_call_id] !== false;
        }
        onDecide?.(payload.approval_id, decisions, sessionApprove || undefined);
    };

    const totalAdded = payload.approvals.reduce((n, a) => n + (a.diff?.added ?? 0), 0);
    const totalRemoved = payload.approvals.reduce((n, a) => n + (a.diff?.removed ?? 0), 0);
    const fileCount = payload.approvals.filter((a) => a.diff).length;
    const isTerminal = payload.approvals.every((a) => /terminal|command|shell/.test(a.tool_name));

    const isResolved = !!resolution;
    /* The title states the VERDICT, or describes what is waiting. The pending
       copy counts the APPROVABLE items only - counting the whole batch would
       promise edits the reader cannot grant - and names the batch, because
       "edits" is a lie for a terminal command or a JSON-args MCP tool. */
    const pendingCount = approvable.length;
    const isTerminalBatch = pendingCount > 0
        && approvable.every((a) => /terminal|command|shell/.test(a.tool_name));
    const isEditBatch = pendingCount > 0 && approvable.every((a) => !!a.diff);
    const pendingTitle = pendingCount === 0
        ? t('approvalNone')
        : tf(
            pendingCount === 1
                ? isTerminalBatch ? 'approvalCommandOne' : isEditBatch ? 'approvalEditOne' : 'approvalActionOne'
                : isTerminalBatch ? 'approvalCommandMany' : isEditBatch ? 'approvalEditMany' : 'approvalActionMany',
            { count: String(pendingCount) },
        );
    const title = resolution === 'approved'
        ? isTerminal ? t('approvalCommandApproved') : t('approvalApproved')
        : resolution === 'rejected'
            ? isTerminal ? t('approvalCommandRejected') : t('approvalRejected')
            : resolution === 'mixed'
                ? t('approvalMixed')
                : pendingTitle;

    /* No plan-mode note on the footer: the per-row "Auto-denied" tag already
       says which items were blocked, so a sentence restating it says nothing
       the reader cannot see - and it read as an apology on a card that was
       simply part denied. */
    const ledgerVisible = !isResolved && (fileCount > 0 || totalAdded || totalRemoved);

    return (
        <section className={`approval-card${isResolved ? ' resolved' : ' pending'}`} aria-label={title}>
            <div className="approval-head">
                <span className={`approval-state-icon ${resolution ?? ''}`}>
                    {resolution === 'approved' ? <Check size={13} />
                        : resolution === 'rejected' ? <X size={13} />
                            : <ShieldCheck size={13} />}
                </span>
                <span className="approval-title">{title}</span>
                {ledgerVisible && (
                    /* The numeric pair sits in its own dir="ltr" isolate: in an
                       RTL paragraph "+128 -44" otherwise reorders to
                       "+128+ 44-", detaching every sign from its number. */
                    <span className="approval-ledger" dir="auto">
                        <span className="files">{fileCount} {t('approvalFiles')}</span>
                        <span className="n" dir="ltr">
                            <span className="add">+{totalAdded}</span>{' '}
                            <span className="del">−{totalRemoved}</span>
                        </span>
                    </span>
                )}
                {!isResolved && (
                    <div className="approval-verdict">
                        <button type="button" className="approval-deny" onClick={() => decide(false)} disabled={submitting}>
                            <X size={13} />
                            <span>{t('denyAll')}</span>
                        </button>
                        <button
                            type="button"
                            className="approval-apply"
                            onClick={() => decide(true)}
                            disabled={submitting || approvable.length === 0}
                        >
                            {submitting ? <span className="step-status spinner" /> : <Check size={13} />}
                            <span>{submitting ? t('approvalApplying') : t('approve')}</span>
                        </button>
                    </div>
                )}
            </div>

            <div className="approval-items">
                {payload.approvals.map((a) => {
                    const deniedUpFront = preDenied[a.tool_call_id] === false;
                    const Icon = toolIcon(a.tool_name);
                    const argsPath = typeof a.args?.path === 'string' ? a.args.path : '';
                    const path = a.diff?.file ?? argsPath;
                    return (
                        <details key={a.tool_call_id} className="approval-item">
                            <summary>
                                <span className="approval-caret" aria-hidden="true"><ChevronDown size={13} /></span>
                                <span className="approval-file-icon"><Icon size={13} /></span>
                                {path
                                    ? <ApprovalPath file={path} />
                                    : <span className="approval-label">{changeSummary(a)}</span>}
                                {deniedUpFront && <span className="approval-denied-tag">{t('preDeniedTag')}</span>}
                                {a.diff && (
                                    <span className="approval-file-stats" dir="ltr">
                                        <span className="add">+{a.diff.added}</span>{' '}
                                        <span className="del">−{a.diff.removed}</span>
                                    </span>
                                )}
                            </summary>
                            <div className="approval-item-body">
                                {a.diff ? <ApprovalDiffView diff={a.diff} /> : <ApprovalActionPreview item={a} />}
                            </div>
                        </details>
                    );
                })}
            </div>

            {!isResolved && (
                <div className="approval-foot">
                    <button
                        type="button"
                        className="approval-session"
                        onClick={() => decide(true, true)}
                        disabled={submitting || approvable.length === 0}
                        title={t('approveSessionHint')}
                    >
                        <Clock size={12} />
                        <span>{t('approveSession')}</span>
                    </button>
                </div>
            )}
        </section>
    );
}