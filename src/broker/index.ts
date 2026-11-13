import {createHash} from 'node:crypto';
import Fastify, {type FastifyRequest} from 'fastify';
import {join} from 'node:path';
import {mkdir, lstat, chmod} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {MODEL_ID, type Budget} from '../contracts/index.js';
import {SerialQuota, preflightFreeRoute} from '../provider/index.js';
import {readJson, request as upstreamRequest} from '../provider/http.js';
import {readSse} from '../provider/sse.js';
import {TraceJournal} from './trace.js';
import {BrokerStore, type Attempt} from './store.js';
import {BrokerError, fail, fixedHighReasoning, integer, object} from './policy.js';
export type {TrialSnapshot, Attempt} from './store.js';
export interface ModelBrokerOptions {
  apiKey:string;stateDir:string;socketPath?:string;quotaPath?:string;traceDirectory?:string;
  /** Trusted test injection only; production always uses OpenRouter. */
  fetch?:typeof globalThis.fetch;now?:()=>number;minimumDispatchIntervalMs?:number;
}
interface Context {id:string;attempt:Attempt;controller:AbortController;finished:boolean;redactions:string[];failureLogged?:boolean}
const ENDPOINT='https://openrouter.ai/api/v1/chat/completions';
const MAX_BYTES=16*1024*1024;
const pinnedProvider={only:['baidu'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:0,completion:0}};
function validateBody(value:unknown,budget:Budget):{body:Record<string,unknown>;input:number;output:number} {
  if(!object(value)||value.model!==MODEL_ID)fail('MODEL_NOT_ALLOWED');
  for(const key of ['models','route','transforms','plugins','api_key','base_url','provider_order'])if(key in value)fail('ROUTING_OVERRIDE_NOT_ALLOWED');
  if(value.provider!==undefined){
    if(!object(value.provider))fail('PROVIDER_NOT_ALLOWED');
    for(const [key,v] of Object.entries(value.provider)){
      if(!(key in pinnedProvider))fail('PROVIDER_NOT_ALLOWED');
      if(key==='only'&&JSON.stringify(v)!==JSON.stringify(['baidu']))fail('PROVIDER_NOT_ALLOWED');
      if(key==='allow_fallbacks'&&v!==false)fail('PROVIDER_NOT_ALLOWED');
      if(key==='require_parameters'&&v!==true)fail('PROVIDER_NOT_ALLOWED');
      if(key==='max_price'&&(!object(v)||Object.values(v).some(price=>price!==0&&price!=='0')))fail('PROVIDER_NOT_ALLOWED');
    }
  }
  if(!Array.isArray(value.messages)||value.messages.length===0||value.n!==undefined&&value.n!==1||value.stream!==undefined&&typeof value.stream!=='boolean')fail('INVALID_REQUEST');
  for(const message of value.messages){
    if(!object(message)||!['system','developer','user','assistant','tool','function'].includes(String(message.role)))fail('INVALID_MESSAGE');
    if(Array.isArray(message.content)&&message.content.some(part=>!object(part)||part.type!=='text'||typeof part.text!=='string'))fail('UNSUPPORTED_CONTENT');
    if(message.content!==null&&message.content!==undefined&&typeof message.content!=='string'&&!Array.isArray(message.content))fail('INVALID_MESSAGE');
  }
  const output=value.max_completion_tokens??value.max_tokens??budget.maxOutputPerCall;
  if(!integer(output)||output<1||output>budget.maxOutputPerCall)fail('OUTPUT_LIMIT_EXCEEDED');
  if(value.max_tokens!==undefined&&value.max_completion_tokens!==undefined&&value.max_tokens!==value.max_completion_tokens)fail('CONFLICTING_OUTPUT_LIMITS');
  const body:Record<string,unknown>={...value,model:MODEL_ID,provider:pinnedProvider,temperature:0,top_p:1,reasoning:fixedHighReasoning(value),...(value.max_completion_tokens===undefined?{max_tokens:output}:{})};
  // Sampling is controlled centrally; native harness defaults must not confound comparison.
  for(const parameter of ['reasoning_effort','include_reasoning','top_k','min_p','seed','frequency_penalty','presence_penalty','repetition_penalty','logit_bias'])delete body[parameter];
  if(value.stream===true){if(value.stream_options!==undefined&&!object(value.stream_options))fail('INVALID_STREAM_OPTIONS');body.stream_options={...(object(value.stream_options)?value.stream_options:{}),include_usage:true};}
  const bytes=Buffer.byteLength(JSON.stringify(body));if(bytes>MAX_BYTES)fail('REQUEST_TOO_LARGE',413);
  // Byte-bound reservation intentionally overestimates text tokenization and framing.
  return {body,input:bytes+4096+value.messages.length*64,output};
}
function inspect(payload:unknown):Record<string,unknown>|undefined {
  if(!object(payload)||payload.error!==undefined)fail('UPSTREAM_RESPONSE_ERROR',502);
  if(payload.model!==undefined&&payload.model!==MODEL_ID)fail('UNEXPECTED_MODEL',502);
  if(payload.provider!==undefined&&payload.provider!=='Baidu'&&payload.provider!=='baidu')fail('UNEXPECTED_PROVIDER',502);
  if(!Array.isArray(payload.choices))fail('INVALID_COMPLETION',502);
  if(payload.usage!==undefined&&!object(payload.usage))fail('INVALID_USAGE',502);
  const usage=object(payload.usage)?payload.usage:undefined;
  if(usage?.cost!==undefined&&Number(usage.cost)!==0)fail('UNEXPECTED_COST',502);
  return usage;
}
function reportedUsage(value:Record<string,unknown>|undefined):{inputTokens:number;outputTokens:number;reasoningTokens:number}|undefined {
  if(!value)return;
  const input=value.prompt_tokens??value.input_tokens,output=value.completion_tokens??value.output_tokens;
  const details=value.completion_tokens_details??value.output_tokens_details;
  const reasoning=object(details)?details.reasoning_tokens??0:value.reasoning_tokens??0;
  if(input===undefined||output===undefined)return;
  if(!integer(input)||!integer(output)||!integer(reasoning)||reasoning>output)fail('INVALID_USAGE',502);
  // OpenAI completion_tokens already includes reasoning_tokens.
  return {inputTokens:input,outputTokens:output,reasoningTokens:reasoning};
}
export function createModelBroker(options:ModelBrokerOptions){
  if(!options.apiKey||options.apiKey.length>8192||/[\x00-\x20\x7f]/.test(options.apiKey))throw new TypeError('A valid runtime API key is required');
  const now=options.now??Date.now,store=new BrokerStore(options.stateDir,now),fetcher=options.fetch??globalThis.fetch;
  const traceDirectory=options.traceDirectory??join(store.stateDir,'traces');
  const traces=new TraceJournal({directory:traceDirectory,secrets:[options.apiKey]});
  const recordTrace=async(context:Context,kind:'request'|'response',data:unknown)=>{try{await traces.record(context.attempt.id,kind,data,{trialId:context.id,secrets:context.redactions});}catch{fail('TRACE_STORAGE_FAILED',503,'Sanitized trace could not be persisted; reconcile before continuing');}};
  const interval=options.minimumDispatchIntervalMs??6000;
  if(!Number.isFinite(interval)||interval<0||interval<6000&&!options.fetch)throw new TypeError('Production dispatch interval must be at least 6000ms');
  const quota=new SerialQuota({path:options.quotaPath??join(options.stateDir,'broker-quota.json'),now});
  const app=Fastify({logger:false,bodyLimit:MAX_BYTES});
  const contexts=new WeakMap<FastifyRequest,Context>(),controllers=new Set<AbortController>();
  app.addHook('onRequest',async(req,reply)=>{
    if(req.method!=='POST'||req.url!=='/v1/chat/completions')return;
    const authorization=req.headers.authorization;
    const token=typeof authorization==='string'&&authorization.startsWith('Bearer ')?authorization.slice(7):'';
    const id=token?store.authenticate(token):undefined;if(!id)fail('INVALID_TRIAL_TOKEN',401);
    const context:Context={id,attempt:store.begin(id),controller:new AbortController(),finished:false,redactions:[token]};contexts.set(req,context);controllers.add(context.controller);
    const cancel=()=>{if(!reply.raw.writableFinished)context.controller.abort();};req.raw.once('aborted',cancel);reply.raw.once('close',cancel);
  });
  app.addHook('onResponse',async(req)=>{const context=contexts.get(req);if(context)controllers.delete(context.controller);});
  app.setErrorHandler(async(error,req,reply)=>{
    const context=contexts.get(req),code=error instanceof BrokerError?error.code:object(error)&&typeof error.code==='string'?error.code:'BROKER_ERROR';
    if(context&&!context.finished){context.finished=true;try{store.finish(context.id,context.attempt,code);}catch{}}
    const candidate=error instanceof BrokerError?error.status:object(error)?error.statusCode??error.status:undefined;
    const status=typeof candidate==='number'&&candidate>=400&&candidate<=599?candidate:code==='FREE_ROUTE_UNAVAILABLE'?503:502;
    if(context&&!context.failureLogged){context.failureLogged=true;try{await traces.record(context.attempt.id,'failure',{model:MODEL_ID,code,status,attempt:{...context.attempt}},{trialId:context.id,secrets:context.redactions});}catch{/* Failing trace storage remains a closed dispatch gate. */}}
    reply.code(status).send({error:{message:error instanceof BrokerError?error.message:'Broker request failed; reservation retained',type:'broker_error',code}});
  });
  app.post('/v1/chat/completions',async(req,reply)=>{
    const context=contexts.get(req)!;
    const validated=validateBody(req.body,store.budget(context.id));
    await recordTrace(context,'request',{model:MODEL_ID,body:validated.body,bodyJsonSha256:createHash('sha256').update(JSON.stringify(validated.body)).digest('hex'),budget:store.budget(context.id),receivedAt:context.attempt.receivedAt});
    store.reserve(context.id,context.attempt,validated.input,validated.output);
    const signal=context.controller.signal;let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const result=await quota.run(async()=>{
        const active=store.dispatch(context.id,context.attempt,Math.max(0,now()-context.attempt.receivedAt));
        timer=setTimeout(()=>context.controller.abort(),active);timer.unref?.();
        const response=await upstreamRequest(fetcher,ENDPOINT,{method:'POST',headers:{authorization:`Bearer ${options.apiKey}`,'content-type':'application/json',accept:validated.body.stream?'text/event-stream, application/json':'application/json'},body:JSON.stringify(validated.body),signal});
        const contentType=(response.headers.get('content-type')??'').split(';')[0]!.trim();let usage:Record<string,unknown>|undefined;
        let payload:unknown,wire:string|undefined;
        if(contentType==='text/event-stream'){
          const events:unknown[]=[];let finished=false;
          for await(const event of readSse(response,signal)){
            if(event==='[DONE]')break;
            const current=inspect(event);if(current)usage={...usage,...current};
            if(object(event)&&Array.isArray(event.choices)&&event.choices.some(choice=>object(choice)&&typeof choice.finish_reason==='string'&&choice.finish_reason.length>0))finished=true;
            events.push(event);
          }
          if(!finished)fail('TRUNCATED_RESPONSE',502);
          if(validated.body.stream!==true)fail('UPSTREAM_STREAM_MISMATCH',502);
          wire=events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')+'data: [DONE]\n\n';
        }else if(contentType==='application/json'){
          payload=await readJson(response,signal);usage=inspect(payload);
          if(validated.body.stream===true&&object(payload)){
            const choices=(payload.choices as Record<string,unknown>[]).map(choice=>({...choice,delta:choice.message,message:undefined}));
            wire=`data: ${JSON.stringify({...payload,object:'chat.completion.chunk',choices})}\n\ndata: [DONE]\n\n`;
          }
        }else{void response.body?.cancel().catch(()=>{});fail('UNSUPPORTED_MEDIA_TYPE',502);}
        const reported=reportedUsage(usage);
        await recordTrace(context,'response',{model:MODEL_ID,contentType,...(payload!==undefined?{payload}:{}),...(wire!==undefined?{wire,forwardedSseSha256:createHash('sha256').update(wire).digest('hex')}:{payloadJsonSha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex')}),...(reported!==undefined?{reportedUsage:reported}:{}),dispatchAt:context.attempt.dispatchAt});
        context.finished=true;
        store.finish(context.id,context.attempt,reported?'USAGE_RECONCILED':'MISSING_USAGE',reported,Math.max(0,now()-context.attempt.dispatchAt!));
        return {payload,wire};
      },signal,async()=>{
        const wait=Math.max(0,store.lastDispatchAt()+interval-now());if(wait)await delay(wait,undefined,{signal});
        const route=await preflightFreeRoute({fetch:fetcher,signal});
        if(route.maxCompletionTokens!==undefined&&validated.output>route.maxCompletionTokens)fail('OUTPUT_LIMIT_EXCEEDED');
      });
      if(result.wire!==undefined)return reply.type('text/event-stream; charset=utf-8').header('cache-control','no-cache').send(result.wire);
      return reply.send(result.payload);
    }catch(error){if(!context.finished){context.finished=true;store.finish(context.id,context.attempt,signal.aborted?'ABORTED':'UPSTREAM_FAILED');}throw error;}
    finally{if(timer)clearTimeout(timer);controllers.delete(context.controller);}
  });
  let closed=false;
  return {
    app,
    registerTrial:(input:{id:string;token:string;budget?:Partial<Budget>})=>store.register(input),
    recordInfrastructureRestart:(id:string)=>store.recordInfrastructureRestart(id),
    snapshot:async()=>({model:MODEL_ID,traceSchemaVersion:1,traceDirectory,trials:store.snapshot(),quota:await quota.snapshot(),minimumDispatchIntervalMs:interval}),
    listen:async(test?:{host:'127.0.0.1';port:number})=>{
      store.snapshot();
      if(test){if(!options.fetch)throw new TypeError('Loopback listen is test-only');return app.listen(test);}
      if(!options.socketPath)throw new TypeError('socketPath is required');
      await mkdir(join(options.socketPath,'..'),{recursive:true,mode:0o700});
      try{await lstat(options.socketPath);fail('SOCKET_ALREADY_EXISTS',503);}catch(error){if(!object(error)||error.code!=='ENOENT')throw error;}
      const address=await app.listen({path:options.socketPath});if(process.platform!=='win32')await chmod(options.socketPath,0o600);return address;
    },
    close:async()=>{if(closed)return;closed=true;for(const controller of controllers)controller.abort();try{await app.close();}finally{store.close();}},
  };
}
