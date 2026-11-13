import {afterEach, describe, expect, it} from 'vitest';
import {chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BudgetReservations, SerialQuota, loadApiKey, storeApiKey} from '../src/provider/index.js';
const dirs:string[]=[];function file(name='quota.json'){const dir=mkdtempSync(join(tmpdir(),'provider-state-'));dirs.push(dir);return join(dir,name);}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

describe('durable serial quota',()=>{
 it('serializes concurrent operations including across instances for one state path',async()=>{
  const path=file();const a=new SerialQuota({path}),b=new SerialQuota({path});let active=0,peak=0;
  await Promise.all([a,b,a].map(q=>q.run(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return 1;})));
  expect(peak).toBe(1);expect((await a.snapshot()).dayUsed).toBe(3);
 });
 it('persists failed attempts and rejects the eleventh request in a rolling minute',async()=>{
  const path=file();const q=new SerialQuota({path,now:()=>Date.UTC(2026,10,12,12)});
  await expect(q.run(async()=>{throw new Error('network uncertain');})).rejects.toThrow('network uncertain');
  for(let i=0;i<9;i++)await q.reserve();
  const recovered=new SerialQuota({path,now:()=>Date.UTC(2026,10,12,12)});await expect(recovered.reserve()).rejects.toMatchObject({status:429,retryAfterMs:60000});expect((await recovered.snapshot()).dayUsed).toBe(10);
 });
 it('enforces the fifty call UTC daily fallback over restarts and resets on UTC rollover',async()=>{
  const path=file();let now=Date.UTC(2026,10,12,0);const q=new SerialQuota({path,now:()=>now});
  for(let i=0;i<50;i++){await q.reserve();now+=61000;}
  await expect(new SerialQuota({path,now:()=>now}).reserve()).rejects.toMatchObject({code:'DAILY_QUOTA_EXHAUSTED'});
  now=Date.UTC(2026,10,13,0);expect((await q.reserve()).id).toBeTypeOf('string');expect((await q.snapshot()).dayUsed).toBe(1);
 });
 it('fails closed on corrupt state or a clock rollback',async()=>{
  const path=file();writeFileSync(path,'not-json');await expect(new SerialQuota({path}).reserve()).rejects.toMatchObject({code:'QUOTA_STATE_INVALID'});
  const other=file();let now=Date.UTC(2026,10,12,12);const q=new SerialQuota({path:other,now:()=>now});await q.reserve();now-=1000;await expect(q.reserve()).rejects.toMatchObject({code:'QUOTA_CLOCK_ROLLBACK'});
 });
 it('does not reserve an already aborted operation',async()=>{const q=new SerialQuota({path:file()});const controller=new AbortController();controller.abort();await expect(q.run(async()=>1,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect((await q.snapshot()).dayUsed).toBe(0);});
});

describe('budget reservations',()=>{
 it('reserves headroom atomically and settles usage without counting reasoning twice',()=>{
  const ledger=new BudgetReservations({maxCalls:2,maxInputTokens:100,maxOutputTokens:50});const hold=ledger.reserve({inputTokens:60,outputTokens:40});expect(()=>ledger.reserve({inputTokens:50,outputTokens:20})).toThrow();hold.commit({inputTokens:20,outputTokens:30,reasoningTokens:25});expect(ledger.snapshot()).toMatchObject({calls:1,inputTokens:20,outputTokens:30});ledger.reserve({inputTokens:80,outputTokens:20});expect(()=>ledger.reserve({inputTokens:0,outputTokens:0})).toThrow();expect(()=>hold.commit({inputTokens:1,outputTokens:1,reasoningTokens:0})).toThrow();
 });
});

describe('explicit credential setup',()=>{
 it('prefers a supplied environment value and never writes during reads',async()=>{const path=file('key');expect(await loadApiKey({path,env:{OPENROUTER_API_KEY:'synthetic-key'}})).toBe('synthetic-key');await expect(loadApiKey({path,env:{}})).resolves.toBeUndefined();});
 it('requires explicit setup authorization',async()=>{await expect(storeApiKey('synthetic-key',{path:file('key'),explicitSetup:false})).rejects.toThrow('explicit');});
 it('stores test credentials with platform protection and loads them without shell arguments',async()=>{
  const path=file('key');await storeApiKey('synthetic-key-only',{path,explicitSetup:true});expect(await loadApiKey({path,env:{}})).toBe('synthetic-key-only');
  if(process.platform==='win32'){expect(readFileSync(path,'utf8')).not.toContain('synthetic-key-only');expect(readFileSync(path,'utf8')).toMatch(/^DPAPI1:/);}else{expect(statSync(path).mode&0o777).toBe(0o600);chmodSync(path,0o644);await expect(loadApiKey({path,env:{}})).rejects.toThrow();}
 });
});

describe('quota cancellation and cross-process guard',()=>{
 it('cancels queued work promptly without consuming a reservation',async()=>{
  const path=file();const q=new SerialQuota({path});let release!:()=>void;let started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{started=resolve;});
  const first=q.run(async()=>{started();await gate;});await ready;
  const controller=new AbortController();const second=q.run(async()=>2,controller.signal);controller.abort();
  let result:string;try{result=await Promise.race([second.then(()=> 'ran',()=> 'aborted'),new Promise<string>(resolve=>setTimeout(()=>resolve('still queued'),100))]);}finally{release();await first;await second.catch(()=>{});}
  expect(result).toBe('aborted');expect((await q.snapshot()).dayUsed).toBe(1);
 });
 it('does not override another writer lock',async()=>{const path=file();writeFileSync(`${path}.lock`,'{}');await expect(new SerialQuota({path}).reserve()).rejects.toMatchObject({code:'QUOTA_LOCKED'});expect(readFileSync(`${path}.lock`,'utf8')).toBe('{}');});
});
