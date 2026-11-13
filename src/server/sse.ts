import type {ServerResponse} from 'node:http';
import type {EventBus,SessionStore} from '../contracts/index.js';

type StreamResponse=Pick<ServerResponse,'write'|'on'|'off'|'destroy'|'writableLength'|'destroyed'|'writableEnded'>;
interface StreamOptions {
 maxBufferedBytes?:number;
 stallTimeoutMs?:number;
 heartbeatMs?:number;
 onClose?:()=>void;
}

/** The database is the delivery queue; bus events only wake one ordered reader. */
export function startEventStream(response:StreamResponse,store:Pick<SessionStore,'events'>,bus:EventBus,after:number,options:StreamOptions={}):()=>void {
 const maxBufferedBytes=options.maxBufferedBytes??1024*1024;
 const stallTimeoutMs=options.stallTimeoutMs??10000;
 let cursor=after;
 let closed=false;
 let draining=false;
 let requested=false;
 let heartbeat=false;
 let cancelDrain:(()=>void)|undefined;
 let unsubscribe=()=>{};
 const timer=setInterval(()=>{heartbeat=true;requestDrain();},options.heartbeatMs??1000);
 timer.unref();

 function cleanup(){
  if(closed)return;
  closed=true;
  clearInterval(timer);
  unsubscribe();
  cancelDrain?.();
  response.off('close',cleanup);
  response.off('finish',cleanup);
  response.off('error',stop);
  options.onClose?.();
 }
 function stop(){cleanup();response.destroy();}
 function waitForDrain():Promise<boolean>{
  return new Promise(resolve=>{
   let settled=false;
   const finish=(ok:boolean)=>{
    if(settled)return;
    settled=true;
    clearTimeout(timeout);
    response.off('drain',onDrain);
    cancelDrain=undefined;
    resolve(ok);
   };
   const onDrain=()=>finish(true);
   const timeout=setTimeout(()=>{finish(false);stop();},stallTimeoutMs);
   timeout.unref();
   cancelDrain=()=>finish(false);
   response.on('drain',onDrain);
   if(closed||response.destroyed||response.writableEnded)finish(false);
  });
 }
 async function write(frame:string):Promise<boolean>{
  if(closed||response.destroyed||response.writableEnded)return false;
  if(response.writableLength+Buffer.byteLength(frame)>maxBufferedBytes){stop();return false;}
  const ready=response.write(frame);
  if(response.writableLength>maxBufferedBytes){stop();return false;}
  return ready||await waitForDrain();
 }
 function requestDrain(){
  if(closed)return;
  requested=true;
  if(!draining)void drain();
 }
 async function drain(){
  draining=true;
  try{
   do{
    requested=false;
    while(!closed){
     const page=store.events(cursor);
     if(!page.length)break;
     for(const event of page){
      if(closed)return;
      if(event.seq<=cursor)continue;
      if(!await write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`))return;
      cursor=event.seq;
     }
     // Yield between pages so shutdown and other clients can run during replay.
     await new Promise<void>(resolve=>setImmediate(resolve));
    }
    if(heartbeat&&!closed){heartbeat=false;if(!await write(': heartbeat\n\n'))return;}
   }while(requested&&!closed);
  }catch{stop();}
  finally{draining=false;}
 }
 response.on('close',cleanup);
 response.on('finish',cleanup);
 response.on('error',stop);
 unsubscribe=bus.subscribe(requestDrain);
 queueMicrotask(requestDrain);
 return stop;
}
