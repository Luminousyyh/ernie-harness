import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runProcess} from '../src/improvement/process.js';
const dirs:string[]=[];const root=()=>{const d=mkdtempSync(join(tmpdir(),'improvement-process-'));dirs.push(d);return d;};
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
describe('improvement process ownership, real offline processes',()=>{
 it('preserves literal argument payloads without a shell',async()=>{const payload="$(never);'literal spaces'";const result=await runProcess([process.execPath,'-e','process.stdout.write(process.argv[1])','--',payload],{cwd:root(),signal:new AbortController().signal});expect(result.exitCode).toBe(0);expect(result.output).toBe(payload);});
 it('redacts credentials split between chunks before returning evidence',async()=>{const result=await runProcess([process.execPath,'-e',"process.stdout.write('fixture-');setTimeout(()=>process.stdout.write('secret'),20)"],{cwd:root(),signal:new AbortController().signal,secrets:['fixture-secret']});expect(result.output).toBe('[REDACTED]');});
 it('kills the owned process tree on cancellation',async()=>{const d=root(),pidFile=join(d,'child.pid'),controller=new AbortController();const code="const {spawn}=require('node:child_process'),f=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});f.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);";const work=runProcess([process.execPath,'-e',code,pidFile],{cwd:d,signal:controller.signal});const rejected=expect(work).rejects.toThrow(/cancelled/i);let pid:number|undefined;try{for(let i=0;i<100&&!existsSync(pidFile);i++)await new Promise(r=>setTimeout(r,20));expect(existsSync(pidFile)).toBe(true);pid=Number(readFileSync(pidFile,'utf8'));controller.abort();await rejected;let alive=true;for(let i=0;i<100&&alive;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,20));}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw e;}}expect(alive).toBe(false);}finally{controller.abort();if(pid)try{process.kill(pid,'SIGKILL');}catch{}}});
 it('does not launch an already-cancelled command',async()=>{const c=new AbortController();c.abort();await expect(runProcess([process.execPath,'-e','process.exit(0)'],{cwd:root(),signal:c.signal})).rejects.toThrow(/cancelled/i);});
});
