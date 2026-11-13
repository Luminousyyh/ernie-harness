import type {ActiveRunRecord,AttemptUsage} from './types.js';
export type ActiveRunErrorCode='INVALID_INPUT'|'ENVIRONMENT_UNAVAILABLE'|'ACTIVE_VERSION_UNAVAILABLE'|'ACTIVE_VERSION_MISMATCH'|'ACTIVE_INTEGRITY_FAILED'|'PRIVATE_WORKSPACE'|'WORKSPACE_BUSY'|'BUDGET_EXCEEDED'|'CANCELLED'|'NEEDS_RECONCILIATION'|'EXECUTION_FAILED';
/** Sanitized integration error. A rejected run never exposes a patch; confirmed usage may still require charging. */
export class ActiveRunError extends Error {
 readonly name='ActiveRunError';
 constructor(readonly runId:string,readonly code:ActiveRunErrorCode,message:string,readonly status:ActiveRunRecord['status']='failed',readonly usage?:AttemptUsage){super(message);}
}
