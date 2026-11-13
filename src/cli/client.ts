import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {defaultStateDirectory} from '../provider/index.js';
export interface Connection {url:string;token:string;pid:number}
export interface RequestOptions {signal?:AbortSignal;timeoutMs?:number}
export function connectionPath(){return join(defaultStateDirectory(),'service.json');}
export function serviceUrl(connection:Connection,path:string):string{
 const url=new URL(connection.url);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!path.startsWith('/')||path.startsWith('//'))throw new Error('Invalid local service connection');
 return connection.url.replace(/\/$/,'')+'/api'+path;
}
export function readConnection():Connection|undefined{try{const value=JSON.parse(readFileSync(connectionPath(),'utf8'));if(typeof value.token!=='string'||!value.token||!Number.isSafeInteger(value.pid)||value.pid<1)return;serviceUrl(value,'/state');return value;}catch{return;}}
/** Also strip terminal control sequences so model/tool output cannot control the terminal. */
export function safeText(value:unknown,secrets:string[]=[]):string{
 let text=typeof value==='string'?value:JSON.stringify(value)??String(value);
 for(const secret of secrets)if(secret)text=text.split(secret).join('[REDACTED]');
 return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,'').replace(/\bBearer\s+[^\s"'<>]+/gi,'Bearer [REDACTED]').replace(/\bsk-[a-zA-Z0-9_-]+/g,'[REDACTED]').replace(/([#?]token=)[^\s&#"']+/gi,'$1[REDACTED]');
}
export class ServiceRequestError extends Error {constructor(public readonly status:number,detail=''){super(`HTTP ${status}${detail?': '+detail:''}`);}}
export async function serviceRequest<T>(connection:Connection,path:string,body?:unknown,method=body===undefined?'GET':'POST',options:RequestOptions={}):Promise<T>{
 const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(options.timeoutMs??30000)]):AbortSignal.timeout(options.timeoutMs??30000);
 let response:Response;
 try{response=await fetch(serviceUrl(connection,path),{method,headers:{authorization:'Bearer '+connection.token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal});}
 catch(error){if(options.signal?.aborted)throw options.signal.reason??new Error('Cancelled');throw new Error(safeText(error instanceof Error?error.message:'Local service unavailable',[connection.token]));}
 let value:unknown;try{value=await response.json();}catch{throw new ServiceRequestError(response.status,'Invalid service response');}
 if(!response.ok){const detail=value&&typeof value==='object'&&'error' in value?safeText(String(value.error),[connection.token]).slice(0,500):'';throw new ServiceRequestError(response.status,detail);}
 return value as T;
}
export async function ensureService():Promise<Connection>{
 const current=readConnection();if(current){try{await serviceRequest(current,'/state',undefined,'GET',{timeoutMs:1500});return current;}catch{}}
 const stateDir=defaultStateDirectory();mkdirSync(stateDir,{recursive:true,mode:0o700});const descriptor=openSync(join(stateDir,'service.log'),'a',0o600);
 try{const child=spawn(process.execPath,[...process.execArgv,fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'./main.ts':'./main.js',import.meta.url)),'serve'],{cwd:process.cwd(),detached:true,windowsHide:true,stdio:['ignore',descriptor,descriptor]});child.on('error',()=>{});child.unref();}finally{closeSync(descriptor);}
 for(let i=0;i<120;i++){await new Promise(resolve=>setTimeout(resolve,100));const connection=readConnection();if(connection){try{await serviceRequest(connection,'/state',undefined,'GET',{timeoutMs:1000});return connection;}catch{}}}
 throw new Error('Service startup failed; inspect local service.log.');
}
export function acquireServiceLock(stateDir:string):()=>void{
 mkdirSync(stateDir,{recursive:true,mode:0o700});const path=join(stateDir,'service.lock');
 try{const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,String(process.pid));}finally{closeSync(fd);}}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const pid=Number(readFileSync(path,'utf8'));let alive=false;try{if(Number.isSafeInteger(pid)&&pid>0){process.kill(pid,0);alive=true;}}catch{}if(alive)throw new Error(`Service already running (PID ${pid})`);unlinkSync(path);return acquireServiceLock(stateDir);}
 return()=>{try{if(readFileSync(path,'utf8')===String(process.pid))unlinkSync(path);}catch{}};
}
