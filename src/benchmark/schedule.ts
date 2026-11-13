import { createHash } from 'node:crypto';
import { DEFAULT_BUDGET, MODEL_ID } from '../contracts/index.js';

export const SEED = 20261112;
export const BASELINE_PINS = {
  dsh: 'e8f7b93a344964de3dca1ace9e72b6e4d6de87cb',
  pi: 'b22e525b325ff1934b4110f7fc60426fd6f0a8f3',
} as const;
export type HarnessName = 'ernie' | 'dsh' | 'pi';
export interface TestObservation {
  completed: boolean; exitCode: number; statuses: Record<string, string>; logSha256: string;
}
export interface Qualification {
  instanceId: string; repo: string; baseCommit: string; datasetRevision: string; specCommit: string;
  failToPass: string[]; passToPass: string[]; base: TestObservation; oracle: TestObservation;
  environmentDigest: string; qualifiedAt: string;
}
export interface FrozenTask {
  instanceId: string; repo: string; baseCommit: string; qualificationSha256: string;
}
export interface ScheduledTrial {
  id: string; instanceId: string; harness: HarnessName; repeat: number; block: string; contextLimit?: number; status: 'pending';
}
export interface Manifest {
  schemaVersion: 1; phase?: 'development'; experimentId: string; createdAt: string; seed: number; model: typeof MODEL_ID;
  providerEpoch: string; datasetRevision: string; specCommit: string; baselinePins: typeof BASELINE_PINS;
  limits: typeof DEFAULT_BUDGET; maxInfrastructureRestarts: 2; globalRPM: 10; defaultDailyQuota: 50;
  testTasks: FrozenTask[]; devTasks: FrozenTask[]; trials: ScheduledTrial[];
}
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = (s: string, length: number): boolean => new RegExp(`^[a-f0-9]{${length}}$`).test(s);

export function isEligible(q: Qualification): boolean {
  return q.failToPass.length > 0 && new Set([...q.failToPass, ...q.passToPass]).size === q.failToPass.length + q.passToPass.length
    && sha(q.baseCommit, 40) && sha(q.datasetRevision, 40) && sha(q.specCommit, 40)
    && sha(q.environmentDigest, 64) && sha(q.base.logSha256, 64) && sha(q.oracle.logSha256, 64)
    && q.base.completed && q.oracle.completed && q.base.exitCode !== 0 && q.oracle.exitCode === 0
    && q.failToPass.every(id => ['FAILED', 'ERROR'].includes(q.base.statuses[id]) && q.oracle.statuses[id] === 'PASSED')
    && q.passToPass.every(id => q.base.statuses[id] === 'PASSED' && q.oracle.statuses[id] === 'PASSED');
}
function ordered<T>(values: T[], label: string, key: (x: T) => string): T[] {
  return [...values].sort((a, b) => {
    const left = digest([SEED, label, key(a)]), right = digest([SEED, label, key(b)]);
    return left < right ? -1 : left > right ? 1 : key(a).localeCompare(key(b));
  });
}
// Balanced repository strata. Every nonempty repo contributes once per round.
function stratified(rows: Qualification[], count: number, label: string): Qualification[] {
  const repos = ordered([...new Set(rows.map(q => q.repo))], label, x => x);
  const buckets = new Map(repos.map(repo => [repo, ordered(rows.filter(q => q.repo === repo), label + repo, q => q.instanceId)]));
  const selected: Qualification[] = [];
  while (selected.length < count) {
    for (const repo of repos) {
      const task = buckets.get(repo)!.shift();
      if (task) selected.push(task);
      if (selected.length === count) break;
    }
  }
  return selected;
}
export function freezeManifest(records: Qualification[], options: { experimentId: string; providerEpoch: string; createdAt?: string }): Manifest {
  if (!options.experimentId || !options.providerEpoch) throw new Error('experiment and provider epoch required');
  if (new Set(records.map(q => q.instanceId)).size !== records.length) throw new Error('duplicate instance IDs');
  const eligible = records.filter(isEligible);
  if (eligible.length < 30) throw new Error(`need 30 actually qualified tasks; observed ${eligible.length}`);
  if (new Set(eligible.map(q => q.datasetRevision)).size !== 1 || new Set(eligible.map(q => q.specCommit)).size !== 1)
    throw new Error('mixed dataset/spec revision');
  const selected = stratified(eligible, 30, 'sample');
  const dev = stratified(selected, 6, 'dev');
  const devIds = new Set(dev.map(q => q.instanceId));
  const test = selected.filter(q => !devIds.has(q.instanceId));
  const blocks = ordered(test.flatMap(q => [0, 1].map(repeat => ({ q, repeat }))), 'blocks', b => `${b.q.instanceId}:${b.repeat}`);
  const trials: ScheduledTrial[] = blocks.flatMap(({ q, repeat }) => {
    const block = `${q.instanceId}:${repeat}`;
    return ordered<HarnessName>(['ernie', 'dsh', 'pi'], block, x => x).map(harness => ({
      id: `trial-${digest([options.experimentId, block, harness]).slice(0, 40)}`, instanceId: q.instanceId, harness, repeat, block, status: 'pending',
    }));
  });
  const publicTask = (q: Qualification): FrozenTask => ({ instanceId: q.instanceId, repo: q.repo, baseCommit: q.baseCommit, qualificationSha256: digest(q) });
  return { schemaVersion: 1, experimentId: options.experimentId, createdAt: options.createdAt ?? new Date().toISOString(), seed: SEED,
    model: MODEL_ID, providerEpoch: options.providerEpoch, datasetRevision: eligible[0].datasetRevision, specCommit: eligible[0].specCommit,
    baselinePins: BASELINE_PINS, limits: { ...DEFAULT_BUDGET }, maxInfrastructureRestarts: 2, globalRPM: 10, defaultDailyQuota: 50,
    testTasks: test.map(publicTask), devTasks: dev.map(publicTask), trials };
}
