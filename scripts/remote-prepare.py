"""Bounded parallel prep. Private apt package extraction is NOT system installation."""
import concurrent.futures,hashlib,json,os,pathlib,subprocess,tarfile,time,urllib.request
ROOT=pathlib.Path('/home/home_new/yaoyh/ernie-harness'); START=time.time()
os.environ.update(HOME=str(ROOT/'runtimes/home'),TMPDIR=str(ROOT/'cache/tmp'),UV_CACHE_DIR=str(ROOT/'cache/uv'),UV_HTTP_TIMEOUT='30',UV_HTTP_RETRIES='1',UV_CONCURRENT_BUILDS='2',UV_CONCURRENT_INSTALLS='4',UV_NATIVE_TLS='true',GIT_TERMINAL_PROMPT='0')
def run(args,cwd=ROOT,timeout=1500,log=None):
 with open(ROOT/'eval'/(log or 'prep-commands.log'),'a') as output:
  output.write(json.dumps(args)+'\n');output.flush()
  subprocess.run(args,cwd=cwd,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=timeout)
def source(name,repo,pin):
 archive=ROOT/'cache'/(name+'-source.tar.gz')
 if not archive.exists():
  run(['curl','-fL','--connect-timeout','15','--max-time','1400','--speed-limit','1000','--speed-time','90','-o',str(archive)+'.part',f'https://codeload.github.com/{repo}/tar.gz/{pin}'],log=name+'-download.log')
  pathlib.Path(str(archive)+'.part').replace(archive)
 target=ROOT/'baselines'/name;target.mkdir(exist_ok=True)
 with tarfile.open(archive) as tar:
  for m in tar.getmembers():
   parts=m.name.split('/',1)
   if len(parts)!=2 or not parts[1]:continue
   m.name=parts[1];p=(target/m.name).resolve()
   if not p.is_relative_to(target) or m.islnk() or (m.issym() and not (p.parent/m.linkname).resolve().is_relative_to(target)):raise ValueError('unsafe archive')
   if not(m.isfile() or m.isdir() or m.issym()):raise ValueError('special file')
   tar.extract(m,target,filter='fully_trusted')
 result={'status':'source-ready','name':name,'pin':pin,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'directory':str(target)}
 (target/'.source-pin.json').write_text(json.dumps(result,indent=2));return result

def python():
 deps=ROOT/'cache/python-dev';deps.mkdir(exist_ok=True);sysroot=ROOT/'runtimes/sysroot';sysroot.mkdir(exist_ok=True)
 run(['apt-get','download','zlib1g-dev','libffi-dev','libsqlite3-dev','liblzma-dev','libbz2-dev'],deps,180,'python-dev.log')
 for package in deps.glob('*.deb'):run(['dpkg-deb','-x',str(package),str(sysroot)],log='python-dev.log')
 libdir=sysroot/'usr/lib/x86_64-linux-gnu'
 for link in libdir.glob('*.so'):
  if link.is_symlink() and not link.exists():
   target=pathlib.Path('/usr/lib/x86_64-linux-gnu')/os.readlink(link)
   if target.exists():link.unlink();link.symlink_to(target)
 source=ROOT/'runtimes/Python-3.11.14';prefix=ROOT/'runtimes/cpython-3.11.14'
 os.environ['CPPFLAGS']=f'-I{sysroot}/usr/include -I{sysroot}/usr/include/x86_64-linux-gnu'
 os.environ['LDFLAGS']=f'-L{sysroot}/usr/lib/x86_64-linux-gnu'
 run(['make','clean'],source,90,'python-rebuild.log')
 run(['./configure','--prefix='+str(prefix),'--with-ensurepip=install'],source,180,'python-rebuild.log')
 run(['make','-j8'],source,600,'python-rebuild.log');run(['make','install'],source,300,'python-rebuild.log')
 run([str(prefix/'bin/python3.11'),'-c','import ssl,sqlite3,ctypes,zlib,lzma,bz2; print("Python runtime modules OK")'],log='python-rebuild.log')
 uv=str(ROOT/'runtimes/uv-wheel/uv-0.9.11.data/scripts/uv');py=str(ROOT/'runtimes/evaluator/bin/python')
 if not pathlib.Path(py).exists():run([uv,'venv',str(ROOT/'runtimes/evaluator'),'--python',str(prefix/'bin/python3.11')],log='python-rebuild.log')
 run([uv,'pip','install','--python',py,'-e',str(ROOT/'baselines/swebench'),'psutil==7.1.3'],timeout=600,log='python-packages.log')
 result={'status':'installed','python':'3.11.14','evaluator':py};(ROOT/'eval/python-ready.json').write_text(json.dumps(result));return result

def dataset():
 target=ROOT/'eval/dataset';target.mkdir(exist_ok=True)
 for name,url in [
 ('info.json','https://huggingface.co/api/datasets/SWE-bench/SWE-bench_Verified'),
 ('first.json','https://datasets-server.huggingface.co/rows?dataset=SWE-bench%2FSWE-bench_Verified&config=default&split=test&offset=0&length=1')]:
  run(['curl','-fL','--connect-timeout','15','--max-time','90','-o',str(target/name),url],timeout=100,log='dataset-fetch.log')
 first=json.loads((target/'first.json').read_text());return {'status':'dataset-first-row-ready','columns':list(first['rows'][0]['row'])}

jobs={'python':python,'dsh':lambda:source('dsh','deepseek-ai/deepseek-harness','e8f7b93a344964de3dca1ace9e72b6e4d6de87cb'),'pi':lambda:source('pi','badlogic/pi-mono','b22e525b325ff1934b4110f7fc60426fd6f0a8f3'),'dataset':dataset}
if os.environ.get('PREP_ONLY'):
 jobs={name:fn for name,fn in jobs.items() if name in os.environ['PREP_ONLY'].split(',')}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 futures={pool.submit(fn):name for name,fn in jobs.items()}
 for future in concurrent.futures.as_completed(futures):
  name=futures[future]
  try:result=future.result()
  except Exception as error:result={'status':'failed','error':str(error)}
  result.update(job=name,elapsed_seconds=time.time()-START)
  (ROOT/'eval'/('prep-'+name+'.json')).write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
