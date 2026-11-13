import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freezeManifest, isEligible, type Qualification } from '../src/benchmark/schedule.js';
import { TrialQueue, summarize } from '../src/benchmark/queue.js';

function qualified(i: number): Qualification {
  return { instanceId: `repo__task-${i}`, repo: `org/repo${i % 5}`, baseCommit: 'a'.repeat(40),
    datasetRevision: 'b'.repeat(40), specCommit: 'c'.repeat(40), failToPass: ['broken'], passToPass: ['stable'],
    base: { completed: true, exitCode: 1, statuses: { broken: 'FAILED', stable: 'PASSED' }, logSha256: 'd'.repeat(64) },
    oracle: { completed: true, exitCode: 0, statuses: { broken: 'PASSED', stable: 'PASSED' }, logSha256: 'e'.repeat(64) },
    environmentDigest: 'f'.repeat(64), qualifiedAt: '2026-11-12T00:00:00.000Z' };
}
const records = Array.from({ length: 50 }, (_, i) => qualified(i));
const freeze = (rows = records) => freezeManifest(rows, { experimentId: 'qualification-test', providerEpoch: 'epoch-1', createdAt: '2026-11-12T00:00:00.000Z' });

describe('qualification and frozen schedule', () => {
  it('requires observed base failures, regression passes and oracle passes', () => {
    expect(isEligible(qualified(1))).toBe(true);
    expect(isEligible({ ...qualified(1), oracle: { ...qualified(1).oracle, completed: false } })).toBe(false);
    expect(isEligible({ ...qualified(1), base: { ...qualified(1).base, statuses: { broken: 'ERROR', stable: 'PASSED' } } })).toBe(true);
    expect(isEligible({ ...qualified(1), base: { ...qualified(1).base, statuses: { broken: 'SKIPPED', stable: 'PASSED' } } })).toBe(false);
    expect(isEligible({ ...qualified(1), oracle: { ...qualified(1).oracle, statuses: { broken: 'PASSED' } } })).toBe(false);
  });
  it('refuses to freeze fewer than 30 actually qualified tasks', () => {
    expect(() => freeze(records.slice(0, 29))).toThrow(/30/);
    expect(() => freeze(records.map(r => ({ ...r, oracle: { ...r.oracle, completed: false } })))).toThrow(/30/);
  });
  it('has disjoint 24 test / 6 dev, 144 pending trials, reproducible despite input order', () => {
    const first = freeze();
    expect(first).toEqual(freeze([...records].reverse()));
    expect(first.testTasks).toHaveLength(24);
    expect(first.devTasks).toHaveLength(6);
    expect(first.trials).toHaveLength(144);
    const dev = new Set(first.devTasks.map(t => t.instanceId));
    expect(first.testTasks.some(t => dev.has(t.instanceId))).toBe(false);
    expect(new Set(first.testTasks.map(t => t.repo)).size).toBe(5);
    for (let i = 0; i < first.trials.length; i += 3) {
      const block = first.trials.slice(i, i + 3);
      expect(new Set(block.map(t => t.instanceId)).size).toBe(1);
      expect(new Set(block.map(t => t.repeat)).size).toBe(1);
      expect(new Set(block.map(t => t.harness)).size).toBe(3);
      expect(block.every(t => t.status === 'pending')).toBe(true);
    }
  });
  it('rejects duplicate instances and mixed provenance', () => {
    expect(() => freeze([...records, records[0]])).toThrow(/duplicate/);
    expect(() => freeze([ { ...records[0], datasetRevision: '9'.repeat(40) }, ...records.slice(1) ])).toThrow(/revision/);
  });
});

describe('durable trial budgets and honest outcomes', () => {
  it('retains calls/tokens/active time across reopen and two infrastructure resumes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'benchmark-'));
    try {
      let queue = new TrialQueue(join(dir, 'queue.db'), freeze());
      const trial = queue.claimNext()!;
      queue.reserveCall(trial.id, 'request-1', 100, 100);
      queue.settleCall('request-1', { inputTokens: 80, outputTokens: 20, reasoningTokens: 10 });
      queue.addActiveMs(trial.id, 5000);
      queue.close();
      queue = new TrialQueue(join(dir, 'queue.db'), freeze());
      queue.recoverInterrupted();
      queue.resumeInfrastructure(trial.id);
      expect(queue.claimNext()!.id).toBe(trial.id);
      expect(queue.get(trial.id)!.usage).toEqual({ calls: 1, inputTokens: 80, outputTokens: 30, activeMs: 5000 });
      queue.recoverInterrupted(); queue.resumeInfrastructure(trial.id); queue.claimNext();
      queue.recoverInterrupted();
      expect(() => queue.resumeInfrastructure(trial.id)).toThrow(/restart/);
      queue.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('never blindly replays an unsettled model call', () => {
    const queue = new TrialQueue(':memory:', freeze());
    const trial = queue.claimNext()!;
    queue.reserveCall(trial.id, 'uncertain', 100, 100);
    queue.recoverInterrupted();
    expect(() => queue.resumeInfrastructure(trial.id)).toThrow(/unsettled/);
    expect(queue.get(trial.id)!.usage.calls).toBe(1);
    queue.close();
  });
  it('counts auxiliary/retry calls and stops at the cumulative call ceiling', () => {
    const queue = new TrialQueue(':memory:', freeze());
    const trial = queue.claimNext()!;
    for (let i = 0; i < 20; i++) {
      queue.reserveCall(trial.id, `retry-${i}`, 1, 1);
      queue.settleCall(`retry-${i}`, { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 });
    }
    expect(() => queue.reserveCall(trial.id, 'retry-21', 1, 1)).toThrow(/budget/);
    queue.close();
  });
  it('does not report success for pending, agent-exited, or incomplete-evaluation tasks', () => {
    const queue = new TrialQueue(':memory:', freeze());
    const trial = queue.list()[0];
    expect(() => queue.finishEvaluation(trial.id, { completed: true, resolved: true, evidenceSha256: 'a'.repeat(64) })).toThrow();
    expect(summarize(queue.list()).pending).toBe(144);
    queue.claimNext(); queue.finishAgent(trial.id, 0, 'b'.repeat(64));
    expect(summarize(queue.list()).resolved).toBe(0);
    queue.beginEvaluation(trial.id);
    queue.finishEvaluation(trial.id, { completed: false, resolved: true, evidenceSha256: 'a'.repeat(64) });
    expect(queue.get(trial.id)!.status).toBe('evaluation-incomplete');
    expect(summarize(queue.list()).resolved).toBe(0);
    expect(() => queue.beginEvaluation(trial.id)).toThrow();
    queue.close();
  });
  it('binds resume to the original frozen provider epoch and schedule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'benchmark-'));
    try {
      const path = join(dir, 'queue.db');
      new TrialQueue(path, freeze()).close();
      expect(() => new TrialQueue(path, { ...freeze(), providerEpoch: 'changed' })).toThrow(/manifest/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('durable observation summaries',()=>{
 it('retains nullable metric provenance without changing score or charged budgets',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ernie-observation-queue-'));const manifest=freeze();let queue=new TrialQueue(join(dir,'queue.db'),manifest);
  try{const trial=queue.claimNext()!;const usage={...trial.usage};const observation={receiptPath:join(dir,'receipt.json'),receiptSha256:'a'.repeat(64),providerComplete:true,toolCalls:null,toolFailures:null,toolMetricsComplete:false,toolMetricsSource:'DSH native event schema unavailable'};
   queue.recordObservation(trial.id,observation);expect(queue.get(trial.id)).toMatchObject({status:'running',usage,observation});queue.close();queue=new TrialQueue(join(dir,'queue.db'),manifest);expect(queue.get(trial.id)?.observation).toEqual(observation);
   expect(()=>queue.recordObservation(trial.id,{...observation,toolCalls:0,toolFailures:0})).toThrow();
   expect(()=>queue.recordObservation(trial.id,{...observation,toolCalls:1,toolFailures:2,toolMetricsComplete:true})).toThrow();
   queue.recordObservation(trial.id,{...observation,toolCalls:2,toolFailures:1,toolMetricsComplete:true,toolMetricsSource:'native-tool-completion-events'});expect(queue.get(trial.id)?.observation?.toolFailures).toBe(1);expect(queue.get(trial.id)?.usage).toEqual(usage);
  }finally{queue.close();rmSync(dir,{recursive:true,force:true});}
 });
});
