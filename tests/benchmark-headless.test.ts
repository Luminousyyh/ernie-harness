import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MODEL_ID } from '../src/contracts/index.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it('headless keeps its native DB and emits redacted tool failure events without altering broker requests',async()=>{
  const root=await mkdtemp(join(tmpdir(),'headless-telemetry-'));roots.push(root);
  const workspace=join(root,'workspace'),stateDir=join(root,'home','.ernie-trial');await mkdir(workspace);
  const requests:any[]=[];
  const server=createServer((req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      requests.push(JSON.parse(body));const first=requests.length===1;
      const message=first?{role:'assistant',content:null,tool_calls:[{id:'read-missing',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'absent.txt'})}}]}:{role:'assistant',content:'task-created disk-cache trial-telemetry-token sk-short-example'};
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:MODEL_ID,provider:'Baidu',choices:[{message,finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:10}}));
    });
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  try{
    const port=(server.address()as any).port;
    const child=spawn(process.execPath,['--import','tsx/esm',resolve('src/cli/headless.ts'),'--workspace',workspace,'--prompt','Read absent.txt, then finish.','--base-url',`http://127.0.0.1:${port}/v1`,'--token','trial-telemetry-token','--state-dir',stateDir],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    const exit=await new Promise<number|null>((done,reject)=>{child.on('error',reject);child.on('close',done);});
    expect(exit,stderr).toBe(0);expect(JSON.parse(stdout).status).toBe('succeeded');
    expect((await stat(join(stateDir,'state.db'))).size).toBeGreaterThan(0);
    const events=stderr.split('\n').filter(line=>line.startsWith('ERNIE_EVENT_JSON ')).map(line=>JSON.parse(line.slice('ERNIE_EVENT_JSON '.length)));
    expect(events.length).toBeGreaterThan(3);expect(events.every(row=>row.schema==='ernie-harness.event.v1')).toBe(true);
    expect(events.find(row=>row.event.type==='tool.started').event.data.name).toBe('read_file');
    expect(events.find(row=>row.event.type==='tool.completed').event.data.result.ok).toBe(false);
    expect(JSON.stringify(events)).not.toContain('trial-telemetry-token');expect(JSON.stringify(events)).not.toContain('sk-short-example');
    expect(events.find(row=>row.event.type==='message'&&typeof row.event.data.content==='string').event.data.content).toBe('task-created disk-cache [REDACTED] [REDACTED]');
    expect(requests).toHaveLength(2);expect(requests[1].messages.some((m:any)=>m.role==='tool')).toBe(true);
    expect(requests[1].temperature).toBe(0);expect(requests[1].reasoning).toEqual({effort:'high',exclude:false});
  }finally{await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));}
});
