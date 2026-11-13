import {access,cp,lstat,mkdir,readFile,readdir,realpath,writeFile,rm} from 'node:fs/promises';
import {join,resolve,isAbsolute,basename,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readlinkSync} from 'node:fs';
import type {IsolationEvidence,LinuxEvaluationEnvironment} from './types.js';
import type {EvaluationManifest,EvaluationSuite,EvaluationTask} from './evaluation.js';
import {hashTree,sha256} from './archive.js';
import {validateCommand,loadSuite} from './evaluation.js';
import {checkAbort,runProcess,type ProcessEvidence} from './process.js';
/** Trusted launcher, mounted separately from the candidate. It only relays to the scoped Unix broker. */
const LAUNCHER=`import argparse,asyncio,os,signal,sys
async def pipe(reader,writer):
 try:
  while data:=await reader.read(65536): writer.write(data);await writer.drain()
 except (ConnectionError,asyncio.CancelledError): pass
 finally: writer.close()
async def main():
 p=argparse.ArgumentParser();p.add_argument('--socket',required=True);p.add_argument('--token-file',required=True);p.add_argument('command',nargs=argparse.REMAINDER);a=p.parse_args()
 async def accept(reader,writer):
  try: r,w=await asyncio.open_unix_connection(a.socket)
  except OSError: writer.close();return
  await asyncio.gather(pipe(reader,w),pipe(r,writer))
 command=a.command[1:] if a.command[:1]==['--'] else a.command
 env=dict(os.environ);env['ERNIE_BROKER_TOKEN']=open(a.token_file).read()
 server=await asyncio.start_server(accept,'127.0.0.1',18080)
 async with server:
  child=await asyncio.create_subprocess_exec(*command,env=env)
  loop=asyncio.get_running_loop()
  for s in [signal.SIGTERM,signal.SIGINT]: loop.add_signal_handler(s,lambda s=s:child.send_signal(s) if child.returncode is None else None)
  return await child.wait()
if __name__=='__main__':sys.exit(asyncio.run(main()))
`;
/** Frozen module/safety unit checks; formal benchmark records are never mounted into candidates. */
export const MANDATORY_CANDIDATE_TESTS=[
 'tests/tools.test.ts','tests/tools-process.test.ts','tests/context.test.ts','tests/engine.test.ts',
 'tests/improvement-security.test.ts','tests/improvement-repository.test.ts','tests/improvement-service.test.ts','tests/improvement-isolation.test.ts','tests/improvement-active.test.ts','tests/improvement-process.test.ts','tests/improvement-configuration.test.ts',
] as const;
/** A curated immutable runtime may contain internal package links, never links out to host data. */
export async function verifyDependencyMount(root:string):Promise<void>{
 const base=resolve(root);if((await lstat(base)).isSymbolicLink()||await realpath(base)!==base)throw new Error('Linked dependency root');let entries=0;
 async function walk(path:string):Promise<void>{for(const name of await readdir(path)){
  if(++entries>200000)throw new Error('Dependency tree limit exceeded');
  if(['.git','.env','.npmrc','.netrc','.pypirc'].includes(name)||/\.(db|sqlite|sqlite3|pem|key|p12)$/i.test(name))throw new Error('Private file in dependency mount');
  const p=join(path,name),stat=await lstat(p);if(stat.isSymbolicLink()){const target=await realpath(p);if(target!==base&&!target.startsWith(base+sep))throw new Error('Dependency link outside runtime');}
  else if(stat.isDirectory())await walk(p);else if(!stat.isFile()||stat.nlink>1)throw new Error('Nonregular dependency file');
 }}await walk(base);for(const required of ['typescript/bin/tsc','vitest/vitest.mjs'])if(!(await lstat(join(base,required))).isFile())throw new Error('Required compiler/test runtime missing');
}
export interface SandboxMounts {candidate?:string;workspace?:string;suite?:string;prompt?:string;launcher?:string;tokenFile?:string;brokerSocket?:string;taskConfig?:string;writableCandidate?:boolean}
/** No shared host root, git metadata, host HOME, stable DB or public network. */
export function bubblewrapArgv(node:string,dependencies:string|undefined,mounts:SandboxMounts,command:string[]):string[]{
 validateCommand(command);if(!isAbsolute(node)||Object.values(mounts).some(v=>typeof v==='string'&&(!isAbsolute(v)||v.includes('\0'))))throw new Error('Absolute sandbox mounts required');
 const args=['--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib','--ro-bind-try','/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/home','--dir','/home/agent','--dir','/runtime','--ro-bind',node,'/runtime/node','--setenv','HOME','/home/agent','--setenv','PATH','/runtime:/usr/bin:/bin','--setenv','TMPDIR','/tmp','--setenv','LANG','C.UTF-8','--setenv','CI','1','--setenv','GIT_CONFIG_NOSYSTEM','1','--setenv','NO_PROXY','*'];
 if(mounts.candidate)args.push(mounts.writableCandidate?'--bind':'--ro-bind',mounts.candidate,'/candidate');
 if(dependencies){if(!isAbsolute(dependencies))throw new Error('Absolute dependency mount required');args.push('--ro-bind',dependencies,mounts.candidate?'/candidate/node_modules':'/dependencies');}
 if(mounts.workspace)args.push('--bind',mounts.workspace,'/workspace');
 if(mounts.suite)args.push('--ro-bind',mounts.suite,'/evaluator');
 if(mounts.prompt)args.push('--ro-bind',mounts.prompt,'/task.txt');
 if(mounts.taskConfig)args.push('--ro-bind',mounts.taskConfig,'/task-config.json');
 if(mounts.brokerSocket){if(!mounts.launcher||!mounts.tokenFile)throw new Error('Scoped broker launcher required');args.push('--dir','/broker','--ro-bind',mounts.brokerSocket,'/broker/model.sock','--dir','/run','--ro-bind',mounts.tokenFile,'/run/token','--ro-bind',mounts.launcher,'/launcher.py');}
 args.push('--chdir',mounts.workspace?'/workspace':mounts.candidate?'/candidate':'/tmp');
 if(mounts.brokerSocket)args.push('/usr/bin/python3','/launcher.py','--socket','/broker/model.sock','--token-file','/run/token','--');
 args.push(...command);return args;
}
async function noLinks(root:string):Promise<void>{if((await lstat(root)).isSymbolicLink()||(await realpath(root))!==resolve(root))throw new Error('Linked materialization root');for(const name of await readdir(root)){if(name==='.git'||name==='.env'||/\.(pem|key)$/.test(name))throw new Error('Private metadata in candidate materialization');const p=join(root,name),s=await lstat(p);if(s.isSymbolicLink()||s.isFile()&&s.nlink>1)throw new Error('Linked candidate materialization');if(s.isDirectory())await noLinks(p);else if(!s.isFile())throw new Error('Nonregular candidate materialization');}}
export class LinuxCandidateSandbox {
 private evidence?:IsolationEvidence;
 constructor(private readonly environment?:LinuxEvaluationEnvironment){}
 async verify(signal:AbortSignal):Promise<IsolationEvidence>{
  const base:IsolationEvidence={verified:false,platform:process.platform,mechanism:'linux-bubblewrap',checkedAt:new Date().toISOString()};
  if(process.platform!=='linux')return this.evidence={...base,reason:'Linux Bubblewrap isolation required'};
  if(!this.environment)return this.evidence={...base,reason:'Pinned evaluator, dependencies and scoped broker required'};
  try{
   checkAbort(signal);const node=this.environment.nodeExecutable??process.execPath,bwrap=this.environment.bwrapExecutable??'/usr/bin/bwrap';
   for(const p of [node,bwrap,this.environment.dependenciesDir]){if(!isAbsolute(p))throw new Error('Nonabsolute runtime');await access(p);}
   await verifyDependencyMount(this.environment.dependenciesDir);const hostNetwork=readlinkSync('/proc/self/ns/net');
   const code=`const f=require('node:fs');console.log(JSON.stringify({linux:process.platform==='linux',network:f.readlinkSync('/proc/self/ns/net'),clean:!f.existsSync('/candidate')&&!f.existsSync('/evaluator')&&!f.existsSync('/broker')&&!f.existsSync('/root')&&!f.existsSync('/workspace'),secret:Object.keys(process.env).some(k=>/token|key|secret|password/i.test(k))}));`;
   const result=await runProcess([bwrap,...bubblewrapArgv(node,undefined,{},['/runtime/node','-e',code])],{cwd:'/',signal,timeoutMs:15000});const proof=JSON.parse(result.output.trim());
   if(result.exitCode!==0||proof.linux!==true||proof.network===hostNetwork||proof.clean!==true||proof.secret!==false)throw new Error('Isolation probe failed');
   return this.evidence={...base,verified:true,probeHash:sha256(result.output)};
  }catch{return this.evidence={...base,reason:'Bubblewrap unavailable or namespace isolation probe failed'};}
 }
 private assertVerified():LinuxEvaluationEnvironment{if(process.platform!=='linux'||!this.evidence?.verified||!this.environment)throw new Error('Verified Linux isolation required');return this.environment;}
 private async exec(candidate:string|undefined,mounts:SandboxMounts,command:string[],cwd:string,signal:AbortSignal,timeoutMs:number,secrets:readonly string[]=[]):Promise<ProcessEvidence>{
  const e=this.assertVerified();if(candidate)await noLinks(candidate);
  return runProcess([e.bwrapExecutable??'/usr/bin/bwrap',...bubblewrapArgv(e.nodeExecutable??process.execPath,e.dependenciesDir,{...mounts,...(candidate?{candidate}:{})},command)],{cwd,signal,timeoutMs,secrets});
 }
 async build(candidate:string,stateDir:string,signal:AbortSignal):Promise<{passed:boolean;commands:{exitCode:number;outputHash:string}[]}>{
  const e=this.assertVerified(),commands=[['/runtime/node','/candidate/node_modules/typescript/bin/tsc','-p','tsconfig.json'],['/runtime/node','/candidate/node_modules/vitest/vitest.mjs','run',...MANDATORY_CANDIDATE_TESTS],...(e.buildCommands??[])];const evidence:{exitCode:number;outputHash:string}[]=[];
  for(const command of commands){validateCommand(command);const r=await this.exec(candidate,{writableCandidate:true},command,stateDir,signal,600_000);evidence.push({exitCode:r.exitCode,outputHash:r.outputHash});if(r.exitCode!==0)return{passed:false,commands:evidence};}
  await noLinks(candidate);return{passed:true,commands:evidence};
 }
 /** A real isolated headless launch on an already staged authorized workspace. No evaluator is mounted. */
 async runAgent(input:{candidate:string;workspace:string;prompt:string;stateDir:string;signal:AbortSignal;maxCalls:number;maxActiveMs:number;trial:{socketPath:string;token:string}}):Promise<{exitCode:number;outputHash:string;elapsedMs:number;developmentOutput?:string}>{
  this.assertVerified();const {candidate,workspace,prompt,stateDir,signal,maxCalls,maxActiveMs,trial}=input;checkAbort(signal);
  if(!Number.isSafeInteger(maxCalls)||maxCalls<1||maxCalls>20||!Number.isSafeInteger(maxActiveMs)||maxActiveMs<1||maxActiveMs>1800000)throw new Error('Invalid isolated task allowance');
  await noLinks(workspace);if(!(await lstat(trial.socketPath)).isSocket())throw new Error('Scoped broker Unix socket required');
  const dir=join(stateDir,'agent-'+randomUUID());await mkdir(dir,{mode:0o700});
  try{
   const task=join(dir,'prompt.txt'),config=join(dir,'config.json'),launcher=join(dir,'launcher.py'),token=join(dir,'token');
   await writeFile(task,prompt,{mode:0o600});await writeFile(config,JSON.stringify({maxCalls,maxActiveMs}),{mode:0o600});await writeFile(launcher,LAUNCHER,{mode:0o600});await writeFile(token,trial.token,{mode:0o600});
   const run=await this.exec(candidate,{workspace,prompt:task,taskConfig:config,launcher,tokenFile:token,brokerSocket:trial.socketPath},['/runtime/node','/candidate/dist/improvement/candidate-runner.js'],dir,signal,maxActiveMs,[trial.token]);
   return{exitCode:run.exitCode,outputHash:run.outputHash,elapsedMs:run.elapsedMs,developmentOutput:run.output};
  }finally{if(!resolve(dir).startsWith(resolve(stateDir)+sep)||!/^agent-[a-f0-9-]+$/.test(basename(dir)))throw new Error('Unsafe agent cleanup path');await rm(dir,{recursive:true,force:true});}
 }
 async task(input:{candidate:string;suite:EvaluationSuite;manifest:EvaluationManifest;task:EvaluationTask;stateDir:string;signal:AbortSignal;maxCalls?:number;maxActiveMs?:number;trial:{socketPath:string;token:string}}):Promise<{resolved:boolean;agentLogHash:string;gradeLogHash:string;developmentTrace?:{agent:string;grade:string}}>{
  this.assertVerified();const {candidate,suite,manifest,task,stateDir,signal,trial}=input;const maxCalls=input.maxCalls??20,maxActiveMs=input.maxActiveMs??1800000;await loadSuite(suite,manifest.partition);if(await hashTree(join(suite.root,task.fixture))!==task.fixtureHash)throw new Error('Fixture changed');
  const started=Date.now(),dir=join(stateDir,'task-'+randomUUID()),workspace=join(dir,'workspace');await mkdir(dir,{recursive:false,mode:0o700});await cp(join(suite.root,task.fixture),workspace,{recursive:true,dereference:false,errorOnExist:true,force:false});await noLinks(workspace);
  try{
   if(!(await lstat(trial.socketPath)).isSocket())throw new Error('Scoped broker Unix socket required');
   // Agent never sees the grader, evaluator manifest, other tasks or stable source Git metadata.
   const run=await this.runAgent({candidate,workspace,prompt:task.prompt,stateDir:dir,signal,maxCalls,maxActiveMs,trial});
   // Host controls grading in a fresh namespace with no candidate source or broker mount.
   const remaining=maxActiveMs-(Date.now()-started);if(remaining<=0)throw new Error('Task active time allowance exceeded');const grade=await this.exec(undefined,{workspace,suite:suite.root},task.grade,dir,signal,Math.min(60_000,remaining),[trial.token]);
   return{resolved:run.exitCode===0&&grade.exitCode===0,agentLogHash:run.outputHash,gradeLogHash:grade.outputHash,...(manifest.partition==='development'?{developmentTrace:{agent:(run.developmentOutput??'').slice(0,60000),grade:grade.output.slice(0,30000)}}:{})};
  }finally{if(!resolve(dir).startsWith(resolve(stateDir)+sep)||!/^task-[a-f0-9-]+$/.test(basename(dir)))throw new Error('Unsafe task cleanup path');await rm(dir,{force:true,recursive:true});}
 }
}
