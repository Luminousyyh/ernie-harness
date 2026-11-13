/** Executed only inside Bubblewrap. Broker owns quotas and usage; no upstream credentials enter this process. */
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {AgentEngine} from '../core/engine.js';
import {SqliteStore} from '../store/sqlite.js';
import {LocalEventBus} from '../store/events.js';
import {createToolRegistry} from '../tools/index.js';
import {MODEL_ID,type ModelTransport} from '../contracts/index.js';
import {redactText} from '../trace/redact.js';
import {augmentCandidateRequest} from './prompt.js';
async function main(){
 const token=process.env.ERNIE_BROKER_TOKEN;if(!token)throw new Error('Scoped trial token missing');const prompt=readFileSync('/task.txt','utf8');mkdirSync('/tmp/agent-state',{recursive:true});
 const model:ModelTransport={async complete(request,_delta,signal){const input=augmentCandidateRequest(request);const r=await fetch('http://127.0.0.1:18080/v1/chat/completions',{method:'POST',signal,headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({model:MODEL_ID,messages:input.messages,tools:input.tools,max_tokens:input.maxTokens??16384,temperature:0,reasoning:{effort:'high',exclude:false}})});if(!r.ok)throw new Error('Broker request rejected');const v=await r.json() as any;if(v.model!==MODEL_ID||!v.choices?.[0]?.message||!v.usage)throw new Error('Invalid broker response');return{model:MODEL_ID,message:v.choices[0].message,usage:{inputTokens:v.usage.prompt_tokens,outputTokens:v.usage.completion_tokens,reasoningTokens:v.usage.completion_tokens_details?.reasoning_tokens??0},finishReason:v.choices[0].finish_reason??'stop'};}};
 const store=new SqliteStore('/tmp/agent-state/state.sqlite'),bus=new LocalEventBus(),tools=createToolRegistry(),controller=new AbortController();process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
 let traceBytes=0;const unsubscribe=bus.subscribe(event=>{if(!['tool.started','tool.completed','message','run.failed','usage'].includes(event.type))return;const text=redactText(JSON.stringify({type:event.type,data:event.data}),[token]).slice(0,3500)+'\n';if(traceBytes+Buffer.byteLength(text)>90000)return;traceBytes+=Buffer.byteLength(text);process.stderr.write(text);});
 const config=existsSync('/task-config.json')?JSON.parse(readFileSync('/task-config.json','utf8')):{maxCalls:20,maxActiveMs:1800000};if(!Number.isSafeInteger(config.maxCalls)||config.maxCalls<1||config.maxCalls>20||!Number.isSafeInteger(config.maxActiveMs)||config.maxActiveMs<1||config.maxActiveMs>1800000)throw new Error('Invalid task allowance');
 const goal=store.createGoal({workspace:'/workspace',prompt,budget:{maxCalls:config.maxCalls,maxActiveMs:config.maxActiveMs},supervised:false});try{await new AgentEngine(store,bus,model,tools).run(goal.id,controller.signal);process.exitCode=store.getGoal(goal.id)?.status==='succeeded'?0:1;}finally{await tools.cancelAll?.(goal.id);unsubscribe();store.close();}
}
main().catch(()=>{process.stderr.write('Candidate task failed\n');process.exitCode=1;});
