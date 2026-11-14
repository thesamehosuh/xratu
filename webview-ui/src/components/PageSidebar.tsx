import { ArrowLeft, ArrowRight, Bot, Cpu, ChartNoAxesColumn, Globe, KeyRound, PlugZap, Palette, Settings, Sparkles, Store } from 'lucide-react';
import { getLocale, t } from '../i18n';

export type SettingsSection = 'providers' | 'engines' | 'mcp' | 'marketplace' | 'skills' | 'agents' | 'usage' | 'proxy' | 'appearance' | 'settings';

const SECTIONS = [
    { id: 'providers', label: 'providersTitle', icon: KeyRound },
    { id: 'engines', label: 'enginesTitle', icon: Cpu },
    { id: 'mcp', label: 'mcpServersTab', icon: PlugZap },
    { id: 'marketplace', label: 'mcpMarketTab', icon: Store },
    { id: 'skills', label: 'skillsTitle', icon: Sparkles },
    { id: 'agents', label: 'surfaceAgents', icon: Bot },
    { id: 'usage', label: 'settingsUsage', icon: ChartNoAxesColumn },
    { id: 'proxy', label: 'proxyPageTitle', icon: Globe },
    { id: 'appearance', label: 'appearanceTitle', icon: Palette },
    { id: 'settings', label: 'settingsTitle', icon: Settings },
] as const;

export function PageSidebar({ current, onSelect, onBack }: {
    current: SettingsSection;
    onSelect: (section: SettingsSection) => void;
    onBack: () => void;
}) {
    const Back = getLocale() === 'fa' ? ArrowRight : ArrowLeft;
    return (
        <nav className="page-sidebar" aria-label={t('settingsTitle')}>
            <button type="button" className="sidebar-back" title={t('surfaceBack')} onClick={onBack}><Back size={15} /><span>{t('surfaceBack')}</span></button>
            {[
                { label: 'surfaceModelsEngines', ids: ['providers', 'engines'] },
                { label: 'surfaceAgentResources', ids: ['mcp', 'marketplace', 'skills', 'agents'] },
                { label: 'surfacePreferences', ids: ['usage', 'proxy', 'appearance', 'settings'] },
            ].map(group => <section className="sidebar-group" key={group.label}><div className="workspace-nav-label">{t(group.label as Parameters<typeof t>[0])}</div>{SECTIONS.filter(section => group.ids.includes(section.id)).map(({ id, label, icon: Icon }) => (
                <button type="button" key={id} data-section={id} className={`sidebar-item${current === id ? ' active' : ''}`}
                    aria-current={current === id ? 'page' : undefined} title={t(label)} onClick={() => onSelect(id)}>
                    <Icon size={15} /><span>{t(label)}</span>
                </button>
            ))}</section>)}
        </nav>
    );
}
