import type { LocalAgentEvent, LocalAgentRequest, LocalApprovalGate, LocalImageAttachment, LocalSteerFeed, LocalToolExecutor } from '../local/localTypes';
import type { UserQuestionGate } from '../tooling/userQuestion';

export type EngineId = 'xratu' | 'opencode';
export interface EngineSessionRef {
    engineId: EngineId;
    nativeSessionId?: string;
    binaryPath?: string;
    workspace?: string;
}
export interface EngineCapabilities {
    steering: boolean;
    rewind: boolean;
    localTools: boolean;
    nativeConfiguration: boolean;
    offline: boolean;
    subagents: boolean;
}
/** Shared by runtime admission, setup, and settings; readiness is separate. */
export const ENGINE_CAPABILITIES: Record<EngineId, EngineCapabilities> = {
    xratu: { steering: true, rewind: true, localTools: true, nativeConfiguration: false, offline: true, subagents: true },
    opencode: { steering: true, rewind: false, localTools: false, nativeConfiguration: true, offline: false, subagents: false },
};
export interface EngineTurn {
    prompt: string;
    model: string;
    variant?: string;
    workspace: string;
    signal: AbortSignal;
    plan: boolean;
    yolo: boolean;
    /** Host policy, delivered through native instructions, never user text. */
    context?: string;
    /** Built-in turns carry images; native turns also stage text/code files. */
    attachments?: LocalImageAttachment[];
    session?: EngineSessionRef;
    localRequest?: LocalAgentRequest;
}
export interface EngineHost {
    approvals: LocalApprovalGate;
    questions: UserQuestionGate;
    executor?: LocalToolExecutor;
    steer?: LocalSteerFeed;
    onSession?: (session: EngineSessionRef) => Promise<void>;
    onSteerRejected?: (steerId: string | undefined) => void;
}
export interface AgentEngine {
    readonly id: EngineId;
    readonly capabilities: EngineCapabilities;
    runTurn(turn: EngineTurn, host: EngineHost): AsyncIterable<LocalAgentEvent>;
    dispose(): Promise<void>;
}

export interface EngineSetupState {
    active: EngineId;
    phase: 'checking' | 'missing' | 'unsupported' | 'ready' | 'installing' | 'removing' | 'failed';
    version?: string;
    binaryPath?: string;
    customPath: string;
    installedByXratu: boolean;
    updateAvailable?: boolean;
    downloadedBytes?: number;
    totalBytes?: number;
    errorKey?: string;
    detail?: string;
    busy: boolean;
}
