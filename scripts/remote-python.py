"""Private CPython build plus official evaluator package, independently restartable."""
import json,os,pathlib,subprocess
ROOT=pathlib.Path('/home/home_new/yaoyh/ernie-harness')
os.environ.update(HOME=str(ROOT/'runtimes/home'),TMPDIR=str(ROOT/'cache/tmp'),UV_CACHE_DIR=str(ROOT/'cache/uv'),UV_HTTP_TIMEOUT='30',UV_HTTP_RETRIES='1',UV_CONCURRENT_BUILDS='2',UV_CONCURRENT_INSTALLS='4',UV_NATIVE_TLS='true')
def run(argv,cwd=ROOT):
 print(json.dumps({'command':argv}),flush=True);subprocess.run(argv,cwd=cwd,check=True,timeout=900)
python=ROOT/'runtimes/cpython-3.11.14/bin/python3.11';source=ROOT/'runtimes/Python-3.11.14'
if not python.exists():
 run(['./configure','--prefix='+str(ROOT/'runtimes/cpython-3.11.14'),'--with-ensurepip=install'],source)
 run(['make','-j8'],source);run(['make','install'],source)
run([str(python),'--version'])
uv=str(ROOT/'runtimes/uv-wheel/uv-0.9.11.data/scripts/uv')
if not (ROOT/'runtimes/evaluator/bin/python').exists():run([uv,'venv',str(ROOT/'runtimes/evaluator'),'--python',str(python)])
run([uv,'pip','install','--python',str(ROOT/'runtimes/evaluator/bin/python'),'-e',str(ROOT/'baselines/swebench'),'psutil==7.1.3'])
(ROOT/'eval/python-ready.json').write_text(json.dumps({'python':'3.11.14','source_sha256':'8d3ed8ec5c88c1c95f5e558612a725450d2452813ddad5e58fdb1a53b1209b78','runtime':str(python),'evaluator':str(ROOT/'runtimes/evaluator/bin/python'),'status':'installed','model_calls':0},indent=2))
