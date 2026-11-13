import {spawn} from 'node:child_process';
import {killProcessTree,scrubEnvironment} from '../tools/processes.js';
import {redactText} from '../trace/redact.js';
import {sha256} from './archive.js';
export interface ProcessEvidence {exitCode:number;output:string;outputHash:string;elapsedMs:number}
export const abortError=():Error=>Object.assign(new Error('Improvement cancelled'),{name:'AbortError'});
export function checkAbort(signal:AbortSignal):void{if(signal.aborted)throw abortError();}
/** Every executable receives an argument array. Never invoke a shell or execute candidate code on the host. */
export async function runProcess(command:readonly string[],options:{cwd:string;signal:AbortSignal;timeoutMs?:number;secrets?:readonly string[];env?:NodeJS.ProcessEnv}):Promise<ProcessEvidence>{
 checkAbort(options.signal);if(!command.length||command.some(x=>typeof x!=='string'||x.includes('\0')))throw new Error('Invalid process argument array');
 const started=Date.now(),environment={...scrubEnvironment(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',...options.env};
 const secrets=[...(options.secrets??[]),...Object.entries(process.env).filter(([k])=>/key|token|password|secret|credential|authorization/i.test(k)).map(([,v])=>v??'').filter(v=>v.length>=8)];
 const child=spawn(command[0],[...command.slice(1)],{cwd:options.cwd,env:environment,shell:false,detached:true,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output=Buffer.alloc(0),stop:Promise<void>|undefined,interrupted=false,timedOut=false,overflow=false;
 const terminate=()=>{interrupted=true;if(child.pid&&!stop)stop=killProcessTree(child.pid);void stop?.catch(()=>{});};
 const onAbort=()=>terminate();options.signal.addEventListener('abort',onAbort,{once:true});if(options.signal.aborted)terminate();
 const timer=setTimeout(()=>{timedOut=true;terminate();},options.timeoutMs??60_000);timer.unref();
 for(const stream of [child.stdout,child.stderr])stream.on('data',(data:Buffer)=>{if(output.length+data.length>128*1024){overflow=true;terminate();return;}output=Buffer.concat([output,data]);});
 try{
  const code=await new Promise<number>((resolve,reject)=>{child.once('error',()=>reject(new Error('Improvement executable unavailable')));child.once('close',code=>resolve(code??1));});
  if(stop)await stop;if(options.signal.aborted)throw abortError();if(timedOut)throw new Error('Improvement process timed out');if(overflow)throw new Error('Improvement output limit exceeded');if(interrupted)throw new Error('Improvement process interrupted');
  const text=redactText(output.toString('utf8'),secrets);return{exitCode:code,output:text,outputHash:sha256(text),elapsedMs:Date.now()-started};
 }finally{clearTimeout(timer);options.signal.removeEventListener('abort',onAbort);}
}
export function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){void promise.catch(()=>{});return Promise.reject(abortError());}
 return new Promise<T>((resolve,reject)=>{const onAbort=()=>reject(abortError());signal.addEventListener('abort',onAbort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',onAbort)).catch(()=>{});});
}
