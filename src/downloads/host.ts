import { DownloadManager } from './manager';
import type { DownloadDependencies } from './manager';
import { validatePublicUrl } from '../webTools';
import { getProxyDispatcher } from '../proxyDispatcher';
import { proxyFetch } from '../proxyFetch';
import { isOfflineMode } from '../networkPolicy';

export function createDownloadManager(workspace: string, storage: string, deps: Pick<DownloadDependencies, 'secrets' | 'changed' | 'diagnostic' | 'prepareDestination'>): DownloadManager {
    return new DownloadManager(workspace, storage, {
        ...deps, validateUrl: validatePublicUrl, dispatcher: getProxyDispatcher,
        fetch: proxyFetch, offline: isOfflineMode,
    });
}
