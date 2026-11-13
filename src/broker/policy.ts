import {DEFAULT_BUDGET, type Budget} from '../contracts/index.js';

export class BrokerError extends Error {
  constructor(readonly code:string, readonly status:number, message:string) { super(message); }
}
export function fail(code:string,status=400,message='Broker rejected the request'):never { throw new BrokerError(code,status,message); }
export function object(value:unknown):value is Record<string,unknown> { return typeof value==='object' && value!==null && !Array.isArray(value); }
export function integer(value:unknown):value is number { return typeof value==='number' && Number.isSafeInteger(value) && value>=0; }
export function trialBudget(input:Partial<Budget>={}):Budget {
  if (!object(input)) fail('INVALID_BUDGET');
  for (const key of Object.keys(input)) if (!(key in DEFAULT_BUDGET)) fail('INVALID_BUDGET');
  const budget={...DEFAULT_BUDGET,...input};
  for (const key of Object.keys(DEFAULT_BUDGET) as (keyof Budget)[]) {
    if (!integer(budget[key]) || budget[key]<1 || budget[key]>DEFAULT_BUDGET[key]) fail('INVALID_BUDGET');
  }
  return budget;
}
/** Evaluation policy is uniform across all harnesses, including omitted defaults. */
export function fixedHighReasoning(request:Record<string,unknown>):Record<string,unknown> {
  if(request.reasoning_effort!==undefined&&request.reasoning_effort!=='high')fail('HIGH_REASONING_REQUIRED');
  const reasoning=request.reasoning;
  if(reasoning!==undefined&&!object(reasoning))fail('HIGH_REASONING_REQUIRED');
  if(object(reasoning)&&((reasoning.effort!==undefined&&reasoning.effort!=='high')||(reasoning.enabled!==undefined&&reasoning.enabled!==true)))fail('HIGH_REASONING_REQUIRED');
  return {effort:'high',exclude:false};
}
