import type {Usage} from '../contracts/index.js';
import {ApiError} from './errors.js';
export interface TokenAllowance {maxCalls:number;maxInputTokens:number;maxOutputTokens:number}
export interface BudgetSnapshot {calls:number;inputTokens:number;outputTokens:number;reasoningTokens:number;reservedInputTokens:number;reservedOutputTokens:number}
/** Reserve before dispatch. Unsettled attempts retain their entire allowance. */
export class BudgetReservations {
  private state:BudgetSnapshot={calls:0,inputTokens:0,outputTokens:0,reasoningTokens:0,reservedInputTokens:0,reservedOutputTokens:0};
  constructor(private readonly limits:TokenAllowance){for(const value of Object.values(limits))if(!Number.isSafeInteger(value)||value<0)throw new TypeError('Budget limits must be nonnegative integers');}
  snapshot():BudgetSnapshot{return {...this.state};}
  reserve(estimate:{inputTokens:number;outputTokens:number}):{commit:(usage:Usage)=>void}{
    for(const value of Object.values(estimate))if(!Number.isSafeInteger(value)||value<0)throw new TypeError('Token reservations must be nonnegative integers');
    const s=this.state;
    if(s.calls+1>this.limits.maxCalls||s.inputTokens+s.reservedInputTokens+estimate.inputTokens>this.limits.maxInputTokens||s.outputTokens+s.reservedOutputTokens+estimate.outputTokens>this.limits.maxOutputTokens)throw new ApiError('Model budget exhausted',{code:'BUDGET_EXHAUSTED',retryable:false});
    s.calls++;s.reservedInputTokens+=estimate.inputTokens;s.reservedOutputTokens+=estimate.outputTokens;let settled=false;
    return {commit:(usage:Usage)=>{if(settled)throw new Error('Reservation already settled');for(const value of [usage.inputTokens,usage.outputTokens,usage.reasoningTokens])if(!Number.isSafeInteger(value)||value<0)throw new TypeError('Invalid token usage');
      settled=true;s.reservedInputTokens-=estimate.inputTokens;s.reservedOutputTokens-=estimate.outputTokens;s.inputTokens+=usage.inputTokens;s.outputTokens+=usage.outputTokens;s.reasoningTokens+=usage.reasoningTokens;
      // Actual overages are retained and prevent the next reservation; never conceal them.
    }};
  }
}
