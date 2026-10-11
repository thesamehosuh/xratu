import { runLocalAgent } from '../local/localAgent';
import type { AgentEngine } from './types';

export const xratuEngine: AgentEngine = {
    id: 'xratu',
    capabilities: { steering: true, rewind: true, localTools: true },
    runTurn(turn, host) {
        if (!turn.localRequest || !host.executor) throw new Error('Missing Xratu engine context');
        return runLocalAgent(turn.localRequest, host.executor, host.approvals, host.steer);
    },
    async dispose() { /* The caller owns each local turn's AbortController. */ },
};
