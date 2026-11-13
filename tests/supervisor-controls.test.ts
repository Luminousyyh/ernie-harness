import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {SqliteStore} from '../src/store/sqlite.js';import {Supervisor} from '../src/supervisor/scheduler.js';import {AgentEngine} from '../src/core/engine.js';import {LocalEventBus} from '../src/store/events.js';
import type {ModelTransport,ToolRegistry} from '../src/contracts/index.js';
const dirs:string[]=[],stores:SqliteStore[]=[],supervisors:Supervisor[]=[];
afterEach(async()=>{for(const s of supervisors.splice(0))await s.shutdown();for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'ernie-control-'));dirs.push(dir);const store=new SqliteStore(join(dir,'state.db'));stores.push(store);return{dir,store,bus:new LocalEventBus()};}
describe('atomic controls and workspace reservations',()=>{
 it('keeps cancellation terminal when revision overlaps a running goal',async()=>{
  const {dir,store,bus}=fixture();let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  const model:ModelTransport={async complete(_r,_d,signal){entered();await new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>setTimeout(()=>reject(new Error('aborted')),10),{once:true}));throw new Error('unreachable');}};
  const tools:ToolRegistry={definitions:()=>[],execute:async()=>({ok:true,output:''})};
  const supervisor=new Supervisor(store,bus,new AgentEngine(store,bus,model,tools),tools);supervisors.push(supervisor);
  const goal=store.createGoal({workspace:dir,prompt:'before'});await supervisor.start(goal.id);await started;
  const revise=supervisor.revise(goal.id,{prompt:'after'});const cancel=supervisor.cancel(goal.id);
  const results=await Promise.allSettled([revise,cancel]);expect(results[0].status).toBe('rejected');expect(store.getGoal(goal.id)?.status).toBe('cancelled');expect(store.getGoal(goal.id)?.prompt).toBe('before');
 });
 it('rolls back transcript, queue and evidence when committing a revision fails',()=>{
  const {dir,store}=fixture();const goal=store.createGoal({workspace:dir,prompt:'before'});store.appendMessage(goal.id,{role:'user',content:'history'});store.enqueue(goal.id);
  const old=store.getGoal(goal.id);const fail=vi.spyOn(store,'appendEvent').mockImplementationOnce(()=>{throw new Error('disk failure');});
  expect(()=>store.reviseGoal(goal.id,1,{prompt:'after'})).toThrow('disk failure');fail.mockRestore();
  expect(store.getGoal(goal.id)).toEqual(old);expect(store.getMessages(goal.id)).toHaveLength(1);expect(store.queued()).toContain(goal.id);
  const reopened=new SqliteStore(join(dir,'state.db'));try{expect(reopened.getGoal(goal.id)).toEqual(old);expect(reopened.getMessages(goal.id)).toHaveLength(1);}finally{reopened.close();}
 });
 it('rejects sibling writers and reserves the directory against start and dispatch',async()=>{
  const {dir,store,bus}=fixture();const model:ModelTransport={async complete(){throw new Error('must not run');}};const tools:ToolRegistry={definitions:()=>[],execute:async()=>({ok:true,output:''})};
  const supervisor=new Supervisor(store,bus,new AgentEngine(store,bus,model,tools),tools);supervisors.push(supervisor);
  const sibling=store.createGoal({workspace:dir,prompt:'sibling'});store.updateGoal(sibling.id,{status:'running'});
  await expect(supervisor.withWorkspaceSnapshot(dir,async()=>true)).rejects.toThrow();
  store.updateGoal(sibling.id,{status:'paused'});
  await supervisor.withWorkspaceSnapshot(dir,async()=>{
   await expect(supervisor.start(sibling.id)).rejects.toThrow();
   store.enqueue(sibling.id);await supervisor.recover();expect(store.getGoal(sibling.id)?.status).toBe('paused');store.settleQueue(sibling.id);
  });
 });
});
