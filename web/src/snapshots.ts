import type {Goal} from '../../src/contracts/index.js';
import type {ServiceState} from './api.js';
export type GoalWatermarks = Readonly<Record<string, number>>;
export interface LocalGoalChanges {startedAt: number; watermarks: GoalWatermarks}
// A request is authoritative only until a newer event for this goal is observed.
export function mergeGoalSnapshot(current: Goal | undefined, incoming: Goal, startedAt: number, watermarks: GoalWatermarks, local?: LocalGoalChanges): Goal {
  if (!current) return incoming;
  if ((watermarks[incoming.id] ?? 0) > startedAt || (local && (local.watermarks[incoming.id] ?? 0) > local.startedAt) || incoming.revision < current.revision) return current;
  if (Date.parse(incoming.updatedAt) < Date.parse(current.updatedAt)) return current;
  return incoming;
}
export function mergeServiceSnapshot(current: ServiceState | null, incoming: ServiceState, startedAt: number, watermarks: GoalWatermarks, local?: LocalGoalChanges): ServiceState {
  if (!current) return incoming;
  const previous = new Map(current.goals.map(goal => [goal.id, goal]));
  const seen = new Set(incoming.goals.map(goal => goal.id));
  return {...incoming, goals: [
    ...incoming.goals.map(goal => mergeGoalSnapshot(previous.get(goal.id), goal, startedAt, watermarks, local)),
    // The current API never deletes goals: omission cannot remove an observed row.
    ...current.goals.filter(goal => !seen.has(goal.id)),
  ]};
}
