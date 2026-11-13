import type {Goal} from '../../src/contracts/index.js';
import type {ServiceState, Workspace} from './api.js';
import {basename, record} from './state.js';
export type WorkspaceEntry = Omit<Workspace, 'id'> & {id?: string};
export function workspaceEntries(state: ServiceState | null): WorkspaceEntry[] {
  if (!state) return [];
  const entries: WorkspaceEntry[] = [...(state.workspaces ?? [])];
  for (const path of [state.workspace, ...state.goals.map(goal => goal.workspace)]) {
    if (path && !entries.some(item => item.path === path)) entries.push({path, name: basename(path), createdAt: ''});
  }
  return entries;
}
export function activeWorkspace(state: ServiceState | null): WorkspaceEntry | undefined {
  return state?.workspaces?.find(item => item.id === state.activeWorkspaceId) ?? workspaceEntries(state).find(item => item.path === state?.workspace);
}
export function isAbsoluteDirectory(path: string): boolean {
  return /^(?:[a-z]:[\\/]|\\\\[^\\]+[\\][^\\]+|\/)/i.test(path.trim());
}
export function continuationBlock(status: string): string {
  if (status === 'cancelled') return '此会话已取消。请新建会话继续。';
  if (status === 'needs-reconciliation') return '请先在检查器中核对不确定的操作。';
  if (status === 'running' || status === 'waiting-rate-limit') return '当前仍在执行，请暂停或等待本轮结束后发送。';
  return '';
}
// Context fields are optional until a capable backend returns current-request accounting.
export function contextSnapshot(goal: Goal) {
  const context = record((goal as Goal & {context?: unknown}).context);
  const number = (key: string) => typeof context[key] === 'number' && Number.isFinite(context[key]) ? Math.max(0, context[key] as number) : undefined;
  const limit = number('effectiveLimit') ?? goal.contextLimit;
  const stale = typeof context.requestRevision === 'number' && context.requestRevision !== goal.revision;
  const used = stale ? undefined : number('requestInputTokens');
  const remaining = stale ? undefined : number('remainingTokens');
  return {limit, used, remaining, stale, raw: context};
}
