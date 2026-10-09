import { Brain, Circle, ChevronDown, ListChecks, X } from 'lucide-react';
import { ToolImages } from './ToolImages';
import type { Step } from '../types';
import { t, tf } from '../i18n';
import { toolIcon, toolLabel } from '../toolMeta';

function hint(step: Step): string {
    try {
        const args = JSON.parse(step.text) as Record<string, unknown>;
        for (const key of ['path', 'file_path', 'command', 'query', 'url', 'description', 'pattern']) {
            if (typeof args[key] === 'string') return (args[key] as string).replace(/\s+/g, ' ').slice(0, 180);
        }
    } catch { /* Legacy calls keep their tool label. */ }
    return '';
}

export function CompactSteps({ steps, failed, createdAt, completedAt }: {
    steps: Step[];
    failed: (step: Step) => boolean;
    createdAt: number;
    completedAt?: number;
}) {
    const calls = steps.filter((step) => (step.kind === 'toolCall' || step.kind === 'toolResult' || step.kind === 'thinking') && step.tool !== 'ask_user_question');
    if (!calls.length) return null;
    const count = calls.filter((step) => step.kind !== 'thinking').length;
    return <details className="completed-steps">
        <summary><ListChecks size={13} /><span>{count ? tf('surfaceActions', { count: String(count) }) : t('miniThinking')}</span><span className="completed-steps-time">{completedAt ? tf('surfaceFinishedIn', { seconds: String(Math.max(1, Math.round((completedAt - createdAt) / 1000))) }) : t('surfaceCompleted')}</span><ChevronDown size={12} /></summary>
        <div className="compact-step-list">{calls.map((step) => {
            const Icon = step.kind === 'thinking' ? Brain : toolIcon(step.tool);
            const label = step.kind === 'thinking' ? t('miniThinking') : toolLabel(step.tool).fa;
            const detail = hint(step);
            const normalized = step.kind === 'toolResult' ? { ...step, result: step.text } : step;
            const exit = normalized.tool === 'run_terminal_command' ? normalized.result?.match(/(?:^|\n)Exit code: (-?\d+)(?:\r?\n|$)/)?.[1] : undefined;
            const error = failed(normalized) || (exit !== undefined && exit !== '0');
            return <div className={`compact-step${error ? ' failed' : ''}`} key={step.id}>
                <Icon size={12} /><span className="compact-step-label">{label}</span>{detail && <code dir="auto" title={detail}>{detail}</code>}
                {error ? <X size={12} className="err" /> : <Circle size={5} className="step-complete" aria-label={t('surfaceCompleted')} />}
                {exit !== undefined && <span className="compact-step-exit" dir="ltr">{tf('surfaceExitCode', { code: exit })}</span>}
                {error && normalized.result && <pre dir="auto" className="compact-step-error">{normalized.result.slice(0, 8000)}</pre>}
                <ToolImages call={normalized} />
            </div>;
        })}</div>
    </details>;
}
