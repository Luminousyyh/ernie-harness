import type {Locale} from '../../src/i18n/index.js';
import type { ChatMessage, HarnessEvent } from '../../src/contracts/index.js';

export interface ThreadState {
  goalId: string;
  messages: ChatMessage[];
  events: HarnessEvent[];
  draft: string;
  reasoning: string;
  lastSeq: number;
  loaded: boolean;
}
export function emptyThread(goalId: string): ThreadState {
  return {goalId, messages: [], events: [], draft: '', reasoning: '', lastSeq: 0, loaded: false};
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
export function applyEvent(thread: ThreadState, event: HarnessEvent): ThreadState {
  if (event.goalId !== thread.goalId || event.seq <= thread.lastSeq) return thread;
  const next = {...thread, lastSeq: event.seq, events: [...thread.events, event]};
  const data = record(event.data);
  if (event.type === 'model.delta' && typeof data.text === 'string') {
    if (data.type === 'text') next.draft += data.text;
    if (data.type === 'reasoning') next.reasoning += data.text;
  }
  if (event.type === 'message' && ['user', 'assistant', 'tool', 'system'].includes(String(data.role))) {
    next.messages = [...next.messages, data as unknown as ChatMessage];
    if (data.role === 'assistant') { next.draft = ''; next.reasoning = ''; }
  }
  if (event.type === 'context.compacted') { next.draft = ''; next.reasoning = ''; }
  return next;
}
export function hydrateThread(goalId: string, snapshot: {messages: ChatMessage[]; events: HarnessEvent[]; eventCursor?: number}, current?: ThreadState): ThreadState {
  let next = emptyThread(goalId);
  for (const event of [...snapshot.events].sort((a, b) => a.seq - b.seq)) next = applyEvent(next, event);
  next.messages = snapshot.messages;
  next.loaded = true;
  // Full messages are authoritative through the explicit cursor even when the event window is bounded.
  // Older backends fall back to the greatest parsed event sequence.
  next.lastSeq = Math.max(snapshot.eventCursor ?? 0, next.lastSeq);
  for (const event of current?.events ?? []) if (event.seq > next.lastSeq) next = applyEvent(next, event);
  return next;
}
export function parseAcceptance(value: string): string[] {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
export function safeHref(value: string): string | undefined {
  if (/[\u0000-\u0020\u007f]/.test(value) || !/^(https?:\/\/|mailto:)/i.test(value)) return undefined;
  try { const url = new URL(value); return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : undefined; } catch { return undefined; }
}
export function parseAuthFragment(hash: string): string | undefined {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token')?.trim() || undefined;
}
export const statusLabels: Record<string, string> = {
  pending: '待启动', running: '执行中', 'waiting-rate-limit': '等待额度恢复', 'waiting-input': '等待输入', paused: '已暂停', 'needs-reconciliation': '待人工核对', succeeded: '已完成', failed: '执行失败', cancelled: '已取消',
};
export function basename(path: string): string { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path; }
export function formatNumber(value?: number, locale: Locale = 'zh-CN'): string { return typeof value === 'number' ? new Intl.NumberFormat(locale, {notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1}).format(value) : '—'; }
export function formatTime(value: string, locale: Locale = 'zh-CN'): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit', second: '2-digit'}); }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '请求未完成，请重试。'; }
