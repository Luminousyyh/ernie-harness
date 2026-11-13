import { DatabaseSync } from 'node:sqlite';
import type { Manifest, ScheduledTrial } from './schedule.js';
import { digest } from './schedule.js';
import { DEFAULT_BUDGET } from '../contracts/index.js';

export type TrialStatus = 'pending' | 'running' | 'needs-reconciliation' | 'awaiting-evaluation' | 'evaluating' | 'resolved' | 'unresolved' | 'evaluation-incomplete' | 'infrastructure-failed';
export interface TrialObservation {receiptPath:string;receiptSha256:string;providerComplete:boolean;toolCalls:number|null;toolFailures:number|null;toolMetricsComplete:boolean;toolMetricsSource:string}
export interface Trial extends Omit<ScheduledTrial, 'status'> {
  status: TrialStatus; infrastructureRestarts: number;
  usage: { calls: number; inputTokens: number; outputTokens: number; activeMs: number };
  agentExitCode?: number; patchSha256?: string; evidenceSha256?: string; observation?:TrialObservation;
}
interface Reservation { request_id: string; trial_id: string; input_tokens: number; output_tokens: number; settled: number }
const integer = (x: number): void => { if (!Number.isSafeInteger(x) || x < 0) throw new Error('usage must be a nonnegative integer'); };
export class TrialQueue {
  private readonly db: DatabaseSync;
  readonly phase: 'formal' | 'development';
  constructor(path: string, manifest: Manifest) {
    this.phase = manifest.phase ?? 'formal';
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trials (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, trial_id TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0);`);
    try {
      this.transaction(() => {
        const previous = this.db.prepare("SELECT value FROM meta WHERE key='manifest'").get() as { value: string } | undefined;
        if (previous && previous.value !== digest(manifest)) throw new Error('frozen manifest differs; use a new experiment database');
        if (!previous) {
          const validTrials = manifest.phase === 'development'
            ? manifest.trials.length === 18 && new Set(manifest.trials.map(t=>t.id)).size === 18 && manifest.devTasks.every(d=>[0,1,2].every(repeat=>manifest.trials.filter(t=>t.instanceId===d.instanceId&&t.repeat===repeat&&t.harness==='ernie'&&t.contextLimit===[64000,128000,256000][repeat]).length===1))
            : manifest.trials.length === 144;
          if (!validTrials || manifest.testTasks.length !== 24 || manifest.devTasks.length !== 6)
            throw new Error('expected the frozen 144-trial schema');
          this.db.prepare('INSERT INTO meta VALUES (?, ?)').run('manifest', digest(manifest));
          const insert = this.db.prepare('INSERT INTO trials VALUES (?, ?, ?)');
          manifest.trials.forEach((trial, ordinal) => insert.run(trial.id, ordinal, JSON.stringify({ ...trial, status: 'pending', infrastructureRestarts: 0, usage: { calls: 0, inputTokens: 0, outputTokens: 0, activeMs: 0 } })));
        }
      });
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private save(trial: Trial): void { this.db.prepare('UPDATE trials SET data=? WHERE id=?').run(JSON.stringify(trial), trial.id); }
  get(id: string): Trial | undefined {
    const row = this.db.prepare('SELECT data FROM trials WHERE id=?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Trial : undefined;
  }
  private require(id: string, status?: TrialStatus): Trial {
    const trial = this.get(id);
    if (!trial || (status && trial.status !== status)) throw new Error(`trial ${id}: expected ${status ?? 'existing trial'}`);
    return trial;
  }
  list(): Trial[] { return (this.db.prepare('SELECT data FROM trials ORDER BY ordinal').all() as { data: string }[]).map(r => JSON.parse(r.data) as Trial); }
  recordObservation(id:string,observation:TrialObservation):void {
    if(!observation||typeof observation.receiptPath!=='string'||!observation.receiptPath||/[\r\n\0]/.test(observation.receiptPath)||!/^[a-f0-9]{64}$/.test(observation.receiptSha256)||typeof observation.providerComplete!=='boolean'||typeof observation.toolMetricsComplete!=='boolean'||typeof observation.toolMetricsSource!=='string'||observation.toolMetricsSource.length>1024)throw new Error('invalid observation metadata');
    if(observation.toolMetricsComplete){
      const calls=observation.toolCalls,failures=observation.toolFailures;
      if(typeof calls!=='number'||typeof failures!=='number'||!Number.isSafeInteger(calls)||!Number.isSafeInteger(failures)||calls<0||failures<0||failures>calls)throw new Error('invalid tool metric counts');
    }else if(observation.toolCalls!==null||observation.toolFailures!==null)throw new Error('unknown tool metrics must stay null');
    this.transaction(()=>{const trial=this.require(id);trial.observation={...observation};this.save(trial);});
  }
  claimNext(): Trial | undefined {
    return this.transaction(() => {
      const all = this.list();
      if (all.some(t => ['running', 'evaluating', 'needs-reconciliation', 'awaiting-evaluation'].includes(t.status))) return undefined;
      const trial = all.find(t => t.status === 'pending');
      if (trial) { trial.status = 'running'; this.save(trial); }
      return trial;
    });
  }
  recoverInterrupted(): void {
    this.transaction(() => {
      for (const trial of this.list()) {
        if (trial.status === 'running') { trial.status = 'needs-reconciliation'; this.save(trial); }
        // A final evaluation may have already consumed the one permitted observation.
        else if (trial.status === 'evaluating') { trial.status = 'evaluation-incomplete'; this.save(trial); }
      }
    });
  }
  resumeInfrastructure(id: string): void {
    this.transaction(() => {
      const trial = this.require(id, 'needs-reconciliation');
      if (this.db.prepare('SELECT 1 FROM requests WHERE trial_id=? AND settled=0').get(id)) throw new Error('unsettled request requires broker reconciliation');
      if (trial.infrastructureRestarts >= 2) throw new Error('infrastructure restart limit exhausted');
      this.checkBudget(trial, 0, 0, 0);
      trial.infrastructureRestarts++; trial.status = 'pending'; this.save(trial);
    });
  }
  private checkBudget(t: Trial, calls: number, input: number, output: number): void {
    if (t.usage.calls + calls > DEFAULT_BUDGET.maxCalls || t.usage.inputTokens + input > DEFAULT_BUDGET.maxInputTokens
      || t.usage.outputTokens + output > DEFAULT_BUDGET.maxOutputTokens || t.usage.activeMs >= DEFAULT_BUDGET.maxActiveMs)
      throw new Error('cumulative trial budget exhausted');
  }
  reserveCall(id: string, requestId: string, estimatedInput: number, maxOutput: number): void {
    integer(estimatedInput); integer(maxOutput);
    if (!requestId || maxOutput < 1 || maxOutput > DEFAULT_BUDGET.maxOutputPerCall) throw new Error('invalid per-call output budget');
    this.transaction(() => {
      const trial = this.require(id, 'running');
      this.checkBudget(trial, 1, estimatedInput, maxOutput);
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, 0)').run(requestId, id, estimatedInput, maxOutput);
      trial.usage.calls++; trial.usage.inputTokens += estimatedInput; trial.usage.outputTokens += maxOutput;
      this.save(trial);
    });
  }
  // outputTokens here EXCLUDES reasoning; provider usage total must be normalized by broker.
  settleCall(requestId: string, actual: { inputTokens: number; outputTokens: number; reasoningTokens: number }): void {
    Object.values(actual).forEach(integer);
    this.transaction(() => {
      const r = this.db.prepare('SELECT * FROM requests WHERE request_id=?').get(requestId) as unknown as Reservation | undefined;
      if (!r || r.settled) throw new Error('unknown or already settled request');
      const t = this.require(r.trial_id);
      t.usage.inputTokens += actual.inputTokens - r.input_tokens;
      t.usage.outputTokens += actual.outputTokens + actual.reasoningTokens - r.output_tokens;
      this.db.prepare('UPDATE requests SET settled=1 WHERE request_id=?').run(requestId);
      this.save(t);
    });
  }
  addActiveMs(id: string, delta: number): void {
    integer(delta);
    this.transaction(() => { const t = this.require(id, 'running'); t.usage.activeMs += delta; this.save(t); });
  }
  finishAgent(id: string, exitCode: number, patchSha256: string): void {
    if (!/^[a-f0-9]{64}$/.test(patchSha256)) throw new Error('final patch digest required');
    this.transaction(() => {
      const t = this.require(id, 'running');
      if (this.db.prepare('SELECT 1 FROM requests WHERE trial_id=? AND settled=0').get(id)) throw new Error('unsettled usage');
      t.agentExitCode = exitCode; t.patchSha256 = patchSha256; t.status = 'awaiting-evaluation'; this.save(t);
    });
  }
  beginEvaluation(id: string): void {
    this.transaction(() => { const t = this.require(id, 'awaiting-evaluation'); t.status = 'evaluating'; this.save(t); });
  }
  finishEvaluation(id: string, result: { completed: boolean; resolved: boolean; evidenceSha256: string }): void {
    if (!/^[a-f0-9]{64}$/.test(result.evidenceSha256)) throw new Error('external evaluation evidence digest required');
    this.transaction(() => {
      const t = this.require(id, 'evaluating');
      t.evidenceSha256 = result.evidenceSha256;
      t.status = result.completed ? result.resolved ? 'resolved' : 'unresolved' : 'evaluation-incomplete';
      this.save(t);
    });
  }
  failInfrastructure(id: string): void {
    this.transaction(() => {
      const t = this.require(id);
      if (!['running', 'needs-reconciliation'].includes(t.status)) throw new Error('cannot replace a final outcome');
      t.status = 'infrastructure-failed'; this.save(t);
    });
  }
  adoptBrokerSnapshot(id: string, snapshot: { usage: { calls: number; inputTokens: number; outputTokens: number; activeMs: number }; infrastructureRestarts: number; attempts: { status: string }[] }, activeMs: number): void {
    Object.values(snapshot.usage).forEach(integer); integer(activeMs); integer(snapshot.infrastructureRestarts);
    this.transaction(() => {
      const t = this.require(id);
      if (!['running', 'needs-reconciliation'].includes(t.status)) throw new Error('cannot update final trial usage');
      if (snapshot.infrastructureRestarts > 2) throw new Error('broker restart ceiling exceeded');
      for (const key of ['calls', 'inputTokens', 'outputTokens'] as const) {
        if (snapshot.usage[key] < t.usage[key]) throw new Error('broker usage would reset cumulative budget');
        t.usage[key] = snapshot.usage[key];
      }
      t.usage.activeMs = Math.max(t.usage.activeMs, activeMs, snapshot.usage.activeMs);
      t.infrastructureRestarts = Math.max(t.infrastructureRestarts, snapshot.infrastructureRestarts);
      if (snapshot.attempts.some(a => ['received', 'reserved', 'dispatched', 'uncertain'].includes(a.status))) t.status = 'needs-reconciliation';
      this.save(t);
    });
  }
  close(): void { this.db.close(); }
}
export function summarize(trials: Trial[]): Record<TrialStatus | 'total', number> {
  const counts = { total: trials.length, pending: 0, running: 0, 'needs-reconciliation': 0, 'awaiting-evaluation': 0,
    evaluating: 0, resolved: 0, unresolved: 0, 'evaluation-incomplete': 0, 'infrastructure-failed': 0 };
  for (const t of trials) counts[t.status]++;
  return counts;
}
export function exportResults(trials: Trial[]): { jsonl: string; csv: string; counts: ReturnType<typeof summarize> } {
  const fields = ['id', 'instanceId', 'harness', 'repeat', 'contextLimit', 'status', 'calls', 'inputTokens', 'outputTokens', 'activeMs', 'infrastructureRestarts','toolCalls','toolFailures','toolMetricsComplete','observationSha256'];
  const cell = (v: unknown): string => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return { jsonl: trials.map(t => JSON.stringify(t)).join('\n') + '\n',
    csv: [fields.join(','), ...trials.map(t => fields.map(k => cell(({ ...t, ...t.usage,toolCalls:t.observation?.toolCalls,toolFailures:t.observation?.toolFailures,toolMetricsComplete:t.observation?.toolMetricsComplete,observationSha256:t.observation?.receiptSha256 } as Record<string, unknown>)[k])).join(','))].join('\n') + '\n',
    counts: summarize(trials) };
}
