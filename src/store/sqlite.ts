import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync,realpathSync,statSync} from 'node:fs';
import {dirname,isAbsolute,basename} from 'node:path';
import {DEFAULT_BUDGET,type SessionStore,type Goal,type GoalInput,type ChatMessage,type HarnessEvent,type ToolIntent,type ToolResult,type Workspace} from '../contracts/index.js';
const json=(value:unknown)=>JSON.stringify(value);
export class StateError extends Error {constructor(message:string,public statusCode=400){super(message);}}
const pathKey=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
export function canonicalWorkspace(path:string):string {
 if(!isAbsolute(path))throw new StateError('工作目录必须使用绝对路径');
 try{const real=realpathSync(path);if(!statSync(real).isDirectory())throw new Error();return real;}
 catch{throw new StateError('工作目录不存在或不是可访问的文件夹');}
}

export class SqliteStore implements SessionStore {
 private db:DatabaseSync; private closed=false;
 constructor(path:string){if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,path_key TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,goal_id TEXT NOT NULL REFERENCES goals(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,goal_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),data TEXT NOT NULL,status TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS active_runs(goal_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, reserved_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS events_goal ON events(goal_id,seq); CREATE INDEX IF NOT EXISTS events_goal_type ON events(goal_id,type,seq); CREATE INDEX IF NOT EXISTS messages_goal ON messages(goal_id,seq);`); }
 transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 createGoal(input:GoalInput):Goal{
  if(!input.prompt?.trim())throw new Error('目标内容不能为空');
  const workspace=canonicalWorkspace(input.workspace);const budget={...DEFAULT_BUDGET,...input.budget};
  for(const [key,value]of Object.entries(budget))if(!Number.isFinite(value)||value<=0||!Number.isInteger(value))throw new Error(`Invalid budget ${key}`);
  if(input.reasoningEffort!==undefined&&input.reasoningEffort!=='high')throw new StateError('该免费模型当前只验证 high 思考强度');
  if(input.contextLimit!==undefined&&(!Number.isInteger(input.contextLimit)||input.contextLimit<4096||input.contextLimit>1024000))throw new Error('Invalid context limit');
  const at=new Date().toISOString(); const goal:Goal={id:randomUUID(),title:input.title?.trim()||input.prompt.trim().slice(0,60),prompt:input.prompt,workspace,acceptanceCommands:input.acceptanceCommands??[],status:'pending',revision:1,budget,usage:{calls:0,inputTokens:0,outputTokens:0,reasoningTokens:0,activeMs:0},createdAt:at,updatedAt:at,evidence:[],dependsOn:input.dependsOn??[],supervised:input.supervised??false,contextLimit:input.contextLimit??128000,reasoningEffort:input.reasoningEffort??'high',...(input.parentId?{parentId:input.parentId}:{})};
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
   const goal:Goal={...old,...patch,revision:old.revision+1,status:'paused',error:undefined,summary:undefined,context:undefined,evidence:[],updatedAt:new Date().toISOString()};
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
  const goal:Goal={...old,revision:old.revision+1,status:'paused',error:undefined,summary:undefined,evidence:[],updatedAt:new Date().toISOString()};
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
 beginTool(goalId:string,revision:number,name:string,args:Record<string,unknown>):ToolIntent{const intent:ToolIntent={id:randomUUID(),goalId,revision,name,args,status:'pending',createdAt:new Date().toISOString()};this.db.prepare('INSERT INTO intents VALUES(?,?,?,?)').run(intent.id,goalId,json(intent),intent.status);return intent;}
 finishTool(id:string,result:ToolResult):void{const row=this.db.prepare('SELECT data FROM intents WHERE id=?').get(id)as {data:string}|undefined;if(!row)throw new Error('Unknown intent');const intent:ToolIntent={...JSON.parse(row.data),status:'completed',result};this.db.prepare('UPDATE intents SET data=?,status=? WHERE id=?').run(json(intent),intent.status,id);}
 pendingTools(goalId?:string):ToolIntent[]{const rows=goalId?this.db.prepare("SELECT data FROM intents WHERE status!='completed' AND goal_id=?").all(goalId):this.db.prepare("SELECT data FROM intents WHERE status!='completed'").all();return(rows as {data:string}[]).map(r=>JSON.parse(r.data));}
 markUncertain(id:string):void{const row=this.db.prepare('SELECT data FROM intents WHERE id=?').get(id)as {data:string}|undefined;if(row){const intent={...JSON.parse(row.data),status:'uncertain'};this.db.prepare('UPDATE intents SET data=?,status=? WHERE id=?').run(json(intent),'uncertain',id);}}
 reconcile(goalId:string,note:string):void{if(!note.trim())throw new Error('需要记录核对说明');this.transaction(()=>{for(const intent of this.pendingTools(goalId))this.finishTool(intent.id,{ok:false,output:`Manually reconciled: ${note}`});this.appendEvent(goalId,'reconciliation',{note});});}
 enqueue(goalId:string):void{this.transaction(()=>{const g=this.getGoal(goalId);if(!g)throw new Error('Unknown goal');const jobId=`${goalId}:${g.revision}`;this.db.prepare("INSERT INTO outbox VALUES(?,?,?,'pending',?) ON CONFLICT(id) DO UPDATE SET status='pending'").run(jobId,goalId,'run',new Date().toISOString());});}
 beginActivity(id:string):void{const g=this.getGoal(id)!;this.db.prepare('INSERT OR REPLACE INTO active_runs VALUES(?,?,?)').run(id,Date.now(),Math.max(0,g.budget.maxActiveMs-g.usage.activeMs));}
 finishActivity(id:string):void{this.db.prepare('DELETE FROM active_runs WHERE goal_id=?').run(id);}
 recoverActivity(id:string):boolean{const r=this.db.prepare('SELECT started_at,reserved_ms FROM active_runs WHERE goal_id=?').get(id) as {started_at:number;reserved_ms:number}|undefined;if(!r)return false;const g=this.getGoal(id)!;const recovered=Math.max(g.usage.activeMs,Math.min(g.budget.maxActiveMs,g.budget.maxActiveMs-r.reserved_ms+Math.max(0,Date.now()-r.started_at)));this.updateGoal(id,{usage:{...g.usage,activeMs:recovered}});this.finishActivity(id);this.appendEvent(id,'budget.recovered',{conservative:true,reason:'Unclean shutdown: elapsed wall time, including downtime, conservatively retained'});return true;}
 latestEvent(goalId:string):HarnessEvent|undefined{const row=this.db.prepare('SELECT * FROM events WHERE goal_id=? ORDER BY seq DESC LIMIT 1').get(goalId) as any;return row?{seq:Number(row.seq),goalId:row.goal_id,type:row.type,data:JSON.parse(row.data),createdAt:row.created_at}:undefined;}
 queued():string[]{return(this.db.prepare("SELECT goal_id FROM outbox WHERE status='pending' ORDER BY created_at").all()as {goal_id:string}[]).map(r=>r.goal_id);}
 settleQueue(goalId:string):void{this.db.prepare("UPDATE outbox SET status='done' WHERE goal_id=?").run(goalId);}
 close():void{if(!this.closed){this.closed=true;this.db.close();}}
}
