"""Freeze exact deployed execution sources/config templates after main integration.

Run with the private evaluator interpreter. Hashes only an explicit execution
allowlist; never loads credentials, per-trial bearer tokens or environment dumps.
Dataset bytes are streamed only for hashing; no oracle patch or conversation
content is serialized. No model calls or resource lock.
"""
from __future__ import annotations
import argparse,datetime,hashlib,json,os,pathlib,subprocess,uuid
ROOT=pathlib.Path('/home/home_new/yaoyh/ernie-harness')
EXECUTION_HELPERS=('remote-evaluate.py','remote-qualify.py','remote-guard.py','qualification_support.py','test_ids.py','relay.py','patch_collection.py','isolated_smoke.py','remote-dsh-build.py','remote-environment-preflight.py','remote-freeze-artifacts.py')
def sha(path):
 digest=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
 return digest.hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def helper_fingerprints(root):
 return {(pathlib.Path('eval')/name).as_posix():{'sha256':sha(root/'eval'/name),'bytes':(root/'eval'/name).stat().st_size} for name in EXECUTION_HELPERS}

def persist_freeze(target,content):
 checksum=hashlib.sha256(canonical(content)).hexdigest()
 result={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifactSetSha256':checksum,**content}
 if target.exists():
  previous=json.loads(target.read_text())
  if previous['artifactSetSha256']!=checksum:raise ValueError('frozen execution artifacts changed; reconcile before proceeding')
 else:
  temporary=target.with_name(target.name+'.'+str(uuid.uuid4())+'.tmp')
  with temporary.open('xb') as stream:os.chmod(temporary,0o600);stream.write(json.dumps(result,indent=2,ensure_ascii=False).encode()+b'\n');stream.flush();os.fsync(stream.fileno())
  try:os.link(temporary,target)
  finally:temporary.unlink()
 return checksum

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--integration-proof',type=pathlib.Path,required=True)
 parser.add_argument('--linux-log',type=pathlib.Path,required=True)
 parser.add_argument('--linux-exit',type=pathlib.Path)
 args=parser.parse_args()
 for path in [args.integration_proof,args.linux_log]:
  if not path.is_file() or not path.resolve().is_relative_to(ROOT/'eval'):raise ValueError('existing integration proof/log under ROOT/eval required')
 proof=json.loads(args.integration_proof.read_text())
 if proof.get('passed') is not True:raise ValueError('main integration proof must pass')
 exit_path=args.linux_exit or args.linux_log.with_suffix('.exit')
 if not exit_path.is_file() or not exit_path.resolve().is_relative_to(ROOT/'eval') or exit_path.read_text().strip()!='0':raise ValueError('final Linux verification exit receipt must be zero')
 app=ROOT/'app';files={}
 def add(path):
  if not path.is_file():raise ValueError('required artifact missing: '+str(path))
  if not path.resolve().is_relative_to(ROOT):raise ValueError('artifact escaped root')
  relative=path.relative_to(ROOT).as_posix()
  if 'credential' in pathlib.PurePosixPath(relative).parts or path.name.startswith('.env'):raise ValueError('secret artifact prohibited')
  files[relative]={'sha256':sha(path),'bytes':path.stat().st_size}
 for pattern in ['src/**/*.ts','src/**/*.tsx','src/**/*.md','dist/**/*.js','dist/**/*.json']:
  for path in sorted(app.glob(pattern)):add(path)
 for name in ['package.json','pnpm-lock.yaml','tsconfig.json']:add(app/name)
 for name in EXECUTION_HELPERS:add(ROOT/'eval'/name)
 for base,patterns in [('dsh',['vendor/*/lib/**/*.js','packages/*/*/lib/**/*.js','apps/cli/lib/*.js','native/system/packages/linux-x64/bin/glibc/*.node']),('pi',['packages/*/dist/**/*.js'])]:
  folder=ROOT/'baselines'/base;add(folder/'.source-pin.json')
  lock=folder/('pnpm-lock.yaml' if base=='dsh' else 'package-lock.json');add(lock)
  for pattern in patterns:
   for path in sorted(folder.glob(pattern)):add(path)
 add(ROOT/'baselines/swebench/.source-pin.json')
 for path in sorted((ROOT/'baselines/swebench').glob('swebench/harness/**/*.py')):add(path)
 for name in ['test-00000-of-00001.parquet','lfs-metadata.json']:add(ROOT/'eval/dataset'/name)
 for binary in ['runtimes/node-v24.13.1-linux-x64/bin/node','runtimes/cpython-3.11.14/bin/python3.11']:add(ROOT/binary)
 node=ROOT/'runtimes/node-v24.13.1-linux-x64/bin/node'
 source=r"""import {baselineCommand,baselineConfig,baselineEnvironment} from './src/benchmark/adapters.ts';
 const token='trial-artifact-template',base='http://127.0.0.1:18080/v1';
 console.log(JSON.stringify(Object.fromEntries(['ernie','dsh','pi'].map(name=>[name,{config:baselineConfig(name,base,token),environment:baselineEnvironment(name,token),contextParameterApplies:name==='ernie',commands:name==='ernie'?[64000,128000,256000].map(context=>({contextLimit:context,argv:baselineCommand(name,token,context)})):[{contextLimit:null,argv:baselineCommand(name,token)}]}]))));"""
 env={'PATH':str(node.parent)+':/usr/bin:/bin','LANG':'C.UTF-8','CUDA_VISIBLE_DEVICES':'','NVIDIA_VISIBLE_DEVICES':'none'}
 templates=json.loads(subprocess.check_output([str(node),'--import','tsx/esm','--input-type=module','-e',source],cwd=app,env=env,text=True,timeout=30))
 manifest=ROOT/'eval/private/formal/manifest.json';add(manifest)
 content={'schemaVersion':1,'experimentId':json.loads(manifest.read_text())['experimentId'],'gitEvidence':'No implementation commit: supplied checkout is untracked. Exact file bytes are frozen below.','model':'baidu/ernie-5.5-flash-preview:free','files':dict(sorted(files.items())),'configurationTemplates':templates,'templateToken':'Non-secret placeholder; actual per-trial authentication values are excluded.','integrationProof':{'path':str(args.integration_proof),'sha256':sha(args.integration_proof)},'linuxVerification':{'path':str(args.linux_log),'sha256':sha(args.linux_log),'exitPath':str(exit_path),'exitSha256':sha(exit_path)}}
 target=ROOT/'eval/private/formal/artifacts.json'
 checksum=persist_freeze(target,content)
 print(json.dumps({'path':str(target),'artifactSetSha256':checksum,'fileCount':len(files),'modelCalls':0}))
if __name__=='__main__':main()
