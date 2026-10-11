import type { AgentEngine, EngineId } from './types';

export class EngineRegistry {
    private readonly engines = new Map<EngineId, AgentEngine>();
    register(engine: AgentEngine): void { this.engines.set(engine.id, engine); }
    get(id: EngineId): AgentEngine {
        const engine = this.engines.get(id);
        if (!engine) throw new Error(`Unknown engine: ${id}`);
        return engine;
    }
    async dispose(): Promise<void> { await Promise.allSettled([...this.engines.values()].map(engine => engine.dispose())); }
}
