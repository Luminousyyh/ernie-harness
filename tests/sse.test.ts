import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request,type ClientRequest,type IncomingMessage} from 'node:http';
import {createHarnessService} from '../src/server/app.js';

const services:Awaited<ReturnType<typeof createHarnessService>>[]=[];
const dirs:string[]=[];
const requests:ClientRequest[]=[];
const responses:IncomingMessage[]=[];
afterEach(async()=>{
 for(const response of responses.splice(0))response.destroy();
 for(const req of requests.splice(0))req.destroy();
 for(const service of services.splice(0))await service.app.close();
 vi.restoreAllMocks();
 for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});
});
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ernie-sse-'));dirs.push(dir);
 const service=await createHarnessService({stateDir:dir,workspace:dir,apiKey:'',token:'sse-fixture-token'});services.push(service);
 const url=await service.app.listen({host:'127.0.0.1',port:0});
 const goal=service.store.createGoal({workspace:dir,prompt:'SSE fixture'});
 return {...service,url,goal};
}
function connect(url:string,headers:Record<string,string>={authorization:'Bearer sse-fixture-token'}){
 return new Promise<IncomingMessage>((resolve,reject)=>{
  const req=request(url,{headers},response=>{responses.push(response);response.on('error',()=>{});resolve(response);});
  requests.push(req);req.on('error',reject);req.end();
 });
}
function capture(response:IncomingMessage){
 let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;});
 return ()=>[...text.matchAll(/^id: (\d+)/gm)].map(match=>Number(match[1]));
}
async function until(predicate:()=>boolean){
 const deadline=Date.now()+3000;
 while(!predicate()){if(Date.now()>deadline)throw new Error('Timed out waiting for SSE frames');await new Promise(resolve=>setTimeout(resolve,10));}
}
async function bounded<T>(promise:Promise<T>,ms:number){
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SSE shutdown stalled')),ms);})]);}
 finally{clearTimeout(timer);}
}
describe('persisted SSE delivery',()=>{
 it('does not skip a backlog larger than 5000 when a live notification arrives',async()=>{
  const service=await fixture();
  service.store.transaction(()=>{for(let i=0;i<6000;i++)service.store.appendEvent(service.goal.id,'fixture',{i});});
  const read=service.store.events.bind(service.store);let notified=false;
  vi.spyOn(service.store,'events').mockImplementation((after=0,goalId)=>{
   const page=read(after,goalId);
   if(!goalId&&!notified){notified=true;queueMicrotask(()=>service.bus.publish(service.store.appendEvent(service.goal.id,'live',{})));}
   return page;
  });
  const response=await connect(service.url+'/api/events');const ids=capture(response);
  await until(()=>ids().at(-1)===6002);
  expect(ids()).toEqual(Array.from({length:6002},(_,index)=>index+1));
 });
 it('resumes strictly after the query cursor and uses Last-Event-ID as a fallback',async()=>{
  const service=await fixture();for(let i=0;i<5;i++)service.store.appendEvent(service.goal.id,'fixture',{i});
  const first=capture(await connect(service.url+'/api/events?after=3',{authorization:'Bearer sse-fixture-token','last-event-id':'1'}));
  const second=capture(await connect(service.url+'/api/events',{authorization:'Bearer sse-fixture-token','last-event-id':'4'}));
  await until(()=>first().at(-1)===6&&second().at(-1)===6);
  expect(first()).toEqual([4,5,6]);expect(second()).toEqual([5,6]);
 });
 it('rejects unauthenticated encoded SSE routes',async()=>{
  const service=await fixture();const response=await connect(service.url+'/%61pi/events',{});
  expect(response.statusCode).toBe(401);
 });
 it('closes the app promptly while an SSE connection is still open',async()=>{
  const service=await fixture();const response=await connect(service.url+'/api/events');
  const closing=service.app.close();
  try{await bounded(closing,500);}finally{response.destroy();await closing;}
 });
});
