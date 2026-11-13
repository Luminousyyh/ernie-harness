import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {mkdirSync,realpathSync,statSync,existsSync} from 'node:fs';
import {dirname,isAbsolute,basename} from 'node:path';
import {DEFAULT_BUDGET,type SessionStore,type Goal,type GoalInput,type ChatMessage,type HarnessEvent,type ToolIntent,type ToolResult,type Workspace,type Usage,type ApprovalRequest} from '../contracts/index.js';
const json=(value:unknown)=>JSON.stringify(value);
export class StateError extends Error {constructor(message:string,public statusCode=400){super(message);}}
const pathKey=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
export function canonicalWorkspace(path:string):string {
 if(!isAbsolute(path))throw new StateError('工作目录必须使用绝对路径');
 try{const real=realpathSync(path);if(!statSync(real).isDirectory())throw new Error();return real;}
 catch{throw new StateError('工作目录不存在或不是可访问的文件夹');}
}

export class SqliteStore implements SessionStore {
 private db:DatabaseSync; private closed=false; private transactionDepth=0;
 constructor(path:string){if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});const existed=path!==':memory:'&&existsSync(path);this.db=new DatabaseSync(path);const version=Number((this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);if(version>2)throw new Error('Database schema is newer than this runtime');if(existed&&version<2){const backup=path+'.migration-'+Date.now()+'.backup';this.db.exec("VACUUM INTO '"+backup.replaceAll("'","''")+"'");}this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,ancestors TEXT NOT NULL,input INTEGER NOT NULL,output INTEGER NOT NULL,status TEXT NOT NULL,calls INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,binding TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS queued_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,goal_id TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending');
 PRAGMA user_version=2;
 CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,path_key TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,goal_id TEXT NOT NULL REFERENCES goals(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,goal_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),data TEXT NOT NULL,status TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS active_runs(goal_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, reserved_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS active_run_owners(goal_id TEXT NOT NULL,owner_id TEXT NOT NULL,charged_ms INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(goal_id,owner_id));
 CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS events_goal ON events(goal_id,seq); CREATE INDEX IF NOT EXISTS events_goal_type ON events(goal_id,type,seq); CREATE INDEX IF NOT EXISTS messages_goal ON messages(goal_id,seq);`); }
 transaction<T>(fn:()=>T):T{const depth=this.transactionDepth++;const name='nested_'+depth;try{this.db.exec(depth===0?'BEGIN IMMEDIATE':'SAVEPOINT '+name);try{const result=fn();this.db.exec(depth===0?'COMMIT':'RELEASE SAVEPOINT '+name);return result;}catch(error){this.db.exec(depth===0?'ROLLBACK':'ROLLBACK TO SAVEPOINT '+name);if(depth)this.db.exec('RELEASE SAVEPOINT '+name);throw error;}}finally{this.transactionDepth--;}}
 createGoal(input:GoalInput):Goal{
  if(!input.prompt?.trim())throw new Error('目标内容不能为空');
  const workspace=canonicalWorkspace(input.workspace);const budget={...DEFAULT_BUDGET,...input.budget};
  for(const [key,value]of Object.entries(budget))if(!Number.isFinite(value)||value<=0||!Number.isInteger(value))throw new Error(`Invalid budget ${key}`);
  if(input.reasoningEffort!==undefined&&input.reasoningEffort!=='high')throw new StateError('该免费模型当前只验证 high 思考强度');
  if(input.contextLimit!==undefined&&(!Number.isInteger(input.contextLimit)||input.contextLimit<4096||input.contextLimit>1024000))throw new Error('Invalid context limit');
  const at=new Date().toISOString(); const goal:Goal={mode:input.mode??'trusted',partition:(input.budgetRootId?this.getGoal(input.budgetRootId)?.partition:input.parentId?this.getGoal(input.parentId)?.partition:undefined)??input.partition??'production',...(input.budgetRootId?{budgetRootId:input.budgetRootId}:input.parentId?{budgetRootId:this.getGoal(input.parentId)?.budgetRootId??input.parentId}:{}),id:randomUUID(),title:input.title?.trim()||input.prompt.trim().slice(0,60),prompt:input.prompt,workspace,acceptanceCommands:input.acceptanceCommands??[],status:'pending',revision:1,budget,usage:{calls:0,inputTokens:0,outputTokens:0,reasoningTokens:0,activeMs:0},createdAt:at,updatedAt:at,evidence:[],dependsOn:input.dependsOn??[],supervised:input.supervised??false,contextLimit:input.contextLimit??128000,reasoningEffort:input.reasoningEffort??'high',...(input.parentId?{parentId:input.parentId}:{})};
  for(const dep of goal.dependsOn)if(!this.getGoal(dep))throw new Error(`Unknown dependency ${dep}`);
  this.addWorkspace({path:workspace});
  this.transaction(()=>{this.db.prepare('INSERT INTO goals VALUES(?,?)').run(goal.id,json(goal));this.appendEvent(goal.id,'goal.created',goal);});return goal;
 }
 listWorkspaces():Workspace[]{return(this.db.prepare('SELECT data FROM workspaces ORDER BY rowid').all()as {data:string}[]).map(r=>JSON.parse(r.data));}
 getWorkspace(id:string):Workspace|undefined{const row=this.db.prepare('SELECT data FROM workspaces WHERE id=?').get(id)as {data:string}|undefined;return row?JSON.parse(row.data):undefined;}
 addWorkspace(input:{path:string;name?:string}):Workspace {
  const path=canonicalWorkspace(input.path),key=pathKey(path);
  const existing=this.db.prepare('SELECT data FROM workspaces WHERE path_key=?').get(key)as {data:string}|undefined;
  if(existing)return JSON.parse(existing.data);
  const workspace:Workspace={id:randomUUID(),path,name:input.name?.trim()||basename(path)||path,createdAt:new Date().toISOString()};
  this.db.prepare('INSERT INTO workspaces VALUES(?,?,?)').run(workspace.id,key,json(workspace));
  return workspace;
 }
 editWorkspace(id:string,input:{path?:string;name?:string}):Workspace {
  const old=this.getWorkspace(id);if(!old)throw new StateError('工作区不存在',404);
  const path=input.path===undefined?old.path:canonicalWorkspace(input.path);
  const duplicate=this.db.prepare('SELECT id FROM workspaces WHERE path_key=? AND id!=?').get(pathKey(path),id);
  if(duplicate)throw new StateError('该目录已在工作区列表中',409);
  const workspace={...old,path,name:input.name?.trim()||old.name};
  this.db.prepare('UPDATE workspaces SET path_key=?,data=? WHERE id=?').run(pathKey(path),json(workspace),id);
  return workspace;
 }
 selectWorkspace(id:string):Workspace {
  const workspace=this.getWorkspace(id);if(!workspace)throw new StateError('工作区不存在',404);
  canonicalWorkspace(workspace.path);
  this.db.prepare("INSERT INTO preferences VALUES('activeWorkspace',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);
  return workspace;
 }
 activeWorkspace():Workspace|undefined {
  const selected=this.db.prepare("SELECT value FROM preferences WHERE key='activeWorkspace'").get()as {value:string}|undefined;
  return selected?this.getWorkspace(selected.value):undefined;
 }
 reviseGoal(id:string,expectedRevision:number,patch:Pick<Partial<Goal>,'title'|'prompt'|'acceptanceCommands'>):Goal {
  return this.transaction(()=>{
   const old=this.getGoal(id);if(!old)throw new StateError('目标不存在',404);
   if(old.status==='cancelled'||old.revision!==expectedRevision)throw new StateError('目标已取消或版本已变更',409);
   if(this.pendingTools(id).length)throw new StateError('请先核对中断操作',409);
   const goal:Goal={...old,...patch,revision:old.revision+1,status:'paused',error:undefined,summary:undefined,context:undefined,evidence:[],manifest:undefined,updatedAt:new Date().toISOString()};
   this.db.prepare("UPDATE outbox SET status='done' WHERE goal_id=?").run(id);
   this.db.prepare('DELETE FROM messages WHERE goal_id=?').run(id);
   this.db.prepare('UPDATE goals SET data=? WHERE id=?').run(json(goal),id);
   this.appendEvent(id,'goal.updated',goal);return goal;
  });
 }
 continueConversation(id:string,content:string,initial:ChatMessage[]=[]):Goal {
  const old=this.getGoal(id);if(!old)throw new StateError('目标不存在',404);
  if(!content.trim())throw new StateError('消息不能为空');
  if(['running','waiting-rate-limit','cancelled','needs-reconciliation'].includes(old.status)||this.queued().includes(id)||this.pendingTools(id).length)throw new StateError('请先暂停任务并核对未完成操作；已取消的对话不能继续',409);
  const goal:Goal={...old,revision:old.revision+1,status:'paused',error:undefined,summary:undefined,evidence:[],manifest:undefined,updatedAt:new Date().toISOString()};
  const message:ChatMessage={role:'user',content:content.trim()};
  this.transaction(()=>{
   if(!this.getMessages(id).length){const append=this.db.prepare('INSERT INTO messages(goal_id,data) VALUES(?,?)');for(const m of initial)append.run(id,json(m));}
   this.appendMessage(id,message);
   this.db.prepare('UPDATE goals SET data=? WHERE id=?').run(json(goal),id);
   this.appendEvent(id,'message',message);this.appendEvent(id,'goal.updated',goal);
  });return goal;
 }
 getGoal(id:string):Goal|undefined{const row=this.db.prepare('SELECT data FROM goals WHERE id=?').get(id) as {data:string}|undefined;return row?JSON.parse(row.data):undefined;}
 listGoals():Goal[]{return(this.db.prepare('SELECT data FROM goals ORDER BY rowid DESC').all()as {data:string}[]).map(r=>JSON.parse(r.data));}
 updateGoal(id:string,patch:Partial<Goal>):Goal{const old=this.getGoal(id);if(!old)throw new Error('Goal not found');if(old.status==='cancelled'&&patch.status&&patch.status!=='cancelled')throw new StateError('Cancelled goal is terminal',409);const goal={...old,...patch,id:old.id,createdAt:old.createdAt,updatedAt:new Date().toISOString()};this.transaction(()=>{this.db.prepare('UPDATE goals SET data=? WHERE id=?').run(json(goal),id);this.appendEvent(id,'goal.updated',goal);});return goal;}
 getMessages(id:string):ChatMessage[]{return(this.db.prepare('SELECT data FROM messages WHERE goal_id=? ORDER BY seq').all(id)as {data:string}[]).map(r=>JSON.parse(r.data));}
 appendMessage(id:string,message:ChatMessage):void{this.db.prepare('INSERT INTO messages(goal_id,data) VALUES(?,?)').run(id,json(message));}
 replaceMessages(id:string,messages:ChatMessage[]):void{this.transaction(()=>{this.db.prepare('DELETE FROM messages WHERE goal_id=?').run(id);const stmt=this.db.prepare('INSERT INTO messages(goal_id,data) VALUES(?,?)');for(const message of messages)stmt.run(id,json(message));});}
 appendEvent(goalId:string,type:string,data:unknown):HarnessEvent{const createdAt=new Date().toISOString();const result=this.db.prepare('INSERT INTO events(goal_id,type,data,created_at) VALUES(?,?,?,?)').run(goalId,type,json(data),createdAt);return{seq:Number(result.lastInsertRowid),goalId,type,data,createdAt};}
 events(after=0,goalId?:string):HarnessEvent[]{const rows=goalId?this.db.prepare('SELECT * FROM events WHERE seq>? AND goal_id=? ORDER BY seq LIMIT 5000').all(after,goalId):this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 5000').all(after);return rows.map((r:any)=>({seq:Number(r.seq),goalId:r.goal_id,type:r.type,data:JSON.parse(r.data),createdAt:r.created_at}));}
 recentEvents(goalId:string,limit=5000):HarnessEvent[]{
  const count=Math.min(5000,Math.max(1,limit));
  const rows=this.db.prepare('SELECT * FROM events WHERE goal_id=? ORDER BY seq DESC LIMIT ?').all(goalId,count).reverse() as any[];
  // Streaming deltas must not hide the latest durable plan after reconnect.
  const plan=this.db.prepare("SELECT * FROM events WHERE goal_id=? AND type='plan.updated' ORDER BY seq DESC LIMIT 1").get(goalId) as any;
  if(count>1&&plan&&!rows.some(row=>row.seq===plan.seq)){if(rows.length>=count)rows.shift();rows.unshift(plan);}
  return rows.map((r:any)=>({seq:Number(r.seq),goalId:r.goal_id,type:r.type,data:JSON.parse(r.data),createdAt:r.created_at}));
 }
 beginTool(goalId:string,revision:number,name:string,args:Record<string,unknown>,toolCallId?:string):ToolIntent {
  return this.transaction(()=>{
   if(toolCallId!==undefined&&(!toolCallId||this.toolIntentForCall(goalId,revision,toolCallId)))throw new StateError('Tool call already has an intent or has an invalid binding',409);
   const intent:ToolIntent={id:randomUUID(),goalId,revision,name,args,status:'pending',createdAt:new Date().toISOString(),...(toolCallId!==undefined?{toolCallId}:{})};
   this.db.prepare('INSERT INTO intents VALUES(?,?,?,?)').run(intent.id,goalId,json(intent),intent.status);return intent;
  });
 }
 legacyCompletedTool(goalId:string,revision:number,name:string):boolean {return !!this.db.prepare("SELECT id FROM intents WHERE goal_id=? AND status='completed' AND json_extract(data,'$.revision')=? AND json_extract(data,'$.name')=? AND json_extract(data,'$.toolCallId') IS NULL LIMIT 1").get(goalId,revision,name);}
 toolIntentForCall(goalId:string,revision:number,toolCallId:string):ToolIntent|undefined {
  const rows=this.db.prepare("SELECT data FROM intents WHERE goal_id=? AND json_extract(data,'$.revision')=? AND json_extract(data,'$.toolCallId')=? ORDER BY rowid DESC LIMIT 2").all(goalId,revision,toolCallId) as {data:string}[];
  if(rows.length>1)throw new StateError('Ambiguous tool call binding requires reconciliation',409);
  return rows[0]?JSON.parse(rows[0].data):undefined;
 }
 completeToolWithMessage(intentId:string,toolCallId:string,name:string,result:ToolResult):HarnessEvent {
  return this.transaction(()=>{
   const row=this.db.prepare('SELECT data FROM intents WHERE id=?').get(intentId) as {data:string}|undefined;if(!row)throw new StateError('Unknown tool intent',404);
   const intent=JSON.parse(row.data) as ToolIntent&{toolCallId?:string};
   if(!toolCallId||intent.name!==name||(intent.toolCallId!==undefined&&intent.toolCallId!==toolCallId))throw new StateError('Tool completion binding mismatch',409);
   if(intent.status==='completed'&&(!intent.toolCallId||!isDeepStrictEqual(intent.result,result)))throw new StateError('Completed tool outcome mismatch or unbound legacy intent',409);
   const existing=this.getMessages(intent.goalId).filter(message=>message.role==='tool'&&message.tool_call_id===toolCallId);
   if(existing.length>1||existing.some(message=>message.name!==name||message.content!==json(result)))throw new StateError('Tool transcript outcome mismatch',409);
   if(!intent.toolCallId)this.db.prepare('UPDATE intents SET data=? WHERE id=?').run(json({...intent,toolCallId}),intentId);
   if(intent.status!=='completed')this.finishTool(intentId,result);
   if(!existing.length)this.appendMessage(intent.goalId,{role:'tool',tool_call_id:toolCallId,name,content:json(result)});
   const event=this.db.prepare("SELECT * FROM events WHERE goal_id=? AND type='tool.completed' AND json_extract(data,'$.id')=? ORDER BY seq DESC LIMIT 1").get(intent.goalId,intentId) as {seq:number;goal_id:string;type:string;data:string;created_at:string}|undefined;
   return event?{seq:Number(event.seq),goalId:event.goal_id,type:event.type,data:JSON.parse(event.data),createdAt:event.created_at}:this.appendEvent(intent.goalId,'tool.completed',{id:intentId,name,result});
  });
 }
 finishTool(id:string,result:ToolResult):void{const row=this.db.prepare('SELECT data FROM intents WHERE id=?').get(id)as {data:string}|undefined;if(!row)throw new Error('Unknown intent');const intent:ToolIntent={...JSON.parse(row.data),status:'completed',result};this.db.prepare('UPDATE intents SET data=?,status=? WHERE id=?').run(json(intent),intent.status,id);}
 pendingTools(goalId?:string):ToolIntent[]{const rows=goalId?this.db.prepare("SELECT data FROM intents WHERE status!='completed' AND goal_id=?").all(goalId):this.db.prepare("SELECT data FROM intents WHERE status!='completed'").all();return(rows as {data:string}[]).map(r=>JSON.parse(r.data));}
 markUncertain(id:string):void{const row=this.db.prepare('SELECT data FROM intents WHERE id=?').get(id)as {data:string}|undefined;if(row){const intent={...JSON.parse(row.data),status:'uncertain'};this.db.prepare('UPDATE intents SET data=?,status=? WHERE id=?').run(json(intent),'uncertain',id);}}
 reconcile(goalId:string,note:string):void{if(!note.trim())throw new Error('需要记录核对说明');this.transaction(()=>{for(const intent of this.pendingTools(goalId))this.finishTool(intent.id,{ok:false,output:`Manually reconciled: ${note}`});this.appendEvent(goalId,'reconciliation',{note});});}
 enqueue(goalId:string):void{this.transaction(()=>{const g=this.getGoal(goalId);if(!g)throw new Error('Unknown goal');const jobId=`${goalId}:${g.revision}`;this.db.prepare("INSERT INTO outbox VALUES(?,?,?,'pending',?) ON CONFLICT(id) DO UPDATE SET status='pending'").run(jobId,goalId,'run',new Date().toISOString());});}
 hasActivity(id:string):boolean{return !!this.db.prepare('SELECT goal_id FROM active_runs WHERE goal_id=?').get(id);}
 beginActivity(id:string):void {
  this.transaction(()=>{
   if(this.hasActivity(id))return;
   const owners=this.budgetAncestors(id),goal=owners[0];if(this.remainingActive(id)<=0)throw new StateError('Shared execution budget exceeded',409);
   this.db.prepare('INSERT INTO active_runs VALUES(?,?,?)').run(id,Date.now(),Math.max(0,goal.budget.maxActiveMs-goal.usage.activeMs));
   const insert=this.db.prepare('INSERT INTO active_run_owners(goal_id,owner_id,charged_ms) VALUES(?,?,0)');for(const owner of owners)insert.run(id,owner.id);
  });
 }
 finishActivity(id:string):void {this.transaction(()=>{this.db.prepare('DELETE FROM active_run_owners WHERE goal_id=?').run(id);this.db.prepare('DELETE FROM active_runs WHERE goal_id=?').run(id);});}
 /** Add one run's measured delta to every distinct owner, including its immediate parent. */
 chargeActive(goalId:string,delta:number):void {
  if(!Number.isSafeInteger(delta)||delta<0)throw new StateError('Invalid active time charge');
  this.transaction(()=>{
   const owners=this.budgetAncestors(goalId);for(const owner of owners){const activeMs=owner.usage.activeMs+delta;if(!Number.isSafeInteger(activeMs))throw new StateError('Active time charge overflow');this.updateGoal(owner.id,{usage:{...owner.usage,activeMs}});}
   this.db.prepare('UPDATE active_run_owners SET charged_ms=charged_ms+? WHERE goal_id=?').run(delta,goalId);
  });
 }
 /** Includes elapsed time not yet saved by any running family member's heartbeat. */
 remainingActive(goalId:string):number {
  const owners=this.budgetAncestors(goalId),pending=new Map<string,number>(),now=Date.now();
  const runs=this.db.prepare('SELECT goal_id,started_at,reserved_ms FROM active_runs').all() as {goal_id:string;started_at:number;reserved_ms:number}[];
  for(const run of runs){
   const elapsed=Math.max(0,now-run.started_at),charges=this.db.prepare('SELECT owner_id,charged_ms FROM active_run_owners WHERE goal_id=?').all(run.goal_id) as {owner_id:string;charged_ms:number}[];
   if(charges.length){for(const charge of charges)pending.set(charge.owner_id,(pending.get(charge.owner_id)??0)+Math.max(0,elapsed-charge.charged_ms));}
   else{const family=this.budgetAncestors(run.goal_id),leaf=family[0],leafCharged=Math.max(0,leaf.usage.activeMs-(leaf.budget.maxActiveMs-run.reserved_ms));for(const owner of family)pending.set(owner.id,(pending.get(owner.id)??0)+Math.max(0,elapsed-(owner.id===leaf.id?leafCharged:0)));}
  }
  return Math.max(0,Math.min(...owners.map(owner=>owner.budget.maxActiveMs-owner.usage.activeMs-(pending.get(owner.id)??0))));
 }
 recoverActivity(id:string):boolean {
  return this.transaction(()=>{
   const run=this.db.prepare('SELECT started_at,reserved_ms FROM active_runs WHERE goal_id=?').get(id) as {started_at:number;reserved_ms:number}|undefined;if(!run)return false;
   const elapsed=Math.max(0,Date.now()-run.started_at),charges=this.db.prepare('SELECT owner_id,charged_ms FROM active_run_owners WHERE goal_id=?').all(id) as {owner_id:string;charged_ms:number}[];
   const owners=this.budgetAncestors(id),leaf=owners[0],legacyCharged=Math.max(0,leaf.usage.activeMs-(leaf.budget.maxActiveMs-run.reserved_ms));
   // Persisted ownership survives ancestry changes; legacy rows only tracked leaf heartbeats.
   const accounted=charges.length?charges:owners.map(owner=>({owner_id:owner.id,charged_ms:owner.id===id?legacyCharged:0}));
   for(const charge of accounted){const owner=this.getGoal(charge.owner_id);if(!owner)throw new StateError('Activity budget owner not found');const delta=Math.max(0,elapsed-charge.charged_ms);this.updateGoal(owner.id,{usage:{...owner.usage,activeMs:Math.max(owner.usage.activeMs,Math.min(owner.budget.maxActiveMs,owner.usage.activeMs+delta))}});}
   this.finishActivity(id);this.appendEvent(id,'budget.recovered',{conservative:true,owners:accounted.map(owner=>owner.owner_id),reason:'Unclean shutdown: elapsed wall time, including downtime, conservatively retained'});return true;
  });
 }
 latestEvent(goalId:string):HarnessEvent|undefined{const row=this.db.prepare('SELECT * FROM events WHERE goal_id=? ORDER BY seq DESC LIMIT 1').get(goalId) as any;return row?{seq:Number(row.seq),goalId:row.goal_id,type:row.type,data:JSON.parse(row.data),createdAt:row.created_at}:undefined;}
 queued():string[]{return(this.db.prepare("SELECT goal_id FROM outbox WHERE status='pending' ORDER BY created_at").all()as {goal_id:string}[]).map(r=>r.goal_id);}
 settleQueue(goalId:string):void{this.db.prepare("UPDATE outbox SET status='done' WHERE goal_id=?").run(goalId);}

 getPreference(key:string):string|undefined {return (this.db.prepare('SELECT value FROM preferences WHERE key=?').get(key) as {value:string}|undefined)?.value;}
 setPreference(key:string,value:string):void {this.db.prepare('INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
 branchGoal(id:string):Goal {return this.transaction(()=>{const parent=this.getGoal(id);if(!parent)throw new StateError('Goal not found',404);if(this.pendingTools(id).length||['running','pending','waiting-rate-limit'].includes(parent.status)&&this.queued().includes(id))throw new StateError('Pause and reconcile before branching',409);const next=this.createGoalInTransaction(parent);return next;});}
 private createGoalInTransaction(parent:Goal):Goal {const at=new Date().toISOString();const next:Goal={...parent,id:randomUUID(),parentId:parent.id,budgetRootId:parent.budgetRootId??parent.id,revision:1,status:'paused',evidence:[],error:undefined,summary:undefined,context:undefined,manifest:undefined,usage:{calls:0,inputTokens:0,outputTokens:0,reasoningTokens:0,activeMs:0},createdAt:at,updatedAt:at};this.db.prepare('INSERT INTO goals VALUES(?,?)').run(next.id,json(next));for(const message of this.getMessages(parent.id))this.appendMessage(next.id,message);this.appendEvent(next.id,'goal.branched',{parentId:parent.id,budgetRootId:next.budgetRootId});return next;}
 private budgetAncestors(id:string):Goal[] {
  const owners:Goal[]=[],seen=new Set<string>(),visiting=new Set<string>();
  const visit=(next:string)=>{if(visiting.has(next))throw new StateError('Budget ancestry cycle');if(seen.has(next))return;const goal=this.getGoal(next);if(!goal)throw new StateError('Budget owner not found');visiting.add(next);owners.push(goal);if(goal.parentId)visit(goal.parentId);if(goal.budgetRootId&&goal.budgetRootId!==goal.id)visit(goal.budgetRootId);visiting.delete(next);seen.add(next);};
  visit(id);return owners;
 }
 reserveAttempt(goalId:string,id:string,input:number,output:number,calls=1):void {this.transaction(()=>{if(!Number.isSafeInteger(calls)||calls<1)throw new StateError('Invalid call reservation');if(!id||[input,output].some(n=>!Number.isSafeInteger(n)||n<0))throw new StateError('Invalid reservation');if(this.db.prepare('SELECT id FROM attempts WHERE id=?').get(id))throw new StateError('Attempt already reserved',409);const owners=this.budgetAncestors(goalId);if(this.remainingActive(goalId)<=0)throw new StateError('Shared execution budget exceeded',409);for(const goal of owners){if(goal.status==='cancelled')throw new StateError('Budget owner cancelled',409);if(goal.usage.calls+calls>goal.budget.maxCalls||goal.usage.inputTokens+input>goal.budget.maxInputTokens||goal.usage.outputTokens+output>goal.budget.maxOutputTokens)throw new StateError('Shared execution budget exceeded',409);}this.db.prepare("INSERT INTO attempts(id,goal_id,ancestors,input,output,status,calls) VALUES(?,?,?,?,?,'reserved',?)").run(id,goalId,json(owners.map(g=>({id:g.id,estimated:g.usage.estimated??false}))),input,output,calls);for(const goal of owners)this.updateGoal(goal.id,{usage:{...goal.usage,calls:goal.usage.calls+calls,inputTokens:goal.usage.inputTokens+input,outputTokens:goal.usage.outputTokens+output,estimated:true}});});}
 settleAttempt(id:string,usage:Usage,calls=1):void {this.transaction(()=>{const row=this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id) as {ancestors:string;input:number;output:number;status:string;calls:number}|undefined;if(!row||row.status!=='reserved')throw new StateError('Attempt is unknown or already settled',409);if(!Number.isSafeInteger(calls)||calls<0||calls>row.calls)throw new StateError('Invalid settled calls');if([usage.inputTokens,usage.outputTokens,usage.reasoningTokens].some(n=>!Number.isSafeInteger(n)||n<0))throw new StateError('Invalid usage');for(const owner of JSON.parse(row.ancestors) as (string|{id:string;estimated:boolean})[]){const goalId=typeof owner==='string'?owner:owner.id;const historicalEstimated=typeof owner==='string'?true:owner.estimated;const goal=this.getGoal(goalId)!;this.updateGoal(goal.id,{usage:{...goal.usage,calls:goal.usage.calls-row.calls+calls,inputTokens:goal.usage.inputTokens-row.input+usage.inputTokens,outputTokens:goal.usage.outputTokens-row.output+usage.outputTokens,reasoningTokens:goal.usage.reasoningTokens+usage.reasoningTokens,estimated:historicalEstimated||(usage.estimated??false)}});}this.db.prepare("UPDATE attempts SET status='settled' WHERE id=?").run(id);});}
 queueMessage(id:string,content:string):void {const goal=this.getGoal(id);if(!goal)throw new StateError('Goal not found',404);if(!content.trim()||content.length>100000||goal.status==='cancelled')throw new StateError('Invalid queued message');this.db.prepare('INSERT INTO queued_messages(goal_id,content) VALUES(?,?)').run(id,content.trim());this.appendEvent(id,'message.queued',{content:content.trim()});}
 applyQueuedMessages(id:string):Goal {return this.transaction(()=>{const goal=this.getGoal(id);if(!goal)throw new StateError('Goal not found',404);const rows=this.db.prepare("SELECT seq,content FROM queued_messages WHERE goal_id=? AND status='pending' ORDER BY seq").all(id) as {seq:number;content:string}[];if(!rows.length)return goal;for(const row of rows){const message={role:'user' as const,content:row.content};this.appendMessage(id,message);this.appendEvent(id,'message',message);this.db.prepare("UPDATE queued_messages SET status='applied' WHERE seq=?").run(row.seq);}const changed=this.updateGoal(id,{revision:goal.revision+1,evidence:[],summary:undefined,context:undefined,manifest:undefined});this.appendEvent(id,'goal.steered',{revision:changed.revision,count:rows.length});return changed;});}
 listApprovals(goalId?:string):ApprovalRequest[]{const rows=goalId?this.db.prepare('SELECT data FROM approvals WHERE goal_id=? ORDER BY rowid').all(goalId):this.db.prepare('SELECT data FROM approvals ORDER BY rowid').all();return (rows as {data:string}[]).map(row=>JSON.parse(row.data));}
 requestApproval(input:Omit<ApprovalRequest,'id'|'status'|'createdAt'>):ApprovalRequest {const row=this.db.prepare('SELECT data FROM approvals WHERE binding=?').get(input.binding) as {data:string}|undefined;if(row)return JSON.parse(row.data);const approval:ApprovalRequest={...input,id:randomUUID(),status:'pending',createdAt:new Date().toISOString()};this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?)').run(approval.id,input.goalId,input.binding,json(approval));this.appendEvent(input.goalId,'approval.requested',approval);return approval;}
 decideApproval(id:string,decision:'allow'|'deny'):ApprovalRequest {const row=this.db.prepare('SELECT data FROM approvals WHERE id=?').get(id) as {data:string}|undefined;if(!row)throw new StateError('Approval not found',404);const approval:ApprovalRequest=JSON.parse(row.data);const goal=this.getGoal(approval.goalId);if(!goal||goal.revision!==approval.revision||goal.status==='cancelled'||approval.status!=='pending')throw new StateError('Approval is stale or already decided',409);approval.status=decision;this.db.prepare('UPDATE approvals SET data=? WHERE id=?').run(json(approval),id);this.appendEvent(goal.id,'approval.decided',approval);return approval;}

 close():void{if(!this.closed){this.closed=true;this.db.close();}}
}
