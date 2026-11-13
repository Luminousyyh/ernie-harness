import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MODEL_ID} from '../src/contracts/index.js';
import {ApiError, OpenRouterTransport, probeCapabilities, SerialQuota} from '../src/provider/index.js';

const dirs:string[]=[];
function quota() { const dir=mkdtempSync(join(tmpdir(),'ernie-provider-'));dirs.push(dir);return new SerialQuota({path:join(dir,'quota.json')}); }
afterEach(()=>{vi.restoreAllMocks();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const modelCatalog=()=>({data:{id:MODEL_ID,endpoints:[{provider_name:'Baidu',tag:'baidu',model_id:MODEL_ID,status:0,pricing:{prompt:'0',completion:'0',discount:0},context_length:1024000,max_completion_tokens:921600,supported_parameters:['reasoning','reasoning_effort','tools','tool_choice','response_format']}]}});
const json=(body:unknown,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
function stream(events:unknown[], chunk=13) {
 const text=': keepalive\r\n\r\n'+events.map(event=>`data: ${typeof event==='string'?event:JSON.stringify(event)}\r\n\r\n`).join('');
 const bytes=new TextEncoder().encode(text);let offset=0;
 return new Response(new ReadableStream({pull(controller){if(offset>=bytes.length){controller.close();return;}controller.enqueue(bytes.slice(offset,offset+chunk));offset+=chunk;}}),{headers:{'content-type':'text/event-stream'}});
}
const frame=(delta:unknown,finish_reason:string|null=null)=>({model:MODEL_ID,provider:'Baidu',choices:[{index:0,delta,finish_reason}]});
const completion=()=>({model:MODEL_ID,provider:'Baidu',choices:[{message:{role:'assistant',content:'完成'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:8,completion_tokens_details:{reasoning_tokens:5}}});
function setup(response:()=>Response,catalog=modelCatalog()) {
 const fetcher=vi.fn(async (url:unknown)=>String(url).includes('/endpoints')?json(catalog):response());
 return {fetcher,transport:new OpenRouterTransport({apiKey:'test-only-secret-value',fetch:fetcher as typeof fetch,quota:quota()})};
}
const request={messages:[{role:'user' as const,content:'处理任务'}]};

describe('OpenRouter transport',()=>{
 it('assembles split UTF-8, interleaved tool arguments, reasoning and terminal usage without double counting',async()=>{
  const {transport,fetcher}=setup(()=>stream([
   frame({reasoning_details:[{index:0,type:'reasoning.text',text:'先',signature:'sig'}]}),
   frame({reasoning_details:[{index:0,type:'reasoning.text',text:'分析'}],tool_calls:[{index:1,id:'second',type:'function',function:{name:'read_file',arguments:'{"path":"b'}}]}),
   frame({content:'中文',tool_calls:[{index:0,id:'first',type:'function',function:{name:'read_',arguments:'{"path":'}}]}),
   frame({tool_calls:[{index:0,function:{name:'file',arguments:'"a"}'}},{index:1,function:{arguments:'"}'}}]},'tool_calls'),
   {...frame({},'tool_calls'),usage:{prompt_tokens:11,completion_tokens:19,completion_tokens_details:{reasoning_tokens:12}}},'[DONE]'
  ],1));
  const deltas:unknown[]=[];const result=await transport.complete(request,d=>deltas.push(d));
  expect(result.message.content).toBe('中文');expect(result.message.tool_calls?.map(c=>c.function)).toEqual([{name:'read_file',arguments:'{"path":"a"}'},{name:'read_file',arguments:'{"path":"b"}'}]);
  expect(result.message.reasoning_details).toEqual([{index:0,type:'reasoning.text',text:'先分析',signature:'sig'}]);
  expect(result.usage).toEqual({inputTokens:11,outputTokens:19,reasoningTokens:12,inputEstimated:false,outputEstimated:false,reasoningEstimated:false});
  expect(deltas).toContainEqual({type:'text',text:'中文'});
  const body=JSON.parse((fetcher.mock.calls[1] as unknown as [string,RequestInit])[1].body as string);
  expect(body.model).toBe(MODEL_ID);expect(body.reasoning).toEqual({effort:'high',exclude:false});
  expect(body.provider).toMatchObject({only:['baidu'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:0,completion:0}});
 });
 it('replays opaque reasoning and a failed tool result unmodified',async()=>{
  const {transport,fetcher}=setup(()=>json(completion()));
  const history=[...request.messages,{role:'assistant' as const,content:null,reasoning_details:[{type:'reasoning.encrypted',data:'opaque',id:'r1',format:'provider-v1'}],tool_calls:[{id:'t1',type:'function' as const,function:{name:'read_file',arguments:'{"path":"a"}'}}]},{role:'tool' as const,tool_call_id:'t1',content:'{"ok":false,"output":"not found"}'}];
  const before=JSON.stringify(history);await transport.complete({messages:history});
  const body=JSON.parse((fetcher.mock.calls[1] as unknown as [string,RequestInit])[1].body as string);
  expect(body.messages).toEqual(history);expect(JSON.stringify(history)).toBe(before);expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('accepts a valid JSON completion on the original request without retrying',async()=>{
  const {transport,fetcher}=setup(()=>json(completion()));const result=await transport.complete(request);
  expect(result.usage.outputTokens).toBe(8);expect(result.usage.reasoningTokens).toBe(5);expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('marks missing usage as estimated and includes reasoning in output estimate exactly once',async()=>{
  const {transport}=setup(()=>stream([frame({content:'answer',reasoning:'thinking'},'stop'),'[DONE]']));
  const result=await transport.complete(request);expect(result.usage.estimated).toBe(true);expect(result.usage.inputTokens).toBeGreaterThan(0);expect(result.usage.outputTokens).toBeGreaterThanOrEqual(result.usage.reasoningTokens);
 });
 it.each(['paid','wrong-provider','wrong-model','missing-prices','paid-request'])('fails closed for %s catalog before any generation',async(kind)=>{
  const catalog=modelCatalog();const endpoint=catalog.data.endpoints[0];
  if(kind==='paid')endpoint.pricing.prompt='0.0001';if(kind==='wrong-provider')endpoint.provider_name='Other';if(kind==='wrong-model')catalog.data.id='different' as typeof MODEL_ID;if(kind==='missing-prices')delete (endpoint.pricing as Partial<typeof endpoint.pricing>).completion;if(kind==='paid-request')Object.assign(endpoint.pricing,{request:'0.001'});
  const {transport,fetcher}=setup(()=>json(completion()),catalog);await expect(transport.complete(request)).rejects.toMatchObject({code:'FREE_ROUTE_UNAVAILABLE',retryable:false});expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('refreshes catalog on every completion and refuses a price change',async()=>{
  let gets=0;const fetcher=vi.fn(async(url:unknown)=>{if(String(url).includes('/endpoints')){const data=modelCatalog();if(++gets>1)data.data.endpoints[0].pricing.completion='1';return json(data);}return json(completion());});
  const transport=new OpenRouterTransport({apiKey:'test-only-secret-value',fetch:fetcher as typeof fetch,quota:quota()});await transport.complete(request);await expect(transport.complete(request)).rejects.toMatchObject({code:'FREE_ROUTE_UNAVAILABLE'});expect(fetcher).toHaveBeenCalledTimes(3);
 });
 it('returns sanitized 429 and Retry-After without automatic retry',async()=>{
  const {transport,fetcher}=setup(()=>json({error:{message:'Authorization: Bearer test-only-secret-value',metadata:{api_key:'another-secret'}}},429,{'retry-after':'2'}));
  let caught:unknown;try{await transport.complete(request);}catch(e){caught=e;}
  expect(caught).toBeInstanceOf(ApiError);expect(caught).toMatchObject({status:429,retryAfterMs:2000,retryable:true});expect(JSON.stringify(caught)).not.toContain('secret');expect(String(caught)).not.toContain('secret');expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('rejects malformed/truncated tool arguments and mid-stream errors',async()=>{
  const {transport}=setup(()=>stream([frame({tool_calls:[{index:0,id:'t',function:{name:'write_file',arguments:'{"path":'}}]},'tool_calls'),'[DONE]']));
  await expect(transport.complete(request)).rejects.toMatchObject({code:'INVALID_TOOL_CALL'});
  const other=setup(()=>stream([frame({content:'partial'}),{error:{code:503,message:'private provider text'}}]));await expect(other.transport.complete(request)).rejects.toMatchObject({status:503,retryable:true});
 });
 it('rejects early EOF, a different model or provider, and unsupported media types',async()=>{
  for(const response of [()=>stream([frame({content:'partial'})]),()=>json({...completion(),model:'paid-model'}),()=>json({...completion(),provider:'Other'}),()=>new Response('<html>oops</html>',{headers:{'content-type':'text/html'}})]){
   await expect(setup(response).transport.complete(request)).rejects.toBeInstanceOf(ApiError);
  }
 });
 it('aborts a pending stream read and cancels its reader',async()=>{
  const cancel=vi.fn();const controller=new AbortController();let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});const {transport}=setup(()=>new Response(new ReadableStream({pull(){started();},cancel}),{headers:{'content-type':'text/event-stream'}}));
  const running=transport.complete(request,undefined,controller.signal);await ready;controller.abort();await expect(running).rejects.toMatchObject({name:'AbortError'});expect(cancel).toHaveBeenCalled();
 });
 it('does no work when already aborted',async()=>{const {transport,fetcher}=setup(()=>json(completion()));const controller=new AbortController();controller.abort();await expect(transport.complete(request,undefined,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(fetcher).not.toHaveBeenCalled();});
 it('uses loopback broker and never sends authorization to public catalog',async()=>{
  const fetcher=vi.fn(async(url:unknown)=>String(url).includes('/endpoints')?json(modelCatalog()):json(completion()));const transport=new OpenRouterTransport({apiKey:'broker-token',baseUrl:'http://127.0.0.1:9911/api/v1',fetch:fetcher as typeof fetch,quota:quota()});await transport.complete(request);
  expect(String(fetcher.mock.calls[0][0])).toBe(`https://openrouter.ai/api/v1/models/${MODEL_ID}/endpoints`);
  const calls=fetcher.mock.calls as unknown as [string,RequestInit][];expect(new Headers(calls[0][1]?.headers).has('authorization')).toBe(false);expect(String(calls[1][0])).toBe('http://127.0.0.1:9911/api/v1/chat/completions');
 });
 it('metadata probe makes no generation call and labels capabilities untested',async()=>{
  const fetcher=vi.fn(async()=>json(modelCatalog()));const result=await probeCapabilities('test-only-secret-value',{fetch:fetcher as typeof fetch});expect(result.model).toBe(MODEL_ID);expect(result.liveVerified).toBe(false);expect(result.tools).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);
 });
});

describe('provider boundary regressions',()=>{
 it('uses explicitly selected supported JSON mode with no implicit retries',async()=>{
  const fetcher=vi.fn(async(url:unknown)=>String(url).includes('/endpoints')?json(modelCatalog()):json(completion()));
  const transport=new OpenRouterTransport({apiKey:'synthetic',fetch:fetcher as typeof fetch,quota:quota(),responseMode:'json'});
  await transport.complete(request);const calls=fetcher.mock.calls as unknown as [string,RequestInit][];expect(JSON.parse(calls[1][1].body as string).stream).toBe(false);expect(transport.snapshot()).toMatchObject({catalogRequests:1,completionAttempts:1,responseMode:'json'});
 });
 it('handles multiline SSE data, a usage-only event and a final event without blank line',async()=>{
  const text='data: '+JSON.stringify(frame({content:'ok'},'stop')).replace(',"provider"',',\ndata: "provider"')+'\n\n'+`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:4,completion_tokens:2,completion_tokens_details:{reasoning_tokens:1}}})}\n\ndata: [DONE]`;
  const {transport}=setup(()=>new Response(text,{headers:{'content-type':'text/event-stream'}}));const result=await transport.complete(request);expect(result.message.content).toBe('ok');expect(result.usage).toEqual({inputTokens:4,outputTokens:2,reasoningTokens:1,inputEstimated:false,outputEstimated:false,reasoningEstimated:false});
 });
 it('fails closed on oversized responses, negative usage, or nonzero cost',async()=>{
  const oversized=()=>new Response('x',{headers:{'content-type':'application/json','content-length':String(32*1024*1024)}});
  const negative=()=>json({...completion(),usage:{prompt_tokens:-1,completion_tokens:0}});
  const billed=()=>json({...completion(),usage:{prompt_tokens:1,completion_tokens:1,cost:0.1}});
  for(const response of [oversized,negative,billed])await expect(setup(response).transport.complete(request)).rejects.toBeInstanceOf(ApiError);
 });
 it('does not expose a rejected fetch error that echoes a secret',async()=>{
  const fetcher=vi.fn(async(url:unknown)=>{if(String(url).includes('/endpoints'))return json(modelCatalog());throw new Error('Bearer synthetic-private-api-key');});
  const transport=new OpenRouterTransport({apiKey:'synthetic-private-api-key',fetch:fetcher as typeof fetch,quota:quota()});let error:unknown;try{await transport.complete(request);}catch(e){error=e;}expect(String(error)).not.toContain('synthetic-private-api-key');expect(error).toMatchObject({code:'NETWORK_ERROR'});
 });
 it('rejects remote insecure brokers and URL credentials before networking',()=>{
  for(const baseUrl of ['http://example.com','https://attacker.example','https://user:secret@openrouter.ai/api/v1'])expect(()=>new OpenRouterTransport({apiKey:'synthetic',baseUrl})).toThrow();
 });
});

it('performs the route preflight after entering the serialized generation turn',async()=>{
 let release!:()=>void;let started!:()=>void;let gets=0;const gate=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{started=resolve;});
 const fetcher=vi.fn(async(url:unknown)=>{if(String(url).includes('/endpoints')){gets++;return json(modelCatalog());}started();await gate;return json(completion());});
 const transport=new OpenRouterTransport({apiKey:'synthetic',fetch:fetcher as typeof fetch,quota:quota()});const first=transport.complete(request);await ready;const second=transport.complete(request);await new Promise(resolve=>setTimeout(resolve,20));const early=gets;release();await Promise.all([first,second]);expect(early).toBe(1);expect(gets).toBe(2);
});

it('preserves fragmented opaque reasoning signatures and replays the assembled block',async()=>{
 const {transport}=setup(()=>stream([frame({reasoning_details:[{index:0,type:'reasoning.text',text:'think',signature:'sig'}]}),frame({reasoning_details:[{index:0,type:'reasoning.text',signature:'nature'}],content:'done'},'stop'),'[DONE]']));
 const result=await transport.complete(request);expect(result.message.reasoning_details).toEqual([{index:0,type:'reasoning.text',text:'think',signature:'signature'}]);
});

it('keeps an estimated reasoning breakdown within the reported completion total',async()=>{
 const {transport}=setup(()=>json({...completion(),choices:[{message:{role:'assistant',content:'ok',reasoning:'a long reasoning string with a missing token breakdown'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2}}));
 const result=await transport.complete(request);expect(result.usage.estimated).toBe(true);expect(result.usage.outputTokens).toBe(2);expect(result.usage.reasoningTokens).toBeLessThanOrEqual(2);
});
describe('native usage field provenance',()=>{
 it('marks missing input independently of reported output and reasoning',async()=>{
  const{transport}=setup(()=>json({...completion(),usage:{completion_tokens:8,completion_tokens_details:{reasoning_tokens:2}}}));
  expect((await transport.complete(request)).usage).toMatchObject({estimated:true,inputEstimated:true,outputEstimated:false,reasoningEstimated:false});
 });
 it('marks missing output independently of reported input and reasoning',async()=>{
  const{transport}=setup(()=>json({...completion(),usage:{prompt_tokens:123,completion_tokens_details:{reasoning_tokens:2}}}));
  expect((await transport.complete(request)).usage).toMatchObject({inputTokens:123,estimated:true,inputEstimated:false,outputEstimated:true,reasoningEstimated:false});
 });
 it('does not call an absent reasoning breakdown exact when no reasoning text is visible',async()=>{
  const{transport}=setup(()=>json({...completion(),usage:{prompt_tokens:123,completion_tokens:8}}));
  expect((await transport.complete(request)).usage).toMatchObject({inputTokens:123,outputTokens:8,reasoningTokens:0,estimated:true,inputEstimated:false,outputEstimated:false,reasoningEstimated:true});
 });
});
