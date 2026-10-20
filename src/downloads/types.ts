import type { ProxyRouteMode } from '../proxy';

export type DownloadStatus = 'queued' | 'downloading' | 'retrying' | 'verifying' | 'paused' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
export type DownloadError = 'downloadNetworkError' | 'downloadHttpError' | 'downloadUnsafeUrl' | 'downloadFileError' | 'downloadChanged' | 'downloadChecksumError' | 'downloadTooLarge' | 'downloadOffline' | 'downloadProxyMissing';

/** Safe to send to the webview and the model. Source URLs live in SecretStorage. */
export interface DownloadView {
    id: string;
    path: string;
    source: string;
    route: ProxyRouteMode;
    effectiveRoute?: 'proxy' | 'direct';
    status: DownloadStatus;
    received: number;
    total: number | null;
    bytesPerSecond: number;
    attempts: number;
    retryAt?: number;
    error?: DownloadError;
    httpStatus?: number;
    createdAt: number;
    updatedAt: number;
}

export interface DownloadRecord extends DownloadView {
    maxBytes: number;
    sha256?: string;
    etag?: string;
    lastModified?: string;
}

export interface DownloadSecrets {
    get(key: string): PromiseLike<string | undefined>;
    store(key: string, value: string): PromiseLike<void>;
    delete(key: string): PromiseLike<void>;
}
