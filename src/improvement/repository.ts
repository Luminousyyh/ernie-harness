import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync,mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Activation, ActiveRunRecord, AttemptUsage, DevelopmentTrace, ImprovementAttempt, ImprovementCandidate, ImprovementJob, Selection} from './types.js';
import type {BanditState} from './search.js';
const now=()=>new Date().toISOString();
export class ImprovementRepository {
 private db:DatabaseSync;private closed=false;
 constructor(stateDir:string){mkdirSync(stateDir,{recursive:true,mode:0o700});for(const name of ['improvement.sqlite','improvement.sqlite-wal','improvement.sqlite-shm']){const file=join(stateDir,name);if(existsSync(file)){const stat=lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1)throw new Error('Linked improvement database');}}this.db=new DatabaseSync(join(stateDir,'improvement.sqlite'));if(process.platform!=='win32')chmodSync(join(stateDir,'improvement.sqlite'),0o600);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;if(version!==0&&version!==1){this.db.close();throw new Error('Unsupported improvement DB version');}
 this.db.exec(`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS bandit(context TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS development_traces(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),manifest_hash TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS seals(manifest_hash TEXT PRIMARY KEY,job_id TEXT NOT NULL,candidate_id TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS lineage(seq INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS active_runs(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=1;`);
 this.transaction(()=>{for(const r of this.listActiveRuns())if(['preparing','running'].includes(r.status))this.patchActiveRun(r.id,{status:'needs-reconciliation',error:'Interrupted active launch; never automatically replayed',reservation:{...r.reservation,status:r.reservation.status==='unreserved'?'unreserved':'uncertain'}});for(const j of this.listJobs())if(['queued','proposing','evaluating','validating'].includes(j.status))this.patchJob(j.id,{status:'needs-reconciliation',error:'Interrupted operation; no automatic replay'});for(const row of this.db.prepare('SELECT data FROM attempts').all() as {data:string}[]){const a=JSON.parse(row.data) as ImprovementAttempt;if(a.status==='reserved')this.failAttempt(a.id);}});
 }
 transaction<T>(work:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const out=work();this.db.exec('COMMIT');return out;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 private read<T>(table:string,id:string):T|undefined {const r=this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as {data:string}|undefined;return r?JSON.parse(r.data) as T:undefined;}
 private put(table:string,id:string,value:unknown){this.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value),id);}
 listActiveRuns():ActiveRunRecord[]{return(this.db.prepare('SELECT data FROM active_runs ORDER BY rowid DESC').all() as {data:string}[]).map(r=>JSON.parse(r.data));}
 activeRun(id:string):ActiveRunRecord|undefined{return this.read('active_runs',id);}
 createActiveRun(input:Omit<ActiveRunRecord,'createdAt'|'updatedAt'>):ActiveRunRecord{return this.transaction(()=>{
  if(!Number.isSafeInteger(input.maxCalls)||input.maxCalls<1||input.maxCalls>20||!Number.isSafeInteger(input.maxActiveMs)||input.maxActiveMs<1||input.maxActiveMs>1800000)throw new Error('Invalid active launch budget');
  if(this.activeRun(input.id)||this.getJob(input.id))throw new Error('Launch ID already used');
  if(this.listActiveRuns().some(r=>r.workspace===input.workspace&&['preparing','running','needs-reconciliation'].includes(r.status))||this.listJobs().some(j=>j.workspace===input.workspace&&['queued','proposing','evaluating','validating','needs-reconciliation'].includes(j.status)))throw new Error('Workspace already owned');
  const r={...input,createdAt:now(),updatedAt:now()};this.db.prepare('INSERT INTO active_runs VALUES(?,?,?)').run(r.id,r.workspace,JSON.stringify(r));return r;
 });}
 patchActiveRun(id:string,patch:Partial<ActiveRunRecord>):ActiveRunRecord{const r=this.activeRun(id);if(!r)throw new Error('Unknown active launch');const next={...r,...patch,id:r.id,updatedAt:now()};this.put('active_runs',id,next);return next;}
 listJobs():ImprovementJob[]{return(this.db.prepare('SELECT data FROM jobs ORDER BY rowid DESC').all() as {data:string}[]).map(r=>JSON.parse(r.data));}
 getJob(id:string):ImprovementJob|undefined {const j=this.read<ImprovementJob>('jobs',id);if(j)j.calls=this.attempts(id).reduce((s,a)=>s+(a.status==='completed'?a.usage!.calls:a.reservedCalls),0);return j;}
 createJob(input:{workspace:string;maxCalls:number;maxCandidates:number;selection:Selection}):ImprovementJob{
  if(!Number.isSafeInteger(input.maxCalls)||input.maxCalls<1||input.maxCalls>400||!Number.isSafeInteger(input.maxCandidates)||input.maxCandidates<1||input.maxCandidates>2)throw new Error('Improvement budget limits exceeded');
  return this.transaction(()=>{if(this.listActiveRuns().some(r=>r.workspace===input.workspace&&['preparing','running','needs-reconciliation'].includes(r.status)))throw new Error('Workspace already owned by an active launch');if(this.listJobs().some(j=>j.workspace===input.workspace&&['queued','proposing','evaluating','validating','needs-reconciliation'].includes(j.status)))throw new Error('Workspace already owned by an improvement job');const j:ImprovementJob={...input,id:randomUUID(),status:'queued',calls:0,createdAt:now(),updatedAt:now(),candidateIds:[],parentId:this.active()?.candidateId??null};this.db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(j.id,j.workspace,JSON.stringify(j));return j;});
 }
 patchJob(id:string,patch:Partial<ImprovementJob>):ImprovementJob{const j=this.getJob(id);if(!j)throw new Error('Unknown improvement job');const next={...j,...patch,id:j.id,updatedAt:now()};this.put('jobs',id,next);return next;}
 addCandidate(jobId:string,input:Omit<ImprovementCandidate,'jobId'|'createdAt'>):ImprovementCandidate{return this.transaction(()=>{const j=this.getJob(jobId);if(!j)throw new Error('Unknown improvement job');if(j.candidateIds.length>=j.maxCandidates)throw new Error('Candidate budget exhausted');const c={...input,jobId,createdAt:now()};this.db.prepare('INSERT INTO candidates VALUES(?,?,?)').run(c.id,jobId,JSON.stringify(c));this.patchJob(jobId,{candidateIds:[...j.candidateIds,c.id]});return c;});}
 candidate(id:string):ImprovementCandidate|undefined{return this.read('candidates',id);}
 patchCandidate(id:string,patch:Partial<ImprovementCandidate>):ImprovementCandidate{const c=this.candidate(id);if(!c)throw new Error('Unknown candidate');const next={...c,...patch,id:c.id,jobId:c.jobId};this.put('candidates',id,next);return next;}
 attempts(jobId:string):ImprovementAttempt[]{return(this.db.prepare('SELECT data FROM attempts WHERE job_id=? ORDER BY rowid').all(jobId) as {data:string}[]).map(r=>JSON.parse(r.data));}
 reserve(jobId:string,kind:ImprovementAttempt['kind'],calls:number,metadata:Pick<ImprovementAttempt,'candidateId'|'partition'>={}):ImprovementAttempt{
  return this.transaction(()=>{const j=this.getJob(jobId);if(!j||!Number.isSafeInteger(calls)||calls<1||kind==='proposal'&&calls!==1||kind==='evaluation'&&calls>20||j.calls+calls>j.maxCalls)throw new Error('Improvement call budget exhausted');const a:ImprovementAttempt={id:randomUUID(),jobId,kind,status:'reserved',reservedCalls:calls,reservedInputTokens:kind==='proposal'?512000:2000000,reservedOutputTokens:kind==='proposal'?16384:128000,createdAt:now(),...metadata};this.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(a.id,jobId,JSON.stringify(a));return a;});
 }
 settle(id:string,usage:AttemptUsage):void{const a=this.read<ImprovementAttempt>('attempts',id);if(!a||a.status!=='reserved')throw new Error('Attempt already settled or unknown');if(Object.values(usage).some(v=>!Number.isSafeInteger(v)||v<0)||!['calls','inputTokens','outputTokens','reasoningTokens','activeMs'].every(k=>Object.hasOwn(usage,k)))throw new Error('Invalid attempt usage');this.put('attempts',id,{...a,status:'completed',usage});}
 failAttempt(id:string):void{const a=this.read<ImprovementAttempt>('attempts',id);if(!a||a.status==='completed')throw new Error('Completed or unknown attempt');this.put('attempts',id,{...a,status:'uncertain'});}
 seal(hash:string,jobId:string,candidateId:string):void{if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid validation hash');try{this.db.prepare('INSERT INTO seals VALUES(?,?,?,?)').run(hash,jobId,candidateId,now());}catch{throw new Error('Validation partition already consumed');}}
 hasSeal(hash:string):boolean{return !!this.db.prepare('SELECT 1 FROM seals WHERE manifest_hash=?').get(hash);}
 recordDevelopmentTrace(jobId:string,trace:DevelopmentTrace):void{if(trace.partition!=='development'||!/^[a-f0-9]{64}$/.test(trace.manifestHash)||!trace.taskId||JSON.stringify(trace).length>256000)throw new Error('Only bounded development partition traces may be archived');this.db.prepare('INSERT INTO development_traces VALUES(?,?,?,?)').run(randomUUID(),jobId,trace.manifestHash,JSON.stringify(trace));}
 developmentTraces(manifestHash:string):DevelopmentTrace[]{return(this.db.prepare('SELECT data FROM development_traces WHERE manifest_hash=? ORDER BY rowid DESC LIMIT 32').all(manifestHash) as {data:string}[]).map(r=>JSON.parse(r.data));}
 getBandit(context:string):BanditState|undefined{const r=this.db.prepare('SELECT data FROM bandit WHERE context=?').get(context) as {data:string}|undefined;return r?JSON.parse(r.data):undefined;}
 saveBandit(context:string,state:BanditState):void{this.db.prepare('INSERT INTO bandit VALUES(?,?) ON CONFLICT(context) DO UPDATE SET data=excluded.data').run(context,JSON.stringify(state));}
 active():Activation|undefined{const r=this.db.prepare("SELECT data FROM meta WHERE key='active'").get() as {data:string}|undefined;return r?JSON.parse(r.data):undefined;}
 private setActive(value:Activation,action:string){const activation={...value,createdAt:now()};this.db.prepare("INSERT INTO meta VALUES('active',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(JSON.stringify(activation));this.db.prepare('INSERT INTO lineage(data) VALUES(?)').run(JSON.stringify({action,activation,createdAt:now()}));return activation;}
 activate(value:Activation,expected:string|null):Activation{return this.transaction(()=>{if((this.active()?.candidateId??null)!==expected)throw new Error('Stale activation parent');return this.setActive(value,'apply');});}
 lineage():{action:string;activation:Activation;createdAt:string}[]{return(this.db.prepare('SELECT data FROM lineage ORDER BY seq').all() as {data:string}[]).map(r=>JSON.parse(r.data));}
 rollback(expected:string|null):Activation{return this.transaction(()=>{const current=this.active();if(!current||current.candidateId!==expected)throw new Error('Stale rollback parent');if(current.candidateId===null)throw new Error('No previous activation');const history=this.lineage().filter(x=>x.action==='apply');const prior=[...history].reverse().find(x=>x.activation.candidateId===current.parentId)?.activation;if(!prior)throw new Error('No previous activation');return this.setActive(prior,'rollback');});}
 close():void{if(!this.closed){this.closed=true;this.db.close();}}
}
