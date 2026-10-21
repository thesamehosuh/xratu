import * as vscode from 'vscode';
import type { WebToolConfig } from './types';

/** Research is automatic. The only user control is proxy routing. Legacy
 * provider/key settings are deliberately no longer read or advertised. */
export function getWebToolConfig(): WebToolConfig {
    const cfg = vscode.workspace.getConfiguration('xratu');
    return { useProxy: cfg.get<boolean>('webSearchUseProxy', true), trusted: vscode.workspace.isTrusted !== false };
}
