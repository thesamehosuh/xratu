export type XratuRuntimeMode = 'cloud' | 'local';

export interface LocalModelConnection {
    id: string;
    runtime: 'ollama' | 'lm-studio' | 'llama.cpp' | 'vllm' | 'custom';
    name: string;
    baseUrl: string;
    apiKey?: string | null;
    model?: string;
}

export interface LocalModelInfo {
    id: string;
    object?: string;
    ownedBy?: string;
    contextWindow?: number;
    supportsTools?: boolean;
    supportsVision?: boolean;
}

export interface LocalRuntimeStatus {
    mode: 'local';
    connectionId: string;
    baseUrl: string;
    connected: boolean;
    models: LocalModelInfo[];
    error?: string;
}
