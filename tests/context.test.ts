import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SqliteStore} from '../src/store/sqlite.js';import {LocalEventBus} from '../src/store/events.js';import {AgentEngine} from '../src/core/engine.js';
import {compactContext,estimateTokens} from '../src/core/context.js';
import type {ChatMessage,ModelRequest,ModelTransport,ToolRegistry} from '../src/contracts/index.js';
const dirs:string[]=[];const stores:SqliteStore[]=[];
afterEach(()=>{stores.splice(0).forEach(s=>s.close());dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'ernie-context-'));dirs.push(dir);const store=new SqliteStore(':memory:');stores.push(store);return{dir,store,bus:new LocalEventBus()};}
const tools:ToolRegistry={definitions:()=>[],async execute(){throw new Error('unexpected tool execution');}};
const response={message:{role:'assistant' as const,content:'done'},usage:{inputTokens:120,outputTokens:3,reasoningTokens:1},model:'test',finishReason:'stop'};
describe('current context',()=>{
 it('includes system, tool schemas and reserved response in the 80 percent compaction trigger',()=>{
  const messages:ChatMessage[]=[{role:'system',content:'policy'},{role:'user',content:'goal'},...Array.from({length:30},(_,i)=>({role:'assistant' as const,content:`message ${i} `+'x'.repeat(100)}))];
  const schema=[{type:'function' as const,function:{name:'large',description:'schema'.repeat(300),parameters:{type:'object'}}}];
  const limit=9000;expect(estimateTokens(messages)).toBeLessThan(limit*.8);
  const result=compactContext(messages,limit,{tools:schema,responseReserve:2000});
  expect(result.compacted).toBe(true);expect(result.retainedSummaryOutline?.length).toBeGreaterThan(0);
 });
 it('does not enlarge a small history or split a retained tool group',()=>{
  const messages:ChatMessage[]=[{role:'system',content:'policy'},{role:'user',content:'goal'},...Array.from({length:15},()=>({role:'assistant' as const,content:'old'.repeat(300)})),{role:'assistant',content:null,reasoning_details:[{opaque:'signature'}],tool_calls:[{id:'a',type:'function',function:{name:'read_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'a',content:'result'}];
  const result=compactContext(messages,4096,{responseReserve:256});
  expect(estimateTokens(result.messages)).toBeLessThan(estimateTokens(messages));
  expect(result.messages.at(-2)?.reasoning_details).toEqual([{opaque:'signature'}]);expect(result.messages.at(-1)?.tool_call_id).toBe('a');
 });
 it('persists provider prompt usage separately from cumulative usage and model capacity',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'x',contextLimit:128000});
  store.updateGoal(g.id,{usage:{...g.usage,inputTokens:500000,calls:2}});
  let sent:ModelRequest|undefined;const model:ModelTransport={contextLength:1024000,async complete(request){sent=request;return response;}};
  await new AgentEngine(store,bus,model,tools).run(g.id,new AbortController().signal);
  const done=store.getGoal(g.id)!;expect(done.context).toMatchObject({contextLimit:128000,modelContextLength:1024000,effectiveLimit:128000,requestInputTokens:120,lastPromptTokens:120,source:'provider-usage',estimated:false,responseReserve:16384,compressionCount:0});
  expect(done.context!.estimatedInputTokens).toBe(estimateTokens({messages:sent!.messages,tools:sent!.tools}));
  expect(done.context!.remainingRatio).toBeCloseTo((128000-16384-120)/128000);expect(done.usage.inputTokens).toBe(500120);
 });
 it('keeps estimates and uncertain reservations on failed requests',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'x'});
  await new AgentEngine(store,bus,{async complete(){throw new Error('network');}},tools).run(g.id,new AbortController().signal);
  expect(store.getGoal(g.id)?.context).toMatchObject({source:'request-estimate',estimated:true,estimateMethod:'utf8-bytes'});expect(store.getGoal(g.id)?.usage.calls).toBe(1);
 });
 it('blocks an indivisible oversized prompt instead of sending past response reserve',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'x'.repeat(10000),contextLimit:4096,budget:{maxOutputPerCall:512}});let calls=0;
  await new AgentEngine(store,bus,{async complete(){calls++;return response;}},tools).run(g.id,new AbortController().signal);
  expect(calls).toBe(0);expect(store.getGoal(g.id)?.status).toBe('failed');expect(store.getGoal(g.id)?.context?.remainingRatio).toBe(0);
 });
 it('persists compaction events, timestamp and outline across engine instances',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'goal',contextLimit:4096,budget:{maxOutputPerCall:256}});
  store.replaceMessages(g.id,[{role:'system',content:'old system'},{role:'user',content:'goal'},...Array.from({length:30},(_,i)=>({role:'assistant' as const,content:'history '+i+'x'.repeat(300)}))]);
  const model:ModelTransport={async complete(){return response;}};await new AgentEngine(store,bus,model,tools).run(g.id,new AbortController().signal);
  const first=store.getGoal(g.id)!.context!;expect(first.compressionCount).toBeGreaterThan(0);expect(first.lastCompressedAt).toMatch(/^\d{4}-/);expect(first.retainedSummaryOutline?.length).toBeGreaterThan(0);
  expect(store.events(0,g.id).some(e=>e.type==='context.compacted')).toBe(true);
  await new AgentEngine(store,bus,model,tools).run(g.id,new AbortController().signal);expect(store.getGoal(g.id)!.context!.compressionCount).toBeGreaterThanOrEqual(first.compressionCount);
 });
});
describe('continuation transcript repair',()=>{
 it('inserts aborted results before a later user message and refreshes revision policy',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'original'});store.updateGoal(g.id,{revision:2,acceptanceCommands:['new-test']});
  const assistant:ChatMessage={role:'assistant',content:null,reasoning_details:[{opaque:'keep'}],tool_calls:[{id:'missing',type:'function',function:{name:'read_file',arguments:'{}'}}]};
  store.replaceMessages(g.id,[{role:'system',content:'Goal revision: 1'}, {role:'user',content:'original'},assistant,{role:'user',content:'continue'}]);let sent:ModelRequest|undefined;
  const engine=new AgentEngine(store,bus,{async complete(request){sent=request;throw new Error('stop');}},tools);engine.prepareContinuation(g.id);
  expect(store.getMessages(g.id).slice(-3).map(m=>m.role)).toEqual(['assistant','tool','user']);
  await engine.run(g.id,new AbortController().signal);expect(sent!.messages[0].content).toContain('Goal revision: 2');expect(sent!.messages[0].content).toContain('new-test');
  expect(sent!.messages.at(-1)?.content).toBe('continue');expect(sent!.messages.at(-3)?.reasoning_details).toEqual([{opaque:'keep'}]);
 });
 it('refuses repair when a write outcome is still uncertain',()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'x'});store.beginTool(g.id,1,'write_file',{});
  expect(()=>new AgentEngine(store,bus,{async complete(){return response;}},tools).prepareContinuation(g.id)).toThrow(/核对|reconcil/i);
 });
});
describe('supervised model-provided plans',()=>{
 it('journals a structured plan without tool intents, file operations or verified completion',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'x',supervised:true});let calls=0;
  const model:ModelTransport={async complete(request){calls++;expect(request.tools?.some(d=>d.function.name==='update_plan')).toBe(true);expect(request.messages[0].content).toContain('update_plan');if(calls===1)return{...response,message:{role:'assistant',content:null,tool_calls:[{id:'plan',type:'function',function:{name:'update_plan',arguments:JSON.stringify({steps:[{id:'s1',title:'Inspect',status:'completed'}],checkpoints:[{id:'c1',title:'Tests',status:'pending'}]})}}]}};return response;}};
  await new AgentEngine(store,bus,model,tools).run(g.id,new AbortController().signal);
  const event=store.events(0,g.id).find(e=>e.type==='plan.updated');expect(event?.data).toMatchObject({source:'model',revision:1,steps:[{id:'s1',title:'Inspect',status:'completed'}]});expect(store.pendingTools(g.id)).toEqual([]);expect(store.getGoal(g.id)?.status).toBe('waiting-input');expect(store.getGoal(g.id)?.evidence).toEqual([]);
 });
 it('rejects invalid plan statuses without emitting a plan',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'x',supervised:true});let calls=0;
  const model:ModelTransport={async complete(){return ++calls===1?{...response,message:{role:'assistant',content:null,tool_calls:[{id:'bad',type:'function',function:{name:'update_plan',arguments:'{"steps":[{"id":"x","title":"x","status":"verified"}]}'}}]}}:response;}};
  await new AgentEngine(store,bus,model,tools).run(g.id,new AbortController().signal);expect(store.events(0,g.id).filter(e=>e.type==='plan.updated')).toHaveLength(0);expect(store.getMessages(g.id).find(m=>m.tool_call_id==='bad')?.content).toContain('false');
 });
});
// Continuation and small-window regressions are independent of live quota.
describe('context window boundaries',()=>{
 it('caps response headroom for a small configured context instead of reserving 16384',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'short',contextLimit:4096});let sent:ModelRequest|undefined;
  await new AgentEngine(store,bus,{async complete(request){sent=request;return response;}},tools).run(g.id,new AbortController().signal);
  expect(sent).toBeDefined();expect(sent!.maxTokens).toBeLessThan(4096);expect(sent!.maxTokens).toBeGreaterThan(0);expect(store.getGoal(g.id)?.status).toBe('succeeded');expect(store.getGoal(g.id)!.context!.estimatedInputTokens+sent!.maxTokens!).toBeLessThanOrEqual(4096);
 });
 it('blocks tool-schema and system overhead that cannot fit before dispatch',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'short',contextLimit:4096});let calls=0;
  const huge:ToolRegistry={...tools,definitions:()=>[{type:'function',function:{name:'large',description:'schema'.repeat(1000),parameters:{type:'object'}}}]};
  await new AgentEngine(store,bus,{async complete(){calls++;return response;}},huge).run(g.id,new AbortController().signal);
  expect(calls).toBe(0);expect(store.getGoal(g.id)?.usage.calls).toBe(0);expect(store.getGoal(g.id)?.context?.remainingRatio).toBe(0);
 });
 it('tags last-request context with the request revision without erasing compaction metadata',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'short'});const model:ModelTransport={async complete(){return response;}};
  const engine=new AgentEngine(store,bus,model,tools);await engine.run(g.id,new AbortController().signal);
  expect(store.getGoal(g.id)?.context?.requestRevision).toBe(1);store.updateGoal(g.id,{revision:2});expect(store.getGoal(g.id)?.context?.requestRevision).toBe(1);
  store.appendMessage(g.id,{role:'user',content:'continue'});await engine.run(g.id,new AbortController().signal);expect(store.getGoal(g.id)?.context?.requestRevision).toBe(2);
 });
});
describe('engine accounting provenance',()=>{
 it('preserves historical estimated usage while reporting an exact latest request',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'x'});store.updateGoal(g.id,{usage:{...g.usage,estimated:true,inputTokens:150}});
  await new AgentEngine(store,bus,{async complete(){return response;}},tools).run(g.id,new AbortController().signal);
  expect(store.getGoal(g.id)?.usage.estimated).toBe(true);expect(store.getGoal(g.id)?.context?.estimated).toBe(false);
 });
 it('rejects unsupported reasoning values on persisted goals before dispatch',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'x'});store.updateGoal(g.id,{reasoningEffort:'low' as never});let calls=0;
  await new AgentEngine(store,bus,{async complete(){calls++;return response;}},tools).run(g.id,new AbortController().signal);expect(calls).toBe(0);expect(store.getGoal(g.id)?.status).toBe('failed');
 });
 it('reports the route window learned by a failed provider preflight',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'x'});let declared:number|undefined;
  const model:ModelTransport={get contextLength(){return declared;},async complete(){declared=4000;throw new Error('route window too small');}};
  await new AgentEngine(store,bus,model,tools).run(g.id,new AbortController().signal);expect(store.getGoal(g.id)?.context).toMatchObject({modelContextLength:4000,effectiveLimit:4000,remainingRatio:0});
 });
});
describe('authoritative user restrictions through compaction',()=>{
 it('pins every complete user message through repeated compaction',()=>{
  const users:ChatMessage[]=[{role:'user',content:'Implement feature'}, {role:'user',content:'Leave config.json unchanged. '+ 'Additional restriction text. '.repeat(60)}, {role:'user',content:'Also preserve all existing fixtures.'}];
  let history:ChatMessage[]=[{role:'system',content:'policy'},users[0],{role:'assistant',content:'initial progress'},users[1],...Array.from({length:25},(_,i)=>({role:'assistant' as const,content:`progress ${i} `+'x'.repeat(300)})),users[2],{role:'assistant',content:'latest progress'}];
  for(let round=0;round<3;round++){
   const result=compactContext(history,4096,{responseReserve:256});expect(result.compacted).toBe(true);
   expect(result.messages.filter(m=>m.role==='user')).toEqual(users);
   history=[...result.messages,...Array.from({length:25},()=>({role:'assistant' as const,content:'later progress '+'y'.repeat(300)}))];
  }
 });
 it('fails before model dispatch if all pinned user instructions cannot fit',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'original',contextLimit:4096,budget:{maxOutputPerCall:256}});
  const users:ChatMessage[]=[{role:'user',content:'original'},{role:'user',content:'Leave config.json unchanged. '+'a'.repeat(2500)},{role:'user',content:'Keep deployment unchanged. '+'b'.repeat(2500)}];
  store.replaceMessages(g.id,[{role:'system',content:'old'},users[0],users[1],...Array.from({length:30},()=>({role:'assistant' as const,content:'progress '+'x'.repeat(300)})),users[2],{role:'assistant',content:'latest'}]);let calls=0;
  await new AgentEngine(store,bus,{async complete(){calls++;return response;}},tools).run(g.id,new AbortController().signal);
  expect(calls).toBe(0);expect(store.getGoal(g.id)?.status).toBe('failed');expect(store.getGoal(g.id)?.usage.calls).toBe(0);
  expect(store.getMessages(g.id).filter(m=>m.role==='user')).toEqual(users);
 });
});
describe('independent prompt usage provenance',()=>{
 it('uses exact native prompt usage when only the reasoning breakdown is estimated',async()=>{
  const{CompletionAssembler}=await import('../src/provider/sse.js');const{MODEL_ID}=await import('../src/contracts/index.js');
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'x'});let nativeUsage:unknown;
  const model:ModelTransport={async complete(request){
   const assembler=new CompletionAssembler(request);
   assembler.add({model:MODEL_ID,provider:'Baidu',choices:[{index:0,delta:{content:'done',reasoning:'reasoning text without a reported breakdown'},finish_reason:'stop'}]},true);
   assembler.add({choices:[],usage:{prompt_tokens:123,completion_tokens:17}},true);
   const result=assembler.finish();nativeUsage=result.usage;return result;
  }};
  await new AgentEngine(store,bus,model,tools).run(g.id,new AbortController().signal);
  expect(nativeUsage).toMatchObject({inputTokens:123,outputTokens:17,estimated:true,inputEstimated:false,outputEstimated:false,reasoningEstimated:true});
  const done=store.getGoal(g.id)!;expect(done.status).toBe('succeeded');expect(done.context).toMatchObject({requestInputTokens:123,lastPromptTokens:123,lastUsageEstimated:false,estimated:false,source:'provider-usage'});
  expect(done.usage.inputTokens).toBe(123);expect(done.usage.estimated).toBe(true);
 });
 it('retains conservative input estimates for legacy mixed usage without field provenance',async()=>{
  const{dir,store,bus}=fixture();const g=store.createGoal({workspace:dir,prompt:'x'});
  await new AgentEngine(store,bus,{async complete(){return{...response,usage:{...response.usage,inputTokens:123,estimated:true}};}},tools).run(g.id,new AbortController().signal);
  const context=store.getGoal(g.id)!.context!;expect(context.source).toBe('request-estimate');expect(context.estimated).toBe(true);expect(context.requestInputTokens).toBe(context.estimatedInputTokens);
 });
});
