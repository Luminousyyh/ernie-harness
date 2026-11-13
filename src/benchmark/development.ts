import { digest, type Manifest } from './schedule.js';
import type { Trial } from './queue.js';
import type { TuningFreeze } from './runner.js';
export const CONTEXT_LIMITS = [64000, 128000, 256000] as const;
export const DEVELOPMENT_SELECTION_RULE = { primary: 'completed-task-rate', secondary: 'total-input-tokens', tiePreference: [128000, 64000, 256000] } as const;
export interface DevelopmentEvidence { schemaVersion: 1; manifestSha256: string; providerEpoch: string; contexts: readonly number[]; selectionRule: typeof DEVELOPMENT_SELECTION_RULE; trials: Trial[] }
const selectionDigest = (manifest: Manifest): string => digest({ ...manifest, createdAt: undefined });
export function developmentManifest(formal: Manifest): Manifest {
  const trials = formal.devTasks.flatMap(task => CONTEXT_LIMITS.map((context, repeat) => ({
    id: 'dev-' + digest([formal.experimentId, task.instanceId, context]).slice(0, 40), instanceId: task.instanceId,
    harness: 'ernie' as const, repeat, contextLimit: context, block: task.instanceId, status: 'pending' as const,
  })).sort((a,b) => digest([formal.seed,a.id]).localeCompare(digest([formal.seed,b.id]))));
  return { ...formal, phase: 'development', experimentId: formal.experimentId + '-development', trials };
}
export function freezeDevelopment(formal: Manifest, trials: Trial[]): { tuning: TuningFreeze; evidence: DevelopmentEvidence } {
  const expected = developmentManifest(formal).trials;
  if (trials.length !== 18 || new Set(trials.map(t=>t.id)).size !== 18 || expected.some(e=>!trials.some(t=>t.id===e.id&&t.instanceId===e.instanceId&&t.harness===e.harness&&t.repeat===e.repeat&&t.block===e.block&&t.contextLimit===e.contextLimit))) throw new Error('development trial set differs');
  if (trials.some(t=>!['resolved','unresolved'].includes(t.status))) throw new Error('development trials are incomplete');
  if (trials.some(t=>t.usage.calls < 1 || !/^[a-f0-9]{64}$/.test(t.evidenceSha256??'') || !/^[a-f0-9]{64}$/.test(t.patchSha256??''))) throw new Error('real development calls and evaluator evidence required');
  const ranked = CONTEXT_LIMITS.map((context,repeat)=>({context,
    completionRate: trials.filter(t=>t.repeat===repeat&&t.status==='resolved').length / formal.devTasks.length,
    inputTokens: trials.filter(t=>t.repeat===repeat).reduce((sum,t)=>sum+t.usage.inputTokens,0),
  })).sort((a,b)=>b.completionRate-a.completionRate || a.inputTokens-b.inputTokens
    || DEVELOPMENT_SELECTION_RULE.tiePreference.indexOf(a.context)-DEVELOPMENT_SELECTION_RULE.tiePreference.indexOf(b.context));
  const evidence: DevelopmentEvidence = { schemaVersion:1, manifestSha256:selectionDigest(formal), providerEpoch:formal.providerEpoch, contexts:CONTEXT_LIMITS, selectionRule:DEVELOPMENT_SELECTION_RULE, trials:expected.map(e=>trials.find(t=>t.id===e.id)!) };
  return { tuning:{status:'frozen',settings:{strategy:'baseline',reasoning:'high',contextLimit:ranked[0]!.context},evidenceSha256:digest(evidence),devTasks:formal.devTasks.map(t=>t.instanceId)}, evidence };
}
export function verifyDevelopmentEvidence(formal: Manifest, tuning: TuningFreeze, evidence: DevelopmentEvidence): void {
  if (evidence.manifestSha256!==selectionDigest(formal) || evidence.providerEpoch!==formal.providerEpoch || tuning.evidenceSha256!==digest(evidence)) throw new Error('development evidence hash/manifest mismatch');
  const expected = freezeDevelopment(formal,evidence.trials);
  if (digest(expected.tuning)!==digest(tuning) || digest(expected.evidence)!==digest(evidence)) throw new Error('development selection differs from real evidence');
}
