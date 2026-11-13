import {mkdir, readFile, rename, unlink, open, lstat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ApiError, abortError, checkAbort, record} from './errors.js';
export const FALLBACK_RPM = 10;
export const FALLBACK_DAILY_LIMIT = 50;
export function defaultStateDirectory():string {return process.env.ERNIE_HARNESS_HOME || join(homedir(),'.ernie-harness');}
interface QuotaState {version:1;lastSeen:number;attempts:{id:string;at:number}[]}
export interface QuotaSnapshot {rpmLimit:number;dailyLimit:number;rpmUsed:number;dayUsed:number;minuteRemaining:number;dayRemaining:number;dayResetAt:string}
export interface QuotaReservation {id:string;at:number}
const queues=new Map<string,Promise<unknown>>();
function utcDay(now:number):number{return Math.floor(now/86400000)*86400000;}
function ioError(error:unknown,code:string):boolean{return record(error)&&error.code===code;}
/** Same-path instances share one queue. A disk lock prevents competing processes. */
export class SerialQuota {
  readonly path:string; private readonly now:()=>number;
  constructor(options:{path?:string;now?:()=>number}={}){this.path=resolve(options.path??join(defaultStateDirectory(),'provider-quota.json'));this.now=options.now??Date.now;}
  private async serial<T>(operation:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    checkAbort(signal);const previous=queues.get(this.path)??Promise.resolve();
    const result=previous.catch(()=>{}).then(()=>{checkAbort(signal);return operation();});
    const tail=result.then(()=>{},()=>{});queues.set(this.path,tail);
    void tail.then(()=>{if(queues.get(this.path)===tail)queues.delete(this.path);});
    if(!signal)return result;
    let onAbort!:()=>void;
    const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(abortError());signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();});
    try{return await Promise.race([result,aborted]);}finally{signal.removeEventListener('abort',onAbort);}
  }
  private async locked<T>(operation:()=>Promise<T>):Promise<T>{
    await mkdir(dirname(this.path),{recursive:true,mode:0o700});let lock;
    try{lock=await open(`${this.path}.lock`,'wx',0o600);}catch(error){if(ioError(error,'EEXIST'))throw new ApiError('Provider quota is locked by another writer; stale locks require reconciliation',{status:429,retryAfterMs:1000,code:'QUOTA_LOCKED'});throw new ApiError('Cannot lock provider quota state',{code:'QUOTA_STORAGE_ERROR',retryable:false});}
    try{await lock.writeFile(JSON.stringify({pid:process.pid}));return await operation();}finally{await lock.close();await unlink(`${this.path}.lock`);}
  }
  private async load():Promise<QuotaState>{
    let text:string;
    try{const info=await lstat(this.path);if(!info.isFile()||info.size>65536)throw new Error('invalid');text=await readFile(this.path,'utf8');}
    catch(error){if(ioError(error,'ENOENT'))return {version:1,lastSeen:0,attempts:[]};throw new ApiError('Quota state cannot be read safely',{code:'QUOTA_STATE_INVALID',retryable:false});}
    try{const state:unknown=JSON.parse(text);if(!record(state)||state.version!==1||!Number.isSafeInteger(state.lastSeen)||Number(state.lastSeen)<0||!Array.isArray(state.attempts)||state.attempts.length>50||!state.attempts.every(v=>record(v)&&typeof v.id==='string'&&typeof v.at==='number'&&Number.isSafeInteger(v.at)&&v.at>=0&&v.at<=Number(state.lastSeen)))throw new Error();return state as unknown as QuotaState;}
    catch{throw new ApiError('Quota state is invalid; refusing to reset consumed allowance',{code:'QUOTA_STATE_INVALID',retryable:false});}
  }
  private time(state:QuotaState):number {const now=this.now();if(!Number.isSafeInteger(now)||now<state.lastSeen)throw new ApiError('Clock moved backwards; quota requires reconciliation',{code:'QUOTA_CLOCK_ROLLBACK',retryable:false});return now;}
  private view(state:QuotaState,now:number):QuotaSnapshot {
    const rpmUsed=state.attempts.filter(v=>v.at>now-60000).length,dayUsed=state.attempts.filter(v=>v.at>=utcDay(now)).length;
    return {rpmLimit:10,dailyLimit:50,rpmUsed,dayUsed,minuteRemaining:Math.max(0,10-rpmUsed),dayRemaining:Math.max(0,50-dayUsed),dayResetAt:new Date(utcDay(now)+86400000).toISOString()};
  }
  private async reserveLocked(signal?:AbortSignal):Promise<QuotaReservation>{
    checkAbort(signal);const state=await this.load();const now=this.time(state);const snapshot=this.view(state,now);
    if(snapshot.dayUsed>=50)throw new ApiError('Daily free model quota exhausted',{status:429,retryAfterMs:utcDay(now)+86400000-now,code:'DAILY_QUOTA_EXHAUSTED'});
    if(snapshot.rpmUsed>=10){const recent=state.attempts.filter(v=>v.at>now-60000);throw new ApiError('Per-minute free model quota exhausted',{status:429,retryAfterMs:Math.max(1,Math.min(...recent.map(v=>v.at))+60000-now),code:'RPM_QUOTA_EXHAUSTED'});}
    const reservation={id:randomUUID(),at:now};state.attempts=state.attempts.filter(v=>v.at>=utcDay(now)||v.at>now-60000);state.attempts.push(reservation);state.lastSeen=now;
    const temporary=`${this.path}.${randomUUID()}.tmp`;let handle;
    try{handle=await open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(state));await handle.sync();await handle.close();handle=undefined;await rename(temporary,this.path);}
    catch{throw new ApiError('Cannot persist provider quota reservation',{code:'QUOTA_STORAGE_ERROR',retryable:false});}
    finally{await handle?.close();await unlink(temporary).catch(()=>{});}
    return reservation;
  }
  reserve(signal?:AbortSignal):Promise<QuotaReservation>{return this.serial(()=>this.locked(()=>this.reserveLocked(signal)),signal);}
  /** A failed/aborted/uncertain dispatched attempt stays consumed. No automatic refund. */
  run<T>(operation:(reservation:QuotaReservation)=>Promise<T>,signal?:AbortSignal,prepare?:()=>Promise<void>):Promise<T>{return this.serial(()=>this.locked(async()=>{checkAbort(signal);await prepare?.();const reservation=await this.reserveLocked(signal);checkAbort(signal);return operation(reservation);}),signal);}
  snapshot():Promise<QuotaSnapshot>{return this.serial(async()=>{const state=await this.load();return this.view(state,this.time(state));});}
}
