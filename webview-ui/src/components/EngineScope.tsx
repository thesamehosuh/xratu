import { BookOpen, Bot, FolderOpen, Info, LockKeyhole, RefreshCw, Server } from 'lucide-react';
import { ENGINE_SETUP, type SetupEngine } from '../../../src/engines/setup';
import { t, tOrRaw } from '../i18n';
import type { NativeSetupState, ToExtensionMessage } from '../types';
import { Dropdown } from './Dropdown';
import './engineScope.css';

export function EngineScope({ engine, onChange }: { engine: SetupEngine; onChange: (engine: SetupEngine) => void }) {
    return <div className="engine-scope"><label htmlFor="settings-engine">{t('setupSelectEngine')}</label><Dropdown id="settings-engine" label={t('setupSelectEngine')} value={engine} onChange={(value) => onChange(value as SetupEngine)} options={Object.entries(ENGINE_SETUP).map(([id, descriptor]) => ({ value: id, label: t(descriptor.label) }))} /><span className="engine-scope-help" role="img" tabIndex={0} title={t(engine === 'opencode' ? 'setupOwnershipNative' : 'setupOwnershipXratu')} aria-label={t(engine === 'opencode' ? 'setupOwnershipNative' : 'setupOwnershipXratu')}><Info size={12} /></span></div>;
}

export function NativeInventory({ state, section, refresh }: { state: NativeSetupState | null; section: 'servers' | 'skills' | 'agents'; refresh: () => void }) {
    const errorKey = state?.errorKey ?? (section === 'agents' ? state?.agentsErrorKey : undefined);
    const rows = section === 'servers' ? state?.servers.map(server => ({ id: server.name, name: server.name, status: tOrRaw(`nativeStatus_${server.status}`) }))
        : section === 'skills' ? state?.skills.map(skill => ({ id: skill.path, name: skill.name, detail: skill.description, path: skill.path }))
            : state?.agents?.map(agent => ({ id: agent.id, name: agent.name, detail: agent.description, mode: agent.mode }));
    const Icon = section === 'servers' ? Server : section === 'skills' ? BookOpen : Bot;
    return <details className="native-inventory" open={section === 'agents' ? true : undefined}>
        <summary>{t('nativeInventory')}</summary>
        <div className="native-inventory-head"><span className="native-readonly"><LockKeyhole size={12} aria-hidden="true" /><span>{t('surfaceReadOnlyInventory')}</span></span><button type="button" className="icon-btn" aria-label={t('nativeRefreshInventory')} title={t('nativeRefreshInventory')} onClick={refresh} disabled={state?.busy}><RefreshCw size={13} /></button></div>
        {errorKey && <p className="setup-error" role="alert">{tOrRaw(errorKey)}</p>}
        {(!state || state.phase === 'checking') && <span role="status">{t('setupChecking')}</span>}
        {rows?.map(row => <div key={row.id} className="native-config-row">
            <div className="native-inventory-row-head"><Icon size={14} aria-hidden="true" /><strong dir="ltr">{row.name}</strong>
                {'mode' in row && <span className="native-inventory-badge">{t(row.mode === 'primary' ? 'nativeAgentPrimary' : row.mode === 'subagent' ? 'nativeAgentChild' : 'nativeAgentAll')}</span>}
                {'status' in row && <span className="native-inventory-badge">{row.status}</span>}
            </div>
            {('detail' in row && row.detail || 'path' in row) && <details className="native-inventory-detail"><summary><Info size={12} aria-hidden="true" /><span>{t('miniDetails')}</span></summary>
                {'detail' in row && row.detail && <p dir="auto">{row.detail}</p>}
                {'path' in row && <code dir="ltr">{row.path}</code>}
            </details>}
        </div>)}
        {state?.phase === 'ready' && !rows?.length && !errorKey && <p className="scope-hint">{t('nativeNoneConfigured')}</p>}
    </details>;
}

export function NativeConfiguration({ state, send, refresh, onManageXratu }: { state: NativeSetupState | null; send: (message: ToExtensionMessage) => void; refresh: () => void; onManageXratu: () => void }) {
    return <section className="settings-page native-config"><header className="settings-head"><h2>{t('surfaceAgents')}</h2></header><div className="settings-scroll">
        <button type="button" className="secondary-btn" onClick={onManageXratu}><FolderOpen size={14} aria-hidden="true" /><span>{t('nativeManageXratuAgents')}</span></button>
        <NativeInventory state={state} section="agents" refresh={refresh} />
        {state?.phase === 'attention' && <button type="button" className="secondary-btn" onClick={() => send({ type: 'setupOpen', path: 'free' })}>{t('setupResume')}</button>}
    </div></section>;
}
