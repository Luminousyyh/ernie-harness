import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile, rm, mkdtemp} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, extname, join, resolve, sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixture=process.argv.includes('--fixture');
const isolated=process.argv.includes('--isolated');
const review=process.argv.find(arg=>arg.startsWith('--review='))?.slice('--review='.length);
const output=join(root,'web','qa-artifacts',isolated?'isolated':fixture?'fixture':'service');
await mkdir(output,{recursive:true});
const checks=[]; const errors=[]; let server; let browser; let page; let service; let isolatedData;
const check=(name)=>{checks.push(name);console.log(`PASS ${name}`);};
let state; let posts=[]; let failMessage=false;
async function fixtureServer(){
 const now='2026-11-13T00:00:00.000Z';
 const budget={maxCalls:20,maxInputTokens:2000000,maxOutputTokens:128000,maxActiveMs:1800000,maxOutputPerCall:16384};
 const goal={id:'g1',title:'整理项目结构',prompt:'理解项目',workspace:'/projects/alpha',acceptanceCommands:['pnpm test'],status:'paused',revision:1,budget,usage:{inputTokens:999999,outputTokens:200,calls:4,activeMs:2000,reasoningTokens:10},createdAt:now,updatedAt:now,evidence:[],dependsOn:[],supervised:true,contextLimit:64000,context:{contextLimit:64000,effectiveLimit:64000,requestInputTokens:12000,estimatedInputTokens:14000,estimated:true,source:'request-estimate',responseReserve:8000,remainingTokens:44000,compressionCount:1,retainedSummaryOutline:['原始目标与工具结果摘要'],updatedAt:now}};
 state={workspace:'/projects/alpha',workspaces:[{id:'a',name:'Alpha',path:'/projects/alpha',createdAt:now},{id:'b',name:'Beta',path:'/projects/beta',createdAt:now}],activeWorkspaceId:'a',goals:[goal],provider:{model:'baidu/ernie-5.5-flash-preview:free',configured:true,mode:'mock'},stats:{calls:4,inputTokens:999999,outputTokens:200},version:'fixture'};
 const messages={g1:[{role:'user',content:'理解项目'},{role:'assistant',content:'已阅读项目结构，等待下一步。'}]};
 const events={g1:[{seq:1,goalId:'g1',type:'context.compacted',data:{before:20000,after:12000},createdAt:now}]};
 server=createServer(async(req,res)=>{
  try{
   const path=new URL(req.url,'http://127.0.0.1').pathname;
   if(path==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(': fixture stream\n\n');return;}
   if(path.startsWith('/api/')){
    let input='';for await(const chunk of req) input+=chunk;
    const body=input?JSON.parse(input):{};let result;let status=200;
    const parts=path.split('/');const id=decodeURIComponent(parts[3]??'');
    if(req.method!=='GET')posts.push({path,body,method:req.method});
    if(path==='/api/state') result=state;
    else if(path==='/api/auth')result={ok:true};
    else if(path==='/api/model/capabilities')result={status:'available',model:state.provider.model,contextLength:1024000,reasoning:{advertised:['high'],verified:['high'],selected:'high',reason:'免费路由当前只确认 high；其他档位未验证。'}};
    else if(path==='/api/benchmark')result={status:'pending',summary:null,trials:[]};
    else if(path==='/api/workspaces' && req.method==='POST'){result={id:'w'+state.workspaces.length,...body,createdAt:now};state.workspaces.push(result);}
    else if(parts[2]==='workspaces'){
     result=state.workspaces.find(item=>item.id===id);
     if(parts[4]==='select'){state.activeWorkspaceId=id;state.workspace=result.path;}
     else if(req.method==='PATCH')Object.assign(result,body);
    }
    else if(path==='/api/goals' && req.method==='POST'){result={...goal,...body,id:'g'+(state.goals.length+1),status:'pending',title:body.prompt,workspace:body.workspace,evidence:[]};state.goals.unshift(result);messages[result.id]=[{role:'user',content:body.prompt}];events[result.id]=[];}
    else if(parts[2]==='goals'){
     const selected=state.goals.find(item=>item.id===id);
     if(parts[4]==='messages'){
      if(failMessage){failMessage=false;status=409;result={error:'此会话正在执行，请稍后再试。'};}
      else{selected.revision++;selected.status='running';selected.evidence=[];messages[id].push({role:'user',content:body.content});result=selected;}
     }else if(parts[4]==='children'){
      result={...goal,...body,id:'child1',title:body.prompt,parentId:id,workspace:'/worktrees/child1',status:'pending'};state.goals.push(result);messages.child1=[{role:'user',content:body.prompt}];events.child1=[];
     }else if(parts[4]==='diff')result={diff:''};
     else if(parts[4]){selected.status=parts[4]==='pause'?'paused':parts[4]==='cancel'?'cancelled':'running';result=selected;}
     else result={goal:selected,messages:messages[id],events:events[id]};
    }else{status=404;result={error:'fixture missing endpoint'};}
    res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
   }
   const file=resolve(root,'web','dist',path==='/'?'index.html':'.'+path);
   if(!file.startsWith(join(root,'web','dist')+sep))throw new Error('invalid path');
   const data=await readFile(file);res.writeHead(200,{'content-type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[extname(file)]??'application/octet-stream'});res.end(data);
  }catch(error){res.writeHead(500);res.end('Fixture error');errors.push(error.message);}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:`http://127.0.0.1:${server.address().port}`,token:''};
}
async function isolatedService(){
 const {createHarnessService}=await import('../dist/server/app.js');
 const runtime=await mkdtemp(join(output,'runtime-'));
 const paths=Object.fromEntries(['alpha','beta','renamed','beta-edited','gamma'].map(name=>[name,join(runtime,name)]));
 for(const path of Object.values(paths))await mkdir(path);
 await writeFile(join(paths.alpha,'README.md'),'Isolated browser QA. No model network requests.\n');
 const git=(...args)=>execFileSync('git',['-c',`core.hooksPath=${process.platform==='win32'?'NUL':'/dev/null'}`,...args],{cwd:paths.alpha,windowsHide:true,stdio:'pipe'});
 git('init','-b','main');git('add','README.md');git('-c','user.name=Browser QA','-c','user.email=browser-qa@example.invalid','commit','-m','Isolated QA initial commit');
 let calls=0;
 service=await createHarnessService({stateDir:join(runtime,'state'),workspace:paths.alpha,benchmarkPath:join(runtime,'benchmark.json'),webRoot:join(root,'web','dist'),apiKey:'',token:randomBytes(32).toString('hex'),capabilityReader:async()=>({status:'available',model:'baidu/ernie-5.5-flash-preview:free',contextLength:1024000,reasoning:{selected:'high',advertised:[],verified:[],reason:'离线注入能力数据；未提供原生实测成功记录。'}}),transport:{async complete(){calls++;return {model:'baidu/ernie-5.5-flash-preview:free',provider:'injected',message:{role:'assistant',content:'离线注入响应：仅检查 UI 与本地服务行为。'},usage:{inputTokens:32,outputTokens:16,reasoningTokens:0,estimated:true},finishReason:'stop'};}}});
 const alpha=service.store.activeWorkspace();service.store.editWorkspace(alpha.id,{name:'Alpha'});
 const beta=service.store.addWorkspace({path:paths.beta,name:'Beta'});
 const goal=service.store.createGoal({title:'整理项目结构',workspace:paths.alpha,prompt:'理解项目',supervised:true});
 service.store.updateGoal(goal.id,{status:'paused'});service.store.appendMessage(goal.id,{role:'user',content:'理解项目'});service.store.appendMessage(goal.id,{role:'assistant',content:'已读取项目，等待下一步。'});
 isolatedData={paths,alpha,beta,goal,runtime,calls:()=>calls};
 await service.app.listen({host:'127.0.0.1',port:0});
 return {url:service.app.listeningOrigin,token:service.token};
}
async function isolatedChecks(page){
 const {paths,alpha,beta,goal}=isolatedData;
 const prompt=page.getByLabel('描述你的目标',{exact:true});
 await prompt.fill('Alpha 未发送草稿');await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('heading',{name:'模型验证与适配依据'}).waitFor();await page.getByRole('button',{name:'工作台',exact:true}).click();assert.equal(await prompt.inputValue(),'Alpha 未发送草稿');check('isolated service: navigation preserves draft');
 const picker=page.getByLabel('当前工作空间',{exact:true});await picker.selectOption(beta.id);await page.waitForFunction(path=>document.getElementById('goal-workspace')?.value===path,paths.beta);await prompt.fill('Beta 未发送草稿');await picker.selectOption(alpha.id);await page.waitForFunction(path=>document.getElementById('goal-workspace')?.value===path,paths.alpha);assert.equal(await prompt.inputValue(),'Alpha 未发送草稿');check('isolated service: workspace selection and drafts');
 await page.getByRole('button',{name:'编辑当前工作空间',exact:true}).click();await page.getByRole('dialog').getByLabel('工作目录（绝对路径）').fill(paths.renamed);await page.getByRole('button',{name:'保存工作空间'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(service.store.getGoal(goal.id).workspace,paths.alpha);check('isolated service: path edit preserves historical conversation directory');
 await page.getByRole('button',{name:'添加工作空间',exact:true}).click();await page.getByLabel('名称 可选').fill('Gamma');await page.getByRole('dialog').getByLabel('工作目录（绝对路径）').fill(paths.gamma);await page.getByRole('button',{name:'保存工作空间'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(service.store.activeWorkspace().path,paths.gamma);check('isolated service: add persists and selects workspace');
 await page.getByRole('button',{name:'编辑 Beta 工作空间',exact:true}).click();await page.getByRole('dialog').getByLabel('工作目录（绝对路径）').fill(paths['beta-edited']);await page.getByRole('button',{name:'保存工作空间'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await page.locator('#goal-workspace').inputValue(),paths.gamma);check('isolated service: inactive edit keeps active directory');
 await page.getByRole('button',{name:'在 Beta 新建会话',exact:true}).click();await page.waitForFunction(path=>document.getElementById('goal-workspace')?.value===path,paths['beta-edited']);await prompt.fill('隔离目录新会话');await page.getByRole('button',{name:'创建并启动目标',exact:true}).click();await page.getByRole('heading',{name:'隔离目录新会话'}).waitFor();assert.equal(service.store.listGoals().find(item=>item.prompt==='隔离目录新会话').workspace,paths['beta-edited']);check('isolated service: per-project new conversation');
 await page.getByRole('button',{name:'整理项目结构',exact:true}).click();await page.getByLabel('继续推进这个目标').fill('继续：补充说明');
 let writes=0;
 await page.route(`**/api/goals/${goal.id}/messages`,async route=>{writes++;if(writes===1)service.store.updateGoal(goal.id,{status:'running'});await route.continue();});
 await page.getByRole('button',{name:'发送并继续'}).click();await page.getByRole('alert').first().waitFor();assert.equal(await page.getByLabel('继续推进这个目标').inputValue(),'继续：补充说明');assert.equal(writes,1);check('isolated service: real 409 preserves draft without retry');
 service.store.updateGoal(goal.id,{status:'paused'});await page.getByRole('button',{name:'发送并继续'}).click();await page.waitForFunction(()=>document.getElementById('follow-up-message')?.value==='');assert.equal(service.store.getGoal(goal.id).revision,2);assert.ok(service.store.getMessages(goal.id).some(item=>item.role==='user'&&item.content==='继续：补充说明'));assert.ok(isolatedData.calls()>0);check('isolated service: continuation history and revision with offline injected transport');
 await page.getByRole('button',{name:'创建子目标',exact:true}).click();await page.getByLabel('子目标描述').fill('隔离工作树检查');await page.getByRole('button',{name:'创建工作树与子目标'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByRole('heading',{name:'隔离工作树检查'}).waitFor();const child=service.store.listGoals().find(item=>item.parentId===goal.id);assert.ok(child&&child.workspace!==goal.workspace);check('isolated service: creates real independent child worktree');
 await page.getByRole('button',{name:'整理项目结构',exact:true}).click();await page.getByLabel('继续推进这个目标').fill('后续草稿');await page.getByRole('button',{name:'新建会话',exact:true}).click();await page.getByRole('button',{name:'整理项目结构',exact:true}).click();assert.equal(await page.getByLabel('继续推进这个目标').inputValue(),'后续草稿');await page.screenshot({path:join(output,'conversation-light.png'),fullPage:true});check('isolated service: continuation draft survives return');
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('heading',{name:'模型验证与适配依据'}).scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'model-evidence.png'),fullPage:true});
}

async function reviewRegressions(page,only='all'){
 const {paths}=isolatedData;
 const seed=(title,status='paused')=>{const goal=service.store.createGoal({title,prompt:title,workspace:paths.alpha,supervised:false});return service.store.updateGoal(goal.id,{status});};
 const chosen=name=>only==='all'||only===name;
 if(chosen('notes')){
  const a=seed('核对 A','needs-reconciliation');const b=seed('核对 B','needs-reconciliation');
  await page.reload();await page.getByRole('button',{name:'核对 A',exact:true}).click();await page.getByLabel('核对记录',{exact:true}).fill('仅属于 A 的核对记录');
  await page.getByRole('button',{name:'核对 B',exact:true}).click();assert.equal(await page.getByLabel('核对记录',{exact:true}).inputValue(),'','A reconciliation text must not appear under goal B');
  await page.getByLabel('核对记录',{exact:true}).fill('只核对 B');await page.getByRole('button',{name:'记录核对结果',exact:true}).click();
  await page.getByLabel('核对记录',{exact:true}).waitFor({state:'hidden'});assert.equal(service.store.getGoal(a.id).status,'needs-reconciliation');assert.equal(service.store.getGoal(b.id).status,'paused');check('regression: reconciliation notes are goal-scoped and submit only to B');
 }
 if(chosen('snapshots')){
  const goal=seed('快照竞态','running');await page.reload();await page.getByRole('button',{name:'快照竞态',exact:true}).waitFor();
  const detailReady=Promise.withResolvers();const stateReady=Promise.withResolvers();const release=Promise.withResolvers();
  let detailHeld=false,stateHeld=false;
  await page.route(`**/api/goals/${goal.id}`,async route=>{detailHeld=true;const response=await route.fetch();detailReady.resolve();await release.promise;await route.fulfill({response});});
  await page.route('**/api/state',async route=>{if(stateHeld)return route.continue();stateHeld=true;const response=await route.fetch();stateReady.resolve();await release.promise;await route.fulfill({response});});
  await page.getByRole('button',{name:'快照竞态',exact:true}).click();await detailReady.promise;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await stateReady.promise;
  const updated=service.store.updateGoal(goal.id,{status:'succeeded',revision:2,budget:{...goal.budget,maxCalls:51}});service.bus.publish(service.store.latestEvent(goal.id));
  await page.locator('.goal-subbar .status-succeeded').waitFor();const delivered=page.waitForResponse(response=>response.url().endsWith(`/api/goals/${goal.id}`));release.resolve();await delivered;
  await page.waitForTimeout(80);assert.equal(await page.locator('.goal-subbar .status-succeeded').count(),1,'old detail/state must not overwrite newer SSE success');
  assert.match(await page.locator('.conversation-intro').innerText(),/修订 2/);assert.match(await page.locator('.inspector').innerText(),/51/);check('regression: delayed detail and state cannot overwrite newer SSE status/revision/budget');
  await page.unroute(`**/api/goals/${goal.id}`);await page.unroute('**/api/state');
 }
 if(chosen('drafts')){
  const a=seed('草稿 A');const b=seed('草稿 B');await page.reload();await page.getByRole('button',{name:'草稿 A',exact:true}).click();
  let request=Promise.withResolvers(),release=Promise.withResolvers();let submissions=0;
  await page.route(`**/api/goals/${a.id}/messages`,async route=>{submissions++;request.resolve();await release.promise;await route.continue();});
  await page.getByLabel('继续推进这个目标').fill('已发送的 A');await page.getByRole('button',{name:'发送并继续'}).click();await request.promise;
  await page.getByLabel('继续推进这个目标').fill('发送期间新写的 A');await page.getByRole('button',{name:'草稿 B',exact:true}).click();await page.getByLabel('继续推进这个目标').fill('B 的独立草稿');release.resolve();
  await page.waitForResponse(response=>response.url().endsWith(`/api/goals/${a.id}/messages`));await page.waitForTimeout(50);assert.equal(await page.getByLabel('继续推进这个目标').inputValue(),'B 的独立草稿');
  await page.getByRole('button',{name:'草稿 A',exact:true}).click();assert.equal(await page.getByLabel('继续推进这个目标').inputValue(),'发送期间新写的 A','completion must not erase edits made after submission');assert.equal(submissions,1);check('regression: pending continuation preserves newer A edits and independent B draft');await page.unroute(`**/api/goals/${a.id}/messages`);
 }
 if(chosen('http-create')){
  const releaseEvents=Promise.withResolvers();
  await page.route('**/api/events?*',async route=>{await releaseEvents.promise;await route.abort();});
  await page.reload();await page.getByLabel('描述你的目标',{exact:true}).waitFor();
  for(const child of [false,true]){
   if(child){await page.getByRole('button',{name:'整理项目结构',exact:true}).click();await page.getByRole('button',{name:'创建子目标',exact:true}).waitFor();}
   const held=Promise.withResolvers(),release=Promise.withResolvers(),delivered=Promise.withResolvers();
   const holdState=async route=>{const response=await route.fetch();held.resolve();await release.promise;await route.fulfill({response});delivered.resolve();};
   await page.route('**/api/state',holdState);
   await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await held.promise;
   const title=child?'HTTP 新子目标保留回归':'HTTP 新会话保留回归';
   if(child){await page.getByRole('button',{name:'创建子目标',exact:true}).click();await page.getByLabel('子目标描述').fill(title);await page.getByRole('button',{name:'创建工作树与子目标'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});}
   else{await page.getByRole('button',{name:'新建会话',exact:true}).click();await page.getByRole('combobox',{name:'执行模式'}).selectOption('single');await page.getByLabel('描述你的目标',{exact:true}).fill(title);await page.getByRole('button',{name:'创建并启动目标',exact:true}).click();}
   await page.getByRole('heading',{name:title,exact:true}).waitFor();
   await page.waitForFunction(()=>document.querySelector('.conversation .history-loading')===null&&!document.getElementById('goal-prompt')?.disabled);
   const goal=service.store.listGoals().find(item=>item.prompt===title);assert.ok(goal);if(child)assert.equal(goal.parentId,isolatedData.goal.id);else assert.ok(service.store.getMessages(goal.id).length);
   release.resolve();await delivered.promise;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await page.getByRole('heading',{name:title,exact:true}).count(),1,'pre-create state response must not remove the selected HTTP-created goal');
   assert.equal(await page.getByRole('button',{name:title,exact:true}).count(),1,'HTTP-created goal must remain in the sidebar');
   check(`regression: old state cannot remove HTTP-created ${child?'child after create/detail':'conversation after create/start/detail'} while SSE is held`);
   await page.unroute('**/api/state',holdState);
  }
  await page.unroute('**/api/events?*');releaseEvents.resolve();await page.reload();await page.getByLabel('描述你的目标',{exact:true}).waitFor();
 }
 if(chosen('chat')){
  await page.getByRole('button',{name:'新建会话',exact:true}).click();const mode=page.getByRole('combobox',{name:'执行模式'});assert.equal(await mode.inputValue(),'single');
  const prompt=page.getByLabel('描述你的目标',{exact:true});await prompt.fill('模式切换期间保留草稿');await mode.selectOption('supervised');await page.locator('.main-navigation').getByRole('button',{name:/^目标/}).click();await page.getByRole('button',{name:'工作台',exact:true}).click();assert.equal(await mode.inputValue(),'supervised');assert.equal(await prompt.inputValue(),'模式切换期间保留草稿');await mode.selectOption('single');
  await prompt.fill('普通聊天回归');await page.getByRole('button',{name:'创建并启动目标',exact:true}).click();await page.locator('.goal-subbar .status-succeeded').waitFor();
  assert.equal(service.store.listGoals().find(goal=>goal.prompt==='普通聊天回归').supervised,false);check('regression: ordinary chat defaults correctly, keeps drafts/mode across pages, completes without acceptance');
  await page.getByRole('button',{name:'新建会话',exact:true}).click();await mode.selectOption('supervised');await prompt.fill('持续目标验收回归');await page.getByRole('button',{name:'创建并启动目标',exact:true}).click();await page.locator('.goal-subbar .status-waiting-input').waitFor();assert.equal(service.store.listGoals().find(goal=>goal.prompt==='持续目标验收回归').supervised,true);assert.match(await page.locator('.conversation').innerText(),/验收命令/);check('regression: Super-Agent still requires acceptance before verified completion');
 }
}

try{
 const config=isolated?await isolatedService():fixture?await fixtureServer():JSON.parse(await readFile(join(homedir(),'.ernie-harness','service.json'),'utf8'));
 const edge=process.env.ERNIE_BROWSER??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
 browser=await chromium.launch({...(existsSync(edge)?{executablePath:edge}:{}),headless:true});
 page=await browser.newPage({viewport:{width:1536,height:1024}});
 page.setDefaultTimeout(12000);
 page.on('pageerror',error=>errors.push(error.message));
 if(config.token){const auth=await page.request.post(new URL('/api/auth',config.url).href,{data:{token:config.token}});assert.equal(auth.ok(),true,'Local service authentication failed');}
 await page.goto(config.url);
 await page.getByLabel('描述你的目标',{exact:true}).waitFor();
 if(fixture){
  const prompt=page.getByLabel('描述你的目标',{exact:true});
  await prompt.fill('Alpha 的未发送草稿');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('heading',{name:'模型验证与适配依据'}).waitFor();
  assert.match(await page.locator('body').innerText(),/144.*|144/s);
  await page.getByRole('button',{name:'工作台',exact:true}).click();assert.equal(await prompt.inputValue(),'Alpha 的未发送草稿');check('navigation preserves draft and model evidence labels');
  const picker=page.getByLabel('当前工作空间',{exact:true});
  await picker.selectOption('b');await page.waitForFunction(()=>document.getElementById('goal-workspace')?.value==='/projects/beta');assert.equal(await prompt.inputValue(),'');await prompt.fill('Beta 草稿');
  await picker.selectOption('a');await page.waitForFunction(()=>document.getElementById('goal-workspace')?.value==='/projects/alpha');assert.equal(await prompt.inputValue(),'Alpha 的未发送草稿');check('workspace switch updates directory and preserves per-workspace drafts');
  await page.getByRole('button',{name:'编辑当前工作空间',exact:true}).click();
  await page.getByLabel('工作目录（绝对路径）',{exact:true}).last().fill('/projects/renamed');
  await page.getByRole('button',{name:'保存工作空间'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.getElementById('goal-workspace')?.value==='/projects/renamed');
  assert.equal(state.goals.find(g=>g.id==='g1').workspace,'/projects/alpha');check('editing workspace path leaves historical goals unchanged');
  await page.getByRole('button',{name:'添加工作空间',exact:true}).click();await page.getByLabel('名称 可选').fill('Gamma');await page.getByRole('dialog').getByLabel('工作目录（绝对路径）').fill('/projects/gamma');await page.getByRole('button',{name:'保存工作空间'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.getElementById('goal-workspace')?.value==='/projects/gamma');check('add workspace persists and selects new registration');
  await page.getByRole('button',{name:'编辑 Beta 工作空间',exact:true}).click();await page.getByRole('dialog').getByLabel('工作目录（绝对路径）').fill('/projects/beta-edited');await page.getByRole('button',{name:'保存工作空间'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await page.locator('#goal-workspace').inputValue(),'/projects/gamma');check('editing an inactive workspace keeps active composer directory');

  await page.getByRole('button',{name:'在 Beta 新建会话',exact:true}).click();await page.waitForFunction(()=>document.getElementById('goal-workspace')?.value==='/projects/beta-edited');assert.equal(await prompt.inputValue(),'');await prompt.fill('Beta 草稿');
  await page.getByRole('button',{name:'创建并启动目标',exact:true}).click();await page.getByRole('heading',{name:'Beta 草稿'}).waitFor();assert.equal(state.goals[0].workspace,'/projects/beta-edited');check('per-project new conversation uses selected absolute directory');
  await page.getByRole('button',{name:'整理项目结构',exact:true}).click();
  await page.getByLabel('继续推进这个目标').fill('继续：补充 README');
  failMessage=true;await page.getByRole('button',{name:'发送并继续'}).click();await page.getByRole('alert').filter({hasText:'此会话正在执行'}).waitFor();assert.equal(await page.getByLabel('继续推进这个目标').inputValue(),'继续：补充 README');assert.equal(posts.filter(p=>p.path.endsWith('/messages')).length,1);check('409 retains continuation draft without replay');
  await page.getByRole('button',{name:'发送并继续'}).click();await page.getByRole('button',{name:'暂停',exact:true}).first().waitFor();assert.equal(posts.filter(p=>p.path.endsWith('/messages')).at(-1).body.start,true);check('continuation explicitly starts existing conversation');
  await page.getByRole('button',{name:'暂停',exact:true}).first().click();
  await page.getByRole('button',{name:'创建子目标',exact:true}).click();await page.getByLabel('子目标描述').fill('独立核验文档');await page.getByRole('button',{name:'创建工作树与子目标'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByRole('heading',{name:'独立核验文档'}).waitFor();assert.equal(state.goals.at(-1).parentId,'g1');check('child creation uses backend worktree endpoint and parent relationship');
  await page.getByRole('button',{name:'整理项目结构',exact:true}).click();
  await page.getByLabel('继续推进这个目标').fill('跨页面保留的后续草稿');await page.getByRole('button',{name:'新建会话',exact:true}).click();await page.getByRole('button',{name:'整理项目结构',exact:true}).click();assert.equal(await page.getByLabel('继续推进这个目标').inputValue(),'跨页面保留的后续草稿');check('conversation draft survives leaving and returning');
  await page.screenshot({path:join(output,'conversation-light.png'),fullPage:true});
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('heading',{name:'模型验证与适配依据'}).scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'model-evidence.png'),fullPage:true});
 }
 if(isolated){if(!review)await isolatedChecks(page);await reviewRegressions(page,review??'all');}
 await page.getByRole('button',{name:'工作台',exact:true}).click();
 await page.getByRole('button',{name:'切换到深色主题',exact:true}).click();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await page.screenshot({path:join(output,'desktop-dark.png'),fullPage:true});check('theme toggles to dark');
 await page.reload();await page.getByLabel('描述你的目标',{exact:true}).waitFor();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');check('theme survives reload');
 await page.keyboard.press('Control+Shift+N');await page.getByLabel('描述你的目标',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.activeElement?.id),'goal-prompt');check('keyboard new conversation focuses composer');
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
 assert.equal(await page.locator('.preserved-page:not([hidden])').evaluate(el=>getComputedStyle(el).animationName),'none');check('reduced motion suppresses page transition animation');
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'打开侧边栏',exact:true}).click();await page.keyboard.press('Control+k');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='搜索项目与会话');assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'搜索项目与会话');await page.keyboard.press('Escape');assert.equal(await page.locator('.app').evaluate(el=>el.classList.contains('sidebar-open')),false);
 await page.getByRole('button',{name:'打开侧边栏',exact:true}).focus();
 for(let index=0;index<30;index++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('.sidebar')),false,'Tab must not enter the closed mobile drawer');}
 await page.getByRole('button',{name:'打开侧边栏',exact:true}).click();await page.waitForFunction(()=>document.activeElement?.closest('.sidebar'));
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('.sidebar')),true);await page.keyboard.press('Escape');
 await page.setViewportSize({width:1536,height:1024});await page.getByRole('button',{name:'新建会话',exact:true}).focus();assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('.sidebar')),true);await page.setViewportSize({width:390,height:844});
 check('regression: closed mobile drawer is excluded from Tab order, open and desktop drawers remain interactive');
 const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(width.scroll<=width.viewport,JSON.stringify(width));check('mobile search shortcut, escape and no horizontal overflow');
 await page.screenshot({path:join(output,'mobile-dark-reduced-motion.png'),fullPage:true});
 assert.equal(errors.length,0,errors.join('\n'));check('no browser page errors');
 await writeFile(join(output,'browser-checks.json'),JSON.stringify({checkedAt:new Date().toISOString(),mode:isolated?'real isolated service and SQLite/worktrees; injected transport; offline behavior only; no live model calls':fixture?'isolated API fixtures; no live model calls':'running local service; read-only browser inspection; no live model calls',checks,errors},null,2));
 await Promise.all(['failure.png','browser-failure.json'].map(name=>rm(join(output,name),{force:true})));
 console.log(`Browser QA: ${checks.length} checks passed (${isolated?'isolated service / offline injected transport':fixture?'fixture API':'local service'}). Artifacts: ${output}`);
}catch(error){await page?.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,'browser-failure.json'),JSON.stringify({mode:isolated?'isolated':fixture?'fixture':'service',checks,errors,error:error.message},null,2));throw error;}
finally{await browser?.close();server?.closeAllConnections();server?.close();await service?.app.close();}
