import type { ComposerAttachment } from './types';
import { getWebviewState, patchWebviewState } from './vscode';

/** Only text goes into VS Code state. Attachment bytes remain in memory. */
const attachments = new Map<string, ComposerAttachment[]>();
const MAX_DRAFTS = 32;
const MAX_TEXT = 200_000;
export const composerDraftKey = (workspace: string, session: string | null) => JSON.stringify([workspace, session]);

function savedTexts(): Record<string, string> {
    const raw = getWebviewState().composerDrafts;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([key, value]) =>
        key.length <= 4096 && typeof value === 'string' && value.length <= MAX_TEXT).slice(-MAX_DRAFTS));
}

export function readComposerDraft(key: string): { text: string; attachments: ComposerAttachment[] } {
    return { text: savedTexts()[key] ?? '', attachments: attachments.get(key) ?? [] };
}

export function saveComposerDraft(key: string, text: string, files: ComposerAttachment[]): void {
    const texts = savedTexts();
    delete texts[key];
    if (text) texts[key] = text.slice(0, MAX_TEXT);
    // Keep the newest drafts under a total character budget as well as a count.
    let total = 0;
    const kept = Object.entries(texts).reverse().filter(([, value], index) => {
        total += value.length;
        return index < MAX_DRAFTS && total <= MAX_TEXT;
    }).reverse();
    patchWebviewState({ composerDrafts: Object.fromEntries(kept) });
    attachments.delete(key);
    if (files.length) attachments.set(key, files);
    while (attachments.size > MAX_DRAFTS) attachments.delete(attachments.keys().next().value!);
}

/** A disk ID is assigned after the first send; this is still the same chat. */
export function promoteComposerDraft(from: string, to: string): void {
    if (from === to) return;
    const draft = readComposerDraft(from);
    const queued = readComposerRecoveries(from);
    if (queued.length) { saveComposerRecoveries(from, []); saveComposerRecoveries(to, queued); }
    saveComposerDraft(from, '', []);
    saveComposerDraft(to, draft.text, draft.attachments);
}

export interface ComposerRecovery {
    id: string;
    value: string;
    attachments: ComposerAttachment[];
    missingNames: string[];
}
const recoveries = new Map<string, ComposerRecovery[]>();

/** Text and file names survive reload; attachment bytes never enter UI state. */
export function readComposerRecoveries(key: string): ComposerRecovery[] {
    const cached = recoveries.get(key);
    if (cached) return cached;
    const raw = getWebviewState().composerRecoveries;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const entries = (raw as Record<string, unknown>)[key];
    if (!Array.isArray(entries)) return [];
    return entries.slice(-MAX_DRAFTS).flatMap(entry => {
        if (!entry || typeof entry.id !== 'string' || entry.id.length > 128 || typeof entry.value !== 'string') return [];
        return [{ id: entry.id, value: entry.value.slice(0, MAX_TEXT), attachments: [], missingNames:
            Array.isArray(entry.names) ? entry.names.filter((name: unknown): name is string => typeof name === 'string').slice(0, 20).map((name: string) => name.slice(0, 1024)) : [] }];
    });
}

export function saveComposerRecoveries(key: string, entries: ComposerRecovery[]): void {
    recoveries.delete(key);
    recoveries.set(key, entries);
    while (recoveries.size > MAX_DRAFTS) recoveries.delete(recoveries.keys().next().value!);
    const raw = getWebviewState().composerRecoveries;
    const state: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    delete state[key];
    if (entries.length) state[key] = entries.slice(-MAX_DRAFTS).map(entry => ({
        id: entry.id, value: entry.value.slice(0, MAX_TEXT), names: [...entry.missingNames, ...entry.attachments.map(file => file.name)].slice(0, 20),
    }));
    // Budget text separately from metadata: a maximum-length newest draft
    // must not be evicted merely because its JSON envelope adds characters.
    let remaining = MAX_TEXT;
    const kept: Record<string, unknown> = {};
    for (const savedKey of Object.keys(state).slice(-MAX_DRAFTS).reverse()) {
        const queue = state[savedKey];
        if (!Array.isArray(queue)) continue;
        const values = queue.slice(-MAX_DRAFTS).reverse().flatMap(entry => {
            if (!entry || typeof entry.id !== 'string' || entry.id.length > 128 || typeof entry.value !== 'string') return [];
            const value = entry.value.slice(0, remaining);
            remaining -= value.length;
            const names = Array.isArray(entry.names) ? entry.names.filter((name: unknown): name is string => typeof name === 'string').slice(0, 20).map((name: string) => name.slice(0, 1024)) : [];
            return value || names.length ? [{ id: entry.id, value, names }] : [];
        }).reverse();
        if (values.length) kept[savedKey] = values;
    }
    patchWebviewState({ composerRecoveries: Object.fromEntries(Object.entries(kept).reverse()) });
}
