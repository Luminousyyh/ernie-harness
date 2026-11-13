import {createHash, randomUUID} from 'node:crypto';
import {closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {type Budget} from '../contracts/index.js';
import {fail, integer, object, trialBudget} from './policy.js';

export interface Attempt {
  id:string; status:'received'|'reserved'|'dispatched'|'completed'|'rejected'|'uncertain';
  receivedAt:number; inputTokens:number; outputTokens:number; reasoningTokens:number; activeMs:number; waitingMs:number;
  dispatchAt?:number; finishedAt?:number; code?:string;
}
export interface TrialSnapshot {
  id:string; budget:Budget; infrastructureRestarts:number; rejectedRequests:number;
  usage:{calls:number; inputTokens:number; outputTokens:number; reasoningTokens:number; activeMs:number; waitingMs:number};
  attempts:Attempt[];
}
interface Trial extends TrialSnapshot {tokenHash:string; registrationEpoch:string}
interface State {version:1; lastDispatchAt:number; trials:Trial[]}
const statuses=new Set(['received','reserved','dispatched','completed','rejected','uncertain']);
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
const counters=['inputTokens','outputTokens','reasoningTokens','activeMs','waitingMs'] as const;

/** One exclusive writer; fsync + atomic replace precede every possible remote effect. */
export class BrokerStore {
  readonly stateDir:string;
  private readonly path:string;
  private readonly epoch=randomUUID();
  private state:State={version:1,lastDispatchAt:0,trials:[]};
  private opened=false;
  private closed=false;
  constructor(stateDir:string, private readonly now:()=>number) { this.stateDir=resolve(stateDir); this.path=join(this.stateDir,'broker-state.json'); }
  private open():void {
    if(this.closed) fail('BROKER_CLOSED',503);
    if(this.opened)return;
    mkdirSync(this.stateDir,{recursive:true,mode:0o700});
    const lockPath=join(this.stateDir,'broker.lock');
    const acquire=()=>{const fd=openSync(lockPath,'wx',0o600);try{writeFileSync(fd,JSON.stringify({pid:process.pid,epoch:this.epoch}));fsyncSync(fd);}finally{closeSync(fd);}};
    try { acquire(); }
    catch(error) {
      if(!object(error)||error.code!=='EEXIST') fail('BROKER_STORAGE_ERROR',503);
      let owner:unknown;try{if(!lstatSync(lockPath).isFile())throw Error();owner=JSON.parse(readFileSync(lockPath,'utf8'));}catch{fail('BROKER_LOCK_REQUIRES_RECONCILIATION',503);}
      if(!object(owner)||!integer(owner.pid)||owner.pid<1)fail('BROKER_LOCK_REQUIRES_RECONCILIATION',503);
      try{process.kill(owner.pid,0);fail('BROKER_ALREADY_RUNNING',503);}catch(probe){if(!object(probe)||probe.code!=='ESRCH')fail('BROKER_ALREADY_RUNNING',503);}
      unlinkSync(lockPath);acquire();
    }
    this.opened=true;
    try {
      if(existsSync(this.path)) {
        const info=lstatSync(this.path);if(!info.isFile()||info.size>32*1024*1024)throw Error();
        const data:unknown=JSON.parse(readFileSync(this.path,'utf8'));this.validate(data);this.state=data;
      }
      let changed=false;
      for(const trial of this.state.trials)for(const attempt of trial.attempts) {
        if(['received','reserved','dispatched'].includes(attempt.status)){attempt.status=attempt.status==='received'?'rejected':'uncertain';attempt.code='BROKER_RESTART';changed=true;}
      }
      if(changed)this.save();
    } catch { this.close();fail('BROKER_STATE_INVALID',503,'Durable broker state requires reconciliation'); }
  }
  private validate(value:unknown):asserts value is State {
    if(!object(value)||value.version!==1||!integer(value.lastDispatchAt)||!Array.isArray(value.trials))throw Error();
    const ids=new Set(),tokens=new Set();
    for(const t of value.trials) {
      if(!object(t)||typeof t.id!=='string'||ids.has(t.id)||typeof t.tokenHash!=='string'||!(/^[a-f0-9]{64}$/).test(t.tokenHash)||tokens.has(t.tokenHash)||typeof t.registrationEpoch!=='string'||!integer(t.infrastructureRestarts)||t.infrastructureRestarts>2||!integer(t.rejectedRequests)||!object(t.usage)||!integer(t.usage.calls)||!Array.isArray(t.attempts)||t.attempts.length!==t.usage.calls)throw Error();
      trialBudget(t.budget as Budget);ids.add(t.id);tokens.add(t.tokenHash);
      for(const key of counters)if(!integer(t.usage[key]))throw Error();
      for(const a of t.attempts) {
        if(!object(a)||typeof a.id!=='string'||!statuses.has(String(a.status))||!integer(a.receivedAt)||!counters.every(key=>integer(a[key]))||(a.dispatchAt!==undefined&&!integer(a.dispatchAt))||(a.finishedAt!==undefined&&!integer(a.finishedAt)))throw Error();
      }
      for(const key of counters)if(t.usage[key]!==t.attempts.reduce((sum:number,a:Attempt)=>sum+a[key],0))throw Error();
    }
  }
  private save():void {
    const temporary=`${this.path}.${randomUUID()}.tmp`;let fd:number|undefined;
    try {
      fd=openSync(temporary,'wx',0o600);writeFileSync(fd,JSON.stringify(this.state));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,this.path);
      if(process.platform!=='win32'){const parent=openSync(dirname(this.path),'r');try{fsyncSync(parent);}finally{closeSync(parent);}}
    }catch{fail('BROKER_STORAGE_ERROR',503);}finally{if(fd!==undefined)closeSync(fd);if(existsSync(temporary))unlinkSync(temporary);}
  }
  register(input:{id:string;token:string;budget?:Partial<Budget>}):TrialSnapshot {
    this.open();
    if(typeof input.id!=='string'||!(/^[\w.-]{1,200}$/).test(input.id)||typeof input.token!=='string'||!(/^[\x21-\x7e]{8,512}$/).test(input.token))fail('INVALID_TRIAL_REGISTRATION');
    const tokenHash=hash(input.token),existing=this.state.trials.find(t=>t.id===input.id);
    if(existing){
      if(existing.tokenHash!==tokenHash||(input.budget&&JSON.stringify(trialBudget(input.budget))!==JSON.stringify(existing.budget)))fail('TRIAL_REGISTRATION_CONFLICT',409);
      if(existing.registrationEpoch!==this.epoch){this.restart(existing);existing.registrationEpoch=this.epoch;this.save();}
      return this.view(existing);
    }
    if(this.state.trials.some(t=>t.tokenHash===tokenHash))fail('TRIAL_TOKEN_CONFLICT',409);
    const trial:Trial={id:input.id,tokenHash,registrationEpoch:this.epoch,budget:trialBudget(input.budget),infrastructureRestarts:0,rejectedRequests:0,usage:{calls:0,inputTokens:0,outputTokens:0,reasoningTokens:0,activeMs:0,waitingMs:0},attempts:[]};
    this.state.trials.push(trial);this.save();return this.view(trial);
  }
  private restart(trial:Trial):void {if(trial.infrastructureRestarts>=2)fail('INFRASTRUCTURE_RESTART_LIMIT',429);trial.infrastructureRestarts++;}
  recordInfrastructureRestart(id:string):TrialSnapshot {this.open();const trial=this.state.trials.find(t=>t.id===id);if(!trial)fail('UNKNOWN_TRIAL',404);this.restart(trial);this.save();return this.view(trial);}
  authenticate(token:string):string|undefined {this.open();const trial=this.state.trials.find(t=>t.tokenHash===hash(token));return trial?.registrationEpoch===this.epoch?trial.id:undefined;}
  private get(id:string):Trial {const trial=this.state.trials.find(t=>t.id===id);if(!trial)fail('UNKNOWN_TRIAL',401);return trial;}
  begin(id:string):Attempt {
    const trial=this.get(id);if(trial.usage.calls>=trial.budget.maxCalls){trial.rejectedRequests++;this.save();fail('TRIAL_CALL_BUDGET_EXHAUSTED',429);}
    const attempt:Attempt={id:randomUUID(),status:'received',receivedAt:this.now(),inputTokens:0,outputTokens:0,reasoningTokens:0,activeMs:0,waitingMs:0};trial.usage.calls++;trial.attempts.push(attempt);this.save();return attempt;
  }
  reserve(id:string,a:Attempt,input:number,output:number):Budget {
    const trial=this.get(id),u=trial.usage,b=trial.budget;
    if(u.inputTokens+input>b.maxInputTokens||u.outputTokens+output>b.maxOutputTokens||u.activeMs>=b.maxActiveMs)fail('TRIAL_BUDGET_EXHAUSTED',429);
    a.status='reserved';this.charge(trial,a,{inputTokens:input,outputTokens:output});this.save();return b;
  }
  dispatch(id:string,a:Attempt,waitingMs:number):number {
    const trial=this.get(id),remaining=trial.budget.maxActiveMs-trial.usage.activeMs;
    if(remaining<=0)fail('TRIAL_ACTIVE_BUDGET_EXHAUSTED',429);
    a.status='dispatched';a.dispatchAt=this.now();this.state.lastDispatchAt=a.dispatchAt;
    this.charge(trial,a,{activeMs:remaining,waitingMs});this.save();return remaining;
  }
  finish(id:string,a:Attempt,code:string,usage?:{inputTokens:number;outputTokens:number;reasoningTokens:number},activeMs?:number):void {
    const trial=this.get(id);
    if(usage&&activeMs!==undefined){this.charge(trial,a,{...usage,activeMs});a.status='completed';}
    else {if(activeMs!==undefined)this.charge(trial,a,{activeMs});a.status=a.status==='received'?'rejected':'uncertain';}
    a.code=code;a.finishedAt=this.now();this.save();
  }
  private charge(trial:Trial,a:Attempt,values:Partial<Record<typeof counters[number],number>>):void {for(const key of counters)if(values[key]!==undefined){trial.usage[key]+=values[key]!-a[key];a[key]=values[key]!;}}
  budget(id:string):Budget{return {...this.get(id).budget};}
  lastDispatchAt():number{this.open();return this.state.lastDispatchAt;}
  private view(trial:Trial):TrialSnapshot {const {tokenHash:_hash,registrationEpoch:_epoch,...view}=trial;return structuredClone(view);}
  snapshot():TrialSnapshot[]{this.open();return this.state.trials.map(t=>this.view(t));}
  close():void {
    if(this.closed)return;this.closed=true;
    if(this.opened){const lock=join(this.stateDir,'broker.lock');try{const owner=JSON.parse(readFileSync(lock,'utf8'));if(owner.epoch===this.epoch)unlinkSync(lock);}catch{}}
  }
}
