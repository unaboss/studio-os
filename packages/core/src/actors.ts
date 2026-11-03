import type { Actor } from './types.ts'

export const SYSTEM: Actor = { id: 'system', kind: 'system', role: 'manager', name: 'Studio OS' }
export const AGENT: Actor = { id: 'agent', kind: 'agent', role: 'manager', name: 'Back-office agent' }
