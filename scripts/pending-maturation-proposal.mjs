/** One persistent, quota-gated real proposal. Run only in the separate Linux validation checkout. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {SerialQuota,loadApiKey} from '../dist/provider/index.js';
import {createHarnessService} from '../dist/server/app.js';
if(process.argv.length!==3||process.argv[2]!=='--wait-for-free-quota')throw new Error('Explicit --wait-for-free-quota required');
if(process.platform!=='linux')throw new Error('Approved Linux validation host required');
const root='/home/home_new/yaoyh/ernie-harness',source=fileURLToPath(new URL('../',import.meta.url));
if(!source.startsWith(root+'/versions/'))throw new Error('Separate version checkout required');
const directory=join(source,'.ernie','pending-proposal');await mkdir(directory,{recursive:true,mode:0o700});
const intent=join(directory,'dispatch.json'),status=join(directory,'status.json');
if(existsSync(intent))throw new Error('Proposal already dispatched or uncertain; inspect before retrying');
const quotaPath=join(root,'eval/private/broker/broker-quota.json'),quota=new SerialQuota({path:quotaPath});
for(;;){const snapshot=await quota.snapshot();await writeFile(status,JSON.stringify({state:'waiting-free-quota',remaining:snapshot.dayRemaining,retryAt:snapshot.dayResetAt,required:3,modelCalls:0}),{mode:0o600});if(snapshot.dayRemaining>=3)break;await delay(60000);}
await writeFile(intent,JSON.stringify({state:'dispatch-intent',at:new Date().toISOString(),maxCalls:1,maxCandidates:1}),{mode:0o600,flag:'wx'});
const key=await loadApiKey({path:join(root,'eval/private/credential/openrouter.key'),env:{}});if(!key)throw new Error('Runtime credential unavailable');
const service=await createHarnessService({workspace:source,stateDir:join(directory,'service'),apiKey:key,learning:false,quotaPath});
try{const job=service.maturation.improvements.start({workspace:source,maxCalls:1,maxCandidates:1,selection:{mode:'fixed',modules:['context']}});await writeFile(status,JSON.stringify({state:'running',id:job.id}),{mode:0o600});await service.maturation.improvements.wait(job.id);const result=service.maturation.improvements.get(job.id);await writeFile(status,JSON.stringify({state:result?.status,job:result,quota:await quota.snapshot(),evidence:'actual model proposal only; no external evaluation or promotion claimed'},null,2),{mode:0o600});}finally{await service.app.close();}
