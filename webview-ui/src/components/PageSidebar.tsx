import { ArrowLeft, ArrowRight, Bot, ChartNoAxesColumn, Globe, KeyRound, PlugZap, Settings, Sparkles, Store } from 'lucide-react';
import { getLocale, t } from '../i18n';

export type SettingsSection = 'providers' | 'mcp' | 'marketplace' | 'skills' | 'agents' | 'usage' | 'proxy' | 'settings';

const SECTIONS = [
    { id: 'providers', label: 'providersTitle', icon: KeyRound },
    { id: 'mcp', label: 'mcpServersTab', icon: PlugZap },
    { id: 'marketplace', label: 'mcpMarketTab', icon: Store },
    { id: 'skills', label: 'skillsTitle', icon: Sparkles },
    { id: 'agents', label: 'surfaceAgents', icon: Bot },
    { id: 'usage', label: 'settingsUsage', icon: ChartNoAxesColumn },
    { id: 'proxy', label: 'proxyPageTitle', icon: Globe },
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
            <button type="button" className="sidebar-back" onClick={onBack}><Back size={15} />{t('surfaceBack')}</button>
            {SECTIONS.map(({ id, label, icon: Icon }) => (
                <button type="button" key={id} className={`sidebar-item${current === id ? ' active' : ''}`}
                    aria-current={current === id ? 'page' : undefined} onClick={() => onSelect(id)}>
                    <Icon size={15} /><span>{t(label)}</span>
                </button>
            ))}
        </nav>
    );
}
