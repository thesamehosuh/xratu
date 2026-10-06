/**
 * Shared host-side chat types: what the composer sends, what the transcript
 * stores, and what a user turn carries once attachment bytes are stripped.
 * Split out of extension.ts - the attachment layer and the webview message
 * router both need them.
 */

export interface ComposerAttachment {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    dataBase64: string;
    /** Workspace-relative path of a REFERENCE attachment (@-mention): the
     *  webview sends path-only, and this host reads the bytes at send time
     *  (resolveReferenceAttachments) so content is always fresh. */
    path?: string;
}

export interface AttachmentMeta {
    name: string;
    mime_type: string;
    size: number;
    path?: string;
}

export interface HistoryMessage {
    role: string;
    content?: string;
    events?: any[];
    /** Shadow-checkpoint sha taken just BEFORE this prompt ran - the restore
     *  point when the user edits/resends or regenerates this turn. */
    cp?: string;
    /** Attachment metadata (no base64) for user turns - rendered in the
     *  bubble and replayed on edit/resend. */
    attachments?: AttachmentMeta[];
}
