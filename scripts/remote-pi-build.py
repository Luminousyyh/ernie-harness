import json,os,pathlib,subprocess,time
root=pathlib.Path('/home/home_new/yaoyh/ernie-harness');base=root/'baselines/pi'
os.environ.update(PATH=str(root/'runtimes/node-v24.13.1-linux-x64/bin')+':'+os.environ['PATH'],HOME=str(root/'runtimes/home'),npm_config_cache=str(root/'cache/npm'))
start=time.time()
try:
 subprocess.run(['npm','run','build'],cwd=base,check=True,timeout=600)
 subprocess.run(['node',str(base/'packages/coding-agent/dist/cli.js'),'--help'],cwd=base,check=True,timeout=60)
 result={'status':'build-and-help-ready','model_calls':0}
except Exception as e:result={'status':'blocked','error':str(e),'model_calls':0}
result['elapsed_seconds']=time.time()-start
(root/'eval/pi-build.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
