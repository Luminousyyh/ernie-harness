import type { ChatMessage, Goal, GoalInput, HarnessEvent } from '../../src/contracts/index.js';

export interface Workspace {id: string; path: string; name: string; createdAt: string}
export interface ModelCapabilities {status?: 'available' | 'unavailable'; model?: string; contextLength?: number; reasoning?: {advertised?: string[]; verified?: string[]; selected?: string; reason?: string}; checkedAt?: string}
export interface ServiceState {
  workspaces?: Workspace[];
  activeWorkspaceId?: string;
  goals: Goal[];
  provider: {model: string; configured: boolean; mode: string};
  stats: {calls: number; inputTokens: number; outputTokens: number};
  version: string;
  workspace: string;
}
export interface GoalDetail {goal: Goal; messages: ChatMessage[]; events: HarnessEvent[]; eventCursor?: number}
export interface Benchmark {status: string; summary: unknown; trials: unknown[]; report?: string}
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; }
}
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {credentials: 'same-origin', ...options, headers: {...(options.body ? {'Content-Type': 'application/json'} : {}), ...options.headers}});
  } catch { throw new ApiError(0, '无法连接本地服务，请确认 ERNIE Harness 已启动。'); }
  let data: unknown;
  try { data = await response.json(); } catch { throw new ApiError(response.status, '本地服务未返回有效响应，请检查服务是否已启动。'); }
  if (!response.ok) {
    const body = data as {error?: string; message?: string};
    throw new ApiError(response.status, response.status === 401 ? '会话已过期，请使用本地服务令牌连接。' : body.message || body.error || `请求失败 (${response.status})`);
  }
  return data as T;
}
const body = (value: unknown) => JSON.stringify(value);
export const api = {
  auth: (token: string) => request<unknown>('/auth', {method: 'POST', body: body({token})}),
  state: () => request<ServiceState>('/state'),
  capabilities: () => request<ModelCapabilities>('/model/capabilities'),
  addWorkspace: (input: {path: string; name?: string}) => request<Workspace>('/workspaces', {method: 'POST', body: body(input)}),
  editWorkspace: (id: string, patch: {path?: string; name?: string}) => request<Workspace>(`/workspaces/${encodeURIComponent(id)}`, {method: 'PATCH', body: body(patch)}),
  selectWorkspace: (id: string) => request<Workspace>(`/workspaces/${encodeURIComponent(id)}/select`, {method: 'POST'}),
  message: (id: string, content: string, start = true) => request<Goal>(`/goals/${encodeURIComponent(id)}/messages`, {method: 'POST', body: body({content, start})}),
  child: (id: string, input: Omit<GoalInput, 'workspace' | 'parentId'>) => request<Goal>(`/goals/${encodeURIComponent(id)}/children`, {method: 'POST', body: body(input)}),
  detail: (id: string) => request<GoalDetail>(`/goals/${encodeURIComponent(id)}`),
  create: (input: GoalInput) => request<Goal>('/goals', {method: 'POST', body: body(input)}),
  action: (id: string, action: 'start' | 'pause' | 'resume' | 'cancel') => request<Goal>(`/goals/${encodeURIComponent(id)}/${action}`, {method: 'POST'}),
  edit: (id: string, patch: Pick<Goal, 'title' | 'prompt' | 'acceptanceCommands'>) => request<Goal>(`/goals/${encodeURIComponent(id)}`, {method: 'PATCH', body: body(patch)}),
  reconcile: (id: string, note: string) => request<Goal>(`/goals/${encodeURIComponent(id)}/reconcile`, {method: 'POST', body: body({note})}),
  diff: (id: string) => request<{diff: string}>(`/goals/${encodeURIComponent(id)}/diff`),
  benchmark: () => request<Benchmark>('/benchmark'),
};
