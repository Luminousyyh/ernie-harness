import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {join} from 'node:path';
import {createModelBroker} from '../src/broker/index.js';
import {MODEL_ID} from '../src/contracts/index.js';
import {CATALOG_URL, SerialQuota} from '../src/provider/index.js';

const roots:string[]=[];
const brokers:ReturnType<typeof createModelBroker>[]=[];
afterEach(async()=>{for(const broker of brokers.splice(0))await broker.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function root(){const value=mkdtempSync(join(tmpdir(),'ernie-broker-test-'));roots.push(value);return value;}
const body={model:MODEL_ID,messages:[{role:'user',content:'hello'}],max_tokens:100};
const headers={authorization:'Bearer fake-trial-token'};
function catalog(price='0'){return Response.json({data:{id:MODEL_ID,endpoints:[{model_id:MODEL_ID,provider_name:'Baidu',tag:'baidu',pricing:{prompt:'0',completion:price},supported_parameters:['reasoning','reasoning_effort','tools','tool_choice','response_format'],max_completion_tokens:16384}]}});}
function completion(usage:unknown={prompt_tokens:11,completion_tokens:9,completion_tokens_details:{reasoning_tokens:6}}){return {id:'response-test',object:'chat.completion',model:MODEL_ID,provider:'Baidu',choices:[{index:0,message:{role:'assistant',content:'ok',reasoning_details:[{type:'reasoning.text',text:'reason'}]},finish_reason:'stop'}],...(usage===null?{}:{usage})};}
function setup(options:{stateDir?:string;quotaPath?:string;price?:string;response?:()=>Response|Promise<Response>;clock?:()=>number}={}){
 const calls:{url:string;init?:RequestInit}[]=[];
 const fetcher=(async(url:unknown,init?:RequestInit)=>{calls.push({url:String(url),init});return String(url)===CATALOG_URL?catalog(options.price):options.response?options.response():Response.json(completion());}) as typeof fetch;
 const broker=createModelBroker({apiKey:'test-provider-secret',stateDir:options.stateDir??root(),quotaPath:options.quotaPath,fetch:fetcher,minimumDispatchIntervalMs:0,...(options.clock?{now:options.clock}:{})});brokers.push(broker);return {broker,calls};
}
async function send(broker:ReturnType<typeof createModelBroker>,payload:unknown=body){return broker.app.inject({method:'POST',url:'/v1/chat/completions',headers,payload:payload as object});}
async function trial(broker:ReturnType<typeof createModelBroker>){return (await broker.snapshot()).trials[0]!;}

describe('trusted evaluation model broker (offline HTTP fixtures, no live model evidence)',()=>{
 it('rejects alternate models, paid catalog routes and client routing overrides before completion dispatch',async()=>{
  const {broker,calls}=setup({price:'0.01'});await broker.registerTrial({id:'trial',token:'fake-trial-token'});
  expect((await send(broker,{...body,model:'other/model'})).statusCode).toBe(400);
  expect((await send(broker,{...body,provider:{allow_fallbacks:true}})).statusCode).toBe(400);
  expect((await send(broker)).statusCode).toBe(503);
  expect(calls.every(call=>call.url===CATALOG_URL)).toBe(true);expect((await trial(broker)).usage.calls).toBe(3);
 });
 it('forwards native tools, tool choice, structured outputs and reasoning, pins routing, and does not count reasoning twice',async()=>{
  const {broker,calls}=setup();await broker.registerTrial({id:'trial',token:'fake-trial-token'});
  const native={...body,tools:[{type:'function',function:{name:'edit',parameters:{type:'object'},strict:true}}],tool_choice:{type:'function',function:{name:'edit'}},response_format:{type:'json_schema',json_schema:{name:'result',schema:{type:'object'}}},reasoning:{effort:'high',exclude:false},parallel_tool_calls:false};
  const response=await send(broker,native);expect(response.statusCode).toBe(200);expect(response.json().choices[0].message.reasoning_details).toHaveLength(1);
  const upstream=JSON.parse(String(calls.find(call=>call.url!==CATALOG_URL)!.init!.body));
  expect(upstream).toMatchObject(native);expect(upstream.provider).toEqual({only:['baidu'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:0,completion:0}});
  expect(calls[0]!.init!.headers).not.toHaveProperty('authorization');
  expect((await trial(broker)).usage).toMatchObject({calls:1,inputTokens:11,outputTokens:9,reasoningTokens:6});
  expect(JSON.stringify(await broker.snapshot())).not.toContain('test-provider-secret');
 });
 it('applies identical sampling for omitted and harness-specific request defaults',async()=>{
  const {broker,calls}=setup();await broker.registerTrial({id:'trial',token:'fake-trial-token'});
  for(const sampling of [{},{temperature:0.8,top_p:0.7,top_k:12,min_p:0.2,seed:13,reasoning_effort:'high',include_reasoning:false,reasoning:{effort:'high',max_tokens:1},frequency_penalty:1,presence_penalty:1,repetition_penalty:1.2,logit_bias:{'17':8}}])expect((await send(broker,{...body,...sampling})).statusCode).toBe(200);
  for(const call of calls.filter(call=>call.url!==CATALOG_URL)){
   const sent=JSON.parse(String(call.init!.body));expect(sent).toMatchObject({temperature:0,top_p:1});expect(sent.reasoning).toEqual({effort:'high',exclude:false});
   for(const parameter of ['reasoning_effort','include_reasoning','top_k','min_p','seed','frequency_penalty','presence_penalty','repetition_penalty','logit_bias'])expect(sent).not.toHaveProperty(parameter);
  }
 });
 it('fixes high reasoning for every harness and rejects lower effort or disabled reasoning before dispatch',async()=>{
  const {broker,calls}=setup();await broker.registerTrial({id:'trial',token:'fake-trial-token'});
  for(const override of [{reasoning:{effort:'medium'}},{reasoning_effort:'low'},{reasoning:{enabled:false}},{reasoning:{effort:'none'}},{reasoning:'high'}]){
   const response=await send(broker,{...body,...override});expect(response.statusCode).toBe(400);expect(response.json().error.code).toBe('HIGH_REASONING_REQUIRED');
  }
  expect(calls).toHaveLength(0);
  expect((await send(broker)).statusCode).toBe(200);
  expect((await send(broker,{...body,reasoning_effort:'high',reasoning:{effort:'high',exclude:false}})).statusCode).toBe(200);
  for(const call of calls.filter(call=>call.url!==CATALOG_URL))expect(JSON.parse(String(call.init!.body)).reasoning).toMatchObject({effort:'high',exclude:false});
 });
 it('cancels upstream on a real HTTP socket disconnect and durably retains the uncertain reservation',async()=>{
  let started!:()=>void,aborted!:()=>void;
  const upstreamStarted=new Promise<void>(resolve=>{started=resolve;}),upstreamAborted=new Promise<void>(resolve=>{aborted=resolve;});
  const fetcher=(async(url:unknown,init?:RequestInit)=>{
   if(String(url)===CATALOG_URL)return catalog();
   return new Promise<Response>((_resolve,reject)=>{
    const signal=init!.signal!;signal.addEventListener('abort',()=>{aborted();reject(new DOMException('Request aborted','AbortError'));},{once:true});started();
   });
  }) as typeof fetch;
  const stateDir=root();const broker=createModelBroker({apiKey:'test-provider-secret',stateDir,fetch:fetcher,minimumDispatchIntervalMs:0});brokers.push(broker);
  await broker.registerTrial({id:'trial',token:'fake-trial-token'});await broker.listen({host:'127.0.0.1',port:0});
  const address=broker.app.server.address();if(!address||typeof address==='string')throw Error('Expected local TCP listener');
  const client=httpRequest({host:'127.0.0.1',port:address.port,method:'POST',path:'/v1/chat/completions',headers:{...headers,'content-type':'application/json'}},response=>response.resume());
  client.on('error',()=>{});client.end(JSON.stringify({...body,stream:true}));
  try{
   await upstreamStarted;
   const reserved=JSON.parse(readFileSync(join(stateDir,'broker-state.json'),'utf8')).trials[0];
   expect(reserved.attempts[0].status).toBe('dispatched');expect(reserved.usage.outputTokens).toBe(100);expect(reserved.usage.activeMs).toBe(1800000);
   client.destroy();await upstreamAborted;
   await expect.poll(async()=>(await trial(broker)).attempts[0]).toMatchObject({status:'uncertain',code:'ABORTED'});
   const snapshot=await broker.snapshot(),state=snapshot.trials[0]!;
   expect(state.attempts[0]).toMatchObject({status:'uncertain',code:'ABORTED'});expect(state.usage).toMatchObject({calls:1,outputTokens:100,activeMs:1800000});expect(state.usage.inputTokens).toBeGreaterThan(0);expect(snapshot.quota.dayUsed).toBe(1);
  }finally{client.destroy();}
 });
 it('keeps missing-usage reservations and call limits across restart and idempotent registration',async()=>{
  const stateDir=root();let first=setup({stateDir,response:()=>Response.json(completion(null))});
  await first.broker.registerTrial({id:'trial',token:'fake-trial-token',budget:{maxCalls:2}});
  expect((await send(first.broker)).statusCode).toBe(200);const before=await trial(first.broker);
  expect(before.usage.outputTokens).toBe(100);expect(before.attempts[0]!.status).toBe('uncertain');await first.broker.close();
  const second=setup({stateDir});await second.broker.registerTrial({id:'trial',token:'fake-trial-token'});await second.broker.registerTrial({id:'trial',token:'fake-trial-token'});
  expect((await trial(second.broker)).usage).toEqual(before.usage);expect((await trial(second.broker)).infrastructureRestarts).toBe(1);
  expect((await send(second.broker)).statusCode).toBe(200);expect((await send(second.broker)).statusCode).toBe(429);
  expect(second.calls.filter(call=>call.url!==CATALOG_URL)).toHaveLength(1);
  expect(readFileSync(join(stateDir,'broker-state.json'),'utf8')).not.toContain('fake-trial-token');
 });
 it('shares an authoritative quota across separate durable budgets and restarts without increasing the fifty-call limit',async()=>{
  const quotaPath=join(root(),'shared-quota.json'),stateDir=root();let now=Date.UTC(2026,10,12,0);
  const shared=new SerialQuota({path:quotaPath,now:()=>now});
  // Seed offline reservations, never model calls, leaving exactly two global calls.
  for(let i=0;i<48;i++){await shared.reserve();now+=61000;}
  const first=setup({stateDir,quotaPath,clock:()=>now}),second=setup({quotaPath,clock:()=>now});
  await first.broker.registerTrial({id:'formal',token:'fake-trial-token'});await second.broker.registerTrial({id:'smoke',token:'fake-trial-token'});
  expect((await send(first.broker)).statusCode).toBe(200);now+=61000;
  expect((await send(second.broker)).statusCode).toBe(200);
  const before=await trial(first.broker);expect(before.usage.calls).toBe(1);expect((await trial(second.broker)).usage.calls).toBe(1);
  expect((await first.broker.snapshot()).quota).toMatchObject({dayUsed:50,dailyLimit:50});
  await first.broker.close();const recovered=setup({stateDir,quotaPath,clock:()=>now});await recovered.broker.registerTrial({id:'formal',token:'fake-trial-token'});
  expect((await trial(recovered.broker)).usage).toEqual(before.usage);
  const exhausted=await send(recovered.broker);expect(exhausted.statusCode).toBe(429);expect(exhausted.json().error.code).toBe('DAILY_QUOTA_EXHAUSTED');
  expect(recovered.calls.filter(call=>call.url!==CATALOG_URL)).toHaveLength(0);
  expect((await recovered.broker.snapshot()).quota).toMatchObject({dayUsed:50,dailyLimit:50});expect((await trial(second.broker)).usage.calls).toBe(1);
 });
 it('retains a predispatch reservation when the upstream connection fails',async()=>{
  const {broker}=setup({response:()=>{throw new Error('unsafe secret echoed from upstream');}});await broker.registerTrial({id:'trial',token:'fake-trial-token'});
  const response=await send(broker);expect(response.statusCode).toBe(502);expect(response.body).not.toContain('unsafe secret');
  const state=await trial(broker);expect(state.usage.outputTokens).toBe(100);expect(state.usage.activeMs).toBe(1800000);expect(state.attempts[0]!.status).toBe('uncertain');
 });
 it('checks the catalog for each dispatch and refuses unsupported policy or oversized bodies without a completion',async()=>{
  const {broker,calls}=setup();await broker.registerTrial({id:'trial',token:'fake-trial-token'});
  expect((await send(broker)).statusCode).toBe(200);expect((await send(broker)).statusCode).toBe(200);expect(calls.filter(call=>call.url===CATALOG_URL)).toHaveLength(2);
  expect((await send(broker,{...body,max_tokens:16385})).statusCode).toBe(400);
  expect((await send(broker,{...body,route:'fallback'})).statusCode).toBe(400);
  expect((await send(broker,{...body,messages:[{role:'user',content:'x'.repeat(16*1024*1024)}]})).statusCode).toBe(413);
  expect(calls.filter(call=>call.url!==CATALOG_URL)).toHaveLength(2);expect((await trial(broker)).usage.calls).toBe(5);
  expect((await broker.app.inject({method:'POST',url:'/admin/register',headers,payload:{}})).statusCode).toBe(404);
 });
 it('forwards fragmented UTF-8 SSE, final tool calls and usage without fabricating content',async()=>{
  const events=[{id:'s',model:MODEL_ID,choices:[{index:0,delta:{role:'assistant',reasoning_details:[{type:'reasoning.text',text:'思考'}]},finish_reason:null}]},{id:'s',choices:[{index:0,delta:{tool_calls:[{index:0,id:'tool1',type:'function',function:{name:'edit',arguments:'{"x":1}'}}]},finish_reason:'tool_calls'}]},{id:'s',choices:[],usage:{prompt_tokens:5,completion_tokens:10,completion_tokens_details:{reasoning_tokens:7}}}];
  const bytes=new TextEncoder().encode(events.map(event=>`data: ${JSON.stringify(event)}\r\n\r\n`).join('')+'data: [DONE]\r\n\r\n');
  const {broker}=setup({response:()=>new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}}),{headers:{'content-type':'text/event-stream'}})});
  await broker.registerTrial({id:'trial',token:'fake-trial-token'});const response=await send(broker,{...body,stream:true});expect(response.statusCode).toBe(200);expect(response.body).toContain('思考');expect(response.body).toContain('tool1');expect(response.body).toContain('[DONE]');expect((await trial(broker)).usage).toMatchObject({inputTokens:5,outputTokens:10,reasoningTokens:7});
 });
});
