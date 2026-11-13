import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,lstat,realpath,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createModelBroker} from '../broker/index.js';
import {BrokerStore} from '../broker/store.js';
import type {AttemptUsage,ImprovementBroker} from './types.js';
import {checkAbort} from './process.js';
/** Production adapter to the existing pinned/free-route broker. No upstream key reaches a candidate. */
export function createImprovementBroker(options:{stateDir:string;quotaPath:string;apiKey:string;socketDirectory?:string}):ImprovementBroker{
 return{async openTrial(input){
  if(process.platform!=='linux')throw new Error('Improvement broker trials require Linux Unix sockets');checkAbort(input.signal);
  if(!/^[a-zA-Z0-9-]+$/.test(input.id)||!Number.isSafeInteger(input.maxCalls)||input.maxCalls<1||input.maxCalls>20||!Number.isSafeInteger(input.maxActiveMs)||input.maxActiveMs<1||input.maxActiveMs>1800000)throw new Error('Invalid improvement trial allowance');
  const state=join(resolve(options.stateDir),input.id),sockets=resolve(options.socketDirectory??join(tmpdir(),'ernie-improvement-sockets'));
  await mkdir(sockets,{recursive:true,mode:0o700});if((await lstat(sockets)).isSymbolicLink()||await realpath(sockets)!==sockets)throw new Error('Linked broker socket directory');
  const socket=join(sockets,randomUUID()+'.sock');if(Buffer.byteLength(socket)>103)throw new Error('Broker Unix socket path too long');
  const token=randomBytes(32).toString('hex'),broker=createModelBroker({stateDir:state,quotaPath:options.quotaPath,apiKey:options.apiKey,socketPath:socket});
  let shutdown:Promise<void>|undefined;const stop=()=>shutdown??=broker.close();const onAbort=()=>{void stop().catch(()=>{});};
  try{
   broker.registerTrial({id:input.id,token,budget:{maxCalls:input.maxCalls,maxActiveMs:input.maxActiveMs}});await broker.listen();input.signal.addEventListener('abort',onAbort,{once:true});checkAbort(input.signal);
   let finishing:Promise<{usage:AttemptUsage;uncertain:boolean}>|undefined;
   return{socketPath:socket,token,finish(){
    return finishing??=(async()=>{
     input.signal.removeEventListener('abort',onAbort);await stop();await rm(socket,{force:true});
     // Reopen only AFTER shutdown. The existing broker recovers uncertain reservations conservatively.
     const ledger=new BrokerStore(state,Date.now);try{const trial=ledger.snapshot().find(t=>t.id===input.id);if(!trial)throw new Error('Broker trial ledger unavailable');return{usage:{calls:trial.usage.calls,inputTokens:trial.usage.inputTokens,outputTokens:trial.usage.outputTokens,reasoningTokens:trial.usage.reasoningTokens,activeMs:trial.usage.activeMs},uncertain:trial.attempts.some(a=>['received','reserved','dispatched','uncertain'].includes(a.status))};}finally{ledger.close();}
    })();
   }};
  }catch{input.signal.removeEventListener('abort',onAbort);await stop();await rm(socket,{force:true});throw new Error('Scoped improvement broker unavailable');}
 }};
}
