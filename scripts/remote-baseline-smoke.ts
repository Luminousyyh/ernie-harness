import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { SandboxedBenchmarkAdapter } from '../src/benchmark/adapters.js';
if (process.platform !== 'linux') throw new Error('Smoke runs require the remote Linux sandbox');
const root='/home/home_new/yaoyh/ernie-harness';
const names=(process.env.SMOKE_HARNESSES??'ernie,dsh,pi').split(',');
if(names.some(name=>!['ernie','dsh','pi'].includes(name)))throw new Error('Unknown smoke harness');
const report:unknown[]=[];
function trusted(mode:string,id:string,name:string):any {
 const output=execFileSync('/usr/bin/python3',[join(root,'eval/remote-guard.py'),'--root',root,'--seconds','180','--',join(root,'runtimes/evaluator/bin/python'),join(root,'eval/isolated_smoke.py'),mode,id,name],{cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',CUDA_VISIBLE_DEVICES:'',NVIDIA_VISIBLE_DEVICES:'none'},encoding:'utf8',maxBuffer:16*1024*1024,timeout:200000});
 const rows=output.trim().split('\n').map(line=>JSON.parse(line));
 const guard=rows.pop();if(guard.resource_guard?.exit_code!==0||guard.resource_guard?.limit)throw new Error('Smoke resource guard failed');
 return rows.pop();
}
for(const name of names){
 const id='trial-'+createHash('sha256').update(randomUUID()).digest('hex').slice(0,40);
 const prepared=trusted('prepare',id,name);const started=Date.now();
 const adapter=new SandboxedBenchmarkAdapter(name as 'ernie'|'dsh'|'pi',{root,brokerSocket:join(root,'eval/private/model.sock'),cpus:[0,1,2,3,4,5,6,7]});
 try {
  const result=await adapter.run({workspace:prepared.workspace,prompt:'请检查 add.mjs 和测试，将减法错误修为正确的加法；不要修改测试。修改后运行 node --test 并总结真实结果。',baseUrl:'http://127.0.0.1:18080/v1',token:`trial-smoke-${name}-20261112`});
  const verdict=trusted('finish',id,name);
  const record={name,trialId:id,agentExit:result.exitCode,...verdict,elapsedMs:Date.now()-started,output:result.output.slice(-12000)};
  report.push(record);process.stdout.write(JSON.stringify({name,agentExit:record.agentExit,externalTestsPass:record.externalTestsPass,elapsedMs:record.elapsedMs,patch:record.patch})+'\n');
 }catch(error){const record={name,error:String(error).replace(/sk-or-v1-[a-zA-Z0-9]+/g,'[REDACTED]'),elapsedMs:Date.now()-started};report.push(record);process.stdout.write(JSON.stringify(record)+'\n');}
}
writeFileSync(join(root,`eval/live-smoke-${names.join('-')}.json`),JSON.stringify({schemaVersion:2,model:'baidu/ernie-5.5-flash-preview:free',provider:'Baidu',sandboxed:true,externalTestsIsolated:true,results:report},null,2));
