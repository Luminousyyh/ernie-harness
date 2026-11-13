import {MODEL_ID, type ModelDelta, type ModelRequest, type ModelResponse, type ModelTransport} from '../contracts/index.js';
import {ApiError, checkAbort, protocolError} from './errors.js';
import {preflightFreeRoute, type FreeRoute} from './catalog.js';
import {readJson, request, scopedSignal} from './http.js';
import {SerialQuota} from './quota.js';
import {CompletionAssembler, readSse} from './sse.js';
export interface OpenRouterOptions {
  apiKey:string;baseUrl?:string;fetch?:typeof globalThis.fetch;quota?:SerialQuota;
  /** Explicitly selected only after non-streaming support is established for this route. */
  responseMode?:'stream'|'json';
}
export interface TransportSnapshot {model:typeof MODEL_ID;catalogRequests:number;completionAttempts:number;responseMode:'stream'|'json';lastRoute?:FreeRoute}
function endpoint(base:string):string{
  let url:URL;try{url=new URL(base);}catch{throw new TypeError('Invalid provider base URL');}
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash||((url.protocol!=='https:'||url.hostname!=='openrouter.ai')&&!(loopback&&['http:','https:'].includes(url.protocol))))throw new TypeError('Provider base URL must be OpenRouter HTTPS or a loopback broker');
  return `${url.toString().replace(/\/$/,'')}/chat/completions`;
}
export class OpenRouterTransport implements ModelTransport {
  readonly #apiKey:string;private readonly url:string;private readonly fetcher:typeof globalThis.fetch;private readonly quota:SerialQuota;private readonly responseMode:'stream'|'json';
  private catalogRequests=0;private completionAttempts=0;private lastRoute:FreeRoute|undefined;
  constructor(options:OpenRouterOptions){
    if(!options.apiKey||options.apiKey.length>8192||/[\x00-\x20\x7f]/.test(options.apiKey))throw new TypeError('A valid API key is required');
    this.#apiKey=options.apiKey;this.url=endpoint(options.baseUrl??'https://openrouter.ai/api/v1');this.fetcher=options.fetch??globalThis.fetch;this.quota=options.quota??new SerialQuota();this.responseMode=options.responseMode??'stream';
  }
  get contextLength():number|undefined{return this.lastRoute?.contextLength;}
  snapshot():TransportSnapshot{return {model:MODEL_ID,catalogRequests:this.catalogRequests,completionAttempts:this.completionAttempts,responseMode:this.responseMode,...(this.lastRoute?{lastRoute:structuredClone(this.lastRoute)}:{})};}
  async complete(input:ModelRequest,onDelta?:(delta:ModelDelta)=>void,signal?:AbortSignal):Promise<ModelResponse>{
    checkAbort(signal);
    if(input.reasoningEffort!==undefined&&input.reasoningEffort!=='high')throw new ApiError('Only high reasoning effort is supported',{code:'UNSUPPORTED_REASONING_EFFORT',retryable:false});
    if(!Array.isArray(input.messages)||input.messages.length===0)throw new TypeError('At least one chat message is required');
    if(input.maxTokens!==undefined&&(!Number.isSafeInteger(input.maxTokens)||input.maxTokens<=0))throw new TypeError('maxTokens must be a positive integer');
    if(input.temperature!==undefined&&(!Number.isFinite(input.temperature)||input.temperature<0||input.temperature>2))throw new TypeError('temperature must be between zero and two');
    // Freeze the call's history before any await so callers cannot mutate queued tool turns.
    const modelRequest=structuredClone(input);
    const scope=scopedSignal(signal,10*60*1000);
    try{

      const body={model:MODEL_ID,messages:modelRequest.messages,stream:this.responseMode==='stream',...(this.responseMode==='stream'?{stream_options:{include_usage:true}}:{}),reasoning:{effort:modelRequest.reasoningEffort??'high',exclude:false},provider:{only:['baidu'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:0,completion:0}},...(modelRequest.tools?.length?{tools:modelRequest.tools,tool_choice:'auto'}:{}),max_tokens:modelRequest.maxTokens??16384,...(modelRequest.temperature!==undefined?{temperature:modelRequest.temperature}:{})};
      const serialized=JSON.stringify(body);if(Buffer.byteLength(serialized)>16*1024*1024)throw new ApiError('Model request exceeds the local size bound',{code:'REQUEST_TOO_LARGE',retryable:false});
      return await this.quota.run(async()=>{
        checkAbort(scope.signal);this.completionAttempts++;
        const response=await request(this.fetcher,this.url,{method:'POST',headers:{authorization:`Bearer ${this.#apiKey}`,'content-type':'application/json',accept:this.responseMode==='stream'?'text/event-stream, application/json':'application/json'},body:serialized,signal:scope.signal});
        const assembler=new CompletionAssembler(modelRequest,onDelta);const contentType=(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
        if(contentType==='text/event-stream'){
          for await(const event of readSse(response,scope.signal)){if(event==='[DONE]')break;assembler.add(event,true);}
        }else if(contentType==='application/json'){
          // A successful JSON response itself establishes support; never issue a hidden second call.
          assembler.add(await readJson(response,scope.signal),false);
        }else{void response.body?.cancel().catch(()=>{});throw protocolError('UNSUPPORTED_MEDIA_TYPE');}
        return assembler.finish();
      },scope.signal,async()=>{
        this.catalogRequests++;this.lastRoute=await preflightFreeRoute({fetch:this.fetcher,signal:scope.signal});
        const estimatedInput=Buffer.byteLength(JSON.stringify({messages:modelRequest.messages,tools:modelRequest.tools}),'utf8');
        if(this.lastRoute.contextLength!==undefined&&estimatedInput+body.max_tokens>this.lastRoute.contextLength)throw new ApiError('Request and response allowance exceed the declared route context',{code:'CONTEXT_LIMIT_EXCEEDED',retryable:false});
        if(modelRequest.tools?.length&&!this.lastRoute.supportedParameters.includes('tools'))throw new ApiError('The free route does not advertise tools',{code:'TOOLS_UNAVAILABLE',retryable:false});
        if(this.lastRoute.maxCompletionTokens!==undefined&&body.max_tokens>this.lastRoute.maxCompletionTokens)throw new ApiError('Requested output exceeds the free route limit',{code:'OUTPUT_LIMIT_EXCEEDED',retryable:false});
      });
    }catch(error){
      checkAbort(scope.signal);if(error instanceof ApiError)throw error;
      // Fetch, stream and parsing exceptions can include URLs or echoed credentials.
      throw new ApiError('Provider response failed; request outcome may be uncertain',{code:'RESPONSE_ERROR',retryable:false});
    }finally{scope.dispose();}
  }
}
