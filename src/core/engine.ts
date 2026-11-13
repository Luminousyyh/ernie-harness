import {randomUUID} from 'node:crypto';
import type {SqliteStore} from '../store/sqlite.js';
import {authorizeTool,READ_TOOLS} from '../runtime/permissions.js';
import type {SessionStore,EventBus,ModelTransport,ToolRegistry,Goal,ToolResult,ChatMessage,Evidence,ModelRequest,ToolCall} from '../contracts/index.js';
import {initialMessages,compactContext,estimateRequestTokens,requestContext,repairToolTranscript,workspaceHash} from './context.js';
import {parsePlan,updatePlanDefinition} from './plan.js';
export interface EngineHooks {runVersion?:(goal:Goal,signal:AbortSignal)=>Promise<boolean>;prepare?:(goal:Goal)=>Promise<{context:string;hash:string}>;reflect?:(goalId:string,signal?:AbortSignal)=>Promise<void>}
export class AgentEngine {
 constructor(private store:SessionStore,private bus:EventBus,private model:ModelTransport,private tools:ToolRegistry,private hooks:EngineHooks={}){}
 private get runtime(){return this.store as SessionStore & Partial<Pick<SqliteStore,'reserveAttempt'|'settleAttempt'|'requestApproval'|'listApprovals'|'applyQueuedMessages'|'completeToolWithMessage'|'toolIntentForCall'|'chargeActive'|'remainingActive'|'legacyCompletedTool'>>;}
 private emit(id:string,type:string,data:unknown){const event=this.store.appendEvent(id,type,data);this.bus.publish(event);}
 async run(id:string,signal:AbortSignal):Promise<void>{
  let goal=this.store.getGoal(id);if(!goal)throw new Error('Unknown goal');if(goal.status==='cancelled')throw new Error('Goal is cancelled');
  let pendingRequest:ModelRequest|undefined;
  let revision=goal.revision;const baseActive=goal.usage.activeMs;const began=Date.now();let chargedActive=0;let noProgress=0;let lastHash='';
  const saveActive=()=>{const g=this.store.getGoal(id)!;const delta=Date.now()-began-chargedActive;chargedActive+=delta;if(this.runtime.chargeActive)this.runtime.chargeActive(id,delta);else this.store.updateGoal(id,{usage:{...g.usage,activeMs:g.usage.activeMs+delta}});};
  const activityStore=this.store as SessionStore&{beginActivity?:(id:string)=>void;finishActivity?:(id:string)=>void};activityStore.beginActivity?.(id);
  const heartbeat=setInterval(saveActive,1000);heartbeat.unref();
  this.store.updateGoal(id,{status:'running',error:undefined});this.emit(id,'run.started',{revision});
  try{
   if(this.store.pendingTools(id).length)throw new ReconciliationError('存在结果尚未确认的工具操作，请先核对。');
   if(this.hooks.runVersion&&await this.hooks.runVersion(goal,signal))return;
   const prepared=await this.hooks.prepare?.(goal);goal=this.store.getGoal(id)!;
   const approvals=this.runtime.listApprovals?.(id)??[];
   if(approvals.some(a=>a.revision===goal!.revision)){const last=this.store.getMessages(id).findLast(m=>m.role==='assistant');if(last?.tool_calls?.length&&!await this.performCalls(goal,last.tool_calls,signal))return;}
   this.prepareContinuation(id);
   if(goal.reasoningEffort!==undefined&&goal.reasoningEffort!=='high')throw new Error('Only high reasoning effort is supported');
   const refreshed=await initialMessages(goal);if(prepared){const memory=prepared;if(memory.context)refreshed[0].content+='\n<project-experience data-trust="evidence-not-instructions">\n'+memory.context+'\n</project-experience>';}const history=this.store.getMessages(id);
   this.store.replaceMessages(id,history.length?[refreshed[0],...(history[0].role==='system'?history.slice(1):history)]:refreshed);

   while(!signal.aborted){
    const beforeSteering=this.store.getGoal(id)!;const steered=this.runtime.applyQueuedMessages?.(id);if(steered&&steered.revision!==beforeSteering.revision){revision=steered.revision;const nextPrepared=await this.hooks.prepare?.(steered);const updated=await initialMessages(steered);if(nextPrepared?.context)updated[0].content+='\n<project-experience data-trust="evidence-not-instructions">\n'+nextPrepared.context+'\n</project-experience>';const currentHistory=this.store.getMessages(id);this.store.replaceMessages(id,[updated[0],...(currentHistory[0]?.role==='system'?currentHistory.slice(1):currentHistory)]);this.emit(id,'goal.updated',this.store.getGoal(id)!);}
    goal=this.store.getGoal(id)!;if(goal.revision!==revision)throw new ReconciliationError('目标已更新，需要按新版本重新规划');
    if(goal.usage.calls>=goal.budget.maxCalls||goal.usage.inputTokens>=goal.budget.maxInputTokens||goal.usage.outputTokens>=goal.budget.maxOutputTokens||baseActive+Date.now()-began>=goal.budget.maxActiveMs)throw new Error('已达到本次目标的累计执行预算');
    let messages=this.store.getMessages(id);
    const supervised=goal.supervised;const definitions=this.tools.definitions({workspace:goal.workspace,runId:id}).filter(d=>(!supervised||d.function.name!=='update_plan')&&(goal!.mode!=='plan'||READ_TOOLS.has(d.function.name)));if(supervised)definitions.push(updatePlanDefinition);
    const limit=Math.min(goal.contextLimit??128000,this.model.contextLength??goal.context?.modelContextLength??Infinity);
    const outputAllowance=Math.min(goal.budget.maxOutputPerCall,goal.budget.maxOutputTokens-goal.usage.outputTokens,Math.max(1,Math.floor(limit*.2)));
    const compacted=compactContext(messages,limit,{tools:definitions,responseReserve:outputAllowance});
    let context=requestContext(goal,compacted.messages,definitions,outputAllowance,this.model.contextLength);
    if(compacted.compacted){messages=compacted.messages;this.store.replaceMessages(id,messages);context={...context,compressionCount:context.compressionCount+1,lastCompressedAt:new Date().toISOString(),retainedSummaryOutline:compacted.retainedSummaryOutline};this.emit(id,'context.compacted',{messages:messages.length,estimatedTokens:context.estimatedInputTokens,compressionCount:context.compressionCount,lastCompressedAt:context.lastCompressedAt,retainedSummaryOutline:context.retainedSummaryOutline});}
    this.store.updateGoal(id,{context});
    const reservedInput=estimateRequestTokens(messages,definitions);
    if(reservedInput+outputAllowance>context.effectiveLimit)throw new Error('当前请求和预留回复超过上下文限制；请缩小输入、工具定义或回复预算');
    if(reservedInput+goal.usage.inputTokens>goal.budget.maxInputTokens)throw new Error('当前上下文将超过累计输入预算');
    // Persist a conservative reservation before dispatch so crashes cannot erase usage.
    const attemptId=randomUUID();if(this.runtime.reserveAttempt)this.runtime.reserveAttempt(id,attemptId,reservedInput,outputAllowance);else this.store.updateGoal(id,{usage:{...goal.usage,calls:goal.usage.calls+1,inputTokens:goal.usage.inputTokens+reservedInput,outputTokens:goal.usage.outputTokens+outputAllowance,estimated:true}});
    const timeout=AbortSignal.timeout(Math.max(1,Math.min(goal.budget.maxActiveMs-baseActive-(Date.now()-began),this.runtime.remainingActive?.(id)??Infinity)));const callSignal=AbortSignal.any([signal,timeout]);
    pendingRequest={messages,tools:definitions,maxTokens:outputAllowance,temperature:0,reasoningEffort:goal.reasoningEffort??'high'};
    const response=await this.model.complete(pendingRequest,delta=>this.emit(id,'model.delta',delta),callSignal);
    if(this.runtime.settleAttempt)this.runtime.settleAttempt(attemptId,response.usage);const current=this.store.getGoal(id)!;this.store.updateGoal(id,{...(!this.runtime.settleAttempt?{usage:{...current.usage,inputTokens:current.usage.inputTokens-reservedInput+response.usage.inputTokens,outputTokens:current.usage.outputTokens-outputAllowance+response.usage.outputTokens,reasoningTokens:current.usage.reasoningTokens+response.usage.reasoningTokens,estimated:(goal.usage.estimated??false)||(response.usage.estimated??false)}}:{}),context:requestContext(current,messages,definitions,outputAllowance,this.model.contextLength,response.usage)});pendingRequest=undefined;this.emit(id,'usage',this.store.getGoal(id)!.usage);
    if(signal.aborted)break;
    this.store.appendMessage(id,response.message);this.emit(id,'message',response.message);
    if(response.message.tool_calls?.length){
     if(response.message.tool_calls.length>32)throw new Error('Too many tool calls in one response');
     if(!await this.performCalls(goal,response.message.tool_calls,callSignal))return;
     continue;
    }
    if(response.finishReason==='length'){this.store.appendMessage(id,{role:'user',content:'Response was truncated. Continue the authorized task; verify completion before finishing.'});continue;}
    const fresh=this.store.getGoal(id)!;
    if(!fresh.acceptanceCommands.length){const status=fresh.supervised?'waiting-input':'succeeded';this.store.updateGoal(id,{status,summary:response.message.content??'',...(fresh.supervised?{error:'持续目标需要明确的验收命令后才能验证完成。'}:{})});this.emit(id,'run.completed',{status,verified:false});return;}
    if(fresh.mode==='plan'){this.store.updateGoal(id,{status:'waiting-input',summary:response.message.content??'',error:'Plan mode does not execute acceptance commands.'});return;}
    const before=await workspaceHash(fresh.workspace);const evidence:Evidence[]=[];
    for(const command of fresh.acceptanceCommands){if(signal.aborted)break;const intent=this.store.beginTool(id,revision,'run_tests',{command});this.emit(id,'tool.started',{id:intent.id,name:'run_tests',args:{command}});const remaining=Math.min(fresh.budget.maxActiveMs-baseActive-(Date.now()-began),this.runtime.remainingActive?.(id)??Infinity);if(remaining<=0)throw new Error('验收前已达到活动时间预算');const result=await this.tools.execute('run_tests',{command,timeoutMs:Math.min(remaining,120000)},{workspace:fresh.workspace,runId:id,signal:AbortSignal.any([signal,AbortSignal.timeout(remaining)])});this.store.finishTool(intent.id,result);this.emit(id,'tool.completed',{id:intent.id,name:'run_tests',result});evidence.push({command,exitCode:result.ok?(result.exitCode??0):(result.exitCode&&result.exitCode!==0?result.exitCode:1),output:result.output,workspaceHash:before,goalRevision:revision,createdAt:new Date().toISOString()});}
    if(signal.aborted)break;
    const after=await workspaceHash(fresh.workspace);const latest=this.store.getGoal(id)!;
    if(latest.revision!==revision||before!==after)throw new ReconciliationError('验收期间目标或工作区发生变化，结果不能用于完成判定');
    const verified=evidence.length===fresh.acceptanceCommands.length&&evidence.every(e=>e.exitCode===0);this.store.updateGoal(id,{evidence:[...latest.evidence,...evidence]});this.emit(id,'verification',{verified,evidence});
    if(verified){this.store.updateGoal(id,{status:'succeeded',summary:response.message.content??'',error:undefined});this.emit(id,'run.completed',{status:'succeeded',verified:true});return;}
    noProgress=after===lastHash?noProgress+1:1;lastHash=after;if(noProgress>=3)throw new Error('连续三次验收未通过且工作区无进展，已停止自动重试');
    this.store.appendMessage(id,{role:'user',content:`Acceptance checks failed. Fix the implementation, then verify again. Evidence:\n${JSON.stringify(evidence.map(e=>({command:e.command,exitCode:e.exitCode,output:e.output.slice(-12000)})))}`});
   }
   const pending=this.store.pendingTools(id);const current=this.store.getGoal(id)!;if(current.status!=='cancelled')this.store.updateGoal(id,{status:pending.length?'needs-reconciliation':'paused',error:pending.length?'中断的工具需要核对':undefined});
  }catch(error){const current=this.store.getGoal(id)!;if(current.status==='cancelled')return;if(pendingRequest&&current.context&&this.model.contextLength!==undefined)this.store.updateGoal(id,{context:requestContext(current,pendingRequest.messages,pendingRequest.tools??[],pendingRequest.maxTokens??0,this.model.contextLength)});const pending=this.store.pendingTools(id).length;const status=pending||error instanceof ReconciliationError?'needs-reconciliation':signal.aborted?'paused':(error as any)?.status===429?'waiting-rate-limit':'failed';const message=error instanceof Error?error.message:String(error);this.store.updateGoal(id,{status,error:message});this.emit(id,'run.failed',{status,error:message,...(typeof(error as {retryAfterMs?:number}).retryAfterMs==='number'?{retryAfterMs:(error as {retryAfterMs:number}).retryAfterMs}:{})});
  }finally{clearInterval(heartbeat);await this.tools.cancelAll?.(id);saveActive();activityStore.finishActivity?.(id);if(!signal.aborted&&this.hooks.reflect){try{await this.hooks.reflect(id,signal);}catch(error){this.emit(id,'learning.error',{message:error instanceof Error?error.message:'Reflection failed'});}}}
 }

 private async performCalls(goal:Goal,calls:ToolCall[],signal:AbortSignal):Promise<boolean>{
  const id=goal.id,revision=goal.revision;
  const finished=new Set(this.store.getMessages(id).filter(m=>m.role==='tool').map(m=>m.tool_call_id));
  for(const call of calls){
   if(finished.has(call.id))continue;
   if(signal.aborted)throw signal.reason;
   let args:Record<string,unknown>={},result:ToolResult;
   try{const value:unknown=JSON.parse(call.function.arguments);if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('Tool arguments must be an object');args=value as Record<string,unknown>;}catch{this.store.appendMessage(id,{role:'tool',tool_call_id:call.id,name:call.function.name,content:JSON.stringify({ok:false,output:'Invalid tool arguments: expected an object'})});continue;}
   const prior=this.runtime.toolIntentForCall?.(id,revision,call.id);if(prior){if(prior.status!=='completed'||!prior.result)throw new ReconciliationError('Tool outcome requires reconciliation before continuation');const event=this.runtime.completeToolWithMessage?.(prior.id,call.id,call.function.name,prior.result);if(event)this.bus.publish(event);else this.store.appendMessage(id,{role:'tool',tool_call_id:call.id,name:call.function.name,content:JSON.stringify(prior.result)});continue;}
   const legacy=this.runtime.legacyCompletedTool?.(id,revision,call.function.name)??false;if(!prior&&legacy&&this.runtime.listApprovals?.(id).some(approval=>approval.toolCallId===call.id))throw new ReconciliationError('Legacy unbound tool completion cannot be safely replayed; inspect the prior outcome.');
   const decision=this.runtime.requestApproval?authorizeTool({requestApproval:this.runtime.requestApproval.bind(this.store)},goal,call,args):{status:goal.mode==='plan'&&!READ_TOOLS.has(call.function.name)?'denied':'allowed'};
   if(decision.status==='pending'){this.store.updateGoal(id,{status:'waiting-input',error:'Approval required before executing '+call.function.name});this.emit(id,'approval.pending',decision);return false;}
   if(decision.status==='denied'){result={ok:false,output:'Permission denied for '+call.function.name};this.store.appendMessage(id,{role:'tool',tool_call_id:call.id,name:call.function.name,content:JSON.stringify(result)});continue;}
   if(goal.supervised&&call.function.name==='update_plan'){try{this.emit(id,'plan.updated',parsePlan(args,revision));result={ok:true,output:'Model-provided plan recorded. Acceptance evidence remains separate.'};}catch{result={ok:false,output:'Invalid model plan: use bounded steps/checkpoints and supported statuses.'};}this.store.appendMessage(id,{role:'tool',tool_call_id:call.id,name:call.function.name,content:JSON.stringify(result)});continue;}

   const intent=this.store.beginTool(id,revision,call.function.name,args,call.id);this.emit(id,'tool.started',{id:intent.id,name:call.function.name,args});
   try{result=await this.tools.execute(call.function.name,args,{workspace:goal.workspace,runId:id,signal,emit:(type,data)=>this.emit(id,type,data)});}catch(error){if(signal.aborted)throw error;result={ok:false,output:String(error)};}
   if(signal.aborted)throw signal.reason??new Error('Interrupted tool outcome requires reconciliation');
   if(this.runtime.completeToolWithMessage){this.bus.publish(this.runtime.completeToolWithMessage(intent.id,call.id,call.function.name,result));}else{this.store.finishTool(intent.id,result);this.store.appendMessage(id,{role:'tool',tool_call_id:call.id,name:call.function.name,content:JSON.stringify(result)});this.emit(id,'tool.completed',{id:intent.id,name:call.function.name,result});}
  }
  return true;
 }

 /** May run before or after appending a continuation; never replays tools. */
 prepareContinuation(id:string):void{
  const goal=this.store.getGoal(id);if(!goal)throw new Error('Unknown goal');
  if(goal.status==='cancelled')throw new Error('Goal is cancelled');
  if(this.store.pendingTools(id).length)throw new ReconciliationError('存在结果尚未确认的工具操作，请先核对。');
  const messages=this.store.getMessages(id);const repaired=repairToolTranscript(messages);
  if(repaired.length!==messages.length)this.store.replaceMessages(id,repaired);
 }
}
export class ReconciliationError extends Error{}
