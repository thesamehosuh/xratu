import { createContext } from 'react';

export const AgentNavigation = createContext<((stepId: string) => void) | null>(null);
