import { expect, it } from 'vitest';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPrivateTrialHome, captureNativeProcess } from '../src/benchmark/adapters.js';
import { sandboxArgv } from '../src/benchmark/sandbox.js';
/** Explicit operator-run Linux integration: fixture output, zero live model/fixture HTTP requests. */
it.skipIf(process.platform!=='linux'||process.env.ERNIE_NATIVE_BWRAP_PROOF!=='1')('retains the real bwrap HOME leaf while private parents and a canary remain inaccessible',async()=>{
  const root='/home/home_new/yaoyh/ernie-harness',id='observability-preflight-'+randomUUID();
  const workspace=join(root,'eval/trials',id,'workspace');await mkdir(workspace,{recursive:true});
  const record=await createPrivateTrialHome(root,workspace,'ernie');
  const socket=join(root,'eval/private','obs-'+randomUUID().slice(0,8)+'.sock'),canary=join(root,'eval/private',id+'-canary');
  await writeFile(canary,'PRIVATE_CANARY_MUST_NOT_EXPORT',{flag:'wx',mode:0o600});
  let requests=0;const server=createServer(connection=>{requests++;connection.destroy();});
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(socket,done);});
  try{
    const python=[
      'import os,json,pathlib,sys',
      `assert not pathlib.Path(${JSON.stringify(root+'/eval/private')}).exists()`,
      `assert not pathlib.Path(${JSON.stringify(record.recordDir)}).exists()`,
      "home=pathlib.Path(os.environ['HOME']); assert str(home)=='/home/agent'",
      "(home/'session.jsonl').write_text(json.dumps({'type':'tool.completed','ok':False,'auth':'trial-private-proof','example':'sk-short-proof'})+'\\n')",
      `(home/'escape.jsonl').symlink_to(${JSON.stringify(canary)})`,
      "print('EARLY_NATIVE_STDOUT trial-private-proof sk-short-proof',flush=True)",
      "print('NATIVE_TOOL_FAILED',file=sys.stderr,flush=True)",
    ].join('\n');
    const argv=sandboxArgv({root,workspace,homeDir:record.home,nodeRuntime:join(root,'runtimes/node-v24.13.1-linux-x64'),baseline:join(root,'baselines/pi'),brokerSocket:socket,relayScript:join(root,'eval/relay.py'),guardScript:join(root,'eval/remote-guard.py'),cpus:[0,1,2,3,4,5,6,7],command:['/usr/bin/python3','-c',python]});
    const result=await captureNativeProcess(argv,{...record,cwd:root,token:'trial-private-proof',harness:'ernie',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
    expect(result.exitCode,result.output).toBe(0);expect(requests).toBe(0);
    const manifest=JSON.parse(await readFile(join(record.recordDir,'manifest.json'),'utf8'));
    expect(manifest.complete).toBe(true);expect(manifest.nativeFiles.find((f:any)=>f.relativePath==='escape.jsonl').skipped).toBe('symlink');
    const session=manifest.nativeFiles.find((f:any)=>f.relativePath==='session.jsonl');const text=await readFile(session.sanitizedPath,'utf8');
    expect(text).toContain('tool.completed');expect(text).not.toContain('trial-private-proof');expect(text).not.toContain('sk-short-proof');expect(text).not.toContain('PRIVATE_CANARY_MUST_NOT_EXPORT');
    expect(await readFile(join(record.home,'session.jsonl'),'utf8')).toContain('trial-private-proof');
    await writeFile(join(root,'eval/observability-v2-bwrap-proof.json'),JSON.stringify({schemaVersion:1,passed:true,liveModelCalls:0,fixtureSocketConnections:requests,kind:'real bwrap, scripted output only; not native/model readiness',recordDir:record.recordDir,manifestPath:join(record.recordDir,'manifest.json'),sanitizedStdout:manifest.stdout.sanitizedPath,sanitizedStderr:manifest.stderr.sanitizedPath,home:record.home,privateParentsInvisible:true,symlinkSkipped:true,recordedAt:new Date().toISOString()},null,2));
  }finally{
    await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
    await rm(canary,{force:true});await rm(join(root,'eval/trials',id),{recursive:true,force:true});
  }
},45000);
