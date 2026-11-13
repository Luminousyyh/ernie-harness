import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as provider from '../src/provider/index.js';
import {MODEL_ID,type ModelRequest} from '../src/contracts/index.js';
const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})));
const catalog=(extra={})=>({data:{id:MODEL_ID,endpoints:[{provider_name:'Baidu',model_id:MODEL_ID,tag:'baidu',status:0,pricing:{prompt:'0',completion:'0'},context_length:1024000,supported_parameters:['reasoning','reasoning_effort','tools'],...extra}]}});
const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
describe('read-only model capabilities',()=>{
 it('exports a mountable inspector',()=>expect(provider.inspectModelCapabilities).toBeTypeOf('function'));
 it('never treats generic support or a mock as verified effort',async()=>{
  const fetcher=vi.fn(async()=>json(catalog()));
  const result=await provider.inspectModelCapabilities({fetch:fetcher as typeof fetch});
  expect(result).toMatchObject({status:'available',model:MODEL_ID,contextLength:1024000,reasoning:{advertised:[],verified:[],selected:'high'}});
  expect(result.reasoning.reason).toContain('尚未提供真实调用');expect(result.checkedAt).toMatch(/^\d{4}-/);expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe(provider.CATALOG_URL);
 });
 it('reports only explicitly listed efforts and supplied live verification for high',async()=>{
  const result=await provider.inspectModelCapabilities({fetch:(async()=>json(catalog({supported_reasoning_efforts:['high','low']}))) as typeof fetch,verifiedReasoning:['high']});
  expect(result.reasoning).toMatchObject({advertised:['high','low'],verified:['high'],selected:'high'});
  expect(result.reasoning.reason).toContain('真实调用');
 });
 it('returns a safe unavailable snapshot without leaking upstream details',async()=>{
  const result=await provider.inspectModelCapabilities({fetch:(async()=>{throw new Error('secret-from-upstream');}) as typeof fetch,verifiedReasoning:['high']});
  expect(result.status).toBe('unavailable');expect(result.reasoning.reason).toContain('历史证据');expect(JSON.stringify(result)).not.toContain('secret-from-upstream');
  expect(result.reasoning.verified).toEqual(['high']);
 });
 it('does not validate free reasoning routes when routing/pricing is unsafe',async()=>{
  const result=await provider.inspectModelCapabilities({fetch:(async()=>json(catalog({pricing:{prompt:'0',completion:'0.001'}}))) as typeof fetch});
  expect(result.status).toBe('unavailable');expect(result.reasoning.reason).toContain('尚未提供真实调用');expect(result.reasoning.verified).toEqual([]);
 });
});
describe('reasoning selection and request bounds',()=>{
 function transport(fetcher:typeof fetch){const dir=mkdtempSync(join(tmpdir(),'ernie-effort-'));dirs.push(dir);return new provider.OpenRouterTransport({apiKey:'test-key',fetch:fetcher,quota:new provider.SerialQuota({path:join(dir,'quota.json')})});}
 it('rejects unsupported effort before any fetch or quota dispatch',async()=>{
  const fetcher=vi.fn();const model=transport(fetcher as typeof fetch);
  await expect(model.complete({messages:[{role:'user',content:'hi'}],reasoningEffort:'low'} as unknown as ModelRequest)).rejects.toMatchObject({code:'UNSUPPORTED_REASONING_EFFORT'});
  expect(fetcher).not.toHaveBeenCalled();expect(model.snapshot().completionAttempts).toBe(0);
 });
 it('reserves completion room in the declared route window before dispatch',async()=>{
  const fetcher=vi.fn(async()=>json(catalog({context_length:100})));
  const model=transport(fetcher as typeof fetch);
  await expect(model.complete({messages:[{role:'system',content:'x'.repeat(60)}],maxTokens:50})).rejects.toMatchObject({code:'CONTEXT_LIMIT_EXCEEDED'});
  expect(model.snapshot().completionAttempts).toBe(0);expect(fetcher).toHaveBeenCalledTimes(1);
 });
});
// Main's service loads this module directly; keep the public inspector available here.
it('exports capability inspection from the catalog mount path',async()=>{const catalogModule=await import('../src/provider/catalog.js');expect(catalogModule.inspectModelCapabilities).toBeTypeOf('function');});
it('rejects a route that explicitly excludes the configured high effort',async()=>{
 const result=await provider.inspectModelCapabilities({fetch:(async()=>json(catalog({supported_reasoning_efforts:['low']}))) as typeof fetch});expect(result.status).toBe('unavailable');
});
