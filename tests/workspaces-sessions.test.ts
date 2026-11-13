import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHarnessService} from '../src/server/app.js';
import {SqliteStore} from '../src/store/sqlite.js';
const directories: string[] = [];
const services: Awaited<ReturnType<typeof createHarnessService>>[] = [];
const headers = {authorization:'Bearer workspace-test-token'};
async function setup() {
 const dir=mkdtempSync(join(tmpdir(),'ernie-workspaces-'));directories.push(dir);
 const service=await createHarnessService({stateDir:join(dir,'state'),workspace:dir,apiKey:'',token:'workspace-test-token'});
 services.push(service);return {...service,dir};
}
afterEach(async()=>{for(const s of services.splice(0)) await s.app.close();for(const d of directories.splice(0))rmSync(d,{recursive:true,force:true});});
describe('persistent workspace and conversation management',()=>{
 it('adds/selects/renames directories and preserves each historical conversation binding',async()=>{
  const {app,store,dir}=await setup();const other=join(dir,'project');mkdirSync(other);
  const original=(await app.inject({url:'/api/state',headers})).json();expect(original.workspaces).toHaveLength(1);
  const added=await app.inject({method:'POST',url:'/api/workspaces',headers,payload:{path:other,name:'项目二'}});expect(added.statusCode).toBe(200);
  const project=added.json();expect(project.name).toBe('项目二');
  await app.inject({method:'POST',url:`/api/workspaces/${project.id}/select`,headers});
  const selected=(await app.inject({url:'/api/state',headers})).json();expect(selected.workspace).toBe(project.path);expect(selected.activeWorkspaceId).toBe(project.id);
  const create=()=>app.inject({method:'POST',url:'/api/goals',headers,payload:{workspace:other,prompt:'独立任务'}});
  const first=(await create()).json(),second=(await create()).json();expect(first.id).not.toBe(second.id);
  const renamed=await app.inject({method:'PATCH',url:`/api/workspaces/${project.id}`,headers,payload:{name:'重命名',path:dir}});
  expect(renamed.statusCode).toBe(409); // two existing registrations must not alias the same canonical directory
  const third=join(dir,'third');mkdirSync(third);
  expect((await app.inject({method:'PATCH',url:`/api/workspaces/${project.id}`,headers,payload:{name:'重命名',path:third}})).statusCode).toBe(200);
  expect(store.getGoal(first.id)?.workspace).toBe(project.path);expect(store.getGoal(second.id)?.workspace).toBe(project.path);
 });
 it('rejects relative paths, files and missing directories; canonical duplicates share one record',async()=>{
  const {app,dir}=await setup();const file=join(dir,'file.txt');writeFileSync(file,'data');
  for(const path of ['.',file,join(dir,'missing')])expect((await app.inject({method:'POST',url:'/api/workspaces',headers,payload:{path}})).statusCode).toBe(400);
  const first=(await app.inject({method:'POST',url:'/api/workspaces',headers,payload:{path:dir}})).json();
  const second=(await app.inject({method:'POST',url:'/api/workspaces',headers,payload:{path:join(dir,'.')}})).json();expect(second.id).toBe(first.id);
  expect((await app.inject({method:'POST',url:'/api/goals',headers,payload:{workspace:file,prompt:'x'}})).statusCode).toBe(400);
 });
 it('returns a consistent recent event window and full transcript watermark after 5000 events',async()=>{
  const {app,store,dir}=await setup();const goal=store.createGoal({workspace:dir,prompt:'long session'});
  store.transaction(()=>{for(let n=0;n<5005;n++)store.appendEvent(goal.id,'model.delta',{type:'text',text:'x'});store.appendMessage(goal.id,{role:'assistant',content:'complete answer'});store.appendEvent(goal.id,'message',{role:'assistant',content:'complete answer'});});
  const response=await app.inject({url:`/api/goals/${goal.id}`,headers});expect(response.statusCode).toBe(200);
  const detail=response.json();expect(detail.events).toHaveLength(5000);expect(detail.events[0].seq).toBeGreaterThan(1);expect(detail.events.at(-1).seq).toBe(detail.eventCursor);expect(detail.messages).toEqual([{role:'assistant',content:'complete answer'}]);
 });
 it('retains the latest durable model plan even when streaming deltas exceed the detail window',async()=>{
  const {app,store,dir}=await setup();const goal=store.createGoal({workspace:dir,prompt:'long supervised session'});
  const plan=store.appendEvent(goal.id,'plan.updated',{source:'model',revision:1,steps:[{id:'inspect',title:'Inspect',status:'completed'}],checkpoints:[]});
  store.transaction(()=>{for(let n=0;n<5005;n++)store.appendEvent(goal.id,'model.delta',{type:'text',text:'x'});});
  const detail=(await app.inject({url:`/api/goals/${goal.id}`,headers})).json();
  expect(detail.events).toHaveLength(5000);expect(detail.events.find((e:any)=>e.type==='plan.updated')?.seq).toBe(plan.seq);expect(detail.events.at(-1).seq).toBe(detail.eventCursor);
 });
 it('exposes only capability metadata and rejects unsupported model settings',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ernie-capabilities-'));directories.push(dir);
  const snapshot={status:'available' as const,model:'baidu/ernie-5.5-flash-preview:free' as const,contextLength:1024000,reasoning:{advertised:['high'],verified:['high'],selected:'high' as const,reason:'记录验证'}};
  const service=await createHarnessService({stateDir:dir,workspace:dir,apiKey:'',token:'workspace-test-token',capabilityReader:async()=>snapshot});services.push(service);
  const response=await service.app.inject({url:'/api/model/capabilities',headers});expect(response.statusCode).toBe(200);expect(response.json()).toEqual(snapshot);
  expect((await service.app.inject('/api/model/capabilities')).statusCode).toBe(401);
 });
 it('persists verified thinking intensity and rejects unsupported effort',async()=>{
  const {app,store,dir}=await setup();
  const valid=await app.inject({method:'POST',url:'/api/goals',headers,payload:{workspace:dir,prompt:'x',reasoningEffort:'high'}});
  expect(valid.statusCode).toBe(200);expect(store.getGoal(valid.json().id)?.reasoningEffort).toBe('high');
  const invalid=await app.inject({method:'POST',url:'/api/goals',headers,payload:{workspace:dir,prompt:'x',reasoningEffort:'low'}});
  expect(invalid.statusCode).toBe(400);
 });
 it('retains workspace selection when the store is reopened',async()=>{
  const {store,dir}=await setup();const next=join(dir,'next');mkdirSync(next);const w=store.addWorkspace({path:next,name:'next'});store.selectWorkspace(w.id);
  const reopened=new SqliteStore(join(dir,'state','state.db'));
  try{expect(reopened.activeWorkspace()?.id).toBe(w.id);expect(reopened.listWorkspaces().map(w=>w.path)).toContain(w.path);}finally{reopened.close();}
 });
 it('continues a conversation preserving transcript and cumulative budget while invalidating old evidence',async()=>{
  const {app,store,dir}=await setup();const g=store.createGoal({workspace:dir,prompt:'first'});
  store.appendMessage(g.id,{role:'user',content:'first'});store.appendMessage(g.id,{role:'assistant',content:'first answer'});
  store.updateGoal(g.id,{status:'succeeded',usage:{...g.usage,calls:4},summary:'old',evidence:[{command:'test',exitCode:0,output:'pass',goalRevision:1,workspaceHash:'old',createdAt:g.createdAt}]});
  const response=await app.inject({method:'POST',url:`/api/goals/${g.id}/messages`,headers,payload:{content:'second',start:false}});
  expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({revision:2,status:'paused',usage:{calls:4},evidence:[]});
  expect(store.getMessages(g.id).map(m=>m.content)).toEqual(['first','first answer','second']);
  expect(store.getGoal(g.id)?.summary).toBeUndefined();
 });
 it('initializes a never-started conversation before appending a follow-up',async()=>{
  const {app,store,dir}=await setup();const g=store.createGoal({workspace:dir,prompt:'original goal'});
  const response=await app.inject({method:'POST',url:`/api/goals/${g.id}/messages`,headers,payload:{content:'follow-up'}});
  expect(response.statusCode).toBe(200);
  const history=store.getMessages(g.id);expect(history[0].role).toBe('system');
  expect(history.filter(m=>m.role==='user').map(m=>m.content)).toEqual(['original goal','follow-up']);
 });
 it('does not append to a queued goal or an intent with an unknown outcome',async()=>{
  const {app,store,dir}=await setup();const queued=store.createGoal({workspace:dir,prompt:'queued'});store.enqueue(queued.id);
  const uncertain=store.createGoal({workspace:dir,prompt:'uncertain'});store.beginTool(uncertain.id,1,'write_file',{path:'a'});
  for(const g of [queued,uncertain]){
   expect((await app.inject({method:'POST',url:`/api/goals/${g.id}/messages`,headers,payload:{content:'later'}})).statusCode).toBe(409);
   expect(store.getMessages(g.id)).toEqual([]);expect(store.getGoal(g.id)?.revision).toBe(1);
  }
 });
 it('rejects input for busy, cancelled and uncertain goals without appending anything',async()=>{
  const {app,store,dir}=await setup();
  for(const status of ['running','waiting-rate-limit','cancelled','needs-reconciliation'] as const){
   const g=store.createGoal({workspace:dir,prompt:'x'});store.updateGoal(g.id,{status});
   const response=await app.inject({method:'POST',url:`/api/goals/${g.id}/messages`,headers,payload:{content:'unsafe'}});
   expect(response.statusCode).toBe(409);expect(store.getMessages(g.id)).toEqual([]);
  }
 });
});
