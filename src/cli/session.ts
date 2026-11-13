import type {Goal,GoalInput,HarnessEvent,Workspace} from '../contracts/index.js';
import {serviceRequest,safeText,type Connection} from './client.js';
import {streamEvents,type StreamStatus} from './events.js';
import {emptyTranscript,hydrateTranscript,reduceTranscript,type Transcript} from './state.js';
import {executionMode,executeManagementCommand,isManagementCommand,slashHelp,type ExecutionMode} from './commands.js';
import {cliText,resolveCliLocale,type CliLocale} from './locale.js';
export interface TerminalOptions {locale?:CliLocale;mode?:ExecutionMode}
export interface TerminalState {goals:Goal[];workspaces:Workspace[];workspace:string;selectedGoalId?:string;thread?:Transcript;locale:CliLocale;mode:ExecutionMode;connection:StreamStatus;busy:boolean;notice:string;panel:string}
interface ServiceState {goals:Goal[];workspaces:Workspace[];workspace:string;activeWorkspaceId?:string}
export function splitArguments(input:string):string[]{
 const result:string[]=[];let value='';let quote='';let active=false;
 for(let index=0;index<input.length;index++){const char=input[index]!;
  if(char==='\\'&&(input[index+1]===quote||input[index+1]==='\\')){value+=input[++index];active=true;continue;}
  if(quote){if(char===quote)quote='';else value+=char;active=true;}
  else if(char==='"'||char==="'"){quote=char;active=true;}
  else if(/\s/.test(char)){if(active){result.push(value);value='';active=false;}}
  else{value+=char;active=true;}
 }
 if(quote)throw new Error('Unclosed quote');if(active)result.push(value);return result;
}
/** Owns all subscriptions, in-flight HTTP requests, refresh timers, and selection state. */
export class TerminalSession {
 state:TerminalState;
 private readonly abort=new AbortController();private readonly listeners=new Set<()=>void>();
 private readonly threads=new Map<string,Transcript>();private readonly snapshotVersions=new Map<string,number>();
 private timer?:ReturnType<typeof setInterval>;private refreshTimer?:ReturnType<typeof setTimeout>;
 private stream?:Promise<void>;private disposed=false;private stateVersion=0;private manualSelection=false;private started=false;
 constructor(readonly connection:Connection,workspace?:string,options:TerminalOptions={}){
  this.state={goals:[],workspaces:[],workspace:workspace??'',locale:options.locale??'zh-CN',mode:options.mode??'standard',connection:'connecting',busy:false,notice:'',panel:''};
 }
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 snapshot=()=>this.state;
 private update(patch:Partial<TerminalState>){if(this.disposed)return;this.state={...this.state,...patch};for(const listener of this.listeners)listener();}
 private request<T>(path:string,body?:unknown,method=body===undefined?'GET':'POST'){return serviceRequest<T>(this.connection,path,body,method,{signal:this.abort.signal});}
 private fail(error:unknown){if(!this.disposed)this.update({notice:safeText(error instanceof Error?error.message:cliText(this.state.locale,'error'),[this.connection.token])});}
 async start(){
  if(this.started||this.disposed)return;this.started=true;
  await Promise.allSettled([this.refreshState(),this.request<{locale?:unknown}>('/preferences').then(preferences=>{this.update({locale:resolveCliLocale(preferences.locale)});})]);
  if(this.disposed)return;
  this.stream=streamEvents(this.connection,{signal:this.abort.signal,onEvent:event=>this.receive(event),onStatus:connection=>this.update({connection})}).catch(error=>this.fail(error));
  if(this.state.selectedGoalId)await this.refreshGoal(this.state.selectedGoalId).catch(error=>this.fail(error));
  if(!this.disposed)this.timer=setInterval(()=>{void this.refreshState().catch(error=>this.fail(error));},15000);
 }
 async stop(){this.disposed=true;this.abort.abort();clearInterval(this.timer);clearTimeout(this.refreshTimer);this.listeners.clear();await this.stream;}
 async refreshState(){
  const version=++this.stateVersion;const state=await this.request<ServiceState>('/state');if(this.disposed||version!==this.stateVersion)return;
  const workspace=this.state.workspace||state.workspace;let selectedGoalId=this.state.selectedGoalId;
  if(!selectedGoalId&&!this.manualSelection)selectedGoalId=state.goals.find(goal=>goal.workspace===workspace)?.id;
  this.update({goals:state.goals,workspaces:state.workspaces??[],workspace,selectedGoalId});
 }
 async refreshGoal(id:string){
  const version=(this.snapshotVersions.get(id)??0)+1;this.snapshotVersions.set(id,version);
  const snapshot=await this.request<{goal:Goal;messages:Transcript['messages'];events:HarnessEvent[];eventCursor?:number}>(`/goals/${encodeURIComponent(id)}`);
  if(this.disposed||this.snapshotVersions.get(id)!==version)return;
  const thread=hydrateTranscript(id,snapshot,this.threads.get(id));this.threads.delete(id);this.threads.set(id,thread);
  if(this.threads.size>20)this.threads.delete(this.threads.keys().next().value!);
  const goals=this.state.goals.map(goal=>goal.id===id?snapshot.goal:goal);
  this.update({goals,...(this.state.selectedGoalId===id?{thread}:{})});
 }
 private receive(event:HarnessEvent){
  if(this.disposed)return;
  if(event.goalId===this.state.selectedGoalId||this.threads.has(event.goalId)){
   const thread=reduceTranscript(this.threads.get(event.goalId)??emptyTranscript(event.goalId),event);this.threads.set(event.goalId,thread);
   if(event.goalId===this.state.selectedGoalId)this.update({thread});
  }
  if(event.type!=='model.delta'&&!event.type.endsWith('.output')){
   clearTimeout(this.refreshTimer);this.refreshTimer=setTimeout(()=>{
    void this.refreshState().then(()=>this.state.selectedGoalId?this.refreshGoal(this.state.selectedGoalId):undefined).catch(error=>this.fail(error));
   },80);
  }
 }
 async selectGoal(id?:string){
  this.manualSelection=true;if(!id){this.update({selectedGoalId:undefined,thread:undefined,panel:'',notice:''});return;}
  const goal=this.state.goals.find(item=>item.id===id);if(!goal)throw new Error(cliText(this.state.locale,'noMatch'));
  this.update({selectedGoalId:id,thread:this.threads.get(id)??emptyTranscript(id),workspace:goal.workspace,panel:'',notice:cliText(this.state.locale,'selected',{id})});
  await this.refreshGoal(id);
 }
 async selectWorkspace(id:string){
  const workspace=this.state.workspaces.find(item=>item.id===id);if(!workspace)throw new Error(cliText(this.state.locale,'noWorkspace'));
  await this.request(`/workspaces/${encodeURIComponent(id)}/select`,{});this.manualSelection=true;
  this.update({workspace:workspace.path,selectedGoalId:undefined,thread:undefined,panel:'',notice:cliText(this.state.locale,'workspaceSelected',{name:workspace.name})});
 }
 async setLocale(value:unknown){const locale=resolveCliLocale(value);await this.request('/preferences',{locale},'PATCH');this.update({locale});}
 async submit(prompt:string){
  if(!prompt.trim()||this.state.busy)return;this.update({busy:true,notice:'',panel:''});
  try{
   let id=this.state.selectedGoalId;
   if(id)await this.request(`/goals/${encodeURIComponent(id)}/messages`,{content:prompt,start:true});
   else{
    if(!this.state.workspace)throw new Error(cliText(this.state.locale,'noWorkspace'));
    const input:GoalInput&{mode:ExecutionMode}={workspace:this.state.workspace,prompt,mode:this.state.mode};
    const goal=await this.request<Goal>('/goals',input);id=goal.id;this.manualSelection=true;
    this.update({goals:[goal,...this.state.goals],selectedGoalId:id,thread:emptyTranscript(id)});await this.request(`/goals/${encodeURIComponent(id)}/start`,{});
   }
   await this.refreshState();if(id)await this.refreshGoal(id);this.update({notice:cliText(this.state.locale,'sent')});
  }finally{this.update({busy:false});}
 }
 async command(input:string):Promise<{quit?:boolean;picker?:'goals'|'workspaces';query?:string}>{
  const [raw,...args]=splitArguments(input);const command=raw?.replace(/^\//,'')??'';
  const id=()=>{if(!this.state.selectedGoalId)throw new Error(cliText(this.state.locale,'noSelection'));return this.state.selectedGoalId;};
  if(command==='quit'||command==='exit')return{quit:true};
  if(command==='help'){this.update({panel:slashHelp(this.state.locale)});return{};}
  if(command==='clear'){this.update({panel:'',notice:''});return{};}
  if(command==='new'){await this.selectGoal();return{};}
  if(command==='goals')return{picker:'goals',query:args.join(' ')};
  if(command==='select'||command==='continue'){
   const value=args[0];const goal=this.state.goals.find(item=>item.id===value)??this.state.goals.filter(item=>item.workspace===this.state.workspace)[Number(value)-1];
   if(!goal)throw new Error(cliText(this.state.locale,'noMatch'));await this.selectGoal(goal.id);
   if(command==='continue'&&args.length>1)await this.submit(args.slice(1).join(' '));return{};
  }
  if(command==='workspace'){
   if(!args.length)return{picker:'workspaces'};
   const workspace=this.state.workspaces.find(item=>item.id===args[0])??this.state.workspaces[Number(args[0])-1];
   if(!workspace)throw new Error(cliText(this.state.locale,'noWorkspace'));await this.selectWorkspace(workspace.id);return{};
  }
  if(command==='mode'){this.update({mode:executionMode(args[0])});return{};}
  if(command==='lang'){if(!args[0])throw new Error(cliText(this.state.locale,'invalidLanguage'));await this.setLocale(args[0]);return{};}
  if(['pause','resume','cancel'].includes(command)){await this.request(`/goals/${encodeURIComponent(id())}/${command}`,{});await this.refreshState();await this.refreshGoal(id());return{};}
  let management=command;let managementArgs=args;
  if(command==='allow'||command==='deny'){management='approvals';managementArgs=[command,...args];}
  if(command==='branch'){management='sessions';managementArgs=['branch',id(),...args];}
  if(command==='checkpoints'){management='checkpoint';managementArgs=['list',id()];}
  if(command==='checkpoint'){managementArgs=['create',id(),...args];}
  if(command==='restore'){management='checkpoint';managementArgs=['restore',id(),...args];}
  if(isManagementCommand(management)){
   const result=await executeManagementCommand(this.connection,management,managementArgs,{workspace:this.state.workspace,locale:this.state.locale,selectedGoalId:this.state.selectedGoalId,signal:this.abort.signal});
   this.update({panel:safeText(JSON.stringify(result,null,2),[this.connection.token]).slice(-12000)});await this.refreshState();if(this.state.selectedGoalId)await this.refreshGoal(this.state.selectedGoalId);return{};
  }
  throw new Error(cliText(this.state.locale,'unknown',{command}));
 }
}
