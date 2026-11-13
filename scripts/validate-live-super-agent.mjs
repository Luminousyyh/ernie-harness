/** Real supervised-plan integration; maximum four shared free requests. */
import {readFile,writeFile} from 'node:fs/promises';import{join}from'node:path';import{randomUUID}from'node:crypto';
import{createHarnessService}from'../dist/server/app.js';import{loadApiKey}from'../dist/provider/index.js';import{createToolRegistry}from'../dist/tools/index.js';
if(process.platform!=='linux')throw new Error('Approved Linux host required');
const root='/home/home_new/yaoyh/ernie-harness';const integrity=JSON.parse(await readFile(join(root,'eval/live-continuation-integrity-20261113.json'),'utf8'));const workspace=integrity.workspace;
if(!workspace.startsWith(root+'/eval/trials/continuation-')||!integrity.testFixtureUnchanged)throw new Error('Verified fixture required');
const key=await loadApiKey({path:join(root,'eval/private/credential/openrouter.key'),env:{}});if(!key)throw new Error('Private credential missing');
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

const stateDir=join(root,'eval/private','native-super-agent-'+randomUUID());const service=await createHarnessService({workspace,stateDir,apiKey:key,tools,quotaPath:join(root,'eval/private/broker/broker-quota.json')});
const report={schemaVersion:1,model:'baidu/ernie-5.5-flash-preview:free',provider:'Baidu',reasoningEffort:'high',checkedAt:new Date().toISOString(),type:'real supervised goal; engine-owned plan tool; Bubblewrap commands; shared quota'};
try{
 const goal=service.store.createGoal({workspace,supervised:true,prompt:'这是持续目标的工具接入验证。先用 read_file 读取 add.mjs；然后必须调用 update_plan，记录你已完成的检查步骤和一个待验证的测试检查点（不要冒称测试已通过）；最后简短给出结论。不要修改文件，不必自己执行 Shell，Harness 会独立运行 node --test 验收。',acceptanceCommands:['node --test'],budget:{maxCalls:4}});
 await service.supervisor.start(goal.id);await service.supervisor.wait(goal.id);const result=service.store.getGoal(goal.id);
 const plans=service.store.events(0,goal.id).filter(e=>e.type==='plan.updated').map(e=>e.data);
 Object.assign(report,{goalId:goal.id,status:result.status,usage:result.usage,plans,evidence:result.evidence,context:result.context,passed:result.status==='succeeded'&&plans.length>0&&result.evidence.length===1&&result.evidence[0].exitCode===0});
 if(!report.passed)process.exitCode=1;
}catch(error){report.passed=false;report.error=String(error).replace(/sk-or-v1-[a-zA-Z0-9]+/g,'[REDACTED]');process.exitCode=1;}
finally{await service.app.close();await writeFile(join(root,'eval/live-super-agent-20261113.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report)+'\n');}
