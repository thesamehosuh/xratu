import { FilePlus2 } from 'lucide-react';
import { SURFACE_PANELS, type NewTab, type SurfacePanel, type SurfaceTab } from '../dockLayout';
import { t } from '../i18n';
import { PANEL_ICONS, PANEL_LABELS } from './SurfaceTabs';

const hints = {
    conversation: 'surfaceConversationHint', changes: 'surfaceChangesHint', activity: 'surfaceActivityHint',
    agents: 'surfaceAgentsHint', background: 'surfaceBackgroundHint', downloads: 'surfaceDownloadsHint', browser: 'surfaceBrowserHint', pullRequests: 'surfacePullRequestsHint',
} as const;

/** An unassigned tab is a destination picker, not an empty work surface. */
export function NewTabPanel({ tab, panelClass, openPanels, onChoose }: {
    tab: NewTab; panelClass: string; openPanels: SurfaceTab[]; onChoose: (panel: SurfacePanel) => void;
}) {
    return <section className={`new-tab-pane ${panelClass}`} id={`surface-panel-${tab}`} role="tabpanel" aria-labelledby={`surface-tab-${tab}`}>
        <div className="new-tab-content">
            <div className="new-tab-heading"><span className="surface-empty-icon"><FilePlus2 size={22} /></span><h2>{t('surfaceChoosePanel')}</h2><p>{t('surfaceNewTabHint')}</p></div>
            <div className="new-tab-choices">
                {SURFACE_PANELS.map(panel => {
                    const Icon = PANEL_ICONS[panel];
                    return <button type="button" key={panel} data-open-panel={panel} className="new-tab-choice" onClick={() => onChoose(panel)}>
                        <Icon size={18} aria-hidden="true" /><span><strong>{t(PANEL_LABELS[panel])}</strong><span>{t(hints[panel])}</span></span>
                        {openPanels.includes(panel) && <span className="new-tab-open">{t('surfaceAlreadyOpen')}</span>}
                    </button>;
                })}
            </div>
        </div>
    </section>;
}
