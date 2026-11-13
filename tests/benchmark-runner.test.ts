import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freezeManifest, type Qualification } from '../src/benchmark/schedule.js';
import { developmentManifest, freezeDevelopment } from '../src/benchmark/development.js';
import { TrialQueue, type Trial } from '../src/benchmark/queue.js';
import { prepareFormalExperiment, runFormalLoop, providerEpoch, type RouteMetadata, type TuningFreeze } from '../src/benchmark/runner.js';

const hash = (n: number, width = 64): string => n.toString(16).padStart(width, '0');
const records = (count: number): Qualification[] => Array.from({ length: count }, (_, i) => ({
  instanceId: `repo__task-${i}`, repo: `repo-${i % 3}/project`, baseCommit: hash(i + 1, 40),
  datasetRevision: hash(41, 40), specCommit: hash(42, 40), failToPass: [`test-${i}`], passToPass: [],
  base: { completed: true, exitCode: 1, statuses: { [`test-${i}`]: 'FAILED' }, logSha256: hash(i + 101) },
  oracle: { completed: true, exitCode: 0, statuses: { [`test-${i}`]: 'PASSED' }, logSha256: hash(i + 201) },
  environmentDigest: hash(i + 301), qualifiedAt: '2026-11-12T00:00:00Z',
}));
const route: RouteMetadata = { model: 'baidu/ernie-5.5-flash-preview:free', provider: 'Baidu', tag: 'baidu', checkedAt: '2026-11-12T00:00:00Z', supportedParameters: ['reasoning', 'reasoning_effort'], contextLength: 1000000 };
const seedManifest = freezeManifest(records(30), { experimentId:'offline-test', providerEpoch:providerEpoch(route) });
const offlineTrials = developmentManifest(seedManifest).trials.map(t=>({...t,status:'unresolved',patchSha256:hash(1),evidenceSha256:hash(2),infrastructureRestarts:0,usage:{calls:1,inputTokens:1,outputTokens:1,activeMs:1}}) as Trial);
const { tuning, evidence:tuningEvidence } = freezeDevelopment(seedManifest, offlineTrials);
let temp: string;
const directory = (): string => { temp = mkdtempSync(join(tmpdir(), 'formal-runner-')); return temp; };
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); vi.restoreAllMocks(); });

async function prepare(root: string, qualified = records(30), frozen: TuningFreeze = tuning, metadata: RouteMetadata = route) {
  return prepareFormalExperiment({ qualifications: qualified, tuning: frozen, tuningEvidence, route: metadata, experimentId: 'offline-test',
    manifestPath: join(root, 'manifest.json'), queuePath: join(root, 'queue.db'), metadataPath: join(root, 'freeze.json') });
}

describe('formal experiment orchestration', () => {
  it('does not create a frozen manifest or queue before 30 actually eligible tasks', async () => {
    const root = directory();
    await expect(prepare(root, records(29))).rejects.toThrow(/30/);
    expect(() => readFileSync(join(root, 'manifest.json'))).toThrow();
    expect(() => readFileSync(join(root, 'queue.db'))).toThrow();
  });

  it('refuses to claim trials until development tuning is explicitly frozen', async () => {
    const root = directory();
    await expect(prepare(root, records(30), { status: 'pending', settings: {} })).rejects.toThrow(/tuning/i);
    expect(() => readFileSync(join(root, 'manifest.json'))).toThrow();
  });

  it('normalizes provider epoch without checkedAt and rejects drift when reopening', async () => {
    const root = directory();
    const first = await prepare(root);
    const second = await prepareFormalExperiment({
      qualifications: records(30), tuning, tuningEvidence, route: { ...route, checkedAt: '2026-11-13T00:00:00Z' },
      experimentId: 'offline-test', manifestPath: join(root, 'manifest.json'), queuePath: join(root, 'queue.db'), metadataPath: join(root, 'freeze.json'),
    });
    expect(first.manifest.providerEpoch).toBe(second.manifest.providerEpoch);
    first.queue.close(); second.queue.close();
    await expect(prepareFormalExperiment({ qualifications: records(30), tuning, tuningEvidence, route: { ...route, maxCompletionTokens: 8192 },
      experimentId: 'offline-test', manifestPath: join(root, 'manifest.json'), queuePath: join(root, 'queue.db'), metadataPath: join(root, 'freeze.json') })).rejects.toThrow(/epoch|manifest|hash/i);
  });

  it('rejects a context selection without actual development evidence', async () => {
    const root = directory();
    await expect(prepareFormalExperiment({ qualifications: records(30), tuning: { ...tuning, settings: { ...tuning.settings, contextLimit: 128000 } }, route, experimentId: 'offline-test', manifestPath: join(root, 'manifest.json'), queuePath: join(root, 'queue.db'), metadataPath: join(root, 'freeze.json') })).rejects.toThrow(/evidence/);
  });

  it('keeps six requests available for the integration proof', async () => {
    const root = directory();const {manifest,queue}=await prepare(root);let launches=0;const controller=new AbortController();
    const result=await runFormalLoop(queue,{broker:{registerTrial:()=>undefined,snapshot:async()=>({trials:[],quota:{dayRemaining:25,dayResetAt:'2026-11-14T00:00:00Z'}})},adapter:()=>({run:async()=>{launches++;return {exitCode:0,output:''};}}),provision:async()=>({workspace:'/unused',prompt:'unused'}),collectPatch:async()=>hash(1),evaluateOnce:async()=>({completed:true,resolved:false,evidenceSha256:hash(2)}),trialToken:async()=>'trial-token',providerMetadata:async()=>route},{expectedProviderEpoch:manifest.providerEpoch,qualifications:records(30),tuning,reservedRequests:6,statusPath:join(root,'status.json'),reportDir:join(root,'reports'),signal:controller.signal,sleep:async()=>{controller.abort();}});
    expect(result.state).toBe('waiting-quota');expect(launches).toBe(0);expect(queue.list().every(t=>t.status==='pending')).toBe(true);queue.close();
  });

  it('allows an explicit zero reserve after integration and waits below 20 remaining calls, persists quota wait state, and does not launch early', async () => {
    const root = directory();
    const { manifest, queue } = await prepare(root);
    const remaining = [19, 20];
    let registered: string | undefined;
    let launches = 0;
    const sleeps: number[] = [];
    const result = await runFormalLoop(queue, {
      broker: { registerTrial: input => { registered = input.id; }, snapshot: async () => ({ trials: registered ? [{ id: registered, infrastructureRestarts: 0, usage: { calls: 1, inputTokens: 100, outputTokens: 20, activeMs: 5, waitingMs: 0 }, attempts: [] }] : [], quota: { dayRemaining: remaining.shift() ?? 20, dayResetAt: '2026-11-13T00:00:00Z' } }) },
      adapter: () => ({ run: async () => { launches++; return { exitCode: 0, output: '' }; } }),
      provision: async () => ({ workspace: '/tmp/task', prompt: 'task' }), collectPatch: async () => hash(1),
      evaluateOnce: async () => ({ completed: true, resolved: true, evidenceSha256: hash(2) }), trialToken: async () => 'fake-token',
      providerMetadata: async () => route,
    }, { expectedProviderEpoch: manifest.providerEpoch, qualifications: records(30), tuning, reservedRequests: 0, statusPath: join(root, 'status.json'),
      reportDir: join(root, 'reports'), maxTrials: 1, sleep: async ms => { sleeps.push(ms); } });
    expect(launches).toBe(1);
    expect(sleeps).toEqual([60000]);
    expect(JSON.parse(readFileSync(join(root, 'status.json'), 'utf8')).state).toBe('running');
    expect(result.launched).toBe(1);
    expect(queue.list().filter(t => t.status === 'resolved')).toHaveLength(1);
    queue.close();
  });

  it('caps quota polling sleep at 60 seconds and reports interruption without claiming a trial', async () => {
    const root = directory();
    const { manifest, queue } = await prepare(root);
    const result = await runFormalLoop(queue, {
      broker: { registerTrial: () => undefined, snapshot: async () => ({ trials: [], quota: { dayRemaining: 0, dayResetAt: '2026-11-13T00:00:00Z' } }) },
      adapter: () => { throw new Error('must not start'); }, provision: async () => ({ workspace: '/tmp/task', prompt: 'task' }),
      collectPatch: async () => hash(1), evaluateOnce: async () => ({ completed: true, resolved: true, evidenceSha256: hash(2) }),
      trialToken: async () => 'fake-token', providerMetadata: async () => route,
    }, { expectedProviderEpoch: manifest.providerEpoch, qualifications: records(30), tuning, statusPath: join(root, 'status.json'),
      reportDir: join(root, 'reports'), signal: AbortSignal.abort(), sleep: async () => undefined });
    expect(result.launched).toBe(0);
    expect(queue.list().every(t => t.status === 'pending')).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'status.json'), 'utf8')).state).toBe('waiting-quota');
    queue.close();
  });

  it('stops before a model request when the provider epoch drifts', async () => {
    const root = directory();
    const { manifest, queue } = await prepare(root);
    let launches = 0;
    const result = await runFormalLoop(queue, {
      broker: { registerTrial: () => undefined, snapshot: async () => ({ trials: [], quota: { dayRemaining: 50, dayResetAt: '2026-11-13T00:00:00Z' } }) },
      adapter: () => { launches++; return { run: async () => ({ exitCode: 0, output: '' }) }; },
      provision: async () => ({ workspace: '/tmp/task', prompt: 'task' }), collectPatch: async () => hash(1),
      evaluateOnce: async () => ({ completed: true, resolved: true, evidenceSha256: hash(2) }), trialToken: async () => 'fake-token',
      providerMetadata: async () => ({ ...route, maxCompletionTokens: 8192 }),
    }, { expectedProviderEpoch: manifest.providerEpoch, qualifications: records(30), tuning, statusPath: join(root, 'status.json'), reportDir: join(root, 'reports') });
    expect(launches).toBe(0);
    expect(result.state).toBe('provider-epoch-drift');
    expect(queue.list().every(t => t.status === 'pending')).toBe(true);
    queue.close();
  });

  it('leaves an interrupted agent in reconciliation and never replays its model call', async () => {
    const root = directory();
    const { manifest, queue } = await prepare(root);
    const first = queue.claimNext()!;
    queue.recoverInterrupted();
    let launches = 0;
    const result = await runFormalLoop(queue, {
      broker: { registerTrial: () => undefined, snapshot: async () => ({ trials: [], quota: { dayRemaining: 50, dayResetAt: '2026-11-13T00:00:00Z' } }) },
      adapter: () => { launches++; return { run: async () => ({ exitCode: 0, output: '' }) }; },
      provision: async () => ({ workspace: '/tmp/task', prompt: 'task' }), collectPatch: async () => hash(1),
      evaluateOnce: async () => ({ completed: true, resolved: true, evidenceSha256: hash(2) }), trialToken: async () => 'fake-token', providerMetadata: async () => route,
    }, { expectedProviderEpoch: manifest.providerEpoch, qualifications: records(30), tuning, statusPath: join(root, 'status.json'), reportDir: join(root, 'reports') });
    expect(result.state).toBe('needs-reconciliation');
    expect(launches).toBe(0);
    expect(queue.get(first.id)?.status).toBe('needs-reconciliation');
    queue.close();
  });

  it('counts only completed external resolutions in report totals', async () => {
    const root = directory();
    const { manifest, queue } = await prepare(root);
    const trial = queue.claimNext()!;
    queue.finishAgent(trial.id, 0, hash(1));
    queue.beginEvaluation(trial.id);
    queue.finishEvaluation(trial.id, { completed: false, resolved: true, evidenceSha256: hash(2) });
    const outcome = await import('../src/benchmark/runner.js').then(m => m.writeReport(queue, join(root, 'reports')));
    expect(outcome).toBeUndefined();
    const dashboard = JSON.parse(readFileSync(join(root, 'reports', 'dashboard.json'), 'utf8'));
    expect(dashboard.counts['evaluation-incomplete']).toBe(1);
    expect(dashboard.counts.resolved).toBe(0);
    expect(dashboard.pairedBootstrap.resamples).toBe(10000);
    queue.close();
  });
});
