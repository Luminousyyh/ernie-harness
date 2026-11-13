"""Real SWE-bench base/oracle qualification using pinned official TestSpec/parsers.

Uses the official test patch and test command. Container activation is replaced
by a private Python venv; this environment adaptation is recorded, never called
an official Docker result. Only completed base-fail/oracle-pass evidence is eligible.
"""
from __future__ import annotations
import argparse,datetime,hashlib,json,os,pathlib,re,shutil,subprocess,tarfile,time,sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent.parent/"eval"))
from qualification_support import candidates,qualified_records,write_json,is_eligible,reconcile_test_ids
import pyarrow.parquet as pq
from swebench.harness.utils import make_test_spec
from swebench.harness.log_parsers import PARSER_REGISTRY
ROOT=pathlib.Path('/home/home_new/yaoyh/ernie-harness');OUT=ROOT/'eval/qualification'
SPEC='02e7a74ffd0b707aab73d203fe87bdc7c76afc8e';REV='78f471bf655a3137b2e8a75af1501690ec009ec3'
PY=ROOT/'runtimes/cpython-3.11.14';UV=ROOT/'runtimes/uv-wheel/uv-0.9.11.data/scripts/uv'
ENV={key:os.environ[key] for key in ['PATH','LANG'] if key in os.environ}
ENV.update(HOME=str(ROOT/'runtimes/home'),TMPDIR=str(ROOT/'cache/tmp'),UV_CACHE_DIR=str(ROOT/'cache/uv'),UV_HTTP_TIMEOUT='30',UV_HTTP_RETRIES='1',UV_CONCURRENT_BUILDS='2',UV_CONCURRENT_INSTALLS='4',CUDA_VISIBLE_DEVICES='',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1',GIT_TERMINAL_PROMPT='0')
def sha(data):return hashlib.sha256(data).hexdigest()
def run(argv,cwd,log,timeout=300,check=True):
 with open(log,'ab') as out:
  out.write((json.dumps(argv)+'\n').encode());out.flush()
  child=subprocess.Popen(argv,cwd=cwd,env=ENV,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=child.wait(timeout=timeout)
  except subprocess.TimeoutExpired:
   import signal
   os.killpg(child.pid,signal.SIGKILL);child.wait();raise
  if check and code:raise subprocess.CalledProcessError(code,argv)
  return code

def source(row,folder,log):
 archive=ROOT/'cache'/(row['repo'].replace('/','__')+'-'+row['base_commit']+'.tar.gz')
 if not archive.exists():
  run(['curl','-fL','--connect-timeout','10','--max-time','900','--speed-limit','1024','--speed-time','120','-o',str(archive)+'.part',f"https://codeload.github.com/{row['repo']}/tar.gz/{row['base_commit']}"],ROOT,log,920)
  pathlib.Path(str(archive)+'.part').replace(archive)
 folder.mkdir()
 with tarfile.open(archive) as stream:
  for m in stream.getmembers():
   parts=m.name.split('/',1)
   if len(parts)<2 or not parts[1]:continue
   m.name=parts[1];target=(folder/m.name).resolve()
   if not target.is_relative_to(folder) or m.islnk() or (m.issym() and not (target.parent/m.linkname).resolve().is_relative_to(folder)):raise ValueError('unsafe source archive')
   if not(m.isfile() or m.isdir() or m.issym()):raise ValueError('unsupported source archive entry')
   stream.extract(m,folder,filter='fully_trusted')
 return sha(archive.read_bytes())

def sandbox(workspace,venv,script):
 args=['bwrap','--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv']
 for path in ['/usr','/bin','/lib','/lib64']:args+=['--ro-bind',path,path]
 args+=['--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/home','--dir','/home/agent','--dir','/etc','--ro-bind','/etc/ld.so.cache','/etc/ld.so.cache']
 for path in [PY,venv]:args+=['--ro-bind',str(path),str(path)]
 args+=['--bind',str(workspace),str(workspace),'--bind',str(workspace),'/testbed','--ro-bind',str(script),'/eval.sh','--chdir','/testbed']
 for key,value in {'HOME':'/home/agent','PATH':str(venv/'bin')+':/usr/bin:/bin','PYTHONPATH':str(workspace),'LANG':'C.UTF-8','CUDA_VISIBLE_DEVICES':'','OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1'}.items():args+=['--setenv',key,value]
 return args+['/bin/bash','/eval.sh']

def qualify(row,attempt):
 folder=OUT/row['instance_id']/('attempt-'+str(attempt));folder.mkdir(parents=True)
 log=folder/'setup.log';base=folder/'base';archive_sha=source(row,base,log)
 venv=folder/'venv';run([str(UV),'venv',str(venv),'--python',str(PY/'bin/python3.11')],folder,log)
 deps=['setuptools==75.8.0','wheel==0.45.1','pytest==7.4.4']
 if row['repo']=='pallets/flask':deps+=['Werkzeug==2.3.8','click==8.1.8','itsdangerous==2.2.0','blinker==1.9.0','Jinja2==3.1.5','asgiref==3.8.1']
 elif row['repo']=='sympy/sympy':deps+=['mpmath==1.3.0']
 else:deps+=['asgiref==3.8.1','sqlparse==0.4.4','pytz==2024.2','Jinja2==3.1.5','docutils==0.20.1']
 run([str(UV),'pip','install','--python',str(venv/'bin/python'),*deps],folder,log,300)
 for command in [['git','init'],['git','add','.'],['git','-c','user.name=Evaluator','-c','user.email=evaluator@localhost','commit','-qm','base archive']]:run(command,base,log)
 oracle=folder/'oracle';shutil.copytree(base,oracle,symlinks=True)
 patch=folder/'oracle.diff';patch.write_text(row['patch']);run(['git','apply',str(patch)],oracle,log)
 spec=make_test_spec(row);official=spec.eval_script
 (folder/'official-eval.sh').write_text(official)
 # Test semantics, test patch and parser remain official. Only environment and
 # archive-local Git revision change; all transformations are stored for audit.
 script=official.replace('git checkout '+row['base_commit'],'git checkout HEAD').replace(' diff '+row['base_commit'],' diff HEAD')
 script='\n'.join(line for line in script.splitlines() if not line.startswith(('source /opt/miniconda3/','conda activate ','python -m pip install ')))+'\n'
 adapted=folder/'adapted-eval.sh';adapted.write_text(script)
 freeze=subprocess.check_output([str(UV),'pip','freeze','--python',str(venv/'bin/python')],env=ENV,text=True)
 (folder/'environment.txt').write_text(freeze)
 (folder/'source.json').write_text(json.dumps({'repo':row['repo'],'base_commit':row['base_commit'],'archive_sha256':archive_sha}))
 evidence={'instanceId':row['instance_id'],'repo':row['repo'],'baseCommit':row['base_commit'],'datasetRevision':REV,'specCommit':SPEC,'failToPass':row['FAIL_TO_PASS'],'passToPass':row['PASS_TO_PASS'],'qualifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'environmentDigest':sha((freeze+script+archive_sha).encode()),'environmentAdaptation':'CPython 3.11.14 uv venv; official test command/parser; no Docker; base archive local HEAD; install step preperformed','sourceArchiveSha256':archive_sha,'officialScriptSha256':sha(official.encode()),'adaptedScriptSha256':sha(script.encode()),'modelCalls':0}
 for phase,workspace in [('base',base),('oracle',oracle)]:
  # Install each checkout then expose only that checkout and its environment.
  run([str(UV),'pip','install','--python',str(venv/'bin/python'),'--no-build-isolation','--no-deps','-e',str(workspace)],folder,log,180)
  testlog=folder/(phase+'.log');code=run(sandbox(workspace,venv,adapted),folder,testlog,300,False)
  text=testlog.read_text(errors='replace');statuses=PARSER_REGISTRY[row['log_parser']](text,spec)
  test_codes=re.findall(r'(?m)^>>>>> Test Exit Code: (\d+)',text)
  completed=bool(test_codes) and '>>>>> End Test Output' in text
  aligned,aliases=reconcile_test_ids(row['FAIL_TO_PASS']+row['PASS_TO_PASS'],statuses,row['repo'])
  evidence[phase]={'completed':completed,'exitCode':int(test_codes[-1]) if test_codes else code,'statuses':aligned,'parserAliases':aliases,'rawStatusCount':len(statuses),'logSha256':sha(testlog.read_bytes())}
  print(json.dumps({'event':'test-finished','instance':row['instance_id'],'phase':phase,'completed':completed,'test_exit':evidence[phase]['exitCode'],'observed_tests':len(statuses)}),flush=True)
 f2p,p2p=evidence['failToPass'],evidence['passToPass'];b,o=evidence['base'],evidence['oracle']
 evidence['eligible']=is_eligible(evidence)
 (folder/'result.json').write_text(json.dumps(evidence,indent=2));return evidence

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--limit',type=int,default=48);parser.add_argument('--only');args=parser.parse_args()
 OUT.mkdir(exist_ok=True)
 data=ROOT/'eval/dataset/test-00000-of-00001.parquet'
 metadata=json.loads((ROOT/'eval/dataset/lfs-metadata.json').read_text())
 expected=next(x['lfs']['oid'] for x in metadata if x['path'].endswith('.parquet'))
 assert sha(data.read_bytes())==expected,'dataset LFS SHA256 mismatch'
 rows=pq.read_table(data).to_pylist()
 (OUT/'provenance.json').write_text(json.dumps({'dataset':'SWE-bench/SWE-bench_Verified','revision':REV,'transport':'hf-mirror.com','parquet_sha256':sha(data.read_bytes()),'spec_commit':SPEC,'tasks':len(rows),'model_calls':0},indent=2))
 # Candidate screening order is separate from the final eligible-only sample.
 supported=candidates(rows,args.limit)
 if args.only:supported=[r for r in rows if r['instance_id']==args.only]
 write_json(OUT/'candidate-batch.json',{'seed':20261112,'limit':args.limit,'target':30,'instances':[r['instance_id'] for r in supported],'scope':'Flask; Django >=4; SymPy, userland Python 3.11 feasibility screening'})
 successes=qualified_records(OUT);write_json(OUT/'eligible.json',successes)
 for row in supported:
  if len(successes)>=30:break
  if (OUT/'stop-after-current').exists():
   print(json.dumps({'status':'operator-stop-marker-present'}),flush=True);break
  prior=list((OUT/row['instance_id']).glob('attempt-*/result.json'))
  if prior:continue
  attempt=len(list((OUT/row['instance_id']).glob('attempt-*')))+1
  print(json.dumps({'event':'qualifying','instance':row['instance_id'],'attempt':attempt,'eligible_count':len(successes)}),flush=True)
  try:result=qualify(row,attempt)
  except Exception as error:
   result={'instanceId':row['instance_id'],'eligible':False,'status':'preparation-or-test-failed','error':str(error),'modelCalls':0}
   folder=OUT/row['instance_id']/('attempt-'+str(attempt));folder.mkdir(parents=True,exist_ok=True)
   write_json(folder/'failure.json',result)
  with open(OUT/'attempts.jsonl','a') as out:out.write(json.dumps(result)+'\n');out.flush();os.fsync(out.fileno())
  successes=qualified_records(OUT);write_json(OUT/'eligible.json',successes)
  print(json.dumps({**{k:v for k,v in result.items() if k in ['instanceId','eligible','status','error']},'eligible_count':len(successes)}),flush=True)
  write_json(OUT/'progress.json',{'eligible_count':len(successes),'target':30,'last_instance':row['instance_id'],'last_status':result.get('status','tested'),'model_calls':0})
 print(json.dumps({'event':'batch-finished','eligible_count':len(successes),'target':30,'frozen':False}),flush=True)
if __name__=='__main__':main()
