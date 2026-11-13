"""Build only pinned baseline dependencies, then run help (zero model requests)."""
import concurrent.futures,json,os,pathlib,subprocess,time
ROOT=pathlib.Path('/home/home_new/yaoyh/ernie-harness');NODE=ROOT/'runtimes/node-v24.13.1-linux-x64/bin'
os.environ.update(PATH=str(NODE)+':'+os.environ['PATH'],HOME=str(ROOT/'runtimes/home'),npm_config_cache=str(ROOT/'cache/npm'),COREPACK_HOME=str(ROOT/'cache/corepack'),PNPM_HOME=str(ROOT/'runtimes/pnpm'),GIT_TERMINAL_PROMPT='0',npm_config_fetch_timeout='60000',npm_config_fetch_retries='1',npm_config_audit='false',npm_config_fund='false',npm_config_update_notifier='false')
def run(args,cwd,log,timeout=900):
 with open(ROOT/'eval'/log,'a') as out:
  out.write(json.dumps(args)+'\n');out.flush();subprocess.run(args,cwd=cwd,stdout=out,stderr=subprocess.STDOUT,check=True,timeout=timeout)
def install(name):
 cwd=ROOT/'baselines'/name;start=time.time()
 try:
  if name=='pi':
   run(['npm','ci','--ignore-scripts','--no-audit','--no-fund'],cwd,'pi-install.log')
   run(['node','--import',str(cwd/'packages/coding-agent/src/experimental/source-resolver.ts'),str(cwd/'packages/coding-agent/src/cli.ts'),'--help'],cwd,'pi-help.log',90)
  else:
   tools=ROOT/'runtimes/pnpm-tool';tools.mkdir(exist_ok=True)
   run(['npm','install','--prefix',str(tools),'--ignore-scripts','--no-audit','--no-fund','pnpm@11.28.5'],ROOT,'dsh-install.log',180)
   pnpm=str(tools/'node_modules/pnpm/bin/pnpm.cjs')
   run(['node',pnpm,'install','--frozen-lockfile','--ignore-scripts','--store-dir',str(ROOT/'cache/pnpm')],cwd,'dsh-install.log')
   run(['node','--import','tsx/esm',str(cwd/'apps/cli/src/bin.ts'),'headless','--help'],cwd,'dsh-help.log',120)
  result={'status':'dependencies-and-help-ready','model_calls':0}
 except Exception as error:result={'status':'blocked','error':str(error),'model_calls':0}
 result.update(name=name,elapsed_seconds=time.time()-start);(ROOT/'eval'/(name+'-install.json')).write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(install,['pi','dsh']))
