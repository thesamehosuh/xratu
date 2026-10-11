import { Check, Circle, RefreshCw, TriangleAlert } from 'lucide-react';
import { t, tOrRaw } from '../i18n';
import type { SetupModel } from '../../../src/engines/setup';

export function SetupModelPicker({ models, selected, freeOnly, onSelect }: { models: SetupModel[]; selected: string; freeOnly: boolean; onSelect: (id: string) => void }) {
    return <div className="setup-models" role="radiogroup" aria-label={t('setupChooseModel')}>
        {models.map((model) => {
            const available = model.availability === 'available' && model.checkedAt !== undefined && Date.now() - model.checkedAt < 60_000;
            const checking = model.availability === 'checking';
            const disabled = freeOnly && !available;
            const label = checking ? 'modelPingChecking' : available ? 'modelPingAvailable' : model.availability === 'rateLimited' ? 'modelPingLimited' : model.availability === 'failed' ? 'modelPingFailed' : freeOnly ? 'setupCheckAgain' : 'setupConnected';
            const Status = checking ? RefreshCw : available ? Check : disabled ? TriangleAlert : null;
            return <button key={model.id} type="button" role="radio" aria-checked={model.id === selected} disabled={disabled}
                className={`setup-model${model.id === selected ? ' selected' : ''}`} onClick={() => onSelect(model.id)}
                title={model.detail ? tOrRaw(model.detail) : t(label)}>
                <span className="setup-model-radio" aria-hidden="true">{model.id === selected ? <Check size={12} /> : <Circle size={12} />}</span>
                <span className="setup-model-copy" dir="ltr"><span className="setup-model-name" dir="ltr">{model.name}<span className="model-provider">{model.provider}</span></span>
                    <span className="setup-model-status">{Status && <Status size={11} className={checking ? 'spinning' : undefined} />}{t(label)}</span></span>
                {model.free && <span className="setup-free">{t('setupFreeBadge')}</span>}
            </button>;
        })}
    </div>;
}
