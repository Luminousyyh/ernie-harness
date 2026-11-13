/** Linux integration proof. Uses the same authoritative remote quota, never a new allowance. */
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createHarnessService} from '../dist/server/app.js';
import {createToolRegistry} from '../dist/tools/index.js';
import {loadApiKey} from '../dist/provider/index.js';
if(process.platform!=='linux')throw new Error('Run on the approved Linux host');
const root='/home/home_new/yaoyh/ernie-harness';
const id='continuation-'+randomUUID(),workspace=join(root,'eval/trials',id,'workspace'),stateDir=join(root,'eval/private',id);
await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'add.mjs'),'export function add(a,b){return a-b;}\n');
await writeFile(join(workspace,'add.test.mjs'),"import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from './add.mjs';test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1);});\n");
const key=await loadApiKey({path:join(root,'eval/private/credential/openrouter.key'),env:{}});
if(!key)throw new Error('Private runtime credential missing');
const baseTools=createToolRegistry();
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const tools={definitions:()=>baseTools.definitions(),cancelAll:id=>baseTools.cancelAll(id),async execute(name,args,context){
 if(name==='shell'||name==='run_tests'){
  const argv=['bwrap','--unshare-all','--die-with-parent','--new-session','--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/home/agent','--setenv','HOME','/home/agent','--ro-bind',join(root,'runtimes/node-v24.13.1-linux-x64'),'/runtime/node','--bind',workspace,'/workspace','--chdir','/workspace','--setenv','PATH','/runtime/node/bin:/usr/bin:/bin','--','/bin/sh','-c',args.command];
  return baseTools.execute(name,{...args,command:argv.map(quote).join(' ')},context);
 }
 return baseTools.execute(name,args,context);
}};
const isolation=await tools.execute('run_tests',{command:'test ! -e '+quote(join(root,'eval/private/credential/openrouter.key'))},{workspace,runId:'isolation-preflight'});
if(!isolation.ok)throw new Error('Private credential isolation preflight failed');
const options={stateDir,workspace,apiKey:key,tools,quotaPath:join(root,'eval/private/broker/broker-quota.json')};
let service;let report={schemaVersion:1,model:'baidu/ernie-5.5-flash-preview:free',provider:'Baidu',reasoningEffort:'high',checkedAt:new Date().toISOString(),workspace,type:'real native transport; shared quota; controlled service close and reopen; Bubblewrap shell isolation verified'};
try{
 service=await createHarnessService(options);
 const goal=service.store.createGoal({workspace,prompt:'检查 add.mjs 与现有测试，修复错误的减法实现为加法。保留测试文件，运行 node --test 并总结真实结果。',acceptanceCommands:['node --test'],budget:{maxCalls:8}});
 await service.supervisor.start(goal.id);await service.supervisor.wait(goal.id);const first=service.store.getGoal(goal.id);
 report.goalId=goal.id;report.first={status:first.status,usage:first.usage,evidence:first.evidence};
 if(first.status!=='succeeded')throw new Error('First live goal did not complete: '+first.status);
 await service.app.close();service=await createHarnessService(options);
 await service.supervisor.continueConversation(goal.id,'继续检查刚才的 add.mjs，确认加法实现和测试仍正确；不要修改测试，简短汇报检查结果。');
 await service.supervisor.start(goal.id);await service.supervisor.wait(goal.id);const next=service.store.getGoal(goal.id);
 report.afterRestart={status:next.status,revision:next.revision,usage:next.usage,evidence:next.evidence,context:next.context};
 report.transcriptMessages=service.store.getMessages(goal.id).length;
 report.nativeProof=JSON.parse(await readFile(join(stateDir,'model-validation.json'),'utf8'));
 report.passed=next.status==='succeeded'&&next.revision===2&&next.usage.calls>first.usage.calls&&next.evidence.every(e=>e.exitCode===0)&&report.nativeProof.model===report.model;
 if(!report.passed)throw new Error('Continuation verification did not pass');
}catch(error){report.error=String(error).replace(/sk-or-v1-[a-zA-Z0-9]+/g,'[REDACTED]');report.passed=false;process.exitCode=1;}
finally{if(service)await service.app.close();await writeFile(join(root,'eval/live-continuation-20261113.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report)+'\n');}
