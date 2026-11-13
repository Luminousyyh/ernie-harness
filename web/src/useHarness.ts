import { useCallback, useEffect, useRef, useState } from 'react';
import type { Goal, GoalInput, HarnessEvent } from '../../src/contracts/index.js';
import { api, ApiError, type ServiceState, type ModelCapabilities } from './api.js';
import {mergeGoalSnapshot, mergeServiceSnapshot} from './snapshots.js';
import {activeWorkspace} from './workspaces.js';
import { applyEvent, emptyThread, errorMessage, hydrateThread, parseAuthFragment, record, type ThreadState } from './state.js';

export type Connection = 'connecting' | 'ready' | 'offline' | 'auth';
export function useHarness() {
  const [conversationDrafts, setConversationDrafts] = useState<Record<string, string>>({});
  const [draftWorkspace, setDraftWorkspace] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ModelCapabilities | null>(null);
  const [state, setState] = useState<ServiceState | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [stream, setStream] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, ThreadState>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const cursor = useRef(0);
  const goalWatermarks = useRef<Record<string, number>>({});
  const localGeneration = useRef(0);
  const localGoalWatermarks = useRef<Record<string, number>>({});
  const stateVersion = useRef(0);
  const selected = useRef(selectedId);
  selected.current = selectedId;
  const detailVersion = useRef<Record<string, number>>({});
  const mounted = useRef(true);

  const report = useCallback((cause: unknown) => {
    if (!mounted.current) return;
    if (cause instanceof ApiError && cause.status === 401) setConnection('auth');
    setError(errorMessage(cause));
  }, []);
  const refresh = useCallback(async () => {
    const version = ++stateVersion.current;
    const startedAt = cursor.current;
    const localStartedAt = localGeneration.current;
    try {
      const next = await api.state();
      if (mounted.current && stateVersion.current === version) { setState(current => mergeServiceSnapshot(current, next, startedAt, goalWatermarks.current, {startedAt: localStartedAt, watermarks: localGoalWatermarks.current})); setConnection('ready'); }
      return next;
    } catch (cause) {
      if (mounted.current && stateVersion.current === version) { setConnection(cause instanceof ApiError && cause.status === 401 ? 'auth' : 'offline'); }
      throw cause;
    }
  }, []);
  const loadDetail = useCallback(async (id: string) => {
    const version = (detailVersion.current[id] ?? 0) + 1;
    detailVersion.current[id] = version;
    const startedAt = cursor.current;
    const localStartedAt = localGeneration.current;
    try {
      const detail = await api.detail(id);
      if (!mounted.current || detailVersion.current[id] !== version) return;
      setThreads(current => ({...current, [id]: hydrateThread(id, detail, current[id])}));
      setState(current => current && ({...current, goals: current.goals.map(goal => goal.id === id ? mergeGoalSnapshot(goal, detail.goal, startedAt, goalWatermarks.current, {startedAt: localStartedAt, watermarks: localGoalWatermarks.current}) : goal)}));
    } catch (cause) { report(cause); }
  }, [report]);
  useEffect(() => {
    mounted.current = true;
    const token = parseAuthFragment(location.hash);
    if (token) history.replaceState(null, '', `${location.pathname}${location.search}`);
    void (async () => {
      try { if (token) await api.auth(token); await refresh(); }
      catch (cause) { report(cause); if (token) setConnection('auth'); }
    })();
    return () => { mounted.current = false; };
  }, [refresh, report]);
  useEffect(() => { if (connection === 'ready') void api.capabilities().then(setCapabilities).catch(() => setCapabilities(null)); }, [connection]);
  useEffect(() => { if (selectedId && connection === 'ready') void loadDetail(selectedId); }, [selectedId, connection, loadDetail]);

  useEffect(() => {
    if (connection !== 'ready') return;
    let source: EventSource | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const connect = () => {
      if (stopped) return;
      source = new EventSource(`/api/events?after=${cursor.current}`, {withCredentials: true});
      source.onopen = () => {
        failures = 0; setStream('live');
        void refresh().catch(report);
        if (selected.current) void loadDetail(selected.current);
      };
      source.onmessage = message => {
        let event: HarnessEvent;
        try { event = JSON.parse(message.data) as HarnessEvent; } catch { return; }
        if (!Number.isSafeInteger(event.seq) || typeof event.goalId !== 'string' || event.seq <= cursor.current) return;
        cursor.current = event.seq;
        goalWatermarks.current[event.goalId] = event.seq;
        setThreads(current => ({...current, [event.goalId]: applyEvent(current[event.goalId] ?? emptyThread(event.goalId), event)}));
        if (event.type === 'goal.created' || event.type === 'goal.updated') {
          const goal = record(event.data);
          if (goal.id === event.goalId && typeof goal.status === 'string') setState(current => current && ({...current, goals: current.goals.some(item => item.id === goal.id) ? current.goals.map(item => item.id === goal.id ? goal as unknown as Goal : item) : [goal as unknown as Goal, ...current.goals]}));
        }
        if (event.type !== 'model.delta' && !refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh().catch(report); }, 400);
        if (['run.completed', 'run.failed', 'context.compacted', 'reconciliation'].includes(event.type)) void loadDetail(event.goalId);
      };
      source.onerror = () => {
        source?.close(); setStream('reconnecting');
        retry = setTimeout(() => { void refresh().then(connect).catch(report); }, Math.min(12000, 1000 * 2 ** failures++));
      };
    };
    connect();
    const onFocus = () => { void refresh().catch(report); if (selected.current) void loadDetail(selected.current); };
    window.addEventListener('focus', onFocus);
    return () => { stopped = true; source?.close(); clearTimeout(retry); clearTimeout(refreshTimer); window.removeEventListener('focus', onFocus); };
  }, [connection, refresh, loadDetail, report]);

  async function receiveGoal(request: () => Promise<Goal>): Promise<Goal> {
    const startedAt = cursor.current;
    const goal = await request();
    localGoalWatermarks.current[goal.id] = ++localGeneration.current;
    setState(current => current && ({...current, goals: current.goals.some(item => item.id === goal.id) ? current.goals.map(item => item.id === goal.id ? mergeGoalSnapshot(item, goal, startedAt, goalWatermarks.current) : item) : [goal, ...current.goals]}));
    return goal;
  }
  async function act(id: string, action: 'start' | 'pause' | 'resume' | 'cancel') {
    if (busy) return;
    setBusy(`${id}:${action}`); setError('');
    try { await receiveGoal(() => api.action(id, action)); await loadDetail(id); }
    catch (cause) { report(cause); }
    finally { setBusy(''); }
  }
  async function create(input: GoalInput): Promise<boolean> {
    if (busy) return false;
    setBusy('create'); setError('');
    let created: Goal | undefined;
    try {
      created = await receiveGoal(() => api.create(input));
      const id = created.id; setSelectedId(id);
      await receiveGoal(() => api.action(id, 'start'));
      await loadDetail(created.id);
      return true;
    } catch (cause) {
      report(cause);
      if (created) { setError(`目标已保存，启动未完成。可在该目标中再次启动。${errorMessage(cause)}`); await loadDetail(created.id); return true; }
      return false;
    } finally { setBusy(''); }
  }
  async function edit(id: string, patch: Pick<Goal, 'title' | 'prompt' | 'acceptanceCommands'>): Promise<boolean> {
    if (busy) return false;
    setBusy(`${id}:edit`); setError('');
    try { await receiveGoal(() => api.edit(id, patch)); await loadDetail(id); return true; }
    catch (cause) { report(cause); return false; }
    finally { setBusy(''); }
  }
  async function reconcile(id: string, note: string): Promise<boolean> {
    if (busy) return false;
    setBusy(`${id}:reconcile`); setError('');
    try { await receiveGoal(() => api.reconcile(id, note)); await loadDetail(id); return true; }
    catch (cause) { report(cause); return false; }
    finally { setBusy(''); }
  }
  async function saveWorkspace(id: string | undefined, input: {path: string; name?: string}): Promise<boolean> {
    if (busy) return false;
    setBusy('workspace'); setError('');
    try {
      const workspace = id ? await api.editWorkspace(id, input) : await api.addWorkspace(input);
      if (!id) await api.selectWorkspace(workspace.id);
      const next = await refresh(); setDraftWorkspace(activeWorkspace(next)?.path ?? null); setSelectedId(null); return true;
    } catch (cause) {report(cause); return false;} finally {setBusy('');}
  }
  async function selectWorkspace(id: string): Promise<boolean> {
    if (busy) return false;
    setBusy('workspace'); setError('');
    try {const workspace = await api.selectWorkspace(id); await refresh(); setDraftWorkspace(workspace.path); setSelectedId(null); return true;}
    catch (cause) {report(cause); return false;} finally {setBusy('');}
  }
  async function continueConversation(id: string, content: string): Promise<boolean> {
    if (busy) return false;
    setBusy(`${id}:message`); setError('');
    try {await receiveGoal(() => api.message(id, content, true)); await loadDetail(id); return true;}
    catch (cause) {report(cause); return false;} finally {setBusy('');}
  }
  async function createChild(id: string, input: Omit<GoalInput, 'workspace' | 'parentId'>): Promise<boolean> {
    if (busy) return false;
    setBusy(`${id}:child`); setError('');
    try {const goal = await receiveGoal(() => api.child(id, input)); setSelectedId(goal.id); await loadDetail(goal.id); return true;}
    catch (cause) {report(cause); return false;} finally {setBusy('');}
  }
  async function authenticate(token: string) {
    setBusy('auth'); setError('');
    try { await api.auth(token); await refresh(); }
    catch (cause) { report(cause); }
    finally { setBusy(''); }
  }
  async function retryConnection() { setError(''); setConnection('connecting'); try { await refresh(); } catch (cause) { report(cause); } }
  const goal = state?.goals.find(item => item.id === selectedId) ?? null;
  return {state, capabilities, conversationDrafts, setConversationDrafts, draftWorkspace, setDraftWorkspace, activeWorkspace: activeWorkspace(state), saveWorkspace, selectWorkspace, continueConversation, createChild, connection, stream, selectedId, setSelectedId, goal, thread: selectedId ? threads[selectedId] ?? emptyThread(selectedId) : null, error, clearError: () => setError(''), busy, create, act, edit, reconcile, authenticate, retryConnection, refresh, loadDetail};
}
export type Harness = ReturnType<typeof useHarness>;
