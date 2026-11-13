import {loadImprovementEnvironment} from './improvement-config.js';
import type {LinuxEvaluationEnvironment} from '../improvement/index.js';
import {MaturationRuntime,registerMaturationRoutes} from './maturation.js';
import Fastify from 'fastify';import cookie from '@fastify/cookie';import staticFiles from '@fastify/static';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';import {join,resolve} from 'node:path';
import {createChildWorktree,removeChildWorktree} from '../supervisor/worktrees.js';
import {startEventStream} from './sse.js';
import {z} from 'zod';import {SqliteStore} from '../store/sqlite.js';import {LocalEventBus} from '../store/events.js';import {AgentEngine} from '../core/engine.js';import {Supervisor} from '../supervisor/scheduler.js';
import {MODEL_ID,type ModelTransport,type ToolRegistry,type ModelCapabilities} from '../contracts/index.js';import {OpenRouterTransport,loadApiKey,defaultStateDirectory,SerialQuota} from '../provider/index.js';import {createToolRegistry} from '../tools/index.js';
export interface ServiceOptions {improvementEnvironment?:LinuxEvaluationEnvironment;learning?:boolean;maxWorkers?:1|2;stateDir?:string;workspace?:string;transport?:ModelTransport;tools?:ToolRegistry;apiKey?:string;token?:string;webRoot?:string;benchmarkPath?:string;quotaPath?:string;capabilityReader?:()=>Promise<ModelCapabilities>}
export async function createHarnessService(options:ServiceOptions={}){
 const stateDir=options.stateDir??defaultStateDirectory();mkdirSync(stateDir,{recursive:true,mode:0o700});const store=new SqliteStore(join(stateDir,'state.db'));const bus=new LocalEventBus();const key=options.apiKey??await loadApiKey();
 const missing:ModelTransport={async complete(){throw new Error('尚未配置 OpenRouter 凭据，请运行 pnpm cli setup。');}};const validationPath=join(stateDir,'model-validation.json');
 const sharedQuotaPath=options.quotaPath??join(defaultStateDirectory(),'provider-quota.json');
 const improvementEnvironment=options.improvementEnvironment??loadImprovementEnvironment(stateDir,key,sharedQuotaPath);
 const upstream=key?new OpenRouterTransport({apiKey:key,quota:new SerialQuota({path:sharedQuotaPath})}):undefined;
 const model:ModelTransport=options.transport??(upstream?{
  get contextLength(){return upstream.contextLength;},
  async complete(request,onDelta,signal){
   const response=await upstream.complete(request,onDelta,signal);
   if(response.model===MODEL_ID&&response.provider==='Baidu'){
    try{const temporary=validationPath+'.tmp';writeFileSync(temporary,JSON.stringify({source:'live-completion',model:MODEL_ID,provider:'Baidu',effort:'high',recordedAt:new Date().toISOString()}),{mode:0o600});renameSync(temporary,validationPath);}catch{/* Model success must survive a metadata write failure. */}
   }
   return response;
  }
 }:missing);const baseTools=options.tools??createToolRegistry();const maturation=new MaturationRuntime(store,bus,model,baseTools,stateDir,options.learning??!!key,undefined,improvementEnvironment);const tools=maturation.tools;const engine=new AgentEngine(store,bus,model,tools,{runVersion:(goal,signal)=>maturation.runVersion(goal,signal),prepare:goal=>maturation.prepare(goal),reflect:(id,signal)=>maturation.reflect(id,signal)});const supervisor=new Supervisor(store,bus,engine,tools,{maxWorkers:options.maxWorkers??1,stateDir});await supervisor.recover();
 const token=options.token??randomBytes(32).toString('hex');const match=(candidate:unknown)=>typeof candidate==='string'&&Buffer.byteLength(candidate)===Buffer.byteLength(token)&&timingSafeEqual(Buffer.from(candidate),Buffer.from(token));
 const app=Fastify({logger:false,bodyLimit:1024*1024,requestTimeout:30000});await app.register(cookie);
 app.addHook('onRequest',async(request,reply)=>{
  reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store');
  const origin=request.headers.origin;if(origin){try{if(new URL(origin).host!==request.headers.host)return reply.code(403).send({error:'Cross-origin requests are disabled'});}catch{return reply.code(403).send({error:'Invalid origin'});}}
 });
 app.addHook('preHandler',async(request,reply)=>{
  const route=request.routeOptions.url;
  if(!route?.startsWith('/api/')||route==='/api/health'||route==='/api/auth')return;
  const bearer=request.headers.authorization?.startsWith('Bearer ')?request.headers.authorization.slice(7):undefined;
  if(!match(bearer)&&!match(request.cookies.ernie_session))return reply.code(401).send({error:'需要本地服务令牌'});
 });
 app.setErrorHandler((error:any,_request,reply)=>{const message=error instanceof Error?error.message:'Request failed';reply.code(error instanceof z.ZodError?400:error.statusCode??400).send({code:error instanceof z.ZodError?'INVALID_REQUEST':'SERVICE_ERROR',error:message.replace(/sk-or-v1-[a-zA-Z0-9]+/g,'[REDACTED]')});});
 const defaultWorkspace=store.addWorkspace({path:resolve(options.workspace??process.cwd())});
 if(!store.activeWorkspace())store.selectWorkspace(defaultWorkspace.id);
 for(const goal of store.listGoals()){try{store.addWorkspace({path:goal.workspace});}catch{/* Preserve inaccessible historical goals. */}}
 registerMaturationRoutes(app,store,bus,supervisor,maturation);
 app.get('/api/model/capabilities',async()=>{
  if(options.capabilityReader)return options.capabilityReader();
  let verifiedReasoning:('high')[]=[];
  try{const record=JSON.parse(readFileSync(validationPath,'utf8'));if(record.source==='live-completion'&&record.model===MODEL_ID&&record.provider==='Baidu'&&record.effort==='high'&&typeof record.recordedAt==='string'&&Number.isFinite(Date.parse(record.recordedAt)))verifiedReasoning=['high'];}catch{}
  return (await import('../provider/catalog.js')).inspectModelCapabilities({verifiedReasoning});
 });
 app.post('/api/workspaces',request=>store.addWorkspace(z.object({path:z.string().min(1),name:z.string().trim().min(1).max(200).optional()}).parse(request.body)));
 app.patch<{Params:{id:string}}>('/api/workspaces/:id',request=>store.editWorkspace(request.params.id,z.object({path:z.string().min(1).optional(),name:z.string().trim().min(1).max(200).optional()}).parse(request.body)));
 app.post<{Params:{id:string}}>('/api/workspaces/:id/select',request=>store.selectWorkspace(request.params.id));
 app.post<{Params:{id:string}}>('/api/goals/:id/messages',async(request,reply)=>{
  const input=z.object({content:z.string().trim().min(1).max(100000),start:z.boolean().optional()}).parse(request.body);
  const current=store.getGoal(request.params.id);if(!current)return reply.code(404).send({error:'目标不存在'});
  if(current.status==='running'&&store.hasActivity(current.id)){store.queueMessage(current.id,input.content);const event=store.latestEvent(current.id);if(event)bus.publish(event);return current;}
  if(store.listApprovals(current.id).some(a=>a.revision===current.revision&&a.status==='pending'))return reply.code(409).send({error:'Resolve pending approvals before adding a message',code:'APPROVAL_PENDING'});
  await supervisor.continueConversation(request.params.id,input.content);
  if(input.start)await supervisor.start(request.params.id);
  return store.getGoal(request.params.id);
 });
 app.get('/api/health',()=>({ok:true,version:'0.2.0'}));app.post('/api/auth',async(request,reply)=>{const body=z.object({token:z.string().max(1024)}).parse(request.body);if(!match(body.token))return reply.code(401).send({error:'服务令牌不正确'});reply.setCookie('ernie_session',token,{httpOnly:true,sameSite:'strict',path:'/'});return{ok:true};});
 app.get('/api/state',()=>{const goals=store.listGoals();const selected=store.activeWorkspace();return{goals,workspaces:store.listWorkspaces(),activeWorkspaceId:selected?.id,provider:{model:MODEL_ID,configured:!!key||!!options.transport,mode:options.transport?'injected':'free-only'},stats:goals.filter(g=>!g.budgetRootId).reduce((sum,g)=>({calls:sum.calls+g.usage.calls,inputTokens:sum.inputTokens+g.usage.inputTokens,outputTokens:sum.outputTokens+g.usage.outputTokens}),{calls:0,inputTokens:0,outputTokens:0}),version:'0.2.0',workspace:selected?.path??resolve(options.workspace??process.cwd())};});
 const goalSchema=z.object({mode:z.enum(['plan','standard','trusted']).default('standard'),prompt:z.string().trim().min(1).max(100000),workspace:z.string().min(1),title:z.string().max(200).optional(),acceptanceCommands:z.array(z.string().min(1).max(10000)).max(20).optional(),supervised:z.boolean().optional(),reasoningEffort:z.literal('high').optional(),contextLimit:z.number().int().min(4096).max(1024000).optional(),dependsOn:z.array(z.string()).max(20).optional(),parentId:z.string().optional(),budget:z.object({maxCalls:z.number().int().positive().max(10000).optional(),maxInputTokens:z.number().int().positive().optional(),maxOutputTokens:z.number().int().positive().optional(),maxActiveMs:z.number().int().positive().optional(),maxOutputPerCall:z.number().int().positive().max(128000).optional()}).optional()});
 const childSchema=goalSchema.omit({workspace:true,parentId:true});
 app.post<{Params:{id:string}}>('/api/goals/:id/children',async(request,reply)=>{
  const input=childSchema.parse(request.body);
  const parent=store.getGoal(request.params.id);
  if(!parent)return reply.code(404).send({error:'目标不存在'});
  if(parent.status==='running'||store.queued().includes(parent.id)||store.pendingTools(parent.id).length)return reply.code(409).send({error:'请先暂停父目标并核对未完成操作'});
  for(const dependency of input.dependsOn??[])if(!store.getGoal(dependency))throw new Error('Unknown dependency');
  return supervisor.withWorkspaceSnapshot(parent.workspace,async()=>{
  const worktreeId=randomUUID();
   const worktree=await createChildWorktree(parent.workspace,stateDir,worktreeId);
   try{
    const goal=store.createGoal({...input,workspace:worktree.path,parentId:parent.id});
    const event=store.latestEvent(goal.id);if(event)bus.publish(event);
    return goal;
   }catch(error){await removeChildWorktree(parent.workspace,stateDir,worktreeId);throw error;}
  });
 });
 app.post('/api/goals',request=>{const input=goalSchema.parse(request.body);const goal=store.createGoal(input);store.appendMessage(goal.id,{role:'user',content:input.prompt});bus.publish(store.events(0,goal.id).at(-1)!);return goal;});
 app.get<{Params:{id:string}}>('/api/goals/:id',(request,reply)=>{const goal=store.getGoal(request.params.id);if(!goal)return reply.code(404).send({error:'目标不存在'});return{goal,messages:store.getMessages(goal.id),events:store.recentEvents(goal.id),eventCursor:store.latestEvent(goal.id)?.seq??0};});
 for(const action of ['start','resume','pause','cancel']as const)app.post<{Params:{id:string}}>(`/api/goals/:id/${action}`,async(request,reply)=>{const id=request.params.id;if(action==='start'||action==='resume'){await supervisor.start(id);}else await supervisor[action](id);return store.getGoal(id);});
 app.patch<{Params:{id:string}}>('/api/goals/:id',request=>supervisor.revise(request.params.id,z.object({prompt:z.string().trim().min(1).max(100000).optional(),title:z.string().max(200).optional(),acceptanceCommands:z.array(z.string().min(1)).max(20).optional()}).parse(request.body)));
 app.post<{Params:{id:string}}>('/api/goals/:id/reconcile',request=>supervisor.reconcile(request.params.id,z.object({note:z.string().trim().min(1).max(10000)}).parse(request.body).note));
 app.get<{Params:{id:string}}>('/api/goals/:id/diff',async(request)=>{const goal=store.getGoal(request.params.id);if(!goal)throw new Error('Goal not found');const result=await tools.execute('git_diff',{}, {workspace:goal.workspace,runId:`diff-${goal.id}`});return{diff:result.output};});
 const benchmarkPath=options.benchmarkPath??join(process.cwd(),'artifacts','benchmark','summary.json');app.get('/api/benchmark',()=>{if(!existsSync(benchmarkPath))return{status:'not-started',summary:null,trials:[]};try{return JSON.parse(readFileSync(benchmarkPath,'utf8'));}catch{return{status:'unreadable',summary:null,trials:[]};}});
 const streams=new Set<()=>void>();
 app.addHook('preClose',async()=>{for(const stop of streams)stop();streams.clear();});
 app.get<{Querystring:{after?:string}}>('/api/events',async(request,reply)=>{
  const cursor=Number(request.query.after??request.headers['last-event-id']??0);
  if(!Number.isSafeInteger(cursor)||cursor<0)return reply.code(400).send({error:'Invalid event cursor'});
  reply.hijack();
  reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
  reply.raw.flushHeaders();
  const stop=startEventStream(reply.raw,store,bus,cursor,{onClose:()=>streams.delete(stop)});
  streams.add(stop);
 });
 const webRoot=resolve(options.webRoot??join(process.cwd(),'web','dist'));if(existsSync(join(webRoot,'index.html'))){await app.register(staticFiles,{root:webRoot,wildcard:true});app.setNotFoundHandler((request,reply)=>{if(request.url.startsWith('/api/')||request.url.startsWith('/assets/'))return reply.code(404).send({error:'API not found'});return reply.sendFile('index.html');});}else app.get('/',(_request,reply)=>reply.type('text/html').send('<h1>ERNIE Harness</h1><p>请先运行 pnpm build 生成工作台。</p>'));
 app.addHook('onClose',async()=>{await supervisor.shutdown();await maturation.close();store.close();});return{app,store,bus,supervisor,engine,maturation,token,stateDir};
}
