import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {LearningService, LEARNING_DATABASE_FILE} from '../src/learning/index.js';
import {MODEL_ID, type Goal, type ModelRequest, type ModelResponse, type ModelTransport} from '../src/contracts/index.js';
import {SqliteStore} from '../src/store/sqlite.js';
import {LocalEventBus} from '../src/store/events.js';
import {workspaceHash} from '../src/core/context.js';
import {SerialQuota} from '../src/provider/quota.js';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.unstubAllEnvs(); });
type PromptEvidence = {id:string;command:string;goalRevision:number;workspaceHash:string;exitCode:number;output:string};
function payload(request:ModelRequest): {evidence:PromptEvidence[]} {return JSON.parse(request.messages[1].content!);}
function response(content:unknown):ModelResponse {return {message:{role:'assistant',content:JSON.stringify(content),reasoning:'PRIVATE REASONING MUST NOT BE REUSED'},usage:{inputTokens:50,outputTokens:30,reasoningTokens:10},model:MODEL_ID,finishReason:'stop'};}
function lesson(request:ModelRequest,text='Run pnpm test after changing parser code.',ids?:string[]):ModelResponse {
 return response({version:1,deltas:[{op:'add',text,evidenceIds:ids??payload(request).evidence.filter(e=>e.exitCode===0).map(e=>e.id)}]});
}
function fixture(complete:(request:ModelRequest,signal?:AbortSignal)=>Promise<ModelResponse>=async request=>lesson(request)) {
 const root=mkdtempSync(join(tmpdir(),'ernie-learning-')); cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'project');const other=join(root,'other');const state=join(root,'state');
 [workspace,other,state].forEach(path=>mkdirSync(path));writeFileSync(join(workspace,'parser.ts'),'export const parser = 1;');writeFileSync(join(other,'parser.ts'),'export const parser = 1;');
 const store=new SqliteStore(join(state,'sessions.sqlite'));cleanups.push(()=>store.close());const bus=new LocalEventBus();
 const model:ModelTransport & {quota:SerialQuota}={quota:new SerialQuota({path:join(state,'provider-quota.json')}),complete:vi.fn(async(request,_delta,signal)=>complete(request,signal))};
 const service=new LearningService(store,model,bus,state);cleanups.push(()=>service.close());
 return {root,workspace,other,state,store,bus,model,service};
}
async function verified(f:ReturnType<typeof fixture>,workspace=f.workspace,partition:'production'|'development'|'formal'='production'):Promise<Goal> {
 const goal=f.store.createGoal({workspace,prompt:'Change parser code and run pnpm test',acceptanceCommands:['pnpm test']});
 return f.store.updateGoal(goal.id,{status:'succeeded',partition,evidence:[{command:'pnpm test',exitCode:0,output:'parser test: 12 passed',workspaceHash:await workspaceHash(workspace),goalRevision:goal.revision,createdAt:new Date().toISOString()}]} as Partial<Goal>);
}
function rows(state:string,table='learning_attempts'):Record<string,unknown>[] {
 const db=new DatabaseSync(join(state,LEARNING_DATABASE_FILE));try{return db.prepare(`SELECT * FROM ${table}`).all();}finally{db.close();}
}

describe('embedded evidence-linked learning',()=>{
 it('learns a structured lesson and retrieves relevant bounded untrusted context without leaking another project',async()=>{
  const f=fixture();const goal=await verified(f);await f.service.reflect(goal.id);
  const entries=f.service.list(f.workspace);expect(entries).toHaveLength(1);expect(entries[0].status).toBe('active');expect(entries[0].evidence).toHaveLength(1);
  const prepared=await f.service.prepare(goal);expect(prepared.entries).toHaveLength(1);expect(prepared.context).toContain('untrusted');expect(prepared.context).toContain('pnpm test');expect(Buffer.byteLength(prepared.context)).toBeLessThanOrEqual(8192);expect(prepared.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(await f.service.prepare(goal)).toEqual(prepared);
  expect(f.service.list(f.other)).toEqual([]);const other=await verified(f,f.other);expect((await f.service.prepare(other)).entries).toEqual([]);
  expect(f.store.events(0,goal.id).some(event=>event.type==='learning.completed')).toBe(true);
 });
 it('canonicalizes workspace aliases and rejects external symlink source targets',async()=>{
  const f=fixture();const goal=await verified(f);await f.service.reflect(goal.id);
  const alias=join(f.root,'alias');symlinkSync(f.workspace,alias,'junction');expect(f.service.list(alias).map(e=>e.id)).toEqual(f.service.list(f.workspace).map(e=>e.id));
  symlinkSync(f.other,join(f.workspace,'external'),'junction');expect((await f.service.prepare(goal)).entries).toEqual([]);
 });
 it('isolates production and development and prohibits formal reflection and retrieval',async()=>{
  const f=fixture();const dev=await verified(f,f.workspace,'development');await f.service.reflect(dev.id);
  const prod=await verified(f);expect((await f.service.prepare(prod)).entries).toEqual([]);
  const formal=await verified(f,f.workspace,'formal');await f.service.reflect(formal.id);expect((await f.service.prepare(formal)).entries).toEqual([]);
  expect(f.model.complete).toHaveBeenCalledTimes(1);expect(f.store.getGoal(formal.id)!.usage.calls).toBe(0);expect(f.service.list(f.workspace).every(e=>e.partition==='development')).toBe(true);
 });
 it('keeps unsupported, failed, stale and foreign evidence assertions candidate',async()=>{
  const f=fixture(async request=>response({version:1,deltas:[
   {op:'add',text:'Run parser tests to verify the change',evidenceIds:['invented']},
   {op:'add',text:'Use a failed parser test as a success assertion',evidenceIds:payload(request).evidence.map(e=>e.id)},
  ]}));
  let goal=await verified(f);goal=f.store.updateGoal(goal.id,{evidence:goal.evidence.map(e=>({...e,exitCode:1}))});await f.service.reflect(goal.id);
  expect(f.service.list(f.workspace).map(e=>e.status)).toEqual(['candidate','candidate']);expect((await f.service.prepare(goal)).entries).toEqual([]);
 });
 it('invalidates active memory on evidence removal, revision changes and source changes',async()=>{
  const f=fixture();let goal=await verified(f);await f.service.reflect(goal.id);f.store.updateGoal(goal.id,{evidence:[]});expect((await f.service.prepare(goal)).entries).toEqual([]);expect(f.service.list(f.workspace)[0].status).toBe('candidate');
  goal=await verified(f);await f.service.reflect(goal.id);expect(f.service.list(f.workspace)[0].status).toBe('active');f.store.updateGoal(goal.id,{revision:2});expect((await f.service.prepare(goal)).entries).toEqual([]);
  goal=await verified(f);await f.service.reflect(goal.id);writeFileSync(join(f.workspace,'parser.ts'),'export const parser = 2;');expect((await f.service.prepare(goal)).entries).toEqual([]);
 });
 it('rechecks evidence and revision after model completion before activating deltas',async()=>{
  let release!:(value:ModelResponse)=>void;let captured!:ModelRequest;
  const f=fixture(request=>{captured=request;return new Promise(resolve=>{release=resolve;});});const goal=await verified(f);const running=f.service.reflect(goal.id);
  await vi.waitFor(()=>expect(f.model.complete).toHaveBeenCalledTimes(1));f.store.updateGoal(goal.id,{evidence:[]});release(lesson(captured));await running;
  expect(f.service.list(f.workspace)[0].status).toBe('candidate');expect((await f.service.prepare(f.store.getGoal(goal.id)!)).entries).toEqual([]);
 });
 it('deduplicates normalized lessons incrementally, preserves disable, and records append-only versions',async()=>{
  const f=fixture();const first=await verified(f);await f.service.reflect(first.id);const id=f.service.list(f.workspace)[0].id;
  const second=await verified(f);await f.service.reflect(second.id);expect(f.service.list(f.workspace)).toHaveLength(1);expect(f.service.list(f.workspace)[0].evidence).toHaveLength(2);
  f.service.update(id,{status:'disabled'});expect((await f.service.prepare(second)).entries).toEqual([]);
  const third=await verified(f);await f.service.reflect(third.id);expect(f.service.list(f.workspace)[0].status).toBe('disabled');
  expect(f.service.update(id,{status:'active'}).status).toBe('active');expect(f.service.update(id,{text:'Parser test claim changed by a user'}).status).toBe('candidate');expect(()=>f.service.update(id,{status:'active'})).toThrow(/evidence/i);
  expect(rows(f.state,'learning_history').length).toBeGreaterThanOrEqual(5);
  const db=new DatabaseSync(join(f.state,LEARNING_DATABASE_FILE));try{expect(()=>db.exec('DELETE FROM learning_history')).toThrow();expect(()=>db.exec("UPDATE learning_history SET action='tampered'")).toThrow();expect(db.prepare('PRAGMA user_version').get()).toMatchObject({user_version:1});}finally{db.close();}
 });
 it('redacts credentials and never stores or sends transcript reasoning',async()=>{
  const f=fixture(async request=>lesson(request,'Use pnpm test. api_key=fixture-private-value Bearer fixture-token-value'));
  vi.stubEnv('EXAMPLE_API_KEY','fixture-private-value');let goal=await verified(f);goal=f.store.updateGoal(goal.id,{prompt:'pnpm test api_key=fixture-private-value',evidence:goal.evidence.map(e=>({...e,output:'12 passed token=fixture-token-value'}))});f.store.appendMessage(goal.id,{role:'assistant',content:'ANSWER SECRET',reasoning:'RAW PRIVATE CHAIN'});
  await f.service.reflect(goal.id);const wire=JSON.stringify(vi.mocked(f.model.complete).mock.calls);const stored=JSON.stringify(rows(f.state,'learning_entries'))+JSON.stringify(rows(f.state,'learning_history'))+JSON.stringify(rows(f.state))+JSON.stringify(f.store.events(0,goal.id).filter(e=>e.type.startsWith('learning.')));
  expect(wire+stored).not.toContain('fixture-private-value');expect(wire+stored).not.toContain('fixture-token-value');expect(wire+stored).not.toContain('RAW PRIVATE CHAIN');expect(stored).not.toContain('PRIVATE REASONING MUST NOT BE REUSED');expect(f.service.list(f.workspace)[0].text).toContain('[REDACTED]');
 });
 it('rejects raw reasoning and invalid structured output without persisting the response',async()=>{
  const f=fixture(async()=>response({version:1,deltas:[{op:'add',text:'<think>PRIVATE REASONING</think>',evidenceIds:[]}]}));const goal=await verified(f);await f.service.reflect(goal.id);expect(f.service.list(f.workspace)).toEqual([]);expect(f.store.getGoal(goal.id)!.usage.calls).toBe(1);
 });
});

describe('durable reflection budget and cancellation',()=>{
 it('reserves original goal usage before one completion and remains idempotent across concurrency and restart',async()=>{
  let f!:ReturnType<typeof fixture>;
  f=fixture(async request=>{const usage=f.store.getGoal(goal.id)!.usage;expect(usage.calls).toBe(1);expect(usage.inputTokens).toBeGreaterThan(50);expect(usage.outputTokens).toBeGreaterThanOrEqual(30);return lesson(request);});const goal=await verified(f);
  await Promise.all([f.service.reflect(goal.id),f.service.reflect(goal.id)]);expect(f.model.complete).toHaveBeenCalledTimes(1);expect(f.store.getGoal(goal.id)!.usage).toMatchObject({calls:1,inputTokens:50,outputTokens:30,reasoningTokens:10});
  f.service.close();const reopened=new LearningService(f.store,f.model,f.bus,f.state);cleanups.push(()=>reopened.close());await reopened.reflect(goal.id);expect(f.model.complete).toHaveBeenCalledTimes(1);expect(reopened.list(f.workspace)).toHaveLength(1);
 });
 it('persists pending-budget without a model call and permits retry when original budget is increased',async()=>{
  const f=fixture();let goal=await verified(f);goal=f.store.updateGoal(goal.id,{usage:{...goal.usage,calls:goal.budget.maxCalls}});await f.service.reflect(goal.id);
  expect(f.model.complete).not.toHaveBeenCalled();expect(JSON.stringify(rows(f.state))).toContain('pending-budget');expect(f.store.events(0,goal.id).some(e=>e.type==='learning.pending-budget')).toBe(true);
  f.store.updateGoal(goal.id,{budget:{...goal.budget,maxCalls:goal.budget.maxCalls+1}});await f.service.reflect(goal.id);expect(f.model.complete).toHaveBeenCalledTimes(1);
 });
 it('does not dispatch without free-route quota and does not charge the goal for the preflight',async()=>{
  const f=fixture();const goal=await verified(f);const at=Date.now();writeFileSync(join(f.state,'provider-quota.json'),JSON.stringify({version:1,lastSeen:at,attempts:Array.from({length:50},(_,i)=>({id:String(i),at}))}));await f.service.reflect(goal.id);
  expect(f.model.complete).not.toHaveBeenCalled();expect(f.store.getGoal(goal.id)!.usage.calls).toBe(0);expect(JSON.stringify(rows(f.state))).toContain('pending-budget');
 });
 it('retains conservative charges on uncertain failure and never automatically replays',async()=>{
  const f=fixture(async()=>{throw new Error('network echoed api_key=fixture-sensitive');});const goal=await verified(f);await f.service.reflect(goal.id);const usage=f.store.getGoal(goal.id)!.usage;
  expect(usage.calls).toBe(1);expect(usage.inputTokens).toBeGreaterThan(0);expect(usage.outputTokens).toBeGreaterThan(0);expect(usage.estimated).toBe(true);await f.service.reflect(goal.id);expect(f.model.complete).toHaveBeenCalledTimes(1);expect(f.store.getGoal(goal.id)!.usage).toEqual(usage);expect(JSON.stringify(rows(f.state))).not.toContain('fixture-sensitive');
 });
 it('recovers a crash between goal reservation and dispatch without a second charge or call',async()=>{
  const f=fixture();const goal=await verified(f);const publish=f.bus.publish.bind(f.bus);let fail=true;
  vi.spyOn(f.bus,'publish').mockImplementation(event=>{if(fail&&event.type==='learning.reserved'){fail=false;throw new Error('simulated crash after committed reservation');}publish(event);});
  await f.service.reflect(goal.id);const usage=f.store.getGoal(goal.id)!.usage;expect(usage.calls).toBe(1);expect(f.model.complete).not.toHaveBeenCalled();f.service.close();
  const reopened=new LearningService(f.store,f.model,f.bus,f.state);cleanups.push(()=>reopened.close());await reopened.reflect(goal.id);expect(f.store.getGoal(goal.id)!.usage).toEqual(usage);expect(f.model.complete).not.toHaveBeenCalled();expect(JSON.stringify(rows(f.state))).toContain('uncertain');
 });
 it('never calls after cancellation, including cancellation triggered by the reservation event',async()=>{
  const f=fixture();const goal=await verified(f);const abort=new AbortController();abort.abort();await f.service.reflect(goal.id,abort.signal);expect(f.model.complete).not.toHaveBeenCalled();expect(f.store.getGoal(goal.id)!.usage.calls).toBe(0);
  f.bus.subscribe(event=>{if(event.type==='learning.reserved')f.store.updateGoal(goal.id,{status:'cancelled'});});await f.service.reflect(goal.id);expect(f.model.complete).not.toHaveBeenCalled();expect(f.store.getGoal(goal.id)!.usage.calls).toBe(1);await f.service.reflect(goal.id);expect(f.model.complete).not.toHaveBeenCalled();
 });
 it('does not activate a late response after cancel and retains the uncertain reservation',async()=>{
  let release!:(value:ModelResponse)=>void;let captured!:ModelRequest;const f=fixture(request=>{captured=request;return new Promise(resolve=>{release=resolve;});});const goal=await verified(f);const running=f.service.reflect(goal.id);await vi.waitFor(()=>expect(f.model.complete).toHaveBeenCalledTimes(1));const reserved=f.store.getGoal(goal.id)!.usage;
  f.store.updateGoal(goal.id,{status:'cancelled'});release(lesson(captured));await running;expect(f.service.list(f.workspace)).toEqual([]);expect(f.store.getGoal(goal.id)!.usage).toEqual(reserved);
 });
 it('bounds retrieval and uses relevance instead of including every active memory',async()=>{
  const f=fixture(async request=>response({version:1,deltas:Array.from({length:24},(_,i)=>({op:'add',text:`Parser test case ${i}: ${'bounded evidence '.repeat(35)}`,evidenceIds:payload(request).evidence.map(e=>e.id)}))}));const goal=await verified(f);await f.service.reflect(goal.id);const prepared=await f.service.prepare(goal);expect(prepared.entries.length).toBeGreaterThan(0);expect(prepared.entries.length).toBeLessThanOrEqual(12);expect(Buffer.byteLength(prepared.context)).toBeLessThanOrEqual(8192);
  const irrelevant=f.store.createGoal({workspace:f.workspace,prompt:'Explain astronomical redshift'});expect((await f.service.prepare(irrelevant)).entries).toEqual([]);
 });
});

describe('atomic store integration and additional failure boundaries',()=>{
 it('charges and settles the root budget including active time through native store reservations',async()=>{
  const f=fixture();const root=f.store.createGoal({workspace:f.workspace,prompt:'Root parser tests'});let child=await verified(f);child=f.store.updateGoal(child.id,{budgetRootId:root.id});
  const reserve=vi.spyOn(f.store,'reserveAttempt');const settle=vi.spyOn(f.store,'settleAttempt');await f.service.reflect(child.id);
  expect(reserve).toHaveBeenCalledTimes(1);expect(settle).toHaveBeenCalledTimes(1);const childUsage=f.store.getGoal(child.id)!.usage;const rootUsage=f.store.getGoal(root.id)!.usage;
  expect(rootUsage).toMatchObject({calls:1,inputTokens:50,outputTokens:30,reasoningTokens:10});expect(rootUsage.activeMs).toBeGreaterThan(0);expect(rootUsage.activeMs).toBe(childUsage.activeMs);
 });
 it('does not dispatch when an ancestor has no budget even if the child has room',async()=>{
  const f=fixture();let root=f.store.createGoal({workspace:f.workspace,prompt:'Root parser tests'});root=f.store.updateGoal(root.id,{usage:{...root.usage,calls:root.budget.maxCalls}});let child=await verified(f);child=f.store.updateGoal(child.id,{budgetRootId:root.id});await f.service.reflect(child.id);
  expect(f.model.complete).not.toHaveBeenCalled();expect(f.store.getGoal(child.id)!.usage.calls).toBe(0);expect(JSON.stringify(rows(f.state))).toContain('pending-budget');
 });
 it('preserves a committed fallback reservation if a base SessionStore throws after its update',async()=>{
  const f=fixture();const goal=await verified(f);let failed=false;const base=new Proxy(f.store,{get(target,key){if(['reserveAttempt','settleAttempt','transaction'].includes(String(key)))return undefined;const value=Reflect.get(target,key);if(key==='updateGoal')return (id:string,patch:Partial<Goal>)=>{const result=target.updateGoal(id,patch);if(patch.usage?.calls===1&&!failed){failed=true;throw new Error('crash after commit');}return result;};return typeof value==='function'?value.bind(target):value;}});
  const fallback=new LearningService(base,f.model,f.bus,f.state);cleanups.push(()=>fallback.close());await fallback.reflect(goal.id);const usage=f.store.getGoal(goal.id)!.usage;expect(usage.calls).toBe(1);expect(f.model.complete).not.toHaveBeenCalled();fallback.close();
  const reopened=new LearningService(base,f.model,f.bus,f.state);cleanups.push(()=>reopened.close());await reopened.reflect(goal.id);expect(f.store.getGoal(goal.id)!.usage).toEqual(usage);expect(f.model.complete).not.toHaveBeenCalled();
 });
 it('retains dispatched charges after shutdown and never calls again on reopen',async()=>{
  let f!:ReturnType<typeof fixture>;f=fixture(async request=>{f.service.close();return lesson(request);});const goal=await verified(f);await f.service.reflect(goal.id);const charged=f.store.getGoal(goal.id)!.usage;expect(charged.calls).toBe(1);expect(charged.inputTokens).toBeGreaterThan(50);
  const reopened=new LearningService(f.store,f.model,f.bus,f.state);cleanups.push(()=>reopened.close());await reopened.reflect(goal.id);expect(f.model.complete).toHaveBeenCalledTimes(1);expect(f.store.getGoal(goal.id)!.usage).toEqual(charged);expect(reopened.list(f.workspace)).toEqual([]);expect(JSON.stringify(rows(f.state))).toContain('uncertain');
 });
 it('lets the transport reserve provider quota once, without a duplicate learning reservation',async()=>{
  const f=fixture();const {SerialQuota}=await import('../src/provider/quota.js');const quota=new SerialQuota({path:join(f.state,'provider-quota.json')});const model:ModelTransport={complete:async request=>quota.run(async()=>lesson(request))};const service=new LearningService(f.store,model,f.bus,f.state);cleanups.push(()=>service.close());const goal=await verified(f);await service.reflect(goal.id);await service.reflect(goal.id);
  expect((await quota.snapshot()).dayUsed).toBe(1);expect(f.store.getGoal(goal.id)!.usage.calls).toBe(1);
 });
 it('keeps memory candidate when source changes during the request',async()=>{
  const f=fixture(async request=>{writeFileSync(join(f.workspace,'parser.ts'),'export const parser = 99;');return lesson(request);});const goal=await verified(f);await f.service.reflect(goal.id);expect(f.service.list(f.workspace)[0].status).toBe('candidate');expect((await f.service.prepare(goal)).entries).toEqual([]);
 });
 it('deduplicates case and whitespace and denies foreign entry mutations',async()=>{
  let calls=0;const f=fixture(async request=>{calls++;return lesson(request,calls===1?'Run pnpm test after changing parser code.':'run  pnpm test after changing parser code.');});const goal=await verified(f);await f.service.reflect(goal.id);const next=await verified(f);await f.service.reflect(next.id);expect(f.service.list(f.workspace)).toHaveLength(1);const entry=f.service.list(f.workspace)[0];expect(entry.evidence).toHaveLength(2);
  const foreign=await verified(f,f.other);const attacker:ModelTransport={complete:async request=>response({version:1,deltas:[{op:'disable',id:entry.id,evidenceIds:payload(request).evidence.map(e=>e.id)}]})};const foreignService=new LearningService(f.store,attacker,f.bus,f.state);cleanups.push(()=>foreignService.close());await foreignService.reflect(foreign.id);expect(f.service.list(f.workspace)[0].status).toBe('active');expect(f.service.list(f.other)).toEqual([]);
 });
});

describe('formal lineage, cancellation and reasoning boundaries',()=>{
 it('never learns or retrieves memory for a child of a formal budget owner',async()=>{
  const f=fixture();const root=f.store.createGoal({workspace:f.workspace,prompt:'Formal test',partition:'formal'});let child=await verified(f);child=f.store.updateGoal(child.id,{budgetRootId:root.id});await f.service.reflect(child.id);expect(f.model.complete).not.toHaveBeenCalled();expect((await f.service.prepare(child)).entries).toEqual([]);expect(f.service.list(f.workspace)).toEqual([]);
 });
 it('does not make calls for a child whose root was cancelled',async()=>{
  const f=fixture();const root=f.store.createGoal({workspace:f.workspace,prompt:'Parent parser test'});let child=await verified(f);child=f.store.updateGoal(child.id,{budgetRootId:root.id});f.store.updateGoal(root.id,{status:'cancelled'});await f.service.reflect(child.id);expect(f.model.complete).not.toHaveBeenCalled();expect(f.store.getGoal(child.id)!.usage.calls).toBe(0);
 });
 it('emits a durable cancellation event after reservation-triggered cancellation',async()=>{
  const f=fixture();const goal=await verified(f);f.bus.subscribe(event=>{if(event.type==='learning.started')f.store.updateGoal(goal.id,{status:'cancelled'});});await f.service.reflect(goal.id);expect(f.model.complete).not.toHaveBeenCalled();expect(f.store.events(0,goal.id).some(event=>event.type==='learning.cancelled')).toBe(true);
 });
 it('does not keep narrative private reasoning supplied as structured lesson text',async()=>{
  const f=fixture(async request=>lesson(request,'Reasoning: first I considered several approaches, then I secretly reasoned through every step.'));const goal=await verified(f);await f.service.reflect(goal.id);expect(f.service.list(f.workspace)).toEqual([]);expect(JSON.stringify(rows(f.state,'learning_history'))).not.toContain('secretly reasoned');
 });
 it('allows one new call for a new revision while invalidating the old evidence',async()=>{
  const f=fixture();let goal=await verified(f);await f.service.reflect(goal.id);goal=f.store.updateGoal(goal.id,{revision:2,evidence:goal.evidence.map(item=>({...item,goalRevision:2}))});await f.service.reflect(goal.id);await f.service.reflect(goal.id);expect(f.model.complete).toHaveBeenCalledTimes(2);expect(f.store.getGoal(goal.id)!.usage.calls).toBe(2);expect((await f.service.prepare(goal)).entries).toHaveLength(1);
 });
 it('retains historical estimate provenance after exact reflection usage',async()=>{
  const f=fixture();let goal=await verified(f);goal=f.store.updateGoal(goal.id,{usage:{...goal.usage,inputTokens:17,outputTokens:9,estimated:true}});await f.service.reflect(goal.id);expect(f.store.getGoal(goal.id)!.usage).toMatchObject({calls:1,inputTokens:67,outputTokens:39,estimated:true});
 });
});


describe('supplied transport quota ownership',()=>{
 it('consults the supplied quota and never substitutes an unrelated local allowance',async()=>{
  const f=fixture();const goal=await verified(f);const at=Date.now();
  writeFileSync(join(f.state,'provider-quota.json'),JSON.stringify({version:1,lastSeen:at,attempts:Array.from({length:50},(_,i)=>({id:String(i),at}))}));
  f.model.quota=new SerialQuota({path:join(f.root,'supplied-provider-quota.json')});
  await f.service.reflect(goal.id);expect(f.model.complete).toHaveBeenCalledTimes(1);expect(f.store.getGoal(goal.id)!.usage.calls).toBe(1);
 });
 it('lets an injected transport without a quota inspector enforce its own quota without using local state',async()=>{
  const f=fixture();const goal=await verified(f);writeFileSync(join(f.state,'provider-quota.json'),'invalid unrelated quota file');
  const model:ModelTransport={complete:vi.fn(async request=>lesson(request))};const service=new LearningService(f.store,model,f.bus,f.state);cleanups.push(()=>service.close());
  await service.reflect(goal.id);expect(model.complete).toHaveBeenCalledTimes(1);expect(f.store.getGoal(goal.id)!.usage.calls).toBe(1);
 });
});
