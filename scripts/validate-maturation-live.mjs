/** Bounded real ERNIE validation. No mocked transport and no alternate quota. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync,readlinkSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHarnessService} from '../dist/server/app.js';
import {createToolRegistry} from '../dist/tools/index.js';
import {loadApiKey} from '../dist/provider/index.js';
import {LinuxCandidateSandbox,bubblewrapArgv} from '../dist/improvement/isolation.js';
const args=process.argv.slice(2);
if(!((args.length===1&&args[0]==='--repair-smoke')||(args.length===2&&args[0]==='--continue'&&/^live-[a-f0-9-]{36}$/.test(args[1]))))throw new Error('Explicit supported mode required: --repair-smoke or --continue live-UUID; unknown modes never dispatch');
const root='/home/home_new/yaoyh/ernie-harness';
const source=resolve(fileURLToPath(new URL('..',import.meta.url)));
const quotaPath=join(root,'eval/private/broker/broker-quota.json');
const credentialPath=join(root,'eval/private/credential/openrouter.key');
const sha=value=>createHash('sha256').update(value).digest('hex');
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const put=async(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const clean=value=>String(value).replace(/sk-or-v1-[a-zA-Z0-9]+/g,'[REDACTED]');
if(process.platform!=='linux'||source!==join(root,'versions/maturation-20261113'))throw new Error('Approved independent Linux source required');
const continued=process.argv[2]==='--continue';
const id=continued?process.argv[3]:'live-'+randomUUID();
const output=join(source,'artifacts/maturation',id),stateDir=join(source,'.ernie/maturation',id),workspace=join(output,'workspace');
await mkdir(output,{recursive:true,mode:0o700});await mkdir(stateDir,{recursive:true,mode:0o700});
const baselinePath=join(output,'quota-before.json');
if(!continued){const initial=await json(quotaPath);if(initial.attempts.length+6>48)throw new Error('Six-call repair/reflection/restart envelope unavailable; preserve the last two shared calls');await put(baselinePath,initial);}
const before=await json(baselinePath);
const used=async()=>{const current=await json(quotaPath);return {ledger:current,delta:current.attempts.filter(a=>!before.attempts.some(b=>a.id===b.id)).length};};
const allowance=async max=>{const q=await used();if(q.delta>=max||q.ledger.attempts.length>=48)throw new Error('Bounded live allowance reached; preserving two shared requests');};
const base=createToolRegistry();
const tools={definitions:context=>base.definitions(context),cancelAll:id=>base.cancelAll?.(id),async execute(name,args,context){
 if(resolve(context.workspace)!==workspace)throw new Error('Only the authorized live workspace is mounted');
 if(name==='shell'||name==='run_tests'){
  const shellMount=bubblewrapArgv(process.execPath,undefined,{workspace},['/runtime/node','--version']);
  const argv=['/usr/bin/bwrap',...shellMount.slice(0,-2),'/bin/sh','-c',args.command];
  return base.execute(name,{...args,command:argv.map(quote).join(' ')},context);
 }
 return base.execute(name,args,context);
}};
let service,report={schemaVersion:1,id,sourceRoot:source,workspace,stateDir,model:'baidu/ernie-5.5-flash-preview:free',provider:'Baidu',reasoningEffort:'high',kind:'real native OpenRouterTransport; shared persisted quota; actual process restart; Bubblewrap shell',startedAt:new Date().toISOString()};
const summarize=goal=>({id:goal.id,status:goal.status,revision:goal.revision,error:goal.error,summary:goal.summary,usage:goal.usage,evidence:goal.evidence,manifest:goal.manifest});
const capture=async()=>{if(!service)return;const goals=service.store.listGoals();await put(join(output,continued?'continued-goals.json':'initial-goals.json'),goals);for(const goal of goals){await put(join(output,goal.id+(continued?'-continued-events.json':'-initial-events.json')),service.store.events(0,goal.id).filter(e=>e.type!=='model.delta'));await put(join(output,goal.id+(continued?'-continued-messages.json':'-initial-messages.json')),service.store.getMessages(goal.id).map(m=>{const {reasoning,reasoning_details,...safe}=m;return safe;}));}};
try{
 await allowance(8);
 const key=await loadApiKey({path:credentialPath,env:{}});if(!key)throw new Error('Runtime credential missing');
 if(!continued){
  const manifest=await json(join(source,'artifacts/maturation/source-manifest.json'));report.snapshotHash=manifest.sourceHash;
  await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'add.mjs'),'export function add(a,b){return a-b;}\n');
  await writeFile(join(workspace,'add.test.mjs'),"import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from './add.mjs';test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1);assert.equal(add(0,0),0);});\n");
  report.testSha256=sha(await readFile(join(workspace,'add.test.mjs')));
  const sandbox=new LinuxCandidateSandbox({nodeExecutable:process.execPath,dependenciesDir:join(source,'.ernie/maturation/dependencies')});
  report.candidateIsolation=await sandbox.verify(new AbortController().signal);
  const hidden=[credentialPath,quotaPath,stateDir,join(root,'src'),join(root,'dist'),join(root,'eval')];
  const probe=`const fs=require('node:fs');console.log(JSON.stringify({network:fs.readlinkSync('/proc/self/ns/net'),hidden:${JSON.stringify(hidden)}.every(p=>!fs.existsSync(p)),workspace:fs.existsSync('/workspace/add.mjs'),privateEnvironment:Object.keys(process.env).some(k=>/token|key|secret|password/i.test(k))}));`;
  const result=await tools.execute('run_tests',{command:'node -e '+quote(probe)},{workspace,runId:'live-isolation-preflight'});
  let proof;try{proof=JSON.parse(result.output.trim());}catch{throw new Error('Shell isolation probe produced no valid proof: '+clean(result.output));}
  report.shellIsolation={...proof,exitCode:result.exitCode,hostNetwork:readlinkSync('/proc/self/ns/net')};
  if(!report.candidateIsolation.verified||!result.ok||!proof.hidden||!proof.workspace||proof.privateEnvironment||proof.network===report.shellIsolation.hostNetwork)throw new Error('Actual Bubblewrap isolation preflight failed');
  const failing=await tools.execute('run_tests',{command:'node --test'},{workspace,runId:'initial-failing-test'});report.beforeTest=failing;
  if(failing.ok)throw new Error('Fixture did not fail before the live edit');
  service=await createHarnessService({stateDir,workspace,apiKey:key,tools,quotaPath,learning:false});
  const goal=service.store.createGoal({workspace,partition:'development',mode:'trusted',prompt:'修复这个极小项目的 add.mjs：当前把加法错误写成减法。先 read_file 读取 add.mjs，再用 edit_file 修复为 a+b，运行 run_tests(command="node --test")，最后简短报告真实结果。不要修改 add.test.mjs，不要调用额外模型或安装依赖。工具可并行时合并调用。只有四次回复预算，请简洁执行。',acceptanceCommands:['node --test'],budget:{maxCalls:4,maxOutputPerCall:2048,maxInputTokens:100000,maxOutputTokens:12000,maxActiveMs:300000}});
  report.goalId=goal.id;await put(join(output,'report.json'),report);
  await service.supervisor.start(goal.id);await service.supervisor.wait(goal.id);let resultGoal=service.store.getGoal(goal.id);report.first=summarize(resultGoal);
  report.editedCode=await readFile(join(workspace,'add.mjs'),'utf8');report.testUnchanged=sha(await readFile(join(workspace,'add.test.mjs')))===report.testSha256;
  if(resultGoal.status!=='succeeded')throw new Error('Initial live goal did not succeed: '+resultGoal.status+' '+(resultGoal.error??''));
  if(!report.testUnchanged)throw new Error('Live model modified the acceptance test');
  await allowance(6);service.store.updateGoal(goal.id,{budget:{...resultGoal.budget,maxCalls:resultGoal.usage.calls+1}});
  await service.maturation.learning.reflect(goal.id,AbortSignal.timeout(120000));
  resultGoal=service.store.getGoal(goal.id);report.afterReflection=summarize(resultGoal);report.memories=service.maturation.learning.list(workspace);
  report.reflection=service.store.events(0,goal.id).filter(e=>e.type.startsWith('learning.'));
  service.store.updateGoal(goal.id,{budget:{...resultGoal.budget,maxCalls:resultGoal.usage.calls+1}});
  await capture();await service.app.close();service=undefined;
  report.closedAt=new Date().toISOString();await put(join(output,'report.json'),report);
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--continue',id],{cwd:source,encoding:'utf8',timeout:210000,env:{...process.env,OPENROUTER_API_KEY:'',ERNIE_API_KEY:''}});
  await writeFile(join(output,'restart-process.log'),clean((child.stdout??'')+(child.stderr??'')),{mode:0o600});
  report.restartProcess={pid:child.pid,exitCode:child.status,error:child.error?clean(child.error.message):undefined};
  if(existsSync(join(output,'continuation.json')))report.continuation=await json(join(output,'continuation.json'));
  report.nativeProof=await json(join(stateDir,'model-validation.json'));
  report.passed=child.status===0&&report.continuation?.passed===true&&report.reflection.some(e=>e.type==='learning.completed')&&report.nativeProof.model===report.model;
 }else{
  const original=await json(join(output,'report.json'));report.goalId=original.goalId;
  service=await createHarnessService({stateDir,workspace,apiKey:key,tools,quotaPath,learning:false});
  const persisted=service.store.getGoal(report.goalId);report.persisted=summarize(persisted);report.persistedMessages=service.store.getMessages(report.goalId).length;
  report.memoryBefore=service.maturation.learning.list(workspace);report.prepareBeforeContinuation=await service.maturation.learning.prepare(persisted);
  await allowance(6);
  await service.supervisor.continueConversation(report.goalId,'继续上一轮已完成任务。基于持久化对话中的修复与测试结果，用一句话汇报 add 的修复和测试结果即可。无需再调用工具，不修改任何文件，Harness 会独立复验 node --test。');
  await service.supervisor.start(report.goalId);await service.supervisor.wait(report.goalId);const next=service.store.getGoal(report.goalId);report.after=summarize(next);
  report.preparationEvents=service.store.events(0,report.goalId).filter(e=>['manifest.created','learning.prepared'].includes(e.type));
  report.testUnchanged=sha(await readFile(join(workspace,'add.test.mjs')))===original.testSha256;
  report.passed=next.status==='succeeded'&&next.revision===persisted.revision+1&&next.usage.calls>persisted.usage.calls&&report.persistedMessages>0&&report.testUnchanged&&next.evidence.some(e=>e.goalRevision===next.revision&&e.exitCode===0);
 }
}catch(error){report.passed=false;report.error=clean(error instanceof Error?error.stack:error);}
finally{
 try{await capture();}catch(error){report.captureError=clean(error);}
 if(service)await service.app.close();
 const usage=await used();report.requestsConsumed=usage.delta;report.quotaBefore=before.attempts.length;report.quotaAfter=usage.ledger.attempts.length;report.finishedAt=new Date().toISOString();
 await put(join(output,'quota-after.json'),usage.ledger);await put(join(output,continued?'continuation.json':'report.json'),report);
 console.log(JSON.stringify({id,passed:report.passed,requestsConsumed:report.requestsConsumed,quotaBefore:report.quotaBefore,quotaAfter:report.quotaAfter,error:report.error,report:join(output,continued?'continuation.json':'report.json')}));
 if(!report.passed)process.exitCode=1;
}
