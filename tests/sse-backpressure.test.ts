import {afterEach,describe,expect,it} from 'vitest';
import {Writable} from 'node:stream';
import {startEventStream} from '../src/server/sse.js';
import type {EventBus,HarnessEvent} from '../src/contracts/index.js';
class SlowClient extends Writable {
 frames:string[]=[];callbacks:(()=>void)[]=[];
 constructor(){super({highWaterMark:1});}
 override _write(chunk:Buffer,_encoding:BufferEncoding,callback:()=>void){this.frames.push(chunk.toString());this.callbacks.push(callback);}
 release(){this.callbacks.shift()?.();}
}
class Notifications implements EventBus {
 listeners=new Set<(event:HarnessEvent)=>void>();
 publish(event:HarnessEvent){for(const listener of this.listeners)listener(event);}
 subscribe(listener:(event:HarnessEvent)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
}
const stops:(()=>void)[]=[];
afterEach(()=>{for(const stop of stops.splice(0))stop();});
const event=(seq:number,data:unknown={}):HarnessEvent=>({seq,goalId:'goal',type:'fixture',data,createdAt:'2026-11-12T00:00:00Z'});
async function tick(){await new Promise<void>(resolve=>setImmediate(resolve));}
describe('SSE backpressure',()=>{
 it('waits for drain and preserves order when notifications arrive during a blocked write',async()=>{
  const client=new SlowClient();const bus=new Notifications();const persisted=[event(1),event(2)];
  stops.push(startEventStream(client,{events:(after=0)=>persisted.filter(e=>e.seq>after)},bus,0));
  await tick();expect(client.frames).toHaveLength(1);
  persisted.push(event(3));bus.publish(persisted[2]);bus.publish(persisted[2]);
  await tick();expect(client.frames).toHaveLength(1);
  client.release();await tick();expect(client.frames).toHaveLength(2);
  client.release();await tick();await tick();expect(client.frames).toHaveLength(3);
  client.release();await tick();
  expect(client.frames.map(frame=>Number(/^id: (\d+)/.exec(frame)![1]))).toEqual([1,2,3]);
 });
 it('disconnects stalled clients and removes the subscription and drain listener',async()=>{
  const client=new SlowClient();const bus=new Notifications();
  stops.push(startEventStream(client,{events:(after=0)=>after===0?[event(1),event(2)]:[]},bus,0,{stallTimeoutMs:20,heartbeatMs:5}));
  await new Promise(resolve=>setTimeout(resolve,50));
  expect(client.destroyed).toBe(true);expect(client.frames).toHaveLength(1);
  expect(bus.listeners.size).toBe(0);expect(client.listenerCount('drain')).toBe(0);
 });
 it('disconnects before a frame would exceed the buffer cap',async()=>{
  const client=new SlowClient();const bus=new Notifications();
  stops.push(startEventStream(client,{events:()=>[event(1,'x'.repeat(1024))]},bus,0,{maxBufferedBytes:256}));
  await tick();expect(client.destroyed).toBe(true);expect(client.frames).toHaveLength(0);expect(bus.listeners.size).toBe(0);
 });
 it('never sends a bus event which is not in the persisted log',async()=>{
  const client=new SlowClient();const bus=new Notifications();
  stops.push(startEventStream(client,{events:()=>[]},bus,0));
  await tick();bus.publish(event(99));await tick();expect(client.frames).toHaveLength(0);
 });
 it('cancels a blocked drain immediately when the stream is stopped',async()=>{
  const client=new SlowClient();const bus=new Notifications();
  const stop=startEventStream(client,{events:()=>[event(1)]},bus,0);stops.push(stop);
  await tick();stop();await tick();
  expect(client.destroyed).toBe(true);expect(client.listenerCount('drain')).toBe(0);expect(bus.listeners.size).toBe(0);
 });
});
