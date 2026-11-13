import {describe,it,expect,afterEach}from'vitest';import{mkdtempSync,rmSync,mkdirSync,writeFileSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';import{createHarnessService}from'../src/server/app.js';
const dirs:string[]=[];const apps:any[]=[];afterEach(async()=>{for(const a of apps.splice(0))await a.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
async function setup(){const dir=mkdtempSync(join(tmpdir(),'ernie-api-'));dirs.push(dir);const service=await createHarnessService({stateDir:dir,workspace:dir,benchmarkPath:join(dir,'benchmark.json'),apiKey:'',token:'test-local-token'});apps.push(service.app);return{...service,dir};}
describe('authenticated service',()=>{
 it('requires auth and rejects cross-origin commands',async()=>{const{app}=await setup();expect((await app.inject('/api/state')).statusCode).toBe(401);expect((await app.inject({method:'POST',url:'/api/auth',payload:{token:'test-local-token'},headers:{origin:'https://attacker.example'}})).statusCode).toBe(403);const auth=await app.inject({method:'POST',url:'/api/auth',payload:{token:'test-local-token'}});expect(auth.statusCode).toBe(200);expect(auth.headers['set-cookie']).toContain('HttpOnly');expect(auth.headers['set-cookie']).toContain('SameSite=Strict');});
 it('creates real pending goals and validates workspace',async()=>{const{app,dir}=await setup();const headers={authorization:'Bearer test-local-token'};const created=await app.inject({method:'POST',url:'/api/goals',headers,payload:{workspace:dir,prompt:'write tests',acceptanceCommands:['node --test']}});expect(created.statusCode).toBe(200);expect(created.json().status).toBe('pending');const detail=await app.inject({url:'/api/goals/'+created.json().id,headers});expect(detail.json().messages).toEqual([{role:'user',content:'write tests'}]);const state=await app.inject({url:'/api/state',headers});expect(JSON.stringify(state.json())).not.toContain('test-local-token');expect((await app.inject({url:'/api/benchmark',headers})).json().trials).toEqual([]);});
});

describe('matched API route authentication',()=>{
 it('rejects encoded API paths before reads and writes',async()=>{
  const {app,dir,store}=await setup();
  expect((await app.inject('/%61pi/state')).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/%61pi/goals',payload:{workspace:dir,prompt:'unauthorized'}})).statusCode).toBe(401);
  expect(store.listGoals()).toEqual([]);
  expect((await app.inject({url:'/%61pi/state',headers:{authorization:'Bearer test-local-token'}})).statusCode).toBe(200);
 });
 it('keeps only the exact public routes exempt, including query strings',async()=>{
  const {app}=await setup();
  expect((await app.inject('/%61pi/health?probe=1')).statusCode).toBe(200);
  const auth=await app.inject({method:'POST',url:'/%61pi/auth?next=state',payload:{token:'test-local-token'}});
  expect(auth.statusCode).toBe(200);
  const cookie=String(auth.headers['set-cookie']).split(';')[0];
  expect((await app.inject({url:'/%61pi/state',headers:{cookie}})).statusCode).toBe(200);
  expect((await app.inject({url:'/%61pi/state',headers:{cookie,origin:'https://attacker.example'}})).statusCode).toBe(403);
 });
});

it('serves new build assets created after service startup as JavaScript',async()=>{const dir=mkdtempSync(join(tmpdir(),'ernie-static-'));dirs.push(dir);writeFileSync(join(dir,'index.html'),'<div id="root"></div>');const{app}=await createHarnessService({stateDir:join(dir,'state'),workspace:dir,webRoot:dir,token:'test-token'});apps.push(app);await app.ready();mkdirSync(join(dir,'assets'));writeFileSync(join(dir,'assets','new-build.js'),'console.log("ready")');const response=await app.inject('/assets/new-build.js');expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toMatch(/javascript/);expect(response.body).toContain('console.log');expect((await app.inject('/assets/missing.js')).statusCode).toBe(404);});
