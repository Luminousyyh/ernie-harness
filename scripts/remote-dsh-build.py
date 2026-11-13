"""Build pinned DSH host libraries, then load app-boot inside an isolated mount."""
from __future__ import annotations
import hashlib,json,os,pathlib,subprocess,time
ROOT=pathlib.Path('/home/home_new/yaoyh/ernie-harness');BASE=ROOT/'baselines/dsh';NODE=ROOT/'runtimes/node-v24.13.1-linux-x64'
ENV={'PATH':str(NODE/'bin')+':'+str(ROOT/'runtimes/pnpm-tool/node_modules/.bin')+':/usr/bin:/bin','HOME':str(ROOT/'runtimes/home'),'TMPDIR':str(ROOT/'cache/tmp'),'npm_config_cache':str(ROOT/'cache/npm'),'PNPM_HOME':str(ROOT/'runtimes/pnpm'),'CUDA_VISIBLE_DEVICES':'','NVIDIA_VISIBLE_DEVICES':'none','OMP_NUM_THREADS':'8','OPENBLAS_NUM_THREADS':'8','LANG':'C.UTF-8','GIT_TERMINAL_PROMPT':'0'}
def main():
 start=time.time();result={'pin':'e8f7b93a344964de3dca1ace9e72b6e4d6de87cb','model_calls':0,'live_provider_validation':False}
 try:
  pin=json.loads((BASE/'.source-pin.json').read_text());assert pin['pin']==result['pin']
  command=[str(NODE/'bin/node'),'--import','tsx/esm','scripts/compile-referenced-projects.ts','host-libraries']
  print(json.dumps({'event':'host-build','command':command}),flush=True)
  subprocess.run(command,cwd=BASE,env=ENV,check=True,timeout=540)
  subprocess.run([str(NODE/'bin/node'),'--import','tsx/esm','native/system/scripts/build.ts','--host-addon-only'],cwd=BASE,env=ENV,check=True,timeout=60)
  # These dual-client packages are skipped by the host bundle pass, but their
  # Node entrypoints are part of the unmodified stock headless profile.
  for package in ['packages/typert/registry','packages/api/gateway']:
   subprocess.run([str(NODE/'bin/node'),'node_modules/tsdown/dist/run.mjs','--config-loader','native','--config',package+'/tsdown.config.ts','--env.DSH_BUILD_FACE','client'],cwd=BASE,env=ENV,check=True,timeout=90)
  module=BASE/'packages/boot/app-boot/lib/index.js';assert module.is_file(),'app-boot build output missing'
  args=['bwrap','--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv']
  for path in ['/usr','/bin','/lib','/lib64']:args+=['--ro-bind',path,path]
  args+=['--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/home','--dir','/home/agent','--dir','/etc','--ro-bind','/etc/ld.so.cache','/etc/ld.so.cache','--ro-bind',str(NODE),'/runtime/node','--ro-bind',str(BASE),'/baseline','--chdir','/baseline','--setenv','HOME','/home/agent','--setenv','PATH','/runtime/node/bin:/usr/bin:/bin','--setenv','CUDA_VISIBLE_DEVICES','','/runtime/node/bin/node','--input-type=module','-e',"await import('/baseline/packages/boot/app-boot/lib/index.js'); console.log('isolated app-boot import OK')"]
  subprocess.run(args,cwd=ROOT,env=ENV,check=True,timeout=60)
  required=['apps/cli/lib/bin.js','native/system/packages/linux-x64/bin/glibc/system.node','packages/typert/registry/lib/index.js','packages/api/gateway/lib/index.js']
  artifacts={path:hashlib.sha256((BASE/path).read_bytes()).hexdigest() for path in required}
  result.update(status='host-build-and-isolated-import-ready',entrypoint='apps/cli/lib/bin.js',module_sha256=hashlib.sha256(module.read_bytes()).hexdigest(),artifact_sha256=artifacts)
  # This receipt describes a build only. Real modify/test smoke is separate.
 except Exception as error:result.update(status='blocked',error=str(error))
 result['elapsed_seconds']=time.time()-start
 (ROOT/'eval/dsh-host-build.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
 if result.get('status')=='blocked':raise SystemExit(1)
if __name__=='__main__':main()
