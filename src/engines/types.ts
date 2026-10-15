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
}
export interface EngineTurn {
    prompt: string;
    model: string;
    variant?: string;
    workspace: string;
    signal: AbortSignal;
    plan: boolean;
    yolo: boolean;
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
    phase: 'checking' | 'missing' | 'unsupported' | 'ready' | 'installing' | 'failed';
    version?: string;
    binaryPath?: string;
    customPath: string;
    installedByXratu: boolean;
    downloadedBytes?: number;
    totalBytes?: number;
    errorKey?: string;
    detail?: string;
    busy: boolean;
}
