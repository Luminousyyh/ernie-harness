"""Zero-model scratch check. Run once under remote-guard; no nested guard."""
from __future__ import annotations
import hashlib,importlib.util,json,os,pathlib,subprocess,uuid
ROOT=pathlib.Path('/home/home_new/yaoyh/ernie-harness')
NODE=ROOT/'runtimes/node-v24.13.1-linux-x64/bin/node'
PYTHON=ROOT/'runtimes/evaluator/bin/python'
ENV={'PATH':str(NODE.parent)+':/usr/bin:/bin','LANG':'C.UTF-8','CUDA_VISIBLE_DEVICES':'','NVIDIA_VISIBLE_DEVICES':'none'}
def main():
 manifest=json.loads((ROOT/'eval/private/formal/manifest.json').read_text())
 spec=importlib.util.spec_from_file_location('trusted_evaluator',ROOT/'eval/remote-evaluate.py')
 evaluator=importlib.util.module_from_spec(spec);spec.loader.exec_module(evaluator)
 task=min(manifest['devTasks'],key=lambda t:sum(len(evaluator.qualification(t['instanceId'],t['qualificationSha256'])[1][k]) for k in ['failToPass','passToPass']))
 context,record=evaluator.qualification(task['instanceId'],task['qualificationSha256'])
 identity='dev-'+hashlib.sha256(('environment-preflight-'+str(uuid.uuid4())).encode()).hexdigest()[:40]
 trialdir=ROOT/'eval/trials'/identity
 class Args:pass
 args=Args();args.instance=task['instanceId'];args.trialdir=trialdir
 cli=[str(PYTHON),str(ROOT/'eval/remote-evaluate.py')]
 common=['--instance',args.instance,'--trialdir',str(trialdir),'--qualification-sha256',task['qualificationSha256']]
 prepared=json.loads(subprocess.check_output([*cli,'--prepare',*common],cwd=ROOT,env=ENV,text=True,timeout=180))
 check="import sys,os,json; assert sys.version_info[:2]==(3,11); assert os.environ['VIRTUAL_ENV'] in sys.executable; assert not os.path.exists('"+str(ROOT/"eval/private/credential/openrouter.key")+"'); assert not os.path.exists('"+str(ROOT/"eval/qualification")+"'); print(json.dumps({'python':sys.version.split()[0],'venv':sys.prefix,'privatePathsVisible':False}))"
 # The outer resource guard already owns the lock; use only its bwrap section.
 source=r"""import {sandboxArgv} from './src/benchmark/sandbox.ts';
 const root=process.argv[1],workspace=process.argv[2],check=process.argv[3];
 const argv=sandboxArgv({root,workspace,nodeRuntime:root+'/runtimes/node-v24.13.1-linux-x64',baseline:root+'/baselines/ernie',brokerSocket:root+'/eval/private/model.sock',relayScript:root+'/eval/relay.py',guardScript:root+'/eval/remote-guard.py',pythonVenv:workspace.replace(/\/workspace$/,'/python-venv'),cpus:[0,1,2,3,4,5,6,7],command:['python','-c',check]});
 console.log(JSON.stringify(argv.slice(argv.indexOf('bwrap'))));"""
 argv=json.loads(subprocess.check_output([str(NODE),'--import','tsx/esm','--input-type=module','-e',source,str(ROOT),prepared['workspace'],check],cwd=ROOT/'app',env=ENV,text=True))
 test=subprocess.run(argv,cwd=ROOT,env=ENV,capture_output=True,text=True,timeout=60)
 if test.returncode:raise RuntimeError('isolated Python import failed: '+test.stderr[-1500:])
 args.patch=ROOT/'eval/private/formal/patches'/(identity+'.diff');args.patch.parent.mkdir(parents=True,exist_ok=True)
 (pathlib.Path(prepared['workspace'])/'ernie_collector_preflight.py').write_text('# zero-model collector preflight\n')
 collection=json.loads(subprocess.check_output([*cli,'--collect-patch',*common,'--patch',str(args.patch)],cwd=ROOT,env=ENV,text=True,timeout=180))
 if collection['patchBytes']<=0 or b'ernie_collector_preflight.py' not in args.patch.read_bytes():raise RuntimeError('added file missing from isolated patch')
 verdict=json.loads(subprocess.check_output([*cli,*common,'--patch',str(args.patch)],cwd=ROOT,env=ENV,text=True,timeout=650))
 report={'modelCalls':0,'scratchTrial':identity,'instanceId':task['instanceId'],'python':json.loads(test.stdout),'collection':collection,'verdict':verdict,'expected':'benign added-file patch is completed and unresolved','countsAsDevelopmentTrial':False}
 (ROOT/'eval/environment-preflight.json').write_text(json.dumps(report,indent=2))
 print(json.dumps(report),flush=True)
 if verdict['completed'] is not True or verdict['resolved'] is not False:raise RuntimeError('base scratch verdict differs from qualification')
if __name__=='__main__':main()
