import type {Goal, Usage} from '../contracts/index.js';

export type LearningPartition = 'development' | 'production' | 'formal';
export type MemoryStatus = 'active' | 'disabled' | 'candidate';
export interface MemoryEvidence {
  id: string;
  goalId: string;
  goalRevision: number;
  command: string;
  workspaceHash: string;
  createdAt: string;
}
export interface MemoryEntry {
  id: string;
  workspace: string;
  projectId: string;
  partition: Exclude<LearningPartition, 'formal'>;
  text: string;
  status: MemoryStatus;
  evidence: MemoryEvidence[];
  sourceHash: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface ReflectionDelta {
  op: 'add' | 'update' | 'disable';
  id?: string;
  text?: string;
  evidenceIds: string[];
}
export interface ReflectionDocument {version: 1; deltas: ReflectionDelta[]}
export interface BudgetMarker {
  id: string;
  revision: number;
  phase: 'reserved' | 'settled';
  input: number;
  output: number;
  activeMs: number;
  priorEstimated: boolean;
  priorInputEstimated: boolean;
  priorOutputEstimated: boolean;
}
export type LearningUsage = Goal['usage'] & {learningReservations?: Record<string, BudgetMarker>};
export type AttemptStatus = 'pending-budget' | 'reserving' | 'dispatched' | 'completed' | 'uncertain' | 'cancelled';
export interface LearningAttempt {
  id: string;
  goalId: string;
  revision: number;
  projectId: string;
  partition: Exclude<LearningPartition, 'formal'>;
  status: AttemptStatus;
  reason?: string;
  reservation?: BudgetMarker;
  createdAt: string;
  updatedAt: string;
}
export const validUsage = (usage: Usage): boolean => [usage.inputTokens, usage.outputTokens, usage.reasoningTokens].every(value => Number.isSafeInteger(value) && value >= 0);
