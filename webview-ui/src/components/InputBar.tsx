import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { processPdf, PDF_SCAN_MAX_PAGES } from '../pdfClient';
import {
    Brain,
    Check,
    ChevronUp,
    Cpu,
    File,
    Link,
    Paperclip,
    PencilLine,
    Plus,
    RefreshCw,
    Search,
    Send,
    Square,
    TriangleAlert,
    X,
} from 'lucide-react';
import type { ComposerAttachment, ThinkingLevel, TokenUsage } from '../types';
import { applyMentionPick, detectMention, filterFiles, type MentionState } from '../mention';
import { getLocale, t, tf } from '../i18n';

/** Fallback when the backend hasn't served a window for this model yet
 *  (mirrors deps.DEFAULT_CONTEXT_WINDOW). */
const DEFAULT_CONTEXT_LIMIT = 131_072;

/** Preset windows offered in the pill dropdown (binary-nice values). */
const CTX_PRESETS: Array<{ label: string; value: number }> = [
    { label: '8k', value: 8192 },
    { label: '16k', value: 16384 },
    { label: '32k', value: 32768 },
    { label: '64k', value: 65536 },
    { label: '128k', value: 131072 },
    { label: '256k', value: 262144 },
    { label: '512k', value: 524288 },
    { label: '1M', value: 1048576 },
];

const ATTACH_MAX_COUNT = 20;
const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
const ATTACH_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const ATTACH_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** Non text/* mimes accepted as inline text attachments (mirrors the backend's
 *  ATTACHMENT_TEXT_EXTRA_TYPES). */
const ATTACH_TEXT_EXTRA_TYPES = new Set([
    'application/json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/toml',
    'application/javascript',
    'application/x-sh',
]);
/** Extensions the browser often reports with an empty/unknown MIME type;
 *  these are treated as inline text (Cline/Continue-style code context). */
const ATTACH_TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml',
    'csv', 'tsv', 'ini', 'cfg', 'conf', 'env', 'log', 'properties',
    'py', 'pyw', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'css', 'scss', 'sass', 'less',
    'html', 'htm', 'vue', 'svelte', 'astro', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
    'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs', 'php', 'sh', 'bash', 'zsh',
    'fish', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'proto',
    'dockerfile', 'makefile', 'mk', 'cmake', 'gradle', 'lock', 'gitignore',
    'gitattributes', 'editorconfig', 'npmrc', 'diff', 'patch', 'lua', 'pl', 'pm',
    'r', 'dart', 'elm', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'scala', 'groovy',
    'tf', 'tfvars', 'hcl', 'sol', 'zig', 'nim', 'v', 'asm', 's', 'm', 'mm',
]);
const IMAGE_EXT_MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
};

/** 76800 -> '76.8k', 131072 -> '131.1k', 1234567 -> '1.23M'. */
function fmtCompact(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) {
        const k = n / 1000;
        const s = k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '');
        return `${s}k`;
    }
    const m = n / 1_000_000;
    const s = m >= 100 ? String(Math.round(m)) : m.toFixed(m >= 10 ? 1 : 2).replace(/\.?0+$/, '');
    return `${s}M`;
}

/** Nice window labels: providers quote decimal sizes (gpt-4o = 128000) while
 *  binary sizes are equally common (131072 = real 128k). Both render '128k'.
 *  Non-power-of-two megabyte values (1310720 = 1.25Mi ≈ 1.31M decimal) keep
 *  their decimals - Math.round(v / 1_048_576) rendered 1,310,720 as '1M',
 *  hiding a quarter of the real window. */
function fmtWindow(v: number): string {
    if (v % 1_048_576 === 0) return `${v / 1_048_576}M`;
    if (v % 1_000_000 === 0) return `${v / 1_000_000}M`;
    if (v > 1_000_000) {
        const m = v / 1_000_000;
        return `${m.toFixed(m >= 10 ? 1 : 2).replace(/\.?0+$/, '')}M`;
    }
    if (v % 1000 === 0) return `${v / 1000}k`;
    if (v % 1024 === 0) return `${v / 1024}k`;
    return `${Math.round(v / 1024)}k`;
}

const RING_CIRC = 2 * Math.PI * 8;

let _attachSeq = 0;
function nextAttachId(): string {
    _attachSeq += 1;
    return `a${_attachSeq}-${Date.now().toString(36)}`;
}

function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function isImageMime(mime: string): boolean {
    return ATTACH_IMAGE_TYPES.has(mime);
}

function isTextMime(mime: string): boolean {
    return mime.startsWith('text/') || ATTACH_TEXT_EXTRA_TYPES.has(mime);
}

/** Magic-byte sniffing of a base64 image payload - mirrors the backend so a
 *  text file named .png is rejected in the COMPOSER (Persian, auto-dismissed)
 *  instead of failing the send with an English backend error. */
function sniffImageMime(dataBase64: string): string | null {
    let head: string;
    try {
        head = atob(dataBase64.slice(0, 24));
    } catch {
        return null;
    }
    const bytes = new Uint8Array(head.length);
    for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i);
    const startsWith = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
    if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
    if (startsWith([0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'image/webp';
    }
    return null;
}

/** PDFs are processed client-side (pdfClient.ts): text PDFs become a
 *  text/plain attachment (same fenced-block pipeline as text files);
 *  scanned/image-only PDFs render their first pages to JPEG images so
 *  vision models can read them.  Returns one or more attachments. */
async function processPdfAttachment(a: ComposerAttachment): Promise<ComposerAttachment[]> {
    const result = await processPdf(a.dataBase64);
    if (result.kind === 'text') {
        const block = `[Attached PDF: ${a.name} - text layer extracted]\n\n${result.text}`;
        return [{
            ...a,
            mimeType: 'text/plain',
            size: new Blob([block]).size,
            dataBase64: btoa(String.fromCharCode(...new TextEncoder().encode(block))),
        }];
    }
    const suffix = result.pageCount > PDF_SCAN_MAX_PAGES ? ` (first ${PDF_SCAN_MAX_PAGES} of ${result.pageCount} pages)` : '';
    return result.pages.map((p) => ({
        id: `${a.id}-p${p.page}`,
        name: `${a.name} - page ${p.page}${p.page === result.pages.length ? suffix : ''}`,
        mimeType: 'image/jpeg',
        size: Math.ceil(p.dataBase64.length * 3 / 4),
        dataBase64: p.dataBase64,
    }));
}

/** Resolve a reliable MIME type: browsers frequently report an empty or
 *  generic type for code/config files, so fall back to the extension. */
function mimeForFile(file: File): string {
    const ext = file.name.includes('.')
        ? file.name.split('.').pop()!.toLowerCase()
        : file.name.toLowerCase();
    if (isImageMime(file.type)) return file.type;
    if (IMAGE_EXT_MIME[ext]) return IMAGE_EXT_MIME[ext];
    if (ext === 'pdf') return 'application/pdf';
    if (ATTACH_TEXT_EXTENSIONS.has(ext)) return 'text/plain';
    return file.type;
}

/** WEBP is the one image format local vision runtimes (LM Studio, Ollama's
 *  llama.cpp backend) commonly reject even when the transport encoding is
 *  right - PNG is universally supported, so re-encode webp attachments
 *  client-side in the composer.  Cloud providers accept both, and PNG works
 *  everywhere, so this normalization is safe for the whole pipeline. */
async function convertWebpToPng(dataBase64: string): Promise<{ dataBase64: string; size: number }> {
    const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
    try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas unavailable');
        ctx.drawImage(bitmap, 0, 0);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('png encode failed');
        const out = new Uint8Array(await blob.arrayBuffer());
        // btoa in 32k chunks to avoid the argument-length limit on large images.
        let binary = '';
        for (let i = 0; i < out.length; i += 0x8000) {
            binary += String.fromCharCode(...out.subarray(i, i + 0x8000));
        }
        return { dataBase64: btoa(binary), size: blob.size };
    } finally {
        bitmap.close();
    }
}

interface InputBarProps {
    busy: boolean;
    onSend: (text: string, attachments: ComposerAttachment[]) => void;
    onCancel: () => void;
    /** Suggestion-chip payload: typed into the composer char-by-char, then
     *  auto-sent. `id` re-triggers the effect for repeated picks. */
    injectedText?: { id: number; text: string } | null;
    onInjectedApplied?: () => void;
    models?: string[];
    selectedModel?: string | null;
    onSelectModel?: (model: string) => void;
    onRefreshModels?: () => void;
    /** True while the host is re-fetching the model list (spin the button). */
    refreshing?: boolean;
    /** The selected model has an explicit user context-window override. */
    ctxOverridden?: boolean;
    /** Persist (or clear with null) a context-window override for the
     *  selected model. */
    onSetContextWindow?: (window: number | null) => void;
    /** Reasoning effort currently selected for the model (null = Default). */
    thinkingLevel?: ThinkingLevel | null;
    /** Persist (or clear with null) a thinking level for the selected model. */
    onSetThinkingLevel?: (level: ThinkingLevel | null) => void;
    usage?: TokenUsage | null;
    /** Server-provided window for the selected model (null until known). */
    contextWindow?: number | null;
    /** Backend-resolved DEFAULT window for the model (without any user
     *  override) - used to disable options that would shrink the window
     *  below what the conversation already occupies. */
    defaultContextWindow?: number | null;
    planMode?: boolean;
    /** Heuristic vision support of the selected model (null = unknown). */
    modelVisionCapable?: boolean | null;
    /** Backend rejected the last send - restore its value + attachments. */
    restoreDraft?: { value: string; attachments: ComposerAttachment[] } | null;
    onRestoreApplied?: () => void;
    /** Files the host read for attachment (picker/commands via attachUris). */
    injectedAttachments?: ComposerAttachment[] | null;
    onInjectedAttachmentsApplied?: () => void;
    /** Host-side attachment rejection - shown inline, auto-dismissed.
     *  Keyed: every host post is a fresh error object. */
    hostError?: { id: number; value: string; valueKey?: string; params?: Record<string, string> } | null;
    onHostErrorApplied?: () => void;
    /** Message loaded into the composer for editing (pencil flow): the
     *  composer prefills its text; sending performs the rewind-resend
     *  instead of opening a new turn. Null = normal compose mode. */
    editDraft?: { userIndex: number; value: string } | null;
    /** Leave edit mode (Escape or the banner's cancel button). */
    onCancelEdit?: () => void;
    /** Workspace file list for the @-mention popup (host-provided; null
     *  until the first request is answered). */
    workspaceFiles?: string[] | null;
    /** Fire when the mention popup opens - the host answers with fileList. */
    onRequestFiles?: () => void;
}

export function InputBar({
    busy,
    onSend,
    onCancel,
    injectedText,
    onInjectedApplied,
    models = [],
    selectedModel,
    onSelectModel,
    onRefreshModels,
    refreshing,
    ctxOverridden,
    onSetContextWindow,
    thinkingLevel,
    onSetThinkingLevel,
    usage,
    contextWindow,
    defaultContextWindow,
    planMode,
    modelVisionCapable,
    restoreDraft,
    onRestoreApplied,
    injectedAttachments,
    onInjectedAttachmentsApplied,
    hostError,
    onHostErrorApplied,
    editDraft,
    onCancelEdit,
    workspaceFiles,
    onRequestFiles,
}: InputBarProps) {
    const [value, setValue] = useState('');
    const [pickerOpen, setPickerOpen] = useState(false);
    const [filter, setFilter] = useState('');
    const [ctxOpen, setCtxOpen] = useState(false);
    const [attachMenuOpen, setAttachMenuOpen] = useState(false);
    const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
    const [attachError, setAttachError] = useState<string | null>(null);
    // Attachment errors auto-dismiss - they describe a single rejected file,
    // so lingering forever is noise (the chips themselves persist).
    useEffect(() => {
        if (!attachError) return;
        const timer = setTimeout(() => setAttachError(null), 5000);
        return () => clearTimeout(timer);
    }, [attachError]);
    // @-mention popup state: a live `@token` under the caret opens the
    // workspace-file picker; the textarea itself is the search field.
    const [mention, setMention] = useState<MentionState | null>(null);
    const [mentionIdx, setMentionIdx] = useState(0);
    const ref = useRef<HTMLTextAreaElement | null>(null);
    const pickerRef = useRef<HTMLButtonElement | null>(null);
    const popRef = useRef<HTMLDivElement | null>(null);
    const ctxWrapRef = useRef<HTMLSpanElement | null>(null);
    const attachBtnRef = useRef<HTMLButtonElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const composerRef = useRef<HTMLDivElement | null>(null);

    // The context window comes from the model probe's authoritative table -
    // no client-side copy that can drift. The meter shows the conversation's
    // token consumption against that window, LIVE while a response streams:
    // the local agent emits estimated cumulative usage events per streamed
    // output token, so every streamed token counts as it arrives.
    const limit = contextWindow ?? DEFAULT_CONTEXT_LIMIT;
    const usedTokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
    const hasUsage = usage != null;
    const usagePercent = limit > 0 ? (usedTokens / limit) * 100 : 0;

    // Window options smaller than the context ALREADY occupied by the
    // conversation are disabled - shrinking below the filled level would
    // force-compaction of nearly everything on the next send. Occupied
    // context = the meter's value (last response input + output tokens).
    const occupied = hasUsage ? usedTokens : 0;
    const defaultTooSmall =
        defaultContextWindow != null && occupied > 0 && defaultContextWindow < occupied;

    // While a run streams the composer becomes a STEER box: the button is a
    // stop square only while the composer is EMPTY - the moment there is
    // text (or an attachment) to send it reverts to Send, so steering never
    // requires firing the cancel button by mistake.
    const canSend = !!value.trim() || attachments.length > 0;
    const stopping = busy && !canSend;

    const totalAttachBytes = useMemo(
        () => attachments.reduce((sum, a) => sum + a.size, 0),
        [attachments]
    );

    // Suggestion chips: the picked prompt is typed into the composer
    // char-by-char (visible "someone is writing this" beat) and auto-sent
    // after a short pause. Any user keypress takes over - typing keeps the
    // partial text for editing; Escape aborts. Callbacks are read through
    // refs so a re-render never restarts the animation mid-flight.
    const [typing, setTyping] = useState(false);
    const typeTimerRef = useRef<number | null>(null);
    const sendBeatRef = useRef<number | null>(null);
    const injectedAppliedRef = useRef(onInjectedApplied);
    const sendRef = useRef(onSend);
    injectedAppliedRef.current = onInjectedApplied;
    sendRef.current = onSend;

    const clearInjectionTimers = useCallback(() => {
        if (typeTimerRef.current != null) {
            window.clearInterval(typeTimerRef.current);
            typeTimerRef.current = null;
        }
        if (sendBeatRef.current != null) {
            window.clearTimeout(sendBeatRef.current);
            sendBeatRef.current = null;
        }
        setTyping(false);
    }, []);

    useEffect(() => {
        if (!injectedText) return;
        const full = injectedText.text;
        clearInjectionTimers();
        setValue('');
        // The typewriter rewrites the text - any live @-mention token is dead.
        setMention(null);
        ref.current?.focus();
        setTyping(true);
        let i = 0;
        // Adaptive pace: long workflow prompts finish in ~1s, short ones keep
        // the char-by-char feel.
        const step = Math.max(2, Math.ceil(full.length / 70));
        typeTimerRef.current = window.setInterval(() => {
            i = Math.min(full.length, i + step);
            setValue(full.slice(0, i));
            if (i >= full.length) {
                if (typeTimerRef.current != null) {
                    window.clearInterval(typeTimerRef.current);
                    typeTimerRef.current = null;
                }
                setTyping(false);
                sendBeatRef.current = window.setTimeout(() => {
                    sendBeatRef.current = null;
                    injectedAppliedRef.current?.();
                    sendRef.current(full, []);
                    setValue('');
                }, 450);
            }
        }, 16);
        return clearInjectionTimers;
    }, [injectedText, clearInjectionTimers]);

    // Restore the composer after a failed send: value + attachments come
    // back from the host so the user can fix and retry without re-attaching.
    useEffect(() => {
        if (restoreDraft) {
            setValue(restoreDraft.value);
            setAttachments(restoreDraft.attachments);
            // Restored text has no live caret token - close any popup.
            setMention(null);
            ref.current?.focus();
            onRestoreApplied?.();
        }
    }, [restoreDraft, onRestoreApplied]);

    // Edit mode: the pencil loaded a past user message - prefill the
    // composer, drop any in-flight suggestion/mention, and focus. Sending
    // now rewinds + resends (App decides via handleSend); Escape or the
    // banner's cancel exits back to normal compose mode.
    useEffect(() => {
        if (!editDraft) return;
        clearInjectionTimers();
        setValue(editDraft.value);
        // An unsent normal draft must not ride along: the edit starts from
        // the historical message alone, attachments are added fresh.
        setAttachments([]);
        setAttachError(null);
        setMention(null);
        ref.current?.focus();
    }, [editDraft, clearInjectionTimers]);

    useEffect(() => {
        if (!pickerOpen) return;
        const onDocClick = (e: MouseEvent) => {
            const target = e.target as Node;
            if (pickerRef.current?.contains(target) || popRef.current?.contains(target)) return;
            setPickerOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setPickerOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [pickerOpen]);

    // Close attach menu on outside click / Escape.
    useEffect(() => {
        if (!attachMenuOpen) return;
        const onDocClick = (e: MouseEvent) => {
            const target = e.target as Node;
            if (attachBtnRef.current?.contains(target)) return;
            const menu = composerRef.current?.querySelector('.attach-menu');
            if (menu?.contains(target)) return;
            setAttachMenuOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setAttachMenuOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [attachMenuOpen]);

    // Auto-grow the textarea up to its max-height.
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    }, [value]);

    const filteredModels = useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return models;
        return models.filter((m) => m.toLowerCase().includes(q));
    }, [filter, models]);

    const addFiles = useCallback(async (files: FileList | File[]) => {
        setAttachError(null);
        const arr = Array.from(files);
        const result: ComposerAttachment[] = [];
        let addedBytes = totalAttachBytes;
        for (const file of arr) {
            if (attachments.length + result.length >= ATTACH_MAX_COUNT) {
                setAttachError(t('attachTooMany'));
                break;
            }
            if (file.size === 0) {
                setAttachError(t('attachEmpty').replace('{name}', file.name));
                continue;
            }
            if (file.size > ATTACH_MAX_BYTES) {
                setAttachError(t('attachTooLarge').replace('{name}', file.name));
                continue;
            }
            if (addedBytes + file.size > ATTACH_MAX_TOTAL_BYTES) {
                setAttachError(t('attachTotalTooLarge'));
                break;
            }
            const mimeType = mimeForFile(file);
            // PDFs are accepted here and text-extracted host-side before
            // anything reaches the backend.
            if (!isImageMime(mimeType) && !isTextMime(mimeType) && mimeType !== 'application/pdf') {
                setAttachError(t('attachUnsupported').replace('{name}', file.name));
                continue;
            }
            try {
                let dataBase64: string;
                let size = file.size;
                let effectiveMime = mimeType;
                let name = file.name;
                if (mimeType === 'image/webp') {
                    const converted = await convertWebpToPng(await fileToBase64(file));
                    dataBase64 = converted.dataBase64;
                    size = converted.size;
                    effectiveMime = 'image/png';
                } else {
                    dataBase64 = await fileToBase64(file);
                }
                if (isImageMime(effectiveMime) && sniffImageMime(dataBase64) !== effectiveMime) {
                    setAttachError(t('attachUnsupported').replace('{name}', name));
                    continue;
                }
                if (effectiveMime === 'application/pdf') {
                    const processed: ComposerAttachment[] = [];
                    for (const part of await processPdfAttachment({ id: nextAttachId(), name, mimeType: effectiveMime, size, dataBase64 })) {
                        if (part.size > ATTACH_MAX_BYTES) {
                            setAttachError(t('attachTooLarge').replace('{name}', part.name));
                            continue;
                        }
                        if (addedBytes + part.size > ATTACH_MAX_TOTAL_BYTES) {
                            setAttachError(t('attachTotalTooLarge'));
                            break;
                        }
                        addedBytes += part.size;
                        processed.push(part);
                    }
                    result.push(...processed);
                    continue;
                }
                if (size > ATTACH_MAX_BYTES) {
                    setAttachError(t('attachTooLarge').replace('{name}', file.name));
                    continue;
                }
                if (addedBytes + size > ATTACH_MAX_TOTAL_BYTES) {
                    setAttachError(t('attachTotalTooLarge'));
                    break;
                }
                addedBytes += size;
                result.push({
                    id: nextAttachId(),
                    name,
                    mimeType: effectiveMime,
                    size,
                    dataBase64,
                });
            } catch {
                setAttachError(t('attachReadError').replace('{name}', file.name));
            }
        }
        if (result.length > 0) {
            setAttachments((prev) => [...prev, ...result]);
        }
    }, [attachments.length, totalAttachBytes]);

    const removeAttachment = useCallback((id: string) => {
        setAttachments((prev) => prev.filter((a) => a.id !== id));
        setAttachError(null);
    }, []);

    // Workspace file list for the mention popup, ranked by the typed query.
    const mentionFiles = useMemo(
        () => filterFiles(workspaceFiles ?? [], mention?.query ?? ''),
        [workspaceFiles, mention?.query],
    );
    // Keep the highlight in range as the query narrows the list.
    useEffect(() => {
        setMentionIdx((i) => Math.min(i, Math.max(0, mentionFiles.length - 1)));
    }, [mentionFiles.length]);
    // Ask the host for the file list exactly once per popup opening.
    const requestedFilesRef = useRef(false);
    useEffect(() => {
        if (mention && !requestedFilesRef.current) {
            requestedFilesRef.current = true;
            onRequestFiles?.();
        }
        if (!mention) requestedFilesRef.current = false;
    }, [mention, onRequestFiles]);

    /** Turn a picked workspace file into a REFERENCE chip: path only, zero
     *  bytes - the host reads the content at send time. The `@token` is
     *  removed from the text (the chip carries the reference). */
    const pickMentionFile = useCallback((relPath: string) => {
        if (!mention) return;
        const { text, caret } = applyMentionPick(value, mention.start, mention.caret);
        setValue(text);
        setMention(null);
        setMentionIdx(0);
        setAttachments((prev) => {
            if (prev.some((a) => a.path === relPath) || prev.length >= ATTACH_MAX_COUNT) {
                setAttachError(prev.length >= ATTACH_MAX_COUNT ? t('attachTooMany') : null);
                return prev;
            }
            return [...prev, {
                id: nextAttachId(),
                name: relPath,
                mimeType: '',
                size: 0,
                dataBase64: '',
                path: relPath,
            }];
        });
        // Restore caret position after the re-render.
        requestAnimationFrame(() => {
            const el = ref.current;
            if (el) {
                el.focus();
                el.setSelectionRange(caret, caret);
            }
        });
    }, [mention, value]);

    const onValueChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const next = e.target.value;
        setValue(next);
        // Track the `@token` under the caret as the user types.
        setMention(detectMention(next, e.target.selectionStart ?? next.length));
    };

    const submit = () => {
        const text = value.trim();
        // Attachments are a valid user turn even when no text is supplied.
        // No busy guard here: while a run streams, onSend QUEUES the turn
        // (App decides send-vs-queue) - dropping the input would lose it.
        if ((!text && attachments.length === 0)) return;
        onSend(text, attachments);
        setValue('');
        setAttachments([]);
        setAttachError(null);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Mention popup owns navigation keys while open - Enter/Tab pick,
        // arrows move, Escape closes; everything else keeps typing.
        if (mention && mentionFiles.length > 0) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const delta = e.key === 'ArrowDown' ? 1 : -1;
                setMentionIdx((i) => (i + delta + mentionFiles.length) % mentionFiles.length);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pickMentionFile(mentionFiles[Math.min(mentionIdx, mentionFiles.length - 1)]);
                return;
            }
        }
        if (mention && e.key === 'Escape') {
            e.preventDefault();
            setMention(null);
            return;
        }
        // User takeover of an in-flight suggestion: any key stops the
        // typewriter / pending auto-send and keeps the text on screen.
        if (typing) {
            clearInjectionTimers();
            injectedAppliedRef.current?.();
            if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) e.preventDefault();
            // Enter mid-typing only takes over - never sends a half-typed prompt.
            return;
        }
        if (sendBeatRef.current != null) {
            clearInjectionTimers();
            injectedAppliedRef.current?.();
            if (e.key === 'Enter' && !e.shiftKey) {
                // Send the completed prompt immediately instead of waiting
                // for the beat.
                e.preventDefault();
                submit();
            }
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            // Escape exits edit mode first; only otherwise does it cancel a
            // live run (the composer-level handler mirrors the global one).
            // Escape exits edit mode first; only otherwise does it cancel a
            // live run - and only with an empty composer, so Escape never
            // kills a run the user is mid-steering (mirrors the button).
            if (editDraft) onCancelEdit?.();
            else if (stopping) onCancel();
        }
    };

    const pickModel = (m: string) => {
        setFilter('');
        onSelectModel?.(m);
    };

    const pickCtx = (win: number | null) => {
        setCtxOpen(false);
        onSetContextWindow?.(win);
    };

    // Context-window menu: closes on outside click / Escape, like the picker.
    useEffect(() => {
        if (!ctxOpen) return;
        const onDocClick = (e: MouseEvent) => {
            if (ctxWrapRef.current?.contains(e.target as Node)) return;
            setCtxOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setCtxOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [ctxOpen]);

    // Host-side attachment rejections render inline in the composer (with the
    // same auto-dismiss as local errors) - never as chat bubbles.  Keyed by
    // id so each host post displays exactly once, never a stale repeat.
    useEffect(() => {
        if (!hostError) return;
        // Host posts i18n KEYS in valueKey (value is always ''); tf/tOrRaw
        // resolves a known key and passes unknown text through unchanged.
        setAttachError(tf(hostError.valueKey || hostError.value, hostError.params));
        onHostErrorApplied?.();
    }, [hostError, onHostErrorApplied]);

    // Host-read attachments arriving from an explorer drag (attachUris flow).
    useEffect(() => {
        if (!injectedAttachments || injectedAttachments.length === 0) return;
        let cancelled = false;
        void (async () => {
            // A new attach always supersedes the previous inline error.
            setAttachError(null);
            // Normalize client-side: webp → png (local vision runtimes), and
            // PDFs → text/pages - files attached via the explorer menu and
            // palette command never pass through addFiles.
            const normalized: ComposerAttachment[] = [];
            for (const a of injectedAttachments) {
                try {
                    if (a.mimeType === 'application/pdf') {
                        normalized.push(...await processPdfAttachment(a));
                    } else if (a.mimeType === 'image/webp') {
                        const converted = await convertWebpToPng(a.dataBase64);
                        normalized.push({ ...a, mimeType: 'image/png', size: converted.size, dataBase64: converted.dataBase64 });
                    } else if (isImageMime(a.mimeType) && sniffImageMime(a.dataBase64) !== a.mimeType) {
                        setAttachError(t('attachUnsupported').replace('{name}', a.name));
                    } else {
                        normalized.push(a);
                    }
                } catch {
                    setAttachError(t('attachReadError').replace('{name}', a.name));
                }
            }
            if (cancelled || normalized.length === 0) return;
            setAttachments((prev) => {
                const next = [...prev];
                let bytes = prev.reduce((sum, a) => sum + a.size, 0);
                let dropped = 0;
                for (const a of normalized) {
                    if (next.length >= ATTACH_MAX_COUNT || bytes + a.size > ATTACH_MAX_TOTAL_BYTES) {
                        dropped++;
                        continue;
                    }
                    next.push(a);
                    bytes += a.size;
                }
                if (dropped > 0) setAttachError(t('attachTooMany'));
                return next;
            });
            onInjectedAttachmentsApplied?.();
        })();
        return () => { cancelled = true; };
    }, [injectedAttachments, onInjectedAttachmentsApplied]);

    // Paste image data from clipboard.
    const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        // Pasted content takes over an in-flight suggestion - the typewriter
        // would otherwise clobber it on its next tick.
        if (typing || sendBeatRef.current != null) {
            clearInjectionTimers();
            injectedAppliedRef.current?.();
        }
        const items = e.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length > 0) {
            e.preventDefault();
            void addFiles(files);
        }
    };

    return (
        <div className="input-bar">
            <div
                className={`composer${typing ? ' is-typing' : ''}${editDraft ? ' is-editing' : ''}${attachments.length > 0 ? ' has-attachments' : ''}`}
                ref={composerRef}
            >
                {editDraft && (
                    <div className="composer-edit-banner">
                        <PencilLine size={12} aria-hidden="true" />
                        <span>{t('editRewindHint')}</span>
                        <button
                            type="button"
                            className="composer-edit-cancel"
                            onClick={onCancelEdit}
                            aria-label={t('editCancel')}
                            title={t('editCancel')}
                        >
                            <X size={12} />
                        </button>
                    </div>
                )}
                <label htmlFor="xratu-input" className="sr-only">
                    {t('inputSrLabel')}
                </label>
                <div className="composer-top-row">
                    <button
                        type="button"
                        className="attach-btn"
                        ref={attachBtnRef}
                        onClick={() => setAttachMenuOpen((s) => !s)}
                        aria-haspopup="menu"
                        aria-expanded={attachMenuOpen}
                        aria-label={t('attachMenuAria')}
                        title={t('attachMenuAria')}
                    >
                        <Plus size={14} />
                    </button>
                    {attachMenuOpen && (
                        <div className="attach-menu" role="menu" aria-label={t('attachMenuAria')}>
                            <button
                                type="button"
                                role="menuitem"
                                className="attach-menu-item"
                                onClick={() => {
                                    setAttachMenuOpen(false);
                                    // Insert a literal `@` at the caret - the
                                    // popup then behaves exactly like typed @.
                                    const el = ref.current;
                                    const at = el ? (el.selectionStart ?? value.length) : value.length;
                                    const end = el ? (el.selectionEnd ?? at) : at;
                                    const next = `${value.slice(0, at)}@${value.slice(end)}`;
                                    setValue(next);
                                    setMention({ start: at, caret: at + 1, query: '' });
                                    requestAnimationFrame(() => {
                                        if (el) {
                                            el.focus();
                                            el.setSelectionRange(at + 1, at + 1);
                                        }
                                    });
                                }}
                            >
                                <Link size={13} />
                                <span>{t('attachRefMenu')}</span>
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                className="attach-menu-item"
                                onClick={() => {
                                    setAttachMenuOpen(false);
                                    fileInputRef.current?.click();
                                }}
                            >
                                <Paperclip size={13} />
                                <span>{t('attachFiles')}</span>
                            </button>
                        </div>
                    )}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,.json,.jsonc,.yaml,.yml,.toml,.xml,.csv,.tsv,.ini,.cfg,.conf,.env,.log,.properties,.md,.markdown,.txt,.py,.js,.jsx,.mjs,.cjs,.ts,.tsx,.css,.scss,.less,.html,.htm,.vue,.svelte,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.hpp,.cs,.php,.sh,.bash,.zsh,.ps1,.sql,.graphql,.proto,.dockerfile,.makefile,.gradle,.gitignore,.diff,.patch,.lua,.pl,.r,.dart,.ex,.exs,.erl,.clj,.scala,.tf,.hcl,.sol,.zig,.nim"
                        multiple
                        className="sr-only"
                        onChange={(e) => {
                            if (e.target.files && e.target.files.length > 0) {
                                void addFiles(e.target.files);
                            }
                            e.target.value = '';
                        }}
                        aria-label={t('attachFiles')}
                    />
                </div>
                {attachments.length > 0 && (
                    <div className="attach-chips">
                        {attachments.map((a) => {
                            const visionDoubt = modelVisionCapable === false && isImageMime(a.mimeType);
                            return (
                                <span key={a.id} className={`attach-chip${a.path ? ' attach-chip-ref' : ''}`}>
                                    {a.path ? (
                                        <span className="attach-chip-icon" title={t('refChipTitle')}>
                                            <Link size={13} />
                                        </span>
                                    ) : a.mimeType.startsWith('image/') ? (
                                        <img
                                            className="attach-chip-thumb"
                                            src={`data:${a.mimeType};base64,${a.dataBase64}`}
                                            alt={a.name}
                                        />
                                    ) : (
                                        <span className="attach-chip-icon">
                                            <File size={14} />
                                        </span>
                                    )}
                                    <span className="attach-chip-name" dir="ltr">{a.path ?? a.name}</span>
                                    {visionDoubt && (
                                        <span
                                            className="attach-chip-warn"
                                            title={t('attachVisionWarn')}
                                            aria-label={t('attachVisionWarn')}
                                        >
                                            <TriangleAlert size={11} />
                                        </span>
                                    )}
                                    {a.size > 0 && (
                                        <span className="attach-chip-size" dir="ltr">{fmtCompact(a.size)}</span>
                                    )}
                                    <button
                                        type="button"
                                        className="attach-chip-remove"
                                        onClick={() => removeAttachment(a.id)}
                                        aria-label={t('removeAttachment')}
                                        title={t('removeAttachment')}
                                    >
                                        <X size={11} />
                                    </button>
                                </span>
                            );
                        })}
                    </div>
                )}
                {attachError && (
                    <p className="attach-error" role="alert">{attachError}</p>
                )}
                <textarea
                    id="xratu-input"
                    ref={ref}
                    className="composer-input"
                    rows={1}
                    dir={value ? 'auto' : getLocale() === 'fa' ? 'rtl' : 'ltr'}
                    placeholder={busy ? t('inputPlaceholderBusy') : t('inputPlaceholder')}
                    value={value}
                    autoFocus
                    onChange={onValueChange}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    aria-label={t('inputSrLabel')}
                />
                <div className="composer-actions">
                <div className="composer-chips">
                    <button
                        type="button"
                        className="chip-btn picker-chip"
                        ref={pickerRef}
                        onClick={() => setPickerOpen((s) => !s)}
                        aria-haspopup="listbox"
                        aria-expanded={pickerOpen}
                        aria-label={t('pickModel')}
                        title={t('pickModel')}
                    >
                        <Cpu size={12} />
                        <span dir="ltr" className="chip-model-name">
                            {selectedModel ?? t('modelPlaceholder')}
                        </span>
                        {thinkingLevel && (
                            <span
                                className={`chip-think lvl-${thinkingLevel}`}
                                title={t('thinkingLevel')}
                            >
                                <Brain size={11} />
                                {t(thinkingLevel === 'low' ? 'thinkingLow' : thinkingLevel === 'medium' ? 'thinkingMedium' : 'thinkingHigh')}
                            </span>
                        )}
                        <ChevronUp size={12} />
                    </button>
                    <span className="ctx-wrap" ref={ctxWrapRef}>
                        <button
                            type="button"
                            className="chip-btn tok-meter"
                            onClick={() => setCtxOpen((s) => !s)}
                            aria-haspopup="menu"
                            aria-expanded={ctxOpen}
                            aria-label={t('ctxAria')}
                            title={`${t('ctxMeterLabel')} · ${fmtCompact(usedTokens)} / ${fmtWindow(limit)}`}
                        >
                            <svg className="tok-ring" viewBox="0 0 20 20" aria-hidden="true">
                                <circle className="tok-ring-bg" cx="10" cy="10" r="8" />
                                <circle
                                    className={`tok-ring-fill${usagePercent > 90 ? ' danger' : usagePercent > 70 ? ' warn' : ''}`}
                                    cx="10" cy="10" r="8"
                                    strokeDasharray={`${(Math.min(usagePercent / 100, 1) * RING_CIRC).toFixed(2)} ${RING_CIRC.toFixed(2)}`}
                                />
                            </svg>
                            <span className="tok-pct" dir="ltr">
                                    ({Math.round(usagePercent)}%)
                            </span>
                            <span className="tok-text" dir="ltr">
                                    {fmtCompact(usedTokens)}
                            </span>
                            <ChevronUp size={12} />
                        </button>
                        {ctxOpen && (
                            <div className="ctx-menu" role="menu" aria-label={t('ctxAria')}>
                                <button
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={!ctxOverridden}
                                    disabled={defaultTooSmall}
                                    aria-disabled={defaultTooSmall || undefined}
                                    title={defaultTooSmall ? t('ctxOptBelowUsage') : undefined}
                                    className={`ctx-opt${!ctxOverridden ? ' selected' : ''}`}
                                    onClick={() => pickCtx(null)}
                                >
                                    {t('ctxOptDefault')}
                                    {!ctxOverridden && <Check size={12} />}
                                </button>
                                {CTX_PRESETS.map((p) => {
                                    const active = ctxOverridden && limit === p.value;
                                    const tooSmall = occupied > 0 && p.value < occupied;
                                    return (
                                        <button
                                            key={p.label}
                                            type="button"
                                            role="menuitemradio"
                                            aria-checked={active}
                                            disabled={tooSmall}
                                            aria-disabled={tooSmall || undefined}
                                            title={tooSmall ? t('ctxOptBelowUsage') : undefined}
                                            className={`ctx-opt${active ? ' selected' : ''}`}
                                            onClick={() => pickCtx(p.value)}
                                        >
                                            <span dir="ltr">{p.label}</span>
                                            {active && <Check size={12} />}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </span>
                    </div>
                    <div className="composer-buttons">
                        <button
                            type="button"
                            className={`send-btn${stopping ? ' is-stop' : ''}`}
                            onClick={stopping ? onCancel : submit}
                            disabled={!stopping && !canSend}
                            aria-label={stopping ? t('stopAria') : editDraft ? t('editSave') : t('sendAria')}
                            title={stopping ? t('stopTitle') : editDraft ? t('editSave') : t('sendTitle')}
                        >
                            {stopping ? <Square size={14} /> : editDraft ? <RefreshCw size={14} /> : <Send size={15} />}
                        </button>
                    </div>
                </div>

                {pickerOpen && (
                    <div className="model-pop" role="listbox" aria-label={t('modelListAria')} ref={popRef}>
                        <div className="model-pop-head">
                            <div className="model-search">
                                <Search size={13} />
                                <input
                                    type="text"
                                    dir={filter ? 'auto' : getLocale() === 'fa' ? 'rtl' : 'ltr'}
                                    placeholder={t('searchModel')}
                                    value={filter}
                                    onChange={(e) => setFilter(e.target.value)}
                                    autoFocus
                                    aria-label={t('searchModelAria')}
                                />
                            </div>
                            <button
                                type="button"
                                className={`ghost-btn small${refreshing ? ' spinning' : ''}`}
                                onClick={onRefreshModels}
                                disabled={refreshing}
                                aria-busy={refreshing || undefined}
                                aria-label={t('refreshModels')}
                                title={t('refreshTitle')}
                            >
                                <RefreshCw size={13} />
                            </button>
                        </div>
                        <div className="model-list" role="presentation">
                            {filteredModels.length === 0 && (
                                <p className="model-empty">{t('noModels')}</p>
                            )}
                            {filteredModels.map((m) => (
                                <button
                                    key={m}
                                    type="button"
                                    role="option"
                                    aria-selected={m === selectedModel}
                                    className={`model-item${m === selectedModel ? ' selected' : ''}`}
                                    onClick={() => pickModel(m)}
                                >
                                    <span dir="ltr">{m}</span>
                                    {m === selectedModel && (
                                        <Check size={13} className="model-check" />
                                    )}
                                </button>
                            ))}
                        </div>
                        {selectedModel && onSetThinkingLevel && (
                            <div className="thinking-row" role="radiogroup" aria-label={t('thinkingLevel')}>
                                <span className="thinking-row-label">
                                    <Brain size={12} />
                                    {t('thinkingLevel')}
                                </span>
                                <div className="thinking-seg">
                                    {([null, 'low', 'medium', 'high'] as const).map((lvl) => {
                                        const active = (thinkingLevel ?? null) === lvl;
                                        return (
                                            <button
                                                key={lvl ?? 'default'}
                                                type="button"
                                                role="radio"
                                                aria-checked={active}
                                                className={`thinking-seg-opt${active ? ' selected' : ''}`}
                                                onClick={() => onSetThinkingLevel(lvl)}
                                            >
                                                {t(lvl === null ? 'thinkingDefault' : lvl === 'low' ? 'thinkingLow' : lvl === 'medium' ? 'thinkingMedium' : 'thinkingHigh')}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                )}
                {mention && (
                    <div className="model-pop mention-pop" role="listbox" aria-label={t('fileSearchAria')}>
                        <div className="mention-head">
                            <Link size={12} />
                            <span>{t('attachRefMenu')}</span>
                            <span className="mention-query" dir="ltr">@{mention.query}</span>
                        </div>
                        <div className="mention-list">
                            {mentionFiles.length === 0 && (
                                <p className="model-empty">
                                    {workspaceFiles == null ? t('fileListLoading') : t('noFilesFound')}
                                </p>
                            )}
                            {mentionFiles.map((p, i) => (
                                <button
                                    key={p}
                                    type="button"
                                    role="option"
                                    aria-selected={i === mentionIdx}
                                    className={`mention-item${i === mentionIdx ? ' selected' : ''}`}
                                    onMouseEnter={() => setMentionIdx(i)}
                                    onMouseDown={(e) => {
                                        // preventDefault keeps the textarea
                                        // focused (the pick repositions its caret).
                                        e.preventDefault();
                                        pickMentionFile(p);
                                    }}
                                >
                                    <span className="mention-item-name" dir="ltr">
                                        {p.slice(p.lastIndexOf('/') + 1)}
                                    </span>
                                    {p.includes('/') && (
                                        <span className="mention-item-dir" dir="ltr">
                                            {p.slice(0, p.lastIndexOf('/'))}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
