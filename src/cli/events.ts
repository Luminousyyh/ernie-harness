import type {HarnessEvent} from '../contracts/index.js';
import {serviceUrl,type Connection} from './client.js';
export type StreamStatus='connecting'|'connected'|'reconnecting'|'disconnected';
export interface StreamOptions {signal:AbortSignal;after?:number;retryMs?:number;onEvent:(event:HarnessEvent)=>void|Promise<void>;onStatus?:(status:StreamStatus)=>void}
export function abortableDelay(ms:number,signal:AbortSignal):Promise<void>{
 return new Promise(resolve=>{if(signal.aborted){resolve();return;}const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});});
}
/** Auth is a header only. The acknowledged global sequence survives reconnects. */
export async function streamEvents(connection:Connection,options:StreamOptions):Promise<void>{
 let cursor=options.after??0;let failures=0;
 while(!options.signal.aborted){
  options.onStatus?.(failures?'reconnecting':'connecting');let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;let abort:()=>void=()=>{};
  try{
   const response=await fetch(serviceUrl(connection,`/events?after=${cursor}`),{headers:{authorization:`Bearer ${connection.token}`,accept:'text/event-stream','last-event-id':String(cursor)},signal:options.signal});
   if(response.status===401||response.status===403){await response.body?.cancel();throw new StreamAuthError(response.status);}
   if(!response.ok||!response.body||!response.headers.get('content-type')?.includes('text/event-stream')){await response.body?.cancel();throw new Error('SSE unavailable');}
   options.onStatus?.('connected');reader=response.body.getReader();abort=()=>{void reader?.cancel().catch(()=>{});};options.signal.addEventListener('abort',abort,{once:true});
   if(options.signal.aborted)break;
   const decoder=new TextDecoder();let buffer='';let data:string[]=[];let frameSize=0;
   while(!options.signal.aborted){
    const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});
    let boundary:number;
    while((boundary=buffer.indexOf('\n'))>=0){
     const line=buffer.slice(0,boundary).replace(/\r$/,'');buffer=buffer.slice(boundary+1);frameSize+=line.length;
     if(frameSize>1048576)throw new Error('SSE frame too large');
     if(line===''){
      if(data.length){const value=JSON.parse(data.join('\n')) as HarnessEvent;
       if(!Number.isSafeInteger(value.seq)||value.seq<1||typeof value.goalId!=='string'||typeof value.type!=='string')throw new Error('Invalid SSE event');
       if(value.seq>cursor){await options.onEvent(value);cursor=value.seq;failures=0;}
      }
      data=[];frameSize=0;
     }else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));
     if(options.signal.aborted)break;
    }
    if(buffer.length>1048576)throw new Error('SSE line too large');
   }
  }catch(error){if(error instanceof StreamAuthError){options.onStatus?.('disconnected');throw error;}}
  finally{options.signal.removeEventListener('abort',abort);if(reader){try{await reader.cancel();}catch{}reader.releaseLock();}}
  if(!options.signal.aborted){failures++;options.onStatus?.('reconnecting');await abortableDelay(Math.min((options.retryMs??250)*2**Math.min(failures-1,5),10000),options.signal);}
 }
 options.onStatus?.('disconnected');
}
class StreamAuthError extends Error {constructor(status:number){super(`Service authentication failed (HTTP ${status})`);}}
