import {spawn} from 'node:child_process';
import {lstat, mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ApiError, record} from './errors.js';
import {defaultStateDirectory} from './quota.js';
export interface CredentialOptions {path?:string;env?:NodeJS.ProcessEnv}
function credentialPath(options:CredentialOptions):string{return options.path??join(defaultStateDirectory(),process.platform==='win32'?'openrouter.dpapi':'openrouter.key');}
function validKey(key:string):string {const value=key.trim();if(!value||value.length>8192||/[\x00-\x20\x7f]/.test(value))throw new ApiError('API key is empty or invalid',{code:'INVALID_CREDENTIAL',retryable:false});return value;}
function credentialError():ApiError{return new ApiError('Credential vault could not be accessed safely',{code:'CREDENTIAL_VAULT_ERROR',retryable:false});}
async function dpapi(input:string,protect:boolean):Promise<string>{
  // Fixed script; secrets travel only through stdin/stdout pipes, never process arguments.
  const script='Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); '+(protect?'$b=[Text.Encoding]::UTF8.GetBytes($v); $r=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))':'$b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($r))');
  return new Promise((resolve,reject)=>{
    const executable=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',done=false;const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(credentialError());else resolve(output);};
    const timer=setTimeout(()=>{child.kill();finish(credentialError());},15000);timer.unref?.();
    child.stdout.setEncoding('utf8');child.stdout.on('data',(part:string)=>{output+=part;if(output.length>32768){child.kill();finish(credentialError());}});
    child.stderr.resume();child.on('error',()=>finish(credentialError()));child.stdin.on('error',()=>finish(credentialError()));child.on('close',code=>finish(code===0?undefined:credentialError()));child.stdin.end(input);
  });
}
/** Reads only. Callers decide whether absence is fatal; no setup or writes occur here. */
export async function loadApiKey(options:CredentialOptions={}):Promise<string|undefined>{
  const env=options.env??process.env;if(env.OPENROUTER_API_KEY)return validKey(env.OPENROUTER_API_KEY);
  const path=credentialPath(options);let content:string;
  try {const info=await lstat(path);if(!info.isFile()||info.size>32768||(process.platform!=='win32'&&((info.mode&0o777)!==0o600||(process.getuid&&info.uid!==process.getuid()))))throw credentialError();content=await readFile(path,'utf8');}
  catch(error){if(record(error)&&error.code==='ENOENT')return undefined;throw credentialError();}
  if(process.platform==='win32'){if(!content.startsWith('DPAPI1:'))throw credentialError();return validKey(await dpapi(content.slice(7),false));}
  return validKey(content);
}
/** Invoke only from explicit CLI setup, with the secret collected without echo. */
export async function storeApiKey(key:string,options:CredentialOptions&{explicitSetup:boolean}):Promise<void>{
  if(options.explicitSetup!==true)throw new Error('Credential storage requires explicit CLI setup');
  const value=validKey(key),path=credentialPath(options);const stored=process.platform==='win32'?`DPAPI1:${await dpapi(value,true)}`:value;
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temporary=`${path}.${randomUUID()}.tmp`;let handle;
  try{try{if(!(await lstat(path)).isFile())throw credentialError();}catch(error){if(!record(error)||error.code!=='ENOENT')throw error;}
    handle=await open(temporary,'wx',0o600);await handle.writeFile(stored);await handle.sync();await handle.close();handle=undefined;await rename(temporary,path);
  }catch{throw credentialError();}finally{await handle?.close();await unlink(temporary).catch(()=>{});}
}
export const readApiKey=loadApiKey;
export const saveApiKey=storeApiKey;
