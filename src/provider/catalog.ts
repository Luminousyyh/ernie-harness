import {MODEL_ID,type ModelCapabilities,type ReasoningEffort} from '../contracts/index.js';
import {ApiError, checkAbort, record} from './errors.js';
import {readJson, request, scopedSignal} from './http.js';
export const CATALOG_URL = `https://openrouter.ai/api/v1/models/${MODEL_ID}/endpoints`;
export interface FreeRoute {
  model: typeof MODEL_ID; provider: 'Baidu'; tag: string; checkedAt: string;
  supportedParameters: string[]; reasoningEfforts?:string[]; contextLength?: number; maxCompletionTokens?: number;
}
function zero(value: unknown): boolean {return (typeof value==='number'&&value===0)||(typeof value==='string'&&/^\s*0(?:\.0+)?(?:[eE][+-]?\d+)?\s*$/.test(value));}
function freePricing(value: unknown): boolean {
  if(!record(value)||!zero(value.prompt)||!zero(value.completion))return false;
  // Discount is not a billable dimension; every other advertised price must be zero.
  return Object.entries(value).every(([key,price])=>key==='discount'||zero(price));
}
export async function preflightFreeRoute(options:{fetch?:typeof fetch;signal?:AbortSignal}={}):Promise<FreeRoute> {
  const scope=scopedSignal(options.signal,30000);
  try {
    // This is a public request. The model key must never be sent to the catalog.
    const response=await request(options.fetch??globalThis.fetch,CATALOG_URL,{headers:{accept:'application/json'},signal:scope.signal});
    const body=await readJson(response,scope.signal,4*1024*1024);
    const fail=()=>new ApiError('An exact-model, zero-price Baidu route with reasoning support is unavailable',{code:'FREE_ROUTE_UNAVAILABLE',retryable:false});
    if(!record(body)||!record(body.data)||body.data.id!==MODEL_ID||!Array.isArray(body.data.endpoints))throw fail();
    const endpoint=body.data.endpoints.find((value:unknown)=>record(value)&&value.provider_name==='Baidu'&&value.model_id===MODEL_ID&&value.tag==='baidu'&&(value.status===undefined||value.status===0)&&freePricing(value.pricing)&&Array.isArray(value.supported_parameters)&&value.supported_parameters.includes('reasoning')&&value.supported_parameters.includes('reasoning_effort')&&(!Array.isArray(value.supported_reasoning_efforts)||value.supported_reasoning_efforts.length===0||value.supported_reasoning_efforts.includes('high')));
    if(!record(endpoint))throw fail();
    return {model:MODEL_ID,provider:'Baidu',tag:'baidu',checkedAt:new Date().toISOString(),supportedParameters:(endpoint.supported_parameters as unknown[]).filter((x):x is string=>typeof x==='string'),...(Array.isArray(endpoint.supported_reasoning_efforts)?{reasoningEfforts:[...new Set(endpoint.supported_reasoning_efforts.filter((x):x is string=>typeof x==='string'&&['none','minimal','low','medium','high','xhigh'].includes(x)))]}:{}),...(Number.isSafeInteger(endpoint.context_length)&&Number(endpoint.context_length)>0?{contextLength:endpoint.context_length as number}:{}),...(typeof endpoint.max_completion_tokens==='number'?{maxCompletionTokens:endpoint.max_completion_tokens}:{})};
  } finally {scope.dispose();}
}
export interface CapabilitySnapshot extends FreeRoute {
  liveVerified: false; source: 'public-catalog'; reasoning: boolean; tools: boolean; structuredOutputs: boolean; streaming: 'unverified';
}
/** Metadata only: no completion, paid request, credential inspection or tool execution. */
export async function probeCapabilities(_apiKey: string, options:{fetch?:typeof fetch;signal?:AbortSignal}={}):Promise<CapabilitySnapshot> {
  const route=await preflightFreeRoute(options);
  return {...route,liveVerified:false,source:'public-catalog',reasoning:true,tools:route.supportedParameters.includes('tools'),structuredOutputs:route.supportedParameters.includes('response_format')||route.supportedParameters.includes('structured_outputs'),streaming:'unverified'};
}

export interface CapabilityInspectionOptions {
  fetch?:typeof fetch;
  signal?:AbortSignal;
  /** Trusted caller supplies these only after checking a persisted live-success record.
   * Catalog responses and synthetic transport successes must never populate this list. */
  verifiedReasoning?:readonly ReasoningEffort[];
}
/** Public metadata GET only. Does not inspect credentials or consume generation quota. */
export async function inspectModelCapabilities(options:CapabilityInspectionOptions={}):Promise<ModelCapabilities>{
  checkAbort(options.signal);
  const verified:ReasoningEffort[]=options.verifiedReasoning?.includes('high')?['high']:[];
  try{
    const route=await preflightFreeRoute(options);
    return {status:'available',model:MODEL_ID,...(route.contextLength?{contextLength:route.contextLength}:{}),reasoning:{advertised:route.reasoningEfforts??[],verified,selected:'high',reason:verified.length?'服务端已提供 high 档位的真实调用成功记录；开放其他档位仍需目录明确公布并完成真实调用验证。':'当前配置为 high。通用推理支持不代表目录已公布具体档位；服务端尚未提供真实调用成功记录。'},checkedAt:route.checkedAt};
  }catch{
    checkAbort(options.signal);
    return {status:'unavailable',model:MODEL_ID,reasoning:{advertised:[],verified,selected:'high',reason:verified.length?'当前无法确认免费路由可用；已提供的真实调用成功记录仅作为 high 档位的历史证据。':'当前无法确认免费路由可用；服务端尚未提供真实调用成功记录。'},checkedAt:new Date().toISOString()};
  }
}
