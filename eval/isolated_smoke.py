"""Trusted fixture setup and isolated smoke scoring; no model credential access."""
from __future__ import annotations
import argparse,json,os,pathlib,re,subprocess
from patch_collection import freeze_base_objects,collect_patch,private_json,trusted_environment
ROOT=pathlib.Path('/home/home_new/yaoyh/ernie-harness')
TEST="import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from '/workspace/add.mjs';test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1);});\n"
def main():
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['prepare','finish']);parser.add_argument('trial');parser.add_argument('harness',choices=['ernie','dsh','pi']);args=parser.parse_args()
 if not re.fullmatch('trial-[a-f0-9]{40}',args.trial):raise ValueError('invalid smoke trial ID')
 trial=ROOT/'eval/trials'/args.trial;workspace=trial/'workspace';private=ROOT/'eval/private/formal/preparation'/args.trial;instance='smoke-'+args.harness
 if args.mode=='prepare':
  workspace.mkdir(parents=True,mode=0o700);private.mkdir(parents=True,mode=0o700)
  (workspace/'add.mjs').write_text('export function add(a,b){return a-b;}\n')
  (workspace/'add.test.mjs').write_text(TEST.replace("'/workspace/add.mjs'","'./add.mjs'"))
  env=trusted_environment()
  for argv in [['init','--quiet','--template='],['add','.'],['-c','user.name=Evaluator','-c','user.email=evaluation@localhost','commit','-qm','base']]:
   subprocess.run(['/usr/bin/git',*argv],cwd=workspace,env=env,check=True,capture_output=True,timeout=30)
  descriptor=freeze_base_objects(workspace,private)
  private_json(private/'prepared.json',{'instance':instance,'workspace':str(workspace),'collector':descriptor})
  (private/'trusted-test.mjs').write_text(TEST)
  print(json.dumps({'workspace':str(workspace)}));return
 patch=ROOT/'eval/private/formal/patches'/(args.trial+'.diff')
 collected=collect_patch(ROOT,trial,instance,patch)
 argv=['bwrap','--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv']
 for path in ['/usr','/bin','/lib','/lib64']:argv+=['--ro-bind',path,path]
 argv+=['--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/home','--dir','/home/agent','--dir','/etc','--ro-bind','/etc/ld.so.cache','/etc/ld.so.cache',
        '--ro-bind',str(ROOT/'runtimes/node-v24.13.1-linux-x64'),'/runtime/node','--ro-bind',str(workspace),'/workspace','--ro-bind',str(private/'trusted-test.mjs'),'/trusted-test.mjs','--chdir','/workspace','--setenv','HOME','/home/agent','--setenv','PATH','/runtime/node/bin:/usr/bin:/bin','--setenv','CUDA_VISIBLE_DEVICES','','/runtime/node/bin/node','--test','/trusted-test.mjs']
 test=subprocess.run(argv,cwd=private,env=trusted_environment(),capture_output=True,text=True,timeout=30)
 output=test.stdout+test.stderr
 passed=test.returncode==0 and bool(re.search(r'(?:#\s*|ℹ\s*)pass\s+1\b',output)) and bool(re.search(r'(?:#\s*|ℹ\s*)fail\s+0\b',output))
 print(json.dumps({'patch':patch.read_text(errors='replace'),'externalTestsPass':passed,'testEvidence':output,'collection':collected,'externalTestsIsolated':True}))
if __name__=='__main__':main()
