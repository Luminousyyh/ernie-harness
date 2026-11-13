import type {ModelTransport, Usage} from '../contracts/index.js';
import type {EvaluationScore, EvaluationSuite} from './evaluation.js';
export const MODULES = ['tools','context','prompt','reflection','proposer'] as const;
export type ImprovementModule = typeof MODULES[number];
export type Selection = {mode:'fixed';modules:ImprovementModule[]} | {mode:'search';start?:ImprovementModule[]};
export type JobStatus = 'queued'|'proposing'|'evaluating'|'validating'|'awaiting-environment'|'needs-reconciliation'|'completed'|'cancelled'|'failed';
export interface ImprovementJob {id:string;workspace:string;status:JobStatus;maxCalls:number;maxCandidates:number;selection:Selection;calls:number;createdAt:string;updatedAt:string;candidateIds:string[];parentId:string|null;parentSourceHash?:string;developmentHash?:string;validationHash?:string;error?:string;winnerId?:string;isolation?:IsolationEvidence}
export type CandidateStatus = 'proposed'|'awaiting-environment'|'building'|'evaluated'|'rejected'|'eligible'|'applied'|'failed';
export interface ImprovementCandidate {id:string;jobId:string;modules:ImprovementModule[];parentId:string|null;sourceHash:string;patchHash:string;status:CandidateStatus;createdAt:string;archivePath?:string;developmentHash?:string;validationHash?:string;parentScore?:EvaluationScore;score?:EvaluationScore;parentValidation?:EvaluationScore;validation?:EvaluationScore;buildPassed?:boolean;artifactHash?:string;isolation?:IsolationEvidence;error?:string}
export interface AttemptUsage {calls:number;inputTokens:number;outputTokens:number;reasoningTokens:number;activeMs:number}
export interface ImprovementAttempt {id:string;jobId:string;kind:'proposal'|'evaluation';status:'reserved'|'completed'|'uncertain';reservedCalls:number;reservedInputTokens:number;reservedOutputTokens:number;usage?:AttemptUsage;createdAt:string;candidateId?:string;partition?:'development'|'sealed-validation'}
export interface Activation {candidateId:string|null;sourceHash:string;path:string;parentId:string|null;artifactHash?:string;createdAt?:string}
export interface IsolationEvidence {verified:boolean;platform:string;mechanism:'linux-bubblewrap';checkedAt:string;reason?:string;probeHash?:string}
/** Reservations must use the same persistent global allowance as ordinary goals. No retries are hidden here. */
export interface SharedImprovementBudget {
 reserve(input:{jobId:string;attemptId:string;kind:'proposal'|'evaluation'|'active-run';maxCalls:number;inputTokens:number;outputTokens:number},signal:AbortSignal):Promise<void>;
 settle(input:{jobId:string;attemptId:string;usage:AttemptUsage;uncertain:boolean}):Promise<void>;
}
/** Adapter to createModelBroker.registerTrial/trialSnapshot. Tokens remain memory/ephemeral only. */
export interface ImprovementBroker {
 openTrial(input:{id:string;maxCalls:number;maxActiveMs:number;partition:'development'|'sealed-validation'|'user-task';signal:AbortSignal}):Promise<{
  socketPath:string;token:string;
  /** Must revoke/stop the trial and return broker usage, never candidate-reported usage. */
  finish():Promise<{usage:AttemptUsage;uncertain:boolean}>;
 }>;
}
export interface LinuxEvaluationEnvironment {
 development:EvaluationSuite;validation:EvaluationSuite;
 /** Read-only dependency tree prepared by the trusted operator, never installed on the host by a candidate. */
 dependenciesDir:string;
 nodeExecutable?:string; bwrapExecutable?:string;
 /** Trusted argument arrays, executed only inside Bubblewrap. */
 buildCommands?:string[][];
 broker:ImprovementBroker;
}
export interface DevelopmentTrace {partition:'development';manifestHash:string;taskId:string;content:unknown}
export interface ImprovementOptions {
 stateDir:string;sourceRoot:string;model:ModelTransport;budget:SharedImprovementBudget;
 environment?:LinuxEvaluationEnvironment;secrets?:readonly string[];
 onEvent?:(event:{jobId:string;type:string;data:unknown})=>void;
}
export interface StartImprovement {workspace:string;maxCalls?:number;maxCandidates?:number;selection?:Selection;traces?:DevelopmentTrace[]}
export interface StructuredEdit {path:string;beforeSha256:string;content:string}
export interface PatchProposal {schemaVersion:1;summary:string;edits:StructuredEdit[]}
export type {Usage};

/** A separate user-authorized launch, never a formal evaluation or promotion score. */
export interface RunActiveInput {
 id?:string;workspace:string;prompt:string;expectedSourceHash?:string;expectedCandidateId?:string|null;maxCalls?:number;maxActiveMs?:number;signal?:AbortSignal;
}
export interface WorkspaceEdit {path:string;beforeSha256:string|null;afterSha256:string|null;content:string|null}
export interface WorkspacePatch {schemaVersion:1;baseHash:string;resultHash:string;hash:string;edits:WorkspaceEdit[];unified:string}
export interface ActiveRunResult {
 id:string;status:'completed'|'failed';candidateId:string|null;sourceHash:string;artifactHash:string;
 isolation:IsolationEvidence;usage:AttemptUsage;patch:WorkspacePatch;exitCode:number;outputHash:string;failureCode?:'AGENT_EXIT_NONZERO';
}
export interface ActiveRunRecord {
 id:string;workspace:string;promptHash:string;candidateId:string|null;sourceHash:string;artifactHash:string;
 status:'preparing'|'running'|'completed'|'failed'|'cancelled'|'needs-reconciliation';
 maxCalls:number;maxActiveMs:number;createdAt:string;updatedAt:string;error?:string;result?:ActiveRunResult;
 reservation:{id:string;status:'unreserved'|'reserved'|'completed'|'uncertain';maxCalls:number;inputTokens:number;outputTokens:number;usage?:AttemptUsage};
}
