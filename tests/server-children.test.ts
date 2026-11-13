import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFileSync} from 'node:child_process';
import {createHarnessService} from '../src/server/app.js';
const roots:string[]=[];const services:Awaited<ReturnType<typeof createHarnessService>>[]=[];
afterEach(async()=>{for(const service of services.splice(0))await service.app.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function git(repo:string,...args:string[]){return execFileSync('git',['-c','core.hooksPath='+ (process.platform==='win32'?'NUL':'/dev/null'),...args],{cwd:repo,encoding:'utf8',windowsHide:true});}
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'ernie-child-api-'));roots.push(root);const repo=join(root,'repo');mkdirSync(repo);
 git(repo,'init','--quiet');writeFileSync(join(repo,'source.txt'),'committed source');git(repo,'add','source.txt');git(repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','fixture');
 const service=await createHarnessService({stateDir:join(root,'state'),workspace:repo,apiKey:'',token:'child-fixture-token'});services.push(service);
 const parent=service.store.createGoal({workspace:repo,prompt:'parent'});
 const headers={authorization:'Bearer child-fixture-token'};
 const create=(payload:unknown)=>service.app.inject({method:'POST',url:`/api/goals/${parent.id}/children`,headers,payload});
 return {...service,parent,repo,root,headers,create};
}
describe('child goals in isolated worktrees',()=>{
 it('forces the workspace and parent and enforces the two-worktree cap',async()=>{
  const f=await fixture();
  const first=await f.create({prompt:'child task',workspace:f.root,parentId:'spoofed',acceptanceCommands:['node --test'],budget:{maxCalls:2}});
  expect(first.statusCode).toBe(200);const child=first.json();
  expect(child.parentId).toBe(f.parent.id);expect(resolve(child.workspace)).not.toBe(resolve(f.repo));
  expect(resolve(child.workspace)).toMatch(/worktrees[\\/][0-9a-f-]+$/);
  expect(readFileSync(join(child.workspace,'source.txt'),'utf8')).toBe('committed source');
  expect(child.acceptanceCommands).toEqual(['node --test']);expect(child.budget.maxCalls).toBe(2);expect(child.status).toBe('pending');
  expect((await f.create({prompt:'second'})).statusCode).toBe(200);
  expect((await f.create({prompt:'third'})).statusCode).toBe(400);expect(f.store.listGoals()).toHaveLength(3);
 });
 it('rejects active parents, uncertain effects, and dirty tracked or untracked files',async()=>{
  const f=await fixture();f.store.updateGoal(f.parent.id,{status:'running'});
  expect((await f.create({prompt:'blocked'})).statusCode).toBe(409);
  f.store.updateGoal(f.parent.id,{status:'paused'});const intent=f.store.beginTool(f.parent.id,1,'write_file',{});
  expect((await f.create({prompt:'uncertain'})).statusCode).toBe(409);f.store.finishTool(intent.id,{ok:false,output:'checked'});
  writeFileSync(join(f.repo,'source.txt'),'dirty');expect((await f.create({prompt:'dirty'})).statusCode).toBe(400);
  git(f.repo,'restore','source.txt');writeFileSync(join(f.repo,'new.txt'),'untracked');expect((await f.create({prompt:'dirty'})).statusCode).toBe(400);
  expect(f.store.listGoals()).toHaveLength(1);
 });
 it('rejects a sibling writer sharing the parent directory',async()=>{
  const f=await fixture();const sibling=f.store.createGoal({workspace:f.repo,prompt:'sibling writer'});
  f.store.updateGoal(sibling.id,{status:'running'});
  expect((await f.create({prompt:'child'})).statusCode).toBe(409);
  expect(f.store.listGoals()).toHaveLength(2);
 });
 it('rejects continuation and start while the directory snapshot is reserved',async()=>{
  const f=await fixture();
  await f.supervisor.withWorkspaceSnapshot(f.repo,async()=>{
   expect((await f.app.inject({method:'POST',url:`/api/goals/${f.parent.id}/messages`,headers:f.headers,payload:{content:'start later',start:true}})).statusCode).toBe(409);
   expect((await f.app.inject({method:'POST',url:`/api/goals/${f.parent.id}/start`,headers:f.headers,payload:{}})).statusCode).toBe(409);
   expect(f.store.getMessages(f.parent.id)).toEqual([]);
  });
 });
 it('requires authentication, validates input, and checks the parent exists',async()=>{
  const f=await fixture();
  expect((await f.app.inject({method:'POST',url:`/%61pi/goals/${f.parent.id}/children`,payload:{prompt:'unauthorized'}})).statusCode).toBe(401);
  expect((await f.create({prompt:''})).statusCode).toBe(400);
  expect((await f.app.inject({method:'POST',url:'/api/goals/missing/children',headers:f.headers,payload:{prompt:'child'}})).statusCode).toBe(404);
 });
});
