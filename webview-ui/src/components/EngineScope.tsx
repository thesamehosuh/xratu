import { Info, RefreshCw } from 'lucide-react';
import { ENGINE_SETUP, type SetupEngine } from '../../../src/engines/setup';
import { t, tOrRaw } from '../i18n';
import type { NativeSetupState, ToExtensionMessage } from '../types';
import { Dropdown } from './Dropdown';
import './engineScope.css';

export function EngineScope({ engine, onChange }: { engine: SetupEngine; onChange: (engine: SetupEngine) => void }) {
    return <div className="engine-scope"><label htmlFor="settings-engine">{t('setupSelectEngine')}</label><Dropdown id="settings-engine" label={t('setupSelectEngine')} value={engine} onChange={(value) => onChange(value as SetupEngine)} options={Object.entries(ENGINE_SETUP).map(([id, descriptor]) => ({ value: id, label: t(descriptor.label) }))} /><span className="engine-scope-help" role="img" tabIndex={0} title={t(engine === 'opencode' ? 'setupOwnershipNative' : 'setupOwnershipXratu')} aria-label={t(engine === 'opencode' ? 'setupOwnershipNative' : 'setupOwnershipXratu')}><Info size={12} /></span></div>;
}

export function NativeConfiguration({ state, section, send, refresh }: { state: NativeSetupState | null; section: 'servers' | 'skills' | 'marketplace' | 'agents'; send: (message: ToExtensionMessage) => void; refresh: () => void }) {
    const rows = section === 'servers' ? state?.servers.map((server) => ({ name: server.name, detail: tOrRaw(`nativeStatus_${server.status}`) })) : section === 'skills' ? state?.skills.map((skill) => ({ name: skill.name, detail: skill.description, path: skill.path })) : [];
    return <section className="settings-page native-config"><header className="settings-head"><h2>{t(section === 'servers' ? 'mcpTitle' : section === 'skills' ? 'skillsTitle' : section === 'agents' ? 'surfaceAgents' : 'mcpMarketTab')}</h2><button type="button" className="icon-btn" aria-label={t('surfaceRefresh')} onClick={refresh} disabled={state?.busy}><RefreshCw size={13} /></button></header><div className="settings-scroll">
        {state?.errorKey && <p className="setup-error" role="alert">{tOrRaw(state.errorKey)}</p>}
        <p className="scope-hint">{t(section === 'agents' ? 'setupNativeAgents' : 'setupNativeConfiguration')}</p>
        {state?.phase === 'checking' && <span role="status">{t('setupChecking')}</span>}
        {rows?.map((row) => <div key={row.name} className="native-config-row"><strong dir="ltr">{row.name}</strong>{row.detail && <span dir="auto">{row.detail}</span>}{'path' in row && <code dir="ltr">{row.path}</code>}</div>)}
        {state?.phase === 'ready' && !rows?.length && (section === 'servers' || section === 'skills') && <span className="scope-hint">{t('nativeNoneConfigured')}</span>}
        <button type="button" className="secondary-btn" onClick={() => send({ type: 'setupOpen', path: 'free' })}>{t('setupResume')}</button>
    </div></section>;
}
