"""Bounded independent source/runtime acquisition; never calls a model."""
import concurrent.futures, hashlib, json, pathlib, socket, tarfile, urllib.request
ROOT=pathlib.Path('/home/home_new/yaoyh/ernie-harness'); socket.setdefaulttimeout(30)
ITEMS={
 'dsh': ('https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb','e8f7b93a344964de3dca1ace9e72b6e4d6de87cb'),
 'pi': ('https://codeload.github.com/badlogic/pi-mono/tar.gz/b22e525b325ff1934b4110f7fc60426fd6f0a8f3','b22e525b325ff1934b4110f7fc60426fd6f0a8f3'),
 'swebench': ('https://codeload.github.com/SWE-bench/SWE-bench/tar.gz/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e','02e7a74ffd0b707aab73d203fe87bdc7c76afc8e'),
 'python': ('https://www.python.org/ftp/python/3.11.14/Python-3.11.14.tar.xz','3.11.14')}
def fetch(item):
 name,(url,pin)=item; archive=ROOT/'cache'/(name+'-source.tar'+('.xz' if name=='python' else '.gz'))
 try:
  if not archive.exists():
   with urllib.request.urlopen(url,timeout=30) as src, open(str(archive)+'.part','wb') as dest:
    while data:=src.read(1024*1024):dest.write(data)
   pathlib.Path(str(archive)+'.part').replace(archive)
  target=ROOT/('runtimes' if name=='python' else 'baselines')/('Python-3.11.14' if name=='python' else name)
  target.mkdir(parents=True,exist_ok=True)
  with tarfile.open(archive) as tar:
   members=tar.getmembers();prefix=members[0].name.split('/')[0]
   for m in members:
    m.name=m.name[len(prefix):].lstrip('/')
    if not m.name:continue
    path=(target/m.name).resolve()
    if not path.is_relative_to(target):raise ValueError('archive path escape')
    if m.issym() and not (path.parent/m.linkname).resolve().is_relative_to(target):raise ValueError('archive symlink escape')
    if m.islnk():raise ValueError('archive hardlink unsupported')
    if not (m.isfile() or m.isdir() or m.issym()):raise ValueError('archive special file')
    tar.extract(m,target,filter='fully_trusted')
  result={'name':name,'status':'source-ready','pin':pin,'url':url,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'target':str(target)}
  (target/'.source-pin.json').write_text(json.dumps(result,indent=2))
 except Exception as e:result={'name':name,'status':'fetch-failed','error':str(e),'url':url}
 print(json.dumps(result),flush=True);return result
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 results=list(pool.map(fetch,ITEMS.items()))
(ROOT/'eval/source-acquisition.json').write_text(json.dumps(results,indent=2))
