import {captureTrialObservation} from './observations.js';
import {renderReport} from './report.js';
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { BenchmarkAdapter, Budget } from '../contracts/index.js';
import { DEFAULT_BUDGET, MODEL_ID } from '../contracts/index.js';
import { freezeManifest, digest, isEligible, type Manifest, type HarnessName, type Qualification } from './schedule.js';
import { CONTEXT_LIMITS, developmentManifest, freezeDevelopment, verifyDevelopmentEvidence, type DevelopmentEvidence } from './development.js';
import { TrialQueue, exportResults, type Trial } from './queue.js';

export interface BrokerTrialSnapshot {
  id: string; infrastructureRestarts: number;
  usage: { calls: number; inputTokens: number; outputTokens: number; activeMs: number; waitingMs?: number };
  attempts: { id?:string; status: string; receivedAt?: number; dispatchAt?: number; waitingMs?: number }[];
  modelReportedID?: string;
}
export interface TrustedBroker {
  registerTrial(input: { id: string; token: string; budget?: Partial<Budget> }): unknown;
  snapshot(): Promise<{ trials: BrokerTrialSnapshot[]; quota?: { dayRemaining: number; dayResetAt: string } }>;
}
/** An uncompleted proxy invocation is infrastructure evidence, not a scored model trial. */
export function assertObservableModelTrial(status:string,snapshot:Pick<BrokerTrialSnapshot,'attempts'>,providerComplete:boolean):void {
  const completed=snapshot.attempts.some(attempt=>attempt.status==='completed');
  if(completed&&!providerComplete)throw new Error('Completed model response has incomplete trajectory evidence');
  if(status==='running'&&!completed)throw new Error('No completed live-model response: trial is an infrastructure observation, not a model score');
}
export interface TrialHooks {
  broker: TrustedBroker;
  adapter(harness: HarnessName): BenchmarkAdapter;
  provision(trial: Trial): Promise<{ workspace: string; prompt: string }>;
  collectPatch(trial: Trial, workspace: string): Promise<string>;
  evaluateOnce(trial: Trial): Promise<{ completed: boolean; resolved: boolean; evidenceSha256: string }>;
  trialToken(trial: Trial): Promise<string>;
  signal?: AbortSignal;
  now?: () => number;
  onSnapshot?(snapshot: BrokerTrialSnapshot): Promise<void>;
}
export interface RouteMetadata {
  model: string; provider: string; tag: string; checkedAt?: string;
  supportedParameters: string[]; contextLength?: number; maxCompletionTokens?: number; modelReportedID?: string;
}
export interface TuningFreeze {
  status: 'pending' | 'frozen'; settings: Record<string, unknown>; evidenceSha256?: string; devTasks?: string[];
}
function normalizedRoute(route: RouteMetadata): object {
  if (route.model !== MODEL_ID || route.provider !== 'Baidu' || route.tag !== 'baidu') throw new Error('exact free Baidu route required');
  return { model: route.model, provider: route.provider, tag: route.tag, supportedParameters: [...new Set(route.supportedParameters)].sort(),
    contextLength: route.contextLength ?? null, maxCompletionTokens: route.maxCompletionTokens ?? null };
}
export const providerEpoch = (route: RouteMetadata): string => digest(normalizedRoute(route));
function requireTuning(tuning: TuningFreeze): void {
  if (tuning.status !== 'frozen' || !/^[a-f0-9]{64}$/.test(tuning.evidenceSha256 ?? '')) throw new Error('development tuning pending; frozen settings and evidence required');
  // Current adapters implement exactly these settings. Do not pretend arbitrary tuning was applied.
  if (tuning.settings.strategy !== 'baseline' || tuning.settings.reasoning !== 'high' || Object.keys(tuning.settings).some(k => !['strategy', 'reasoning', 'contextLimit'].includes(k)) || !CONTEXT_LIMITS.includes(tuning.settings.contextLimit as typeof CONTEXT_LIMITS[number]))
    throw new Error('only implemented baseline/high context tuning settings are supported');
}
async function json(path: string): Promise<any> { return JSON.parse(await readFile(path, 'utf8')); }
async function optionalJson(path: string): Promise<any | undefined> { try { return await json(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
export async function prepareFormalExperiment(options: {
  qualifications: Qualification[]; tuning: TuningFreeze; route: RouteMetadata; experimentId: string;
  manifestPath: string; queuePath: string; metadataPath: string; tuningEvidence?: DevelopmentEvidence;
}): Promise<{ manifest: Manifest; queue: TrialQueue }> {
  requireTuning(options.tuning);
  const epoch = providerEpoch(options.route);
  const existing = await optionalJson(options.manifestPath) as Manifest | undefined;
  const candidate = freezeManifest(options.qualifications, { experimentId: options.experimentId, providerEpoch: epoch, ...(existing ? { createdAt: existing.createdAt } : {}) });
  {
    if (!options.tuningEvidence) throw new Error('real development evidence required before formal freeze');
    verifyDevelopmentEvidence(candidate, options.tuning, options.tuningEvidence);
  }
  if (options.tuning.devTasks && digest([...options.tuning.devTasks].sort()) !== digest(candidate.devTasks.map(t => t.instanceId).sort())) throw new Error('tuning development task split differs');
  if (existing && digest(existing) !== digest(candidate)) throw new Error('frozen manifest/provider epoch drift; primary experiment incomplete');
  const prior = await optionalJson(options.metadataPath);
  if (prior && prior.tuningSha256 !== digest(options.tuning)) throw new Error('frozen development tuning changed');
  if (!existing) await atomicJson(options.manifestPath, candidate);
  if (!prior) await atomicJson(options.metadataPath, { providerEpoch: epoch, provider: normalizedRoute(options.route),
    modelReportedID: options.route.modelReportedID ?? null, tuningSha256: digest(options.tuning), tuning: options.tuning });
  await mkdir(dirname(options.queuePath), { recursive: true, mode: 0o700 });
  return { manifest: candidate, queue: new TrialQueue(options.queuePath, candidate) };
}

/** One durable trial. Unknown effects require operator reconciliation; no implicit retry. */
export async function runNextTrial(queue: TrialQueue, hooks: TrialHooks): Promise<Trial | undefined> {
  const awaiting = queue.list().find(t => t.status === 'awaiting-evaluation');
  if (awaiting) return evaluateTrial(queue, hooks, awaiting);
  if (hooks.signal?.aborted) return undefined;
  const trial = queue.claimNext();
  if (!trial) return undefined;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  hooks.signal?.addEventListener('abort', abort, { once: true });
  const now = hooks.now ?? (() => performance.now());
  let started: number | undefined, previousWaiting = 0, heartbeat: ReturnType<typeof setInterval> | undefined;
  let chain = Promise.resolve(), heartbeatError: unknown;
  const elapsedActive = (snapshot: BrokerTrialSnapshot): number => {
    // Include a request currently waiting to dispatch; persisted waitingMs only settles at dispatch.
    const inFlightWait = snapshot.attempts.reduce((sum, a) => sum + (['received', 'reserved'].includes(a.status) && a.receivedAt !== undefined ? Math.max(0, Date.now() - a.receivedAt) : 0), 0);
    const wait = Math.max(0, (snapshot.usage.waitingMs ?? 0) + inFlightWait - previousWaiting);
    return trial.usage.activeMs + Math.max(0, Math.ceil(now() - (started ?? now()) - wait));
  };
  const adopt = async (): Promise<void> => {
    const current = queue.get(trial.id)!;
    if (!['running', 'needs-reconciliation'].includes(current.status)) return;
    const snapshot = (await hooks.broker.snapshot()).trials.find(t => t.id === trial.id);
    if (!snapshot) throw new Error('trusted broker lost trial accounting');
    queue.adoptBrokerSnapshot(trial.id, snapshot, elapsedActive(snapshot));
    await hooks.onSnapshot?.(snapshot);
  };
  try {
    const token = await hooks.trialToken(trial);
    await hooks.broker.registerTrial({ id: trial.id, token, budget: DEFAULT_BUDGET });
    const initial = (await hooks.broker.snapshot()).trials.find(t => t.id === trial.id);
    if (!initial) throw new Error('trusted broker lost trial registration');
    previousWaiting = initial.usage.waitingMs ?? 0;
    const prepared = await hooks.provision(trial);
    started = now();
    heartbeat = setInterval(() => {
      chain = chain.then(async () => {
        const snapshot = (await hooks.broker.snapshot()).trials.find(t => t.id === trial.id);
        if (!snapshot) throw new Error('trusted broker lost trial accounting');
        const active = elapsedActive(snapshot), current = queue.get(trial.id)!;
        if (current.status === 'running' && active > current.usage.activeMs) queue.addActiveMs(trial.id, active - current.usage.activeMs);
        if (active >= DEFAULT_BUDGET.maxActiveMs) controller.abort();
      }).catch(error => { heartbeatError = error; controller.abort(); });
    }, 1000);
    const outcome = await hooks.adapter(trial.harness).run({ ...prepared, baseUrl: 'http://127.0.0.1:18080/v1', token, signal: controller.signal });
    clearInterval(heartbeat); heartbeat = undefined; await chain;
    if (heartbeatError) throw heartbeatError;
    await adopt();
    if (queue.get(trial.id)!.status === 'needs-reconciliation') return queue.get(trial.id);
    if (hooks.signal?.aborted) throw new Error('trial interrupted; reconciliation required');
    const patch = await hooks.collectPatch(trial, prepared.workspace);
    queue.finishAgent(trial.id, outcome.exitCode, patch);
    return await evaluateTrial(queue, hooks, queue.get(trial.id)!);
  } catch (error) {
    controller.abort();
    if (heartbeat) clearInterval(heartbeat);
    await chain;
    try { await adopt(); } finally { queue.recoverInterrupted(); }
    throw error;
  } finally { hooks.signal?.removeEventListener('abort', abort); }
}
async function evaluateTrial(queue: TrialQueue, hooks: TrialHooks, trial: Trial): Promise<Trial> {
  queue.beginEvaluation(trial.id);
  try { queue.finishEvaluation(trial.id, await hooks.evaluateOnce(trial)); }
  catch (error) { queue.recoverInterrupted(); throw error; }
  return queue.get(trial.id)!;
}

export interface FormalLoopOptions {
  expectedProviderEpoch: string; qualifications: Qualification[]; tuning: TuningFreeze; statusPath: string; reportDir: string;
  signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; maxTrials?: number; reservedRequests?: number; phase?: 'development';
}
export async function runFormalLoop(queue: TrialQueue, hooks: TrialHooks & { providerMetadata(): Promise<RouteMetadata> }, options: FormalLoopOptions): Promise<{ state: string; launched: number }> {
  if ((options.phase ?? 'formal') !== queue.phase) throw new Error('queue phase mismatch');
  if (options.phase !== 'development') requireTuning(options.tuning);
  const reserve = options.reservedRequests ?? 0;
  if (!Number.isSafeInteger(reserve) || reserve < 0) throw new Error('invalid reserved requests');
  if (options.qualifications.filter(isEligible).length < 30) throw new Error('need 30 eligible tasks');
  queue.recoverInterrupted();
  let launched = 0, state = 'running';
  const status = async (value: string, extra: object = {}): Promise<void> => { state = value; await atomicJson(options.statusPath, { state, launchedThisProcess: launched, updatedAt: new Date().toISOString(), ...extra }); };
  const sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  try {
    while (true) {
      if (queue.list().some(t => t.status === 'needs-reconciliation')) { await status('needs-reconciliation'); break; }
      if (!queue.list().some(t => ['pending', 'awaiting-evaluation'].includes(t.status))) {
        await status(queue.list().every(t => ['resolved', 'unresolved'].includes(t.status)) ? 'complete' : 'incomplete'); break;
      }
      if (providerEpoch(await hooks.providerMetadata()) !== options.expectedProviderEpoch) { await status('provider-epoch-drift'); break; }
      const evaluating = queue.list().some(t => t.status === 'awaiting-evaluation');
      const quota = (await hooks.broker.snapshot()).quota;
      if (!quota || !Number.isSafeInteger(quota.dayRemaining)) throw new Error('trusted global quota snapshot required');
      if (!evaluating && quota.dayRemaining < DEFAULT_BUDGET.maxCalls + reserve) {
        await status('waiting-quota', { remaining: quota.dayRemaining, reservedPerTrial: DEFAULT_BUDGET.maxCalls, reservedRequests: reserve, retryAt: quota.dayResetAt });
        if (options.signal?.aborted) break;
        try { await sleep(60000, options.signal); } catch (error) { if (options.signal?.aborted) break; throw error; }
        continue;
      }
      if (options.signal?.aborted) { await status('interrupted'); break; }
      await status('running');
      const result = await runNextTrial(queue, { ...hooks, signal: options.signal });
      if (!result) { await status('needs-reconciliation'); break; }
      launched++;
      await writeReport(queue, options.reportDir);
      if (launched >= (options.maxTrials ?? Infinity)) break;
    }
  } catch (error) {
    await status(queue.list().some(t => t.status === 'needs-reconciliation') ? 'needs-reconciliation' : 'incomplete');
    throw error;
  } finally { await writeReport(queue, options.reportDir); }
  return { state, launched };
}

/** Paired differences averaged over both repeats, resampling independent task clusters. */
export function pairedBootstrap(trials: Trial[], seed = 20261112): object {
  const comparisons = [];
  let state = seed >>> 0;
  const random = (): number => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  for (const baseline of ['dsh', 'pi'] as const) {
    const values: number[] = [];
    for (const id of new Set(trials.map(t => t.instanceId))) {
      const block = trials.filter(t => t.instanceId === id && ['ernie', baseline].includes(t.harness));
      if (block.length !== 4 || !block.every(t => ['resolved', 'unresolved'].includes(t.status)) || ![0, 1].every(repeat => block.filter(t => t.repeat === repeat).length === 2)) continue;
      values.push(block.reduce((sum, t) => sum + (t.status === 'resolved' ? t.harness === 'ernie' ? 1 : -1 : 0), 0) / 2);
    }
    const samples: number[] = [];
    if (values.length) for (let sample = 0; sample < 10000; sample++) {
      let total = 0;
      for (let i = 0; i < values.length; i++) total += values[Math.floor(random() * values.length)]!;
      samples.push(total / values.length);
    }
    samples.sort((a, b) => a - b);
    comparisons.push({ comparison: `ernie-${baseline}`, pairedTasks: values.length, estimate: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      interval95: samples.length ? [samples[249], samples[9749]] : null });
  }
  return { seed, resamples: 10000, unit: 'task', provisional: trials.some(t => !['resolved', 'unresolved'].includes(t.status)), comparisons };
}
export async function writeReport(queue: TrialQueue, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const trials = queue.list(), result = exportResults(trials);
  const totals = trials.reduce((sum, t) => ({ calls: sum.calls + t.usage.calls, inputTokens: sum.inputTokens + t.usage.inputTokens, outputTokens: sum.outputTokens + t.usage.outputTokens, activeMs: sum.activeMs + t.usage.activeMs }), { calls: 0, inputTokens: 0, outputTokens: 0, activeMs: 0 });
  const dashboard = { phase: queue.phase, counts: result.counts, totals, pairedBootstrap: queue.phase === 'formal' ? pairedBootstrap(trials) : null };
  await writeFile(join(directory, 'results.jsonl'), result.jsonl, { mode: 0o600 });
  await writeFile(join(directory, 'results.csv'), result.csv, { mode: 0o600 });
  await atomicJson(join(directory, 'counts.json'), result.counts);
  await atomicJson(join(directory, 'dashboard.json'), dashboard);
  await writeFile(join(directory, 'summary.md'), renderReport({phase:queue.phase,trials,bootstrap:(dashboard.pairedBootstrap??undefined) as Parameters<typeof renderReport>[0]['bootstrap']}), {mode:0o600});
}
export async function openFrozenQueue(manifestPath: string, queuePath: string): Promise<TrialQueue> {
  return new TrialQueue(queuePath, await json(manifestPath) as Manifest);
}

const execute = promisify(execFile);
const REMOTE_ROOT = '/home/home_new/yaoyh/ernie-harness';
/** CLI coordinates a persistent development queue, then the frozen formal queue.
 * Run without an outer resource guard: every work/evaluation phase acquires the
 * single guard separately, leaving the resource lock free during quota waits.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help')) { process.stdout.write('node --import tsx/esm src/benchmark/runner.ts [--once] [--reserve-requests 6] [--vault PATH]\nRun WITHOUT an outer guard; sequential work phases own eval/resource.lock.\n'); return; }
  if (process.platform !== 'linux') throw new Error('formal evaluation requires Linux');
  const root = REMOTE_ROOT, formal = join(root, 'eval/private/formal');
  const development = join(root, 'eval/private/development');
  await mkdir(formal, { recursive: true, mode: 0o700 }); await mkdir(development, { recursive: true, mode: 0o700 });
  const reserveIndex = argv.indexOf('--reserve-requests');
  const reservedRequests = reserveIndex < 0 ? 6 : Number(argv[reserveIndex + 1]);
  if (!Number.isSafeInteger(reservedRequests) || reservedRequests < 0) throw new Error('reserved requests must be a nonnegative integer');
  const lock = await open(join(formal, 'runner.lock'), 'wx', 0o600);
  await lock.writeFile(String(process.pid)); await lock.sync();
  const controller = new AbortController(); const abort = (): void => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let broker: (TrustedBroker & { listen(): Promise<string>; close(): Promise<void> }) | undefined;
  const queues: TrialQueue[] = [];
  const statusPath = join(formal, 'status.json'), guard = join(root, 'eval/remote-guard.py');
  const python = join(root, 'runtimes/evaluator/bin/python'), script = join(root, 'eval/remote-evaluate.py');
  const pythonJson = async (args: string[]): Promise<any> => {
    // There is no parent guard: agent launches and private evaluator phases are
    // sequential siblings and each owns the shared lock once.
    if (args.includes('--index')) {
      const result = await execute(python,[script,...args],{cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',CUDA_VISIBLE_DEVICES:''},maxBuffer:32*1024*1024,timeout:60000,signal:controller.signal});
      return JSON.parse(result.stdout.trim());
    }
    const command = [guard, '--root', root, '--seconds', '900', '--', python, script, ...args];
    const result = await execute('/usr/bin/python3', command, { cwd: root, env: { PATH:'/usr/bin:/bin', LANG:'C.UTF-8', CUDA_VISIBLE_DEVICES:'', NVIDIA_VISIBLE_DEVICES:'none' }, maxBuffer:32*1024*1024, timeout:930000, signal:controller.signal });
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const receipt = JSON.parse(lines.pop()!);
    if (receipt.resource_guard?.limit || receipt.resource_guard?.exit_code !== 0) throw new Error('private evaluator resource guard failed');
    return JSON.parse(lines.pop()!);
  };
  const wait = async (state: string, extra: object = {}): Promise<boolean> => {
    await atomicJson(statusPath, { state, reservedRequests, updatedAt:new Date().toISOString(), ...extra });
    if (argv.includes('--once') || controller.signal.aborted) return false;
    try { await delay(60000, undefined, { signal:controller.signal }); } catch { return false; }
    return true;
  };
  try {
    let qualifications: Qualification[];
    while (true) {
      qualifications = await pythonJson(['--index']);
      if (qualifications.filter(isEligible).length >= 30) break;
      if (!await wait('waiting-qualification', { eligible:qualifications.filter(isEligible).length, target:30 })) return;
    }
    const { loadApiKey, preflightFreeRoute } = await import('../provider/index.js');
    const metadata = await preflightFreeRoute({signal:controller.signal});
    const manifestPath = join(formal,'manifest.json');
    const existing = await optionalJson(manifestPath) as Manifest | undefined;
    const manifest = freezeManifest(qualifications, {experimentId:'formal-20261112',providerEpoch:providerEpoch(metadata),...(existing ? {createdAt:existing.createdAt} : {})});
    if (existing && digest(existing)!==digest(manifest)) throw new Error('frozen sample/provider epoch changed');
    if (!existing) await atomicJson(manifestPath,manifest);
    const devManifest = developmentManifest(manifest);
    const devPath = join(development,'manifest.json'), priorDev = await optionalJson(devPath);
    if (priorDev && digest(priorDev)!==digest(devManifest)) throw new Error('development plan changed');
    if (!priorDev) await atomicJson(devPath,devManifest);
    const devQueue = new TrialQueue(join(development,'queue.db'),devManifest); queues.push(devQueue);
    // Pending formal records are durable scheduling state, never a tuning claim.
    const formalQueue = new TrialQueue(join(formal,'queue.db'),manifest); queues.push(formalQueue);
    await writeReport(devQueue,join(root,'eval/development')); await writeReport(formalQueue,join(root,'eval/formal'));
    while (await optionalJson(join(formal,'integration-hold.json'))) {
      if (!await wait('waiting-main-integration', {eligible:qualifications.length,developmentTrials:18,formalTrials:144})) return;
    }
    const vaultIndex = argv.indexOf('--vault');
    const key = await loadApiKey({ path:vaultIndex>=0 ? argv[vaultIndex+1] : join(root,'eval/private/credential/openrouter.key'), env:{} });
    if (!key) throw new Error('private runtime credential vault required');
    const { createModelBroker } = await import('../broker/index.js');
    broker = createModelBroker({apiKey:key,stateDir:formal,socketPath:join(root,'eval/private/formal.sock'),quotaPath:join(root,'eval/private/broker/broker-quota.json')});
    await broker.listen();
    const { SandboxedBenchmarkAdapter } = await import('./adapters.js');
    const affinity = await execute('/usr/bin/python3',['-c','import os,json; print(json.dumps(sorted(os.sched_getaffinity(0))))']);
    const cpus = (JSON.parse(affinity.stdout) as number[]).slice(0,8);
    if (cpus.length!==8) throw new Error('eight CPUs required');
    const makeHooks = (isDevelopment:boolean, tuning?:TuningFreeze): TrialHooks & {providerMetadata():Promise<RouteMetadata>} => {
      let contextLimit = Number(tuning?.settings.contextLimit ?? 128000);
      const trialDirectory = (trial:Trial):string => join(root,'eval/trials',trial.id);
      const patchPath = (trial:Trial):string => join(formal,'patches',trial.id+'.diff');
      return {
        broker:broker!, providerMetadata:()=>preflightFreeRoute({signal:controller.signal}),
        adapter:name=>new SandboxedBenchmarkAdapter(name,{root,brokerSocket:join(root,'eval/private/formal.sock'),cpus,contextLimit}),
        trialToken:async trial=>{const path=join(formal,'tokens',trial.id+'.json'), previous=await optionalJson(path); if(previous)return previous.token;const token='trial-'+randomUUID();await atomicJson(path,{token});return token;},
        provision:async trial=>{
          contextLimit = isDevelopment ? trial.contextLimit! : Number(tuning!.settings.contextLimit);
          const task = (isDevelopment ? manifest.devTasks : manifest.testTasks).find(t=>t.instanceId===trial.instanceId)!;
          return pythonJson(['--prepare','--instance',trial.instanceId,'--trialdir',trialDirectory(trial),'--qualification-sha256',task.qualificationSha256]);
        },
        collectPatch:async trial=>{
          const task=(isDevelopment?manifest.devTasks:manifest.testTasks).find(t=>t.instanceId===trial.instanceId)!;
          const result=await pythonJson(['--collect-patch','--instance',trial.instanceId,'--patch',patchPath(trial),'--trialdir',trialDirectory(trial),'--qualification-sha256',task.qualificationSha256]);
          return result.patchSha256;
        },
        evaluateOnce:trial=>{
          const task=(isDevelopment?manifest.devTasks:manifest.testTasks).find(t=>t.instanceId===trial.instanceId)!;
          return pythonJson(['--instance',trial.instanceId,'--patch',patchPath(trial),'--trialdir',trialDirectory(trial),'--qualification-sha256',task.qualificationSha256]);
        },
        onSnapshot:async snapshot=>{
          await atomicJson(join(formal,'broker-snapshots',snapshot.id+'.json'),snapshot);
          const queue=isDevelopment?devQueue:formalQueue;const trial=queue.get(snapshot.id);if(!trial)throw new Error('observation trial missing');
          const observation=await captureTrialObservation({root,phase:isDevelopment?'development':'formal',trialId:trial.id,harness:trial.harness,attempts:snapshot.attempts});
          queue.recordObservation(trial.id,observation);
          assertObservableModelTrial(queue.get(trial.id)!.status,snapshot,observation.providerComplete);
          if(snapshot.modelReportedID){const path=join(formal,'model-reported.json'), previous=await optionalJson(path);if(previous&&previous.id!==snapshot.modelReportedID)throw new Error('model reported ID drift');await atomicJson(path,{id:snapshot.modelReportedID});}
        },
      };
    };
    const smoke = await optionalJson(join(root,'eval/live-smoke-dsh.json'));
    if (!smoke?.results?.some((r:any)=>r.name==='dsh'&&r.agentExit===0&&r.externalTestsPass===true&&r.patch?.includes('+export'))) throw new Error('real DSH modify and test smoke required');
    const devResult=await runFormalLoop(devQueue,makeHooks(true),{expectedProviderEpoch:manifest.providerEpoch,qualifications,tuning:{status:'pending',settings:{}},phase:'development',reservedRequests,statusPath,reportDir:join(root,'eval/development'),signal:controller.signal,...(argv.includes('--once')?{maxTrials:1}:{})});
    if(devResult.state!=='complete') return;
    const {tuning,evidence}=freezeDevelopment(manifest,devQueue.list());
    // Rehash actual private evaluator receipts before a setting is selected.
    for(const trial of evidence.trials){const file=await readFile(join(formal,'evaluation',trial.id,'evidence.json'));if(createHash('sha256').update(file).digest('hex')!==trial.evidenceSha256)throw new Error('development receipt changed');}
    const evidencePath=join(formal,'development-evidence.json'), tuningPath=join(formal,'tuning.json');
    const priorEvidence=await optionalJson(evidencePath),priorTuning=await optionalJson(tuningPath);
    if(priorEvidence&&digest(priorEvidence)!==digest(evidence)||priorTuning&&digest(priorTuning)!==digest(tuning))throw new Error('frozen development evidence changed');
    if(!priorEvidence)await atomicJson(evidencePath,evidence);if(!priorTuning)await atomicJson(tuningPath,tuning);
    const prepared=await prepareFormalExperiment({qualifications,tuning,tuningEvidence:evidence,route:metadata,experimentId:manifest.experimentId,manifestPath,queuePath:join(formal,'queue.db'),metadataPath:join(formal,'freeze.json')});
    prepared.queue.close();
    await runFormalLoop(formalQueue,makeHooks(false,tuning),{expectedProviderEpoch:manifest.providerEpoch,qualifications,tuning,reservedRequests,statusPath,reportDir:join(root,'eval/formal'),signal:controller.signal,...(argv.includes('--once')?{maxTrials:1}:{})});
  } catch(error) {
    await atomicJson(statusPath,{state:'incomplete',reason:'trusted runner stopped; reconcile private durable state',updatedAt:new Date().toISOString()});
    throw error;
  } finally {
    for(const queue of queues)queue.close();await broker?.close();process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);
    await lock.close();await unlink(join(formal,'runner.lock'));
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){main().catch(()=>{process.stderr.write('Benchmark runner stopped; inspect private status and reconciliation state.\n');process.exitCode=1;});}
