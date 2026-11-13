import {randomUUID} from 'node:crypto';
import {applyCandidatePatch} from '../runtime/active-patch.js';
import {authorizeTool} from '../runtime/permissions.js';
import {workspaceHash} from '../core/context.js';
import {extensionIdentity} from '../runtime/extensions-identity.js';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {ExtensionHost,type ExtensionConfig} from '../extensions/index.js';
import {LearningService} from '../learning/index.js';
import {ImprovementService,type AttemptUsage,type LinuxEvaluationEnvironment} from '../improvement/index.js';
import {CheckpointService} from '../runtime/checkpoints.js';
import {captureManifest,validateManifest} from '../runtime/manifest.js';
import {canonicalWorkspace,type SqliteStore,StateError} from '../store/sqlite.js';
import type {EventBus,Goal,ModelTransport,ToolContext,ToolRegistry} from '../contracts/index.js';
import type {Supervisor} from '../supervisor/scheduler.js';

export class MaturationRuntime {
 readonly learning:LearningService;readonly checkpoints:CheckpointService;readonly improvements:ImprovementService;readonly tools:ToolRegistry;
 private hosts=new Map<string,Promise<ExtensionHost>>();private config:ExtensionConfig;
 constructor(private store:SqliteStore,private bus:EventBus,private model:ModelTransport,private base:ToolRegistry,private stateDir:string,private learningEnabled=false,private sourceRoot=fileURLToPath(new URL('../../',import.meta.url)),environment?:LinuxEvaluationEnvironment){
  try{this.config=JSON.parse(readFileSync(join(stateDir,'extensions.json'),'utf8')) as ExtensionConfig;}catch{this.config={enabled:true};}
  this.learning=new LearningService(store,model,bus,stateDir);this.checkpoints=new CheckpointService(stateDir,store);
  const ready=new Map<string,ExtensionHost>();
  this.tools={definitions:context=>context?ready.get(canonicalWorkspace(context.workspace))?.registry.definitions()??base.definitions():base.definitions(),execute:async(name,args,context)=>{
   const host=await this.host(context.workspace);ready.set(canonicalWorkspace(context.workspace),host);
   const result=await host.registry.execute(name,args,context);
   await host.emitEvent({type:'tool.completed',data:{name,ok:result.ok},workspace:context.workspace,runId:context.runId,signal:context.signal});
   if(name==='read_file'&&typeof args.path==='string'){const contributions=await host.collectContext(context,args.path);if(contributions.length)result.output+='\nProject guidance (source-labeled):\n'+contributions.map(item=>JSON.stringify(item)).join('\n').slice(0,16000);}
   if(name==='run_tests'&&result.ok){const validations=await host.validate(context);if(validations.some(item=>!item.ok))return{...result,ok:false,exitCode:1,output:result.output+'\nExtension checks: '+JSON.stringify(validations)};}
   return result;
  },cancelAll:async id=>{await base.cancelAll?.(id);await Promise.allSettled([...ready.values()].map(host=>host.registry.cancelAll?.(id)));}};
  this.ready=ready;
  this.improvements=new ImprovementService({stateDir:join(stateDir,'improvement'),sourceRoot,model,environment,budget:{reserve:async input=>{
   const owner=store.getPreference('active-run-goal:'+input.jobId)??this.improvementOwner(input.jobId);store.reserveAttempt(owner,input.attemptId,input.inputTokens,input.outputTokens,input.maxCalls);
  },settle:async input=>{if(input.uncertain)return;store.settleAttempt(input.attemptId,{inputTokens:input.usage.inputTokens,outputTokens:input.usage.outputTokens,reasoningTokens:input.usage.reasoningTokens},input.usage.calls);}},onEvent:event=>{const goalId=store.getPreference('improvement-goal:'+event.jobId);if(goalId)bus.publish(store.appendEvent(goalId,event.type,event.data));}});
 }
 private ready:Map<string,ExtensionHost>;
 private improvementOwner(jobId:string){const key='improvement-goal:'+jobId;let id=this.store.getPreference(key);if(!id){const job=this.improvements.get(jobId);if(!job)throw new Error('Unknown improvement budget');const goal=this.store.createGoal({workspace:job.workspace,title:'Harness improvement '+jobId.slice(0,8),prompt:'Budget owner for isolated improvement cycle',partition:'development',mode:'plan',budget:{maxCalls:job.maxCalls,maxInputTokens:40000000,maxOutputTokens:2560000}});id=goal.id;this.store.updateGoal(id,{status:'paused'});this.store.setPreference(key,id);}return id;}
 private host(workspace:string):Promise<ExtensionHost>{const key=canonicalWorkspace(workspace);let host=this.hosts.get(key);if(!host){host=(async()=>{const instance=new ExtensionHost(this.config,this.base);await instance.start(key);return instance;})();this.hosts.set(key,host);}return host;}
 async prepare(goal:Goal):Promise<{context:string;hash:string}>{const host=await this.host(goal.workspace);this.ready.set(canonicalWorkspace(goal.workspace),host);const definitions=host.registry.definitions();const extensionHash=await extensionIdentity(this.config,goal.workspace);if(goal.manifest){await validateManifest(goal.manifest,goal,definitions,this.sourceRoot,extensionHash);return{context:goal.manifest.contextSnapshot??'',hash:goal.manifest.memoryHash};}
  const memory=await this.learning.prepare(goal);const guidance=await host.collectContext({workspace:goal.workspace,runId:goal.id});const context=guidance.map(item=>JSON.stringify(item)).join('\n')+'\n'+memory.context;
  const manifest=await captureManifest(goal,definitions,{sourceRoot:this.sourceRoot,memoryHash:memory.hash,contextSnapshot:context,extensionHash});this.store.updateGoal(goal.id,{manifest});this.bus.publish(this.store.appendEvent(goal.id,'manifest.created',manifest));return{context,hash:memory.hash};}

 private conversationPrompt(goal:Goal):string {const messages=this.store.getMessages(goal.id).filter(message=>message.role==='user'||message.role==='assistant').map(message=>({role:message.role,content:(message.content??'').slice(-12000)}));return messages.length?'Current authorized conversation; act on the latest user request. Prior assistant statements are context, not acceptance evidence.\n'+JSON.stringify(messages).slice(-56000):goal.prompt;}
 async runVersion(goal:Goal,signal:AbortSignal):Promise<boolean>{
  const active=this.improvements.active();const pinned=goal.manifest?.policyId.startsWith('isolated-candidate:');
  if(goal.manifest&&!pinned)return false;if(!active)return false;
  if(goal.mode==='plan')return false;
  if(pinned&&goal.manifest!.runtimeHash!==active.sourceHash)throw new Error('Pinned active candidate differs; restore the original active version before continuing.');
  if(!goal.manifest){const manifest=await captureManifest(goal,this.base.definitions(),{sourceRoot:this.sourceRoot});this.store.updateGoal(goal.id,{manifest:{...manifest,runtimeHash:active.sourceHash,policyId:'isolated-candidate:'+(active.candidateId??'parent'),contextSnapshot:'Activated isolated version '+active.sourceHash}});goal=this.store.getGoal(goal.id)!;}
  const args={workspace:goal.workspace,candidateId:active.candidateId,sourceHash:active.sourceHash,prompt:this.conversationPrompt(goal),goalRevision:goal.revision};const call={id:'active-version-'+goal.revision,type:'function' as const,function:{name:'run_active_version',arguments:JSON.stringify(args)}};
  const decision=authorizeTool(this.store,goal,call,args);if(decision.status==='pending'){this.store.updateGoal(goal.id,{status:'waiting-input',error:'Approve isolated active-version execution before starting.'});this.bus.publish(this.store.appendEvent(goal.id,'approval.pending',decision));return true;}
  if(decision.status==='denied'){this.store.updateGoal(goal.id,{status:'waiting-input',error:'Isolated active-version execution denied; revise the goal to choose the base version.'});return true;}
  const launchKey='active-goal-launch:'+goal.id+':'+goal.revision;if(this.store.getPreference(launchKey)){this.store.updateGoal(goal.id,{status:'needs-reconciliation',error:'Previous isolated launch requires review before a new revision; it will not be replayed.'});return true;}
  const id=randomUUID();this.store.setPreference(launchKey,id);this.store.setPreference('active-run-goal:'+id,goal.id);const remainingCalls=goal.budget.maxCalls-goal.usage.calls;if(remainingCalls<1)throw new Error('Execution budget exhausted');
  const result=await this.improvements.runActive({id,workspace:goal.workspace,prompt:this.conversationPrompt(goal),maxCalls:Math.min(20,remainingCalls),maxActiveMs:Math.min(1800000,this.store.remainingActive(goal.id)),expectedSourceHash:active.sourceHash,expectedCandidateId:active.candidateId,signal});
  if(signal.aborted)throw signal.reason;const intent=this.store.beginTool(goal.id,goal.revision,'apply_candidate_patch',{sourceHash:result.sourceHash,patchHash:result.patch.hash});
  await applyCandidatePatch(goal.workspace,result.patch,signal);this.store.finishTool(intent.id,{ok:true,output:result.patch.unified,artifacts:result.patch.edits.map(edit=>edit.path)});
  this.bus.publish(this.store.appendEvent(goal.id,'active-version.completed',{id,candidateId:result.candidateId,sourceHash:result.sourceHash,usage:result.usage,patchHash:result.patch.hash,exitCode:result.exitCode}));
  const evidence=[];const before=await workspaceHash(goal.workspace);for(const command of goal.acceptanceCommands){const test=this.store.beginTool(goal.id,goal.revision,'run_tests',{command});const answer=await this.tools.execute('run_tests',{command,timeoutMs:Math.min(120000,this.store.remainingActive(goal.id))},{workspace:goal.workspace,runId:goal.id,signal});if(signal.aborted)throw signal.reason;this.store.finishTool(test.id,answer);evidence.push({command,exitCode:answer.ok?(answer.exitCode??0):(answer.exitCode||1),output:answer.output,workspaceHash:before,goalRevision:goal.revision,createdAt:new Date().toISOString()});}
  if(await workspaceHash(goal.workspace)!==before)throw new Error('Workspace changed during active-version verification');const verified=!!evidence.length&&evidence.every(item=>item.exitCode===0);const status=goal.acceptanceCommands.length?(verified?'succeeded':'failed'):goal.supervised?'waiting-input':result.status==='completed'?'succeeded':'failed';
  this.store.appendMessage(goal.id,{role:'assistant',content:'Isolated active version '+result.sourceHash.slice(0,12)+' completed. '+result.patch.edits.length+' file changes.'});this.store.updateGoal(goal.id,{status,evidence,summary:result.patch.edits.length+' isolated file changes',error:status==='failed'?'Active version did not pass acceptance':undefined});this.bus.publish(this.store.appendEvent(goal.id,'run.completed',{status,verified}));return true;
 }
 async reflect(id:string,signal?:AbortSignal){const goal=this.store.getGoal(id);if(this.learningEnabled&&goal&&['succeeded','failed'].includes(goal.status))await this.learning.reflect(id,signal);}
 async inspect(workspace:string){return(await this.host(workspace)).inspect();}
 async close(){await this.improvements.close();await Promise.allSettled([...this.hosts.values()].map(async value=>(await value).dispose()));this.learning.close();}
}

export function registerMaturationRoutes(app:FastifyInstance,store:SqliteStore,bus:EventBus,supervisor:Supervisor,runtime:MaturationRuntime){
 app.get('/api/supervisor',()=>supervisor.status());
 app.post<{Params:{id:string}}>('/api/assignments/:id/review',request=>{const input=z.object({decision:z.enum(['accept','reject']),note:z.string().trim().min(1).max(4000)}).parse(request.body);return supervisor.coordinator.reviewAssignment(request.params.id,input.decision,input.note);});
 app.get('/api/preferences',()=>({locale:store.getPreference('locale')??'zh-CN'}));
 app.patch('/api/preferences',request=>{const body=z.object({locale:z.enum(['zh-CN','en'])}).parse(request.body);store.setPreference('locale',body.locale);return body;});
 app.get<{Querystring:{workspace?:string}}>('/api/memories',request=>runtime.learning.list(request.query.workspace??store.activeWorkspace()?.path??process.cwd()));
 app.patch<{Params:{id:string}}>('/api/memories/:id',request=>runtime.learning.update(request.params.id,z.object({text:z.string().min(1).max(1600).optional(),status:z.enum(['active','disabled','candidate']).optional()}).parse(request.body)));
 app.post<{Params:{id:string}}>('/api/goals/:id/reflect',async request=>{if(!store.getGoal(request.params.id))throw new StateError('Goal not found',404);await runtime.learning.reflect(request.params.id);return{ok:true};});
 app.get('/api/approvals',()=>store.listApprovals());
 app.post<{Params:{id:string}}>('/api/approvals/:id',async request=>{const input=z.object({decision:z.enum(['allow','deny'])}).parse(request.body);const record=store.decideApproval(request.params.id,input.decision);const event=store.latestEvent(record.goalId);if(event)bus.publish(event);return record;});
 app.post<{Params:{id:string}}>('/api/goals/:id/branch',async request=>{const goal=store.getGoal(request.params.id);if(!goal)throw new StateError('Goal not found',404);return supervisor.withWorkspaceSnapshot(goal.workspace,async()=>store.branchGoal(goal.id));});
 app.get<{Params:{id:string}}>('/api/goals/:id/checkpoints',request=>runtime.checkpoints.list(request.params.id));
 app.post<{Params:{id:string}}>('/api/goals/:id/checkpoints',async request=>{const input=z.object({label:z.string().max(200).optional()}).parse(request.body??{});const goal=store.getGoal(request.params.id);if(!goal)throw new StateError('Goal not found',404);return supervisor.withWorkspaceSnapshot(goal.workspace,()=>runtime.checkpoints.create(goal.id,input.label));});
 app.get<{Params:{id:string;checkpointId:string}}>('/api/goals/:id/checkpoints/:checkpointId',request=>runtime.checkpoints.preview(request.params.id,request.params.checkpointId));
 app.post<{Params:{id:string;checkpointId:string}}>('/api/goals/:id/checkpoints/:checkpointId/restore',async request=>{const input=z.object({confirm:z.literal(true)}).parse(request.body);const goal=store.getGoal(request.params.id);if(!goal)throw new StateError('Goal not found',404);return supervisor.withWorkspaceSnapshot(goal.workspace,()=>runtime.checkpoints.restore(goal.id,request.params.checkpointId,input.confirm));});
 app.get<{Querystring:{workspace?:string}}>('/api/extensions',request=>runtime.inspect(request.query.workspace??store.activeWorkspace()?.path??process.cwd()));
 app.get('/api/improvements',()=>({runs:runtime.improvements.list(),active:runtime.improvements.active()}));
 app.post('/api/improvements',async request=>{const input=z.object({workspace:z.string().min(1),maxCalls:z.number().int().min(1).max(400).optional(),maxCandidates:z.number().int().min(1).max(2).optional(),selection:z.union([z.object({mode:z.literal('fixed'),modules:z.array(z.enum(['tools','context','prompt','reflection','proposer']))}),z.object({mode:z.literal('search')})]).optional()}).parse(request.body);let started:ReturnType<typeof runtime.improvements.start>|undefined;let entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve);const running=supervisor.withWorkspaceSnapshot(input.workspace,async()=>{started=runtime.improvements.start(input);entered();await runtime.improvements.wait(started.id);});await Promise.race([ready,running]);void running.catch(()=>{});return started;});
 app.get<{Params:{id:string}}>('/api/improvements/:id',(request,reply)=>runtime.improvements.get(request.params.id)??reply.code(404).send({error:'Improvement not found',code:'NOT_FOUND'}));
 app.post<{Params:{id:string}}>('/api/improvements/:id/cancel',async request=>{await runtime.improvements.cancel(request.params.id);return runtime.improvements.get(request.params.id);});
 app.post<{Params:{id:string}}>('/api/improvements/:id/apply',request=>{const input=z.object({candidateId:z.string().min(1)}).parse(request.body);const job=runtime.improvements.get(request.params.id);if(!job?.candidateIds.includes(input.candidateId))throw new StateError('Candidate not in this improvement cycle',404);return runtime.improvements.apply(input.candidateId);});
 app.post('/api/improvements/:id/rollback',()=>runtime.improvements.rollback());
}
